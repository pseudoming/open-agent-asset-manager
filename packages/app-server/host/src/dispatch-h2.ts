import {
    createProtocolResultResponse,
    type ProtocolAcceptedLongOperationName,
    type ProtocolOperationName,
    type ProtocolRequestV1,
    type ProtocolResponseEnvelopeV1,
    parseProtocolOperationResult,
} from "@oaam/app-server-protocol";
import type {
    AdapterId,
    AdapterReadResult,
    AgentRuntimeId,
    CoreResult,
    CoreService,
    ImportAcceptBatchResultV1,
    Platform,
    PlatformContext,
    ProbeResult,
    UuidV4,
} from "@oaam/core";
import { projectDeployment, projectProject, projectProjectLifecycleReview } from "./catalog-projection";
import {
    hostInvocationFailure,
    hostPathSelectionFailure,
    hostReviewCapacityFailure,
    hostReviewFailure,
    projectCoreOutcome,
    projectCoreOutcomeWithFailedValue,
    projectDiagnostic,
    toCoreSha256,
    toProtocolSha256,
} from "./core-outcome";
import type { HostPathSelectionStore } from "./path-selection-store";
import type { HostRenderApprovalAuthority } from "./render-approval-authority";
import type { OperationRunContext } from "./operation-manager";
import { projectAssetUsage, projectRenderAnalysis, toCoreRenderSelection } from "./render-projection";
import { HostReviewRecordCapacityError } from "./review-record-store";
import { type HostReviewRecords, HostReviewRecordUnavailableError } from "./review-records";
import { projectWatchedScanIntent, toCorePromotionTarget } from "./settings-projection";

export const HOST_H2_IMMEDIATE_OPERATIONS = Object.freeze([
    "probe_environment_reference.list",
    "watched_scan_intent.replace",
    "project.register",
    "deployment.create",
    "import_preview.detail",
    "rendered_inspection.detail",
    "import_preview.cancel",
] as const satisfies readonly ProtocolOperationName[]);

export const HOST_H2_LONG_OPERATIONS = Object.freeze([
    "adapter.probe",
    "adapter.read",
    "import.preview",
    "import.accept_batch",
    "project_lifecycle.inspect",
    "project_lifecycle.commit",
    "asset_usage.analyze",
    "deployment.render_preview",
    "deployment.deploy",
    "deployment.inspect_rendered_target",
    "deployment.repair",
    "reverse_accept.prepare",
] as const satisfies readonly ProtocolAcceptedLongOperationName[]);

type ImmediateH2Operation = (typeof HOST_H2_IMMEDIATE_OPERATIONS)[number];
type LongH2Operation = (typeof HOST_H2_LONG_OPERATIONS)[number];
export type ImmediateH2Request = Extract<ProtocolRequestV1, { readonly method: ImmediateH2Operation }>;
export type LongH2Request = Extract<ProtocolRequestV1, { readonly method: LongH2Operation }>;

export interface HostH2DispatchContext {
    readonly connectionId: string;
    readonly pathSelections: HostPathSelectionStore;
    readonly reviews: HostReviewRecords;
    readonly renderApprovals: HostRenderApprovalAuthority;
}

function uuid(value: string): UuidV4 {
    return value as UuidV4;
}

function adapterId(value: string): AdapterId {
    return value as AdapterId;
}

function agentRuntimeIds(values: readonly string[]): AgentRuntimeId[] {
    return values.map((value) => value as AgentRuntimeId);
}

function immediateOutcome(id: string, operation: ImmediateH2Operation, outcome: unknown): ProtocolResponseEnvelopeV1 {
    return createProtocolResultResponse(id, operation, parseProtocolOperationResult(operation, outcome));
}

function immediateFailure(id: string, operation: ImmediateH2Operation, error: unknown): ProtocolResponseEnvelopeV1 {
    return immediateOutcome(
        id,
        operation,
        error instanceof HostReviewRecordUnavailableError ? hostReviewFailure(error.failureKind) : hostInvocationFailure(),
    );
}

function coreBinding(
    binding: { readonly assetScope: "global" } | { readonly assetScope: "project"; readonly projectId: string },
) {
    return binding.assetScope === "global"
        ? { assetScope: "global" as const }
        : { assetScope: "project" as const, projectId: uuid(binding.projectId) };
}

