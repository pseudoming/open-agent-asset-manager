import * as crypto from "node:crypto";
import { publishReverseAcceptedAssetVersion, readAssetManifestAuthoritySet } from "../catalog/version-authority";
import type { CoreResult } from "../contracts/core-service";
import type { UuidV4 } from "../contracts/primitives";
import type {
    CancelRenderedTargetAcceptInput,
    CommitRenderedTargetAcceptInput,
    PrepareRenderedTargetAcceptInput,
    RenderedTargetAcceptCommitView,
    RenderedTargetAcceptPreparationView,
} from "../contracts/reverse";
import { publishDeploymentPayloads, readDeploymentPayload } from "../deployment/deployment-payload-store";
import {
    commitReverseAcceptVersionSelectionSuccessCrashDurable,
    prepareReverseAcceptDeploymentSuccessAuthority,
    readCanonicalDeploymentPreCommitDatabaseState,
} from "../deployment/deployment-state-authority";
import { tryAcquireAuthorityLockLease } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { acquireAllLocks } from "../foundation/physical-path-locks";
import { isStrictObject } from "../foundation/validators";
import {
    buildPreparedReverseAcceptMarker,
    buildReverseAcceptPreparationIdentity,
    createReverseAcceptMarkerStore,
    type ReverseAcceptMarkerStore,
} from "./reverse-accept-marker";
import { executeClaimedCommit } from "./reverse-accept-service-commit";
import {
    buildCommitEvidence,
    commitDraftFingerprint,
    normalizeAndValidateCommitDraft,
    normalizeAndValidateDraft,
    physicalKeysForCommit,
    resolveCommitDraft,
} from "./reverse-accept-service-draft";
import type {
    AcquireLocks,
    FreshReverseAcceptCommitDraft,
    ResolveFreshReverseAcceptCommitInput,
    ReverseAcceptCommitDependencies,
    ReverseAcceptService,
    ReverseAcceptServiceConfiguration,
} from "./reverse-accept-service-model";
import {
    acquirePreparationMutex,
    buildReverseAcceptOrigin,
    computeDraftAuthoritySetFingerprint,
    deploymentAssetTransitionForCommit,
    diagnosticForError,
    failedCommit,
    failedPreparation,
    invalidCommitDraft,
    isSafeNonNegativeInteger,
    ReverseAcceptServiceFailure,
    requireAvailableMarker,
    requireCommitIdentitySeparation,
    requireCommitTime,
    requireExactValue,
    requireNewUuid,
    requirePreparedForCommit,
    requireRenderDeploymentMatchesDatabaseAuthority,
    validateCancelInput,
    validateCommitInput,
    validatePrepareInput,
    validateServiceConfiguration,
} from "./reverse-accept-service-shared";

const COMMIT_DEPENDENCIES: ReverseAcceptCommitDependencies = Object.freeze({
    acquireAssetLocks: tryAcquireAuthorityLockLease,
    acquireSettingsLock: tryAcquireAuthorityLockLease,
    publishVersion: publishReverseAcceptedAssetVersion,
    publishDeploymentPayloads,
    readDeploymentPayload,
    prepareDatabaseAuthority: prepareReverseAcceptDeploymentSuccessAuthority,
    commitDatabase: commitReverseAcceptVersionSelectionSuccessCrashDurable,
});

export function createReverseAcceptService(configuration: ReverseAcceptServiceConfiguration): ReverseAcceptService {
    return createReverseAcceptServiceCore(
        configuration,
        createReverseAcceptMarkerStore(configuration.transactionsRoot, configuration.renderAnalysisValidator),
        acquireAllLocks,
        COMMIT_DEPENDENCIES,
    );
}

/** Test-only dependency seam for deterministic marker/lock failures. */
export function createReverseAcceptServiceForTest(
    configuration: ReverseAcceptServiceConfiguration,
    markerStore: ReverseAcceptMarkerStore,
    acquireLocks: AcquireLocks = acquireAllLocks,
    commitDependencies: Partial<ReverseAcceptCommitDependencies> = {},
): ReverseAcceptService {
    return createReverseAcceptServiceCore(configuration, markerStore, acquireLocks, {
        ...COMMIT_DEPENDENCIES,
        ...commitDependencies,
    });
}

/** Test-only seam for deterministic validation of the physical lock closure. */
export function physicalKeysForCommitForTest(draft: FreshReverseAcceptCommitDraft): string[] {
    return physicalKeysForCommit(draft);
}

