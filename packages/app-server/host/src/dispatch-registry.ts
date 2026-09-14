import {
    createProtocolResultResponse,
    parseProtocolOperationResult,
    type ProtocolAcceptedLongOperationName,
    type ProtocolOperationName,
    type ProtocolRequestV1,
    type ProtocolResponseEnvelopeV1,
} from "@oaam/app-server-protocol";
import type { AdapterId, AgentRuntimeId, CoreService, PosixRelativePath, UuidV4 } from "@oaam/core";
import { projectAsset, projectAssetVersionManifest, projectDeployment, projectProject } from "./catalog-projection";
import {
    projectAssetKindCounts,
    projectAssetSummaryPage,
    projectAssetVersionFilePreview,
    projectAssetVersionFileTreePage,
    projectAssetVersionPage,
    projectAssetVersionTextPage,
    projectAssetVersionComparison,
    projectAssetVersionExport,
    projectAssetVersionNativeExport,
} from "./asset-library-projection";
import {
    hostPathSelectionFailure,
    hostInvocationFailure,
    projectCoreOutcome,
    projectCoreOutcomeWithFailedValue,
    projectLookup,
    toCoreSha256,
} from "./core-outcome";
import { projectAssetListResult } from "./core-projection";
import { projectCatalogSearchResult } from "./catalog-search-projection";
import { projectReindex, projectRenderAnalysis, projectReverseCommit, toCoreRenderSelection } from "./render-projection";
import {
    projectAdapterEnablement,
    projectAdapterProvider,
    projectEnvironment,
    projectPromotionGrant,
    projectPromotionGrantView,
    projectRestrictedSourceFullAccess,
    projectWatchedScanIntent,
    toCorePromotionTarget,
} from "./settings-projection";
import type { OperationRunContext } from "./operation-manager";
import type { HostPathSelectionStore } from "./path-selection-store";
import type { HostRenderApprovalAuthority } from "./render-approval-authority";
import { projectAssetCopy, projectAssetPurgePreparation, projectAssetPurgeResult } from "./asset-lifecycle-projection";

export const HOST_H1_IMMEDIATE_OPERATIONS = Object.freeze([
    "environment.list",
    "adapter_provider.list",
    "adapter_enablement.get",
    "watched_scan_intent.get",
    "project.list",
    "project.get",
    "catalog.search",
    "asset.list",
    "asset.get",
    "asset_version.get",
    "asset_library.kind_counts",
    "asset_library.page",
    "asset_version.list",
    "asset_version.file_children",
    "asset_version.file_preview",
    "asset_version.text_page",
    "asset.purge.inspect",
    "deployment.list",
    "deployment.get",
    "adapter_enablement.replace",
    "asset.display.update",
    "asset.copy",
    "asset.soft_delete",
    "asset.restore",
    "watched_scan_intent.reset",
    "deployment.update_inputs",
    "deployment.soft_delete",
    "promotion_grant.list",
    "promotion_grant.create",
    "promotion_grant.revoke",
    "restricted_source_full_access.get",
    "restricted_source_full_access.set",
] as const satisfies readonly ProtocolOperationName[]);

export const HOST_H1_LONG_OPERATIONS = Object.freeze([
    "asset_version.compare",
    "asset_version.export",
    "asset_version.export_native",
    "asset.purge.commit",
    "deployment.render_analyze",
    "deployment.scan",
    "deployment.recover",
    "reverse_accept.commit",
    "reverse_accept.cancel",
    "asset.reindex",
] as const satisfies readonly ProtocolAcceptedLongOperationName[]);

export const HOST_H1_OPERATIONS = Object.freeze([
    "initialize",
    ...HOST_H1_IMMEDIATE_OPERATIONS,
    ...HOST_H1_LONG_OPERATIONS,
    "operation.observe",
    "operation.cancel",
] as const satisfies readonly ProtocolOperationName[]);

type ImmediateH1Operation = (typeof HOST_H1_IMMEDIATE_OPERATIONS)[number];
type LongH1Operation = (typeof HOST_H1_LONG_OPERATIONS)[number];

function uuid(value: string): UuidV4 {
    return value as UuidV4;
}

