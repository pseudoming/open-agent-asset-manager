import type { ProtocolOperationName, ProtocolOperationResult } from "@oaam/app-server-protocol";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceImportFeedbackFixtureClient } from "../../../../tests/repository/fixtures/desktop-actual-render/source-import-feedback-fixture";
import type { WorkbenchRoute, WorkbenchSourcesRoute } from "../src/renderer/app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { SourceLibraryWorkspace } from "../src/renderer/features/source-library";
import {
    exerciseKeyboardResize,
    exercisePersistentInteractionSidebar,
    toggleInteractionDisclosure,
} from "./desktop-interaction-test-harness";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import { clickSemanticAction } from "./semantic-action-test-harness";

const OPERATIONS: readonly ProtocolOperationName[] = ["adapter_provider.list", "watched_scan_intent.get", "project.list"];
const ENVIRONMENT = { platform: "win32" as const, platformInstanceId: "desktop-local" };
const SOURCE_PATH = "C:\\Users\\person\\.claude";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

afterEach(cleanup);

type WatchedScanIntentValue = Extract<ProtocolOperationResult<"watched_scan_intent.get">, { readonly value: unknown }>["value"];
type WatchedEnvironment = WatchedScanIntentValue["environments"][number];

const LOCAL_ENVIRONMENT_INTENT: WatchedEnvironment = {
    environment: ENVIRONMENT,
    sourceSelectors: [
        {
            disposition: "included",
            source: {
                adapterId: "CLAUDECODE",
                rootRole: "source",
                sourceDomain: "family_shared",
                canonicalPath: SOURCE_PATH,
                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "claude-user-config" }],
            },
            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
            binding: { assetScope: "global" },
            selectorFingerprint: "a".repeat(64),
        },
        {
            disposition: "included",
            source: {
                adapterId: "OPENCODE",
                rootRole: "source",
                sourceDomain: "family_shared",
                canonicalPath: SOURCE_PATH,
                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "opencode-claude-compat" }],
            },
            agentRuntimeIds: ["OPENCODE_CLI"],
            binding: { assetScope: "project", projectId: PROJECT_ID },
            selectorFingerprint: "b".repeat(64),
        },
    ],
};

function wslEnvironment(distribution: string, fingerprintCharacter: string): WatchedEnvironment {
    return {
        environment: { platform: "wsl", platformInstanceId: distribution },
        sourceSelectors: [
            {
                disposition: "included",
                source: {
                    adapterId: "CLAUDECODE",
                    rootRole: "source",
                    sourceDomain: "family_shared",
                    canonicalPath: `/home/person/${distribution.toLocaleLowerCase("en-US")}/.claude`,
                    locatorIdentities: [
                        { locatorKind: "runtime_known_rule", locatorKey: `claude-${distribution.toLocaleLowerCase("en-US")}` },
                    ],
                },
                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                binding: { assetScope: "global" },
                selectorFingerprint: fingerprintCharacter.repeat(64),
            },
        ],
    };
}

