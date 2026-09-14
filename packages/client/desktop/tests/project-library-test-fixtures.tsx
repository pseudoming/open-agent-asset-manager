import type { ProtocolInvalidationV1, ProtocolOperationName } from "@oaam/app-server-protocol";
import { fireEvent, screen, within } from "@testing-library/react";
import { type ComponentProps, createElement, useState } from "react";
import { vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import type { WorkbenchLibraryRoute } from "../src/renderer/app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { ProjectLibraryWorkspace } from "../src/renderer/features/project-library";
import { createDesktopPresentationTestBridge } from "./desktop-presentation-test-harness";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const ASSET_ID = "22222222-2222-4222-8222-222222222222";
export const VERSION_ID = "33333333-3333-4333-8333-333333333333";
export const SECOND_PROJECT_ID = "77777777-7777-4777-8777-777777777777";
export const SECOND_ASSET_ID = "88888888-8888-4888-8888-888888888888";
export const SECOND_VERSION_ID = "99999999-9999-4999-8999-999999999999";
export const DIGEST = "a".repeat(64);

export function expandProjectLibraryKind(kind: string, occurrence = 0): void {
    const tree = screen.getByRole("navigation", { name: "Asset library" });
    const button = within(tree).getAllByRole("button", { name: new RegExp(`^${kind}`, "u") })[occurrence];
    if (button === undefined) throw new Error(`expected ${kind} tree route`);
    fireEvent.click(button);
}

export const PROJECT = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/work/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
export const ASSET = {
    assetId: ASSET_ID,
    kind: "Guidance" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Rules for this Project",
    currentVersionId: VERSION_ID,
    currentRevision: 2,
    currentFingerprint: DIGEST,
    currentVersionStatus: "complete" as const,
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
export const GLOBAL_ASSET = {
    ...ASSET,
    assetId: "44444444-4444-4444-8444-444444444444",
    currentVersionId: "55555555-5555-4555-8555-555555555555",
    scope: "global" as const,
    projectId: undefined,
    displayName: "Global guidance",
};
export const SECOND_PROJECT = {
    ...PROJECT,
    projectId: SECOND_PROJECT_ID,
    displayName: "Second project",
    rootPath: "/work/second-project",
};
export const SECOND_ASSET = {
    ...ASSET,
    assetId: SECOND_ASSET_ID,
    projectId: SECOND_PROJECT_ID,
    currentVersionId: SECOND_VERSION_ID,
    displayName: "Second Project guidance",
};

export function fakeClient(projects = [PROJECT], assets = [ASSET, GLOBAL_ASSET]) {
    const invalidationListeners = new Set<(value: ProtocolInvalidationV1) => void>();
    const availableOperations: ProtocolOperationName[] = [
        "adapter_provider.list",
        "project.list",
        "project.register",
        "asset.list",
        "asset.get",
        "asset_version.get",
        "asset_library.kind_counts",
        "asset_library.page",
        "asset_version.list",
        "asset_version.file_children",
        "asset_version.file_preview",
        "asset_version.text_page",
        "watched_scan_intent.get",
        "adapter.probe",
        "deployment.list",
    ];
    const client = {
        availableOperations,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => availableOperations.includes(operation)),
        listAdapterProviders: vi.fn(async () => ({
            status: "complete",
            value: {
                providers: [
                    {
                        adapterId: "CLAUDECODE",
                        displayName: "Claude Code",
                        version: "1.0.0",
                        enabled: true,
                        agentRuntimes: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                displayName: "Claude Code CLI",
                                entryClass: "cli",
                            },
                        ],
                        sourceCapabilities: [],
                        targetCapabilities: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                assetKind: "Guidance",
                                entrySupportStatus: "supported",
                                renderStrategy: "native_file",
                                reverseExtractPolicy: "can_reconcile",
                                diagnostics: [],
                            },
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                assetKind: "Rule",
                                entrySupportStatus: "supported",
                                renderStrategy: "native_file",
                                reverseExtractPolicy: "can_reconcile",
                                diagnostics: [],
                            },
                        ],
                    },
                ],
            },
            diagnostics: [],
        })),
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects }, diagnostics: [] })),
        registerProject: vi.fn(async () => ({ status: "complete", value: PROJECT, diagnostics: [] })),
        listAssets: vi.fn(async () => ({ status: "complete", value: { assets }, diagnostics: [] })),
        listAssetKindCounts: vi.fn(
            async ({
                subject,
                keywords,
                includeDeleted = false,
            }: {
                subject: { scope: "global" } | { scope: "project"; projectId: string };
                keywords: string;
                includeDeleted?: boolean;
            }) => {
                const query = keywords.trim().toLocaleLowerCase("en-US");
                const matching = assets.filter(
                    (asset) =>
                        (subject.scope === "global"
                            ? asset.scope === "global"
                            : asset.scope === "project" && asset.projectId === subject.projectId) &&
                        (includeDeleted || !asset.deleted) &&
                        (query === "" ||
                            asset.displayName.toLocaleLowerCase("en-US").includes(query) ||
                            asset.displayDescription.toLocaleLowerCase("en-US").includes(query)),
                );
                return {
                    status: "complete",
                    value: {
                        counts: ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"].map((kind) => ({
                            kind,
                            count: matching.filter((asset) => asset.kind === kind).length,
                        })),
                    },
                    diagnostics: [],
                };
            },
        ),
        queryAssetLibrary: vi.fn(
            async ({
                subject,
                kind,
                keywords,
                includeDeleted = false,
                pageSize = 50,
                cursor,
            }: {
                subject: { scope: "global" } | { scope: "project"; projectId: string };
                kind: typeof ASSET.kind;
                keywords: string;
                includeDeleted?: boolean;
                pageSize?: number;
                cursor?: string;
            }) => {
                const query = keywords.trim().toLocaleLowerCase("en-US");
                const matching = assets
                    .filter(
                        (asset) =>
                            asset.kind === kind &&
                            (subject.scope === "global"
                                ? asset.scope === "global"
                                : asset.scope === "project" && asset.projectId === subject.projectId) &&
                            (includeDeleted || !asset.deleted) &&
                            (query === "" ||
                                asset.displayName.toLocaleLowerCase("en-US").includes(query) ||
                                asset.displayDescription.toLocaleLowerCase("en-US").includes(query)),
                    )
                    .sort((left, right) => left.displayName.localeCompare(right.displayName, "en-US"));
                const offset = cursor === undefined ? 0 : Number(cursor);
                const page = matching.slice(offset, offset + pageSize);
                const nextOffset = offset + page.length;
                return {
                    status: "complete",
                    value:
                        nextOffset < matching.length
                            ? {
                                  assets: page,
                                  totalCount: matching.length,
                                  hasMore: true,
                                  nextCursor: String(nextOffset),
                              }
                            : { assets: page, totalCount: matching.length, hasMore: false },
                    diagnostics: [],
                };
            },
        ),
        getAsset: vi.fn(async ({ assetId }: { assetId: string }) => {
            const selectedAsset = assets.find((asset) => asset.assetId === assetId) ?? GLOBAL_ASSET;
            return {
                status: "complete",
                value: {
                    found: true,
                    value: {
                        ...selectedAsset,
                        versionIds: [selectedAsset.currentVersionId],
                    },
                },
                diagnostics: [],
            };
        }),
        getAssetVersion: vi.fn(async ({ assetId, versionId }: { assetId: string; versionId: string }) => ({
            status: "complete",
            value: {
                found: true,
                value: {
                    assetId,
                    versionId,
                    revision: 2,
                    status: "complete",
                    versionCanonicalContentFingerprint: DIGEST,
                    files: [
                        {
                            fileId: "66666666-6666-4666-8666-666666666666",
                            logicalPath: "AGENTS.md",
                            role: "entry",
                            mediaType: "text/markdown",
                            contentKind: "text",
                            contentHash: DIGEST,
                            byteLength: 12,
                            executable: false,
                        },
                    ],
                    createdAt: 2,
                },
            },
            diagnostics: [],
        })),
        listAssetVersions: vi.fn(async ({ assetId }: { assetId: string }) => {
            const selectedAsset = assets.find((asset) => asset.assetId === assetId) ?? GLOBAL_ASSET;
            return {
                status: "complete",
                value: {
                    found: true,
                    value: {
                        versions: [
                            {
                                assetId,
                                versionId: selectedAsset.currentVersionId,
                                revision: selectedAsset.currentRevision,
                                status: selectedAsset.currentVersionStatus,
                                fingerprint: selectedAsset.currentFingerprint,
                                originAuthorityFingerprint: selectedAsset.currentFingerprint,
                                versionCanonicalContentFingerprint: selectedAsset.currentFingerprint,
                                changeKind: "create",
                                sourceVersionId: "",
                                sourceDeploymentId: "",
                                changeNote: "",
                                fileCount: 1,
                                createdAt: 2,
                            },
                        ],
                        totalCount: 1,
                        hasMore: false,
                    },
                },
                diagnostics: [],
            };
        }),
        listAssetVersionFileChildren: vi.fn(async ({ directoryPath }: { directoryPath: string }) => ({
            status: "complete",
            value: {
                found: true,
                value: {
                    entries:
                        directoryPath === ""
                            ? [
                                  {
                                      entryKind: "file",
                                      relativeName: "AGENTS.md",
                                      file: {
                                          fileId: "66666666-6666-4666-8666-666666666666",
                                          logicalPath: "AGENTS.md",
                                          role: "entry",
                                          mediaType: "text/markdown",
                                          contentKind: "text",
                                          contentHash: DIGEST,
                                          byteLength: 12,
                                          executable: false,
                                      },
                                  },
                              ]
                            : [],
                    totalCount: directoryPath === "" ? 1 : 0,
                    hasMore: false,
                },
            },
            diagnostics: [],
        })),
        readAssetVersionFilePreview: vi.fn(async () => ({
            status: "complete",
            value: {
                found: true,
                value: {
                    previewKind: "text",
                    file: {
                        fileId: "66666666-6666-4666-8666-666666666666",
                        logicalPath: "AGENTS.md",
                        role: "entry",
                        mediaType: "text/markdown",
                        contentKind: "text",
                        contentHash: DIGEST,
                        byteLength: 12,
                        executable: false,
                    },
                    text: "# Guidance\n",
                    lineCount: 2,
                },
            },
            diagnostics: [],
        })),
        readAssetVersionTextPage: vi.fn(async () => {
            throw new Error("small text preview must not request progressive text");
        }),
        getWatchedScanIntent: vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 0,
                environments: [],
                updatedAt: 0,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        })),
        listDeployments: vi.fn(async () => ({
            status: "complete",
            value: { deployments: [] },
            diagnostics: [],
        })),
        subscribeInvalidation: vi.fn((listener: (value: ProtocolInvalidationV1) => void) => {
            invalidationListeners.add(listener);
            return () => {
                invalidationListeners.delete(listener);
            };
        }),
        inspectStateBackup: vi.fn(async () => {
            throw new Error("unexpected State backup inspection");
        }),
    } as unknown as DesktopApplicationClientApi;
    return {
        client,
        invalidate: (value: ProtocolInvalidationV1) => {
            for (const listener of invalidationListeners) listener(value);
        },
    };
}

