/** Host-owned V4 receipt persistence over the existing bounded graph channel. */
import { hasExactKeys } from "../foundation/validators";
import { stableStringify } from "../foundation/fingerprint";
import { isValidJournal, type ActiveJournalV4 } from "./deployment-journal";
import { isPublicationJournalTransition } from "./deployment-publication-journal";
import { restrictedGraphJournalFingerprint, type RestrictedGraphStep } from "./restricted-target-graph-contract";
import type { TargetRecoveryOutcome } from "./deployment-file-recovery";
import type {
    RestrictedTargetBinding,
    RestrictedTargetExecutionResult,
    RestrictedTargetOperation,
} from "./restricted-target-contract";

export type PersistPublicationReceipt = (previous: ActiveJournalV4, next: ActiveJournalV4) => ActiveJournalV4;
export interface DeploymentTargetPublicationExecution {
    executePublication(
        preparationId: string,
        journal: ActiveJournalV4,
        persist: PersistPublicationReceipt,
    ): { result: RestrictedTargetExecutionResult; journal: ActiveJournalV4 };
    recoverPublication(
        journal: ActiveJournalV4,
        side: "old" | "new",
        persist: PersistPublicationReceipt,
    ): { outcome: TargetRecoveryOutcome; journal: ActiveJournalV4 };
}

export function bindRestrictedPublicationChannel(
    binding: RestrictedTargetBinding,
    stepFor: (operation: RestrictedTargetOperation) => RestrictedGraphStep,
    invalidate: () => void,
    validExecutionResult: (result: RestrictedTargetExecutionResult, journal: ActiveJournalV4) => boolean,
): DeploymentTargetPublicationExecution {
    function requireJournal(journal: ActiveJournalV4) {
        if (
            !isValidJournal(journal) ||
            journal.schemaVersion !== 4 ||
            journal.deploymentId !== binding.deploymentId ||
            journal.targetExecution.kind !== "selected_wsl" ||
            journal.targetExecution.platformInstanceId !== binding.platformInstanceId ||
            journal.targetExecution.targetRootPath !== binding.targetRootPath ||
            journal.targetExecution.executionRootPath !== binding.executionRootPath
        )
            throw new Error("publication journal binding mismatch");
    }
    function drive(
        operation: RestrictedTargetOperation,
        source: ActiveJournalV4,
        mode: "execute" | "old" | "new",
        persist: PersistPublicationReceipt,
    ) {
        let journal = structuredClone(source);
        try {
            requireJournal(journal);
            let step = stepFor(operation);
            let receipts = 0;
            while (step?.kind === "publication_receipt_required") {
                if (
                    !hasExactKeys(step, ["kind", "journalFingerprint", "journal"]) ||
                    step.journalFingerprint !== restrictedGraphJournalFingerprint(journal) ||
                    !isPublicationJournalTransition(journal, step.journal, mode) ||
                    ++receipts > 4 + 8 * (source.publications.length + source.entries.length)
                )
                    throw new Error("publication receipt changes authority or exceeds its bounded sequence");
                requireJournal(step.journal);
                const next = persist(journal, structuredClone(step.journal));
                if (stableStringify(next) !== stableStringify(step.journal))
                    throw new Error("publication receipt was not returned exactly");
                journal = structuredClone(next);
                step = stepFor({ kind: "continue_graph", journal });
            }
            return { step, journal };
        } catch {
            invalidate();
            return { step: null, journal };
        }
    }
    return {
        executePublication(preparationId, journal, persist) {
            const driven = drive({ kind: "execute_graph", preparationId, journal }, journal, "execute", persist);
            if (
                driven.step?.kind !== "executed" ||
                !hasExactKeys(driven.step, ["kind", "result"]) ||
                !validExecutionResult(driven.step.result, driven.journal)
            ) {
                invalidate();
                return { result: { outcome: "uncertain" }, journal: driven.journal };
            }
            return { result: driven.step.result, journal: driven.journal };
        },
        recoverPublication(journal, side, persist) {
            const driven = drive({ kind: "recover_graph", journal, side }, journal, side, persist);
            if (
                driven.step?.kind !== "recovered" ||
                !hasExactKeys(driven.step, ["kind", "outcome"]) ||
                !["done", "third_value", "io_failed"].includes(driven.step.outcome)
            ) {
                invalidate();
                return { outcome: "io_failed", journal: driven.journal };
            }
            return { outcome: driven.step.outcome, journal: driven.journal };
        },
    };
}
