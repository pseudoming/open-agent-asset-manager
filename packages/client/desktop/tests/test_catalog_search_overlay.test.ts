import type { ProtocolDiagnosticV1, ProtocolOperationResult } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchRoute } from "../src/renderer/app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { CatalogSearchOverlay } from "../src/renderer/features/catalog-search";
import {
    boundedCatalogSearchInput,
    catalogSearchAssetRoute,
    segmentCatalogSearchText,
    supportsCatalogSearch,
} from "../src/renderer/features/catalog-search/catalog-search-model";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";
import { clickSemanticAction } from "./semantic-action-test-harness";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";

function diagnostic(message: string, causeKind: ProtocolDiagnosticV1["causeKind"] = "unknown"): ProtocolDiagnosticV1 {
    return {
        severity: "error",
        code: "catalog.search_failed",
        operation: "search",
        causeKind,
        retryable: true,
        suggestedActions: ["retry"],
        message,
        path: "C:\\Users\\private\\catalog.db",
        traceId: "catalog-search-private-trace",
    };
}

afterEach(cleanup);

function result(
    projectName = "Project Atlas",
    assetName = "Guidance map",
): Extract<ProtocolOperationResult<"catalog.search">, { readonly value: unknown }> {
    return {
        status: "complete",
        value: {
            projects: {
                items: [
                    {
                        projectId: PROJECT_ID,
                        displayName: projectName,
                        rootPath: "/workspace/atlas",
                        deleted: false,
                        matchedField: "display_name",
                        snippet: projectName,
                    },
                ],
                totalCount: 1,
            },
            assets: {
                items: [
                    {
                        assetId: ASSET_ID,
                        kind: "Guidance",
                        scope: "project",
                        projectId: PROJECT_ID,
                        scopePath: "",
                        displayName: assetName,
                        matchedField: "text_content",
                        logicalPath: "AGENTS.md",
                        snippet: "portable guidance",
                    },
                ],
                totalCount: 1,
            },
        },
        diagnostics: [],
    };
}

function searchClient(searchCatalog: DesktopApplicationClientApi["searchCatalog"]): DesktopApplicationClientApi {
    return { searchCatalog } as DesktopApplicationClientApi;
}

