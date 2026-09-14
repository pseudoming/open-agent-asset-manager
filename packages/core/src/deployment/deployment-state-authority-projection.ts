/** Strict Deployment database-state and success-postcondition projection. */

import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "better-sqlite3";
import type { DeploymentFileAuthorityProjectionV1, DeploymentResidualRenderAuthorityV1 } from "../contracts/deployment-authority";
import type { AgentRuntimeId, Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { DeploymentBlockingEvidenceV1 } from "../types";
import {
    parseAppliedInputsSnapshot,
    parseAppliedRenderSnapshot,
    parseAppliedRenderSnapshotRef,
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthorityRow,
    projectDeploymentFileAuthority,
    validateAppliedInputsSnapshot,
    validateAppliedRenderSnapshot,
    validateDeploymentResidualAuthority,
} from "../render/deployment-render-authority";
import { assertCurrentDeploymentInputs, type DeploymentSuccessCommitInputV1 } from "./deployment-state-ops";
import {
    computeAppliedInputsSnapshotFingerprint,
    computeAppliedRenderSnapshotFingerprint,
    computeDeploymentAssetId,
    computeDeploymentFileId,
} from "../foundation/fingerprint";
import {
    getDeployment,
    getDeploymentRenderSnapshot,
    listDeploymentAssets,
    listDeploymentFiles,
    listDeploymentResidualAuthorities,
    type DeploymentFileRow,
} from "../persistence/state-db";
import {
    isCanonicalRelativePath,
    isCanonicalTargetRootPath,
    isNonNegativeInteger,
    isSha256Digest,
    isUuidV4,
} from "../foundation/validators";
import type {
    DeploymentFileBaselinePostconditionEntryV1,
    DeploymentSuccessPostconditionV1,
    CanonicalDeploymentPreCommitDatabaseStateV1,
} from "./deployment-state-authority-model";
import {
    validateDeploymentSuccessPostcondition,
    validateCanonicalPreState,
    validateBlockingEvidence,
    canonicalEmptyBlockingEvidence,
    requireCanonicalEmptyBlockingEvidence,
    requireUuid,
    requirePlatform,
    requireObservationState,
    requireBinary,
    requireTimePair,
    requireSorted,
    compareUtf8Bytes,
    requireDatabasePath,
} from "./deployment-state-authority-validation";

export function readCanonicalDeploymentPreCommitDatabaseState(
    databasePath: string,
    deploymentId: UuidV4,
): CanonicalDeploymentPreCommitDatabaseStateV1 {
    requireDatabasePath(databasePath);
    requireUuid(deploymentId, "deploymentId");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        return readCanonicalPreStateFromConnection(db, deploymentId);
    } finally {
        db.close();
    }
}

/**
 * Internal Core projection on an already-owned connection. This is the single strict
 * Deployment-row/file/asset authority decoder used by CoreService views and render input.
 */
export function readCanonicalDeploymentPreCommitDatabaseStateFromConnection(
    db: DatabaseConnection,
    deploymentId: UuidV4,
): CanonicalDeploymentPreCommitDatabaseStateV1 {
    requireUuid(deploymentId, "deploymentId");
    return readCanonicalPreStateFromConnection(db, deploymentId);
}

export function readDeploymentSuccessPostcondition(
    databasePath: string,
    deploymentId: UuidV4,
    commitTransactionId: UuidV4,
): DeploymentSuccessPostconditionV1 {
    requireDatabasePath(databasePath);
    requireUuid(deploymentId, "deploymentId");
    requireUuid(commitTransactionId, "commitTransactionId");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        return readSuccessPostconditionFromConnection(db, deploymentId, commitTransactionId);
    } finally {
        db.close();
    }
}

