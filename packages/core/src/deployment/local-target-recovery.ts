/** Local graph recovery consumes the direction and validated journal selected by Core. */
import { recoverTargetFiles, type TargetRecoveryOutcome } from "./deployment-file-recovery";
import {
    getJournalDirectoryEntries,
    recordJournalCreatedDirectory,
    type ActiveJournal,
    type ActiveJournalV2,
} from "./deployment-journal";
import { verifyManagedDirectoryGraph } from "./deployment-managed-directory-graph";
import {
    cleanupTargetDirectories,
    ensureTargetDirectory,
    removeTargetDirectories,
    restoreTargetDirectory,
    type TargetIoContext,
} from "./deployment-target-io";

export function recoverLocalTargetGraph(
    ctx: TargetIoContext,
    transactionsRoot: string,
    journal: ActiveJournal,
    side: "old" | "new",
): TargetRecoveryOutcome {
    let current = journal;
    if (side === "new" && current.schemaVersion === 2) {
        for (const directory of current.directoryEntries.filter((entry) => entry.desiredState === "present")) {
            let ensured: ReturnType<typeof ensureTargetDirectory>;
            try {
                ensured = ensureTargetDirectory(ctx, directory);
            } catch {
                return "third_value";
            }
            if (!ensured.created) continue;
            try {
                current = recordJournalCreatedDirectory(
                    transactionsRoot,
                    current as ActiveJournalV2,
                    directory.relativePath,
                    ensured.identity,
                );
            } catch {
                return "io_failed";
            }
        }
    }
    const directories = getJournalDirectoryEntries(current);
    if (side === "old") {
        for (const directory of directories.filter((entry) => entry.oldState === "present")) {
            try {
                restoreTargetDirectory(ctx, directory);
            } catch {
                return "third_value";
            }
        }
    }
    const files = recoverTargetFiles(ctx, current.entries, side);
    if (files !== "done") return files;
    const completed = side === "new" ? removeTargetDirectories(ctx, directories) : cleanupTargetDirectories(ctx, directories);
    if (!completed.ok) return "io_failed";
    if (current.schemaVersion !== 1) {
        try {
            if (
                !verifyManagedDirectoryGraph({
                    targetRootPath: ctx.targetRootPath,
                    boundaries: current.managedDirectoryBoundaries,
                    files: current.entries,
                    directories,
                    side,
                })
            )
                return "io_failed";
        } catch {
            return "io_failed";
        }
    }
    return "done";
}