export function completedBridge(lastSelectedProjectId?: string): OaamDesktopBridge {
    let snapshot = createDesktopPresentationSnapshot(
        {
            ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
            onboardingCompleted: true,
            ...(lastSelectedProjectId === undefined ? {} : { lastSelectedProjectId }),
        },
        ["en-US"],
        false,
    );
    return {
        ...createDesktopPresentationTestBridge(snapshot),
        rememberLastProject: vi.fn(async (projectId: string) => {
            snapshot = createDesktopPresentationSnapshot(
                { ...snapshot.preferences, lastSelectedProjectId: projectId },
                ["en-US"],
                false,
            );
            return snapshot;
        }),
        replaceAssetLayout: vi.fn(async (assetLayout) => {
            snapshot = createDesktopPresentationSnapshot({ ...snapshot.preferences, assetLayout }, ["en-US"], false);
            return snapshot;
        }),
        replacePresentationPreferences: vi.fn(async (input) => {
            snapshot = createDesktopPresentationSnapshot({ ...snapshot.preferences, ...input }, ["en-US"], false);
            return snapshot;
        }),
    };
}

type ProjectLibraryTestHarnessProps = Omit<
    ComponentProps<typeof ProjectLibraryWorkspace>,
    | "route"
    | "sidebarVisible"
    | "inspectorVisible"
    | "onNavigate"
    | "onReplaceRoute"
    | "onInspectorVisibleChange"
    | "onOpenGuidedImport"
    | "onOpenSources"
    | "onOpenSearch"