function adapterIds(values: readonly string[]): AdapterId[] {
    return values.map((value) => value as AdapterId);
}

function agentRuntimeIds(values: readonly string[]): AgentRuntimeId[] {
    return values.map((value) => value as AgentRuntimeId);
}

function immediateFailure(id: string, operation: ImmediateH1Operation): ProtocolResponseEnvelopeV1 {
    return createProtocolResultResponse(id, operation, parseProtocolOperationResult(operation, hostInvocationFailure()));
}

export function dispatchH1Immediate(core: CoreService, request: ProtocolRequestV1): ProtocolResponseEnvelopeV1 | null {
    try {
        switch (request.method) {
            case "environment.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getAvailablePlatformContexts([...request.params.platforms]), (contexts) => ({
                        environments: contexts.map(projectEnvironment),
                    })),
                );
            case "adapter_provider.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.listAdapterProviders(), (providers) => ({
                        providers: providers.map(projectAdapterProvider),
                    })),
                );
            case "adapter_enablement.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getAdapterEnablement(), projectAdapterEnablement),
                );
            case "watched_scan_intent.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getWatchedScanIntent(), projectWatchedScanIntent),
                );
            case "project.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.listProjects(request.params), (projects) => ({
                        projects: projects.map(projectProject),
                    })),
                );
            case "project.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getProject(uuid(request.params.projectId)), (value) =>
                        projectLookup(value, projectProject),
                    ),
                );
            case "catalog.search":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.searchCatalog(request.params), projectCatalogSearchResult),
                );
            case "asset.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetListResult(core.listAssets(request.params)),
                );
            case "asset.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getAsset(uuid(request.params.assetId)), (value) =>
                        projectLookup(value, projectAsset),
                    ),
                );
            case "asset_version.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.getVersionManifest({
                            assetId: uuid(request.params.assetId),
                            versionId: uuid(request.params.versionId),
                        }),
                        (value) => projectLookup(value, projectAssetVersionManifest),
                    ),
                );
            case "asset.display.update":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.updateAssetDisplay(uuid(request.params.assetId), {
                            displayName: request.params.displayName,
                            displayDescription: request.params.displayDescription,
                        }),
                        projectAsset,
                    ),
                );
            case "asset.copy":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetCopy(
                        core.copyAssetVersionToLocation({
                            source: {
                                assetId: uuid(request.params.source.assetId),
                                versionId: uuid(request.params.source.versionId),
                                versionFingerprint: toCoreSha256(request.params.source.versionFingerprint),
                                originAuthorityFingerprint: toCoreSha256(request.params.source.originAuthorityFingerprint),
                            },
                            destination:
                                request.params.destination.scope === "global"
                                    ? {
                                          scope: "global",
                                          projectId: "",
                                          scopePath: request.params.destination.scopePath,
                                      }
                                    : {
                                          scope: "project",
                                          projectId: request.params.destination.projectId,
                                          scopePath: request.params.destination.scopePath,
                                      },
                            displayName: request.params.displayName,
                            displayDescription: request.params.displayDescription,
                            userActionEvidenceId: request.params.userActionId,
                        }),
                    ),
                );
            case "asset.soft_delete":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.softDeleteAsset(uuid(request.params.assetId)), projectAsset),
                );
            case "asset.restore":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.restoreAsset(uuid(request.params.assetId)), projectAsset),
                );
            case "asset_library.kind_counts":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetKindCounts(
                        core.listAssetKindCounts({
                            subject:
                                request.params.subject.scope === "global"
                                    ? { scope: "global" }
                                    : {
                                          scope: "project",
                                          projectId: uuid(request.params.subject.projectId),
                                      },
                            keywords: request.params.keywords,
                            ...(request.params.includeDeleted === undefined
                                ? {}
                                : { includeDeleted: request.params.includeDeleted }),
                        }),
                    ),
                );
            case "asset_library.page":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetSummaryPage(
                        core.queryAssetSummaryPage({
                            subject:
                                request.params.subject.scope === "global"
                                    ? { scope: "global" }
                                    : {
                                          scope: "project",
                                          projectId: uuid(request.params.subject.projectId),
                                      },
                            kind: request.params.kind,
                            keywords: request.params.keywords,
                            ...(request.params.includeDeleted === undefined
                                ? {}
                                : { includeDeleted: request.params.includeDeleted }),
                            ...(request.params.pageSize === undefined ? {} : { pageSize: request.params.pageSize }),
                            ...(request.params.cursor === undefined ? {} : { cursor: request.params.cursor }),
                        }),
                    ),
                );
            case "asset_version.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetVersionPage(
                        core.listAssetVersionPage({
                            assetId: uuid(request.params.assetId),
                            ...(request.params.pageSize === undefined ? {} : { pageSize: request.params.pageSize }),
                            ...(request.params.cursor === undefined ? {} : { cursor: request.params.cursor }),
                        }),
                    ),
                );
            case "asset_version.file_children":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetVersionFileTreePage(
                        core.listAssetVersionFileChildren({
                            assetId: uuid(request.params.assetId),
                            versionId: uuid(request.params.versionId),
                            directoryPath: request.params.directoryPath,
                            ...(request.params.pageSize === undefined ? {} : { pageSize: request.params.pageSize }),
                            ...(request.params.cursor === undefined ? {} : { cursor: request.params.cursor }),
                        }),
                    ),
                );
            case "asset_version.file_preview":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetVersionFilePreview(
                        core.readAssetVersionFilePreview({
                            assetId: uuid(request.params.assetId),
                            versionId: uuid(request.params.versionId),
                            logicalPath: request.params.logicalPath as PosixRelativePath,
                        }),
                    ),
                );
            case "asset_version.text_page":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetVersionTextPage(
                        core.readAssetVersionTextPage({
                            assetId: uuid(request.params.assetId),
                            versionId: uuid(request.params.versionId),
                            logicalPath: request.params.logicalPath as PosixRelativePath,
                            ...(request.params.cursor === undefined ? {} : { cursor: request.params.cursor }),
                        }),
                    ),
                );
            case "asset.purge.inspect":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectAssetPurgePreparation(core.inspectAssetPurge(uuid(request.params.assetId))),
                );
            case "deployment.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.listDeployments({
                            ...(request.params.subject === undefined
                                ? {}
                                : {
                                      projectId:
                                          request.params.subject.subjectKind === "global" ? "" : request.params.subject.projectId,
                                  }),
                            ...(request.params.includeDeleted === undefined
                                ? {}
                                : { includeDeleted: request.params.includeDeleted }),
                            ...(request.params.stage === undefined ? {} : { stage: request.params.stage }),
                        }),
                        (deployments) => ({ deployments: deployments.map(projectDeployment) }),
                    ),
                );
            case "deployment.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getDeployment(uuid(request.params.deploymentId)), (value) =>
                        projectLookup(value, projectDeployment),
                    ),
                );
            case "adapter_enablement.replace":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.replaceAdapterEnablement({
                            expectedRevision: request.params.expectedRevision,
                            expectedSettingFingerprint: toCoreSha256(request.params.expectedSettingFingerprint),
                            enabledAdapterIds: adapterIds(request.params.enabledAdapterIds),
                            userActionId: request.params.userActionId,
                        }),
                        projectAdapterEnablement,
                    ),
                );
            case "watched_scan_intent.reset":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.resetWatchedScanIntent({
                            expectedRevision: request.params.expectedRevision,
                            expectedSettingFingerprint: toCoreSha256(request.params.expectedSettingFingerprint),
                            userActionId: request.params.userActionId,
                        }),
                        projectWatchedScanIntent,
                    ),
                );
            case "deployment.update_inputs":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.updateDeploymentInputs(uuid(request.params.deploymentId), {
                            ...(request.params.expectedInputs === undefined
                                ? {}
                                : {
                                      expectedInputs: {
                                          consumerAgentRuntimeIds: agentRuntimeIds(
                                              request.params.expectedInputs.consumerAgentRuntimeIds,
                                          ),
                                          assets: request.params.expectedInputs.assets.map((asset) => ({
                                              assetId: uuid(asset.assetId),
                                              versionId: uuid(asset.versionId),
                                              allowIncomplete: asset.allowIncomplete,
                                          })),
                                      },
                                  }),
                            ...(request.params.consumerAgentRuntimeIds === undefined
                                ? {}
                                : { consumerAgentRuntimeIds: agentRuntimeIds(request.params.consumerAgentRuntimeIds) }),
                            ...(request.params.assets === undefined
                                ? {}
                                : {
                                      assets: request.params.assets.map((asset) => ({
                                          assetId: uuid(asset.assetId),
                                          versionId: uuid(asset.versionId),
                                          allowIncomplete: asset.allowIncomplete,
                                      })),
                                  }),
                        }),
                        projectDeployment,
                    ),
                );
            case "deployment.soft_delete":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.softDeleteDeployment(uuid(request.params.deploymentId)), projectDeployment),
                );
            case "promotion_grant.list":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.listPromotionGrantViews(uuid(request.params.assetId)), (grants) => ({
                        grants: grants.map(projectPromotionGrantView),
                    })),
                );
            case "promotion_grant.create":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.createPromotionGrant(
                            request.params.promotionAction === "grant_current_version_current_target"
                                ? {
                                      promotionAction: request.params.promotionAction,
                                      assetId: uuid(request.params.assetId),
                                      versionId: uuid(request.params.versionId),
                                      target: toCorePromotionTarget(request.params.target),
                                      userActionId: request.params.userActionId,
                                  }
                                : {
                                      promotionAction: request.params.promotionAction,
                                      assetId: uuid(request.params.assetId),
                                      target: toCorePromotionTarget(request.params.target),
                                      userActionId: request.params.userActionId,
                                  },
                        ),
                        projectPromotionGrant,
                    ),
                );
            case "promotion_grant.revoke":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.revokePromotionGrant({
                            promotionGrantId: uuid(request.params.promotionGrantId),
                            expectedRevision: request.params.expectedRevision,
                            expectedGrantFingerprint: toCoreSha256(request.params.expectedGrantFingerprint),
                            userActionId: request.params.userActionId,
                        }),
                        projectPromotionGrant,
                    ),
                );
            case "restricted_source_full_access.get":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(core.getRestrictedSourcePromotionFullAccess(), projectRestrictedSourceFullAccess),
                );
            case "restricted_source_full_access.set":
                return createProtocolResultResponse(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.setRestrictedSourcePromotionFullAccess({
                            settingId: "restricted_source_promotion_full_access_v1",
                            expectedRevision: request.params.expectedRevision,
                            expectedSettingFingerprint: toCoreSha256(request.params.expectedSettingFingerprint),
                            nextState: request.params.nextState,
                            userActionId: request.params.userActionId,
                        }),
                        projectRestrictedSourceFullAccess,
                    ),
                );
            default:
                return null;
        }
    } catch {
        return immediateFailure(request.id, request.method as ImmediateH1Operation);
    }
}