export function dispatchH2Immediate(
    core: CoreService,
    request: ImmediateH2Request,
    context: HostH2DispatchContext,
): ProtocolResponseEnvelopeV1 {
    try {
        switch (request.method) {
            case "probe_environment_reference.list":
                return immediateOutcome(request.id, request.method, {
                    status: "complete",
                    value: {
                        references: context.reviews.listProbeEnvironmentReferences(
                            context.connectionId,
                            request.params.probeToken,
                        ),
                    },
                    diagnostics: [],
                });
            case "project.register": {
                const rootPath = context.pathSelections.consume(request.params.localPathSelectionToken, "project_root");
                if (rootPath === null) return immediateOutcome(request.id, request.method, hostPathSelectionFailure());
                return immediateOutcome(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.registerProject({
                            rootPath,
                            ...(request.params.displayName === undefined ? {} : { displayName: request.params.displayName }),
                        }),
                        projectProject,
                    ),
                );
            }
            case "deployment.create": {
                const resolved = context.reviews.resolveProbeTarget(
                    request.params.probeToken,
                    request.params.probeResultRowId,
                    request.params.targetRowId,
                );
                const expectedTargetKind = request.params.subject.subjectKind;
                if (resolved.targetKind !== "directory" && resolved.targetKind !== expectedTargetKind) {
                    throw new TypeError("Deployment subject does not match the selected probe target");
                }
                return immediateOutcome(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.createDeployment({
                            projectId: request.params.subject.subjectKind === "global" ? "" : request.params.subject.projectId,
                            consumerAgentRuntimeIds: agentRuntimeIds(request.params.consumerAgentRuntimeIds),
                            platform: resolved.result.observation.platformContext.platform,
                            platformInstanceId: resolved.result.observation.platformContext.platformInstanceId,
                            targetRootPath: resolved.targetRootPath,
                            assets: request.params.assets.map((asset) => ({
                                assetId: uuid(asset.assetId),
                                versionId: uuid(asset.versionId),
                                allowIncomplete: asset.allowIncomplete,
                            })),
                        }),
                        projectDeployment,
                    ),
                );
            }
            case "watched_scan_intent.replace": {
                const probes = new Map<string, ProbeResult>();
                const decisions = request.params.decisions.map((decision) => {
                    if (decision.action === "retain_existing") {
                        return {
                            action: decision.action,
                            selectorFingerprint: toCoreSha256(decision.selectorFingerprint),
                        } as const;
                    }
                    if (decision.action === "include_user_selected_root") {
                        const directoryRootPath = context.pathSelections.consume(decision.localPathSelectionToken, "source_root");
                        if (directoryRootPath === null) throw new HostPathSelectionUnavailableError();
                        return {
                            action: decision.action,
                            environment: { ...decision.environment },
                            adapterId: adapterId(decision.adapterId),
                            agentRuntimeIds: agentRuntimeIds(decision.agentRuntimeIds),
                            directoryRootPath,
                            binding: coreBinding(decision.binding),
                        } as const;
                    }
                    const resolved = context.reviews.resolveProbeSources(decision.probeToken, decision.probeResultRowId, [
                        decision.sourceRootRowId,
                    ]);
                    const result = resolved.result;
                    const key = [
                        result.observation.adapterId,
                        result.observation.platformContext.platform,
                        result.observation.platformContext.platformInstanceId,
                    ].join("\0");
                    probes.set(key, result);
                    const sourceRef = {
                        adapterId: result.observation.adapterId,
                        platformContext: result.observation.platformContext,
                        sourceRootId: resolved.sourceRootIds[0] as string,
                    };
                    return decision.action === "include_observed"
                        ? {
                              action: decision.action,
                              sourceRef,
                              agentRuntimeIds: agentRuntimeIds(decision.agentRuntimeIds),
                              binding: coreBinding(decision.binding),
                          }
                        : {
                              action: decision.action,
                              sourceRef,
                              agentRuntimeIds: agentRuntimeIds(decision.agentRuntimeIds),
                          };
                });
                return immediateOutcome(
                    request.id,
                    request.method,
                    projectCoreOutcome(
                        core.replaceWatchedScanIntent({
                            expectedRevision: request.params.expectedRevision,
                            expectedSettingFingerprint: toCoreSha256(request.params.expectedSettingFingerprint),
                            userActionId: request.params.userActionId,
                            currentProbeResults: [...probes.values()],
                            decisions,
                        }),
                        projectWatchedScanIntent,
                    ),
                );
            }
            case "import_preview.detail":
                return immediateOutcome(request.id, request.method, {
                    status: "complete",
                    value: context.reviews.previewDetail(
                        request.params.previewToken,
                        request.params.candidateId,
                        request.params.logicalPath,
                    ),
                    diagnostics: [],
                });
            case "rendered_inspection.detail":
                return immediateOutcome(request.id, request.method, {
                    status: "complete",
                    value: context.reviews.inspectionDetail(request.params.inspectionToken, request.params.selector),
                    diagnostics: [],
                });
            case "import_preview.cancel":
                return immediateOutcome(
                    request.id,
                    request.method,
                    context.reviews.cancelPreview(request.params.previewToken)
                        ? { status: "complete", value: { cancelled: true }, diagnostics: [] }
                        : hostReviewFailure("record"),
                );
        }
    } catch (error) {
        if (error instanceof HostPathSelectionUnavailableError) {
            return immediateOutcome(request.id, request.method, hostPathSelectionFailure());
        }
        return immediateFailure(request.id, request.method, error);
    }
}

