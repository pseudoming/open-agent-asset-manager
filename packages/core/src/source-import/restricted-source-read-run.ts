/** One suspended Provider read; continuations grant/release Host authority without replaying it. */
import { randomUUID } from "node:crypto";
import type { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { hasExactKeys } from "../foundation/validators";
import type { AdapterProvider, AdapterReadResult, AdapterReadTarget, CoreResult, Sha256Digest } from "../types";
import {
    createRestrictedSourceReadOperation,
    restrictedReadAuthorityIntentFingerprint,
    type RestrictedReadAuthorityIntent,
    type RestrictedReadAuthorityOwner,
    type RestrictedReadAuthorityPermission,
} from "./restricted-source-read-operation";
import { executeAdapterReadWithOperationOwner, type AdapterReadAuthorityContext } from "./source-read-execution";
import { failedResult, sourceDiagnostic } from "./source-read-validation-helpers";

export type RestrictedSourceReadStep =
    | { kind: "acquire_authority"; stepId: string; intent: RestrictedReadAuthorityIntent }
    | { kind: "release_authority"; stepId: string; acquiredStepId: string }
    | { kind: "complete"; result: CoreResult<AdapterReadResult> };
export type RestrictedSourceReadContinuation =
    | { stepId: string; intentFingerprint: Sha256Digest; permission: RestrictedReadAuthorityPermission }
    | { stepId: string; released: true };
type PendingStep = Exclude<RestrictedSourceReadStep, { kind: "complete" }>;
type StepContinuation<T extends PendingStep> = T extends { kind: "acquire_authority" }
    ? Extract<RestrictedSourceReadContinuation, { permission: RestrictedReadAuthorityPermission }>
    : Extract<RestrictedSourceReadContinuation, { released: true }>;
interface Decision {
    step: PendingStep;
    resolve(value: RestrictedSourceReadContinuation): void;
    reject(error: unknown): void;
}

export function createRestrictedSourceReadRun(input: {
    provider: AdapterProvider;
    target: AdapterReadTarget;
    authority: AdapterReadAuthorityContext;
    projection: ReturnType<typeof createSelectedWslPathProjection>;
    deadlineAt: number;
}) {
    if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 600_000)
        throw new Error("invalid restricted source read deadline");
    const target = structuredClone(input.target);
    const authority = structuredClone(input.authority);
    const deadlineAt = input.deadlineAt;
    const provider = input.provider;
    const projection = input.projection;
    let started = false;
    let advancing = false;
    let closed = false;
    let complete = false;
    let pending: Decision | undefined;
    let waiter: { resolve(step: RestrictedSourceReadStep): void; reject(error: unknown): void } | undefined;
    let completion: Promise<void> | undefined;

    function requireOpen() {
        if (closed || Date.now() >= deadlineAt) throw new Error("restricted source read is closed or expired");
    }
    function emit(step: RestrictedSourceReadStep) {
        requireOpen();
        // advance installs the sole waiter synchronously before any producer Promise resumes.
        // The operation seals new access before its final result, so no late producer can bypass it.
        const current = waiter!;
        waiter = undefined;
        current.resolve(step);
    }
    function decision<T extends PendingStep>(step: T): Promise<StepContinuation<T>> {
        requireOpen();
        return new Promise((resolve, reject) => {
            // The operation tail serializes decisions; advance alone validates and resolves this exact step.
            pending = { step, resolve: (value) => resolve(value as StepContinuation<T>), reject };
            emit(step);
        });
    }
    async function take(): Promise<RestrictedSourceReadStep> {
        requireOpen();
        // advance owns a single consumer until its pending take settles.
        return new Promise((resolve, reject) => {
            waiter = { resolve, reject };
        });
    }
    const owner: RestrictedReadAuthorityOwner = {
        async withAuthority(intent, run) {
            const acquiredStepId = randomUUID();
            const permitted = await decision({
                kind: "acquire_authority",
                stepId: acquiredStepId,
                intent: structuredClone(intent),
            });
            requireOpen();
            const outcome = await (async () => {
                try {
                    return { kind: "complete" as const, value: await run(permitted.permission) };
                } catch (error) {
                    return { kind: "failed" as const, error };
                }
            })();
            // A read outcome may escape only after the Host acknowledges release, including failed reads.
            await decision({ kind: "release_authority", stepId: randomUUID(), acquiredStepId });
            if (outcome.kind === "failed") throw outcome.error;
            return outcome.value;
        },
    };

    function start() {
        started = true;
        completion = executeAdapterReadWithOperationOwner(provider, target, authority, (operationInput) =>
            createRestrictedSourceReadOperation(operationInput, projection, owner),
        ).then(
            (result) => finish(result),
            (error) => finish(failedResult([sourceDiagnostic("read.restricted_operation_failed", String(error))])),
        );
    }
    function finish(result: CoreResult<AdapterReadResult>) {
        if (closed) return;
        complete = true;
        try {
            emit({ kind: "complete", result });
        } catch (error) {
            cancel(error);
        }
    }
    function cancel(error: unknown = new Error("restricted source read was cancelled")) {
        closed = true;
        const current = pending;
        pending = undefined;
        current?.reject(error);
        const waiting = waiter;
        waiter = undefined;
        waiting?.reject(error);
    }

    return Object.freeze({
        async advance(continuation?: RestrictedSourceReadContinuation): Promise<RestrictedSourceReadStep> {
            if (advancing) throw new Error("restricted source read already has an active continuation");
            advancing = true;
            try {
                requireOpen();
                if (!started) {
                    if (continuation !== undefined) throw new Error("restricted source read has not requested authority");
                    start();
                } else {
                    if (
                        complete ||
                        pending === undefined ||
                        continuation === undefined ||
                        continuation.stepId !== pending.step.stepId
                    )
                        throw new Error("restricted source continuation is stale or unrelated");
                    const valid =
                        pending.step.kind === "acquire_authority"
                            ? hasExactKeys(continuation, ["stepId", "intentFingerprint", "permission"]) &&
                              "permission" in continuation &&
                              continuation.intentFingerprint === restrictedReadAuthorityIntentFingerprint(pending.step.intent) &&
                              isRestrictedReadAuthorityPermission(continuation.permission)
                            : hasExactKeys(continuation, ["stepId", "released"]) &&
                              "released" in continuation &&
                              continuation.released === true;
                    if (!valid) throw new Error("restricted source continuation has invalid authority metadata");
                    const current = pending;
                    pending = undefined;
                    current.resolve(structuredClone(continuation));
                }
                return await take();
            } catch (error) {
                cancel(error);
                throw error;
            } finally {
                advancing = false;
            }
        },
        cancel,
        /** Join only after a bounded Provider/control has been cancelled or reached its terminal. */
        settled: () => completion ?? Promise.resolve(),
    });
}

export function isRestrictedReadAuthorityPermission(value: unknown): value is RestrictedReadAuthorityPermission {
    if (value === null || typeof value !== "object") return false;
    const permission = value as RestrictedReadAuthorityPermission;
    return permission.state === "io_error"
        ? hasExactKeys(permission, ["state", "message"]) && typeof permission.message === "string"
        : ["held", "busy", "stale"].includes(permission.state) && hasExactKeys(permission, ["state"]);
}
