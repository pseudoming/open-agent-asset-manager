/** Explicit local implementation of the complete target transaction operations. */
import { getCanonicalPhysicalAccessPathKind } from "@oaam/shared/paths";
import { executePublications, finalizePublications, planPublications, recoverPublications } from "./deployment-publication";
import { publicationStagingRoot } from "./deployment-publication-io";
import { drivePublicationJournal, recordPublicationJournal } from "./deployment-publication-journal";
import { ensureManagedTargetDirectories, planManagedTargetDirectories } from "./deployment-managed-directory-execution";
import { verifyManagedDirectoryGraph } from "./deployment-managed-directory-graph";
import { cleanupTargetDirectories, removeTargetDirectories } from "./deployment-target-io";
import { applyRuntimeReplacementAuthority } from "./deployment-target-replacement";
import { recoverLocalTargetGraph } from "./local-target-recovery";
import {
    targetTransactionUnavailable,
    type DeploymentTargetTransactions,
    type PreparedTargetTransaction,
    type TargetTransactionFailure,
} from "./deployment-target-transaction";
import type { ActiveJournal, ActiveJournalV2, ActiveJournalV4, DirectoryJournal } from "./deployment-journal";
import type { DeploymentRow } from "../persistence/state-db";

/** Freeze the local operation's authorized identity before entering the shared transaction flow. */
export function bindLocalTargetTransactions(
    target: Pick<DeploymentRow, "deploymentId" | "platform" | "platformInstanceId" | "targetRootPath">,
): DeploymentTargetTransactions {
    const expected = { ...target };
    return Object.freeze<DeploymentTargetTransactions>({
        kind: "host",
        ownsDeployment(deployment) {
            return (
                localTargetTransactions.ownsDeployment(deployment) &&
                deployment.deploymentId === expected.deploymentId &&
                deployment.platform === expected.platform &&
                deployment.platformInstanceId === expected.platformInstanceId &&
                deployment.targetRootPath === expected.targetRootPath
            );
        },
        ownsJournal(journal) {
            return journal.deploymentId === expected.deploymentId && localTargetTransactions.ownsJournal(journal);
        },
        create(input) {
            if (input.ctx.targetRootPath !== expected.targetRootPath)
                throw new Error("local transaction root differs from its authorized operation");
            return localTargetTransactions.create(input);
        },
    });
}

function localJournal(journal: ActiveJournal): boolean {
    return (
        journal.schemaVersion === 1 ||
        journal.schemaVersion === 2 ||
        (journal.schemaVersion === 4 && journal.targetExecution.kind === "host")
    );
}

