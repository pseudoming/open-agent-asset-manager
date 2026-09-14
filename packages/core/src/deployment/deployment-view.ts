/** Strict public Deployment projection from the one canonical durable-state decoder. */

import type { Database } from "better-sqlite3";
import type { DeploymentFileBaselineStateV1, DeploymentFileView, DeploymentView, UuidV4 } from "../types";
import { parseAppliedInputsSnapshot } from "../render/deployment-render-authority";
import { readCanonicalDeploymentPreCommitDatabaseStateFromConnection } from "./deployment-state-authority";
import { deriveDeploymentStatus } from "./deployment-state";
import { scanJournals } from "./deployment-journal";
import { getDeployment } from "../persistence/state-db";

export interface ReadDeploymentViewInput {
    db: Database;
    transactionsRoot: string;
    deploymentId: UuidV4;
}

export function readDeploymentView(input: ReadDeploymentViewInput): DeploymentView | null {
    const authority = input.db.transaction(() => {
        const row = getDeployment(input.db, input.deploymentId);
        if (row === null) return null;
        return {
            canonical: readCanonicalDeploymentPreCommitDatabaseStateFromConnection(input.db, input.deploymentId),
            appliedInputsSnapshot: parseAppliedInputsSnapshot(row.appliedInputsSnapshot, input.deploymentId),
        };
    })();
    if (authority === null) return null;
    const { canonical, appliedInputsSnapshot } = authority;
    const files: DeploymentFileView[] = canonical.deploymentFiles.map((file) => {
        const baselineState: DeploymentFileBaselineStateV1 =
            file.rowState === "active"
                ? {
                      rowState: "active",
                      appliedPayload: structuredClone(file.appliedPayload),
                      appliedExecutable: file.appliedExecutable,
                      provenance: structuredClone(file.provenance),
                  }
                : {
                      rowState: "removed",
                      latestResidualAuthorityId: file.latestResidualAuthorityId,
                  };
        return file.observation.observedState === "present"
            ? {
                  relativePath: file.relativePath,
                  baselineState,
                  observedState: "present",
                  observedContentHash: file.observation.observedContentHash,
                  observedExecutable: file.observation.observedExecutable,
                  observedAt: file.observedAt,
              }
            : {
                  relativePath: file.relativePath,
                  baselineState,
                  observedState: "missing",
                  observedAt: file.observedAt,
              };
    });
    const journalScan = scanJournals(input.transactionsRoot, input.deploymentId);
    const hasUnresolvedJournal = journalScan.matchingTxnIds.length > 0 || journalScan.corruptTxnIds.length > 0;
    const blockingEvidence = canonical.deployment.blockingEvidence;
    const assets = canonical.deploymentAssets
        .filter((asset) => !asset.deleted)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((asset) => ({ assetId: asset.assetId, versionId: asset.versionId, allowIncomplete: asset.allowIncomplete }));
    const selectionChanged =
        canonical.deployment.consumerAgentRuntimeIds.length !== appliedInputsSnapshot.consumerAgentRuntimeIds.length ||
        canonical.deployment.consumerAgentRuntimeIds.some(
            (id, index) => id !== appliedInputsSnapshot.consumerAgentRuntimeIds[index],
        ) ||
        assets.length !== appliedInputsSnapshot.assets.length ||
        assets.some((asset, index) => {
            const applied = appliedInputsSnapshot.assets[index];
            return (
                asset.assetId !== applied.assetId ||
                asset.versionId !== applied.versionId ||
                asset.allowIncomplete !== applied.allowIncomplete
            );
        });
    const derivedStatus = deriveDeploymentStatus({
        deleted: canonical.deployment.deleted,
        observationState: canonical.deployment.observationState,
        blockingEvidence,
        hasUnresolvedJournal,
        recoveryFailed: blockingEvidence.reasonCode.startsWith("blocked_by_recovery_"),
        hasAppliedBaseline: canonical.deployment.committedTransactionId !== "",
        fileObservations: canonical.deploymentFiles.flatMap((file) =>
            file.rowState === "removed"
                ? []
                : [
                      {
                          relativePath: file.relativePath,
                          appliedContentHash: file.appliedPayload.contentHash,
                          observedState: file.observation.observedState,
                          observedContentHash:
                              file.observation.observedState === "present" ? file.observation.observedContentHash : "",
                          appliedExecutable: file.appliedExecutable,
                          observedExecutable:
                              file.observation.observedState === "present" ? file.observation.observedExecutable : false,
                      },
                  ],
        ),
    });
    return {
        deploymentId: input.deploymentId,
        projectId: canonical.deployment.projectId,
        consumerAgentRuntimeIds: structuredClone(canonical.deployment.consumerAgentRuntimeIds),
        platform: canonical.deployment.platform,
        platformInstanceId: canonical.deployment.platformInstanceId,
        targetRootPath: canonical.deployment.targetRootPath,
        appliedInputsSnapshot,
        observationState: canonical.deployment.observationState,
        observationAttemptedAt: canonical.deployment.observationAttemptedAt,
        lastCompleteObservationAt: canonical.deployment.lastCompleteObservationAt,
        blockingEvidence: structuredClone(blockingEvidence),
        deleted: canonical.deployment.deleted,
        createdAt: canonical.deployment.createdAt,
        updatedAt: canonical.deployment.updatedAt,
        derivedStatus:
            canonical.deployment.committedTransactionId !== "" &&
            selectionChanged &&
            derivedStatus.stage !== "deleted" &&
            derivedStatus.stage !== "blocked"
                ? { ...derivedStatus, actionHints: [...new Set([...derivedStatus.actionHints, "review_deployment" as const])] }
                : derivedStatus,
        assets,
        files,
    };
}