class HostPathSelectionUnavailableError extends Error {}

function requestedContexts(
    available: PlatformContext[],
    requested: readonly { readonly platform: Platform; readonly platformInstanceId: string }[],
): PlatformContext[] | null {
    const byKey = new Map(available.map((context) => [`${context.platform}\0${context.platformInstanceId}`, context]));
    const selected = requested.map((environment) => byKey.get(`${environment.platform}\0${environment.platformInstanceId}`));
    return selected.every((context): context is PlatformContext => context !== undefined) ? selected : null;
}

function combineReadResults(results: CoreResult<AdapterReadResult>[]) {
    const values = results.flatMap((result) => (result.status === "failed" ? [] : [result.value]));
    const diagnostics = results.flatMap((result) => result.diagnostics.map(projectDiagnostic));
    const status =
        values.length === 0
            ? ("failed" as const)
            : results.every((result) => result.status === "complete")
              ? "complete"
              : "partial";
    return { status, values, diagnostics };
}

function projectBatchImport(result: ImportAcceptBatchResultV1) {
    return {
        schemaVersion: 1 as const,
        items: result.items.map((item) =>
            item.status === "complete"
                ? {
                      status: item.status,
                      candidateId: item.candidateId,
                      version: { ...item.version },
                      diagnostics: item.diagnostics.map(projectDiagnostic),
                  }
                : item.status === "failed"
                  ? {
                        status: item.status,
                        candidateId: item.candidateId,
                        diagnostics: item.diagnostics.map(projectDiagnostic),
                    }
                  : {
                        status: item.status,
                        candidateId: item.candidateId,
                        failedDependencyCandidateIds: [...item.failedDependencyCandidateIds],
                        diagnostics: item.diagnostics.map(projectDiagnostic),
                    },
        ),
    };
}

