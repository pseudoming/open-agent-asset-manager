import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { AssetBrowserController, type AssetBrowserState } from "../src/renderer/features/project-library";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DIGEST = "a".repeat(64);
const ASSET = {
    assetId: ASSET_ID,
    kind: "Guidance" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Project rules",
    currentVersionId: VERSION_ID,
    currentRevision: 1,
    currentFingerprint: DIGEST,
    currentVersionStatus: "complete" as const,
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
const WARNING = {
    severity: "warning" as const,
    code: "asset.partial",
    operation: "asset" as const,
    causeKind: "partial" as const,
    retryable: true,
    suggestedActions: ["retry"],
    message: "One source was unavailable.",
};
const ERROR = { ...WARNING, severity: "error" as const, message: "The catalog query failed." };

function fakeClient(
    operations: readonly ProtocolOperationName[] = ["asset_library.kind_counts", "asset_library.page"],
    overrides: Partial<DesktopApplicationClientApi> = {},
): DesktopApplicationClientApi {
    return {
        availableOperations: operations,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => operations.includes(operation)),
        listAssetKindCounts: vi.fn(async ({ subject }) => ({
            status: subject.scope === "project" ? ("partial" as const) : ("complete" as const),
            value: {
                counts: [
                    { kind: "Guidance" as const, count: subject.scope === "project" ? 2 : 0 },
                    { kind: "Rule" as const, count: 0 },
                    { kind: "Workflow" as const, count: 0 },
                    { kind: "Skill" as const, count: 0 },
                    { kind: "Subagent" as const, count: 0 },
                    { kind: "Memory" as const, count: 0 },
                ],
            },
            diagnostics: subject.scope === "project" ? [WARNING] : [],
        })),
        queryAssetLibrary: vi.fn(async ({ cursor }) => ({
            status: "complete",
            value:
                cursor === undefined
                    ? { assets: [ASSET], totalCount: 2, hasMore: true, nextCursor: "page-2" }
                    : {
                          assets: [{ ...ASSET, assetId: "44444444-4444-4444-8444-444444444444", displayName: "Second" }],
                          totalCount: 2,
                          hasMore: false,
                      },
            diagnostics: cursor === undefined ? [WARNING] : [],
        })),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
}

function readyState(controller: AssetBrowserController): Extract<AssetBrowserState, { readonly status: "ready" }> {
    expect(controller.state.status).toBe("ready");
    return controller.state as Extract<AssetBrowserState, { readonly status: "ready" }>;
}

function pagedCatalogClient() {
    const catalog = { generation: 1 };
    const assets = Array.from({ length: 150 }, (_, index) => ({
        ...ASSET,
        assetId: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        displayName: `Guidance ${index + 1}`,
    }));
    const client = fakeClient(undefined, {
        listAssetKindCounts: vi.fn(async () => ({
            status: "complete",
            value: {
                counts: [
                    { kind: "Guidance", count: 150 },
                    { kind: "Skill", count: 7 },
                ],
            },
            diagnostics: [],
        })),
        queryAssetLibrary: vi.fn(async ({ cursor, pageSize }) => {
            const [generation, offset] = cursor === undefined ? [catalog.generation, 0] : cursor.split(":").map(Number);
            if (generation !== catalog.generation) return { status: "failed", diagnostics: [ERROR] };
            const start = offset ?? 0;
            const end = start + (pageSize ?? 50);
            return {
                status: "complete",
                value: {
                    assets: assets.slice(start, end),
                    totalCount: assets.length,
                    hasMore: end < assets.length,
                    ...(end < assets.length ? { nextCursor: `${catalog.generation}:${end}` } : {}),
                },
                diagnostics: [],
            };
        }),
    });
    return { client, catalog };
}

describe("AssetBrowserController", () => {
    it("loads one exact Project collection and requests bounded Asset pages", async () => {
        const client = fakeClient();
        const controller = new AssetBrowserController(client);
        const states: AssetBrowserState[] = [];
        controller.subscribe((state) => states.push(state));

        await controller.load("projects", PROJECT_ID, " guide ", true);
        expect(client.listAssetKindCounts).toHaveBeenCalledOnce();
        expect(client.listAssetKindCounts).toHaveBeenCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            keywords: " guide ",
            includeDeleted: true,
        });
        expect(readyState(controller).collections).toHaveLength(1);
        expect(readyState(controller).diagnostics).toEqual([WARNING]);

        await controller.loadKind("project", "Guidance");
        expect(client.queryAssetLibrary).toHaveBeenLastCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            kind: "Guidance",
            keywords: " guide ",
            includeDeleted: true,
            pageSize: 50,
        });
        await controller.loadKind("project", "Guidance");
        expect(client.queryAssetLibrary).toHaveBeenLastCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            kind: "Guidance",
            keywords: " guide ",
            includeDeleted: true,
            pageSize: 50,
            cursor: "page-2",
        });
        const guidance = readyState(controller).collections[0]?.kinds[0];
        expect(guidance).toMatchObject({ status: "ready", totalCount: 2, hasMore: false });
        expect(guidance?.status === "ready" ? guidance.assets.map((asset) => asset.displayName) : []).toEqual([
            "Project guidance",
            "Second",
        ]);
        expect(states.map((state) => state.status)).toContain("loading");
    });

    it("refreshes only loaded pages with new catalog cursors and keeps the next page usable after a copy elsewhere", async () => {
        const { client, catalog } = pagedCatalogClient();
        const controller = new AssetBrowserController(client);
        await controller.refresh();
        expect(client.listAssetKindCounts).not.toHaveBeenCalled();
        await controller.load("global", undefined, "guide", false);
        await controller.loadKind("global", "Guidance");
        await controller.loadKind("global", "Guidance");
        const previous = readyState(controller).collections;
        expect(previous[0]?.kinds[0]).toMatchObject({ status: "ready", nextCursor: "1:100" });
        const counts = await client.listAssetKindCounts({ subject: { scope: "global" }, keywords: "guide" });
        let releaseCounts!: (result: typeof counts) => void;
        vi.mocked(client.listAssetKindCounts).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseCounts = resolve;
                }),
        );
        vi.mocked(client.queryAssetLibrary).mockClear();
        catalog.generation = 2;
        const refresh = controller.refresh();
        expect(readyState(controller).collections).toBe(previous);
        expect(readyState(controller).refreshing).toBe(true);
        await controller.loadKind("global", "Guidance");
        expect(client.queryAssetLibrary).not.toHaveBeenCalled();
        releaseCounts(counts);
        await refresh;
        const refreshed = readyState(controller).collections[0]?.kinds[0];
        expect(refreshed).toMatchObject({ status: "ready", nextCursor: "2:100", hasMore: true });
        expect(refreshed?.status === "ready" ? refreshed.assets : []).toHaveLength(100);
        expect(readyState(controller).refreshing).toBe(false);
        expect(readyState(controller).collections[0]?.kinds.find((kind) => kind.kind === "Skill")).toMatchObject({
            status: "collapsed",
            totalCount: 7,
        });
        expect(vi.mocked(client.queryAssetLibrary).mock.calls.map(([input]) => [input.kind, input.cursor])).toEqual([
            ["Guidance", undefined],
            ["Guidance", "2:50"],
        ]);
        await controller.loadKind("global", "Guidance");
        expect(client.queryAssetLibrary).toHaveBeenLastCalledWith({
            subject: { scope: "global" },
            kind: "Guidance",
            keywords: "guide",
            includeDeleted: false,
            pageSize: 50,
            cursor: "2:100",
        });
        const final = readyState(controller).collections[0]?.kinds[0];
        expect(final?.status === "ready" ? final.assets : []).toHaveLength(150);
        expect(final).toMatchObject({ status: "ready", hasMore: false });
    });

    it("retains loaded rows when copy completion overtakes a pending next page", async () => {
        const { client, catalog } = pagedCatalogClient();
        const controller = new AssetBrowserController(client);
        await controller.load("global", undefined, "", false);
        await controller.loadKind("global", "Guidance");
        await controller.loadKind("global", "Guidance");
        let releasePage!: (result: Awaited<ReturnType<typeof client.queryAssetLibrary>>) => void;
        vi.mocked(client.queryAssetLibrary).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releasePage = resolve;
                }),
        );
        const pending = controller.loadKind("global", "Guidance");
        const loading = readyState(controller).collections[0]?.kinds[0];
        expect(loading).toMatchObject({ status: "ready", loadingMore: true });
        expect(loading?.status === "ready" ? loading.assets : []).toHaveLength(100);
        await controller.loadKind("global", "Guidance");
        expect(client.queryAssetLibrary).toHaveBeenCalledTimes(3);
        catalog.generation = 2;
        await controller.refresh();
        const refreshed = readyState(controller).collections[0]?.kinds[0];
        expect(refreshed?.status === "ready" ? refreshed.assets : []).toHaveLength(100);
        expect(refreshed).toMatchObject({ status: "ready", nextCursor: "2:100" });
        releasePage({ status: "failed", diagnostics: [ERROR] });
        await pending;
        expect(readyState(controller).collections[0]?.kinds[0]).toBe(refreshed);
    });

    it.each(["navigation", "newer refresh"] as const)("ignores an older refresh after %s", async (change) => {
        const { client, catalog } = pagedCatalogClient();
        const controller = new AssetBrowserController(client);
        await controller.load("global", undefined, "", false);
        await controller.loadKind("global", "Guidance");
        const query = vi.mocked(client.queryAssetLibrary);
        let releasePage!: (result: Awaited<ReturnType<typeof client.queryAssetLibrary>>) => void;
        query.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releasePage = resolve;
                }),
        );
        catalog.generation = 2;
        const oldRefresh = controller.refresh();
        await vi.waitFor(() => expect(releasePage).toBeTypeOf("function"));
        catalog.generation = 3;
        if (change === "navigation") {
            await controller.load("projects", PROJECT_ID, "latest", true);
            await controller.loadKind("project", "Guidance");
        } else await controller.refresh();
        const latest = controller.state;
        releasePage({
            status: "complete",
            value: { assets: [{ ...ASSET, displayName: "Stale" }], totalCount: 1, hasMore: false },
            diagnostics: [],
        });
        await oldRefresh;
        expect(controller.state).toBe(latest);
        expect(readyState(controller).collections[0]?.kinds[0]).toMatchObject({ status: "ready", nextCursor: "3:50" });
        expect(readyState(controller).keywords).toBe(change === "navigation" ? "latest" : "");
    });

    it.each([
        "counts",
        "page",
        "connection",
    ] as const)("exposes a failed %s refresh without publishing mixed pages", async (failure) => {
        const { client, catalog } = pagedCatalogClient();
        const controller = new AssetBrowserController(client);
        await controller.load("global", undefined, "", false);
        await controller.loadKind("global", "Guidance");
        await controller.loadKind("global", "Guidance");
        const previous = readyState(controller).collections;
        const observed: AssetBrowserState[] = [];
        controller.subscribe((state) => observed.push(state));
        catalog.generation = 2;
        if (failure === "counts")
            vi.mocked(client.listAssetKindCounts).mockResolvedValueOnce({ status: "failed", diagnostics: [ERROR] });
        else {
            const query = vi.mocked(client.queryAssetLibrary);
            const original = query.getMockImplementation();
            if (original === undefined) throw new Error("missing page fixture");
            query.mockImplementationOnce(original);
            if (failure === "page") query.mockResolvedValueOnce({ status: "failed", diagnostics: [ERROR] });
            else query.mockRejectedValueOnce(new Error("disconnected"));
        }
        await controller.refresh();
        expect(controller.state).toMatchObject({ status: "failed", diagnostics: failure === "connection" ? [] : [ERROR] });
        expect(observed.filter((state) => state.status === "ready").every((state) => state.collections === previous)).toBe(true);
        await controller.load("global", undefined, "", false);
        await controller.loadKind("global", "Guidance");
        expect(readyState(controller).collections[0]?.kinds[0]).toMatchObject({ status: "ready", nextCursor: "2:50" });
    });

    it("fails closed for unavailable, rejected and interrupted queries without inventing an empty library", async () => {
        const unavailable = new AssetBrowserController(fakeClient([]));
        await unavailable.load("global", undefined, "", false);
        expect(unavailable.state.status).toBe("failed");

        const missingProject = new AssetBrowserController(fakeClient());
        await missingProject.load("projects", undefined, "", false);
        expect(missingProject.state.status).toBe("idle");

        const rejected = new AssetBrowserController(
            fakeClient(undefined, {
                listAssetKindCounts: vi.fn(async () => ({ status: "failed", diagnostics: [ERROR] })),
            }),
        );
        await rejected.load("global", undefined, "", false);
        expect(rejected.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.load_failed" },
            diagnostics: [ERROR],
        });

        const interrupted = new AssetBrowserController(
            fakeClient(undefined, {
                listAssetKindCounts: vi.fn(async () => {
                    throw new Error("offline");
                }),
            }),
        );
        await interrupted.load("global", undefined, "", false);
        expect(interrupted.state).toMatchObject({ status: "failed", message: { kind: "localized" } });
    });

    it("keeps a failed Asset page attached to its exact kind and ignores stale work after disposal", async () => {
        const rejected = new AssetBrowserController(
            fakeClient(undefined, {
                queryAssetLibrary: vi.fn(async () => ({ status: "failed", diagnostics: [ERROR] })),
            }),
        );
        await rejected.load("projects", PROJECT_ID, "", false);
        await rejected.loadKind("project", "Guidance");
        expect(readyState(rejected).collections[0]?.kinds[0]).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.load_failed" },
            diagnostics: [ERROR],
        });

        let resolveCounts:
            | ((value: { status: "complete"; value: { counts: readonly [] }; diagnostics: readonly [] }) => void)
            | undefined;
        const delayed = new AssetBrowserController(
            fakeClient(undefined, {
                listAssetKindCounts: vi.fn(
                    () =>
                        new Promise((resolve) => {
                            resolveCounts = resolve;
                        }),
                ),
            }),
        );
        const load = delayed.load("global", undefined, "", false);
        delayed.dispose();
        resolveCounts?.({ status: "complete", value: { counts: [] }, diagnostics: [] });
        await load;
        expect(delayed.state.status).toBe("loading");
    });
});
