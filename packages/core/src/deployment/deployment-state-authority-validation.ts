/** Strict Deployment state, receipt, and postcondition validation. */

import * as path from "node:path";
import type { OperationDiagnostic } from "../contracts/common";
import type {
    DeploymentFileAuthorityProjectionV1,
    DeploymentResidualRenderAuthorityV1,
    DurableAppliedPayloadRefV1,
    TargetFileRenderProvenanceV1,
} from "../contracts/deployment-authority";
import type { EpochMillis, Platform, PosixRelativePath, Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { DeploymentBlockingEvidenceV1, ObservationState } from "../types";

export { compareUtf8Bytes } from "../foundation/text-order";
import {
    type readDeploymentCommitReceiptFromConnection,
    receiptsAreExact,
    type DeploymentCommitReceiptV1,
} from "./deployment-commit-receipts";
import { projectDeploymentFileAuthority, validateDeploymentResidualAuthority } from "../render/deployment-render-authority";
import { computeDeploymentAssetId, computeDeploymentFileId, stableStringify } from "../foundation/fingerprint";
import {
    hasExactKeys,
    isCanonicalRelativePath,
    isCanonicalTargetRootPath,
    isNonNegativeInteger,
    isSha256Digest,
    isStrictObject,
    isUuidV4,
} from "../foundation/validators";
import type {
    DeploymentFileBaselinePostconditionEntryV1,
    DeploymentSuccessPostconditionV1,
    CanonicalDeploymentPreCommitDatabaseStateV1,
} from "./deployment-state-authority-model";

/** Test-only strict DTO seam. Production validates the same shape before every
 * FULL commit and after every canonical DB projection. */
export function validateCanonicalDeploymentPreCommitDatabaseStateForTest(
    value: unknown,
): asserts value is CanonicalDeploymentPreCommitDatabaseStateV1 {
    validateCanonicalPreState(value);
}

/** Test-only strict readback seam used to prove missing and contradictory
 * receipt results fail closed without faking a SQLite engine failure. */
export function validateDeploymentCommitReceiptReadbackForTest(
    lookup: ReturnType<typeof readDeploymentCommitReceiptFromConnection>,
    expected: DeploymentCommitReceiptV1,
): DeploymentCommitReceiptV1 {
    return requireExactReceiptLookup(lookup, expected, "test receipt readback");
}

export function validateDeploymentSuccessPostcondition(value: unknown): asserts value is DeploymentSuccessPostconditionV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "deploymentId",
            "commitTransactionId",
            "deploymentObservationState",
            "deploymentObservationAttemptedAt",
            "deploymentLastCompleteObservationAt",
            "deploymentBlockingEvidence",
            "files",
            "residualAuthorities",
        ])
    ) {
        throw new Error("DeploymentSuccessPostcondition must be an exact object");
    }
    if (value.schemaVersion !== 1 || value.deploymentObservationState !== "complete") {
        throw new Error("DeploymentSuccessPostcondition discriminator is invalid");
    }
    requireUuid(value.deploymentId, "postcondition deploymentId");
    requireUuid(value.commitTransactionId, "postcondition commitTransactionId");
    requireMatchingCompleteObservationTimes(
        value.deploymentObservationAttemptedAt,
        value.deploymentLastCompleteObservationAt,
        "postcondition",
    );
    validateBlockingEvidence(value.deploymentBlockingEvidence);
    requireCanonicalEmptyBlockingEvidence(value.deploymentBlockingEvidence);
    if (!Array.isArray(value.files) || !Array.isArray(value.residualAuthorities)) {
        throw new Error("DeploymentSuccessPostcondition closures must be arrays");
    }
    const residualById = new Map<string, DeploymentResidualRenderAuthorityV1>();
    for (const authority of value.residualAuthorities) {
        validateDeploymentResidualAuthority(authority);
        if (authority.deploymentId !== value.deploymentId) {
            throw new Error("postcondition residual belongs to another Deployment");
        }
        if (residualById.has(authority.residualAuthorityId)) {
            throw new Error("postcondition residualAuthorityId must be unique");
        }
        residualById.set(authority.residualAuthorityId, authority);
    }
    requireSorted(value.residualAuthorities, (item) => item.residualAuthorityId, "residualAuthorities");
    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    for (const file of value.files) {
        validatePostconditionFile(file, value.deploymentId, residualById);
        if (seenPaths.has(file.relativePath) || seenIds.has(file.deploymentFileId)) {
            throw new Error("postcondition files must have unique path and identity");
        }
        seenPaths.add(file.relativePath);
        seenIds.add(file.deploymentFileId);
    }
    requireSorted(value.files, (item) => item.relativePath, "postcondition files");
}

