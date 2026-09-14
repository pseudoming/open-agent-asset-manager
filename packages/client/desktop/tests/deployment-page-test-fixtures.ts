import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { type ComponentProps, createElement, useState } from "react";
import { vi } from "vitest";
import type { WorkbenchRoute } from "../src/renderer/app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { WorkspacePage } from "../src/renderer/pages/WorkspacePage";
import { fakeDiscoveryClient, ENVIRONMENT, PROVIDERS } from "./discovery-test-fixtures";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ASSET_ID = "22222222-2222-4222-8222-222222222222";
export const VERSION_ID = "33333333-3333-4333-8333-333333333333";
export const PROJECT = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/workspace/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
export const PROJECT_ASSET = {
    assetId: ASSET_ID,
    kind: "Guidance" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Current Project guidance",
    currentVersionId: VERSION_ID,
    currentRevision: 1,
    currentFingerprint: "b".repeat(64),
    currentVersionStatus: "complete" as const,
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
export const GLOBAL_ASSET = {
    ...PROJECT_ASSET,
    assetId: "55555555-5555-4555-8555-555555555555",
    currentVersionId: "66666666-6666-4666-8666-666666666666",
    scope: "global" as const,
    projectId: undefined,
    displayName: "Global guidance",
};
export const ONE_ENABLED_PROVIDER = {
    configVersion: 1 as const,
    settingId: "adapter_enablement_v1" as const,
    revision: 1,
    enabledAdapterIds: ["CLAUDECODE"],
    userActionEvidenceId: "provider-fixture",
    updatedAt: 1,
    settingFingerprint: "a".repeat(64),
};

export function missingInstallationProbe() {
    return {
        probeToken: "missing-installation-probe",
        results: [
            {
                rowId: "missing-installation-result",
                adapterId: "CLAUDECODE",
                environment: ENVIRONMENT,
                status: "complete" as const,
                runtimes: [
                    {
                        rowId: "missing-installation-runtime",
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        versionText: "",
                        installationStatus: "not_found" as const,
                        projectDiscoveryStatus: "complete" as const,
                        sourceRootRowIds: [],
                        diagnostics: [],
                    },
                ],
                sources: [],
                projects: [],
                targets: [],
                diagnostics: [],
            },
        ],
    };
}

export function importedSourceDeploymentClient(sourcePath: string): DesktopApplicationClientApi {
    return deploymentClient({
        getProject: vi.fn(async () => ({
            status: "complete" as const,
            value: { found: true as const, value: { ...PROJECT, rootPath: sourcePath } },
            diagnostics: [],
        })),
        listAdapterProviders: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                providers: [
                    {
                        adapterId: "ANTIGRAVITY",
                        displayName: "Antigravity",
                        version: "2.4.3",
                        enabled: true,
                        agentRuntimes: [
                            {
                                agentRuntimeId: "ANTIGRAVITY_IDE",
                                displayName: "Antigravity IDE",
                                entryClass: "ide" as const,
                            },
                        ],
                        sourceCapabilities: [],
                        targetCapabilities: [],
                    },
                ],
            },
            diagnostics: [],
        })),
        getAdapterEnablement: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                configVersion: 1 as const,
                settingId: "adapter_enablement_v1" as const,
                revision: 1,
                enabledAdapterIds: ["ANTIGRAVITY"],
                userActionEvidenceId: "source-navigation",
                updatedAt: 1,
                settingFingerprint: "a".repeat(64),
            },
            diagnostics: [],
        })),
        getWatchedScanIntent: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                configVersion: 1 as const,
                settingId: "watched_scan_intent_v1" as const,
                revision: 1,
                environments: [
                    {
                        environment: ENVIRONMENT,
                        sourceSelectors: [
                            {
                                disposition: "included" as const,
                                source: {
                                    adapterId: "ANTIGRAVITY",
                                    rootRole: "project_actual" as const,
                                    sourceDomain: "project_root" as const,
                                    canonicalPath: sourcePath,
                                    locatorIdentities: [
                                        {
                                            locatorKind: "runtime_known_rule" as const,
                                            locatorKey: "demo-plugin",
                                        },
                                    ],
                                },
                                agentRuntimeIds: ["ANTIGRAVITY_IDE"],
                                binding: { assetScope: "project" as const, projectId: PROJECT_ID },
                                selectorFingerprint: "b".repeat(64),
                            },
                        ],
                    },
                ],
                userActionEvidenceId: "source-navigation",
                updatedAt: 1,
                settingFingerprint: "c".repeat(64),
            },
            diagnostics: [],
        })),
        getAssetVersion: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                found: true as const,
                value: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    revision: 1,
                    status: "complete" as const,
                    versionCanonicalContentFingerprint: "a".repeat(64),
                    files: [],
                    importSource: {
                        adapterId: "ANTIGRAVITY",
                        sourceSnapshotFingerprint: "b".repeat(64),
                        roots: [
                            {
                                sourceRootId: "root-1",
                                rootRole: "project_actual" as const,
                                sourceDomain: "project_root" as const,
                                canonicalPath: sourcePath,
                            },
                        ],
                        files: [
                            {
                                sourceRootId: "root-1",
                                relativePath: "AGENTS.md",
                                contentHash: "c".repeat(64),
                            },
                        ],
                    },
                    createdAt: 1,
                },
            },
            diagnostics: [],
        })),
    });
}

