import { projectDisplayName } from "../../presentation/project-label";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
    SETTINGS_CATEGORIES,
    SETTINGS_CATEGORY_PRESENTATION,
    type WorkbenchLibraryRoute,
    type WorkbenchRoute,
} from "../../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../../client";
import { nonInformationalProtocolDiagnostics, ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { DesktopIcon, WorkbenchDialog } from "../../ui";
import { ASSET_KIND_MESSAGE_IDS, ASSET_KIND_ORDER, type AssetSummaryView } from "../project-library/model";
import {
    boundedCatalogSearchInput,
    type CatalogSearchAssetMatch,
    type CatalogSearchItem,
    type CatalogSearchProjectMatch,
    type CatalogSearchState,
    catalogSearchAssetRoute,
    catalogSearchProjectRoute,
    segmentCatalogSearchText,
} from "./catalog-search-model";

export interface CatalogSearchOverlayProps {
    readonly client: DesktopApplicationClientApi;
    readonly currentLibraryRoute?: WorkbenchLibraryRoute;
    readonly onClose: () => void;
    readonly onNavigate: (route: WorkbenchRoute) => void;
}

type ContextSearchState =
    | { readonly status: "idle" | "loading" }
    | { readonly status: "ready"; readonly items: readonly CatalogSearchItem[]; readonly hasMore: boolean }
    | { readonly status: "failed" };

function folded(value: string): string {
    return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function matchesNavigation(query: string, ...values: readonly string[]): boolean {
    const needle = folded(query.trim());
    return needle === "" || values.some((value) => folded(value).includes(needle));
}

function nextActionableIndex(items: readonly CatalogSearchItem[], currentIndex: number, direction: 1 | -1): number {
    for (let offset = 1; offset <= items.length; offset += 1) {
        const candidateIndex = (currentIndex + direction * offset + items.length) % items.length;
        if (items[candidateIndex]?.route !== undefined) return candidateIndex;
    }
    return currentIndex;
}

function HighlightedSearchText({ value, query }: { readonly value: string; readonly query: string }): React.JSX.Element {
    return (
        <>
            {segmentCatalogSearchText(value, query).map((segment, index) =>
                segment.matched ? (
                    <mark data-oaam-search-match key={`${String(index)}-${segment.text}`}>
                        {segment.text}
                    </mark>
                ) : (
                    segment.text
                ),
            )}
        </>
    );
}

function contextualAssetRoute(route: WorkbenchLibraryRoute, asset: AssetSummaryView): WorkbenchLibraryRoute | undefined {
    if (route.subject === "global") {
        return {
            surface: "library",
            subject: "global",
            collection: "global",
            kind: asset.kind,
            assetId: asset.assetId,
        };
    }
    if (route.projectId === undefined) return undefined;
    return {
        surface: "library",
        subject: "projects",
        projectId: route.projectId,
        collection: "project",
        kind: asset.kind,
        assetId: asset.assetId,
    };
}

export function CatalogSearchOverlay({
    client,
    currentLibraryRoute,
    onClose,
    onNavigate,
}: CatalogSearchOverlayProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const inputRef = useRef<HTMLInputElement>(null);
    const generation = useRef(0);
    const contextGeneration = useRef(0);
    const [query, setQuery] = useState("");
    const [state, setState] = useState<CatalogSearchState>({ status: "idle" });
    const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(() => new Map());
    const projectNameLookup = useMemo(() => {
        const names = new Map<string, string>();
        const pending = new Map<string, Promise<string | undefined>>();
        return {
            names,
            get(projectId: string): Promise<string | undefined> {
                let lookup = pending.get(projectId);
                if (lookup === undefined) {
                    lookup = (async () => {
                        try {
                            const result = await client.getProject({ projectId });
                            return result.status !== "failed" && result.value.found
                                ? projectDisplayName(result.value.value)
                                : undefined;
                        } catch {
                            return undefined;
                        }
                    })();
                    pending.set(projectId, lookup);
                }
                return lookup;
            },
        };
    }, [client]);
    const [contextState, setContextState] = useState<ContextSearchState>({ status: "idle" });
    const [activeIndex, setActiveIndex] = useState(0);

    const navigationItems = useMemo(() => {
        const candidates = [
            {
                id: "navigation-projects",
                title: text("search.navigation.projects"),
                detail: text("search.navigation.projects_detail"),
                route: { surface: "library", subject: "projects" } as const,
            },
            {
                id: "navigation-global",
                title: text("search.navigation.global"),
                detail: text("search.navigation.global_detail"),
                route: { surface: "library", subject: "global" } as const,
            },
            ...SETTINGS_CATEGORIES.map((category) => ({
                id: `navigation-settings-${category}`,
                title: text(SETTINGS_CATEGORY_PRESENTATION[category].title),
                detail: text(SETTINGS_CATEGORY_PRESENTATION[category].copy),
                searchAlias: text("search.navigation.settings"),
                route: { surface: "settings", category } as const,
            })),
        ];
        return candidates
            .filter((candidate) =>
                matchesNavigation(
                    query,
                    candidate.title,
                    candidate.detail,
                    "searchAlias" in candidate ? (candidate.searchAlias ?? "") : "",
                ),
            )
            .map(
                (candidate): CatalogSearchItem =>
                    Object.freeze({
                        itemKind: "navigation",
                        ...candidate,
                    }),
            );
    }, [query, text]);

    useEffect(() => {
        const normalized = query.trim();
        const requestGeneration = ++generation.current;
        if (normalized === "") {
            setState({ status: "idle" });
            return;
        }
        setState({ status: "loading" });
        const timer = window.setTimeout(() => {
            void client
                .searchCatalog({ query: normalized, limitPerGroup: 20 })
                .then((result) => {
                    if (generation.current !== requestGeneration) return;
                    if (result.status === "failed") {
                        setState({
                            status: "failed",
                            diagnostics: nonInformationalProtocolDiagnostics(result.diagnostics),
                        });
                        return;
                    }
                    setState({
                        status: "ready",
                        value: result.value,
                        partial: result.status === "partial",
                        diagnostics: nonInformationalProtocolDiagnostics(result.diagnostics),
                    });
                })
                .catch(() => {
                    if (generation.current === requestGeneration) {
                        setState({ status: "failed", diagnostics: [] });
                    }
                });
        }, 140);
        return () => {
            window.clearTimeout(timer);
            if (generation.current === requestGeneration) generation.current += 1;
        };
    }, [client, query]);

    useEffect(() => {
        const normalized = query.trim();
        const requestGeneration = ++contextGeneration.current;
        if (
            normalized === "" ||
            currentLibraryRoute === undefined ||
            (currentLibraryRoute.subject === "projects" && currentLibraryRoute.projectId === undefined) ||
            !client.supportsOperation("asset_library.kind_counts") ||
            !client.supportsOperation("asset_library.page")
        ) {
            setContextState({ status: "idle" });
            return;
        }
        setContextState({ status: "loading" });
        const timer = window.setTimeout(() => {
            const subject =
                currentLibraryRoute.subject === "global"
                    ? ({ scope: "global" } as const)
                    : ({ scope: "project", projectId: currentLibraryRoute.projectId as string } as const);
            void client
                .listAssetKindCounts({ subject, keywords: normalized, includeDeleted: false })
                .then(async (countsOutcome) => {
                    if (contextGeneration.current !== requestGeneration) return;
                    if (countsOutcome.status === "failed") {
                        setContextState({ status: "failed" });
                        return;
                    }
                    const nonEmptyKinds = ASSET_KIND_ORDER.filter(
                        (kind) => (countsOutcome.value.counts.find((entry) => entry.kind === kind)?.count ?? 0) > 0,
                    );
                    const pageOutcomes = await Promise.all(
                        nonEmptyKinds.map(async (kind) => ({
                            kind,
                            outcome: await client.queryAssetLibrary({
                                subject,
                                kind,
                                keywords: normalized,
                                includeDeleted: false,
                                pageSize: 20,
                            }),
                        })),
                    );
                    if (contextGeneration.current !== requestGeneration) return;
                    if (pageOutcomes.some(({ outcome }) => outcome.status === "failed")) {
                        setContextState({ status: "failed" });
                        return;
                    }
                    const assets = pageOutcomes.flatMap(({ outcome }) =>
                        outcome.status === "failed" ? [] : outcome.value.assets,
                    );
                    const items = assets.slice(0, 20).flatMap((asset): readonly CatalogSearchItem[] => {
                        const route = contextualAssetRoute(currentLibraryRoute, asset);
                        return route === undefined
                            ? []
                            : [
                                  Object.freeze({
                                      itemKind: "asset" as const,
                                      id: `current-asset-${asset.assetId}`,
                                      title: asset.displayName,
                                      detail: text(ASSET_KIND_MESSAGE_IDS[asset.kind]),
                                      snippet: asset.displayDescription,
                                      route,
                                  }),
                              ];
                    });
                    const totalCount = countsOutcome.value.counts.reduce((total, entry) => total + entry.count, 0);
                    setContextState({
                        status: "ready",
                        items: Object.freeze(items),
                        hasMore:
                            totalCount > items.length ||
                            pageOutcomes.some(({ outcome }) => outcome.status !== "failed" && outcome.value.hasMore),
                    });
                })
                .catch(() => {
                    if (contextGeneration.current === requestGeneration) setContextState({ status: "failed" });
                });
        }, 140);
        return () => {
            window.clearTimeout(timer);
            if (contextGeneration.current === requestGeneration) contextGeneration.current += 1;
        };
    }, [client, currentLibraryRoute, query, text]);

    useEffect(() => {
        let active = true;
        if (state.status !== "ready") return;
        const knownProjectNames = projectNameLookup.names;
        for (const project of state.value.projects.items) knownProjectNames.set(project.projectId, projectDisplayName(project));
        setProjectNames(new Map(knownProjectNames));
        const ids = [
            ...new Set(
                state.value.assets.items.flatMap((match) =>
                    match.scope === "project" && match.projectId !== undefined && !knownProjectNames.has(match.projectId)
                        ? [match.projectId]
                        : [],
                ),
            ),
        ];
        void Promise.all(
            ids.map(async (projectId) => {
                const name = await projectNameLookup.get(projectId);
                if (name !== undefined && !knownProjectNames.has(projectId)) knownProjectNames.set(projectId, name);
            }),
        ).then(() => {
            if (active) setProjectNames(new Map(knownProjectNames));
        });
        return () => {
            active = false;
        };
    }, [state, projectNameLookup]);

    const projectItems = useMemo(() => {
        if (state.status !== "ready") return [];
        return state.value.projects.items.map(
            (match: CatalogSearchProjectMatch): CatalogSearchItem =>
                Object.freeze({
                    itemKind: "project",
                    id: `project-${match.projectId}`,
                    title: projectDisplayName(match),
                    detail: match.deleted ? text("search.project.retained", { path: match.rootPath }) : match.rootPath,
                    snippet: match.snippet,
                    route: catalogSearchProjectRoute(match),
                    retained: match.deleted,
                }),
        );
    }, [state, text]);

    const assetItems = useMemo(() => {
        if (state.status !== "ready") return [];
        return state.value.assets.items.map(
            (match: CatalogSearchAssetMatch): CatalogSearchItem =>
                Object.freeze({
                    itemKind: "asset",
                    id: `asset-${match.assetId}`,
                    title: match.displayName,
                    detail: `${match.scope === "global" ? text("library.tree.global_assets") : (projectNames.get(match.projectId ?? "") ?? text("library.tree.projects"))} · ${
                        "logicalPath" in match
                            ? text("search.asset.file_match", {
                                  kind: text(ASSET_KIND_MESSAGE_IDS[match.kind]),
                                  path: match.logicalPath,
                              })
                            : text("search.asset.metadata_match", {
                                  kind: text(ASSET_KIND_MESSAGE_IDS[match.kind]),
                                  field: text(`search.match.${match.matchedField}`),
                              })
                    }`,
                    snippet: match.snippet.trim() === match.displayName.trim() ? "" : match.snippet,
                    route: catalogSearchAssetRoute(match),
                }),
        );
    }, [state, text, projectNames]);

    const contextItems = contextState.status === "ready" ? contextState.items : [];
    const currentAssetIds = useMemo(
        () =>
            new Set(
                contextItems
                    .filter(
                        (item): item is Extract<CatalogSearchItem, { readonly itemKind: "asset" }> => item.itemKind === "asset",
                    )
                    .map((item) => item.id.replace(/^current-asset-/u, "")),
            ),
        [contextItems],
    );
    const otherItems = useMemo(
        () =>
            Object.freeze([
                ...projectItems.filter(
                    (item) =>
                        currentLibraryRoute?.subject !== "projects" ||
                        currentLibraryRoute.projectId === undefined ||
                        item.id !== `project-${currentLibraryRoute.projectId}`,
                ),
                ...assetItems.filter((item) => !currentAssetIds.has(item.id.replace(/^asset-/u, ""))),
                ...navigationItems,
            ]),
        [assetItems, currentAssetIds, currentLibraryRoute, navigationItems, projectItems],
    );
    const items = useMemo(() => Object.freeze([...contextItems, ...otherItems]), [contextItems, otherItems]);

    useEffect(() => {
        setActiveIndex((current) => {
            if (items[current]?.route !== undefined) return current;
            const firstActionable = items.findIndex((item) => item.route !== undefined);
            return firstActionable < 0 ? 0 : firstActionable;
        });
    }, [items]);

    function activate(item: CatalogSearchItem | undefined): void {
        if (item?.route === undefined) return;
        onClose();
        onNavigate(item.route);
    }

    function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (items.length === 0) return;
            setActiveIndex((current) => nextActionableIndex(items, current, event.key === "ArrowDown" ? 1 : -1));
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            const activeItem = items[activeIndex];
            activate(activeItem?.route === undefined ? items.find((item) => item.route !== undefined) : activeItem);
        }
    }

    function renderGroup(label: string, groupItems: readonly CatalogSearchItem[]): React.JSX.Element | null {
        if (groupItems.length === 0) return null;
        return (
            <section className="catalog-search-group" aria-label={label}>
                <h3>{label}</h3>
                <div>
                    {groupItems.map((item) => {
                        const index = items.indexOf(item);
                        return (
                            <button
                                type="button"
                                className="catalog-search-result"
                                data-oaam-semantic-action="search.open_result"
                                data-oaam-semantic-entry="search.result.row"
                                data-active={index === activeIndex}
                                disabled={item.route === undefined}
                                id={`oaam-catalog-search-${item.id}`}
                                key={item.id}
                                tabIndex={-1}
                                onClick={() => activate(item)}
                                onPointerMove={() => setActiveIndex(index)}
                            >
                                <span className="catalog-search-result-icon" aria-hidden="true">
                                    <DesktopIcon
                                        name={
                                            item.itemKind === "project"
                                                ? "reveal"
                                                : item.itemKind === "asset"
                                                  ? "search"
                                                  : "forward"
                                        }
                                        size={15}
                                    />
                                </span>
                                <span>
                                    <strong>
                                        <HighlightedSearchText query={query} value={item.title} />
                                    </strong>
                                    <small>
                                        <HighlightedSearchText query={query} value={item.detail} />
                                    </small>
                                    {"snippet" in item && item.snippet !== "" ? (
                                        <span className="catalog-search-result-snippet">
                                            <HighlightedSearchText query={query} value={item.snippet} />
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>
        );
    }

    const expectsContextResults =
        currentLibraryRoute !== undefined &&
        (currentLibraryRoute.subject === "global" || currentLibraryRoute.projectId !== undefined) &&
        client.supportsOperation("asset_library.kind_counts") &&
        client.supportsOperation("asset_library.page");
    const noResult =
        query.trim() !== "" &&
        state.status === "ready" &&
        (!expectsContextResults || contextState.status === "ready" || contextState.status === "failed") &&
        contextItems.length === 0 &&
        otherItems.length === 0;
    const activeItem = items[activeIndex]?.route === undefined ? undefined : items[activeIndex];

    return (
        <WorkbenchDialog
            data-oaam-interaction-entry="features.catalog-search.catalog_search_overlay.002"
            className="catalog-search-dialog"
            closeLabel={text("common.close")}
            dialogId="catalog_search"
            initialFocusRef={inputRef}
            title={text("search.title")}
            onClose={onClose}
        >
            <div className="catalog-search-input">
                <DesktopIcon name="search" />
                <input
                    data-oaam-interaction-entry="features.catalog-search.catalog_search_overlay.003"
                    ref={inputRef}
                    type="search"
                    value={query}
                    aria-activedescendant={activeItem === undefined ? undefined : `oaam-catalog-search-${activeItem.id}`}
                    aria-controls="oaam-catalog-search-results"
                    aria-label={text("search.input_label")}
                    placeholder={text("search.placeholder")}
                    onChange={(event) => {
                        setQuery(boundedCatalogSearchInput(event.currentTarget.value));
                        setActiveIndex(0);
                    }}
                    onKeyDown={handleInputKeyDown}
                />
            </div>
            <p className="catalog-search-hint">{text("search.keyboard_hint")}</p>
            <div className="catalog-search-results" id="oaam-catalog-search-results" aria-live="polite">
                {state.status === "loading" ? <p>{text("search.loading")}</p> : null}
                {state.status === "failed" ? (
                    <>
                        <p role="alert">{text("search.failed")}</p>
                        <ProtocolDiagnostics
                            diagnostics={state.diagnostics}
                            technicalSummary={text("import.ui.technical_details")}
                        />
                    </>
                ) : null}
                {state.status === "ready" && state.partial ? <p>{text("search.partial")}</p> : null}
                {state.status === "ready" ? (
                    <ProtocolDiagnostics diagnostics={state.diagnostics} technicalSummary={text("import.ui.technical_details")} />
                ) : null}
                {contextState.status === "failed" ? <p>{text("search.current_failed")}</p> : null}
                {contextState.status === "ready" && contextState.hasMore ? (
                    <p>{text("search.current_limited", { count: contextState.items.length })}</p>
                ) : null}
                {noResult ? <p>{text("search.no_results")}</p> : null}
                {renderGroup(
                    text(
                        currentLibraryRoute?.subject === "global"
                            ? "search.group.current_global"
                            : "search.group.current_project",
                    ),
                    contextItems,
                )}
                {renderGroup(text("search.group.other"), otherItems)}
            </div>
        </WorkbenchDialog>
    );
}