export function validateCanonicalPreState(value: unknown): asserts value is CanonicalDeploymentPreCommitDatabaseStateV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, ["schemaVersion", "deployment", "deploymentAssets", "deploymentFiles", "residualAuthorities"]) ||
        value.schemaVersion !== 1 ||
        !isStrictObject(value.deployment)
    ) {
        throw new Error("CanonicalDeploymentPreCommitDatabaseState must be exact v1");
    }
    const deployment = value.deployment;
    if (
        !hasExactKeys(deployment, [
            "deploymentId",
            "consumerAgentRuntimeIds",
            "platform",
            "platformInstanceId",
            "targetRootPath",
            "projectId",
            "committedTransactionId",
            "appliedInputsSnapshotFingerprint",
            "appliedRenderSnapshotFingerprint",
            "observationState",
            "observationAttemptedAt",
            "lastCompleteObservationAt",
            "blockingEvidence",
            "deleted",
            "createdAt",
            "updatedAt",
        ])
    ) {
        throw new Error("canonical pre-state Deployment must be exact");
    }
    requireUuid(deployment.deploymentId, "pre-state deploymentId");
    const consumers = deployment.consumerAgentRuntimeIds;
    if (!Array.isArray(consumers) || consumers.some((item) => typeof item !== "string" || item === "")) {
        throw new Error("canonical pre-state consumers are invalid");
    }
    requireSorted(consumers, (item) => item, "canonical consumers");
    requirePlatform(deployment.platform);
    if (
        typeof deployment.platformInstanceId !== "string" ||
        deployment.platformInstanceId.trim() === "" ||
        deployment.platformInstanceId.includes("\0")
    ) {
        throw new Error("canonical pre-state platformInstanceId must be non-blank and NUL-free");
    }
    if (!isCanonicalTargetRootPath(deployment.targetRootPath, deployment.platform)) {
        throw new Error("canonical pre-state targetRootPath is invalid");
    }
    if (deployment.projectId !== "" && !isUuidV4(deployment.projectId)) {
        throw new Error("canonical pre-state projectId is invalid");
    }
    if (deployment.committedTransactionId !== "" && !isUuidV4(deployment.committedTransactionId)) {
        throw new Error("canonical pre-state transaction ID is invalid");
    }
    requireDigest(deployment.appliedInputsSnapshotFingerprint, "appliedInputsSnapshotFingerprint");
    requireDigest(deployment.appliedRenderSnapshotFingerprint, "appliedRenderSnapshotFingerprint");
    requireObservationState(deployment.observationState);
    requireObservationTimes(
        deployment.observationAttemptedAt,
        deployment.lastCompleteObservationAt,
        deployment.observationState,
        "pre-state",
    );
    validateBlockingEvidence(deployment.blockingEvidence);
    if (typeof deployment.deleted !== "boolean") throw new Error("pre-state deleted must be boolean");
    requireTimePair(deployment.createdAt, deployment.updatedAt, "pre-state Deployment");
    if (
        !Array.isArray(value.deploymentAssets) ||
        !Array.isArray(value.deploymentFiles) ||
        !Array.isArray(value.residualAuthorities)
    ) {
        throw new Error("canonical pre-state closures must be arrays");
    }
    for (const asset of value.deploymentAssets) {
        validatePreStateAsset(asset, deployment.deploymentId);
    }
    requireSorted(value.deploymentAssets, (item) => item.deploymentAssetId, "deploymentAssets");
    const residualById = new Map<string, DeploymentResidualRenderAuthorityV1>();
    for (const residual of value.residualAuthorities) {
        validateDeploymentResidualAuthority(residual);
        if (residual.deploymentId !== deployment.deploymentId) {
            throw new Error("pre-state residual belongs to another Deployment");
        }
        residualById.set(residual.residualAuthorityId, residual);
    }
    requireSorted(value.residualAuthorities, (item) => item.residualAuthorityId, "pre-state residualAuthorities");
    for (const file of value.deploymentFiles) {
        validatePreStateFile(file, deployment.deploymentId, residualById);
    }
    requireSorted(value.deploymentFiles, (item) => item.deploymentFileId, "deploymentFiles");
}