export function readCanonicalPreStateFromConnection(
    db: DatabaseConnection,
    deploymentId: UuidV4,
): CanonicalDeploymentPreCommitDatabaseStateV1 {
    const deployment = getDeployment(db, deploymentId);
    if (deployment === null) throw new Error("canonical pre-state Deployment not found");
    const consumers = parseConsumerAgentRuntimeIds(deployment.consumerAgentRuntimeIds);
    const appliedInputs = parseAppliedInputsSnapshot(deployment.appliedInputsSnapshot, deploymentId);
    const snapshotRef = parseAppliedRenderSnapshotRef(deployment.appliedRenderSnapshotRef);
    let appliedRenderSnapshotFingerprint: Sha256Digest;
    if (snapshotRef.snapshotState === "never") {
        appliedRenderSnapshotFingerprint = computeAppliedRenderSnapshotFingerprint({
            schemaVersion: 1,
            snapshotState: "never",
        });
    } else {
        const snapshotRow = getDeploymentRenderSnapshot(db, deploymentId, snapshotRef.snapshotFingerprint);
        if (snapshotRow === null || snapshotRow.deleted !== 0) {
            throw new Error("canonical pre-state current render snapshot is unresolved");
        }
        const snapshot = parseAppliedRenderSnapshot(snapshotRow.snapshotJson, snapshotRef.snapshotFingerprint);
        if (snapshot.snapshotState !== "applied") {
            throw new Error("canonical pre-state current render snapshot is not applied");
        }
        appliedRenderSnapshotFingerprint = snapshotRef.snapshotFingerprint;
    }
    const blockingEvidence = parseBlockingEvidence(deployment.blockingEvidence);
    const platform = requirePlatform(deployment.platform);
    if (deployment.platformInstanceId.trim() === "" || deployment.platformInstanceId.includes("\0")) {
        throw new Error("canonical pre-state platformInstanceId must be non-blank and NUL-free");
    }
    if (!isCanonicalTargetRootPath(deployment.targetRootPath, platform)) {
        throw new Error("canonical pre-state targetRootPath is invalid");
    }
    if (deployment.projectId !== "" && !isUuidV4(deployment.projectId)) {
        throw new Error("canonical pre-state projectId must be empty or UUID v4");
    }
    if (deployment.committedTransactionId !== "" && !isUuidV4(deployment.committedTransactionId)) {
        throw new Error("canonical pre-state committedTransactionId is invalid");
    }
    const observationState = requireObservationState(deployment.observationState);
    requireObservationTimes(
        deployment.observationAttemptedAt,
        deployment.lastCompleteObservationAt,
        observationState,
        "canonical pre-state",
    );
    requireBinary(deployment.deleted, "Deployment.deleted");
    requireTimePair(deployment.createdAt, deployment.updatedAt, "Deployment");

    const residualAuthorities = readResidualAuthorities(db, deploymentId);
    const residualById = new Map(residualAuthorities.map((authority) => [authority.residualAuthorityId, authority]));
    const deploymentFiles = listDeploymentFiles(db, deploymentId, false)
        .map((row) => projectCurrentFile(row, deploymentId, db, residualById))
        .sort((left, right) => compareUtf8Bytes(left.deploymentFileId, right.deploymentFileId));

    const deploymentAssets = listDeploymentAssets(db, deploymentId, true)
        .map((row) => {
            if (
                row.deploymentAssetId !== computeDeploymentAssetId(deploymentId, row.assetId) ||
                !isUuidV4(row.assetId) ||
                !isUuidV4(row.versionId) ||
                !isNonNegativeInteger(row.sortOrder)
            ) {
                throw new Error("canonical pre-state DeploymentAsset is invalid");
            }
            requireBinary(row.allowIncomplete, "DeploymentAsset.allowIncomplete");
            requireBinary(row.deleted, "DeploymentAsset.deleted");
            requireTimePair(row.createdAt, row.updatedAt, "DeploymentAsset");
            return {
                deploymentAssetId: row.deploymentAssetId,
                assetId: row.assetId as UuidV4,
                versionId: row.versionId as UuidV4,
                sortOrder: row.sortOrder,
                allowIncomplete: row.allowIncomplete === 1,
                deleted: row.deleted === 1,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            };
        })
        .sort((left, right) => compareUtf8Bytes(left.deploymentAssetId, right.deploymentAssetId));

    const state: CanonicalDeploymentPreCommitDatabaseStateV1 = {
        schemaVersion: 1,
        deployment: {
            deploymentId,
            consumerAgentRuntimeIds: consumers,
            platform,
            platformInstanceId: deployment.platformInstanceId,
            targetRootPath: deployment.targetRootPath,
            projectId: deployment.projectId,
            committedTransactionId: deployment.committedTransactionId as UuidV4 | "",
            appliedInputsSnapshotFingerprint: computeAppliedInputsSnapshotFingerprint(appliedInputs),
            appliedRenderSnapshotFingerprint,
            observationState,
            observationAttemptedAt: deployment.observationAttemptedAt,
            lastCompleteObservationAt: deployment.lastCompleteObservationAt,
            blockingEvidence,
            deleted: deployment.deleted === 1,
            createdAt: deployment.createdAt,
            updatedAt: deployment.updatedAt,
        },
        deploymentAssets,
        deploymentFiles,
        residualAuthorities,
    };
    validateCanonicalPreState(state);
    return state;
}