export function deploymentClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    const availableOperations: ProtocolOperationName[] = [
        "adapter.probe",
        "asset_usage.analyze",
        "project.get",
        "project.list",
        "project.register",
        "asset.list",
        "asset.get",
        "asset_version.get",
        "deployment.list",
        "watched_scan_intent.get",
    ];
    return {
        ...fakeDiscoveryClient({
            listAdapterProviders: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    providers: PROVIDERS.map((provider) => ({
                        ...provider,
                        targetCapabilities: provider.agentRuntimes.map((runtime) => ({
                            agentRuntimeId: runtime.agentRuntimeId,
                            assetKind: "Guidance" as const,
                            entrySupportStatus: "supported" as const,
                            renderStrategy: "native_file" as const,
                            reverseExtractPolicy: "can_reconcile" as const,
                            diagnostics: [],
                        })),
                    })),
                },
                diagnostics: [],
            })),
            listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [PROJECT] }, diagnostics: [] })),
            listAssets: vi.fn(async () => ({
                status: "complete",
                value: { assets: [PROJECT_ASSET] },
                diagnostics: [],
            })),
            getProject: vi.fn(async () => ({
                status: "complete",
                value: { found: true as const, value: PROJECT },
                diagnostics: [],
            })),
            getAdapterEnablement: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    configVersion: 1 as const,
                    settingId: "adapter_enablement_v1" as const,
                    revision: 2,
                    enabledAdapterIds: ["CLAUDECODE", "OPENCODE"],
                    userActionEvidenceId: "target-fixture",
                    updatedAt: 2,
                    settingFingerprint: "c".repeat(64),
                },
                diagnostics: [],
            })),
            getAssetVersion: vi.fn(async ({ assetId, versionId }) => ({
                status: "complete" as const,
                value: {
                    found: true as const,
                    value: {
                        assetId,
                        versionId,
                        revision: 1,
                        status: "complete" as const,
                        versionCanonicalContentFingerprint: "b".repeat(64),
                        files: [],
                        createdAt: 1,
                    },
                },
                diagnostics: [],
            })),
        }),
        availableOperations,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => availableOperations.includes(operation)),
        analyzeAssetUsage: vi.fn(async (params) => ({
            status: "complete" as const,
            value: {
                schemaVersion: 2 as const,
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
        ...overrides,
    };
}

type WorkspacePageHarnessProps = Omit<
    ComponentProps<typeof WorkspacePage>,
    "route" | "sidebarVisible" | "inspectorVisible" | "onNavigate" | "onReplaceRoute" | "onInspectorVisibleChange"
> & { readonly onNavigateReceipt?: (route: WorkbenchRoute) => void };

export function WorkspacePageHarness(props: WorkspacePageHarnessProps): React.JSX.Element {
    const [route, setRoute] = useState<Exclude<WorkbenchRoute, { readonly surface: "settings" }>>({
        surface: "library",
        subject: "projects",
    });
    return createElement(WorkspacePage, {
        ...props,
        route,
        sidebarVisible: true,
        inspectorVisible: false,
        onNavigate: (nextRoute) => {
            props.onNavigateReceipt?.(nextRoute);
            if (nextRoute.surface !== "settings") setRoute(nextRoute);
        },
        onReplaceRoute: (nextRoute) => {
            if (nextRoute.surface !== "settings") setRoute(nextRoute);
        },
        onInspectorVisibleChange: vi.fn(),
    });
}
