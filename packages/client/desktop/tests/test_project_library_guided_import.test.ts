import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { completedBridge, fakeClient, PROJECT, PROJECT_ID, ProjectLibraryTestHarness } from "./project-library-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Project library guided-import entry", () => {
    it("shows a truthful empty Project state and only opens guided import after an explicit click", async () => {
        const fixture = fakeClient([]);
        const startGuidedImport = vi.fn();
        const pickProjectRoot = vi.fn(async () => ({ status: "cancelled" as const }));
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot,
                assetCount: 0,
                catalogWarningCount: 1,
                onOpenGuidedImport: startGuidedImport,
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        await vi.waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Start with a Project" })).not.toBeNull());
        expect(startGuidedImport).not.toHaveBeenCalled();
        const addProjectActions = screen
            .getAllByRole("button", { name: "Add Project" })
            .filter((button) => !(button as HTMLButtonElement).disabled);
        expect(addProjectActions).toHaveLength(2);
        const treeAddProject = within(screen.getByRole("navigation", { name: "Asset library" })).getByRole("button", {
            name: "Add Project",
        });
        expect(treeAddProject.querySelector("[data-oaam-icon='add']")).not.toBeNull();
        const addProject = addProjectActions.find((button) => button.textContent?.includes("Add Project"));
        if (addProject === undefined) throw new Error("expected the empty Project action to be available");
        fireEvent.click(addProject);
        await vi.waitFor(() => expect(pickProjectRoot).toHaveBeenCalledOnce());
        expect(fixture.client.registerProject).not.toHaveBeenCalled();
        const importActions = screen.getAllByRole("button", { name: "Import from existing tools" });
        expect(importActions).toHaveLength(1);
        await clickSemanticAction("library.guided_import.no_projects", "library.start_guided_import", {
            expected: startGuidedImport,
            expectedArgs: [],
            unrelated: [pickProjectRoot],
            root: importActions[0] as HTMLElement,
        });
        expect(fixture.client.listProjects).toHaveBeenCalledOnce();
        expect(fixture.client.listAssets).not.toHaveBeenCalled();
    });

    it("opens an empty registered Project import with that exact Project as the route subject", async () => {
        const fixture = fakeClient([PROJECT], []);
        const startGuidedImport = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                onOpenGuidedImport: startGuidedImport,
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
                initialRoute: {
                    surface: "library",
                    subject: "projects",
                    projectId: PROJECT_ID,
                    kind: "Guidance",
                },
            }),
            completedBridge(),
        );

        expect(await screen.findByRole("heading", { level: 1, name: PROJECT.displayName })).not.toBeNull();
        const action = await screen.findByRole("button", { name: "Find Assets for this Project" });
        await clickSemanticAction("library.guided_import.empty_collection", "library.start_guided_import", {
            expected: startGuidedImport,
            expectedArgs: [PROJECT_ID],
            unrelated: [],
            root: action,
        });
    });

    it("keeps the library toolbar import contextual to the selected Project or Global library", async () => {
        const fixture = fakeClient([PROJECT]);
        const startGuidedImport = vi.fn();
        const openSourceLocations = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 1,
                catalogWarningCount: 0,
                onOpenGuidedImport: startGuidedImport,
                onOpenSources: openSourceLocations,
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        expect(await screen.findByRole("heading", { level: 1, name: PROJECT.displayName })).not.toBeNull();
        await vi.waitFor(() => expect(screen.queryByText("Project guidance")).not.toBeNull());
        await clickSemanticAction("library.source_locations.toolbar", "library.open_source_locations", {
            expected: openSourceLocations,
            expectedArgs: [],
            unrelated: [startGuidedImport],
        });
        expect(startGuidedImport).not.toHaveBeenCalled();
        await clickSemanticAction("library.guided_import.toolbar", "library.start_guided_import", {
            expected: startGuidedImport,
            expectedArgs: [PROJECT_ID],
            unrelated: [openSourceLocations],
        });

        fireEvent.click(screen.getByRole("tab", { name: "Global" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Global assets" })).not.toBeNull();
        fireEvent.click(await screen.findByRole("button", { name: "Import from existing tools" }));
        expect(startGuidedImport).toHaveBeenLastCalledWith();
    });
});