export function projectExpectedSuccessPostcondition(
    db: DatabaseConnection,
    input: DeploymentSuccessCommitInputV1,
    preState: CanonicalDeploymentPreCommitDatabaseStateV1,
    deploymentAssetTransitionPrepared: boolean,
): DeploymentSuccessPostconditionV1 {
    requireUuid(input.transactionId, "success transactionId");
    if (!isNonNegativeInteger(input.now)) throw new Error("success now must be epoch milliseconds");
    validateAppliedInputsSnapshot(input.appliedInputsSnapshot);
    validateAppliedRenderSnapshot(input.appliedRenderSnapshot);
    if (!deploymentAssetTransitionPrepared) {
        assertCurrentDeploymentInputs(db, input.deploymentId, input.appliedInputsSnapshot);
    }
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(input.appliedRenderSnapshot);
    const filesByPath = new Map<string, DeploymentFileBaselinePostconditionEntryV1>();
    for (const file of preState.deploymentFiles) {
        if (file.rowState === "removed") {
            filesByPath.set(file.relativePath, {
                rowState: "removed",
                deploymentFileId: file.deploymentFileId,
                relativePath: file.relativePath,
                observedState: "missing",
                latestResidualAuthorityId: file.latestResidualAuthorityId,
            });
        }
    }
    const successPaths = new Set<string>();
    for (const file of input.verifiedActiveFiles) {
        const verified = file.verified;
        if (successPaths.has(verified.relativePath)) {
            throw new Error("duplicate success postcondition path");
        }
        successPaths.add(verified.relativePath);
        if (!isCanonicalRelativePath(verified.relativePath)) {
            throw new Error("success file relativePath is not canonical");
        }
        if (
            verified.observedState !== "present" ||
            verified.appliedContentHash !== file.appliedPayload.contentHash ||
            verified.observedContentHash !== file.appliedPayload.contentHash ||
            verified.appliedExecutable !== verified.observedExecutable ||
            file.provenance.appliedRenderSnapshotFingerprint !== snapshotFingerprint
        ) {
            throw new Error("success active file cannot form an exact postcondition");
        }
        filesByPath.set(verified.relativePath, {
            rowState: "active",
            deploymentFileId: computeDeploymentFileId(input.deploymentId, verified.relativePath),
            relativePath: verified.relativePath,
            appliedPayload: structuredClone(file.appliedPayload),
            appliedExecutable: verified.appliedExecutable,
            observedState: "present",
            observedContentHash: verified.observedContentHash,
            observedExecutable: verified.observedExecutable,
            provenance: structuredClone(file.provenance),
        });
    }
    for (const residual of input.newlyRemoved) {
        validateDeploymentResidualAuthority(residual);
        if (successPaths.has(residual.relativePath)) {
            throw new Error("one success path cannot be active and removed");
        }
        successPaths.add(residual.relativePath);
        if (residual.deploymentId !== input.deploymentId) {
            throw new Error("success residual belongs to another Deployment");
        }
        const prior = preState.deploymentFiles.find((file) => file.relativePath === residual.relativePath);
        if (prior === undefined || prior.rowState !== "active") {
            throw new Error("success removal must consume a current active baseline");
        }
        filesByPath.set(residual.relativePath, {
            rowState: "removed",
            deploymentFileId: computeDeploymentFileId(input.deploymentId, residual.relativePath),
            relativePath: residual.relativePath,
            observedState: "missing",
            latestResidualAuthorityId: residual.residualAuthorityId,
        });
    }
    for (const prior of preState.deploymentFiles) {
        if (prior.rowState === "active" && !successPaths.has(prior.relativePath)) {
            throw new Error("success postcondition omits a current active baseline");
        }
    }
    const residualById = new Map(
        preState.residualAuthorities.map((authority) => [authority.residualAuthorityId, structuredClone(authority)]),
    );
    for (const residual of input.newlyRemoved) {
        residualById.set(residual.residualAuthorityId, structuredClone(residual));
    }
    const postcondition: DeploymentSuccessPostconditionV1 = {
        schemaVersion: 1,
        deploymentId: input.deploymentId as UuidV4,
        commitTransactionId: input.transactionId as UuidV4,
        deploymentObservationState: "complete",
        deploymentObservationAttemptedAt: input.now,
        deploymentLastCompleteObservationAt: input.now,
        deploymentBlockingEvidence: canonicalEmptyBlockingEvidence(),
        files: [...filesByPath.values()].sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath)),
        residualAuthorities: [...residualById.values()].sort((left, right) =>
            compareUtf8Bytes(left.residualAuthorityId, right.residualAuthorityId),
        ),
    };
    validateDeploymentSuccessPostcondition(postcondition);
    return postcondition;
}

