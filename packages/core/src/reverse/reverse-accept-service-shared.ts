import * as path from "node:path";
import type { VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { OperationDiagnostic } from "../contracts/common";
import type { CoreResult } from "../contracts/core-service";
import type { VersionOriginAuthorityV1, VersionPromotionRequirement } from "../contracts/persistence";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { RenderDeploymentInput } from "../contracts/render";
import type {
    CancelRenderedTargetAcceptInput,
    CommitRenderedTargetAcceptInput,
    PrepareRenderedTargetAcceptInput,
    RenderedTargetAcceptCommitView,
    RenderedTargetAcceptPreparationView,
} from "../contracts/reverse";
import type {
    PreparedDeploymentSuccessAuthorityV1,
    ReverseAcceptDeploymentAssetVersionTransitionV1,
} from "../deployment/deployment-state-authority";
import {
    computeAssetManifestAuthoritySetFingerprint,
    computeVersionOriginAuthorityFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { computeDeploymentOperationKey, type LockHandle } from "../foundation/physical-path-locks";
import { hasExactKeys, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import {
    type PreparedAssetManifestAuthority,
    type PreparedRenderedTargetAccept,
    type ReverseAcceptMarkerReadResult,
    type ReverseAcceptMarkerStore,
    ReverseAcceptMarkerStoreError,
    type ReverseAcceptPreparationMarkerV1,
    type ReverseAcceptVersionOriginDraftV1,
} from "./reverse-accept-marker";

import type { AcquireLocks, ReverseAcceptServiceConfiguration } from "./reverse-accept-service-model";

export { compareUtf8Bytes } from "../foundation/text-order";

export function normalizeManifestAuthorities(value: unknown): PreparedAssetManifestAuthority[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept draft requires at least one Asset authority",
            "invalid_schema",
        );
    }
    const authorities: PreparedAssetManifestAuthority[] = value.map((item) => {
        if (
            !isStrictObject(item) ||
            !hasExactKeys(item, ["assetId", "assetManifestAuthorityFingerprint"]) ||
            !isUuidV4(item.assetId) ||
            !isSha256Digest(item.assetManifestAuthorityFingerprint)
        ) {
            throw new ReverseAcceptServiceFailure(
                "reverse_accept.invalid_draft",
                "fresh reverse-accept Asset authority is invalid",
                "invalid_schema",
            );
        }
        return {
            assetId: item.assetId as UuidV4,
            assetManifestAuthorityFingerprint: item.assetManifestAuthorityFingerprint as Sha256Digest,
        };
    });
    authorities.sort((left, right) => left.assetId.localeCompare(right.assetId));
    if (new Set(authorities.map((item) => item.assetId)).size !== authorities.length) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept Asset authority set contains duplicates",
            "invalid_schema",
        );
    }
    return authorities;
}

export function validateOriginDraft(value: ReverseAcceptVersionOriginDraftV1): void {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, ["previousVersionId", "previousVersionOriginAuthorityFingerprint", "promotionRequirement"]) ||
        !isUuidV4(value.previousVersionId) ||
        !isSha256Digest(value.previousVersionOriginAuthorityFingerprint) ||
        !isVersionPromotionRequirement(value.promotionRequirement)
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_draft",
            "fresh reverse-accept Version origin draft is invalid",
            "invalid_schema",
        );
    }
}

export function computeDraftAuthoritySetFingerprint(authorities: readonly PreparedAssetManifestAuthority[]): Sha256Digest {
    return computeAssetManifestAuthoritySetFingerprint(authorities);
}

export function acquirePreparationMutex(
    acquireLocks: AcquireLocks,
    transactionsRoot: string,
    deploymentId: UuidV4,
): LockHandle | null {
    return acquireLocks(transactionsRoot, [computeDeploymentOperationKey(deploymentId)]);
}

export function requireAvailableMarker(
    result: ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>,
    operation: string,
): ReverseAcceptPreparationMarkerV1 {
    if (result.state !== "available") {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.marker_unavailable",
            `reverse-accept marker is unavailable for ${operation}`,
            "unavailable",
        );
    }
    return result.value;
}

