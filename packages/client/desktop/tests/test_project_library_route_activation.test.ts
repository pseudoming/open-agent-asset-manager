import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { ProjectLibraryWorkspace } from "../src/renderer/features/project-library/ProjectLibraryWorkspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    ASSET,
    completedBridge,
    DIGEST,
    fakeClient,
    GLOBAL_ASSET,
    PROJECT,
    ProjectLibraryTestHarness,
    SECOND_ASSET,
    SECOND_PROJECT,
    SECOND_PROJECT_ID,
} from "./project-library-test-fixtures";

afterEach(cleanup);

describe("Project library route activation", () => {
    it("keeps restore review available after a failed check and shows its exact root only once", async () => {
        const retained = { ...SECOND_PROJECT, deleted: true, rootPath: "/work/retained-project" };
        const fixture = fakeClient([PROJECT, retained], [ASSET]);
        (fixture.client.availableOperations as ProtocolOperationName[]).push(
            "project_lifecycle.inspect",
            "project_lifecycle.commit",
        );
        fixture.client.inspectProjectLifecycle = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [] })
            .mockResolvedValue({
                status: "complete",
                value: {
                    schemaVersion: 1,
                    action: "restore",
                    projectLifecycleReviewToken: "restore-after-failed-check",
                    projectId: retained.projectId,
                    projectAuthorityFingerprint: DIGEST,
                    displayName: retained.displayName,
                    rootPath: retained.rootPath,
                    rootAccessState: "available",
                },
                diagnostics: [],
            });
        fixture.client.commitProjectLifecycle = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                initialRoute: { surface: "library", subject: "projects", projectId: retained.projectId },
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 1,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        const dialog = await screen.findByRole("dialog", { name: "Restore retained Project" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Review restore" }));
        await within(dialog).findByText("The Project change could not be prepared. Choose a review action above to try again.");
        expect(fixture.client.inspectProjectLifecycle).toHaveBeenCalledTimes(1);
        expect(fixture.client.commitProjectLifecycle).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole("button", { name: "Review restore" }));
        await within(dialog).findByRole("button", { name: "Confirm exact Project change" });
        expect(within(dialog).getAllByText(retained.rootPath)).toHaveLength(1);
        expect(fixture.client.inspectProjectLifecycle).toHaveBeenLastCalledWith({
            action: "restore",
            projectId: retained.projectId,
        });
        expect(fixture.client.inspectProjectLifecycle).toHaveBeenCalledTimes(2);
        expect(fixture.client.commitProjectLifecycle).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole("button", { name: "Close Project management" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(fixture.client.commitProjectLifecycle).not.toHaveBeenCalled();
    });

    it("does not attach an active fallback collection to the retained Project being reviewed", async () => {
        const retained = { ...SECOND_PROJECT, deleted: true };
        const fixture = fakeClient([PROJECT, retained], [ASSET]);
        (fixture.client.availableOperations as ProtocolOperationName[]).push(
            "project_lifecycle.inspect",
            "project_lifecycle.commit",
        );
        fixture.client.commitProjectLifecycle = vi.fn();
        const counts = await fixture.client.listAssetKindCounts({
            subject: { scope: "project", projectId: PROJECT.projectId },
            keywords: "",
            includeDeleted: false,
        });
        let completeBrowserCounts: ((value: typeof counts) => void) | undefined;
        let calls = 0;
        fixture.client.listAssetKindCounts = vi.fn(async () => {
            calls += 1;
            return calls === 2
                ? new Promise<typeof counts>((resolve) => {
                      completeBrowserCounts = resolve;
                  })
                : counts;
        });
        const replaceRoute = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryWorkspace, {
                client: fixture.client,
                route: { surface: "library", subject: "projects", projectId: retained.projectId },
                sidebarVisible: true,
                inspectorVisible: false,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                assetCount: 1,
                catalogWarningCount: 0,
                onReplaceRoute: replaceRoute,
                onNavigate: vi.fn(),
                onInspectorVisibleChange: vi.fn(),
                onOpenGuidedImport: vi.fn(),
                onOpenSources: vi.fn(),
                onOpenSearch: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );
        await screen.findByRole("dialog", { name: "Restore retained Project" });
        await waitFor(() => expect(completeBrowserCounts).toBeDefined());
        await act(async () => {
            completeBrowserCounts!(counts);
        });
        expect(replaceRoute).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: "Restore retained Project" })).not.toBeNull();
        expect(fixture.client.commitProjectLifecycle).not.toHaveBeenCalled();
    });

    it("opens an exact retained search route in restore and normalizes the route when it closes", async () => {
        const retained = { ...SECOND_PROJECT, deleted: true, rootPath: "/work/missing-project" };
        const fixture = fakeClient([PROJECT, retained], [ASSET, SECOND_ASSET, GLOBAL_ASSET]);
        const operations = fixture.client.availableOperations as ProtocolOperationName[];
        operations.push("project_lifecycle.inspect", "project_lifecycle.commit");
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                initialRoute: {
                    surface: "library",
                    subject: "projects",
                    projectId: SECOND_PROJECT_ID,
                },
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 3,
                catalogWarningCount: 0,
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        const dialog = await screen.findByRole("dialog", { name: "Restore retained Project" });
        expect(within(dialog).getByText(SECOND_PROJECT.displayName)).not.toBeNull();
        expect(within(dialog).getByText(retained.rootPath)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Close Project management" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(screen.getByRole("heading", { level: 1, name: PROJECT.displayName })).not.toBeNull();
        expect(document.querySelector(`[data-oaam-route="library"][data-oaam-project-id="${PROJECT.projectId}"]`)).not.toBeNull();
    });
});