export function createReverseAcceptServiceCore(
    sourceConfiguration: ReverseAcceptServiceConfiguration,
    markerStore: ReverseAcceptMarkerStore,
    acquireLocks: AcquireLocks,
    commitDependencies: ReverseAcceptCommitDependencies,
): ReverseAcceptService {
    validateServiceConfiguration(sourceConfiguration);
    const configuration = Object.freeze({ ...sourceConfiguration });
    const now = configuration.now ?? (() => Date.now());
    const newUuid = configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4);

    return Object.freeze({
        async prepareRenderedTargetAccept(
            sourceInput: PrepareRenderedTargetAcceptInput,
        ): Promise<CoreResult<RenderedTargetAcceptPreparationView>> {
            try {
                const input = structuredClone(sourceInput);
                validatePrepareInput(input);
                const preparationId = requireNewUuid(newUuid(), "preparationId");
                const commitTransactionId = requireNewUuid(newUuid(), "commitTransactionId");
                const stagedVersionId = requireNewUuid(newUuid(), "stagedVersionId");
                if (new Set([preparationId, commitTransactionId, stagedVersionId]).size !== 3) {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.uuid_collision",
                        "Core identity allocator returned duplicate reverse-accept UUIDs",
                        "internal_error",
                    );
                }

                const resolved = await configuration.resolveFreshPreparation({
                    request: structuredClone(input),
                    preparationId,
                    commitTransactionId,
                    stagedVersionId,
                });
                if (resolved.status === "failed") {
                    return {
                        status: "failed",
                        value: { preparationState: "not_prepared" },
                        diagnostics: structuredClone(resolved.diagnostics),
                    };
                }
                const draft = normalizeAndValidateDraft(
                    structuredClone(resolved.value),
                    input,
                    stagedVersionId,
                    configuration.renderAnalysisValidator,
                );
                const preparedAt = now();
                if (!isSafeNonNegativeInteger(preparedAt)) {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.invalid_clock",
                        "Core clock returned an invalid preparedAt value",
                        "internal_error",
                    );
                }
                const expiresAt = preparedAt + configuration.preparationTtlMs;
                if (!Number.isSafeInteger(expiresAt) || expiresAt <= preparedAt) {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.invalid_ttl",
                        "reverse-accept TTL overflowed the safe epoch range",
                        "internal_error",
                    );
                }

                const identity = buildReverseAcceptPreparationIdentity({
                    preparationId,
                    deploymentId: input.deploymentId,
                    commitTransactionId,
                    assetIds: draft.assetManifestAuthorities.map((item) => item.assetId),
                });
                const marker = buildPreparedReverseAcceptMarker(
                    {
                        identity,
                        preparedAt,
                        expiresAt,
                        deploymentAuthorityFingerprint: draft.deploymentAuthorityFingerprint,
                        assetManifestAuthorities: draft.assetManifestAuthorities,
                        assetManifestAuthoritySetFingerprint: computeDraftAuthoritySetFingerprint(draft.assetManifestAuthorities),
                        inspectionScopeFingerprint: draft.inspectionScopeFingerprint,
                        inspectionResultFingerprint: draft.inspectionResultFingerprint,
                        stagedAssetId: draft.stagedAssetId,
                        stagedVersionId,
                        stagedVersionFingerprint: draft.stagedVersionFingerprint,
                        stagedVersionOriginDraft: draft.stagedVersionOriginDraft,
                        renderAnalysis: draft.renderAnalysis,
                    },
                    configuration.renderAnalysisValidator,
                );

                const operationLock = acquirePreparationMutex(acquireLocks, configuration.transactionsRoot, input.deploymentId);
                if (operationLock === null) {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.preparation_busy",
                        "reverse-accept preparation mutex is busy",
                        "conflict",
                        true,
                    );
                }
                try {
                    markerStore.publishPrepared(marker);
                } finally {
                    operationLock.release();
                }

                return {
                    status: resolved.status,
                    value: {
                        preparationState: "prepared",
                        preparationId,
                        preparationRevision: marker.preparationRevision,
                        expiresAt,
                        promotionState: draft.promotionState,
                        renderAnalysis: structuredClone(draft.renderAnalysis),
                    },
                    diagnostics: structuredClone(resolved.diagnostics),
                };
            } catch (error) {
                return failedPreparation(error);
            }
        },

        async commitRenderedTargetAccept(
            sourceInput: CommitRenderedTargetAcceptInput,
        ): Promise<CoreResult<RenderedTargetAcceptCommitView>> {
            try {
                const input = structuredClone(sourceInput);
                validateCommitInput(input);
                const initial = requireAvailableMarker(markerStore.readMarker(input.preparationId), "commit");
                const assetAuthorityLease = commitDependencies.acquireAssetLocks(
                    configuration.authorityLocksRoot,
                    "assets",
                    initial.identity.assetIds,
                );
                if (assetAuthorityLease === null) {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.asset_authority_busy",
                        "one or more reverse-accept Asset authorities are busy",
                        "conflict",
                        true,
                    );
                }
                try {
                    const settingsAuthorityLease = commitDependencies.acquireSettingsLock(
                        configuration.authorityLocksRoot,
                        "settings",
                        ["settings"],
                    );
                    if (settingsAuthorityLease === null) {
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.settings_authority_busy",
                            "reverse-accept promotion settings authority is busy",
                            "conflict",
                            true,
                        );
                    }
                    try {
                        const operationLock = acquirePreparationMutex(
                            acquireLocks,
                            configuration.transactionsRoot,
                            initial.identity.deploymentId,
                        );
                        if (operationLock === null) {
                            throw new ReverseAcceptServiceFailure(
                                "reverse_accept.preparation_busy",
                                "reverse-accept preparation mutex is busy",
                                "conflict",
                                true,
                            );
                        }
                        try {
                            const commitTime = requireCommitTime(now());
                            const prepared = requirePreparedForCommit(markerStore, initial, input, commitTime);
                            markerStore.repairLocatorFromMarker(prepared);
                            const origin = buildReverseAcceptOrigin(prepared, input.userActionId, commitTime);
                            const promotionGrantId =
                                input.newVersionPromotion.promotionAction === "grant_staged_version_current_target"
                                    ? requireNewUuid(newUuid(), "promotionGrantId")
                                    : "";
                            requireCommitIdentitySeparation(prepared, promotionGrantId);
                            const resolverInput: ResolveFreshReverseAcceptCommitInput = {
                                request: structuredClone(input),
                                preparation: structuredClone(prepared),
                                stagedVersionOriginAuthority: origin,
                                promotionGrantId,
                                assetAuthorityLeaseProof: assetAuthorityLease.proof,
                                settingsAuthorityLeaseProof: settingsAuthorityLease.proof,
                            };
                            const first = await resolveCommitDraft(configuration, resolverInput);
                            if (!isStrictObject(first)) {
                                throw invalidCommitDraft("fresh commit draft is not an object");
                            }
                            requireRenderDeploymentMatchesDatabaseAuthority(
                                first.deployment,
                                readCanonicalDeploymentPreCommitDatabaseState(
                                    configuration.databasePath,
                                    prepared.identity.deploymentId,
                                ),
                            );
                            const physicalKeys = physicalKeysForCommit(first);
                            const physicalLocks = acquireLocks(configuration.transactionsRoot, physicalKeys);
                            if (physicalLocks === null) {
                                throw new ReverseAcceptServiceFailure(
                                    "reverse_accept.target_busy",
                                    "one or more reverse-accept target paths are busy",
                                    "conflict",
                                    true,
                                );
                            }
                            try {
                                const fresh = await resolveCommitDraft(configuration, resolverInput);
                                if (commitDraftFingerprint(first) !== commitDraftFingerprint(fresh)) {
                                    throw new ReverseAcceptServiceFailure(
                                        "reverse_accept.fresh_commit_changed",
                                        "fresh reverse-accept result changed while acquiring target locks",
                                        "conflict",
                                        true,
                                    );
                                }
                                const normalized = normalizeAndValidateCommitDraft({
                                    draft: fresh,
                                    prepared,
                                    input,
                                    origin,
                                    promotionGrantId,
                                    assetsRoot: configuration.assetsRoot,
                                    dialectRegistry: configuration.dialectRegistry,
                                });
                                const currentAuthorities = readAssetManifestAuthoritySet(
                                    configuration.assetsRoot,
                                    prepared.identity.assetIds,
                                );
                                requireExactValue(
                                    currentAuthorities,
                                    prepared.assetManifestAuthorities,
                                    "current Asset manifest authority set",
                                );
                                const deploymentAssetTransition = deploymentAssetTransitionForCommit(prepared);
                                const preparedDatabaseAuthority = commitDependencies.prepareDatabaseAuthority(
                                    configuration.databasePath,
                                    normalized.successCommit,
                                    deploymentAssetTransition,
                                );
                                requireRenderDeploymentMatchesDatabaseAuthority(
                                    normalized.deployment,
                                    preparedDatabaseAuthority.preCommitDatabaseState,
                                );
                                const commitEvidence = buildCommitEvidence({
                                    prepared,
                                    normalized,
                                    preparedDatabaseAuthority,
                                    assetsRoot: configuration.assetsRoot,
                                });
                                const claimed = markerStore.claimPrepared(
                                    prepared.identity.preparationId,
                                    prepared.preparationRevision,
                                    prepared.markerFingerprint,
                                    commitEvidence.intent,
                                );
                                return executeClaimedCommit({
                                    configuration,
                                    markerStore,
                                    commitDependencies,
                                    claimed,
                                    normalized,
                                    preparedDatabaseAuthority,
                                    deploymentAssetTransition,
                                    expectedFilesystemReceipt: commitEvidence.expectedFilesystemReceipt,
                                });
                            } finally {
                                physicalLocks.release();
                            }
                        } finally {
                            operationLock.release();
                        }
                    } finally {
                        settingsAuthorityLease.release();
                    }
                } finally {
                    assetAuthorityLease.release();
                }
            } catch (error) {
                return failedCommit(error);
            }
        },

        async cancelRenderedTargetAccept(sourceInput: CancelRenderedTargetAcceptInput): Promise<CoreResult<void>> {
            try {
                const input = structuredClone(sourceInput);
                validateCancelInput(input);
                const initial = markerStore.readMarker(input.preparationId);
                if (initial.state !== "available") {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.marker_unavailable",
                        "reverse-accept marker is unavailable; cancellation cannot guess state",
                        "unavailable",
                    );
                }
                const operationLock = acquirePreparationMutex(
                    acquireLocks,
                    configuration.transactionsRoot,
                    initial.value.identity.deploymentId,
                );
                if (operationLock === null) {
                    throw new ReverseAcceptServiceFailure(
                        "reverse_accept.preparation_busy",
                        "reverse-accept preparation mutex is busy",
                        "conflict",
                        true,
                    );
                }
                try {
                    const current = markerStore.readMarker(input.preparationId);
                    if (current.state !== "available") {
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.marker_unavailable",
                            "reverse-accept marker became unavailable under the preparation mutex",
                            "unavailable",
                        );
                    }
                    if (
                        current.value.identity.preparationIdentityFingerprint !==
                        initial.value.identity.preparationIdentityFingerprint
                    ) {
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.identity_changed",
                            "reverse-accept preparation identity changed while acquiring its Deployment mutex",
                            "unavailable",
                        );
                    }
                    if (current.value.preparationState !== "prepared") {
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.preparation_terminal",
                            `reverse-accept preparation is already ${current.value.preparationState}`,
                            "conflict",
                        );
                    }
                    markerStore.repairLocatorFromMarker(current.value);
                    if (current.value.preparationRevision !== input.expectedPreparationRevision) {
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.revision_stale",
                            "reverse-accept preparation revision is stale",
                            "conflict",
                        );
                    }
                    const currentTime = now();
                    if (!isSafeNonNegativeInteger(currentTime)) {
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.invalid_clock",
                            "Core clock returned an invalid cancellation time",
                            "internal_error",
                        );
                    }
                    if (currentTime >= current.value.expiresAt) {
                        markerStore.transitionPrepared(
                            input.preparationId,
                            input.expectedPreparationRevision,
                            current.value.markerFingerprint,
                            "expired",
                        );
                        throw new ReverseAcceptServiceFailure(
                            "reverse_accept.preparation_expired",
                            "reverse-accept preparation expired before cancellation",
                            "conflict",
                        );
                    }
                    markerStore.transitionPrepared(
                        input.preparationId,
                        input.expectedPreparationRevision,
                        current.value.markerFingerprint,
                        "cancelled",
                    );
                    return completeResult(undefined);
                } finally {
                    operationLock.release();
                }
            } catch (error) {
                return {
                    status: "failed",
                    value: undefined,
                    diagnostics: [diagnosticForError(error)],
                };
            }
        },
    });
}
