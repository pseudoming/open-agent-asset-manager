/** Selected-WSL operations compose the bound graph channel and Core's durable receipt writers. */
import type { DeploymentTargetExecution } from "../orchestration/restricted-target-channel";
import {
    recordJournalCreatedDirectory,
    recordJournalRestoredDirectory,
    type ActiveJournal,
    type ActiveJournalV3,
    type ActiveJournalV4,
} from "./deployment-journal";
import { recordPublicationJournal } from "./deployment-publication-journal";
import type { VerifiedTarget } from "./deployment-target-verify";
import {
    targetTransactionUnavailable,
    type DeploymentTargetTransactions,
    type PreparedTargetTransaction,
} from "./deployment-target-transaction";

export function selectedWslTargetTransactions(execution: DeploymentTargetExecution): DeploymentTargetTransactions {
    const binding = structuredClone(execution.binding);
    function ownsJournal(journal: ActiveJournal): journal is ActiveJournalV3 | ActiveJournalV4 {
        if (journal.deploymentId !== binding.deploymentId || (journal.schemaVersion !== 3 && journal.schemaVersion !== 4))
            return false;
        const recorded = journal.targetExecution;
        return (
            recorded.kind === "selected_wsl" &&
            recorded.platformInstanceId === binding.platformInstanceId &&
            recorded.targetRootPath === binding.targetRootPath &&
            recorded.executionRootPath === binding.executionRootPath
        );
    }
    return Object.freeze<DeploymentTargetTransactions>({
        kind: "selected_wsl",
        ownsDeployment(deployment) {
            return (
                deployment.platform === "wsl" &&
                binding.deploymentId === deployment.deploymentId &&
                binding.targetRootPath === deployment.targetRootPath &&
                binding.platformInstanceId === deployment.platformInstanceId &&
                execution.graph !== undefined &&
                execution.review !== undefined
            );
        },
        ownsJournal,
        create({ transactionsRoot }) {
            return {
                prepare(input) {
                    const publication = input.runtimeReplacementAuthority?.replacementScope !== undefined;
                    const result = execution.graph.prepare({
                        ...(publication ? { publicationTransactionId: input.transactionId } : {}),
                        ...(publication && input.projectRootPath !== undefined
                            ? { publicationProjectRootPath: input.projectRootPath }
                            : {}),
                        compilationFingerprint: input.compilationFingerprint,
                        entries: input.entries,
                        managedDirectoryBoundaries: input.managedDirectoryBoundaries,
                        desiredDirectoryPaths: input.desiredDirectoryPaths,
                        ...(input.runtimeReplacementAuthority === undefined
                            ? {}
                            : { runtimeReplacementAuthority: input.runtimeReplacementAuthority }),
                    });
                    if (result.outcome === "conflict") return { outcome: "conflict", reasonCode: "" };
                    if (result.outcome !== "ready")
                        return {
                            outcome: "blocked",
                            reasonCode:
                                result.outcome === "unsupported"
                                    ? "blocked_needs_support"
                                    : "blocked_by_deploy_target_unavailable",
                            message: "restricted target preparation did not establish readiness",
                        };
                    const graph = result.prepared;
                    let verified: VerifiedTarget[] | null = null;
                    const prepared: PreparedTargetTransaction = {
                        entries: graph.entries,
                        directoryEntries: graph.directoryEntries,
                        prepareJournal(base) {
                            return graph.publication === undefined
                                ? {
                                      ...base,
                                      schemaVersion: 3,
                                      targetExecution: graph.targetExecution,
                                      directoryEntries: graph.directoryEntries,
                                  }
                                : {
                                      ...base,
                                      schemaVersion: 4,
                                      targetExecution: graph.targetExecution,
                                      publicationPhase: "preparing",
                                      directoryEntries: graph.directoryEntries.map(
                                          ({ restoredIdentity: _restored, ...entry }) => entry,
                                      ),
                                      staging: graph.publication.staging,
                                      publications: graph.publication.publications,
                                  };
                        },
                        execute(journal) {
                            if (!ownsJournal(journal)) throw new Error("selected-WSL write journal mismatch");
                            const executed =
                                journal.schemaVersion === 4
                                    ? execution.graph.executePublication(graph.preparationId, journal, (previous, next) =>
                                          recordPublicationJournal(transactionsRoot, previous, next, "execute"),
                                      )
                                    : execution.graph.execute(
                                          graph.preparationId,
                                          journal,
                                          (current, relativePath, identity, side) => {
                                              if (side !== "new")
                                                  throw new Error(
                                                      "forward execution cannot record an old-side directory receipt",
                                                  );
                                              return recordJournalCreatedDirectory(
                                                  transactionsRoot,
                                                  current,
                                                  relativePath,
                                                  identity,
                                              );
                                          },
                                      );
                            if (executed.result.outcome === "verified") {
                                verified = executed.result.verified;
                                return { outcome: "executed", journal: executed.journal };
                            }
                            if (executed.result.outcome === "conflict") return { outcome: "conflict", reasonCode: "" };
                            return targetTransactionUnavailable(
                                "restricted target execution may have written; original journal retained for recovery",
                            );
                        },
                        verify(journal) {
                            if (!ownsJournal(journal) || verified === null)
                                throw new Error("selected-WSL verification has no successful execution receipt");
                            return { outcome: "verified", verified };
                        },
                        finalize(journal) {
                            if (!ownsJournal(journal)) throw new Error("selected-WSL finalization journal mismatch");
                            if (
                                journal.schemaVersion === 4 &&
                                execution.graph.recoverPublication(journal, "new", (previous, next) =>
                                    recordPublicationJournal(transactionsRoot, previous, next, "new"),
                                ).outcome !== "done"
                            ) {
                                throw new Error("publication cleanup retains recovery material");
                            }
                        },
                    };
                    return { outcome: "ready", prepared };
                },
                recover(journal, side) {
                    if (!ownsJournal(journal)) return "io_failed";
                    if (journal.schemaVersion === 4)
                        return execution.graph.recoverPublication(journal, side, (previous, next) =>
                            recordPublicationJournal(transactionsRoot, previous, next, side),
                        ).outcome;
                    const record = side === "new" ? recordJournalCreatedDirectory : recordJournalRestoredDirectory;
                    return execution.graph.recover(journal, side, (current, relativePath, identity) =>
                        record(transactionsRoot, current, relativePath, identity),
                    ).outcome;
                },
            };
        },
    });
}