function requireMatchingCompleteObservationTimes(attemptedAt: unknown, lastCompleteAt: unknown, owner: string): void {
    if (!isNonNegativeInteger(attemptedAt) || attemptedAt === 0 || attemptedAt !== lastCompleteAt) {
        throw new Error(`${owner} complete observation times are invalid`);
    }
}

function requireObservationTimes(attemptedAt: unknown, lastCompleteAt: unknown, state: unknown, owner: string): void {
    if (
        !isNonNegativeInteger(attemptedAt) ||
        !isNonNegativeInteger(lastCompleteAt) ||
        (lastCompleteAt as number) > (attemptedAt as number)
    ) {
        throw new Error(`${owner} observation times are invalid`);
    }
    if (state === "never" && (attemptedAt !== 0 || lastCompleteAt !== 0)) {
        throw new Error(`${owner} never observation must use zero times`);
    }
    if (state !== "never" && state !== "in_progress" && attemptedAt === 0) {
        throw new Error(`${owner} terminal observation must have an attempt time`);
    }
    if (state === "complete" && attemptedAt !== lastCompleteAt) {
        throw new Error(`${owner} complete observation times must match`);
    }
}

export function validatePreStateAsset(value: unknown, deploymentId: UuidV4): void {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "deploymentAssetId",
            "assetId",
            "versionId",
            "sortOrder",
            "allowIncomplete",
            "deleted",
            "createdAt",
            "updatedAt",
        ])
    ) {
        throw new Error("canonical pre-state DeploymentAsset must be exact");
    }
    requireUuid(value.assetId, "pre-state assetId");
    requireUuid(value.versionId, "pre-state versionId");
    if (value.deploymentAssetId !== computeDeploymentAssetId(deploymentId, value.assetId)) {
        throw new Error("canonical pre-state deploymentAssetId mismatch");
    }
    if (!isNonNegativeInteger(value.sortOrder)) {
        throw new Error("canonical pre-state sortOrder is invalid");
    }
    if (typeof value.allowIncomplete !== "boolean" || typeof value.deleted !== "boolean") {
        throw new Error("canonical pre-state DeploymentAsset flags are invalid");
    }
    requireTimePair(value.createdAt, value.updatedAt, "pre-state DeploymentAsset");
}

export function validatePreStateFile(
    value: unknown,
    deploymentId: UuidV4,
    residualById: Map<string, DeploymentResidualRenderAuthorityV1>,
): void {
    if (!isStrictObject(value)) throw new Error("canonical pre-state DeploymentFile must be exact");
    const baseKeys = ["deploymentFileId", "relativePath", "observedAt", "createdAt", "updatedAt"];
    if (!isCanonicalRelativePath(value.relativePath)) {
        throw new Error("canonical pre-state DeploymentFile path is invalid");
    }
    if (value.deploymentFileId !== computeDeploymentFileId(deploymentId, value.relativePath)) {
        throw new Error("canonical pre-state deploymentFileId mismatch");
    }
    if (!isNonNegativeInteger(value.observedAt)) {
        throw new Error("canonical pre-state DeploymentFile observedAt is invalid");
    }
    requireTimePair(value.createdAt, value.updatedAt, "pre-state DeploymentFile");
    if (value.rowState === "removed") {
        if (!hasExactKeys(value, [...baseKeys, "rowState", "latestResidualAuthorityId", "observation"])) {
            throw new Error("canonical pre-state removed DeploymentFile must be exact");
        }
        projectDeploymentFileAuthority({
            deploymentFileId: value.deploymentFileId,
            relativePath: value.relativePath,
            baselineState: {
                rowState: "removed",
                latestResidualAuthorityId: value.latestResidualAuthorityId as string,
            },
            observation: value.observation as { observedState: "missing" },
            observedAt: value.observedAt,
            createdAt: value.createdAt as EpochMillis,
            updatedAt: value.updatedAt as EpochMillis,
        });
        const residual = residualById.get(value.latestResidualAuthorityId as string);
        if (residual === undefined || residual.relativePath !== value.relativePath) {
            throw new Error("canonical pre-state removed file has unresolved residual authority");
        }
        return;
    }
    if (
        value.rowState !== "active" ||
        !hasExactKeys(value, [...baseKeys, "rowState", "appliedPayload", "appliedExecutable", "provenance", "observation"])
    ) {
        throw new Error("canonical pre-state active DeploymentFile must be exact");
    }
    projectDeploymentFileAuthority({
        deploymentFileId: value.deploymentFileId,
        relativePath: value.relativePath,
        baselineState: {
            rowState: "active",
            appliedPayload: value.appliedPayload as DurableAppliedPayloadRefV1,
            appliedExecutable: value.appliedExecutable as boolean,
            provenance: value.provenance as TargetFileRenderProvenanceV1,
        },
        observation: value.observation as
            | {
                  observedState: "present";
                  observedContentHash: Sha256Digest;
                  observedExecutable: boolean;
              }
            | { observedState: "missing" },
        observedAt: value.observedAt,
        createdAt: value.createdAt as EpochMillis,
        updatedAt: value.updatedAt as EpochMillis,
    });
}

