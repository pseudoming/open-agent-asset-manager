/** Publication receipt validation and State-host persistence. The target service cannot edit authority. */
import { durableReplaceFile } from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath } from "@oaam/shared/paths";
import { stableStringify } from "../foundation/fingerprint";
import { isValidJournal, readJournal, type ActiveJournalV4 } from "./deployment-journal";
import type { PublicationOperation } from "./deployment-publication";
import type { TargetRecoveryOutcome } from "./deployment-file-recovery";
import type { JournalPublication } from "./deployment-publication-model";

function fixedPublicationAuthority(unit: JournalPublication) {
    return { kind: unit.kind, relativePath: unit.relativePath, completeReplacement: unit.completeReplacement };
}

export function isPublicationJournalTransition(
    previous: ActiveJournalV4,
    next: ActiveJournalV4,
    mode: "execute" | "old" | "new",
): boolean {
    if (!isValidJournal(next) || next.schemaVersion !== 4) return false;
    const { staging: beforeStaging, publications: before, publicationPhase: beforePhase, ...beforeAuthority } = previous;
    const { staging: afterStaging, publications: after, publicationPhase: afterPhase, ...afterAuthority } = next;
    if (
        stableStringify(beforeAuthority) !== stableStringify(afterAuthority) ||
        beforeStaging.rootPath !== afterStaging.rootPath ||
        before.length !== after.length
    )
        return false;
    if (beforePhase !== afterPhase)
        return (
            mode === "execute" &&
            beforePhase === "preparing" &&
            afterPhase === "publishing" &&
            afterStaging.identity !== null &&
            after.every(
                (unit) =>
                    unit.kind === "file" ||
                    unit.preparedIdentity !== null ||
                    !next.directoryEntries.some(
                        (entry) => entry.relativePath === unit.relativePath && entry.desiredState === "present",
                    ),
            ) &&
            stableStringify(beforeStaging) === stableStringify(afterStaging) &&
            stableStringify(before) === stableStringify(after)
        );
    if (stableStringify(beforeStaging) !== stableStringify(afterStaging)) {
        return (
            mode === "execute" &&
            beforeStaging.identity === null &&
            afterStaging.identity !== null &&
            stableStringify(before) === stableStringify(after)
        );
    }
    let changed = 0;
    for (let index = 0; index < before.length; index += 1) {
        const old = before[index]!,
            current = after[index]!;
        if (stableStringify(old) === stableStringify(current)) continue;
        changed += 1;
        if (stableStringify(fixedPublicationAuthority(old)) !== stableStringify(fixedPublicationAuthority(current))) return false;
        if (old.kind === "directory") {
            // The immutable authority comparison above establishes the same discriminant.
            const directory = current as Extract<JournalPublication, { kind: "directory" }>;
            if (
                stableStringify(old.oldTree) !== stableStringify(directory.oldTree) &&
                (mode !== "execute" || !old.completeReplacement)
            )
                return false;
            if (
                stableStringify(old.preparedIdentity) !== stableStringify(directory.preparedIdentity) &&
                (mode !== "execute" || old.preparedIdentity !== null || directory.preparedIdentity === null)
            )
                return false;
        }
        if (stableStringify(old.recovery) !== stableStringify(current.recovery) && current.recovery !== null) {
            if (current.recovery.side !== (mode === "execute" ? "new" : mode)) return false;
            if (
                old.recovery !== null &&
                (stableStringify(old.recovery.candidateIdentity) !== stableStringify(current.recovery.candidateIdentity) ||
                    (old.recovery.restoreIdentity !== null &&
                        stableStringify(old.recovery.restoreIdentity) !== stableStringify(current.recovery.restoreIdentity)))
            )
                return false;
        }
    }
    return changed === 1;
}

export function recordPublicationJournal(
    transactionsRoot: string,
    previous: ActiveJournalV4,
    next: ActiveJournalV4,
    mode: "execute" | "old" | "new",
): ActiveJournalV4 {
    if (
        !isPublicationJournalTransition(previous, next, mode) ||
        stableStringify(readJournal(transactionsRoot, previous.transactionId)) !== stableStringify(previous)
    )
        throw new Error("publication journal changed before its exact receipt");
    durableReplaceFile(joinPhysicalAccessPath(transactionsRoot, `${previous.transactionId}/journal.json`), JSON.stringify(next));
    const readback = readJournal(transactionsRoot, previous.transactionId);
    if (readback?.schemaVersion !== 4 || stableStringify(readback) !== stableStringify(next))
        throw new Error("publication journal receipt did not read back");
    return readback;
}

export function drivePublicationJournal(
    operation: PublicationOperation,
    journal: ActiveJournalV4,
    persist: (previous: ActiveJournalV4, next: ActiveJournalV4) => ActiveJournalV4,
): { outcome: TargetRecoveryOutcome; journal: ActiveJournalV4 } {
    let current = journal;
    try {
        for (;;) {
            const step = operation.next();
            if (step.done) return { outcome: step.value, journal: current };
            current = persist(current, step.value);
        }
    } catch {
        return { outcome: "io_failed", journal: current };
    }
}
