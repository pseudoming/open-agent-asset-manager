/** V4 generator admission and exact receipt barriers inside the restricted target service. */
import { stableStringify } from "../foundation/fingerprint";
import type { ActiveJournalV4 } from "./deployment-journal";
import { executePublications, recoverPublications, type PublicationOperation } from "./deployment-publication";
import { isPublicationJournalTransition } from "./deployment-publication-journal";
import { createTargetIo } from "./deployment-target-io";
import { verifyAll } from "./deployment-target-verify";
import { verifyManagedDirectoryGraph } from "./deployment-managed-directory-graph";
import { restrictedGraphJournalFingerprint, type RestrictedGraphStep } from "./restricted-target-graph-contract";

export function createRestrictedPublicationOperation(executionRootPath: string, requireRoot: () => void) {
    const ctx = createTargetIo(executionRootPath);
    type Pending = {
        operation: PublicationOperation;
        journal: ActiveJournalV4;
        awaiting: ActiveJournalV4 | null;
        mode: "execute" | "old" | "new";
    };
    let active: Pending | null = null;
    function advance(state: Pending): RestrictedGraphStep {
        requireRoot();
        const step = state.operation.next();
        requireRoot();
        if (!step.done) {
            if (!isPublicationJournalTransition(state.journal, step.value, state.mode))
                throw new Error("invalid publication receipt transition");
            state.awaiting = structuredClone(step.value);
            return {
                kind: "publication_receipt_required",
                journalFingerprint: restrictedGraphJournalFingerprint(state.journal),
                journal: structuredClone(step.value),
            };
        }
        active = null;
        if (state.mode !== "execute") return { kind: "recovered", outcome: step.value };
        if (step.value !== "done") return { kind: "executed", result: { outcome: "uncertain" } };
        const verified = verifyAll(state.journal.entries, ctx);
        const graph = verifyManagedDirectoryGraph({
            targetRootPath: executionRootPath,
            boundaries: state.journal.managedDirectoryBoundaries,
            files: state.journal.entries,
            directories: state.journal.directoryEntries,
            side: "new",
        });
        return {
            kind: "executed",
            result: verified.ok && graph ? { outcome: "verified", verified: verified.verified } : { outcome: "uncertain" },
        };
    }
    return {
        get pending() {
            return active !== null;
        },
        start(journal: ActiveJournalV4, mode: "execute" | "old" | "new"): RestrictedGraphStep {
            if (active !== null) throw new Error("publication cannot replace a pending receipt");
            active = {
                journal: structuredClone(journal),
                mode,
                awaiting: null,
                operation: mode === "execute" ? executePublications(ctx, journal) : recoverPublications(ctx, journal, mode),
            };
            return advance(active);
        },
        continue(journal: ActiveJournalV4): RestrictedGraphStep {
            if (active === null || active.awaiting === null || stableStringify(active.awaiting) !== stableStringify(journal))
                throw new Error("publication receipt was not persisted exactly");
            active.journal = structuredClone(journal);
            active.awaiting = null;
            return advance(active);
        },
    };
}
