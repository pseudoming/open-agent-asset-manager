/** Public Import and promotion orchestration across lower authority owners. */

import * as crypto from "node:crypto";
import { readAssetManifest } from "../catalog/asset-manifest";
import {
    buildPromotionGrantAuthority,
    createPromotionGrantAuthority,
    listPromotionGrantAuthorities,
    revokePromotionGrantAuthority,
} from "../catalog/promotion-grant-store";
import { getRestrictedSourceFullAccessAuthority, setRestrictedSourceFullAccessAuthority } from "../catalog/settings-authority";
import { publishImportedAssetVersion, publishImportedInitialAssetVersion } from "../catalog/version-authority";
import type { AssetManifestV1, CoreResult } from "../contracts/core-service";
import type {
    ImportProvenanceAuthorityV2,
    PromotionGrantV1,
    RestrictedSourcePromotionFullAccessSettingV1,
    VersionOriginAuthorityV1,
} from "../contracts/persistence";
import type { UuidV4 } from "../contracts/primitives";
import type {
    AdapterReadResult,
    CreatePromotionGrantRequest,
    ImportAcceptBatchRequest,
    ImportAcceptBatchResultV1,
    ImportAcceptRequest,
    ImportPreviewSnapshotV1,
    RevokePromotionGrantRequest,
    SetRestrictedSourcePromotionFullAccessRequest,
} from "../contracts/source-import";
import { completeResult } from "../foundation/core-result";
import {
    computeImportProvenanceAuthorityFingerprint,
    computeVersionOriginAuthorityFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import type { OperationDiagnostic, VersionRef } from "../types";
import {
    acquireAssetAuthorityLocks,
    acquireImportCatalogLock,
    acquireSettingsAuthorityLock,
    locatePromotionGrant,
    nextRevision,
    readAssetCatalog,
    requireActiveAsset,
    resolveCandidateProjectId,
} from "./import-authority";
import { acceptImportBatch } from "./import-batch-orchestrator";
import {
    buildCandidateMaterial,
    buildImportedVersionClosure,
    requireParentVersion,
    resolveBindingAssetIds,
    revalidateBindingTargets,
    validateCandidateTargetAsset,
} from "./import-material";
import { buildImportSourceSnapshot } from "./import-source-snapshot";
import { acquireNewAssetLocks } from "./asset-service-shared";
import {
    buildPreview,
    candidateSourceRuntimes,
    computeMaterialFingerprint,
    findExactDuplicateVersions,
    selectFreshCandidate,
    validateAcceptRequest,
    validateBatchAcceptedRequest,
} from "./import-preview";
import type { ImportService, ImportServiceConfiguration } from "./import-service-shared";
import {
    compareUtf8Bytes,
    createIdentityAllocator,
    failed,
    ImportServiceFailure,
    newIdentity,
    requireUserAction,
} from "./import-service-shared";

export function createImportService(sourceConfiguration: ImportServiceConfiguration): ImportService {
    const dialectRegistry = sourceConfiguration.dialectRegistry;
    const configuration: ImportServiceConfiguration = Object.freeze({
        assetsRoot: sourceConfiguration.assetsRoot,
        oaamRoot: sourceConfiguration.oaamRoot,
        authorityLocksRoot: sourceConfiguration.authorityLocksRoot,
        dialectRegistry: Object.freeze({
            getNative: dialectRegistry.getNative.bind(dialectRegistry),
            getRestoration: dialectRegistry.getRestoration.bind(dialectRegistry),
            getPortableEntry: dialectRegistry.getPortableEntry.bind(dialectRegistry),
            getPortableSelector: dialectRegistry.getPortableSelector.bind(dialectRegistry),
        }),
        resolveSourceCapabilityAgentRuntimeId: sourceConfiguration.resolveSourceCapabilityAgentRuntimeId,
        resolveProjectId: sourceConfiguration.resolveProjectId,
        acquireProjectAuthority: sourceConfiguration.acquireProjectAuthority,
        refreshReadResult: sourceConfiguration.refreshReadResult,
        validateReadAuthority: sourceConfiguration.validateReadAuthority,
        reindexImportedAsset: sourceConfiguration.reindexImportedAsset,
        assertMutationScope: sourceConfiguration.assertMutationScope,
        now: sourceConfiguration.now,
        newUuid: sourceConfiguration.newUuid,
    });
    const now = configuration.now ?? (() => Date.now());
    const newUuid = configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4);
    const batchValidatedRequests = new WeakMap<ImportAcceptRequest, ImportServiceConfiguration["refreshReadResult"]>();

    let service: ImportService;
    service = {
        previewImport(readResults: AdapterReadResult[]): CoreResult<ImportPreviewSnapshotV1> {
            try {
                return completeResult(buildPreview(configuration, structuredClone(readResults), now()));
            } catch (error) {
                return failed(error, "asset");
            }
        },

        async acceptImport(sourceInput: ImportAcceptRequest): Promise<CoreResult<VersionRef>> {
            try {
                const batchRefresh = batchValidatedRequests.get(sourceInput);
                const batchValidated = batchRefresh !== undefined;
                batchValidatedRequests.delete(sourceInput);
                const input = structuredClone(sourceInput);
                const initialValidation = batchValidated
                    ? validateBatchAcceptedRequest(input)
                    : validateAcceptRequest(configuration, input);
                configuration.assertMutationScope({
                    assetIds: input.decision.action === "create_version" ? [input.decision.assetId] : [],
                    settingsAuthority: false,
                });
                const selectedSource = await selectFreshCandidate(
                    batchRefresh === undefined ? configuration : { ...configuration, refreshReadResult: batchRefresh },
                    initialValidation.candidate,
                    initialValidation.readResult,
                    input,
                );
                const selectedCandidate = selectedSource.candidate;

                const ids = createIdentityAllocator(newUuid);
                const versionId = ids.next("versionId");
                const assetId = input.decision.action === "create_asset" ? ids.next("assetId") : input.decision.assetId;
                const projectId = resolveCandidateProjectId(configuration, selectedCandidate);
                const releaseProject = projectId === "" ? () => undefined : configuration.acquireProjectAuthority(projectId);
                try {
                    const dependencyAssetIds = resolveBindingAssetIds(configuration, input.decision.callableBindings);
                    const lockedAssetIds = [...new Set([assetId, ...dependencyAssetIds])].sort(compareUtf8Bytes);
                    const release =
                        input.decision.action === "create_asset"
                            ? acquireNewAssetLocks(configuration.authorityLocksRoot, lockedAssetIds)
                            : acquireAssetAuthorityLocks(configuration.authorityLocksRoot, lockedAssetIds);
                    try {
                        configuration.assertMutationScope({
                            assetIds: lockedAssetIds,
                            settingsAuthority: false,
                        });
                        const releaseCatalog = acquireImportCatalogLock(configuration.authorityLocksRoot);
                        try {
                            // A normal single accept recomputes its catalog-relative preview only after
                            // all owning locks are held. A batch request instead reuses the exact snapshot
                            // that was validated before its first publish; final duplicate and binding
                            // checks below still use current authorities for this item.
                            const validated = batchValidated
                                ? validateBatchAcceptedRequest(input)
                                : validateAcceptRequest(configuration, input);
                            const candidateFingerprint = validated.candidateFingerprint;
                            if (
                                input.decision.freshness.freshnessAction === "require_current_source" &&
                                !configuration.validateReadAuthority(selectedSource.readResult)
                            ) {
                                throw new ImportServiceFailure(
                                    "import.source_authority_changed",
                                    "source registry or managed authority changed before publication",
                                    "conflict",
                                    true,
                                );
                            }
                            revalidateBindingTargets(
                                configuration,
                                selectedCandidate,
                                projectId,
                                input.decision.callableBindings,
                            );
                            const parent =
                                input.decision.action === "create_version"
                                    ? requireParentVersion(configuration, input.decision.assetId, input.decision.parentVersionId)
                                    : null;
                            const currentProjectId = resolveCandidateProjectId(configuration, selectedCandidate);
                            if (currentProjectId !== projectId) {
                                throw new ImportServiceFailure(
                                    "import.project_authority_changed",
                                    "candidate Project authority changed before publication",
                                    "conflict",
                                    true,
                                );
                            }
                            if (parent !== null) {
                                validateCandidateTargetAsset(configuration, assetId, selectedCandidate, projectId);
                            }
                            const material = buildCandidateMaterial(
                                selectedCandidate,
                                input.decision.callableBindings,
                                parent,
                                configuration.dialectRegistry,
                                candidateSourceRuntimes(configuration, selectedSource.readResult, selectedCandidate),
                                ids,
                            );
                            const finalDuplicates = findExactDuplicateVersions(
                                readAssetCatalog(configuration),
                                selectedCandidate,
                                projectId,
                                computeMaterialFingerprint(material),
                            );
                            if (finalDuplicates.length > 0) {
                                throw new ImportServiceFailure(
                                    "import.duplicate_after_binding",
                                    "resolved import material already exists in an Asset history",
                                    "conflict",
                                );
                            }
                            const grantId =
                                input.decision.promotion.promotionAction === "import_only" ? null : ids.next("promotionGrantId");
                            const importedAt = now();
                            const importProvenanceId = ids.next("importProvenanceId");
                            const acceptedPromotion =
                                input.decision.promotion.promotionAction === "import_only"
                                    ? {
                                          promotionAction: "import_only" as const,
                                          userActionEvidenceId: requireUserAction(
                                              input.decision.promotion.userActionId,
                                              "promotion.userActionId",
                                          ),
                                      }
                                    : {
                                          promotionAction: input.decision.promotion.promotionAction,
                                          promotionGrantId: grantId as UuidV4,
                                          userActionEvidenceId: requireUserAction(
                                              input.decision.promotion.userActionId,
                                              "promotion.userActionId",
                                          ),
                                      };
                            const provenancePreimage: Omit<ImportProvenanceAuthorityV2, "authorityFingerprint"> = {
                                schemaVersion: 2,
                                importProvenanceId,
                                assetId,
                                versionId,
                                previewSnapshotFingerprint: input.previewSnapshot.snapshotFingerprint,
                                candidateFingerprint,
                                acceptedFreshness:
                                    input.decision.freshness.freshnessAction === "require_current_source"
                                        ? "current_source_verified"
                                        : "user_approved_preview_snapshot",
                                acceptedPromotion,
                                promotionSafety: selectedCandidate.promotionSafety,
                                importedAt,
                                sourceSnapshot: buildImportSourceSnapshot(selectedSource.readResult, selectedCandidate),
                            };
                            const importProvenanceAuthority: ImportProvenanceAuthorityV2 = {
                                ...provenancePreimage,
                                authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
                            };
                            const originPreimage: Omit<
                                Extract<VersionOriginAuthorityV1, { originKind: "import" }>,
                                "authorityFingerprint"
                            > = {
                                schemaVersion: 1,
                                assetId,
                                versionId,
                                originKind: "import",
                                importProvenanceId,
                                importProvenanceAuthorityFingerprint: importProvenanceAuthority.authorityFingerprint,
                                promotionRequirement: "requires_current_authorization",
                                createdAt: importedAt,
                            };
                            const originAuthority: Extract<VersionOriginAuthorityV1, { originKind: "import" }> = {
                                ...originPreimage,
                                authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
                            };
                            const revision = parent === null ? 1 : nextRevision(configuration, assetId);
                            const version = buildImportedVersionClosure({
                                assetId,
                                versionId,
                                revision,
                                parentVersionId: parent?.manifest.versionId ?? "",
                                importedAt,
                                material,
                                candidate: selectedCandidate,
                                originAuthority,
                                importProvenanceAuthority,
                            });
                            const promotionDisposition = input.decision.promotion;
                            const promotion =
                                promotionDisposition.promotionAction === "import_only"
                                    ? { promotionAction: "import_only" as const }
                                    : {
                                          promotionAction: "publish_grant" as const,
                                          grant: buildPromotionGrantAuthority({
                                              promotionGrantId: grantId as UuidV4,
                                              subject:
                                                  promotionDisposition.promotionAction === "grant_current_version_current_target"
                                                      ? {
                                                            subjectKind: "asset_version",
                                                            assetId,
                                                            versionId,
                                                        }
                                                      : {
                                                            subjectKind: "asset_all_versions",
                                                            assetId,
                                                            activationVersionId: versionId,
                                                        },
                                              target: promotionDisposition.target,
                                              userActionEvidenceId: promotionDisposition.userActionId,
                                              updatedAt: importedAt,
                                          }),
                                      };
                            const transactionId = ids.next("transactionId");

                            if (parent === null) {
                                if (readAssetManifest(configuration.assetsRoot, assetId) !== null) {
                                    throw new ImportServiceFailure(
                                        "import.asset_id_collision",
                                        "new Asset identity already exists",
                                    );
                                }
                                const asset: AssetManifestV1 = {
                                    schemaVersion: 1,
                                    assetId,
                                    kind: selectedCandidate.kind,
                                    scope: selectedCandidate.scope,
                                    projectId,
                                    scopePath: selectedCandidate.scopePath,
                                    displayName: selectedCandidate.displayName,
                                    displayDescription: selectedCandidate.displayDescription,
                                    versionIds: [versionId],
                                    deleted: false,
                                    createdAt: importedAt,
                                    updatedAt: importedAt,
                                };
                                publishImportedInitialAssetVersion({
                                    assetsRoot: configuration.assetsRoot,
                                    transactionId,
                                    asset,
                                    version,
                                    dialectRegistry: configuration.dialectRegistry,
                                    promotion,
                                });
                            } else {
                                publishImportedAssetVersion({
                                    assetsRoot: configuration.assetsRoot,
                                    transactionId,
                                    version,
                                    dialectRegistry: configuration.dialectRegistry,
                                    promotion,
                                });
                            }
                            return completePublishedImport(configuration, { assetId, versionId });
                        } finally {
                            releaseCatalog();
                        }
                    } finally {
                        release();
                    }
                } finally {
                    releaseProject();
                }
            } catch (error) {
                return failed(error, "version");
            }
        },

        acceptImportBatch(sourceInput: ImportAcceptBatchRequest): Promise<CoreResult<ImportAcceptBatchResultV1>> {
            const reads = new Map<string, Promise<CoreResult<AdapterReadResult>>>();
            const refreshReadResult: ImportServiceConfiguration["refreshReadResult"] = (previous) => {
                const key = stableStringify({ readTarget: previous.readTarget, snapshot: previous.readSnapshotFingerprint });
                let read = reads.get(key);
                if (read === undefined) {
                    const snapshot = structuredClone(previous);
                    read = Promise.resolve()
                        .then(() => configuration.refreshReadResult(snapshot))
                        .then((result) => structuredClone(result));
                    reads.set(key, read);
                }
                return read.then((result) => structuredClone(result));
            };
            return acceptImportBatch(configuration, sourceInput, (input) => {
                batchValidatedRequests.set(input, refreshReadResult);
                return service.acceptImport(input);
            });
        },

        listPromotionGrants(assetId: UuidV4): CoreResult<PromotionGrantV1[]> {
            try {
                const release = acquireAssetAuthorityLocks(configuration.authorityLocksRoot, [assetId]);
                try {
                    return completeResult(listPromotionGrantAuthorities(configuration.assetsRoot, assetId));
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error, "asset");
            }
        },

        createPromotionGrant(input: CreatePromotionGrantRequest): CoreResult<PromotionGrantV1> {
            try {
                if (
                    input.promotionAction !== "grant_current_version_current_target" &&
                    input.promotionAction !== "grant_asset_all_versions_current_target"
                ) {
                    throw new ImportServiceFailure(
                        "promotion.action_invalid",
                        "promotionAction is not a supported grant operation",
                        "invalid_schema",
                    );
                }
                configuration.assertMutationScope({
                    assetIds: [input.assetId],
                    settingsAuthority: false,
                });
                const release = acquireAssetAuthorityLocks(configuration.authorityLocksRoot, [input.assetId]);
                try {
                    configuration.assertMutationScope({
                        assetIds: [input.assetId],
                        settingsAuthority: false,
                    });
                    const asset = requireActiveAsset(configuration.assetsRoot, input.assetId);
                    if (
                        input.promotionAction === "grant_current_version_current_target" &&
                        !asset.versionIds.includes(input.versionId)
                    ) {
                        throw new ImportServiceFailure(
                            "promotion.version_not_member",
                            "promotion grant Version does not belong to the selected Asset",
                        );
                    }
                    const subject =
                        input.promotionAction === "grant_current_version_current_target"
                            ? {
                                  subjectKind: "asset_version" as const,
                                  assetId: input.assetId,
                                  versionId: input.versionId,
                              }
                            : {
                                  subjectKind: "asset_all_versions" as const,
                                  assetId: input.assetId,
                                  activationVersionId: asset.versionIds[asset.versionIds.length - 1] as UuidV4,
                              };
                    return completeResult(
                        createPromotionGrantAuthority({
                            assetsRoot: configuration.assetsRoot,
                            promotionGrantId: newIdentity(newUuid, "promotionGrantId"),
                            subject,
                            target: input.target,
                            userActionEvidenceId: requireUserAction(input.userActionId, "userActionId"),
                            updatedAt: now(),
                        }),
                    );
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error, "asset");
            }
        },

        revokePromotionGrant(input: RevokePromotionGrantRequest): CoreResult<PromotionGrantV1> {
            try {
                const located = locatePromotionGrant(configuration, input.promotionGrantId);
                configuration.assertMutationScope({
                    assetIds: [located.subject.assetId],
                    settingsAuthority: false,
                });
                const release = acquireAssetAuthorityLocks(configuration.authorityLocksRoot, [located.subject.assetId]);
                try {
                    configuration.assertMutationScope({
                        assetIds: [located.subject.assetId],
                        settingsAuthority: false,
                    });
                    return completeResult(
                        revokePromotionGrantAuthority({
                            assetsRoot: configuration.assetsRoot,
                            assetId: located.subject.assetId,
                            promotionGrantId: input.promotionGrantId,
                            expectedRevision: input.expectedRevision,
                            expectedGrantFingerprint: input.expectedGrantFingerprint,
                            userActionEvidenceId: requireUserAction(input.userActionId, "userActionId"),
                            updatedAt: now(),
                        }),
                    );
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error, "asset");
            }
        },

        getRestrictedSourcePromotionFullAccess(): CoreResult<RestrictedSourcePromotionFullAccessSettingV1> {
            try {
                const release = acquireSettingsAuthorityLock(configuration.authorityLocksRoot);
                try {
                    return completeResult(getRestrictedSourceFullAccessAuthority(configuration.oaamRoot));
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error, "settings");
            }
        },

        setRestrictedSourcePromotionFullAccess(
            input: SetRestrictedSourcePromotionFullAccessRequest,
        ): CoreResult<RestrictedSourcePromotionFullAccessSettingV1> {
            try {
                if (input.settingId !== "restricted_source_promotion_full_access_v1") {
                    throw new ImportServiceFailure(
                        "settings.setting_id_invalid",
                        "settingId is not the restricted-source Full Access authority",
                        "invalid_schema",
                    );
                }
                configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                const release = acquireSettingsAuthorityLock(configuration.authorityLocksRoot);
                try {
                    configuration.assertMutationScope({ assetIds: [], settingsAuthority: true });
                    return completeResult(
                        setRestrictedSourceFullAccessAuthority({
                            oaamRoot: configuration.oaamRoot,
                            expectedRevision: input.expectedRevision,
                            expectedSettingFingerprint: input.expectedSettingFingerprint,
                            nextState: input.nextState,
                            userActionEvidenceId: requireUserAction(input.userActionId, "userActionId"),
                            changedAt: now(),
                        }),
                    );
                } finally {
                    release();
                }
            } catch (error) {
                return failed(error, "settings");
            }
        },
    };
    return Object.freeze(service);
}

function completePublishedImport(configuration: ImportServiceConfiguration, version: VersionRef): CoreResult<VersionRef> {
    try {
        const projection = configuration.reindexImportedAsset(version.assetId);
        const diagnostics = [...projection.diagnostics, ...(projection.status === "failed" ? [] : projection.value.diagnostics)];
        if (projection.status === "complete" && diagnostics.length === 0) {
            return completeResult(version);
        }
        return {
            status: "partial",
            value: version,
            diagnostics:
                diagnostics.length > 0
                    ? structuredClone(diagnostics)
                    : [indexProjectionFailure("imported Asset index projection did not complete")],
        };
    } catch (error) {
        return {
            status: "partial",
            value: version,
            diagnostics: [
                indexProjectionFailure(
                    `imported Asset authority committed but index projection threw: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                ),
            ],
        };
    }
}

function indexProjectionFailure(message: string): OperationDiagnostic {
    return {
        severity: "error",
        code: "import.index_projection_failed",
        message,
        path: "",
        traceId: "",
        operation: "reindex",
        causeKind: "partial",
        retryable: true,
        suggestedActions: ["retry"],
        rawSummary: message,
    };
}