export function requirePreparedForCommit(
    markerStore: ReverseAcceptMarkerStore,
    initial: ReverseAcceptPreparationMarkerV1,
    input: CommitRenderedTargetAcceptInput,
    commitTime: number,
): PreparedRenderedTargetAccept {
    const current = requireAvailableMarker(markerStore.readMarker(input.preparationId), "locked commit");
    if (current.identity.preparationIdentityFingerprint !== initial.identity.preparationIdentityFingerprint) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.identity_changed",
            "reverse-accept preparation identity changed while acquiring authority locks",
            "unavailable",
        );
    }
    if (current.preparationState !== "prepared") {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.preparation_terminal",
            `reverse-accept preparation is already ${current.preparationState}`,
            "conflict",
        );
    }
    if (current.preparationRevision !== input.expectedPreparationRevision) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.revision_stale",
            "reverse-accept preparation revision is stale",
            "conflict",
        );
    }
    if (commitTime >= current.expiresAt) {
        markerStore.transitionPrepared(
            current.identity.preparationId,
            current.preparationRevision,
            current.markerFingerprint,
            "expired",
        );
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.preparation_expired",
            "reverse-accept preparation expired before commit",
            "conflict",
        );
    }
    return current;
}

export function requireCommitTime(value: unknown): number {
    if (!isSafeNonNegativeInteger(value)) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_clock",
            "Core clock returned an invalid commit time",
            "internal_error",
        );
    }
    return value;
}

export function buildReverseAcceptOrigin(
    prepared: PreparedRenderedTargetAccept,
    userActionId: string,
    createdAt: number,
): Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }> {
    const preimage = {
        schemaVersion: 1 as const,
        assetId: prepared.stagedAssetId,
        versionId: prepared.stagedVersionId,
        originKind: "reverse_accept" as const,
        previousVersionId: prepared.stagedVersionOriginDraft.previousVersionId,
        previousVersionOriginAuthorityFingerprint: prepared.stagedVersionOriginDraft.previousVersionOriginAuthorityFingerprint,
        reversePreparationIdentityFingerprint: prepared.identity.preparationIdentityFingerprint,
        userActionEvidenceId: userActionId,
        promotionRequirement: prepared.stagedVersionOriginDraft.promotionRequirement,
        createdAt,
    };
    return {
        ...preimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(preimage),
    };
}

export function deploymentAssetTransitionForCommit(
    prepared: PreparedRenderedTargetAccept,
): ReverseAcceptDeploymentAssetVersionTransitionV1 {
    return {
        assetId: prepared.stagedAssetId,
        previousVersionId: prepared.stagedVersionOriginDraft.previousVersionId,
        stagedVersionId: prepared.stagedVersionId,
    };
}

export function requireRenderDeploymentMatchesDatabaseAuthority(
    deployment: RenderDeploymentInput,
    preState: PreparedDeploymentSuccessAuthorityV1["preCommitDatabaseState"],
): void {
    if (!isStrictObject(deployment)) {
        throw invalidCommitDraft("fresh render Deployment is not an object");
    }
    const current = preState.deployment;
    if (
        deployment.deploymentId !== current.deploymentId ||
        deployment.platform !== current.platform ||
        deployment.platformInstanceId !== current.platformInstanceId ||
        deployment.targetRootPath !== current.targetRootPath ||
        deployment.projectId !== current.projectId ||
        stableStringify(deployment.consumerAgentRuntimeIds) !== stableStringify(current.consumerAgentRuntimeIds)
    ) {
        throw invalidCommitDraft("fresh render Deployment does not match the current database authority");
    }
}

export function requireCommitIdentitySeparation(prepared: PreparedRenderedTargetAccept, promotionGrantId: UuidV4 | ""): void {
    if (
        promotionGrantId !== "" &&
        new Set([
            prepared.identity.preparationId,
            prepared.identity.commitTransactionId,
            prepared.stagedVersionId,
            promotionGrantId,
        ]).size !== 4
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.uuid_collision",
            "Core identity allocator reused a reverse-accept authority UUID",
            "internal_error",
        );
    }
}

