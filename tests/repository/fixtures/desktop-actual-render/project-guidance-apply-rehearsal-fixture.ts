import type { ProtocolDiagnosticV1, ProtocolInvalidationV1, ProtocolOperationName } from "@oaam/app-server-protocol";
import { ClientTransportError } from "@oaam/client-framework";
import {
    type ProjectGuidanceApplySubject,
    PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS,
    type ProjectGuidanceSemanticSelection,
    projectGuidanceApplyScript,
    projectGuidanceAuthorizeScript,
    projectGuidanceCreateReviewScript,
    projectGuidancePreviewScript,
    projectGuidanceRelationshipScript,
} from "../../../../packages/client/desktop/src/main/project-guidance-apply-ui-script";
import { projectGuidanceVisualStageScript } from "../../../../packages/client/desktop/src/main/project-guidance-apply-visual-proof";
import type {
    DesktopApplicationClientApi,
    DesktopLongOperationListener,
} from "../../../../packages/client/desktop/src/renderer/client";
import {
    type AssetSummaryView,
    deploymentTargetSemanticKey,
    type DeploymentView,
    type PromotionGrantView,
    type RenderAnalysisView,
    type RenderPreviewView,
} from "../../../../packages/client/desktop/src/renderer/features/catalog-deployment/catalog-deployment-model";
import { ACTUAL_RENDER_PROJECT_ROOT } from "../desktop-actual-render-registered-project";

export const PROJECT_GUIDANCE_APPLY_REHEARSAL_OPERATIONS: readonly ProtocolOperationName[] = Object.freeze([
    "asset.get",
    "asset_version.get",
    "asset_version.list",
    "asset_version.file_children",
    "asset_version.file_preview",
    "deployment.create",
    "deployment.render_analyze",
    "deployment.render_preview",
    "deployment.deploy",
    "promotion_grant.create",
]);

export const PROJECT_GUIDANCE_APPLY_REHEARSAL_VARIANTS = Object.freeze([
    "happy",
    "probe_failed",
    "target_missing",
    "target_ambiguous",
    "version_unavailable",
    "target_key_mismatch",
    "grant_failed",
    "semantic_missing",
    "semantic_extra",
    "semantic_duplicate",
    "semantic_wrong_subject",
    "preview_failed",
    "preview_wrong_path",
    "preview_multiple_files",
    "deploy_failed",
    "deploy_recovery",
    "deploy_stale",
] as const);

export type ProjectGuidanceApplyRehearsalVariant = (typeof PROJECT_GUIDANCE_APPLY_REHEARSAL_VARIANTS)[number];

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const GRANT_ID = "66666666-6666-4666-8666-666666666666";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const PROBE_TOKEN = "actual-render-project-guidance-probe";
const PROBE_ROW_ID = "actual-render-project-guidance-result";
const TARGET_ROW_ID = "actual-render-project-guidance-target";
const TARGET_CANDIDATE_ID = "actual-render-project-guidance-candidate";
const ENVIRONMENT = Object.freeze({ platform: "wsl" as const, platformInstanceId: "Ubuntu" });
const EXPECTED_TARGET_KEY = deploymentTargetSemanticKey(
    "CLAUDECODE",
    ENVIRONMENT.platform,
    ENVIRONMENT.platformInstanceId,
    TARGET_CANDIDATE_ID,
);