export async function dispatchH1Long(
    core: CoreService,
    request: ProtocolRequestV1,
    operationContext?: OperationRunContext,
    pathSelections?: HostPathSelectionStore,
    renderApprovals?: HostRenderApprovalAuthority,
): Promise<unknown> {
    switch (request.method) {
        case "asset_version.compare":
            return projectAssetVersionComparison(
                await core.compareAssetVersions(
                    {
                        assetId: uuid(request.params.assetId),
                        left: {
                            versionId: uuid(request.params.left.versionId),
                            versionFingerprint: toCoreSha256(request.params.left.versionFingerprint),
                        },
                        right: {
                            versionId: uuid(request.params.right.versionId),
                            versionFingerprint: toCoreSha256(request.params.right.versionFingerprint),
                        },
                        ...(request.params.logicalPath === undefined
                            ? {}
                            : { logicalPath: request.params.logicalPath as PosixRelativePath }),
                    },
                    {
                        report(progress) {
                            operationContext?.reportProgress(progress);
                        },
                        isCancellationRequested() {
                            return operationContext?.isCancellationRequested() ?? false;
                        },
                    },
                ),
            );
        case "asset_version.export": {
            const destinationPath = pathSelections?.consume(request.params.localPathSelectionToken, "asset_export_file");
            if (destinationPath === undefined || destinationPath === null) return hostPathSelectionFailure();
            return projectAssetVersionExport(
                await core.exportAssetVersionToFile({
                    source: {
                        assetId: uuid(request.params.source.assetId),
                        versionId: uuid(request.params.source.versionId),
                        versionFingerprint: toCoreSha256(request.params.source.versionFingerprint),
                        originAuthorityFingerprint: toCoreSha256(request.params.source.originAuthorityFingerprint),
                    },
                    destinationPath,
                    userActionEvidenceId: request.params.userActionId,
                }),
            );
        }
        case "asset_version.export_native": {
            const destinationPath = pathSelections?.consume(request.params.localPathSelectionToken, "asset_native_export_file");
            if (destinationPath === undefined || destinationPath === null) return hostPathSelectionFailure();
            return projectAssetVersionNativeExport(
                await core.exportAssetVersionNativeFilesToFile({
                    source: {
                        assetId: uuid(request.params.source.assetId),
                        versionId: uuid(request.params.source.versionId),
                        versionFingerprint: toCoreSha256(request.params.source.versionFingerprint),
                        originAuthorityFingerprint: toCoreSha256(request.params.source.originAuthorityFingerprint),
                    },
                    destinationPath,
                    userActionEvidenceId: request.params.userActionId,
                }),
            );
        }
        case "asset.purge.commit":
            return projectAssetPurgeResult(
                await core.purgeAsset({
                    preparation: {
                        ...request.params.preparation,
                        assetId: uuid(request.params.preparation.assetId),
                        assetManifestFingerprint: toCoreSha256(request.params.preparation.assetManifestFingerprint),
                        assetDirectoryIdentityFingerprint: toCoreSha256(
                            request.params.preparation.assetDirectoryIdentityFingerprint,
                        ),
                    },
                    userActionEvidenceId: request.params.userActionId,
                }),
            );
        case "deployment.render_analyze":
            return projectCoreOutcome(await core.analyzeDeploymentRender(uuid(request.params.deploymentId)), (analysis) =>
                projectRenderAnalysis(request.params.deploymentId, analysis),
            );
        case "deployment.scan":
            return projectCoreOutcome(await core.scanDeployment(uuid(request.params.deploymentId)), projectDeployment);
        case "deployment.recover":
            return projectCoreOutcome(await core.recoverDeployment(uuid(request.params.deploymentId)), projectDeployment);
        case "reverse_accept.commit": {
            const selectionRequest = toCoreRenderSelection(request.params.renderSelection);
            const commit = () =>
                core.commitRenderedTargetAccept({
                    preparationId: uuid(request.params.preparationId),
                    expectedPreparationRevision: request.params.expectedPreparationRevision,
                    userActionId: request.params.userActionId,
                    newVersionPromotion: { promotionAction: request.params.newVersionPromotion },
                    renderSelectionRequest: selectionRequest,
                });
            const result =
                renderApprovals === undefined
                    ? await commit()
                    : await renderApprovals.runWithResolutions(
                          selectionRequest,
                          renderApprovals.createResolutions(selectionRequest),
                          commit,
                      );
            return projectCoreOutcomeWithFailedValue(result, projectReverseCommit);
        }
        case "reverse_accept.cancel":
            return projectCoreOutcome(
                await core.cancelRenderedTargetAccept({
                    preparationId: uuid(request.params.preparationId),
                    expectedPreparationRevision: request.params.expectedPreparationRevision,
                }),
                () => ({}),
            );
        case "asset.reindex":
            return projectCoreOutcome(
                core.reindexAssets({
                    ...(request.params.assetIds === undefined ? {} : { assetIds: request.params.assetIds.map(uuid) }),
                    ...(request.params.includeDeleted === undefined ? {} : { includeDeleted: request.params.includeDeleted }),
                }),
                projectReindex,
            );
        default:
            return null;
    }
}

export function isH1LongOperation(operation: ProtocolOperationName): operation is LongH1Operation {
    return HOST_H1_LONG_OPERATIONS.includes(operation as LongH1Operation);
}
