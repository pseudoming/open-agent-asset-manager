/** Host permission pump; each response resumes the same service read and every lost exchange retires it without replay. */
import { randomUUID } from "node:crypto";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import { hasExactKeys } from "../foundation/validators";
import type { SelectedWslSourceReadRequest } from "../orchestration/selected-wsl-source-execution";
import type { AdapterReadResult, CoreResult } from "../types";
import { createRestrictedSourceHostAuthority } from "./restricted-source-host-authority";
import { cloneRestrictedSourceSession, type RestrictedSourceSession } from "./restricted-source-request";
import {
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    RESTRICTED_SOURCE_MAX_READS,
    RESTRICTED_SOURCE_MAX_CONTINUATIONS,
    RESTRICTED_SOURCE_PROTOCOL,
    type RestrictedSourceOperation,
    type RestrictedSourceRequest,
    type RestrictedSourceResponse,
} from "./restricted-source-protocol";
import { createRestrictedSourceResultReceiver } from "./restricted-source-result-transfer";

type ChannelOperation = Exclude<RestrictedSourceOperation, { kind: "cancel" }>;
type ChannelResult<T extends ChannelOperation> = T extends { kind: "begin" | "continue" }
    ? Extract<RestrictedSourceResponse["result"], { kind: "read_step" }>
    : T extends { kind: "result_chunk" }
      ? Extract<RestrictedSourceResponse["result"], { kind: "result_chunk" }>
      : Extract<RestrictedSourceResponse["result"], { kind: "acknowledged" | "cancelled" }>;

export function createRestrictedSourceChannel(
    input: RestrictedSourceSession & {
        deadlineAt: number;
        maximumResultBytes: number;
        exchange(request: RestrictedSourceRequest): Promise<unknown>;
        /** Resolves only after the exact service process is confirmed stopped; failure retains Host locks for a later close. */
        abort(): Promise<void>;
    },
) {
    const session = cloneRestrictedSourceSession(input);
    const deadlineAt = input.deadlineAt;
    const maximumResultBytes = input.maximumResultBytes;
    if (
        !Number.isSafeInteger(deadlineAt) ||
        deadlineAt <= Date.now() ||
        deadlineAt > Date.now() + 600_000 ||
        !Number.isSafeInteger(maximumResultBytes) ||
        maximumResultBytes < 16_384
    )
        throw new Error("invalid restricted source channel bounds");
    const exchange = input.exchange;
    const abort = input.abort;
    let sequence = 0;
    let reads = 0;
    let busy = false;
    let usable = true;
    let closing: Promise<void> | undefined;
    const authorities = new Set<ReturnType<typeof createRestrictedSourceHostAuthority>>();

    function requireOpen() {
        if (!usable || Date.now() >= deadlineAt) throw new Error("restricted source channel is closed or expired");
    }
    async function close(): Promise<void> {
        usable = false;
        closing ??= abort()
            .then(() => {
                for (const authority of authorities) authority.dispose();
                authorities.clear();
            })
            .catch((error) => {
                closing = undefined;
                throw error;
            });
        return closing;
    }
    async function send<T extends ChannelOperation>(operation: T): Promise<ChannelResult<T>> {
        requireOpen();
        const request: RestrictedSourceRequest = {
            protocol: RESTRICTED_SOURCE_PROTOCOL,
            hostInstanceId: session.hostInstanceId,
            sessionId: session.sessionId,
            operationId: randomUUID(),
            sequence: ++sequence,
            operation,
        };
        if (Buffer.byteLength(JSON.stringify(request), "utf8") > RESTRICTED_SOURCE_MAX_FRAME_BYTES)
            throw new Error("restricted source request exceeds frame capacity");
        const raw = await exchange(request);
        requireOpen();
        if (!hasExactKeys(raw, ["protocol", "hostInstanceId", "sessionId", "operationId", "sequence", "result"]))
            throw new Error("invalid restricted source response envelope");
        const response = raw as RestrictedSourceResponse;
        if (
            response.protocol !== request.protocol ||
            response.hostInstanceId !== request.hostInstanceId ||
            response.sessionId !== request.sessionId ||
            response.operationId !== request.operationId ||
            response.sequence !== request.sequence ||
            response.result?.readId !== operation.readId ||
            Buffer.byteLength(JSON.stringify(raw), "utf8") > RESTRICTED_SOURCE_MAX_FRAME_BYTES
        )
            throw new Error("restricted source response identity or capacity mismatch");
        const expected =
            operation.kind === "begin" || operation.kind === "continue"
                ? "read_step"
                : operation.kind === "acknowledge"
                  ? "acknowledged"
                  : "result_chunk";
        const fields = [
            "kind",
            "readId",
            ...(expected === "read_step" ? ["step"] : expected === "result_chunk" ? ["chunk"] : []),
        ];
        if (response.result.kind !== expected || !hasExactKeys(response.result, fields))
            throw new Error("restricted source response kind mismatch");
        return response.result as ChannelResult<T>;
    }

    return Object.freeze({
        async read(source: SelectedWslSourceReadRequest): Promise<CoreResult<AdapterReadResult>> {
            if (busy) throw new Error("restricted source read admission overlaps");
            busy = true;
            let authority: ReturnType<typeof createRestrictedSourceHostAuthority> | undefined;
            let receiver: ReturnType<typeof createRestrictedSourceResultReceiver> | undefined;
            try {
                requireOpen();
                if (
                    ++reads > RESTRICTED_SOURCE_MAX_READS ||
                    !sameProbePlatformContext(source.platformContext, session.platformContext) ||
                    source.preparation.platform !== "wsl"
                )
                    throw new Error("restricted source read is outside the selected Environment or lifetime");
                const target = structuredClone(source.target);
                authority = createRestrictedSourceHostAuthority({ ...source, target });
                authorities.add(authority);
                const readId = randomUUID();
                let result = await send({
                    kind: "begin",
                    readId,
                    target,
                    authority: {
                        managedTargetGuards: structuredClone(source.authority.managedTargetGuards),
                        reservationIdentityFingerprints: [...source.authority.reservationIdentityFingerprints],
                    },
                });
                for (let count = 0; count <= RESTRICTED_SOURCE_MAX_CONTINUATIONS; count++) {
                    const step = result.step;
                    if (step.kind === "result") {
                        if (!hasExactKeys(step, ["kind", "descriptor"]))
                            throw new Error("invalid restricted source completed step");
                        receiver = createRestrictedSourceResultReceiver(step.descriptor, maximumResultBytes);
                        while (!receiver.isComplete()) {
                            const chunk = await send({ kind: "result_chunk", readId, ...receiver.nextRequest() });
                            receiver.accept(chunk.chunk);
                        }
                        const completed = authority.finish(receiver.finish());
                        await send({
                            kind: "acknowledge",
                            readId,
                            transferId: receiver.descriptor.transferId,
                            contentHash: receiver.descriptor.contentHash,
                        });
                        authority.dispose();
                        authorities.delete(authority);
                        return completed;
                    }
                    const continuation = step.kind === "acquire_authority" ? authority.grant(step) : authority.release(step);
                    result = await send({ kind: "continue", readId, continuation });
                }
                throw new Error("restricted source read exhausted its continuation bound");
            } catch (error) {
                try {
                    await close();
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        "restricted source read failed and service cleanup is unconfirmed",
                    );
                }
                throw error;
            } finally {
                receiver?.dispose();
                busy = false;
            }
        },
        close,
        get available() {
            return usable && Date.now() < deadlineAt && reads < RESTRICTED_SOURCE_MAX_READS;
        },
    });
}