export function readSuccessPostconditionFromConnection(
    db: DatabaseConnection,
    deploymentId: UuidV4,
    commitTransactionId: UuidV4,
): DeploymentSuccessPostconditionV1 {
    const deployment = getDeployment(db, deploymentId);
    if (deployment === null || deployment.deleted !== 0) {
        throw new Error("success postcondition requires an active Deployment");
    }
    if (deployment.committedTransactionId !== commitTransactionId || deployment.observationState !== "complete") {
        throw new Error("Deployment does not match the requested success transaction");
    }
    requireObservationTimes(
        deployment.observationAttemptedAt,
        deployment.lastCompleteObservationAt,
        deployment.observationState,
        "success postcondition",
    );
    const blockingEvidence = parseBlockingEvidence(deployment.blockingEvidence);
    requireCanonicalEmptyBlockingEvidence(blockingEvidence);
    const residualAuthorities = readResidualAuthorities(db, deploymentId);
    const residualById = new Map(residualAuthorities.map((authority) => [authority.residualAuthorityId, authority]));
    const files = listDeploymentFiles(db, deploymentId, false)
        .map((row): DeploymentFileBaselinePostconditionEntryV1 => {
            const projection = projectCurrentFile(row, deploymentId, db, residualById);
            if (projection.rowState === "removed") {
                return {
                    rowState: "removed",
                    deploymentFileId: projection.deploymentFileId,
                    relativePath: projection.relativePath,
                    observedState: "missing",
                    latestResidualAuthorityId: projection.latestResidualAuthorityId,
                };
            }
            if (projection.observation.observedState !== "present") {
                throw new Error("successful active baseline is not observed present");
            }
            return {
                rowState: "active",
                deploymentFileId: projection.deploymentFileId,
                relativePath: projection.relativePath,
                appliedPayload: projection.appliedPayload,
                appliedExecutable: projection.appliedExecutable,
                observedState: "present",
                observedContentHash: projection.observation.observedContentHash,
                observedExecutable: projection.observation.observedExecutable,
                provenance: projection.provenance,
            };
        })
        .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const postcondition: DeploymentSuccessPostconditionV1 = {
        schemaVersion: 1,
        deploymentId,
        commitTransactionId,
        deploymentObservationState: "complete",
        deploymentObservationAttemptedAt: deployment.observationAttemptedAt,
        deploymentLastCompleteObservationAt: deployment.lastCompleteObservationAt,
        deploymentBlockingEvidence: blockingEvidence,
        files,
        residualAuthorities,
    };
    validateDeploymentSuccessPostcondition(postcondition);
    return postcondition;
}

function requireObservationTimes(attemptedAt: number, lastCompleteAt: number, state: string, owner: string): void {
    if (
        !Number.isSafeInteger(attemptedAt) ||
        attemptedAt < 0 ||
        !Number.isSafeInteger(lastCompleteAt) ||
        lastCompleteAt < 0 ||
        lastCompleteAt > attemptedAt
    ) {
        throw new Error(`${owner} observation times are invalid`);
    }
    if (state === "never" && (attemptedAt !== 0 || lastCompleteAt !== 0)) {
        throw new Error(`${owner} never observation must use zero times`);
    }
    if (state !== "never" && state !== "in_progress" && attemptedAt === 0) {
        throw new Error(`${owner} terminal observation must have an attempt time`);
    }
    if (state === "complete" && lastCompleteAt !== attemptedAt) {
        throw new Error(`${owner} complete observation times must match`);
    }
}