export function validatePostconditionFile(
    value: unknown,
    deploymentId: UuidV4,
    residualById: Map<string, DeploymentResidualRenderAuthorityV1>,
): asserts value is DeploymentFileBaselinePostconditionEntryV1 {
    if (!isStrictObject(value)) throw new Error("postcondition file must be an object");
    if (!isCanonicalRelativePath(value.relativePath)) {
        throw new Error("postcondition relativePath must be canonical");
    }
    if (value.deploymentFileId !== computeDeploymentFileId(deploymentId, value.relativePath)) {
        throw new Error("postcondition deploymentFileId mismatch");
    }
    if (value.rowState === "removed") {
        if (
            !hasExactKeys(value, [
                "rowState",
                "deploymentFileId",
                "relativePath",
                "observedState",
                "latestResidualAuthorityId",
            ]) ||
            value.observedState !== "missing"
        ) {
            throw new Error("removed postcondition file must be exact missing branch");
        }
        const residual = residualById.get(value.latestResidualAuthorityId as string);
        if (residual === undefined || residual.relativePath !== value.relativePath) {
            throw new Error("removed postcondition file has unresolved residual authority");
        }
        return;
    }
    if (
        value.rowState !== "active" ||
        !hasExactKeys(value, [
            "rowState",
            "deploymentFileId",
            "relativePath",
            "appliedPayload",
            "appliedExecutable",
            "observedState",
            "observedContentHash",
            "observedExecutable",
            "provenance",
        ]) ||
        value.observedState !== "present"
    ) {
        throw new Error("active postcondition file must be exact present branch");
    }
    const projected = projectDeploymentFileAuthority({
        deploymentFileId: value.deploymentFileId as string,
        relativePath: value.relativePath as PosixRelativePath,
        baselineState: {
            rowState: "active",
            appliedPayload: value.appliedPayload as DurableAppliedPayloadRefV1,
            appliedExecutable: value.appliedExecutable as boolean,
            provenance: value.provenance as TargetFileRenderProvenanceV1,
        },
        observation: {
            observedState: "present",
            observedContentHash: value.observedContentHash as Sha256Digest,
            observedExecutable: value.observedExecutable as boolean,
        },
        observedAt: 0,
        createdAt: 0,
        updatedAt: 0,
    }) as Extract<DeploymentFileAuthorityProjectionV1, { rowState: "active" }> & {
        observation: {
            observedState: "present";
            observedContentHash: Sha256Digest;
            observedExecutable: boolean;
        };
    };
    if (
        projected.appliedPayload.contentHash !== projected.observation.observedContentHash ||
        projected.appliedExecutable !== projected.observation.observedExecutable
    ) {
        throw new Error("active postcondition applied and observed state differ");
    }
}

export function validateBlockingEvidence(value: unknown): asserts value is DeploymentBlockingEvidenceV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "reasonCode",
            "operation",
            "contextFingerprint",
            "occurredAt",
            "diagnostics",
            "suggestedActions",
            "retryable",
        ]) ||
        value.schemaVersion !== 1 ||
        typeof value.reasonCode !== "string" ||
        typeof value.contextFingerprint !== "string" ||
        !isNonNegativeInteger(value.occurredAt) ||
        typeof value.retryable !== "boolean" ||
        !Array.isArray(value.diagnostics) ||
        !Array.isArray(value.suggestedActions) ||
        value.suggestedActions.some((item) => typeof item !== "string")
    ) {
        throw new Error("DeploymentBlockingEvidence is invalid");
    }
    const operations = new Set(["", "first_deploy", "deploy", "repair", "recover", "inspect", "resolve_conflict"]);
    if (!operations.has(value.operation as string)) {
        throw new Error("DeploymentBlockingEvidence operation is invalid");
    }
    value.diagnostics.forEach(validateOperationDiagnostic);
}

