import { isCompleteReplacementPath } from "./deployment-publication-model";
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { compareUtf8Bytes } from "../foundation/text-order";
import { recordJournalCreatedDirectory, type ActiveJournalV2, type JournalEntry } from "./deployment-journal";
import {
    cleanupTargetDirectories,
    ensureTargetDirectory,
    planTargetDirectories,
    type TargetIoContext,
} from "./deployment-target-io";
import type { TargetPlan } from "./deployment-target-plan";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";

export function resolveManagedDirectoryBoundaryAuthority(
    plan: TargetPlan,
    baseline: readonly { readonly managedDirectoryBoundaryPaths: readonly string[] }[],
    authority: DeploymentRuntimeReplacementAuthorityV1 | undefined,
): string[] {
    const managedBoundaryPaths = [
        ...new Set([
            ...plan.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
            ...baseline.flatMap((file) => file.managedDirectoryBoundaryPaths),
        ]),
    ].sort(compareUtf8Bytes);
    if (managedBoundaryPaths.length > 0 && authority === undefined) {
        throw new Error("complete managed-directory deployment requires one exact fresh runtime preview authority");
    }
    if (
        authority !== undefined &&
        JSON.stringify(authority.managedDirectoryBoundaryPaths ?? []) !== JSON.stringify(managedBoundaryPaths)
    ) {
        throw new Error("runtime replacement authority does not cover the exact managed-directory boundary set");
    }
    if (
        authority !== undefined &&
        JSON.stringify(authority.desiredManagedDirectoryBoundaryPaths ?? []) !==
            JSON.stringify(plan.managedDirectoryBoundaries.map((boundary) => boundary.relativePath))
    ) {
        throw new Error("runtime replacement authority does not cover the exact desired managed-directory boundary set");
    }
    return managedBoundaryPaths;
}

export function planManagedTargetDirectories(
    ctx: TargetIoContext,
    entries: JournalEntry[],
    authority: DeploymentRuntimeReplacementAuthorityV1 | undefined,
    managedBoundaryPaths: string[],
    desiredManagedDirectoryPaths: string[],
) {
    const directoryAuthority = new Map<string, PhysicalPathIdentity>(
        (authority?.directories ?? [])
            .filter(
                (
                    directory,
                ): directory is Extract<
                    DeploymentRuntimeReplacementAuthorityV1["directories"][number],
                    { expectedState: "present" }
                > => directory.expectedState === "present",
            )
            .map((directory) => [directory.relativePath, directory.expectedIdentity]),
    );
    return planTargetDirectories(
        ctx,
        entries,
        (authority?.directoryRemovalPaths ?? [])
            .filter(
                (relativePath) =>
                    authority?.replacementScope === undefined ||
                    !isCompleteReplacementPath(authority.replacementScope, relativePath),
            )
            .map((relativePath) => {
                const expectedIdentity = directoryAuthority.get(relativePath);
                if (expectedIdentity === undefined) {
                    throw new Error(`reviewed directory removal is not present: ${relativePath}`);
                }
                return { relativePath, expectedIdentity };
            }),
        managedBoundaryPaths,
        desiredManagedDirectoryPaths,
    );
}

export function ensureManagedTargetDirectories(input: {
    ctx: TargetIoContext;
    journal: ActiveJournalV2;
    transactionsRoot: string;
    deleteJournal: (transactionsRoot: string, transactionId: string) => boolean;
}): { ok: true; journal: ActiveJournalV2 } | { ok: false; message: string } {
    let journal = input.journal;
    for (const directoryEntry of journal.directoryEntries.filter((entry) => entry.desiredState === "present")) {
        let ensured: ReturnType<typeof ensureTargetDirectory>;
        try {
            ensured = ensureTargetDirectory(input.ctx, directoryEntry);
        } catch (error) {
            return { ok: false, message: `target directory ensure failed: ${directoryEntry.relativePath}: ${String(error)}` };
        }
        if (!ensured.created) continue;
        const transientJournal: ActiveJournalV2 = {
            ...journal,
            directoryEntries: journal.directoryEntries.map((entry) =>
                entry.relativePath === directoryEntry.relativePath ? { ...entry, createdIdentity: ensured.identity } : entry,
            ),
        };
        try {
            journal = recordJournalCreatedDirectory(
                input.transactionsRoot,
                journal,
                directoryEntry.relativePath,
                ensured.identity,
            );
        } catch (error) {
            const cleanup = cleanupTargetDirectories(input.ctx, transientJournal.directoryEntries);
            if (cleanup.ok) {
                try {
                    input.deleteJournal(input.transactionsRoot, journal.transactionId);
                } catch {
                    // Target is restored; preserve the original directory-receipt failure.
                }
            }
            return { ok: false, message: `created directory receipt failed: ${directoryEntry.relativePath}: ${String(error)}` };
        }
    }
    return { ok: true, journal };
}
