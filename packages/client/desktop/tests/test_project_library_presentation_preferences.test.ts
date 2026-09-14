import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    completedBridge,
    fakeClient,
    PROJECT,
    PROJECT_ID,
    ProjectLibraryTestHarness,
    SECOND_PROJECT_ID,
} from "./project-library-test-fixtures";

afterEach(cleanup);

describe("Project library presentation preferences", () => {
    it("remembers list/card and Project choices while keeping selection free of source operations", async () => {
        const fixture = fakeClient();
        const bridge = completedBridge();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            bridge,
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "OAAM" })).not.toBeNull());
        await vi.waitFor(() => expect(document.querySelector(".library-toolbar .layout-switch")).not.toBeNull());
        expect(document.querySelector(".library-toolbar-separator")).not.toBeNull();
        const deletedFilter = screen.getByRole("button", { name: /Show Assets in the OAAM Recycle Bin/u });
        expect(deletedFilter.querySelector("[data-oaam-icon='filter']")).not.toBeNull();
        expect(deletedFilter.querySelector("[data-oaam-icon='trash']")).toBeNull();
        expect(deletedFilter.getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(screen.getByRole("button", { name: "Cards" }));
        await vi.waitFor(() => expect(bridge.replaceAssetLayout).toHaveBeenCalledWith("cards"));
        fireEvent.click(screen.getByRole("button", { name: /^OAAM/u }));
        await vi.waitFor(() => expect(bridge.rememberLastProject).toHaveBeenCalledWith(PROJECT_ID));
        expect(bridge.rememberLastProject).toHaveBeenCalledTimes(1);
        expect(fixture.client.listAssets).not.toHaveBeenCalled();
    });

    it("publishes an exact active route-selected Project once", async () => {
        const bridge = completedBridge();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fakeClient().client,
                initialRoute: { surface: "library", subject: "projects", projectId: PROJECT_ID },
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            bridge,
        );

        await vi.waitFor(() => expect(bridge.rememberLastProject).toHaveBeenCalledWith(PROJECT_ID));
        expect(bridge.rememberLastProject).toHaveBeenCalledTimes(1);
    });

    it("does not publish matching, Global, fallback, invalid, or unloaded Project routes", async () => {
        const matchedBridge = completedBridge(PROJECT_ID);
        const matched = renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fakeClient().client,
                initialRoute: { surface: "library", subject: "projects", projectId: PROJECT_ID },
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            matchedBridge,
        );
        await screen.findByRole("heading", { level: 1, name: PROJECT.displayName });
        expect(matchedBridge.rememberLastProject).not.toHaveBeenCalled();
        matched.unmount();

        for (const initialRoute of [
            { surface: "library", subject: "global" } as const,
            { surface: "library", subject: "projects" } as const,
            { surface: "library", subject: "projects", projectId: SECOND_PROJECT_ID } as const,
        ]) {
            const bridge = completedBridge();
            const view = renderWithPresentation(
                createElement(ProjectLibraryTestHarness, {
                    client: fakeClient().client,
                    initialRoute,
                    pickProjectRoot: async () => ({ status: "cancelled" }),
                    assetCount: 2,
                    catalogWarningCount: 0,
                    onOpenSources: vi.fn(),
                    onOpenSettings: vi.fn(),
                    onOpenDeployments: vi.fn(),
                }),
                bridge,
            );
            await vi.waitFor(() =>
                expect(document.querySelector("main.project-library-shell[data-oaam-state='ready']")).not.toBeNull(),
            );
            expect(bridge.rememberLastProject).not.toHaveBeenCalled();
            view.unmount();
        }

        const loadingFixture = fakeClient();
        (loadingFixture.client.listProjects as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => undefined));
        const loadingBridge = completedBridge();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: loadingFixture.client,
                initialRoute: { surface: "library", subject: "projects", projectId: PROJECT_ID },
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            loadingBridge,
        );
        await screen.findByText("Loading your OAAM library");
        expect(loadingBridge.rememberLastProject).not.toHaveBeenCalled();
    });

    it("warns without looping and retries once after a later explicit route activation", async () => {
        const rememberLastProject = vi.fn(async () => {
            throw new Error("preference unavailable");
        });
        const bridge = { ...completedBridge(), rememberLastProject } satisfies OaamDesktopBridge;
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fakeClient().client,
                initialRoute: { surface: "library", subject: "projects", projectId: PROJECT_ID },
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 2,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            bridge,
        );

        await screen.findByText("The selection remains active for this session, but its Desktop preference was not saved.");
        expect(rememberLastProject).toHaveBeenCalledTimes(1);
        fireEvent(window, new Event("resize"));
        expect(rememberLastProject).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("tab", { name: "Global" }));
        fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
        await vi.waitFor(() => expect(rememberLastProject).toHaveBeenCalledTimes(2));
        fireEvent(window, new Event("resize"));
        expect(rememberLastProject).toHaveBeenCalledTimes(2);
    });
});
