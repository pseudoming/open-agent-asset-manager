import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    ASSET_ID,
    completedBridge,
    expandProjectLibraryKind,
    fakeClient,
    PROJECT_ID,
    ProjectLibraryTestHarness,
} from "./project-library-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Project library tool-file entry", () => {
    it("keeps the empty Global library free of a tool-use shortcut while preserving ownership navigation", async () => {
        const fixture = fakeClient([], []);
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                initialRoute: { surface: "library", subject: "global" },
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        await vi.waitFor(() => expect(fixture.client.listAssetKindCounts).toHaveBeenCalled());
        await vi.waitFor(() =>
            expect(fixture.client.listDeployments).toHaveBeenCalledWith({ subject: { subjectKind: "global" } }),
        );
        expect(screen.queryByRole("navigation", { name: "Workspace view" })).toBeNull();
        expect(await screen.findByRole("button", { name: "Import from existing tools" })).not.toBeNull();
        expect(screen.getByRole("tab", { name: "Global" }).getAttribute("aria-selected")).toBe("true");
        const assetTree = screen.getByRole("navigation", { name: "Asset library" });
        const globalRoot = within(assetTree).getByRole("button", { name: /^Global assets/iu });
        expect(globalRoot).not.toBeNull();
        fireEvent.click(globalRoot);
        expect(assetTree.querySelectorAll("[data-oaam-project-id]")).toHaveLength(0);
        expect(assetTree.querySelectorAll("[data-oaam-collection-id='project']")).toHaveLength(0);
        expect(document.querySelector('[data-oaam-action="open-deployments"]')).toBeNull();
    });

    it("keeps management reachable for an existing Global tool-file relationship even when its Asset list is empty", async () => {
        const fixture = fakeClient([], []);
        fixture.client.listDeployments = vi.fn(async () => ({
            status: "complete",
            value: {
                deployments: [
                    {
                        deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        subject: { subjectKind: "global" },
                        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        environment: { platform: "linux", platformInstanceId: "local" },
                        targetRootPath: "/home/user/.claude",
                        stage: "in_sync",
                        reason: "applied",
                        actionHints: ["check_now"],
                        freshness: { state: "complete", attemptedAt: 1, lastCompleteAt: 1 },
                        deleted: false,
                        assets: [],
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            diagnostics: [],
        }));
        const onOpenDeployments = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                initialRoute: { surface: "library", subject: "global" },
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments,
            }),
            completedBridge(),
        );

        await screen.findByRole("button", { name: "Manage tool locations" });
        await clickSemanticAction("library.deployments.toolbar", "library.open_deployments", {
            expected: onOpenDeployments,
            expectedArgs: [{ subjectKind: "global" }],
            unrelated: [],
        });
    });

    it("keeps the selected Asset add action available when the Project already has another tool location", async () => {
        const fixture = fakeClient();
        fixture.client.listDeployments = vi.fn(async () => ({
            status: "complete",
            value: {
                deployments: [
                    {
                        deploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        subject: { subjectKind: "project", projectId: PROJECT_ID },
                        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                        targetRootPath: "/work/oaam",
                        stage: "in_sync",
                        reason: "applied",
                        actionHints: ["check_now"],
                        freshness: { state: "complete", attemptedAt: 1, lastCompleteAt: 1 },
                        deleted: false,
                        assets: [],
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            diagnostics: [],
        }));
        const onOpenDeployments = vi.fn();
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 1,
                catalogWarningCount: 0,
                initialRoute: { surface: "library", subject: "projects", projectId: PROJECT_ID },
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments,
            }),
            completedBridge(),
        );

        await screen.findByRole("button", { name: "Manage tool locations" });
        await vi.waitFor(() => expect(screen.queryAllByRole("button", { name: /^Guidance/u }).length).toBeGreaterThan(0));
        expandProjectLibraryKind("Guidance");
        fireEvent.click(await screen.findByRole("button", { name: /Project guidance/u }));
        fireEvent.click(await screen.findByRole("button", { name: "Choose where to use" }));

        expect(onOpenDeployments).toHaveBeenCalledWith({ subjectKind: "project", projectId: PROJECT_ID }, ASSET_ID);
    });

    it("keeps the Global library usable when optional target-support and Deployment summaries are interrupted", async () => {
        const fixture = fakeClient([], []);
        fixture.client.listAdapterProviders = vi.fn(async () => {
            throw new Error("provider projection interrupted");
        });
        fixture.client.listDeployments = vi.fn(async () => {
            throw new Error("Deployment summary interrupted");
        });
        renderWithPresentation(
            createElement(ProjectLibraryTestHarness, {
                client: fixture.client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                initialRoute: { surface: "library", subject: "global" },
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenDeployments: vi.fn(),
            }),
            completedBridge(),
        );

        expect(await screen.findByRole("button", { name: "Import from existing tools" })).not.toBeNull();
        await vi.waitFor(() => expect(fixture.client.listAdapterProviders).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(fixture.client.listDeployments).toHaveBeenCalledOnce());
        expect(document.querySelector('[data-oaam-action="open-deployments"]')).toBeNull();
    });
});