const ASSET: AssetSummaryView = Object.freeze({
    assetId: ASSET_ID,
    kind: "Guidance",
    scope: "project",
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guide map",
    displayDescription: "Portable Project instructions",
    currentVersionId: VERSION_ID,
    currentRevision: 1,
    currentFingerprint: DIGEST_A,
    currentVersionStatus: "complete",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

function deployment(stage: DeploymentView["stage"], complete = false): DeploymentView {
    return Object.freeze({
        deploymentId: DEPLOYMENT_ID,
        subject: Object.freeze({ subjectKind: "project" as const, projectId: PROJECT_ID }),
        consumerAgentRuntimeIds: Object.freeze(["CLAUDE_CODE_CLI"]),
        environment: ENVIRONMENT,
        targetRootPath: ACTUAL_RENDER_PROJECT_ROOT,
        stage,
        reason: stage,
        actionHints: Object.freeze(complete ? ["check_now" as const] : ["review_deployment" as const]),
        freshness: complete
            ? Object.freeze({ state: "complete" as const, attemptedAt: 4, lastCompleteAt: 4 })
            : Object.freeze({ state: "never" as const, attemptedAt: 0, lastCompleteAt: 0 }),
        deleted: false,
        assets: Object.freeze([Object.freeze({ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false })]),
        createdAt: 2,
        updatedAt: complete ? 4 : 2,
    });
}

interface ProjectGuidanceProductionRenderReceipt {
    readonly schemaVersion: 1;
    readonly required: RenderAnalysisView;
    readonly authorized: RenderAnalysisView;
    readonly preview: RenderPreviewView;
    readonly semanticClosure: readonly ProjectGuidanceSemanticSelection[];
    readonly native: {
        readonly relativePath: string;
        readonly contentSha256: string;
        readonly byteSize: number;
        readonly semanticRefFingerprints: readonly string[];
    };
}

const GRANT: PromotionGrantView = Object.freeze({
    schemaVersion: 1,
    promotionGrantId: GRANT_ID,
    subject: Object.freeze({ subjectKind: "asset_version" as const, assetId: ASSET_ID, versionId: VERSION_ID }),
    target: Object.freeze({ targetKind: "project" as const, projectId: PROJECT_ID }),
    grantState: "active",
    revision: 1,
    userActionEvidenceId: "actual-render-project-guidance-grant",
    updatedAt: 3,
    grantFingerprint: DIGEST_B,
});

function failureDiagnostic(operation: ProtocolDiagnosticV1["operation"], code: string): ProtocolDiagnosticV1 {
    return Object.freeze({
        severity: "error",
        code,
        operation,
        causeKind: "verification_failed",
        retryable: true,
        suggestedActions: Object.freeze(["retry"]),
        message: `Actual-render fixture failure: ${code}`,
    });
}

function delay(milliseconds = 60): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(name: string): void {
    const key = `oaamProjectGuidance${name}`;
    document.documentElement.dataset[key] = String(Number.parseInt(document.documentElement.dataset[key] ?? "0", 10) + 1);
}

function emitLong<TName extends "deployment.render_analyze" | "deployment.render_preview" | "deployment.deploy">(
    operation: TName,
    listener?: DesktopLongOperationListener<TName>,
): void {
    listener?.({ status: "accepted", operation, operationId: `actual-render-${operation}` });
    listener?.({
        status: "progress",
        operation,
        operationId: `actual-render-${operation}`,
        sequence: 1,
        progress: { stage: `fixture.${operation}`, completedUnits: 1, totalUnits: 2 },
    } as Parameters<NonNullable<typeof listener>>[0]);
}

function probeReview(variant: ProjectGuidanceApplyRehearsalVariant) {
    const target = Object.freeze({
        rowId: TARGET_ROW_ID,
        targetCandidateId: variant === "target_key_mismatch" ? `${TARGET_CANDIDATE_ID}-mismatch` : TARGET_CANDIDATE_ID,
        targetKind: "project" as const,
        displayName: "Open Agent Asset Manager",
        displayPath: ACTUAL_RENDER_PROJECT_ROOT,
        entryApplicabilities: Object.freeze([
            Object.freeze({ agentRuntimeId: "CLAUDE_CODE_CLI", status: "ready_for_plan" as const, diagnostics: [] }),
            Object.freeze({ agentRuntimeId: "CLAUDE_CODE_APP", status: "unknown" as const, diagnostics: [] }),
        ]),
        diagnostics: Object.freeze([]),
    });
    const targets =
        variant === "target_missing"
            ? Object.freeze([])
            : variant === "target_ambiguous"
              ? Object.freeze([target, Object.freeze({ ...target, rowId: `${TARGET_ROW_ID}-duplicate` })])
              : Object.freeze([target]);
    return Object.freeze({
        probeToken: PROBE_TOKEN,
        results: Object.freeze([
            Object.freeze({
                rowId: PROBE_ROW_ID,
                adapterId: "CLAUDECODE",
                environment: ENVIRONMENT,
                status: "partial" as const,
                runtimes: Object.freeze([
                    Object.freeze({
                        rowId: "actual-render-claude-cli",
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        versionText: variant === "version_unavailable" ? "" : "2.1.220",
                        installationStatus: "available" as const,
                        projectDiscoveryStatus: "complete" as const,
                        sourceRootRowIds: Object.freeze([]),
                        diagnostics: Object.freeze([]),
                    }),
                    Object.freeze({
                        rowId: "actual-render-claude-app",
                        agentRuntimeId: "CLAUDE_CODE_APP",
                        versionText: "",
                        installationStatus: "not_found" as const,
                        projectDiscoveryStatus: "unknown" as const,
                        sourceRootRowIds: Object.freeze([]),
                        diagnostics: Object.freeze([]),
                    }),
                ]),
                sources: Object.freeze([]),
                projects: Object.freeze([]),
                targets,
                diagnostics: Object.freeze([]),
            }),
        ]),
    });
}

function authorizedAnalysisForVariant(
    receipt: ProjectGuidanceProductionRenderReceipt,
    variant: ProjectGuidanceApplyRehearsalVariant,
): RenderAnalysisView {
    if (variant === "semantic_missing") {
        const missing = receipt.semanticClosure.at(-1);
        return Object.freeze({
            ...receipt.authorized,
            semantics: Object.freeze(
                receipt.authorized.semantics.filter(
                    (semantic) => semantic.semanticRefFingerprint !== missing?.semanticRefFingerprint,
                ),
            ),
            options: Object.freeze(
                receipt.authorized.options.filter((option) => option.semanticRefFingerprint !== missing?.semanticRefFingerprint),
            ),
        });
    }
    const firstSemantic = receipt.authorized.semantics[0];
    const firstOption = receipt.authorized.options[0];
    if (firstSemantic === undefined || firstOption === undefined) {
        throw new Error("Project Guidance production receipt has no semantic closure");
    }
    if (variant === "semantic_extra") {
        return Object.freeze({
            ...receipt.authorized,
            semantics: Object.freeze([
                ...receipt.authorized.semantics,
                Object.freeze({ ...firstSemantic, semanticKind: "rule.content" as const, semanticRefFingerprint: DIGEST_C }),
            ]),
            options: Object.freeze([
                ...receipt.authorized.options,
                Object.freeze({ ...firstOption, semanticRefFingerprint: DIGEST_C, optionFingerprint: DIGEST_D }),
            ]),
        });
    }
    if (variant === "semantic_duplicate") {
        return Object.freeze({
            ...receipt.authorized,
            semantics: Object.freeze([
                ...receipt.authorized.semantics,
                Object.freeze({ ...firstSemantic, semanticRefFingerprint: DIGEST_C }),
            ]),
            options: Object.freeze([
                ...receipt.authorized.options,
                Object.freeze({ ...firstOption, semanticRefFingerprint: DIGEST_C, optionFingerprint: DIGEST_D }),
            ]),
        });
    }
    if (variant === "semantic_wrong_subject") {
        return Object.freeze({
            ...receipt.authorized,
            semantics: Object.freeze([
                Object.freeze({
                    ...firstSemantic,
                    subject: Object.freeze({ ...firstSemantic.subject, assetId: GRANT_ID, versionId: GRANT_ID }),
                }),
                ...receipt.authorized.semantics.slice(1),
            ]),
        });
    }
    return receipt.authorized;
}

function previewForVariant(
    receipt: ProjectGuidanceProductionRenderReceipt,
    variant: ProjectGuidanceApplyRehearsalVariant,
): RenderPreviewView {
    const file = receipt.preview.files[0];
    if (file === undefined) throw new Error("Project Guidance production receipt has no native preview file");
    if (variant === "preview_wrong_path") {
        return Object.freeze({
            ...receipt.preview,
            files: Object.freeze([Object.freeze({ ...file, relativePath: "sibling.md" })]),
        });
    }
    if (variant === "preview_multiple_files") {
        return Object.freeze({
            ...receipt.preview,
            files: Object.freeze([
                file,
                Object.freeze({ ...file, relativePath: "sibling.md", desired: Object.freeze({ ...file.desired }) }),
            ]),
        });
    }
    return receipt.preview;
}

export function createProjectGuidanceApplyRehearsalFixtureClient(
    variant: ProjectGuidanceApplyRehearsalVariant,
    observedTargetState: "absent",
    productionReceipt: ProjectGuidanceProductionRenderReceipt,
): Readonly<Partial<DesktopApplicationClientApi>> {
    let analysisCount = 0;
    let managedState: "none" | "configured" | "applied" = "none";
    let invalidationListener: ((invalidation: ProtocolInvalidationV1) => void) | undefined;
    return Object.freeze({
        async listProjects() {
            return {
                status: "complete" as const,
                value: {
                    projects: [
                        {
                            projectId: PROJECT_ID,
                            displayName: "Open Agent Asset Manager",
                            rootPath: ACTUAL_RENDER_PROJECT_ROOT,
                            deleted: false,
                            createdAt: 1,
                            updatedAt: 2,
                        },
                    ],
                },
                diagnostics: [],
            };
        },
        async getProject(input) {
            await delay();
            return {
                status: "complete" as const,
                value:
                    input.projectId === PROJECT_ID
                        ? {
                              found: true as const,
                              value: {
                                  projectId: PROJECT_ID,
                                  displayName: "Open Agent Asset Manager",
                                  rootPath: ACTUAL_RENDER_PROJECT_ROOT,
                                  deleted: false,
                                  createdAt: 1,
                                  updatedAt: 2,
                              },
                          }
                        : { found: false as const },
                diagnostics: [],
            };
        },
        async listAssets() {
            return { status: "complete" as const, value: { assets: [ASSET] }, diagnostics: [] };
        },
        async listDeployments() {
            return { status: "complete" as const, value: { deployments: [] }, diagnostics: [] };
        },
        async listAdapterProviders() {
            return {
                status: "complete" as const,
                value: {
                    providers: [
                        {
                            adapterId: "CLAUDECODE",
                            displayName: "Claude Code",
                            version: "1.0.0",
                            enabled: true,
                            agentRuntimes: [
                                { agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "Claude Code CLI", entryClass: "cli" as const },
                                { agentRuntimeId: "CLAUDE_CODE_APP", displayName: "Claude Code App", entryClass: "app" as const },
                            ],
                            sourceCapabilities: [],
                            targetCapabilities: [
                                {
                                    agentRuntimeId: "CLAUDE_CODE_CLI",
                                    assetKind: "Guidance" as const,
                                    scope: "project" as const,
                                    support: "supported" as const,
                                    targetMode: "native" as const,
                                    diagnostics: [],
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            };
        },
        async getAdapterEnablement() {
            return {
                status: "complete" as const,
                value: {
                    configVersion: 1 as const,
                    settingId: "adapter_enablement_v1" as const,
                    revision: 1,
                    enabledAdapterIds: ["CLAUDECODE"],
                    userActionEvidenceId: "actual-render-project-guidance-enablement",
                    updatedAt: 1,
                    settingFingerprint: DIGEST_A,
                },
                diagnostics: [],
            };
        },
        async getWatchedScanIntent() {
            return {
                status: "complete" as const,
                value: {
                    configVersion: 1 as const,
                    settingId: "watched_scan_intent_v1" as const,
                    revision: 0,
                    environments: [],
                    updatedAt: 0,
                    settingFingerprint: DIGEST_A,
                },
                diagnostics: [],
            };
        },
        async listEnvironments() {
            return {
                status: "complete" as const,
                value: {
                    environments: [
                        {
                            environment: { platform: "win32" as const, platformInstanceId: "desktop-local" },
                            displayName: "Local Windows",
                        },
                        { environment: ENVIRONMENT, displayName: "WSL — Ubuntu" },
                    ],
                },
                diagnostics: [],
            };
        },
        async probeProject() {
            record("ProbeCount");
            await delay(90);
            if (variant === "probe_failed") {
                return {
                    status: "failed" as const,
                    diagnostics: [failureDiagnostic("probe", "fixture.probe_failed")],
                };
            }
            return {
                status: "partial" as const,
                value: probeReview(variant),
                diagnostics: [
                    Object.freeze({
                        severity: "warning" as const,
                        code: "fixture.app_unavailable",
                        operation: "probe" as const,
                        causeKind: "unavailable" as const,
                        retryable: false,
                        suggestedActions: Object.freeze([]),
                        message: "Claude Code App is not installed; Claude Code CLI remains available.",
                    }),
                ],
            };
        },
        async analyzeAssetUsage(input) {
            record("AssetUsageCount");
            await delay();
            return {
                status: "complete" as const,
                operationId: "actual-render-asset-usage",
                value: {
                    schemaVersion: 2 as const,
                    assetId: input.asset.assetId,
                    versionId: input.asset.versionId,
                    relationships: input.consumerAgentRuntimeIds.map((agentRuntimeId) => ({
                        agentRuntimeId,
                        capability: "direct" as const,
                        observedTargetState: managedState === "applied" ? ("already_usable" as const) : observedTargetState,
                        managedState,
                        substitute: null,
                        deploymentIds: managedState === "none" ? [] : [DEPLOYMENT_ID],
                        appliedDeploymentIds: managedState === "applied" ? [DEPLOYMENT_ID] : [],
                        degradationKinds: [],
                        reasonCodes: ["actual_render_project_guidance_direct"],
                        requiresReview: false,
                    })),
                },
                diagnostics: [],
            };
        },
        async createDeployment(input) {
            record("CreateCount");
            await delay();
            if (
                input.subject.subjectKind !== "project" ||
                input.subject.projectId !== PROJECT_ID ||
                input.consumerAgentRuntimeIds.length !== 1 ||
                input.consumerAgentRuntimeIds[0] !== "CLAUDE_CODE_CLI" ||
                input.assets.length !== 1 ||
                input.assets[0]?.assetId !== ASSET_ID ||
                input.assets[0].versionId !== VERSION_ID
            ) {
                return {
                    status: "failed" as const,
                    diagnostics: [failureDiagnostic("deploy", "fixture.create_identity_mismatch")],
                };
            }
            managedState = "configured";
            return { status: "complete" as const, value: deployment("in_sync"), diagnostics: [] };
        },
        async createPromotionGrant() {
            record("GrantCreateCount");
            await delay();
            return variant === "grant_failed"
                ? {
                      status: "failed" as const,
                      diagnostics: [failureDiagnostic("settings", "fixture.grant_failed")],
                  }
                : { status: "complete" as const, value: GRANT, diagnostics: [] };
        },
        async analyzeDeployment(_input, listener) {
            analysisCount += 1;
            record("AnalyzeCount");
            emitLong("deployment.render_analyze", listener);
            await delay(analysisCount === 2 ? 100 : 60);
            return {
                status: "complete" as const,
                value:
                    analysisCount === 1 ? productionReceipt.required : authorizedAnalysisForVariant(productionReceipt, variant),
                diagnostics: [],
            };
        },
        async previewDeployment(input, listener) {
            record("PreviewCount");
            emitLong("deployment.render_preview", listener);
            await delay(90);
            const actualOptionFingerprints = input.selection.semanticOptions
                .map((selection) => selection.optionFingerprint)
                .sort();
            const expectedOptionFingerprints = productionReceipt.semanticClosure
                .map((selection) => selection.optionFingerprint)
                .sort();
            if (JSON.stringify(actualOptionFingerprints) !== JSON.stringify(expectedOptionFingerprints)) {
                return {
                    status: "failed" as const,
                    diagnostics: [failureDiagnostic("render", "fixture.preview_semantic_selection_incomplete")],
                };
            }
            return variant === "preview_failed"
                ? {
                      status: "failed" as const,
                      diagnostics: [failureDiagnostic("render", "fixture.preview_failed")],
                  }
                : { status: "complete" as const, value: previewForVariant(productionReceipt, variant), diagnostics: [] };
        },
        async deploy(_input, listener) {
            record("DeployCount");
            emitLong("deployment.deploy", listener);
            await delay(90);
            record("DeployTerminalCount");
            if (variant === "deploy_failed") {
                return {
                    status: "failed" as const,
                    diagnostics: [failureDiagnostic("deploy", "fixture.deploy_failed")],
                };
            }
            if (variant === "deploy_recovery") {
                throw new ClientTransportError(
                    "uncertain",
                    "deployment.deploy",
                    "actual-render-deploy-uncertain",
                    "fixture outcome requires reconciliation",
                    new Error("fixture transport closed"),
                );
            }
            if (variant === "deploy_stale") {
                setTimeout(() => invalidationListener?.({ resourceKind: "deployment", deploymentId: DEPLOYMENT_ID }), 0);
                return { status: "complete" as const, value: deployment("blocked"), diagnostics: [] };
            }
            managedState = "applied";
            return { status: "complete" as const, value: deployment("in_sync", true), diagnostics: [] };
        },
        subscribeInvalidation(listener) {
            invalidationListener = listener;
            return () => {
                invalidationListener = undefined;
            };
        },
    });
}

interface ProjectGuidanceApplyScriptRequest {
    readonly stage:
        | "relationship"
        | "create_review"
        | "authorize"
        | "preview"
        | "apply"
        | "visual_relationship"
        | "visual_authorization"
        | "visual_preview"
        | "visual_applied";
    readonly terminalDeadlineAtMillisecondsSinceEpoch: number;
    readonly targetKey?: string;
    readonly deploymentId?: string;
    readonly desiredSha256?: string;
    readonly semanticSelections?: readonly ProjectGuidanceSemanticSelection[];
}

export function installProjectGuidanceApplyRehearsalScriptBridge(
    variant: ProjectGuidanceApplyRehearsalVariant,
    productionReceipt: ProjectGuidanceProductionRenderReceipt,
): void {
    const baseSubject = Object.freeze({
        projectId: PROJECT_ID,
        rootPath: ACTUAL_RENDER_PROJECT_ROOT,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        sourceSha256: DIGEST_A,
        environment: ENVIRONMENT,
        environmentKey: `wsl\0${ENVIRONMENT.platformInstanceId}`,
    });
    const bridge = Object.freeze({
        metadata: Object.freeze({
            variant,
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            expectedTargetKey: EXPECTED_TARGET_KEY,
            desiredSha256: productionReceipt.native.contentSha256,
            semanticClosure: productionReceipt.semanticClosure,
        }),
        build(request: ProjectGuidanceApplyScriptRequest): string {
            const subject: ProjectGuidanceApplySubject = Object.freeze({
                ...baseSubject,
                terminalDeadlineAtMillisecondsSinceEpoch: request.terminalDeadlineAtMillisecondsSinceEpoch,
            });
            if (request.stage === "relationship") return projectGuidanceRelationshipScript(subject);
            if (request.targetKey === undefined) throw new Error("project Guidance rehearsal targetKey is required");
            if (request.stage === "visual_relationship") {
                return projectGuidanceVisualStageScript({
                    stage: "relationship",
                    subject,
                    targetKey: request.targetKey,
                    deploymentId: "",
                    semanticSelections: [],
                    desiredSha256: "",
                });
            }
            if (request.stage === "create_review") return projectGuidanceCreateReviewScript(subject, request.targetKey);
            if (request.deploymentId === undefined) throw new Error("project Guidance rehearsal deploymentId is required");
            if (request.stage === "authorize") {
                return projectGuidanceAuthorizeScript(subject, request.targetKey, request.deploymentId);
            }
            if (request.stage === "visual_authorization") {
                return projectGuidanceVisualStageScript({
                    stage: "authorization",
                    subject,
                    targetKey: request.targetKey,
                    deploymentId: request.deploymentId,
                    semanticSelections: [],
                    desiredSha256: "",
                });
            }
            if (request.stage === "preview") {
                if (request.semanticSelections === undefined) {
                    throw new Error("project Guidance rehearsal semantic selections are required");
                }
                return projectGuidancePreviewScript(subject, request.targetKey, request.deploymentId, request.semanticSelections);
            }
            if (request.desiredSha256 === undefined || request.semanticSelections === undefined) {
                throw new Error("project Guidance rehearsal desiredSha256 and semantic selections are required");
            }
            if (request.stage === "visual_preview" || request.stage === "visual_applied") {
                return projectGuidanceVisualStageScript({
                    stage: request.stage === "visual_preview" ? "preview" : "applied",
                    subject,
                    targetKey: request.targetKey,
                    deploymentId: request.deploymentId,
                    semanticSelections: request.semanticSelections,
                    desiredSha256: request.desiredSha256,
                });
            }
            return projectGuidanceApplyScript(
                subject,
                request.targetKey,
                request.deploymentId,
                request.desiredSha256,
                request.semanticSelections,
            );
        },
    });
    (
        globalThis as typeof globalThis & { __oaamProjectGuidanceApplyRehearsal?: typeof bridge }
    ).__oaamProjectGuidanceApplyRehearsal = bridge;
}

export function createProjectGuidanceApplyRehearsalHarnessFixture(
    parameters: URLSearchParams,
    scenario: string,
): Readonly<{
    operations: readonly ProtocolOperationName[];
    client: Partial<DesktopApplicationClientApi>;
    installScriptBridge(): void;
}> {
    const enabled = scenario === "project_guidance_apply_rehearsal";
    if (!enabled) {
        return Object.freeze({
            operations: Object.freeze([]),
            client: Object.freeze({}),
            installScriptBridge() {},
        });
    }
    const value = parameters.get("variant") ?? "happy";
    const observedTargetState = parameters.get("targetObservation");
    if (!PROJECT_GUIDANCE_APPLY_REHEARSAL_VARIANTS.includes(value as ProjectGuidanceApplyRehearsalVariant)) {
        throw new Error(`Unsupported Project Guidance apply rehearsal variant ${value}`);
    }
    if (observedTargetState !== "absent") {
        throw new Error("Project Guidance apply rehearsal requires one owner-observed absent target");
    }
    const productionReceipt = parseProductionRenderReceipt(parameters.get("productionRenderReceipt"));
    const variant = value as ProjectGuidanceApplyRehearsalVariant;
    return Object.freeze({
        operations: PROJECT_GUIDANCE_APPLY_REHEARSAL_OPERATIONS,
        client: createProjectGuidanceApplyRehearsalFixtureClient(variant, observedTargetState, productionReceipt),
        installScriptBridge() {
            installProjectGuidanceApplyRehearsalScriptBridge(variant, productionReceipt);
        },
    });
}

function parseProductionRenderReceipt(raw: string | null): ProjectGuidanceProductionRenderReceipt {
    if (raw === null) throw new Error("Project Guidance apply rehearsal requires one production render receipt");
    const parsed = JSON.parse(raw) as Partial<ProjectGuidanceProductionRenderReceipt>;
    for (const [state, analysis] of [
        ["required", parsed.required],
        ["authorized", parsed.authorized],
    ] as const) {
        const inspection = analysis?.promotionAuthorizationInspections[0];
        if (
            analysis?.deploymentId !== DEPLOYMENT_ID ||
            analysis.promotionAuthorizationInspections.length !== 1 ||
            inspection?.promotionAuthorizationState !== state ||
            inspection.assetId !== ASSET_ID ||
            inspection.versionId !== VERSION_ID ||
            inspection.target.targetKind !== "project" ||
            inspection.target.projectId !== PROJECT_ID
        ) {
            throw new Error(`Project Guidance ${state} analysis is not the exact Core/Host projection`);
        }
    }
    if (
        parsed.schemaVersion !== 1 ||
        parsed.preview?.deploymentId !== DEPLOYMENT_ID ||
        parsed.preview.files.length !== 1 ||
        parsed.preview.files[0]?.relativePath !== "CLAUDE.md" ||
        parsed.native?.relativePath !== "CLAUDE.md"
    ) {
        throw new Error("Project Guidance production preview is not one exact CLAUDE.md");
    }
    const closure = parsed.semanticClosure;
    if (
        !Array.isArray(closure) ||
        JSON.stringify(closure.map((selection) => selection.semanticKind)) !==
            JSON.stringify(PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS) ||
        new Set(closure.map((selection) => selection.semanticRefFingerprint)).size !== closure.length ||
        new Set(closure.map((selection) => selection.optionFingerprint)).size !== closure.length ||
        closure.some(
            (selection) =>
                !/^[0-9a-f]{64}$/u.test(selection.semanticRefFingerprint) || !/^[0-9a-f]{64}$/u.test(selection.optionFingerprint),
        ) ||
        JSON.stringify([...parsed.native.semanticRefFingerprints].sort()) !==
            JSON.stringify(closure.map((selection) => selection.semanticRefFingerprint).sort())
    ) {
        throw new Error("Project Guidance production receipt lacks exact semantic closure");
    }
    const previewFile = parsed.preview.files[0];
    if (
        previewFile?.desired.state !== "present" ||
        previewFile.desired.contentHash !== parsed.native.contentSha256 ||
        previewFile.desired.byteSize !== parsed.native.byteSize
    ) {
        throw new Error("Project Guidance production native bytes do not match the preview");
    }
    return Object.freeze({
        schemaVersion: 1,
        required: parsed.required as RenderAnalysisView,
        authorized: parsed.authorized as RenderAnalysisView,
        preview: parsed.preview as RenderPreviewView,
        semanticClosure: Object.freeze(closure),
        native: Object.freeze(parsed.native),
    });
}