export function renderProjectionMatchesVersion(
    projection: RenderDeploymentInput["assets"][number],
    closure: VersionAuthorityClosureV1,
): boolean {
    const manifest = closure.manifest;
    return (
        projection.version.ref.assetId === manifest.assetId &&
        projection.version.ref.versionId === manifest.versionId &&
        projection.version.versionFingerprint === manifest.fingerprint &&
        projection.version.versionCanonicalContentFingerprint === manifest.versionCanonicalContentFingerprint &&
        projection.version.status === manifest.status &&
        stableStringify(projection.version.canonical) === stableStringify({ kind: manifest.kind, typeData: manifest.typeData }) &&
        stableStringify(projection.version.files) === stableStringify(closure.files)
    );
}

export function requireExactValue(actual: unknown, expected: unknown, label: string): void {
    if (stableStringify(actual) !== stableStringify(expected)) {
        throw new ReverseAcceptServiceFailure("reverse_accept.authority_mismatch", `${label} is not exact`, "conflict", true);
    }
}

export function invalidCommitDraft(message: string): ReverseAcceptServiceFailure {
    return new ReverseAcceptServiceFailure("reverse_accept.invalid_commit_draft", message, "invalid_schema");
}

export function validateServiceConfiguration(configuration: ReverseAcceptServiceConfiguration): void {
    if (!Number.isSafeInteger(configuration.preparationTtlMs) || configuration.preparationTtlMs <= 0) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_configuration",
            "preparationTtlMs must be a positive safe integer",
            "invalid_schema",
        );
    }
    for (const [label, root] of [
        ["transactionsRoot", configuration.transactionsRoot],
        ["assetsRoot", configuration.assetsRoot],
        ["deploymentsRoot", configuration.deploymentsRoot],
        ["authorityLocksRoot", configuration.authorityLocksRoot],
        ["databasePath", configuration.databasePath],
    ] as const) {
        if (
            root.length === 0 ||
            root.includes("\0") ||
            !path.isAbsolute(root) ||
            path.normalize(root) !== root ||
            root.endsWith(path.sep) ||
            root === path.parse(root).root
        ) {
            throw new ReverseAcceptServiceFailure(
                "reverse_accept.invalid_configuration",
                `${label} must be a non-root canonical absolute path`,
                "invalid_schema",
            );
        }
    }
}

export function validatePrepareInput(input: PrepareRenderedTargetAcceptInput): void {
    if (
        !isStrictObject(input) ||
        !hasExactKeys(input, ["deploymentId", "inspectionResultFingerprint"]) ||
        !isUuidV4(input.deploymentId) ||
        !isSha256Digest(input.inspectionResultFingerprint)
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_prepare_input",
            "prepare requires a UUID deploymentId and SHA-256 inspection result fingerprint",
            "invalid_schema",
        );
    }
}

export function validateCancelInput(input: CancelRenderedTargetAcceptInput): void {
    if (
        !isStrictObject(input) ||
        !hasExactKeys(input, ["preparationId", "expectedPreparationRevision"]) ||
        !isUuidV4(input.preparationId) ||
        !isSafePositiveInteger(input.expectedPreparationRevision)
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_cancel_input",
            "cancel requires a UUID preparationId and positive safe expected revision",
            "invalid_schema",
        );
    }
}

