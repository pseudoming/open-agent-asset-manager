/** Workspace view-state fixtures for applied, failed and managed-use continuations. */
import { vi } from "vitest";
import type {
    CatalogDeploymentController,
    CatalogDeploymentState,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import type { DeploymentView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { ASSET, PROJECT, VERSION_ID } from "./catalog-deployment-test-support";
const PROJECT_ID = PROJECT.projectId;
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
export function currentDeployment(): DeploymentView {
    return {
        deploymentId: DEPLOYMENT_ID,
        subject: { subjectKind: "project", projectId: PROJECT_ID },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        environment: { platform: "linux", platformInstanceId: "local" },
        targetRootPath: "/workspace/oaam",
        stage: "in_sync",
        reason: "in_sync",
        actionHints: ["check_now"],
        freshness: { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
        deleted: false,
        assets: [{ assetId: ASSET.assetId, versionId: VERSION_ID, allowIncomplete: false }],
        createdAt: 1,
        updatedAt: 2,
    };
}

export function readyState(
    overrides: Partial<Extract<CatalogDeploymentState, { readonly status: "ready" }>> = {},
): Extract<CatalogDeploymentState, { readonly status: "ready" }> {
    return {
        status: "ready",
        projects: [],
        assets: [],
        deployments: [],
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

export function stateController(state: CatalogDeploymentState): CatalogDeploymentController {
    return {
        state,
        subscribe: vi.fn((listener: (next: CatalogDeploymentState) => void) => {
            listener(state);
            return () => undefined;
        }),
        dispose: vi.fn(),
        load: vi.fn(async () => undefined),
        analyzeAssetUsage: vi.fn(async () => undefined),
        selectAsset: vi.fn(async () => undefined),
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