function sourceClient(environments: readonly WatchedEnvironment[] = [LOCAL_ENVIRONMENT_INTENT]): DesktopApplicationClientApi {
    return {
        availableOperations: OPERATIONS,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => OPERATIONS.includes(operation)),
        listAdapterProviders: vi.fn(async () => ({
            status: "complete",
            value: {
                providers: [
                    { adapterId: "CLAUDECODE", displayName: "Claude Code", agentRuntimes: [], capabilities: [] },
                    { adapterId: "OPENCODE", displayName: "OpenCode", agentRuntimes: [], capabilities: [] },
                ],
            },
            diagnostics: [],
        })),
        getWatchedScanIntent: vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 1,
                environments,
                userActionEvidenceId: "action-1",
                updatedAt: 1,
                settingFingerprint: "c".repeat(64),
            },
            diagnostics: [],
        })),
        listProjects: vi.fn(async () => ({
            status: "complete",
            value: {
                projects: [
                    {
                        projectId: PROJECT_ID,
                        displayName: "OAAM",
                        rootPath: "C:\\work\\oaam",
                        deleted: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            diagnostics: [],
        })),
        subscribeInvalidation: vi.fn(() => vi.fn()),
    } as unknown as DesktopApplicationClientApi;
}

function SourceLibraryHarness({
    client,
    onLeave,
    onFindAssets,
    initialRoute,
    catalogWarningCount = 0,
    onOpenSettings = () => undefined,
}: {
    readonly client: DesktopApplicationClientApi;
    readonly onLeave: (route: WorkbenchRoute) => void;
    readonly onFindAssets: () => void;
    readonly initialRoute?: WorkbenchSourcesRoute;
    readonly catalogWarningCount?: number;
    readonly onOpenSettings?: () => void;
}): React.JSX.Element {
    const [route, setRoute] = useState<WorkbenchSourcesRoute>(initialRoute ?? { surface: "sources", selection: "all" });
    function navigate(nextRoute: WorkbenchRoute): void {
        if (nextRoute.surface === "sources") setRoute(nextRoute);
        else onLeave(nextRoute);
    }
    return createElement(SourceLibraryWorkspace, {
        client,
        catalogWarningCount,
        route,
        sidebarVisible: true,
        onNavigate: navigate,
        onReplaceRoute: navigate,
        onOpenGuidedImport: onFindAssets,
        onOpenLibrary: () => onLeave({ surface: "library", subject: "projects" }),
        onOpenSettings,
    });
}

describe("Asset search-location workspace", () => {
    it("renders the held source-fixture failure and restores the same selection through its visible retry", async () => {
        const base = sourceClient();
        const watched = await base.getWatchedScanIntent();
        if (watched.status === "failed") throw new Error("expected the source fixture intent");
        const onLeave = vi.fn();
        const onFindAssets = vi.fn();
        const responseFixture = createSourceImportFeedbackFixtureClient(true, watched.value);
        const client = { ...base, ...responseFixture };
        const { container } = renderWithPresentation(
            createElement(SourceLibraryHarness, {
                client,
                onLeave,
                onFindAssets,
                initialRoute: { surface: "sources", selection: "source", environment: ENVIRONMENT, canonicalPath: SOURCE_PATH },
            }),
        );
        try {
            await screen.findByRole("heading", { level: 2, name: ".claude" });
            document.documentElement.dataset.oaamFeedbackSourceRefresh = "hold";
            fireEvent.click(screen.getByRole("button", { name: "Refresh search locations" }));
            await screen.findByRole("heading", { name: "Loading asset search locations" });
            expect(document.documentElement.dataset.oaamFeedbackSourceRefresh).toBe("pending");
            expect(container.querySelector(".source-library-detail")).toBeNull();
            fireEvent(window, new Event("oaam-feedback-release-source"));
            await screen.findByRole("heading", { name: "Search locations are unavailable" });
            expect(container.querySelector("[data-oaam-route='sources']")?.getAttribute("data-oaam-state")).toBe("failed");
            expect(container.querySelector(".source-library-detail")).toBeNull();
            expect(container.textContent).toContain("Controlled actual-render response failure.");
            expect(ordinarySurfaceText(container)).not.toContain("Controlled actual-render response failure.");
            expect(ordinarySurfaceText(container)).not.toContain("Review the latest result before continuing.");
            expect(ordinarySurfaceText(container)).not.toContain("OAAM could not finish checking this item.");
            expect(container.querySelectorAll(".source-library-main .workbench-notice")).toHaveLength(0);
            expect(screen.getAllByText("OAAM could not load the saved search locations.")).toHaveLength(1);
            fireEvent.click(screen.getByRole("button", { name: "Retry" }));
            await screen.findByRole("heading", { level: 2, name: ".claude" });
            expect(screen.getByText(SOURCE_PATH)).not.toBeNull();
            expect(base.listAdapterProviders).toHaveBeenCalledTimes(3);
            expect(base.listProjects).toHaveBeenCalledTimes(3);
            expect(onLeave).not.toHaveBeenCalled();
            expect(onFindAssets).not.toHaveBeenCalled();
        } finally {
            delete document.documentElement.dataset.oaamFeedbackSourceRefresh;
        }
    });

    it("owns a separate location tree and never presents source identity as inferred Asset membership", async () => {
        const onLeave = vi.fn();
        const onFindAssets = vi.fn();
        const client = sourceClient();
        const { container } = renderWithPresentation(
            createElement(SourceLibraryHarness, { client, onLeave, onFindAssets }),
            createDesktopPresentationTestBridge(),
        );

        expect(await screen.findByRole("navigation", { name: "Asset search location navigation" })).not.toBeNull();
        exercisePersistentInteractionSidebar("features.source-library.source_library_workspace.006", container);
        exerciseKeyboardResize("features.source-library.source_library_workspace.011", container);
        expect(screen.queryByRole("navigation", { name: "Workspace view" })).toBeNull();
        expect(screen.queryByRole("navigation", { name: "Asset library" })).toBeNull();
        expect(screen.queryByRole("tablist", { name: "Library subject" })).toBeNull();
        expect(screen.getAllByText("This device").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Claude Code · OpenCode")).toHaveLength(1);
        expect(screen.getByText("Location")).not.toBeNull();
        expect(screen.getByText("Used by")).not.toBeNull();
        expect(screen.getByText("Import to")).not.toBeNull();
        const sourceSidebar = container.querySelector(".source-library-sidebar");
        const sourceSidebarContent = container.querySelector(".source-sidebar-content");
        const backToLibrary = screen.getByRole("button", { name: "Back to asset library" });
        const sourceSearch = screen.getByRole("searchbox", { name: "Search locations" });
        expect(sourceSidebar?.contains(backToLibrary)).toBe(true);
        expect(sourceSidebarContent?.firstElementChild).toBe(backToLibrary);
        expect(sourceSidebarContent?.contains(sourceSearch)).toBe(true);
        expect(ordinarySurfaceText(container)).not.toContain("CLAUDECODE");
        expect(ordinarySurfaceText(container)).not.toContain("family_shared");

        const sourceRow = screen
            .getAllByRole("button", { name: /\.claude/u })
            .find((button) => button.classList.contains("source-library-row"));
        if (sourceRow === undefined) throw new Error("expected the source workspace row");
        fireEvent.click(sourceRow);
        expect(await screen.findByRole("heading", { level: 2, name: ".claude" })).not.toBeNull();
        expect(screen.getByText(SOURCE_PATH)).not.toBeNull();
        expect(screen.getByText("Global asset library")).not.toBeNull();
        expect(screen.getByText("Project: OAAM")).not.toBeNull();
        toggleInteractionDisclosure("features.source-library.source_library_workspace.017", container);

        fireEvent.click(screen.getByRole("button", { name: "Collapse This device" }));
        expect(screen.queryByRole("button", { name: /\.claude/u })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Expand This device" }));
        expect(screen.getAllByRole("button", { name: /\.claude/u }).length).toBeGreaterThan(0);

        const environmentButton = container.querySelector<HTMLButtonElement>(".source-tree-environment");
        if (environmentButton === null) throw new Error("expected an Environment tree button");
        fireEvent.click(environmentButton);
        expect(await screen.findByRole("heading", { level: 1, name: "This device" })).not.toBeNull();

        const sourceTreeButton = container.querySelector<HTMLButtonElement>(".source-tree-location");
        if (sourceTreeButton === null) throw new Error("expected a source tree button");
        fireEvent.click(sourceTreeButton);
        expect(await screen.findByRole("heading", { level: 1, name: ".claude" })).not.toBeNull();

        fireEvent.click(container.querySelector<HTMLButtonElement>(".source-tree-root") as HTMLButtonElement);
        expect(await screen.findByRole("heading", { level: 1, name: "Asset search locations" })).not.toBeNull();

        fireEvent.change(screen.getByRole("searchbox", { name: "Search locations" }), {
            target: { value: "not-present" },
        });
        expect(await screen.findByRole("heading", { name: "No matching locations" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
        expect((await screen.findAllByText("Claude Code · OpenCode")).length).toBeGreaterThan(0);

        await clickSemanticAction("sources.guided_import.toolbar", "sources.start_guided_import", {
            expected: onFindAssets,
            expectedArgs: [],
            unrelated: [onLeave],
        });
        fireEvent.click(screen.getByRole("button", { name: "Refresh search locations" }));
        await vi.waitFor(() => expect(client.listAdapterProviders).toHaveBeenCalledTimes(2));
        await clickSemanticAction("sources.library.sidebar", "sources.open_library", {
            expected: onLeave,
            expectedArgs: [{ surface: "library", subject: "projects" }],
            unrelated: [onFindAssets],
            root: backToLibrary,
        });
    });

    it("keeps this device and multiple WSL distributions as centered vertical groups with one header per group", async () => {
        const { container } = renderWithPresentation(
            createElement(SourceLibraryHarness, {
                client: sourceClient([LOCAL_ENVIRONMENT_INTENT, wslEnvironment("Ubuntu", "c"), wslEnvironment("Debian", "d")]),
                onLeave: vi.fn(),
                onFindAssets: vi.fn(),
            }),
            createDesktopPresentationTestBridge(),
        );

        await screen.findByRole("navigation", { name: "Asset search location navigation" });
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
            "This device",
            "WSL · Debian",
            "WSL · Ubuntu",
        ]);
        expect(container.querySelectorAll(".source-library-group")).toHaveLength(3);
        expect(screen.getAllByText("Location")).toHaveLength(3);
        expect(screen.getAllByText("Used by")).toHaveLength(3);
        expect(screen.getAllByText("Import to")).toHaveLength(3);
        expect(container.querySelectorAll(".source-library-groups")).toHaveLength(1);
        expect(container.querySelector(".source-library-groups")?.getAttribute("data-oaam-source-group-count")).toBe("3");

        fireEvent.click(screen.getByRole("button", { name: /^WSL · Ubuntu/u }));
        await vi.waitFor(() =>
            expect(container.querySelector(".source-library-groups")?.getAttribute("data-oaam-source-group-count")).toBe("1"),
        );
        expect(container.querySelectorAll(".source-library-group")).toHaveLength(1);
    });

    it("opens guided import from an empty Sources library without forwarding the click event as a Project identity", async () => {
        const onFindAssets = vi.fn();
        renderWithPresentation(
            createElement(SourceLibraryHarness, {
                client: sourceClient([]),
                onLeave: vi.fn(),
                onFindAssets,
            }),
            createDesktopPresentationTestBridge(),
        );

        expect(await screen.findByRole("heading", { name: "No locations included in searches" })).not.toBeNull();
        await clickSemanticAction("sources.guided_import.empty", "sources.start_guided_import", {
            expected: onFindAssets,
            expectedArgs: [],
            unrelated: [],
        });
    });

    it("routes both source warning and footer Settings entries without changing the source selection", async () => {
        const openSettings = vi.fn();
        const onLeave = vi.fn();
        const onFindAssets = vi.fn();
        renderWithPresentation(
            createElement(SourceLibraryHarness, {
                client: sourceClient(),
                onLeave,
                onFindAssets,
                catalogWarningCount: 1,
                onOpenSettings: openSettings,
            }),
            createDesktopPresentationTestBridge(),
        );
        await screen.findByRole("navigation", { name: "Asset search location navigation" });
        const unrelated = [onLeave, onFindAssets];
        await clickSemanticAction("sources.settings.warning", "sources.open_settings", {
            expected: openSettings,
            expectedArgs: [],
            unrelated,
        });
        await clickSemanticAction("sources.settings.footer", "sources.open_settings", {
            expected: openSettings,
            expectedArgs: [],
            unrelated,
        });
    });

    it("renders a recoverable failure and retries the exact source authorities", async () => {
        const client = sourceClient();
        client.supportsOperation = vi.fn(() => false);
        renderWithPresentation(
            createElement(SourceLibraryHarness, {
                client,
                onLeave: vi.fn(),
                onFindAssets: vi.fn(),
            }),
            createDesktopPresentationTestBridge(),
        );

        expect(await screen.findByRole("heading", { name: "Search locations are unavailable" })).not.toBeNull();
        client.supportsOperation = vi.fn((operation: ProtocolOperationName) => OPERATIONS.includes(operation));
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByRole("navigation", { name: "Asset search location navigation" })).not.toBeNull();
    });

    it("repairs a retained source route that is absent from current watched intent", async () => {
        const { container } = renderWithPresentation(
            createElement(SourceLibraryHarness, {
                client: sourceClient(),
                onLeave: vi.fn(),
                onFindAssets: vi.fn(),
                initialRoute: {
                    surface: "sources",
                    selection: "source",
                    environment: ENVIRONMENT,
                    canonicalPath: "C:\\\\Users\\\\person\\\\missing",
                },
            }),
            createDesktopPresentationTestBridge(),
        );

        await vi.waitFor(() => expect(container.querySelector(".source-tree-root")?.getAttribute("aria-current")).toBe("page"));
    });
});