export function projectCurrentFile(
    row: DeploymentFileRow,
    deploymentId: UuidV4,
    db: DatabaseConnection,
    residualById: Map<string, DeploymentResidualRenderAuthorityV1>,
): DeploymentFileAuthorityProjectionV1 {
    if (row.deploymentFileId !== computeDeploymentFileId(deploymentId, row.relativePath)) {
        throw new Error("current DeploymentFile identity/lifecycle is invalid");
    }
    requireBinary(row.observedExecutable, "DeploymentFile.observedExecutable");
    requireTimePair(row.createdAt, row.updatedAt, "DeploymentFile");
    if (!isNonNegativeInteger(row.observedAt)) {
        throw new Error("DeploymentFile observedAt must be epoch milliseconds");
    }
    const baselineState = parseDeploymentFileBaselineState(row.baselineState);
    const observation = parsePhysicalObservation(row);
    const projection = projectDeploymentFileAuthority({
        deploymentFileId: row.deploymentFileId,
        relativePath: row.relativePath,
        baselineState,
        observation,
        observedAt: row.observedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    });
    if (projection.rowState === "removed") {
        const residual = residualById.get(projection.latestResidualAuthorityId);
        if (
            residual === undefined ||
            residual.deploymentId !== deploymentId ||
            residual.relativePath !== projection.relativePath
        ) {
            throw new Error("removed DeploymentFile points to an invalid residual authority");
        }
        return projection;
    }
    const snapshotRow = getDeploymentRenderSnapshot(db, deploymentId, projection.provenance.appliedRenderSnapshotFingerprint);
    if (snapshotRow === null || snapshotRow.deleted !== 0) {
        throw new Error("active DeploymentFile provenance snapshot is unresolved");
    }
    const snapshot = parseAppliedRenderSnapshot(snapshotRow.snapshotJson, projection.provenance.appliedRenderSnapshotFingerprint);
    if (snapshot.snapshotState !== "applied") {
        throw new Error("active DeploymentFile provenance snapshot is not applied");
    }
    const units = snapshot.outputUnits.filter(
        (unit) => unit.outputUnitFingerprint === projection.provenance.outputUnitFingerprint,
    );
    if (units.length !== 1 || !units[0]?.claims.some((claim) => claim.relativePath === projection.relativePath)) {
        throw new Error("active DeploymentFile provenance does not own its path");
    }
    return projection;
}

export function readResidualAuthorities(db: DatabaseConnection, deploymentId: UuidV4): DeploymentResidualRenderAuthorityV1[] {
    const authorities = listDeploymentResidualAuthorities(db, deploymentId).map((row) => {
        if (row.deleted !== 0 || row.createdAt !== row.updatedAt) {
            throw new Error("Deployment residual authority row lifecycle is invalid");
        }
        return parseDeploymentResidualAuthorityRow({
            residualAuthorityId: row.residualAuthorityId,
            residualAuthorityFingerprint: row.residualAuthorityFingerprint as Sha256Digest,
            deploymentId,
            relativePath: row.relativePath,
            authorityBody: row.authorityBody,
        });
    });
    authorities.sort((left, right) => compareUtf8Bytes(left.residualAuthorityId, right.residualAuthorityId));
    return authorities;
}

export function parsePhysicalObservation(row: DeploymentFileRow) {
    if (row.observedState === "missing") {
        if (row.observedContentHash !== "" || row.observedExecutable !== 0) {
            throw new Error("missing DeploymentFile observation has hidden physical values");
        }
        return { observedState: "missing" as const };
    }
    if (row.observedState === "present") {
        if (!isSha256Digest(row.observedContentHash)) {
            throw new Error("present DeploymentFile observation has invalid content hash");
        }
        return {
            observedState: "present" as const,
            observedContentHash: row.observedContentHash as Sha256Digest,
            observedExecutable: row.observedExecutable === 1,
        };
    }
    throw new Error("DeploymentFile observed_state is invalid");
}

export function parseConsumerAgentRuntimeIds(json: string): AgentRuntimeId[] {
    const parsed: unknown = JSON.parse(json);
    if (
        !Array.isArray(parsed) ||
        parsed.some((value) => typeof value !== "string" || value.length === 0 || value !== value.toUpperCase())
    ) {
        throw new Error("Deployment consumerAgentRuntimeIds is invalid");
    }
    requireSorted(parsed, (item) => item, "Deployment consumerAgentRuntimeIds");
    return parsed;
}

export function parseBlockingEvidence(json: string): DeploymentBlockingEvidenceV1 {
    const value: unknown = JSON.parse(json);
    validateBlockingEvidence(value);
    return value;
}