export function validateCommitInput(input: CommitRenderedTargetAcceptInput): void {
    if (
        !isStrictObject(input) ||
        !hasExactKeys(input, [
            "preparationId",
            "expectedPreparationRevision",
            "userActionId",
            "newVersionPromotion",
            "renderSelectionRequest",
        ]) ||
        !isUuidV4(input.preparationId) ||
        !isSafePositiveInteger(input.expectedPreparationRevision) ||
        typeof input.userActionId !== "string" ||
        input.userActionId.trim().length === 0 ||
        !isStrictObject(input.newVersionPromotion) ||
        !isStrictObject(input.renderSelectionRequest) ||
        !hasExactKeys(input.renderSelectionRequest, ["schemaVersion", "renderInputFingerprint", "semanticOptions"]) ||
        input.renderSelectionRequest.schemaVersion !== 1 ||
        !isSha256Digest(input.renderSelectionRequest.renderInputFingerprint) ||
        !Array.isArray(input.renderSelectionRequest.semanticOptions)
    ) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_commit_input",
            "commit requires exact preparation, user action, promotion, and selection authority",
            "invalid_schema",
        );
    }
    if (input.newVersionPromotion.promotionAction === "use_existing_authority") {
        if (!hasExactKeys(input.newVersionPromotion, ["promotionAction"])) {
            throw new ReverseAcceptServiceFailure(
                "reverse_accept.invalid_commit_input",
                "existing-authority promotion request has extra fields",
                "invalid_schema",
            );
        }
    } else if (input.newVersionPromotion.promotionAction === "grant_staged_version_current_target") {
        if (!hasExactKeys(input.newVersionPromotion, ["promotionAction"])) {
            throw new ReverseAcceptServiceFailure(
                "reverse_accept.invalid_commit_input",
                "staged-grant promotion request has extra fields",
                "invalid_schema",
            );
        }
    } else {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_commit_input",
            "unknown reverse-accept promotion action",
            "invalid_schema",
        );
    }
}

export function requireNewUuid(value: UuidV4, label: string): UuidV4 {
    if (!isUuidV4(value)) {
        throw new ReverseAcceptServiceFailure(
            "reverse_accept.invalid_uuid",
            `Core identity allocator returned an invalid ${label}`,
            "internal_error",
        );
    }
    return value;
}

export function isVersionPromotionRequirement(value: unknown): value is VersionPromotionRequirement {
    return value === "not_required" || value === "requires_current_authorization";
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSafePositiveInteger(value: unknown): value is number {
    return isSafeNonNegativeInteger(value) && value >= 1;
}

export class ReverseAcceptServiceFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"],
        readonly retryable = false,
    ) {
        super(message);
        this.name = "ReverseAcceptServiceFailure";
    }
}

export class ReverseAcceptResolverFailure extends ReverseAcceptServiceFailure {
    constructor(
        code: string,
        message: string,
        readonly resolverDiagnostics: OperationDiagnostic[],
    ) {
        super(code, message, "conflict", true);
        this.name = "ReverseAcceptResolverFailure";
    }
}

export function failedPreparation(error: unknown): CoreResult<RenderedTargetAcceptPreparationView> {
    return {
        status: "failed",
        value: { preparationState: "not_prepared" },
        diagnostics: [diagnosticForError(error)],
    };
}

export function failedCommit(error: unknown): CoreResult<RenderedTargetAcceptCommitView> {
    return {
        status: "failed",
        value: { commitState: "outcome_unavailable" },
        diagnostics:
            error instanceof ReverseAcceptResolverFailure && error.resolverDiagnostics.length > 0
                ? structuredClone(error.resolverDiagnostics)
                : [diagnosticForError(error)],
    };
}

export function diagnosticForError(error: unknown): OperationDiagnostic {
    if (error instanceof ReverseAcceptServiceFailure) {
        return diagnostic(error.code, error.message, error.causeKind, error.retryable);
    }
    if (error instanceof ReverseAcceptMarkerStoreError) {
        return diagnostic(
            `reverse_accept.${error.code}`,
            error.message,
            error.code === "marker_revision_stale" || error.code === "marker_state_conflict" ? "conflict" : "unavailable",
            false,
        );
    }
    return diagnostic(
        "reverse_accept.internal_failure",
        error instanceof Error ? error.message : "unknown reverse-accept failure",
        "internal_error",
        false,
    );
}

export function diagnostic(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    retryable: boolean,
): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        path: "",
        traceId: "",
        operation: "reverse_accept",
        causeKind,
        retryable,
        suggestedActions: retryable ? ["retry"] : ["contact_support"],
        rawSummary: message,
    };
}