export async function dispatchH2Long(
    core: CoreService,
    request: LongH2Request,
    context: HostH2DispatchContext,
    operation?: OperationRunContext,
): Promise<unknown> {
    try {
        switch (request.method) {
            case "adapter.probe": {
                const platforms = [...new Set(request.params.environments.map((environment) => environment.platform))];
                const available = core.getAvailablePlatformContexts(platforms);
                if (available.status === "failed") {
                    return { status: "failed", diagnostics: available.diagnostics.map(projectDiagnostic) };
                }
                const contexts = requestedContexts(available.value, request.params.environments);
                if (contexts === null) return hostPathSelectionFailure();
                const authorizedTarget =
                    request.params.authorization.scope === "global"
                        ? ({ authorizationScope: "global" } as const)
                        : request.params.authorization.scope === "project"
                          ? (() => {
                                const projectRootPath = context.pathSelections.consume(
                                    request.params.authorization.localPathSelectionToken,
                                    "project_root",
                                );
                                if (projectRootPath === null) throw new HostPathSelectionUnavailableError();
                                return { authorizationScope: "project" as const, projectRootPath };
                            })()
                          : request.params.authorization.scope === "registered_project"
                            ? (() => {
                                  const project = core.getProject(uuid(request.params.authorization.projectId));
                                  const manifest =
                                      project.status === "complete" && project.value.found ? project.value.value : undefined;
                                  if (manifest === undefined || manifest.deleted) {
                                      throw new HostPathSelectionUnavailableError();
                                  }
                                  return {
                                      authorizationScope: "project" as const,
                                      projectRootPath: manifest.rootPath,
                                  };
                              })()
                            : (() => {
                                  const directoryRootPath = context.pathSelections.consume(
                                      request.params.authorization.localPathSelectionToken,
                                      "source_root",
                                  );
                                  if (directoryRootPath === null) throw new HostPathSelectionUnavailableError();
                                  return { authorizationScope: "directory" as const, directoryRootPath };
                              })();
                let installationRootPath: string | undefined;
                if (request.params.installationRootSelectionToken !== undefined) {
                    const selected = context.pathSelections.consume(
                        request.params.installationRootSelectionToken,
                        "installation_root",
                    );
                    if (selected === null) throw new HostPathSelectionUnavailableError();
                    installationRootPath = selected;
                }
                const target =
                    installationRootPath === undefined ? authorizedTarget : { ...authorizedTarget, installationRootPath };
                const probed = projectCoreOutcome(
                    await core.probeAdapters(
                        {
                            adapterIds: request.params.adapterIds.map(adapterId),
                            contexts,
                            target,
                        },
                        (progress) =>
                            operation?.reportProgress(
                                "adapterId" in progress
                                    ? {
                                          stage: progress.stage,
                                          completedUnits: progress.completedUnits,
                                          totalUnits: progress.totalUnits,
                                          adapterId: progress.adapterId,
                                          environment: {
                                              platform: progress.platformContext.platform,
                                              platformInstanceId: progress.platformContext.platformInstanceId,
                                          },
                                          outcome: progress.outcome,
                                          elapsedMilliseconds: progress.elapsedMilliseconds,
                                      }
                                    : progress,
                            ),
                    ),
                    (results) => context.reviews.recordProbe(context.connectionId, results),
                );
                const diagnostics = [...available.diagnostics.map(projectDiagnostic), ...probed.diagnostics];
                if (probed.status === "failed") return { status: "failed", diagnostics };
                return {
                    status: available.status === "partial" || probed.status === "partial" ? "partial" : "complete",
                    value: probed.value,
                    diagnostics,
                };
            }
            case "adapter.read": {
                const readResults = await Promise.all(
                    request.params.selections.map(async (selection) => {
                        const resolved = context.reviews.resolveProbeSources(
                            request.params.probeToken,
                            selection.probeResultRowId,
                            selection.sourceRootRowIds,
                        );
                        return core.readAssetsFromAdapter({
                            adapterId: resolved.result.observation.adapterId,
                            sourceSelector: {
                                selectorKind: "probe_roots",
                                observation: resolved.result.observation,
                                sourceRootIds: resolved.sourceRootIds,
                            },
                            ...(selection.allowedKinds === undefined ? {} : { allowedKinds: [...selection.allowedKinds] }),
                            ...(selection.agentRuntimeIds === undefined
                                ? {}
                                : { agentRuntimeIds: [...selection.agentRuntimeIds] }),
                        });
                    }),
                );
                const combined = combineReadResults(readResults);
                if (combined.status === "failed") return { status: "failed", diagnostics: combined.diagnostics };
                return {
                    status: combined.status,
                    value: context.reviews.recordRead(context.connectionId, request.params.probeToken, combined.values),
                    diagnostics: combined.diagnostics,
                };
            }
            case "import.preview": {
                const outcome = projectCoreOutcome(
                    core.previewImport(context.reviews.resolveRead(request.params.readToken)),
                    (snapshot) => context.reviews.recordPreview(context.connectionId, request.params.readToken, snapshot),
                );
                return outcome;
            }
            case "import.accept_batch": {
                const snapshot = context.reviews.resolvePreview(request.params.previewToken);
                if (toProtocolSha256(snapshot.snapshotFingerprint) !== request.params.expectedSnapshotFingerprint) {
                    throw new HostReviewRecordUnavailableError("member");
                }
                const result = await core.acceptImportBatch({
                    previewSnapshot: snapshot,
                    decisions: request.params.decisions.map((decision) => ({
                        candidateId: decision.candidateId,
                        freshness:
                            decision.freshness.freshnessAction === "require_current_source"
                                ? { freshnessAction: "require_current_source" as const }
                                : {
                                      freshnessAction: "accept_preview_snapshot" as const,
                                      userActionId: decision.freshness.userActionId,
                                  },
                        promotion:
                            decision.promotion.promotionAction === "import_only"
                                ? {
                                      promotionAction: "import_only" as const,
                                      userActionId: decision.promotion.userActionId,
                                  }
                                : {
                                      promotionAction: decision.promotion.promotionAction,
                                      target: toCorePromotionTarget(decision.promotion.target),
                                      userActionId: decision.promotion.userActionId,
                                  },
                        callableBindings: decision.callableBindings.map((binding) =>
                            "targetAssetVersionId" in binding
                                ? {
                                      subject: { ...binding.subject },
                                      targetAssetVersionId: uuid(binding.targetAssetVersionId),
                                  }
                                : {
                                      subject: { ...binding.subject },
                                      targetCandidateId: binding.targetCandidateId,
                                  },
                        ),
                        ...(decision.action === "create_asset"
                            ? { action: "create_asset" as const }
                            : {
                                  action: "create_version" as const,
                                  assetId: uuid(decision.assetId),
                                  parentVersionId: uuid(decision.parentVersionId),
                              }),
                    })),
                });
                if (result.status !== "failed") context.reviews.acceptPreview(request.params.previewToken);
                return projectCoreOutcome(result, projectBatchImport);
            }
            case "project_lifecycle.inspect": {
                const input = (() => {
                    switch (request.params.action) {
                        case "rename":
                            return {
                                action: request.params.action,
                                projectId: uuid(request.params.projectId),
                                nextDisplayName: request.params.nextDisplayName,
                            };
                        case "rebind": {
                            const nextRootPath = context.pathSelections.consume(
                                request.params.localPathSelectionToken,
                                "project_root",
                            );
                            if (nextRootPath === null) throw new HostPathSelectionUnavailableError();
                            return {
                                action: request.params.action,
                                projectId: uuid(request.params.projectId),
                                nextRootPath,
                            };
                        }
                        case "restore":
                            return {
                                action: request.params.action,
                                projectId: uuid(request.params.projectId),
                            };
                        case "stop_managing":
                            return {
                                action: request.params.action,
                                projectId: uuid(request.params.projectId),
                            };
                    }
                })();
                return projectCoreOutcome(core.inspectProjectLifecycle(input), (preparation) => {
                    const projectLifecycleReviewToken = context.reviews.recordProjectLifecycle(context.connectionId, preparation);
                    return projectProjectLifecycleReview(projectLifecycleReviewToken, preparation);
                });
            }
            case "project_lifecycle.commit": {
                const preparation = context.reviews.resolveProjectLifecycle(request.params.projectLifecycleReviewToken);
                const result = core.commitProjectLifecycle({
                    preparation,
                    userActionId: request.params.userActionId,
                });
                if (result.status !== "failed") {
                    context.reviews.acceptProjectLifecycle(request.params.projectLifecycleReviewToken);
                }
                return projectCoreOutcome(result, projectProject);
            }
            case "asset_usage.analyze": {
                const resolved = context.reviews.resolveProbeTarget(
                    request.params.probeToken,
                    request.params.probeResultRowId,
                    request.params.targetRowId,
                );
                const expectedTargetKind = request.params.subject.subjectKind;
                if (resolved.targetKind !== "directory" && resolved.targetKind !== expectedTargetKind) {
                    throw new TypeError("Asset usage subject does not match the selected probe target");
                }
                const coreInput = {
                    projectId: request.params.subject.subjectKind === "global" ? "" : request.params.subject.projectId,
                    consumerAgentRuntimeIds: agentRuntimeIds(request.params.consumerAgentRuntimeIds),
                    platform: resolved.result.observation.platformContext.platform,
                    platformInstanceId: resolved.result.observation.platformContext.platformInstanceId,
                    targetRootPath: resolved.targetRootPath,
                    currentProbeResults: resolved.currentProbeResults,
                    asset: {
                        assetId: uuid(request.params.asset.assetId),
                        versionId: uuid(request.params.asset.versionId),
                        allowIncomplete: request.params.asset.allowIncomplete,
                    },
                } as const;
                return projectCoreOutcome(await core.analyzeAssetUsage(coreInput), (value) =>
                    projectAssetUsage(value, {
                        assetId: coreInput.asset.assetId,
                        versionId: coreInput.asset.versionId,
                        agentRuntimeIds: coreInput.consumerAgentRuntimeIds,
                    }),
                );
            }
            case "deployment.render_preview": {
                const selectionRequest = toCoreRenderSelection(request.params.selection);
                const approvalResolutions = context.renderApprovals.createResolutions(selectionRequest);
                return projectCoreOutcome(
                    await context.renderApprovals.runWithResolutions(selectionRequest, approvalResolutions, () =>
                        core.previewDeploymentRender({
                            deploymentId: uuid(request.params.deploymentId),
                            selectionRequest,
                        }),
                    ),
                    (preview) =>
                        context.reviews.recordRenderPreview(
                            context.connectionId,
                            request.params.deploymentId,
                            selectionRequest,
                            preview,
                            approvalResolutions,
                        ),
                );
            }
            case "deployment.deploy": {
                const reviewed = context.reviews.resolveRenderPreview(request.params.previewToken);
                const base = {
                    deploymentId: uuid(reviewed.deploymentId),
                    selectionRequest: structuredClone(reviewed.selectionRequest),
                    expectedPreviewFingerprint: reviewed.preview.previewFingerprint,
                };
                const result = await context.renderApprovals.runWithResolutions(
                    reviewed.selectionRequest,
                    reviewed.approvalResolutions,
                    () =>
                        core.deployDeployment(
                            request.params.deploymentAction === "apply"
                                ? { ...base, deploymentAction: "apply" }
                                : request.params.deploymentAction === "replace_unmanaged"
                                  ? {
                                        ...base,
                                        deploymentAction: "replace_unmanaged",
                                        userActionId: request.params.userActionId,
                                    }
                                  : {
                                        ...base,
                                        deploymentAction: "overwrite_runtime",
                                        userActionId: request.params.userActionId,
                                    },
                        ),
                );
                if (result.status !== "failed") {
                    context.reviews.acceptRenderPreview(request.params.previewToken);
                }
                return projectCoreOutcome(result, projectDeployment);
            }
            case "deployment.inspect_rendered_target": {
                const outcome = projectCoreOutcome(
                    await core.inspectDeploymentRenderedTarget(uuid(request.params.deploymentId)),
                    (result) => context.reviews.recordInspection(context.connectionId, request.params.deploymentId, result),
                );
                return outcome;
            }
            case "deployment.repair": {
                context.reviews.resolveInspection(
                    request.params.inspectionToken,
                    request.params.deploymentId,
                    request.params.expectedInspectionResultFingerprint,
                );
                const result = await core.repairDeployment({
                    deploymentId: uuid(request.params.deploymentId),
                    expectedInspectionResultFingerprint: toCoreSha256(request.params.expectedInspectionResultFingerprint),
                    userActionId: request.params.userActionId,
                });
                if (result.status !== "failed") context.reviews.acceptInspection(request.params.inspectionToken);
                return projectCoreOutcome(result, projectDeployment);
            }
            case "reverse_accept.prepare": {
                context.reviews.resolveInspection(
                    request.params.inspectionToken,
                    request.params.deploymentId,
                    request.params.inspectionResultFingerprint,
                );
                const result = await core.prepareRenderedTargetAccept({
                    deploymentId: uuid(request.params.deploymentId),
                    inspectionResultFingerprint: toCoreSha256(request.params.inspectionResultFingerprint),
                });
                if (result.status !== "failed") context.reviews.acceptInspection(request.params.inspectionToken);
                return projectCoreOutcomeWithFailedValue(result, (preparation) =>
                    preparation.preparationState === "not_prepared"
                        ? preparation
                        : {
                              ...preparation,
                              renderAnalysis: projectRenderAnalysis(request.params.deploymentId, preparation.renderAnalysis),
                          },
                );
            }
        }
    } catch (error) {
        if (error instanceof HostPathSelectionUnavailableError) return hostPathSelectionFailure();
        if (error instanceof HostReviewRecordUnavailableError) return hostReviewFailure(error.failureKind);
        if (error instanceof HostReviewRecordCapacityError) return hostReviewCapacityFailure();
        return hostInvocationFailure();
    }
}

export function isH2ImmediateOperation(operation: ProtocolOperationName): operation is ImmediateH2Operation {
    return HOST_H2_IMMEDIATE_OPERATIONS.includes(operation as ImmediateH2Operation);
}
