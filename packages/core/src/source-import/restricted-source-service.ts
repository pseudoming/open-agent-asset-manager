/** Linux source service: original Provider/read operation, Host-owned permissions, completed-result transfer. */
import { inspectDirectoryNoFollow, samePhysicalPathIdentity } from "@oaam/shared/filesystem";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import type { AdapterProvider } from "../types";
import {
    cloneRestrictedSourceSession,
    decodeRestrictedSourceTarget,
    RESTRICTED_SOURCE_HOST_LOCK_AUTHORITY,
    type RestrictedSourceSession,
} from "./restricted-source-request";
import { createRestrictedSourceReadRun, type RestrictedSourceReadStep } from "./restricted-source-read-run";
import {
    isRestrictedSourceRequest,
    RESTRICTED_SOURCE_MAX_CONTINUATIONS,
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    RESTRICTED_SOURCE_MAX_READS,
    type RestrictedSourceResponse,
    type RestrictedSourceWireStep,
} from "./restricted-source-protocol";
import { createRestrictedSourceResultTransfer, RestrictedSourceResultCapacityError } from "./restricted-source-result-transfer";
import { failedResult, sourceDiagnostic } from "./source-read-validation-helpers";

export interface RestrictedSourceServiceConfiguration extends RestrictedSourceSession {
    deadlineAt: number;
    maximumResultBytes: number;
}

export function createRestrictedSourceService(
    input: RestrictedSourceServiceConfiguration & { providers: readonly AdapterProvider[] },
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
        throw new Error("invalid restricted source service lifetime or Host result capacity");
    const providers = new Map(input.providers.map((provider) => [provider.adapterId, provider]));
    if (providers.size === 0 || providers.size !== input.providers.length)
        throw new Error("invalid restricted source Provider inventory");
    const projection = createSelectedWslPathProjection(
        session.platformContext.platformInstanceId,
        session.platformContext.accessRootPath,
    );
    const identity = inspectDirectoryNoFollow(projection.executionAccessRootPath);
    const reads = new Set<string>();
    const operations = new Set<string>();
    let active:
        | {
              readId: string;
              run: ReturnType<typeof createRestrictedSourceReadRun>;
              continuations: number;
              transfer?: ReturnType<typeof createRestrictedSourceResultTransfer>;
          }
        | undefined;
    let completion: Promise<void> = Promise.resolve();
    let handling = false;
    let closed = false;
    let sequence = 0;

    function requireCurrent() {
        if (
            closed ||
            Date.now() >= deadlineAt ||
            !samePhysicalPathIdentity(identity, inspectDirectoryNoFollow(projection.executionAccessRootPath))
        )
            throw new Error("restricted source session expired, closed or lost its selected root");
    }
    function close() {
        closed = true;
        active?.run.cancel();
        active?.transfer?.dispose();
        if (active !== undefined) completion = active.run.settled();
        active = undefined;
    }
    function projectStep(step: RestrictedSourceReadStep): RestrictedSourceWireStep {
        if (step.kind !== "complete") return step;
        if (active === undefined) throw new Error("restricted source completion lost its read identity");
        try {
            active.transfer = createRestrictedSourceResultTransfer(step.result, maximumResultBytes);
        } catch (error) {
            if (!(error instanceof RestrictedSourceResultCapacityError)) throw error;
            active.transfer = createRestrictedSourceResultTransfer(
                failedResult([sourceDiagnostic("read.restricted_result_capacity", error.message)]),
                maximumResultBytes,
            );
        }
        return { kind: "result", descriptor: active.transfer.descriptor };
    }
    return Object.freeze({
        async handle(value: unknown): Promise<RestrictedSourceResponse> {
            if (handling) {
                close();
                throw new Error("restricted source requests overlap");
            }
            handling = true;
            try {
                requireCurrent();
                if (
                    !isRestrictedSourceRequest(value) ||
                    value.hostInstanceId !== session.hostInstanceId ||
                    value.sessionId !== session.sessionId ||
                    value.sequence !== sequence + 1 ||
                    operations.has(value.operationId) ||
                    Buffer.byteLength(JSON.stringify(value), "utf8") > RESTRICTED_SOURCE_MAX_FRAME_BYTES
                )
                    throw new Error("restricted source request identity, sequence or envelope mismatch");
                const request = structuredClone(value);
                sequence = request.sequence;
                operations.add(request.operationId);
                const operation = request.operation;
                let result: RestrictedSourceResponse["result"];
                if (operation.kind === "begin") {
                    if (active !== undefined || reads.has(operation.readId) || reads.size >= RESTRICTED_SOURCE_MAX_READS)
                        throw new Error("restricted source read is overlapping, replayed or exhausted");
                    const provider = providers.get(operation.target?.adapterId);
                    const target =
                        provider === undefined
                            ? null
                            : decodeRestrictedSourceTarget(operation.target, provider, session.platformContext);
                    if (provider === undefined || target === null)
                        throw new Error("restricted source target is outside its approved Provider or Environment");
                    reads.add(operation.readId);
                    active = {
                        readId: operation.readId,
                        continuations: 0,
                        run: createRestrictedSourceReadRun({
                            provider,
                            target,
                            projection,
                            deadlineAt,
                            authority: { ...operation.authority, transactionsRoot: RESTRICTED_SOURCE_HOST_LOCK_AUTHORITY },
                        }),
                    };
                    result = { kind: "read_step", readId: active.readId, step: projectStep(await active.run.advance()) };
                } else {
                    if (active === undefined || operation.readId !== active.readId)
                        throw new Error("restricted source operation references no active read");
                    if (operation.kind === "continue") {
                        if (active.transfer !== undefined || ++active.continuations > RESTRICTED_SOURCE_MAX_CONTINUATIONS)
                            throw new Error("restricted source continuation is terminal or exhausted");
                        result = {
                            kind: "read_step",
                            readId: active.readId,
                            step: projectStep(await active.run.advance(operation.continuation)),
                        };
                    } else if (operation.kind === "result_chunk") {
                        if (active.transfer === undefined) throw new Error("restricted source result is not available");
                        result = {
                            kind: "result_chunk",
                            readId: active.readId,
                            chunk: active.transfer.next({ transferId: operation.transferId, offset: operation.offset }),
                        };
                    } else if (operation.kind === "acknowledge") {
                        if (active.transfer === undefined) throw new Error("restricted source result has not completed");
                        active.transfer.acknowledge({ transferId: operation.transferId, contentHash: operation.contentHash });
                        completion = active.run.settled();
                        active = undefined;
                        result = { kind: "acknowledged", readId: operation.readId };
                    } else {
                        active.run.cancel();
                        active.transfer?.dispose();
                        completion = active.run.settled();
                        await completion;
                        active = undefined;
                        result = { kind: "cancelled", readId: operation.readId };
                    }
                }
                requireCurrent();
                const { operation: _operation, ...envelope } = request;
                const response = { ...envelope, result };
                if (Buffer.byteLength(JSON.stringify(response), "utf8") > RESTRICTED_SOURCE_MAX_FRAME_BYTES)
                    throw new Error("restricted source response exceeds its frame capacity");
                return response;
            } catch (error) {
                close();
                throw error;
            } finally {
                handling = false;
            }
        },
        close,
        settled: () => active?.run.settled() ?? completion,
    });
}