export function validateOperationDiagnostic(value: unknown): asserts value is OperationDiagnostic {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "severity",
            "code",
            "message",
            "path",
            "traceId",
            "operation",
            "causeKind",
            "retryable",
            "suggestedActions",
            "rawSummary",
        ]) ||
        !["info", "warning", "error"].includes(value.severity as string) ||
        ![
            "project",
            "asset",
            "version",
            "probe",
            "read",
            "render",
            "deploy",
            "scan",
            "reindex",
            "settings",
            "reverse_accept",
            "internal",
        ].includes(value.operation as string) ||
        ![
            "not_found",
            "unavailable",
            "permission_denied",
            "version_incompatible",
            "partial",
            "invalid_schema",
            "unsupported",
            "conflict",
            "verification_failed",
            "internal_error",
        ].includes(value.causeKind as string) ||
        typeof value.code !== "string" ||
        typeof value.message !== "string" ||
        typeof value.path !== "string" ||
        typeof value.traceId !== "string" ||
        typeof value.retryable !== "boolean" ||
        typeof value.rawSummary !== "string" ||
        !Array.isArray(value.suggestedActions) ||
        value.suggestedActions.some((item) => typeof item !== "string")
    ) {
        throw new Error("OperationDiagnostic in blocking evidence is invalid");
    }
}

export function canonicalEmptyBlockingEvidence(): DeploymentBlockingEvidenceV1 {
    return {
        schemaVersion: 1,
        reasonCode: "",
        operation: "",
        contextFingerprint: "",
        occurredAt: 0,
        diagnostics: [],
        suggestedActions: [],
        retryable: false,
    };
}

export function requireCanonicalEmptyBlockingEvidence(value: DeploymentBlockingEvidenceV1): void {
    if (stableStringify(value) !== stableStringify(canonicalEmptyBlockingEvidence())) {
        throw new Error("successful Deployment blocking evidence is not canonical empty");
    }
}

export function requireExactAuthority(actual: unknown, expected: unknown, label: string): void {
    if (stableStringify(actual) !== stableStringify(expected)) {
        throw new Error(`${label} mismatch`);
    }
}

export function requireExactReceiptLookup(
    lookup: ReturnType<typeof readDeploymentCommitReceiptFromConnection>,
    expected: DeploymentCommitReceiptV1,
    label: string,
): DeploymentCommitReceiptV1 {
    if (lookup.receiptState !== "available" || !receiptsAreExact(lookup.receipt, expected)) {
        throw new Error(`DeploymentCommitReceipt ${label} readback failed`);
    }
    return lookup.receipt;
}

export function requireUuid(value: unknown, field: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${field} must be UUID v4`);
}

export function requireDigest(value: unknown, field: string): asserts value is Sha256Digest {
    if (!isSha256Digest(value)) throw new Error(`${field} must be SHA-256 digest`);
}

export function requirePlatform(value: unknown): Platform {
    if (value !== "win32" && value !== "darwin" && value !== "linux" && value !== "wsl") {
        throw new Error("Platform is invalid");
    }
    return value;
}

export function requireObservationState(value: unknown): ObservationState {
    if (value !== "never" && value !== "in_progress" && value !== "complete" && value !== "partial" && value !== "failed") {
        throw new Error("ObservationState is invalid");
    }
    return value;
}

export function requireBinary(value: unknown, field: string): asserts value is 0 | 1 {
    if (value !== 0 && value !== 1) throw new Error(`${field} must be 0|1`);
}

export function requireTimePair(createdAt: unknown, updatedAt: unknown, owner: string): void {
    if (!isNonNegativeInteger(createdAt) || !isNonNegativeInteger(updatedAt) || updatedAt < createdAt) {
        throw new Error(`${owner} timestamps are invalid`);
    }
}

export function requireSorted<T>(items: T[], key: (item: T) => string, label: string): void {
    let previous: string | undefined;
    for (const item of items) {
        const current = key(item);
        if (previous !== undefined && current <= previous) {
            throw new Error(`${label} must be sorted and unique`);
        }
        previous = current;
    }
}

export function requireDatabasePath(databasePath: string): void {
    if (
        databasePath.length === 0 ||
        databasePath === ":memory:" ||
        databasePath.includes("\0") ||
        !path.isAbsolute(databasePath) ||
        path.normalize(databasePath) !== databasePath
    ) {
        throw new Error("Deployment state authority requires a canonical absolute DB path");
    }
}