> & {
    readonly onOpenGuidedImport?: () => void;
    readonly onOpenSources?: () => void;
    readonly onOpenSearch?: () => void;
    readonly initialRoute?: WorkbenchLibraryRoute;
};

export function ProjectLibraryTestHarness(props: ProjectLibraryTestHarnessProps): React.JSX.Element {
    const { initialRoute, ...workspaceProps } = props;
    const [route, setRoute] = useState<WorkbenchLibraryRoute>(initialRoute ?? { surface: "library", subject: "projects" });
    const [inspectorVisible, setInspectorVisible] = useState(false);
    return createElement(ProjectLibraryWorkspace, {
        ...workspaceProps,
        route,
        sidebarVisible: true,
        inspectorVisible,
        onOpenGuidedImport: props.onOpenGuidedImport ?? vi.fn(),
        onOpenSources: props.onOpenSources ?? vi.fn(),
        onOpenSearch: props.onOpenSearch ?? vi.fn(),
        onNavigate: (nextRoute) => {
            if (nextRoute.surface === "library") setRoute(nextRoute);
        },
        onReplaceRoute: (nextRoute) => {
            if (nextRoute.surface === "library") setRoute((current) => (current === route ? nextRoute : current));
        },
        onInspectorVisibleChange: setInspectorVisible,
    });
}

export function CrossProjectHistoryRestoreHarness(props: ProjectLibraryTestHarnessProps): React.JSX.Element {
    const [route, setRoute] = useState<WorkbenchLibraryRoute>({
        surface: "library",
        subject: "projects",
        projectId: PROJECT_ID,
    });
    return createElement(
        "section",
        null,
        createElement(
            "button",
            {
                type: "button",
                onClick: () =>
                    setRoute({
                        surface: "library",
                        subject: "projects",
                        projectId: SECOND_PROJECT_ID,
                        assetId: SECOND_ASSET_ID,
                    }),
            },
            "Restore second Project Asset",
        ),
        createElement(ProjectLibraryWorkspace, {
            ...props,
            route,
            sidebarVisible: true,
            inspectorVisible: true,
            onOpenSearch: props.onOpenSearch ?? vi.fn(),
            onNavigate: (nextRoute) => {
                if (nextRoute.surface === "library") setRoute(nextRoute);
            },
            onReplaceRoute: (nextRoute) => {
                if (nextRoute.surface === "library") setRoute(nextRoute);
            },
            onInspectorVisibleChange: vi.fn(),
        }),
    );
}
