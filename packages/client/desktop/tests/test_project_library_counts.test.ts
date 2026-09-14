import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    ASSET,
    ASSET_ID,
    completedBridge,
    fakeClient,
    PROJECT,
    PROJECT_ID,
    ProjectLibraryTestHarness,
    SECOND_ASSET,
    SECOND_PROJECT,
    SECOND_PROJECT_ID,
} from "./project-library-test-fixtures";

afterEach(cleanup);

function mountLibrary(fixture: ReturnType<typeof fakeClient>) {
    return renderWithPresentation(
        createElement(ProjectLibraryTestHarness, {
            client: fixture.client,
            pickProjectRoot: async () => ({ status: "cancelled" }),
            assetCount: 2,
            catalogWarningCount: 0,
            onOpenSources: vi.fn(),
            onOpenSettings: vi.fn(),
            onOpenDeployments: vi.fn(),
        }),
        completedBridge(PROJECT_ID),
    );
}

function projectButton(projectId: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(`.asset-tree-project[data-oaam-project-id="${projectId}"]`);
    if (button === null) throw new Error(`missing Project button: ${projectId}`);
    return button;
}

function countBadge(projectId: string): string | undefined {
    return projectButton(projectId).querySelector("small")?.textContent ?? undefined;
}

describe("Project library count refresh ownership", () => {
    it.each([
        false,
        true,
    ])("retains loaded source rows and opens the copied Asset when the destination count fails: %s", async (failCount) => {
        const assets = [
            ASSET,
            ...Array.from({ length: 50 }, (_, index) => ({
                ...ASSET,
                assetId: `${String(index + 10).padStart(8, "0")}-0000-4000-8000-000000000000`,
                displayName: `Decoy ${index}`,
            })),
        ];
        const fixture = fakeClient([PROJECT, SECOND_PROJECT], assets);
        const copy = { ...SECOND_ASSET, currentRevision: 1, displayName: "Destination copy" };
        const sourceVersion = await fixture.client.getAssetVersion({ assetId: ASSET_ID, versionId: ASSET.currentVersionId });
        if (sourceVersion.status === "failed" || !sourceVersion.value.found) throw new Error("missing source Version");
        fixture.client.copyAsset = vi.fn(async ({ source }) => {
            assets.push(copy);
            return {
                status: "complete",
                diagnostics: [],
                value: {
                    source: { assetId: source.assetId, versionId: source.versionId },
                    asset: { ...copy, versionIds: [copy.currentVersionId] },
                    version: {
                        ...sourceVersion.value.value,
                        assetId: copy.assetId,
                        versionId: copy.currentVersionId,
                        revision: 1,
                    },
                },
            };
        });
        const view = mountLibrary(fixture);
        fireEvent.click(await screen.findByRole("button", { name: "Show 1 more Guidance Assets" }));
        const selector = `.asset-library-item[data-oaam-asset-id="${ASSET_ID}"]`;
        await vi.waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull());
        const sourceRow = view.container.querySelector(selector);
        const inspect = sourceRow?.querySelector<HTMLButtonElement>('[data-oaam-action="inspect-asset"]');
        if (inspect === null || inspect === undefined) throw new Error("missing source row");
        fireEvent.click(inspect);
        const inspector = view.container.querySelector<HTMLElement>(".asset-inspector");
        if (inspector === null) throw new Error("missing Asset inspector");
        fireEvent.click(await within(inspector).findByRole("button", { name: "Copy version" }));
        fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
        fireEvent.click(screen.getByRole("option", { name: SECOND_PROJECT.displayName }));
        const scroll = view.container.querySelector<HTMLElement>(".library-main-scroll");
        if (scroll === null) throw new Error("missing Library scroll container");
        scroll.scrollTop = 420;
        const counts = vi.mocked(fixture.client.listAssetKindCounts);
        const original = counts.getMockImplementation();
        if (original === undefined) throw new Error("missing count fixture");
        let shouldFail = failCount;
        counts.mockClear();
        counts.mockImplementation(async (input) => {
            if (shouldFail && input.subject.scope === "project" && input.subject.projectId === SECOND_PROJECT_ID) {
                shouldFail = false;
                return { status: "failed", diagnostics: [] };
            }
            return original(input);
        });
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        await screen.findByRole("button", { name: "Open copy" });
        await vi.waitFor(() => expect(view.container.querySelector('[aria-busy="true"]')).toBeNull());
        expect(screen.getByText("Saved in Second project · Version 1")).not.toBeNull();
        expect(countBadge(PROJECT_ID)).toBe("51");
        expect(countBadge(SECOND_PROJECT_ID)).toBe(failCount ? undefined : "1");
        expect(counts).toHaveBeenCalledTimes(2);
        expect(view.container.querySelectorAll(".asset-library-item")).toHaveLength(51);
        expect(view.container.querySelector(selector)).toBe(sourceRow);
        expect(sourceRow?.getAttribute("data-selected")).toBe("true");
        expect(scroll.scrollTop).toBe(420);
        fireEvent.click(screen.getByRole("button", { name: "Open copy" }));
        await vi.waitFor(() =>
            expect(
                view.container
                    .querySelector(`.asset-library-item[data-oaam-asset-id="${copy.assetId}"]`)
                    ?.getAttribute("data-selected"),
            ).toBe("true"),
        );
        expect(screen.getByRole("heading", { level: 1, name: SECOND_PROJECT.displayName })).not.toBeNull();
        expect(fixture.client.getAsset).toHaveBeenLastCalledWith({ assetId: copy.assetId });
        expect(fixture.client.copyAsset).toHaveBeenCalledOnce();
    });

    it.each([1, 16, 64])("does not refresh all %s Project counts when only selection changes", async (size) => {
        const projects = [
            PROJECT,
            ...Array.from({ length: size - 1 }, (_, index) => ({
                ...SECOND_PROJECT,
                projectId: `${String(index + 10).padStart(8, "0")}-0000-4000-8000-000000000000`,
                displayName: `Project ${index + 2}`,
                rootPath: `/work/project-${index + 2}`,
            })),
        ];
        const fixture = fakeClient(projects, [ASSET]);
        const counts = vi.mocked(fixture.client.listAssetKindCounts);
        mountLibrary(fixture);
        // One count per sidebar Project, plus the selected Project's bounded browser count.
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(size + 1));
        counts.mockClear();

        await act(async () => fireEvent.click(projectButton(PROJECT_ID)));
        expect(counts).not.toHaveBeenCalled();
        if (size > 1) {
            const nextProject = projects[size - 1];
            if (nextProject === undefined) throw new Error("missing next Project fixture");
            fireEvent.click(projectButton(nextProject.projectId));
            await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(1));
            expect(counts).toHaveBeenLastCalledWith({
                subject: { scope: "project", projectId: nextProject.projectId },
                keywords: "",
                includeDeleted: false,
            });
            expect(screen.getByRole("heading", { level: 1, name: nextProject.displayName })).not.toBeNull();
        }
        expect(fixture.client.listAssets).not.toHaveBeenCalled();
        expect(fixture.client.getAsset).not.toHaveBeenCalled();
    });

    it("refreshes every relevant invalidation even while the Project catalog is already marked stale", async () => {
        const fixture = fakeClient([PROJECT, SECOND_PROJECT], [ASSET, SECOND_ASSET]);
        const counts = vi.mocked(fixture.client.listAssetKindCounts);
        mountLibrary(fixture);
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(3));
        for (const invalidation of [
            { resourceKind: "asset", assetId: ASSET_ID },
            { resourceKind: "collection", collection: "assets" },
            { resourceKind: "project", projectId: SECOND_PROJECT_ID },
            { resourceKind: "collection", collection: "projects" },
        ] as const) {
            counts.mockClear();
            await act(async () => fixture.invalidate(invalidation));
            expect(counts).toHaveBeenCalledTimes(2);
            expect(countBadge(PROJECT_ID)).toBe("1");
            expect(countBadge(SECOND_PROJECT_ID)).toBe("1");
        }
        counts.mockClear();
        await act(async () => fixture.invalidate({ resourceKind: "deployment", deploymentId: PROJECT_ID }));
        expect(counts).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Refresh changed data" })).not.toBeNull();
    });

    it("refreshes counts for the explicit deleted filter and a fresh Project inventory", async () => {
        const fixture = fakeClient([PROJECT, SECOND_PROJECT], [ASSET, { ...SECOND_ASSET, deleted: true }]);
        const counts = vi.mocked(fixture.client.listAssetKindCounts);
        mountLibrary(fixture);
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(3));
        expect(countBadge(SECOND_PROJECT_ID)).toBe("0");
        counts.mockClear();

        fireEvent.click(screen.getByRole("button", { name: /Show Assets in the OAAM Recycle Bin/u }));
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(3));
        expect(counts.mock.calls.every(([input]) => input.includeDeleted === true)).toBe(true);
        expect(countBadge(SECOND_PROJECT_ID)).toBe("1");
        counts.mockClear();
        vi.mocked(fixture.client.listProjects).mockResolvedValueOnce({
            status: "complete",
            value: { projects: [PROJECT] },
            diagnostics: [],
        });
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(2));
        expect(
            counts.mock.calls.every(([input]) => input.subject.scope === "project" && input.subject.projectId === PROJECT_ID),
        ).toBe(true);
        expect(document.querySelector(`.asset-tree-project[data-oaam-project-id="${SECOND_PROJECT_ID}"]`)).toBeNull();
    });

    it("removes failed counts instead of retaining a successful number or claiming zero", async () => {
        const fixture = fakeClient([PROJECT, SECOND_PROJECT], [ASSET, SECOND_ASSET]);
        const counts = vi.mocked(fixture.client.listAssetKindCounts);
        mountLibrary(fixture);
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(3));
        const original = counts.getMockImplementation();
        if (original === undefined) throw new Error("missing count fixture");
        counts.mockImplementation(async (input) =>
            input.subject.scope === "project" && input.subject.projectId === SECOND_PROJECT_ID
                ? { status: "failed", diagnostics: [] }
                : original(input),
        );
        await act(async () => fixture.invalidate({ resourceKind: "collection", collection: "assets" }));
        expect(countBadge(PROJECT_ID)).toBe("1");
        expect(countBadge(SECOND_PROJECT_ID)).toBeUndefined();

        counts.mockRejectedValue(new Error("connection interrupted"));
        await act(async () => fixture.invalidate({ resourceKind: "collection", collection: "assets" }));
        expect(countBadge(PROJECT_ID)).toBeUndefined();
        expect(countBadge(SECOND_PROJECT_ID)).toBeUndefined();
    });

    it("ignores an older count wave after a newer invalidation and unsubscribes on unmount", async () => {
        const fixture = fakeClient([PROJECT, SECOND_PROJECT], [ASSET, SECOND_ASSET]);
        const counts = vi.mocked(fixture.client.listAssetKindCounts);
        const view = mountLibrary(fixture);
        await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(3));
        const original = counts.getMockImplementation();
        if (original === undefined) throw new Error("missing count fixture");
        let releaseOld!: (value: Awaited<ReturnType<typeof fixture.client.listAssetKindCounts>>) => void;
        const old = new Promise<Awaited<ReturnType<typeof fixture.client.listAssetKindCounts>>>((resolve) => {
            releaseOld = resolve;
        });
        counts.mockImplementationOnce(() => old);
        await act(async () => fixture.invalidate({ resourceKind: "asset", assetId: ASSET_ID }));
        counts.mockImplementation(async (input) => {
            const result = await original(input);
            if (result.status === "failed") throw new Error("expected fixture count");
            return { ...result, value: { counts: result.value.counts.map((entry) => ({ ...entry, count: 2 })) } };
        });
        await act(async () => fixture.invalidate({ resourceKind: "asset", assetId: ASSET_ID }));
        expect(countBadge(PROJECT_ID)).toBe("12");
        await act(async () => releaseOld(await original({ subject: { scope: "project", projectId: PROJECT_ID }, keywords: "" })));
        expect(countBadge(PROJECT_ID)).toBe("12");
        view.unmount();
        counts.mockClear();
        fixture.invalidate({ resourceKind: "collection", collection: "assets" });
        expect(counts).not.toHaveBeenCalled();
    });
});