describe("Desktop catalog search overlay", () => {
    it("opens on the search field and exposes finite navigation without calling Core for a blank query", async () => {
        const searchCatalog = vi.fn();
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: searchClient(searchCatalog),
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );

        const input = screen.getByRole("searchbox", { name: "Search OAAM" });
        await vi.waitFor(() => expect(document.activeElement).toBe(input));
        expect(screen.getByRole("button", { name: /Projects/u })).not.toBeNull();
        expect(screen.getByRole("button", { name: /Global library/u })).not.toBeNull();
        expect(screen.getByRole("button", { name: /General/u })).not.toBeNull();
        expect(screen.getByRole("button", { name: /Locations and AI coding tools/u })).not.toBeNull();
        expect(screen.getByRole("button", { name: /Data safety/u })).not.toBeNull();
        expect(searchCatalog).not.toHaveBeenCalled();
    });

    it("debounces the bounded query, groups plain-text results, and activates an exact Asset route", async () => {
        const searchCatalog = vi.fn(async () => result("Project Atlas", "Guide map"));
        const onClose = vi.fn();
        const onNavigate = vi.fn<(route: WorkbenchRoute) => void>();
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: searchClient(searchCatalog),
                onClose,
                onNavigate,
            }),
        );

        const input = screen.getByRole("searchbox", { name: "Search OAAM" });
        fireEvent.change(input, { target: { value: "guide" } });
        expect(screen.getByText("Searching the current catalog…")).not.toBeNull();
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledWith({ query: "guide", limitPerGroup: 20 }));
        expect(await screen.findByRole("button", { name: /^Project Atlas/u })).not.toBeNull();
        expect(screen.getByRole("button", { name: /Guide map/u }).textContent).toContain("portable guidance");
        expect([...document.querySelectorAll("[data-oaam-search-match]")].map((match) => match.textContent)).toEqual(["Guide"]);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onClose).toHaveBeenCalledOnce();
        expect(onNavigate).toHaveBeenCalledWith({
            surface: "library",
            subject: "projects",
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
        });
    });

    it("reuses one Project lookup across queries and publishes its name without delaying Asset results", async () => {
        let resolveProject: ((value: unknown) => void) | undefined;
        const getProject = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveProject = resolve;
                }),
        );
        const searchCatalog = vi.fn(async () => {
            const outcome = result();
            return { ...outcome, value: { ...outcome.value, projects: { items: [], totalCount: 0 } } };
        });
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: { searchCatalog, getProject } as unknown as DesktopApplicationClientApi,
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );
        const input = screen.getByRole("searchbox", { name: "Search OAAM" });
        fireEvent.change(input, { target: { value: "guidance" } });
        expect(await screen.findByRole("button", { name: /Guidance map/u })).not.toBeNull();
        await vi.waitFor(() => expect(getProject).toHaveBeenCalledTimes(1));
        fireEvent.change(input, { target: { value: "map" } });
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(2));
        expect(getProject).toHaveBeenCalledTimes(1);
        await act(async () =>
            resolveProject?.({
                status: "complete",
                value: { found: true, value: { displayName: "Documentation workspace" } },
                diagnostics: [],
            }),
        );
        await vi.waitFor(() =>
            expect(screen.getByRole("button", { name: /Guidance map/u }).textContent).toContain("Documentation workspace"),
        );
        fireEvent.change(input, { target: { value: "portable" } });
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(3));
        expect(getProject).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: /Guidance map/u }).textContent).toContain("Documentation workspace");
    });

    it("keeps a late Project name bound to its ID and retains usable results when another lookup fails", async () => {
        let resolveProject: ((value: unknown) => void) | undefined;
        const otherProjectId = "33333333-3333-4333-8333-333333333333";
        const getProject = vi.fn(({ projectId }: { projectId: string }) =>
            projectId === PROJECT_ID
                ? new Promise((resolve) => {
                      resolveProject = resolve;
                  })
                : Promise.reject(new Error("unavailable")),
        );
        const searchCatalog = vi.fn(async ({ query }: { query: string }) => {
            const outcome = result();
            return {
                ...outcome,
                value: {
                    projects: { items: [], totalCount: 0 },
                    assets: {
                        ...outcome.value.assets,
                        items: outcome.value.assets.items.map((asset) => ({
                            ...asset,
                            projectId: query === "first" ? PROJECT_ID : otherProjectId,
                        })),
                    },
                },
            };
        });
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: { searchCatalog, getProject } as unknown as DesktopApplicationClientApi,
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );
        const input = screen.getByRole("searchbox", { name: "Search OAAM" });
        fireEvent.change(input, { target: { value: "first" } });
        await vi.waitFor(() => expect(getProject).toHaveBeenCalledTimes(1));
        fireEvent.change(input, { target: { value: "second" } });
        await vi.waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
        await act(async () =>
            resolveProject?.({
                status: "complete",
                value: { found: true, value: { displayName: "First workspace" } },
                diagnostics: [],
            }),
        );
        expect(screen.getByRole("button", { name: /Guidance map/u }).textContent).not.toContain("First workspace");
        fireEvent.change(input, { target: { value: "third" } });
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(3));
        expect(getProject).toHaveBeenCalledTimes(2);
    });

    it("queries the exact current library subject before deduplicated catalog-wide results", async () => {
        const otherProjectId = "33333333-3333-4333-8333-333333333333";
        const otherAssetId = "44444444-4444-4444-8444-444444444444";
        const catalogOutcome = result("Project Atlas", "Project guide");
        if (catalogOutcome.status !== "complete") throw new Error("catalog fixture must be complete");
        const duplicateAsset = catalogOutcome.value.assets.items[0];
        const currentProject = catalogOutcome.value.projects.items[0];
        if (duplicateAsset === undefined || currentProject === undefined) throw new Error("catalog fixture is incomplete");
        const searchCatalog = vi.fn(async () => ({
            ...catalogOutcome,
            value: {
                projects: {
                    items: [
                        currentProject,
                        {
                            ...currentProject,
                            projectId: otherProjectId,
                            displayName: "Other workspace",
                            snippet: "Other workspace",
                        },
                    ],
                    totalCount: 2,
                },
                assets: {
                    items: [
                        { ...duplicateAsset, displayName: "Project guide" },
                        {
                            ...duplicateAsset,
                            assetId: otherAssetId,
                            scope: "global" as const,
                            projectId: undefined,
                            displayName: "Global guide",
                            snippet: "global guidance",
                        },
                    ],
                    totalCount: 2,
                },
            },
        }));
        const listAssetKindCounts = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                counts: [
                    { kind: "Guidance" as const, count: 1 },
                    { kind: "Rule" as const, count: 0 },
                    { kind: "Workflow" as const, count: 0 },
                    { kind: "Skill" as const, count: 0 },
                    { kind: "Subagent" as const, count: 0 },
                    { kind: "Memory" as const, count: 0 },
                ],
            },
            diagnostics: [],
        }));
        const queryAssetLibrary = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                assets: [
                    {
                        assetId: ASSET_ID,
                        kind: "Guidance" as const,
                        scope: "project" as const,
                        projectId: PROJECT_ID,
                        scopePath: "",
                        displayName: "Project guide",
                        displayDescription: "Current Project guidance",
                        currentVersionId: "55555555-5555-4555-8555-555555555555",
                        currentRevision: 1,
                        currentFingerprint: "a".repeat(64),
                        currentVersionStatus: "complete" as const,
                        deleted: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                totalCount: 1,
                hasMore: false,
            },
            diagnostics: [],
        }));
        const client = {
            searchCatalog,
            listAssetKindCounts,
            queryAssetLibrary,
            supportsOperation: (operation: string) =>
                operation === "asset_library.kind_counts" || operation === "asset_library.page",
        } as unknown as DesktopApplicationClientApi;
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client,
                currentLibraryRoute: {
                    surface: "library",
                    subject: "projects",
                    projectId: PROJECT_ID,
                    collection: "project",
                },
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );

        fireEvent.change(screen.getByRole("searchbox", { name: "Search OAAM" }), { target: { value: "guide" } });
        const currentGroup = await screen.findByRole("region", { name: "Current Project" });
        const otherGroup = await screen.findByRole("region", { name: "Other results" });
        expect(within(currentGroup).getByRole("button", { name: /Project guide/u })).not.toBeNull();
        expect(within(otherGroup).getByRole("button", { name: /Global guide/u })).not.toBeNull();
        expect(within(otherGroup).getByRole("button", { name: /Other workspace/u })).not.toBeNull();
        expect(within(otherGroup).queryByRole("button", { name: /Project guide/u })).toBeNull();
        expect(within(otherGroup).queryByRole("button", { name: /^Project Atlas/u })).toBeNull();
        expect(listAssetKindCounts).toHaveBeenCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            keywords: "guide",
            includeDeleted: false,
        });
        expect(queryAssetLibrary).toHaveBeenCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            kind: "Guidance",
            keywords: "guide",
            includeDeleted: false,
            pageSize: 20,
        });
    });

    it("builds an exact current-Global Asset route and activates it from the contextual group", async () => {
        const globalAssetId = "66666666-6666-4666-8666-666666666666";
        const searchCatalog = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                projects: { items: [], totalCount: 0 },
                assets: { items: [], totalCount: 0 },
            },
            diagnostics: [],
        }));
        const listAssetKindCounts = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                counts: [
                    { kind: "Guidance" as const, count: 1 },
                    { kind: "Rule" as const, count: 0 },
                    { kind: "Workflow" as const, count: 0 },
                    { kind: "Skill" as const, count: 0 },
                    { kind: "Subagent" as const, count: 0 },
                    { kind: "Memory" as const, count: 0 },
                ],
            },
            diagnostics: [],
        }));
        const queryAssetLibrary = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                assets: [
                    {
                        assetId: globalAssetId,
                        kind: "Guidance" as const,
                        scope: "global" as const,
                        scopePath: "",
                        displayName: "Global guidance",
                        displayDescription: "Reusable guidance",
                        currentVersionId: "77777777-7777-4777-8777-777777777777",
                        currentRevision: 1,
                        currentFingerprint: "b".repeat(64),
                        currentVersionStatus: "complete" as const,
                        deleted: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                totalCount: 1,
                hasMore: false,
            },
            diagnostics: [],
        }));
        const client = {
            searchCatalog,
            listAssetKindCounts,
            queryAssetLibrary,
            supportsOperation: (operation: string) =>
                operation === "asset_library.kind_counts" || operation === "asset_library.page",
        } as unknown as DesktopApplicationClientApi;
        const onNavigate = vi.fn<(route: WorkbenchRoute) => void>();
        const onClose = vi.fn();
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client,
                currentLibraryRoute: {
                    surface: "library",
                    subject: "global",
                    collection: "global",
                },
                onClose,
                onNavigate,
            }),
        );

        fireEvent.change(screen.getByRole("searchbox", { name: "Search OAAM" }), { target: { value: "global" } });
        const currentGroup = await screen.findByRole("region", { name: "Current Global assets" });
        const assetButton = within(currentGroup).getByRole("button", { name: /Global guidance/u });
        fireEvent.pointerMove(assetButton);
        await clickSemanticAction("search.result.row", "search.open_result", {
            expected: onNavigate,
            expectedArgs: [
                {
                    surface: "library",
                    subject: "global",
                    collection: "global",
                    kind: "Guidance",
                    assetId: globalAssetId,
                },
            ],
            unrelated: [],
            root: assetButton,
        });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("reports count, page, and transport failures only for the current-page result group", async () => {
        const emptyCatalog = {
            status: "complete" as const,
            value: {
                projects: { items: [], totalCount: 0 },
                assets: { items: [], totalCount: 0 },
            },
            diagnostics: [],
        };
        const completeCounts = {
            status: "complete" as const,
            value: {
                counts: [
                    { kind: "Guidance" as const, count: 1 },
                    { kind: "Rule" as const, count: 0 },
                    { kind: "Workflow" as const, count: 0 },
                    { kind: "Skill" as const, count: 0 },
                    { kind: "Subagent" as const, count: 0 },
                    { kind: "Memory" as const, count: 0 },
                ],
            },
            diagnostics: [],
        };
        const listAssetKindCounts = vi
            .fn()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [] })
            .mockResolvedValueOnce(completeCounts)
            .mockRejectedValueOnce(new Error("current-page transport"));
        const queryAssetLibrary = vi.fn().mockResolvedValueOnce({ status: "failed", diagnostics: [] });
        const client = {
            searchCatalog: vi.fn(async () => emptyCatalog),
            listAssetKindCounts,
            queryAssetLibrary,
            supportsOperation: (operation: string) =>
                operation === "asset_library.kind_counts" || operation === "asset_library.page",
        } as unknown as DesktopApplicationClientApi;
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client,
                currentLibraryRoute: {
                    surface: "library",
                    subject: "global",
                    collection: "global",
                },
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );
        const input = screen.getByRole("searchbox", { name: "Search OAAM" });

        fireEvent.change(input, { target: { value: "count failure" } });
        expect(
            await screen.findByText("Current-page results could not be loaded. Other results are still available."),
        ).not.toBeNull();
        fireEvent.change(input, { target: { value: "page failure" } });
        await vi.waitFor(() => expect(queryAssetLibrary).toHaveBeenCalledOnce());
        expect(
            await screen.findByText("Current-page results could not be loaded. Other results are still available."),
        ).not.toBeNull();
        fireEvent.change(input, { target: { value: "transport failure" } });
        await vi.waitFor(() => expect(listAssetKindCounts).toHaveBeenCalledTimes(3));
        expect(
            await screen.findByText("Current-page results could not be loaded. Other results are still available."),
        ).not.toBeNull();
    });

    it("renders an exact no-result state after a completed empty query", async () => {
        const searchCatalog = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                projects: { items: [], totalCount: 0 },
                assets: { items: [], totalCount: 0 },
            },
            diagnostics: [],
        }));
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: searchClient(searchCatalog),
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );

        fireEvent.change(screen.getByRole("searchbox", { name: "Search OAAM" }), { target: { value: "missing" } });
        expect(await screen.findByText("No current Project, Asset, or destination matches this search.")).not.toBeNull();
        expect(searchCatalog).toHaveBeenCalledWith({ query: "missing", limitPerGroup: 20 });
    });

    it("fails closed for a malformed Project Asset route and keyboard navigation skips it", async () => {
        const malformed = result();
        if (malformed.status !== "complete") throw new Error("catalog fixture must be complete");
        const asset = malformed.value.assets.items[0];
        if (asset === undefined) throw new Error("catalog Asset fixture missing");
        const withoutProject = {
            ...asset,
            projectId: undefined,
        };
        const searchCatalog = vi.fn(async () => ({
            ...malformed,
            value: {
                projects: { items: [], totalCount: 0 },
                assets: { items: [withoutProject], totalCount: 1 },
            },
        }));
        const onNavigate = vi.fn<(route: WorkbenchRoute) => void>();
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: searchClient(searchCatalog as DesktopApplicationClientApi["searchCatalog"]),
                onClose: vi.fn(),
                onNavigate,
            }),
        );

        const input = screen.getByRole("searchbox", { name: "Search OAAM" });
        fireEvent.change(input, { target: { value: "settings" } });
        const malformedButton = await screen.findByRole("button", { name: /Guidance map/u });
        expect(malformedButton.hasAttribute("disabled")).toBe(true);
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onNavigate).toHaveBeenCalledWith({ surface: "settings", category: "general" });
        expect(catalogSearchAssetRoute(withoutProject)).toBeUndefined();

        const navigationCount = onNavigate.mock.calls.length;
        fireEvent.change(input, { target: { value: "no-actionable-route" } });
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(2));
        expect((await screen.findByRole("button", { name: /Guidance map/u })).hasAttribute("disabled")).toBe(true);
        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onNavigate).toHaveBeenCalledTimes(navigationCount);
    });

    it("ignores stale completions and reports partial, failed, and transport-failed outcomes truthfully", async () => {
        let resolveFirst: ((value: ProtocolOperationResult<"catalog.search">) => void) | undefined;
        const first = new Promise<ProtocolOperationResult<"catalog.search">>((resolve) => {
            resolveFirst = resolve;
        });
        const searchCatalog = vi
            .fn<DesktopApplicationClientApi["searchCatalog"]>()
            .mockImplementationOnce(async () => first)
            .mockResolvedValueOnce(result("Second Project", "Second Asset"))
            .mockResolvedValueOnce({
                ...result("Partial Project", "Partial Asset"),
                status: "partial",
                diagnostics: [diagnostic("Partial source leaked private search evidence", "partial")],
            })
            .mockResolvedValueOnce({
                status: "failed",
                diagnostics: [diagnostic("Exact search failure leaked private search evidence")],
            })
            .mockRejectedValueOnce(new Error("transport"));
        renderWithPresentation(
            createElement(CatalogSearchOverlay, {
                client: searchClient(searchCatalog),
                onClose: vi.fn(),
                onNavigate: vi.fn(),
            }),
        );
        const dialog = screen.getByRole("dialog", { name: "Search OAAM" });
        const input = screen.getByRole("searchbox", { name: "Search OAAM" });

        fireEvent.change(input, { target: { value: "first" } });
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(1));
        fireEvent.change(input, { target: { value: "second" } });
        expect(await screen.findByRole("button", { name: /Second Project/u })).not.toBeNull();
        await act(async () => resolveFirst?.(result("Stale Project", "Stale Asset")));
        expect(screen.queryByText("Stale Project")).toBeNull();

        fireEvent.change(input, { target: { value: "partial" } });
        expect(await screen.findByText("Some catalog sources were unavailable. Results below are incomplete.")).not.toBeNull();
        expect(ordinarySurfaceText(dialog)).not.toContain("Partial source leaked private search evidence");
        expect(dialog.textContent).toContain("Partial source leaked private search evidence");
        fireEvent.change(input, { target: { value: "failed" } });
        expect((await screen.findByRole("alert")).textContent).toBe("Search could not be completed. Try again.");
        expect(ordinarySurfaceText(dialog)).not.toContain("Exact search failure leaked private search evidence");
        expect(dialog.textContent).toContain("Exact search failure leaked private search evidence");
        fireEvent.change(input, { target: { value: "transport" } });
        expect((await screen.findByRole("alert")).textContent).toBe("Search could not be completed. Try again.");
        expect(dialog.textContent).not.toContain("Exact search failure leaked private search evidence");
        expect(screen.queryByText("Partial Project")).toBeNull();
    });

    it("does not publish a late completion into a reopened overlay", async () => {
        let resolveClosed: ((value: ProtocolOperationResult<"catalog.search">) => void) | undefined;
        const closedRequest = new Promise<ProtocolOperationResult<"catalog.search">>((resolve) => {
            resolveClosed = resolve;
        });
        const searchCatalog = vi
            .fn<DesktopApplicationClientApi["searchCatalog"]>()
            .mockImplementationOnce(async () => closedRequest)
            .mockResolvedValueOnce(result("Fresh Project", "Fresh Asset"));

        function Harness(): React.JSX.Element {
            const [open, setOpen] = useState(true);
            return createElement(
                "div",
                {},
                open
                    ? createElement(CatalogSearchOverlay, {
                          client: searchClient(searchCatalog),
                          onClose: () => setOpen(false),
                          onNavigate: vi.fn(),
                      })
                    : createElement("button", { type: "button", onClick: () => setOpen(true) }, "Reopen search"),
            );
        }

        renderWithPresentation(createElement(Harness));
        fireEvent.change(screen.getByRole("searchbox", { name: "Search OAAM" }), { target: { value: "closed" } });
        await vi.waitFor(() => expect(searchCatalog).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        fireEvent.click(screen.getByRole("button", { name: "Reopen search" }));
        fireEvent.change(screen.getByRole("searchbox", { name: "Search OAAM" }), { target: { value: "fresh" } });
        expect(await screen.findByRole("button", { name: /^Fresh Project/u })).not.toBeNull();

        await act(async () => resolveClosed?.(result("Closed Project", "Closed Asset")));
        expect(screen.queryByText("Closed Project")).toBeNull();
        expect(screen.getByRole("button", { name: /^Fresh Project/u })).not.toBeNull();
    });

    it("bounds search input by Unicode code points", () => {
        expect([...boundedCatalogSearchInput(`${"a".repeat(127)}😀tail`)]).toHaveLength(128);
        expect(supportsCatalogSearch({ supportsOperation: () => true } as DesktopApplicationClientApi)).toBe(true);
    });

    it("segments only the exact case-insensitive query terms and preserves source text", () => {
        const segments = segmentCatalogSearchText("Portable C++ Guidance", "guidance c++ guidance");
        expect(segments.map((segment) => segment.text).join("")).toBe("Portable C++ Guidance");
        expect(segments.filter((segment) => segment.matched).map((segment) => segment.text)).toEqual(["C++", "Guidance"]);
        expect(segmentCatalogSearchText("Unrelated", "guide")).toEqual([{ text: "Unrelated", matched: false }]);
    });
});