export const localTargetTransactions: DeploymentTargetTransactions = Object.freeze<DeploymentTargetTransactions>({
    kind: "host",
    ownsDeployment(deployment) {
        return deployment.platform !== "wsl" || getCanonicalPhysicalAccessPathKind(deployment.targetRootPath) !== "win32";
    },
    ownsJournal: localJournal,
    create({ ctx, transactionsRoot, deps }) {
        return {
            prepare(input) {
                const { entries, managedDirectoryBoundaries, desiredDirectoryPaths, runtimeReplacementAuthority } = input;
                const populated = deps.populateOldBytes(entries, ctx);
                if (populated.kind === "read_failed")
                    return targetTransactionUnavailable(`populateOldBytes read failed: ${populated.relativePath}`);
                if (runtimeReplacementAuthority !== undefined) {
                    const replacement = applyRuntimeReplacementAuthority(
                        entries,
                        ctx,
                        runtimeReplacementAuthority,
                        desiredDirectoryPaths,
                    );
                    if (replacement.status === "conflict") return { outcome: "conflict", reasonCode: replacement.reason };
                }
                const unsupported = deps.preflightExecutableTransitions(entries, ctx);
                if (unsupported !== null)
                    return {
                        outcome: "blocked",
                        reasonCode: "blocked_needs_support",
                        message: `target filesystem cannot preserve executable state for: ${unsupported}`,
                    };
                let directoryEntries: ReturnType<typeof planManagedTargetDirectories>;
                try {
                    directoryEntries = planManagedTargetDirectories(
                        ctx,
                        entries,
                        runtimeReplacementAuthority,
                        managedDirectoryBoundaries,
                        desiredDirectoryPaths,
                    );
                } catch (error) {
                    return targetTransactionUnavailable(`target directory preflight failed: ${String(error)}`);
                }

                const prepared: PreparedTargetTransaction = {
                    entries,
                    directoryEntries,
                    prepareJournal(base) {
                        if (runtimeReplacementAuthority?.replacementScope === undefined) return { ...base, schemaVersion: 2 };
                        const publications = planPublications(
                            ctx,
                            base.entries,
                            directoryEntries,
                            managedDirectoryBoundaries,
                            runtimeReplacementAuthority.replacementScope,
                        );
                        return {
                            ...base,
                            schemaVersion: 4,
                            targetExecution: { kind: "host" },
                            publicationPhase: "preparing",
                            publications,
                            staging: {
                                rootPath: publicationStagingRoot(
                                    ctx,
                                    input.transactionId,
                                    publications,
                                    managedDirectoryBoundaries,
                                    {
                                        stateRootPath: transactionsRoot,
                                        ...(input.projectRootPath === undefined
                                            ? {}
                                            : { projectRootPath: input.projectRootPath }),
                                    },
                                ),
                                identity: null,
                            },
                        };
                    },
                    execute(source) {
                        requireLocalJournal(source);
                        let journal = source;
                        if (journal.schemaVersion === 4) {
                            const result = drivePublicationJournal(executePublications(ctx, journal), journal, (previous, next) =>
                                recordPublicationJournal(transactionsRoot, previous, next, "execute"),
                            );
                            return result.outcome === "done"
                                ? { outcome: "executed", journal: result.journal }
                                : targetTransactionUnavailable(
                                      "prepared publication did not finish; journal retained for protective recovery",
                                  );
                        }
                        const ensured = ensureManagedTargetDirectories({
                            ctx,
                            journal,
                            transactionsRoot,
                            deleteJournal: deps.deleteJournal,
                        });
                        if (!ensured.ok) return targetTransactionUnavailable(ensured.message);
                        journal = ensured.journal;
                        const result = deps.casWriteAll(entries, ctx);
                        if (!result.ok && result.stop !== null && result.stop.kind !== "written") {
                            if (result.stop.kind !== "third_value")
                                return targetTransactionUnavailable(`write failed: ${result.stop.relativePath}`);
                            const written = new Set(result.mutated);
                            const rollback = deps.rollbackToOld(
                                entries.filter((entry) => written.has(entry.relativePath)),
                                ctx,
                            );
                            if (!rollback.ok)
                                return targetTransactionUnavailable(
                                    `conflict rollback incomplete; journal retained for recovery: ${rollback.failedRelativePaths.join(",")}`,
                                );
                            const directories = cleanupTargetDirectories(ctx, journal.directoryEntries);
                            if (!directories.ok)
                                return targetTransactionUnavailable(
                                    `conflict directory rollback incomplete; journal retained for recovery: ${directories.failedRelativePaths.join(",")}`,
                                );
                            return { outcome: "conflict", reasonCode: "" };
                        }
                        const removed = removeTargetDirectories(ctx, journal.directoryEntries);
                        if (!removed.ok)
                            return targetTransactionUnavailable(
                                `directory removal incomplete; journal retained for recovery: ${removed.failedRelativePaths.join(",")}`,
                            );
                        return { outcome: "executed", journal };
                    },
                    verify(journal) {
                        requireLocalJournal(journal);
                        const result = deps.verifyAll(entries, ctx);
                        if (!result.ok)
                            return {
                                outcome: "blocked",
                                reasonCode: "blocked_by_deploy_verification_failed",
                                message: "target file verification failed",
                                diagnostics: result.failures,
                            };
                        try {
                            if (
                                !verifyManagedDirectoryGraph({
                                    targetRootPath: ctx.targetRootPath,
                                    boundaries: journal.managedDirectoryBoundaries,
                                    files: journal.entries,
                                    directories: journal.directoryEntries,
                                    side: "new",
                                })
                            ) {
                                return verificationFailure("managed target directory does not match the exact reviewed graph");
                            }
                        } catch (error) {
                            return verificationFailure(`managed target directory could not be verified: ${String(error)}`);
                        }
                        return { outcome: "verified", verified: result.verified };
                    },
                    finalize(journal) {
                        requireLocalJournal(journal);
                        if (journal.schemaVersion === 4 && finalizePublications(ctx, journal) !== "done")
                            throw new Error("publication cleanup retains recovery material");
                    },
                };
                return { outcome: "ready", prepared };
            },
            recover(journal, side) {
                if (!localJournal(journal)) return "io_failed";
                if (journal.schemaVersion === 4) {
                    return drivePublicationJournal(recoverPublications(ctx, journal, side), journal, (previous, next) =>
                        recordPublicationJournal(transactionsRoot, previous, next, side),
                    ).outcome;
                }
                return recoverLocalTargetGraph(ctx, transactionsRoot, journal, side);
            },
        };
    },
});

function requireLocalJournal(journal: DirectoryJournal): asserts journal is ActiveJournalV2 | ActiveJournalV4 {
    if (!localJournal(journal)) throw new Error("local target operations cannot consume a selected-WSL journal");
}

function verificationFailure(message: string): TargetTransactionFailure {
    return { outcome: "blocked", reasonCode: "blocked_by_deploy_verification_failed", message };
}
