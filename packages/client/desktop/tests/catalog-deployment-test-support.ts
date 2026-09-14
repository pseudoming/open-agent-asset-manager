import type {
    ProtocolDiagnosticV1,
    ProtocolInvalidationV1,
    ProtocolOperationParams,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import { vi } from "vitest";
import type { DesktopApplicationClientApi, DesktopLongOperationListener } from "../src/renderer/client";
import {
    CatalogDeploymentController,
    type CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import {
    deploymentTargetSemanticKey,
    type AssetSummaryView,
    type AssetVersionView,
    type AssetView,
    type DeploymentView,
    type DeploymentTargetView,
    type DeploymentToolObservationView,
    type PromotionGrantView,
    type ProjectView,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import {
    COMMITTED_REVERSE,
    INSPECTION,
    INSPECTION_DETAIL,
    PREPARED_REVERSE,
    RENDER_ANALYSIS,
    RENDER_PREVIEW,
} from "./catalog-deployment-test-fixtures";

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ASSET_ID = "22222222-2222-4222-8222-222222222222";
export const VERSION_ID = "33333333-3333-4333-8333-333333333333";
export const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
export const PROMOTION_GRANT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const NEEDS_REPAIR_DEPLOYMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const PROJECT: ProjectView = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/workspace/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

export const ASSET: AssetSummaryView = {
    assetId: ASSET_ID,
    kind: "Guidance",
    scope: "project",
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Current project guidance",
    currentVersionId: VERSION_ID,
    currentRevision: 2,
    currentFingerprint: SHA_A,
    currentVersionStatus: "complete",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

export const INCOMPLETE_ASSET: AssetSummaryView = {
    ...ASSET,
    assetId: "55555555-5555-4555-8555-555555555555",
    currentVersionId: "66666666-6666-4666-8666-666666666666",
    displayName: "Incomplete workflow",
    kind: "Workflow",
    currentVersionStatus: "incomplete",
};

export const ASSET_DETAIL: AssetView = {
    assetId: ASSET_ID,
    kind: "Guidance",
    scope: "project",
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Current project guidance",
    versionIds: [VERSION_ID],
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

export const VERSION: AssetVersionView = {
    assetId: ASSET_ID,
    versionId: VERSION_ID,
    revision: 2,
    status: "complete",
    versionCanonicalContentFingerprint: SHA_A,
    files: [
        {
            fileId: "77777777-7777-4777-8777-777777777777",
            logicalPath: "AGENTS.md",
            role: "entry",
            mediaType: "text/markdown",
            contentKind: "text",
            contentHash: SHA_B,
            byteLength: 12,
            executable: false,
        },
    ],
    createdAt: 2,
};

export const PROMOTION_GRANT: PromotionGrantView = {
    schemaVersion: 1,
    promotionGrantId: PROMOTION_GRANT_ID,
    subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
    target: { targetKind: "project", projectId: PROJECT_ID },
    grantState: "active",
    revision: 1,
    userActionEvidenceId: "user-action",
    updatedAt: 3,
    grantFingerprint: SHA_B,
};

export function completeAssetUsage(
    params: ProtocolOperationParams<"asset_usage.analyze">,
): Extract<ProtocolOperationTerminal<"asset_usage.analyze">, { readonly status: "complete" }> {
    return {
        status: "complete",
        value: {
            schemaVersion: 2,
            assetId: params.asset.assetId,
            versionId: params.asset.versionId,
            relationships: params.consumerAgentRuntimeIds.map((agentRuntimeId) => ({
                agentRuntimeId,
                capability: "direct",
                observedTargetState: "absent",
                managedState: "none",
                substitute: null,
                deploymentIds: [],
                appliedDeploymentIds: [],
                degradationKinds: [],
                reasonCodes: ["test_direct"],
                diagnostics: [],
                requiresReview: false,
            })),
        },
        diagnostics: [],
    };
}

export function deployment(stage: DeploymentView["stage"] = "in_sync", firstDeployment = false): DeploymentView {
    const actionHints: DeploymentView["actionHints"] =
        stage === "deleted"
            ? []
            : stage === "blocked"
              ? ["recover"]
              : stage === "conflict"
                ? ["review_external_changes", "check_now"]
                : stage === "needs_repair"
                  ? ["review_repair", "check_now"]
                  : firstDeployment
                    ? ["review_deployment"]
                    : ["check_now"];
    return {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project", projectId: PROJECT_ID },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        environment: { platform: "linux", platformInstanceId: "local" },
        targetRootPath: "/workspace/oaam",
        stage,
        reason: stage,
        actionHints,
        freshness: firstDeployment
            ? { state: "never", attemptedAt: 0, lastCompleteAt: 0 }
            : { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
        deleted: stage === "deleted",
        assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        createdAt: 1,
        updatedAt: 2,
    };
}

export function diagnostic(message: string, severity: "info" | "warning" | "error" = "error"): ProtocolDiagnosticV1 {
    return {
        severity,
        code: "desktop.test",
        operation: "deploy",
        causeKind: "conflict",
        retryable: true,
        suggestedActions: ["retry"],
        message,
    };
}

export function emitLong<
    TName extends
        | "deployment.render_analyze"
        | "deployment.render_preview"
        | "deployment.deploy"
        | "deployment.scan"
        | "deployment.inspect_rendered_target"
        | "deployment.repair"
        | "deployment.recover",
>(operation: TName, listener?: DesktopLongOperationListener<TName>): void {
    listener?.({ status: "accepted", operation, operationId: `${operation}-1` });
    listener?.({
        status: "progress",
        operation,
        operationId: `${operation}-1`,
        sequence: 1,
        progress: { stage: operation, completedUnits: 1, totalUnits: 2 },
    } as Parameters<NonNullable<typeof listener>>[0]);
}

interface FakeCatalogClient {
    readonly client: DesktopApplicationClientApi;
    invalidate(invalidation: ProtocolInvalidationV1): void;
    unsubscribed(): boolean;
}

export function fakeCatalogClient(overrides: Partial<DesktopApplicationClientApi> = {}): FakeCatalogClient {
    let invalidationListener: ((invalidation: ProtocolInvalidationV1) => void) | undefined;
    let didUnsubscribe = false;
    const client = {
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [PROJECT] }, diagnostics: [] })),
        registerProject: vi.fn(async () => ({ status: "complete", value: PROJECT, diagnostics: [] })),
        listAssets: vi.fn(async () => ({ status: "complete", value: { assets: [ASSET] }, diagnostics: [] })),
        getAsset: vi.fn(async () => ({ status: "complete", value: { found: true, value: ASSET_DETAIL }, diagnostics: [] })),
        getAssetVersion: vi.fn(async () => ({ status: "complete", value: { found: true, value: VERSION }, diagnostics: [] })),
        supportsOperation: vi.fn(() => true),
        readAssetVersionFilePreview: vi.fn(async () => ({
            status: "complete",
            value: {
                found: true,
                value: {
                    previewKind: "text",
                    file: VERSION.files[0],
                    text: "# Project guidance\n",
                    lineCount: 2,
                },
            },
            diagnostics: [],
        })),
        listDeployments: vi.fn(async () => ({
            status: "complete",
            value: { deployments: [deployment("in_sync", true)] },
            diagnostics: [],
        })),
        listPromotionGrants: vi.fn(async () => ({
            status: "complete",
            value: { grants: [] },
            diagnostics: [],
        })),
        createPromotionGrant: vi.fn(async () => ({ status: "complete", value: PROMOTION_GRANT, diagnostics: [] })),
        analyzeAssetUsage: vi.fn(async (params) => ({
            status: "complete",
            value: {
                schemaVersion: 2,
                assetId: params.asset.assetId,
                versionId: params.asset.versionId,
                relationships: params.consumerAgentRuntimeIds.map((agentRuntimeId) => ({
                    agentRuntimeId,
                    capability: "direct" as const,
                    observedTargetState: "absent" as const,
                    managedState: "none" as const,
                    substitute: null,
                    deploymentIds: [],
                    appliedDeploymentIds: [],
                    degradationKinds: [],
                    reasonCodes: ["test_direct"],
                    diagnostics: [],
                    requiresReview: false,
                })),
            },
            diagnostics: [],
        })),
        createDeployment: vi.fn(async () => ({ status: "complete", value: deployment("blocked"), diagnostics: [] })),
        analyzeDeployment: vi.fn(async (_params, listener) => {
            emitLong("deployment.render_analyze", listener);
            return { status: "complete", value: RENDER_ANALYSIS, diagnostics: [] };
        }),
        previewDeployment: vi.fn(async (_params, listener) => {
            emitLong("deployment.render_preview", listener);
            return { status: "complete", value: RENDER_PREVIEW, diagnostics: [] };
        }),
        deploy: vi.fn(async (_params, listener) => {
            emitLong("deployment.deploy", listener);
            return { status: "complete", value: deployment("in_sync"), diagnostics: [] };
        }),
        scanDeployment: vi.fn(async (_params, listener) => {
            emitLong("deployment.scan", listener);
            return { status: "complete", value: deployment("conflict"), diagnostics: [] };
        }),
        inspectRenderedTarget: vi.fn(async (_params, listener) => {
            emitLong("deployment.inspect_rendered_target", listener);
            return { status: "complete", value: INSPECTION, diagnostics: [] };
        }),
        getRenderedInspectionDetail: vi.fn(async () => ({
            status: "complete",
            value: INSPECTION_DETAIL,
            diagnostics: [],
        })),
        repairDeployment: vi.fn(async (_params, listener) => {
            emitLong("deployment.repair", listener);
            return { status: "complete", value: deployment("in_sync"), diagnostics: [] };
        }),
        recoverDeployment: vi.fn(async (_params, listener) => {
            emitLong("deployment.recover", listener);
            return { status: "complete", value: deployment("blocked"), diagnostics: [] };
        }),
        prepareReverseAccept: vi.fn(async (_params, listener) => {
            emitLong("reverse_accept.prepare", listener);
            return { status: "complete", value: PREPARED_REVERSE, diagnostics: [] };
        }),
        commitReverseAccept: vi.fn(async (_params, listener) => {
            emitLong("reverse_accept.commit", listener);
            return { status: "complete", value: COMMITTED_REVERSE, diagnostics: [] };
        }),
        cancelReverseAccept: vi.fn(async (_params, listener) => {
            emitLong("reverse_accept.cancel", listener);
            return { status: "complete", value: {}, diagnostics: [] };
        }),
        subscribeInvalidation: vi.fn((listener) => {
            invalidationListener = listener;
            return () => {
                didUnsubscribe = true;
                invalidationListener = undefined;
            };
        }),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
    return {
        client,
        invalidate(invalidation) {
            invalidationListener?.(invalidation);
        },
        unsubscribed: () => didUnsubscribe,
    };
}

export function createController(client: DesktopApplicationClientApi): CatalogDeploymentController {
    return new CatalogDeploymentController(client, { createUserActionId: () => "user-action" });
}

export function readyState(
    overrides: Partial<Extract<CatalogDeploymentState, { readonly status: "ready" }>> = {},
): Extract<CatalogDeploymentState, { readonly status: "ready" }> {
    return {
        status: "ready",
        projects: [PROJECT],
        assets: [ASSET, INCOMPLETE_ASSET],
        deployments: [
            deployment("in_sync", true),
            { ...deployment("deleted"), deploymentId: "77777777-7777-4777-8777-777777777777" },
            { ...deployment("blocked"), deploymentId: "88888888-8888-4888-8888-888888888888" },
            { ...deployment("conflict"), deploymentId: "99999999-9999-4999-8999-999999999999" },
            { ...deployment("needs_repair"), deploymentId: NEEDS_REPAIR_DEPLOYMENT_ID },
            { ...deployment("in_sync"), deploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ],
        assetUsage: { status: "none" },
        assetDetail: { status: "none" },
        analysis: { status: "none" },
        preview: { status: "none" },
        inspection: { status: "none" },
        reverse: { status: "none" },
        activity: { status: "idle" },
        stale: false,
        requiresReconciliation: false,
        message: undefined,
        diagnostics: [],
        ...overrides,
    };
}

export const ABSENT_DIRECT_ASSET_USAGE: Extract<CatalogDeploymentState, { readonly status: "ready" }>["assetUsage"] = {
    status: "ready",
    requestKey: "fixture-usage",
    targets: [
        {
            targetKey: deploymentTargetSemanticKey("CLAUDECODE", "linux", "local", "target-candidate"),
            status: "ready",
            usage: {
                schemaVersion: 2,
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                relationships: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        capability: "direct",
                        observedTargetState: "absent",
                        managedState: "none",
                        substitute: null,
                        deploymentIds: [],
                        appliedDeploymentIds: [],
                        degradationKinds: [],
                        reasonCodes: ["project_guidance_preserved_native_file"],
                        diagnostics: [],
                        requiresReview: false,
                    },
                ],
            },
        },
    ],
};

export function fakeController(state: CatalogDeploymentState): CatalogDeploymentController {
    return {
        state,
        subscribe: vi.fn((listener: (next: CatalogDeploymentState) => void) => {
            listener(state);
            return () => undefined;
        }),
        dispose: vi.fn(),
        load: vi.fn(async () => undefined),
        analyzeAssetUsage: vi.fn(async () => undefined),
        refreshAssetUsageTargets: vi.fn(async () => undefined),
        selectAsset: vi.fn(async () => undefined),
        selectAssetFile: vi.fn(async () => undefined),
        loadMoreAssetText: vi.fn(async () => undefined),
        clearAssetSelection: vi.fn(),
        registerProject: vi.fn(async () => undefined),
        createDeployment: vi.fn(async () => undefined),
        authorizeCurrentVersionForProject: vi.fn(async () => undefined),
        analyze: vi.fn(async () => undefined),
        clearPreview: vi.fn(),
        preview: vi.fn(async () => undefined),
        deployPreview: vi.fn(async () => undefined),
        overwritePreview: vi.fn(async () => undefined),
        scan: vi.fn(async () => undefined),
        inspect: vi.fn(async () => undefined),
        loadInspectionDetail: vi.fn(async () => undefined),
        repair: vi.fn(async () => undefined),
        recover: vi.fn(async () => undefined),
        prepareReverse: vi.fn(async () => undefined),
        commitReverse: vi.fn(async () => undefined),
        cancelReverse: vi.fn(async () => undefined),
    } as unknown as CatalogDeploymentController;
}

export function readyObservations(targets: readonly DeploymentTargetView[]): readonly DeploymentToolObservationView[] {
    return targets.flatMap((target) => [
        ...target.readyAgentRuntimeIds.map((agentRuntimeId) => ({
            key: JSON.stringify([
                target.adapterId,
                target.platform,
                target.platformInstanceId,
                agentRuntimeId,
                target.targetCandidateId,
            ]),
            adapterId: target.adapterId,
            platform: target.platform,
            platformInstanceId: target.platformInstanceId,
            agentRuntimeId,
            versionText:
                target.runtimeIdentities.find((identity) => identity.agentRuntimeId === agentRuntimeId)?.versionText ?? "",
            state: "ready" as const,
            reasonCodes: [],
            diagnostics: [],
            checkedPaths: [target.displayPath],
            target,
        })),
        ...target.unavailableAgentRuntimeIds.map((agentRuntimeId) => ({
            key: JSON.stringify([
                target.adapterId,
                target.platform,
                target.platformInstanceId,
                agentRuntimeId,
                target.targetCandidateId,
            ]),
            adapterId: target.adapterId,
            platform: target.platform,
            platformInstanceId: target.platformInstanceId,
            agentRuntimeId,
            versionText: "",
            state: "unsupported" as const,
            reasonCodes: ["catalog.target.unsupported"],
            diagnostics: [],
            checkedPaths: [target.displayPath],
            target,
        })),
    ]);
}
