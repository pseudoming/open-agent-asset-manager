/** Deployment observation attempt and complete-scan state transitions. */

import type { Database } from "better-sqlite3";
import type { PosixRelativePath } from "../types";
import { stableStringify } from "../foundation/fingerprint";
import { isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import { getDeployment, listDeploymentFiles, updateDeployment, upsertDeploymentFile } from "../persistence/state-db";
import { parseAppliedRenderSnapshotRef, parseDeploymentFileBaselineState } from "../render/deployment-render-authority";
import { canonicalEmptyBlockingEvidence } from "./deployment-state-authority-validation";

export type DeploymentObservationCommitFile =
    | {
          relativePath: PosixRelativePath;
          observedState: "present";
          observedContentHash: string;
          observedExecutable: boolean;
      }
    | { relativePath: PosixRelativePath; observedState: "missing" };

/** Exact active Deployment state captured before a user-requested observation.
 * A failed/partial attempt is recorded only while this body still matches, so
 * a stale operation cannot overwrite newer Deployment authority. */
export interface DeploymentObservationAttemptAnchorV1 {
    deploymentId: string;
    rowBody: string;
}

export function captureDeploymentObservationAttemptAnchor(
    db: Database,
    deploymentId: string,
): DeploymentObservationAttemptAnchorV1 | null {
    const row = getDeployment(db, deploymentId);
    if (row === null || row.deleted !== 0) return null;
    return { deploymentId, rowBody: stableStringify(row) };
}

/** Persist a terminal incomplete observation attempt without replacing the
 * prior complete-file evidence or its timestamp. Returns false when the
 * Deployment changed while the attempt was running. */
export function commitIncompleteDeploymentObservationAttempt(input: {
    db: Database;
    anchor: DeploymentObservationAttemptAnchorV1;
    state: "partial" | "failed";
    attemptedAt: number;
}): boolean {
    if (!isUuidV4(input.anchor.deploymentId)) throw new Error("observation anchor deploymentId must be UUID v4");
    if (!Number.isSafeInteger(input.attemptedAt) || input.attemptedAt <= 0) {
        throw new Error("observation attemptedAt must be a positive epoch millisecond");
    }
    if (input.state !== "partial" && input.state !== "failed") {
        throw new Error("incomplete observation state must be partial or failed");
    }
    return input.db.transaction(() => {
        const current = getDeployment(input.db, input.anchor.deploymentId);
        if (current === null || current.deleted !== 0 || stableStringify(current) !== input.anchor.rowBody) return false;
        if (input.attemptedAt < current.observationAttemptedAt || input.attemptedAt < current.updatedAt) {
            throw new Error("observation attempt time predates current Deployment authority");
        }
        updateDeployment(
            input.db,
            input.anchor.deploymentId,
            {
                observationState: input.state,
                observationAttemptedAt: input.attemptedAt,
            },
            input.attemptedAt,
        );
        return true;
    })();
}

/** Commit one complete observation without changing any successful baseline. */
export function commitDeploymentObservation(input: {
    db: Database;
    deploymentId: string;
    expectedCommittedTransactionId: string;
    expectedSnapshotFingerprint: string;
    files: DeploymentObservationCommitFile[];
    observedAt: number;
}): void {
    if (!isUuidV4(input.deploymentId)) throw new Error("observation deploymentId must be UUID v4");
    if (!isUuidV4(input.expectedCommittedTransactionId)) {
        throw new Error("expected committed transaction ID must be UUID v4");
    }
    if (!isSha256Digest(input.expectedSnapshotFingerprint)) {
        throw new Error("expected snapshot fingerprint must be SHA-256");
    }
    if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
        throw new Error("observedAt must be a non-negative safe integer");
    }
    for (const file of input.files) {
        if (!isCanonicalRelativePath(file.relativePath)) throw new Error("observation relativePath must be canonical");
        if (file.observedState !== "present" && file.observedState !== "missing") {
            throw new Error("observation state must be present or missing");
        }
        if (file.observedState === "present" && !isSha256Digest(file.observedContentHash)) {
            throw new Error("present observation content hash must be SHA-256");
        }
        if (file.observedState === "present" && typeof file.observedExecutable !== "boolean") {
            throw new Error("present observation executable flag must be boolean");
        }
    }
    input.db.transaction(() => {
        const deployment = getDeployment(input.db, input.deploymentId);
        if (deployment === null || deployment.deleted !== 0) {
            throw new Error("active Deployment not found while committing observation");
        }
        const snapshotRef = parseAppliedRenderSnapshotRef(deployment.appliedRenderSnapshotRef);
        if (
            deployment.committedTransactionId !== input.expectedCommittedTransactionId ||
            snapshotRef.snapshotState !== "applied" ||
            snapshotRef.snapshotFingerprint !== input.expectedSnapshotFingerprint
        ) {
            throw new Error("Deployment success authority changed during observation");
        }
        if (input.observedAt < deployment.observationAttemptedAt || input.observedAt < deployment.updatedAt) {
            throw new Error("observedAt predates current Deployment authority");
        }
        const activeRows = listDeploymentFiles(input.db, input.deploymentId, false).filter(
            (row) => parseDeploymentFileBaselineState(row.baselineState).rowState === "active",
        );
        const expectedPaths = activeRows.map((row) => row.relativePath).sort();
        const observedPaths = input.files.map((file) => file.relativePath).sort();
        if (
            new Set(observedPaths).size !== observedPaths.length ||
            JSON.stringify(expectedPaths) !== JSON.stringify(observedPaths)
        ) {
            throw new Error("observation does not cover the exact active baseline path set");
        }
        const observedByPath = new Map(input.files.map((file) => [file.relativePath, file]));
        for (const row of activeRows) {
            const observed = observedByPath.get(row.relativePath) as DeploymentObservationCommitFile;
            upsertDeploymentFile(
                input.db,
                input.deploymentId,
                row.relativePath,
                row.baselineState,
                observed.observedState,
                observed.observedState === "present" ? observed.observedContentHash : "",
                observed.observedState === "present" && observed.observedExecutable ? 1 : 0,
                input.observedAt,
                input.observedAt,
            );
        }
        updateDeployment(
            input.db,
            input.deploymentId,
            {
                observationState: "complete",
                observationAttemptedAt: input.observedAt,
                lastCompleteObservationAt: input.observedAt,
                blockingEvidence: JSON.stringify(canonicalEmptyBlockingEvidence()),
            },
            input.observedAt,
        );
    })();
}
