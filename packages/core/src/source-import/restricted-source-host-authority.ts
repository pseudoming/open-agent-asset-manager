/** State-owning Host controller for the original per-access source locks and final observed closure. */
import { acquireAllLocks, type LockHandle } from "../foundation/physical-path-locks";
import { stableStringify } from "../foundation/fingerprint";
import { hasExactKeys, isUuidV4 } from "../foundation/validators";
import type { ReadAuthorityRevalidator } from "../adapters/adapter-read-access";
import type { AdapterReadResult, AdapterReadTarget, CoreResult } from "../types";
import type { AdapterReadAuthorityContext, PreparedRead } from "./source-read-execution";
import { decodeRestrictedReadAuthorityIntent } from "./restricted-source-request";
import {
    restrictedReadAuthorityKeys,
    restrictedReadAuthorityIntentFingerprint,
    type RestrictedReadAuthorityIntent,
    type RestrictedReadAuthorityPermission,
} from "./restricted-source-read-operation";
import type { RestrictedSourceReadContinuation } from "./restricted-source-read-run";
import { validateAdapterReadResultSnapshot } from "./source-read-snapshot-validator";
import { isRestrictedSourceDiagnostics } from "./restricted-source-diagnostics";

export function createRestrictedSourceHostAuthority(input: {
    target: AdapterReadTarget;
    preparation: PreparedRead;
    authority: AdapterReadAuthorityContext;
    revalidateAuthority: ReadAuthorityRevalidator;
}) {
    const target = structuredClone(input.target);
    const prepared = structuredClone(input.preparation);
    const authority = structuredClone(input.authority);
    const revalidateAuthority = input.revalidateAuthority;
    const keyInput = { platform: prepared.platform, sourceRoots: prepared.roots };
    let held: LockHandle | null = null;
    let activeStepId: string | undefined;
    let finalIntent: RestrictedReadAuthorityIntent | undefined;
    let disposed = false;
    const steps = new Set<string>();

    function requireNewStep(value: unknown): string {
        if (disposed || value === null || typeof value !== "object")
            throw new Error("restricted source Host authority is closed");
        const id = (value as { stepId: unknown }).stepId;
        if (!isUuidV4(id) || steps.has(id)) throw new Error("restricted source authority step is invalid or replayed");
        return id;
    }

    return Object.freeze({
        grant(value: unknown): RestrictedSourceReadContinuation {
            const stepId = requireNewStep(value);
            const step = value as { kind: string; intent: unknown };
            const intent = decodeRestrictedReadAuthorityIntent(step.intent);
            if (
                !hasExactKeys(value, ["kind", "stepId", "intent"]) ||
                step.kind !== "acquire_authority" ||
                intent === null ||
                activeStepId !== undefined ||
                finalIntent !== undefined
            )
                throw new Error("restricted source authority request is malformed or out of order");
            const keys = restrictedReadAuthorityKeys(keyInput, intent);
            steps.add(stepId);
            activeStepId = stepId;
            if (intent.phase === "final_validate") finalIntent = intent;
            let permission: RestrictedReadAuthorityPermission;
            try {
                held = acquireAllLocks(authority.transactionsRoot, keys);
                // Durable authority is recomputed while all original physical locks are held, before service I/O.
                permission = held === null ? { state: "busy" } : revalidateAuthority() ? { state: "held" } : { state: "stale" };
            } catch (error) {
                permission = { state: "io_error", message: error instanceof Error ? error.message : String(error) };
            }
            return { stepId, intentFingerprint: restrictedReadAuthorityIntentFingerprint(intent), permission };
        },
        release(value: unknown): RestrictedSourceReadContinuation {
            const stepId = requireNewStep(value);
            const step = value as { kind: string; acquiredStepId: string };
            if (
                !hasExactKeys(value, ["kind", "stepId", "acquiredStepId"]) ||
                step.kind !== "release_authority" ||
                activeStepId === undefined ||
                step.acquiredStepId !== activeStepId
            )
                throw new Error("restricted source release does not match the active Host authority");
            steps.add(stepId);
            held?.release();
            held = null;
            activeStepId = undefined;
            return { stepId, released: true };
        },
        finish(result: CoreResult<AdapterReadResult>): CoreResult<AdapterReadResult> {
            if (disposed || activeStepId !== undefined || held !== null)
                throw new Error("restricted source result arrived before authority release");
            if (result.value === undefined) {
                if (
                    result.status !== "failed" ||
                    !isRestrictedSourceDiagnostics(result.diagnostics) ||
                    result.diagnostics.length === 0
                )
                    throw new Error("restricted source empty result is not a diagnosed failure");
                disposed = true;
                return result;
            }
            const read = result.value;
            if (
                finalIntent === undefined ||
                result.status !== read.status ||
                stableStringify(result.diagnostics) !== stableStringify(read.diagnostics) ||
                stableStringify(read.readTarget) !== stableStringify(target) ||
                read.readAuthorityFingerprint !== prepared.readAuthorityFingerprint ||
                stableStringify(read.sourceRoots) !== stableStringify(prepared.roots) ||
                stableStringify(read.sourceReadObligations) !== stableStringify(prepared.obligations)
            )
                throw new Error("restricted source result does not match its exact Host read authority");
            const observedTargets = read.observedReadEntries.map(({ sourceRootId, relativePath, entryKind }) => ({
                sourceRootId,
                relativePath,
                entryKind,
            }));
            // Include multiplicity: ignored or duplicate observations cannot disappear from the final admission.
            const canonicalTargets = (intent: RestrictedReadAuthorityIntent) => intent.targets.map(stableStringify).sort();
            if (
                stableStringify(canonicalTargets(finalIntent)) !==
                stableStringify(canonicalTargets({ phase: "final_validate", targets: observedTargets }))
            )
                throw new Error("restricted source final grant did not cover the entire observed ledger");
            const diagnostics = validateAdapterReadResultSnapshot(read);
            // The original pipeline returns diagnosed blocked results when a Provider produces an invalid candidate.
            // Preserve that normal refusal; never accept invalid candidates as a successful or partial read.
            if (
                diagnostics.length > 0 &&
                (read.status !== "failed" ||
                    read.sourceReports.some((report) => report.status !== "blocked") ||
                    diagnostics.some(
                        (diagnostic) => !read.diagnostics.some((known) => stableStringify(known) === stableStringify(diagnostic)),
                    ))
            )
                throw new Error("restricted source result has an invalid snapshot closure");
            disposed = true;
            return result;
        },
        /** The transport owner calls this only after normal completion or confirmed service quiescence. */
        dispose() {
            held?.release();
            held = null;
            activeStepId = undefined;
            disposed = true;
        },
    });
}
