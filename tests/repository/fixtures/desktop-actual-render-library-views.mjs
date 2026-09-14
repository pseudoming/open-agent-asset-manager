import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";

export async function inspectLibraryViewCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspect(entryValue, assertOrdinarySurfaceLanguage, ordinarySurfaceLanguageLexicon) {
            const waitFor = async (predicate, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(`timed out waiting for ${label}`);
            };
            const assert = (condition, message) => {
                if (!condition) throw new Error(`${entryValue.id}: ${message}`);
            };
            const click = (element, label) => {
                assert(element instanceof HTMLButtonElement, `${label} is not a button`);
                assert(!element.disabled, `${label} is disabled`);
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };
            const assertInsideViewport = (element, label) => {
                assert(element instanceof HTMLElement, `${label} is missing`);
                const bounds = element.getBoundingClientRect();
                assert(bounds.left >= 0, `${label} escapes the left viewport edge`);
                assert(bounds.top >= 0, `${label} escapes the top viewport edge`);
                assert(bounds.right <= window.innerWidth + 1, `${label} escapes the right viewport edge`);
                assert(bounds.bottom <= window.innerHeight + 1, `${label} escapes the bottom viewport edge`);
            };

            await waitFor(
                () => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"),
                "ready Asset library",
            );

            const view =
                entryValue.scenario === "import_sources_review"
                    ? "sources"
                    : entryValue.scenario === "catalog_search_context_review"
                      ? "search"
                      : entryValue.scenario === "asset_library_global_review"
                        ? "global"
                        : entryValue.scenario === "asset_library_empty_review"
                          ? "empty"
                          : "projects";
            if (view === "sources") {
                click(
                    await waitFor(
                        () => document.querySelector(".library-source-locations-button"),
                        "Asset search locations task",
                    ),
                    "Asset search locations task",
                );
                await waitFor(
                    () => document.querySelector("[data-oaam-route='sources'][data-oaam-state='ready']"),
                    "ready Import sources",
                );
            } else if (view === "global") {
                click(document.querySelector("[data-oaam-subject-choice='global']"), "Global Asset subject");
                await waitFor(
                    () => document.querySelector("[data-oaam-route='library'][data-oaam-subject='global']"),
                    "ready Global Asset library",
                );
            } else if (view === "search") {
                await waitFor(() => document.querySelector(".asset-collection"), "loaded current Project collection");
                click(document.querySelector(".library-brand-search"), "catalog search");
                const searchDialog = await waitFor(
                    () => document.querySelector("[data-oaam-dialog='catalog_search']"),
                    "catalog search dialog",
                );
                const searchInput = searchDialog.querySelector("input[type='search']");
                assert(searchInput instanceof HTMLInputElement, "catalog search input is missing");
                const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                assert(typeof valueSetter === "function", "catalog search input setter is unavailable");
                valueSetter.call(searchInput, "guide");
                searchInput.dispatchEvent(new Event("input", { bubbles: true }));
                await waitFor(
                    () =>
                        searchDialog.querySelector("[aria-label='当前项目']") &&
                        searchDialog.querySelector("[aria-label='其他结果']"),
                    "contextual and other search groups",
                );
            }

            const surface =
                view === "sources"
                    ? document.querySelector("[data-oaam-route='sources'][data-oaam-state='ready']")
                    : document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']");
            assert(surface instanceof HTMLElement, "review surface is missing");
            await waitFor(
                () => surface.querySelector(view === "sources" ? ".source-tree" : ".asset-tree"),
                view === "sources" ? "Asset search-location tree" : "Asset-library ownership tree",
            );
            if (view !== "sources" && view !== "empty") {
                await waitFor(() => surface.querySelector(".asset-collection"), "loaded Asset-library projection");
                await waitFor(
                    () =>
                        surface.querySelectorAll(".asset-library-item").length === entryValue.expectedAssetCount ? surface : null,
                    "exact visible Asset-library items",
                );
            }
            assertOrdinarySurfaceLanguage(
                surface,
                view === "sources" ? "Asset search locations" : `Asset library (${view})`,
                entryValue.id,
                ordinarySurfaceLanguageLexicon,
            );
            if (view === "search") {
                const searchDialog = document.querySelector("[data-oaam-dialog='catalog_search']");
                assert(searchDialog instanceof HTMLElement, "contextual search dialog disappeared before review");
                assertOrdinarySurfaceLanguage(
                    searchDialog,
                    "Contextual catalog search",
                    entryValue.id,
                    ordinarySurfaceLanguageLexicon,
                );
            }

            assert(
                surface.querySelector(".workbench-view-switch") === null,
                "low-frequency Import sources remains permanently visible",
            );

            const assetTree = surface.querySelector(".asset-tree");
            const sourceTree = surface.querySelector(".source-tree");
            const subjectSwitch = surface.querySelector(".subject-switch");
            if (view === "sources") {
                assert(sourceTree instanceof HTMLElement, "Import sources does not own its source tree");
                assert(assetTree === null, "Import sources still renders the Asset-library tree");
                assert(subjectSwitch === null, "Import sources leaks the Project/Global subject switch");
                const sourceSidebarContent = surface.querySelector(".source-sidebar-content");
                const sourceReturn = surface.querySelector(".source-library-back");
                const sourceSearch = surface.querySelector(".source-sidebar-search");
                assert(
                    sourceSidebarContent instanceof HTMLElement &&
                        sourceReturn instanceof HTMLButtonElement &&
                        sourceSidebarContent.firstElementChild === sourceReturn &&
                        sourceSidebarContent.contains(sourceSearch),
                    "Import sources does not own one contextual sidebar return above search",
                );
                assert(
                    surface.querySelectorAll(".source-library-row").length === 4,
                    "Asset search locations did not render the four exact physical roots",
                );
                const groupSurface = surface.querySelector(".source-library-groups");
                assert(groupSurface instanceof HTMLElement, "all-sources projection does not own a grouped-list surface");
                assert(
                    groupSurface.dataset.oaamSourceGroupCount === "3",
                    "all-sources projection does not report the exact three Environment groups",
                );
                assert(
                    surface.querySelectorAll(".source-tree-environment").length === 3,
                    "Asset search locations did not render this device plus two WSL branches",
                );
                assert(
                    [...surface.querySelectorAll(".source-tree-location")].every(
                        (row) =>
                            (row.querySelector("strong")?.textContent?.trim().length ?? 0) > 0 &&
                            !/[\\/]/u.test(row.querySelector("strong")?.textContent?.trim() ?? "") &&
                            row.querySelector("small") === null,
                    ),
                    "search-location tree does not use one-line physical folder names",
                );
                assert(
                    [...surface.querySelectorAll(".source-library-row")].every(
                        (row) =>
                            row.querySelector(".source-library-row-main") instanceof HTMLElement &&
                            row.querySelector(".source-library-row-tools") instanceof HTMLElement &&
                            row.querySelector(".source-library-row-meta") instanceof HTMLElement &&
                            row.querySelector(".source-library-row-action") === null,
                    ),
                    "search-location rows do not own one aligned location/tool/destination projection",
                );
                const columnHeadings = [...surface.querySelectorAll(".source-library-column-headings")];
                assert(
                    columnHeadings.length === 3 &&
                        columnHeadings.every((heading) => heading.querySelectorAll(":scope > span").length === 3),
                    "Environment groups do not own exactly one location/tool/destination heading row",
                );
                const sourceGroup = surface.querySelector(".source-library-group");
                const mainPanel = surface.querySelector(".source-library-main");
                assert(sourceGroup instanceof HTMLElement && mainPanel instanceof HTMLElement, "source content group is missing");
                assert(
                    sourceGroup.getBoundingClientRect().width <= Math.min(mainPanel.getBoundingClientRect().width, 960) + 1,
                    "source group stretches into a sparse full-width card",
                );
                const groups = [...surface.querySelectorAll(".source-library-group")];
                assert(
                    groups.every(
                        (group, index) =>
                            index === 0 ||
                            Math.abs(
                                group.getBoundingClientRect().top -
                                    (groups[index - 1]?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY),
                            ) <= 1,
                    ),
                    "multiple Environments do not form one continuous vertical grouped-list surface",
                );
                assert(
                    getComputedStyle(groupSurface).backgroundColor !== "rgba(0, 0, 0, 0)" &&
                        groups.every(
                            (group) =>
                                getComputedStyle(group).backgroundColor === "rgba(0, 0, 0, 0)" &&
                                getComputedStyle(group).boxShadow === "none",
                        ),
                    "Environment groups still render as separate cards instead of rows in one shared surface",
                );
            } else if (view !== "empty") {
                assert(assetTree instanceof HTMLElement, "Asset library does not own its Asset tree");
                assert(sourceTree === null, "Asset library still renders the Import-sources tree");
                assert(subjectSwitch instanceof HTMLElement, "Asset library lost the Project/Global subject switch");
                assert(
                    subjectSwitch.querySelectorAll("[data-oaam-subject-choice]").length === 2,
                    "Asset-library subject switch is incomplete",
                );
                assert(
                    subjectSwitch.querySelector(
                        `[data-oaam-subject-choice='${view === "global" ? "global" : "projects"}'][aria-selected='true']`,
                    ) instanceof HTMLButtonElement,
                    "Asset-library subject switch exposes the wrong active subject",
                );
                assert(surface.querySelector(".asset-browser") instanceof HTMLElement, "Asset browser is missing");
                assert(surface.querySelector(".asset-library-overview") === null, "obsolete Asset overview remains visible");
                assert(
                    surface.querySelectorAll(".asset-collection").length === 1,
                    "main panel repeats more than the selected Asset collection",
                );
                assert(
                    surface.querySelectorAll(".asset-library-item").length === entryValue.expectedAssetCount,
                    "selected Asset collection does not project its exact bounded content",
                );
                assert(
                    [...surface.querySelectorAll(".asset-library-item")].every(
                        (asset) => asset.getAttribute("data-oaam-revision") === "1",
                    ),
                    "actual-render array order is masquerading as Asset Version revision",
                );
                assert(
                    [...surface.querySelectorAll(".asset-kind-group")].every(
                        (group) =>
                            group.querySelector(".asset-kind-header") instanceof HTMLElement &&
                            group.querySelector(".asset-items[data-layout='list']") instanceof HTMLElement,
                    ),
                    "non-empty Asset kinds do not render as grouped lists",
                );
                assert(
                    surface.querySelector("[data-oaam-action='open-deployments']") === null,
                    "Asset library exposes a page-level tool-write action without an exact selected Asset or existing relationship",
                );
                const pageTitle = surface.querySelector(".library-toolbar h1");
                assert(pageTitle instanceof HTMLHeadingElement, "Asset-library page identity is missing");
                const visibleAsset = surface.querySelector(".asset-library-item strong")?.textContent?.trim();
                if (view === "projects" || view === "search") {
                    const projectRows = assetTree.querySelectorAll(".asset-tree-project[data-oaam-project-id]");
                    assert(
                        projectRows.length === (entryValue.projectCount ?? 2),
                        "Project subject does not render the exact Project list",
                    );
                    assert(
                        assetTree.querySelectorAll("[data-oaam-action='manage-project']").length ===
                            (entryValue.projectCount ?? 2),
                        "each Project row does not own its exact lifecycle menu",
                    );
                    assert(
                        assetTree.querySelectorAll("[data-oaam-action='add-project']").length === 1,
                        "Project section does not own one add-folder action",
                    );
                    assert(
                        assetTree.querySelector("[data-oaam-collection-id]") === null,
                        "Project tree retains a redundant All-assets collection node",
                    );
                    const selectedProjectRow = [...projectRows].find((row) => row.getAttribute("aria-current") === "page");
                    const projectListItem = selectedProjectRow?.closest("li");
                    assert(
                        projectListItem instanceof HTMLLIElement &&
                            projectListItem.querySelectorAll(".asset-tree-kind").length === 2,
                        "selected Project does not directly own its two non-empty AssetKind branches",
                    );
                    surface.style.setProperty("--oaam-left-pane-width", "224px");
                    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    const selectedProjectContainer = selectedProjectRow?.closest(".asset-tree-project-row");
                    const selectedProjectMenu = projectListItem?.querySelector("[data-oaam-action='manage-project']");
                    assert(
                        selectedProjectContainer instanceof HTMLElement &&
                            selectedProjectMenu instanceof HTMLButtonElement &&
                            selectedProjectMenu.parentElement === selectedProjectContainer,
                        "selected Project lifecycle menu is not owned by its highlighted row",
                    );
                    const rowBounds = selectedProjectContainer.getBoundingClientRect();
                    const menuBounds = selectedProjectMenu.getBoundingClientRect();
                    const treeBounds = assetTree.getBoundingClientRect();
                    const initialMenuStyle = getComputedStyle(selectedProjectMenu);
                    assert(
                        Number.parseFloat(initialMenuStyle.opacity) === 0 && initialMenuStyle.pointerEvents === "none",
                        "selected Project lifecycle menu occupies the row without hover or focus",
                    );
                    selectedProjectMenu.focus();
                    await waitFor(
                        () =>
                            document.activeElement === selectedProjectMenu &&
                            Number.parseFloat(getComputedStyle(selectedProjectMenu).opacity) === 1,
                        "focused Project lifecycle menu transition",
                    );
                    const activeMenuStyle = getComputedStyle(selectedProjectMenu);
                    assert(
                        menuBounds.left >= rowBounds.left &&
                            menuBounds.right <= rowBounds.right &&
                            menuBounds.right <= treeBounds.right &&
                            menuBounds.top >= rowBounds.top &&
                            menuBounds.bottom <= rowBounds.bottom &&
                            menuBounds.width >= 24 &&
                            menuBounds.height >= 24 &&
                            Number.parseInt(activeMenuStyle.zIndex, 10) > 0 &&
                            Number.parseFloat(activeMenuStyle.opacity) > 0 &&
                            activeMenuStyle.pointerEvents === "auto" &&
                            selectedProjectMenu.getAttribute("data-tooltip") === entryValue.expectedProjectMenuTooltip,
                        "focused Project lifecycle menu is clipped, hidden or lacks its compact hint at minimum sidebar width " +
                            `(row=${String(rowBounds.left)}..${String(rowBounds.right)}, ` +
                            `tree=${String(treeBounds.left)}..${String(treeBounds.right)}, ` +
                            `menu=${String(menuBounds.left)}..${String(menuBounds.right)}, ` +
                            `size=${String(menuBounds.width)}x${String(menuBounds.height)}, ` +
                            `z=${activeMenuStyle.zIndex}, opacity=${activeMenuStyle.opacity}, ` +
                            `pointerEvents=${activeMenuStyle.pointerEvents})`,
                    );
                    const selectedProjectLabel = selectedProjectRow
                        ?.querySelector(".asset-tree-project-label > span")
                        ?.textContent?.trim();
                    assert(
                        selectedProjectRow?.querySelector("[data-oaam-icon='folder_open']") instanceof SVGElement,
                        "selected Project branch does not use the open-folder state",
                    );
                    assert(
                        pageTitle.textContent?.trim() === selectedProjectLabel,
                        "main page identity is not the exact selected Project",
                    );
                    assert(
                        surface.querySelector(".asset-collection[data-oaam-collection-id='project']") instanceof HTMLElement &&
                            surface.querySelector(".asset-collection[data-oaam-collection-id='global']") === null,
                        "Project selection does not project exactly one Project collection",
                    );
                    assert(visibleAsset === "Project guide map 1", "Project collection renders the wrong Asset subject");
                    assert(
                        [...surface.querySelectorAll(".asset-kind-title-button")].every(
                            (title) => (title.getAttribute("data-tooltip")?.trim().length ?? 0) > 0,
                        ),
                        "non-empty AssetKind headings do not use the shared accessible glossary",
                    );
                } else {
                    assert(
                        assetTree.querySelector("[data-oaam-project-id]") === null,
                        "Global subject incorrectly renders Project roots",
                    );
                    const globalRoot = assetTree.querySelector(".asset-tree-global");
                    assert(
                        globalRoot instanceof HTMLButtonElement && assetTree.querySelector("[data-oaam-collection-id]") === null,
                        "Global subject does not use the Global root itself as the all-assets route",
                    );
                    assert(
                        pageTitle.textContent?.trim() === globalRoot.textContent?.replace(/\d+$/u, "").trim(),
                        "main page identity is not the exact Global Asset context",
                    );
                    assert(
                        surface.querySelector(".asset-collection[data-oaam-collection-id='global']") instanceof HTMLElement &&
                            surface.querySelector(".asset-collection[data-oaam-collection-id='project']") === null,
                        "Global selection does not project exactly one Global collection",
                    );
                    assert(visibleAsset === "Shared guide map 1", "Global collection renders the wrong Asset subject");
                    const guidanceTargets = surface.querySelector("[data-oaam-asset-kind='Guidance'] .asset-target-support");
                    const workflowTargets = surface.querySelector("[data-oaam-asset-kind='Workflow'] .asset-target-support");
                    assert(guidanceTargets instanceof HTMLElement, "Global Guidance target support is missing");
                    assert(workflowTargets instanceof HTMLElement, "Global Workflow target support is missing");
                    assert(
                        [...guidanceTargets.querySelectorAll("[data-oaam-agent-runtime-ids]")]
                            .map((target) => target.getAttribute("data-oaam-agent-runtime-ids"))
                            .join(",") === "ANTIGRAVITY_CLI,CLAUDE_CODE_CLI,CODEX_CLI",
                        "Global Guidance bounded family projection does not preserve the exact visible runtime identities",
                    );
                    assert(
                        [...guidanceTargets.querySelectorAll("[data-oaam-agent-runtime-ids]")]
                            .map((target) => target.textContent?.trim())
                            .join(",") === "Antigravity,Claude Code,Codex" &&
                            guidanceTargets.dataset.oaamHiddenTargetCount === "2" &&
                            guidanceTargets.querySelector(".asset-target-summary")?.getAttribute("title")?.includes("OpenCode") &&
                            guidanceTargets.querySelector(".asset-target-summary")?.getAttribute("title")?.includes("ZCode"),
                        "single-runtime Providers do not collapse to bounded ordinary family display names",
                    );
                    const moreTargets = guidanceTargets.querySelector(".asset-target-more");
                    click(moreTargets, "additional Guidance targets");
                    await waitFor(
                        () =>
                            moreTargets.getAttribute("aria-expanded") === "true" &&
                            guidanceTargets.querySelectorAll("[data-oaam-agent-runtime-ids]").length === 5,
                        "expanded Guidance targets",
                    );
                    assert(
                        moreTargets.getAttribute("aria-expanded") === "true" &&
                            [...guidanceTargets.querySelectorAll("[data-oaam-agent-runtime-ids]")]
                                .map((target) => target.textContent?.trim())
                                .join(",") === "Antigravity,Claude Code,Codex,OpenCode,ZCode",
                        "additional write targets do not expand from the explicit count control",
                    );
                    assert(
                        workflowTargets.querySelector("[data-oaam-agent-runtime-ids]") === null &&
                            workflowTargets.dataset.oaamTargetSupportStatus === "ready",
                        "Global Workflow invents a supported target or hides provider readiness",
                    );
                }
            }

            if (view === "empty") {
                assert(assetTree instanceof HTMLElement, "empty Asset library lost its ownership tree");
                assert(assetTree.querySelector("[data-oaam-project-id]") === null, "empty Asset library invents a Project");
                assert(surface.querySelector(".asset-library-item") === null, "empty Asset library invents an Asset");
                assert(
                    surface.querySelector(".library-empty-state") instanceof HTMLElement,
                    "empty Asset library has no useful empty state",
                );
                assert(
                    surface.querySelectorAll(".library-empty-state button").length === 2 &&
                        assetTree.querySelectorAll("[data-oaam-action='add-project']").length === 1 &&
                        surface.querySelectorAll("[data-oaam-action='add-project']").length === 2 &&
                        surface.querySelectorAll("[data-oaam-action='start-guided-import']").length === 1 &&
                        surface.querySelector("[data-oaam-action='open-import-sources']") === null &&
                        surface.querySelector(".library-import-sources-button") === null &&
                        surface.querySelector(".sidebar-section-actions") === null,
                    "empty Asset library repeats its contextual Project/import actions in chrome",
                );
            }

            if (view !== "sources" && view !== "empty") {
                const layoutSwitch = surface.querySelector(".layout-switch");
                assert(layoutSwitch instanceof HTMLElement, "compact layout toggle is missing");
                assert(layoutSwitch.querySelectorAll("button").length === 2, "compact layout toggle is incomplete");
                assert(
                    [...layoutSwitch.querySelectorAll("button")].every((button) => button.textContent?.trim() === ""),
                    "layout toggle still occupies the toolbar with text buttons",
                );
                if (view === "projects" && entryValue.scenario === "asset_library_project_review") {
                    const cards = layoutSwitch.querySelectorAll("button")[1];
                    click(cards, "card layout");
                    const cardGroups = await waitFor(
                        () => surface.querySelector(".asset-kind-groups[data-layout='cards']"),
                        "card layout projection",
                    );
                    const firstCard = cardGroups.querySelector(".asset-library-item");
                    const description = firstCard?.querySelector(".asset-library-main > span");
                    const actions = firstCard?.querySelector(".asset-library-row-actions");
                    const firstAction = actions?.querySelector("button");
                    assert(
                        firstCard instanceof HTMLElement &&
                            description instanceof HTMLElement &&
                            actions instanceof HTMLElement &&
                            firstAction instanceof HTMLButtonElement,
                        "card layout lost its description or action tray",
                    );
                    firstAction.focus({ preventScroll: true });
                    const descriptionStyle = getComputedStyle(description);
                    const actionStyle = getComputedStyle(actions);
                    const cardBounds = firstCard.getBoundingClientRect();
                    const actionBounds = actions.getBoundingClientRect();
                    assert(
                        descriptionStyle.whiteSpace === "normal" && descriptionStyle.webkitLineClamp === "3",
                        "card description is not a bounded three-line summary",
                    );
                    assert(
                        actionBounds.right <= cardBounds.right &&
                            actionBounds.bottom <= cardBounds.bottom &&
                            actionBounds.top > cardBounds.top + cardBounds.height / 2 &&
                            Number.parseFloat(actionStyle.opacity) > 0,
                        "card action tray is not visible in the lower-right corner on keyboard focus",
                    );
                }
                assert(surface.querySelector(".environment-filter") === null, "Asset library exposes a false Environment filter");
                assert(
                    surface.querySelector(".asset-browser-search") === null &&
                        surface.querySelector(".library-brand-search") instanceof HTMLButtonElement,
                    "Asset library exposes more than the single OAAM/Ctrl+K search entry",
                );
            }

            if (view === "search") {
                const searchDialog = document.querySelector("[data-oaam-dialog='catalog_search']");
                const currentGroup = searchDialog?.querySelector("[aria-label='当前项目']");
                const otherGroup = searchDialog?.querySelector("[aria-label='其他结果']");
                assert(currentGroup instanceof HTMLElement, "contextual search has no exact current-Project group");
                assert(otherGroup instanceof HTMLElement, "contextual search has no deduplicated other-results group");
                assert(
                    currentGroup.querySelectorAll(".catalog-search-result").length === 2,
                    "contextual search does not show the two exact scoped guide matches",
                );
                assert(
                    [...currentGroup.querySelectorAll(".catalog-search-result strong")].every((title) =>
                        title.textContent?.includes("Project guide map"),
                    ),
                    "current-Project search group contains a non-scoped result",
                );
                assert(
                    [...otherGroup.querySelectorAll(".catalog-search-result strong")].some(
                        (title) => title.textContent?.trim() === "Shared guide map 1",
                    ) &&
                        [...otherGroup.querySelectorAll(".catalog-search-result strong")].some(
                            (title) => title.textContent?.trim() === "Guide research",
                        ),
                    "other-results group lost the global Asset or other Project result",
                );
                assert(
                    [...otherGroup.querySelectorAll(".catalog-search-result")].every(
                        (result) => !result.textContent?.includes("Project guide map 1"),
                    ),
                    "catalog-wide results repeat the current scoped Asset",
                );
            }

            const sidebar = surface.querySelector(".library-sidebar");
            const workbench = surface.querySelector(".library-workbench");
            const toolbar = surface.querySelector(".library-toolbar");
            const mainScroll = surface.querySelector(".library-main-scroll");
            assertInsideViewport(sidebar, "view-owned sidebar");
            assertInsideViewport(workbench, "view-owned workbench");
            assertInsideViewport(toolbar, "view toolbar");
            assertInsideViewport(mainScroll, "view scroll owner");
            assert(
                sidebar instanceof HTMLElement && sidebar.scrollWidth <= sidebar.clientWidth + 1,
                "view-owned sidebar overflows horizontally",
            );
            assert(
                mainScroll instanceof HTMLElement && getComputedStyle(mainScroll).overflowY === "auto",
                "view-owned main panel is not independently scrollable",
            );
            const centeredContent =
                view === "sources"
                    ? surface.querySelector(".source-library-groups")
                    : view === "empty"
                      ? surface.querySelector(".library-empty-state")
                      : surface.querySelector(".asset-browser");
            assert(centeredContent instanceof HTMLElement && mainScroll instanceof HTMLElement, "centered content is missing");
            const contentBounds = centeredContent.getBoundingClientRect();
            const mainBounds = mainScroll.getBoundingClientRect();
            assert(
                Math.abs((contentBounds.left + contentBounds.right) / 2 - (mainBounds.left + mainBounds.right) / 2) <= 2,
                "bounded main content is not horizontally centered in the available workspace",
            );
            if ((view === "project" || view === "global") && innerWidth >= 1920) {
                const minimumWideContent = Math.min(innerWidth >= 3000 ? 1800 : 1400, mainBounds.width - 64);
                assert(
                    contentBounds.width >= minimumWideContent,
                    `Asset library does not use its wide workbench (${contentBounds.width}/${mainBounds.width})`,
                );
            }
            const footer = surface.querySelector(".library-sidebar-footer");
            assert(
                footer instanceof HTMLElement && footer.getBoundingClientRect().height <= 52,
                "Host status and Settings do not share one compact footer row",
            );

            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: [`asset_and_sources_views:${view}`],
                routeStates:
                    view === "sources"
                        ? ["library:ready", "sources:ready"]
                        : ["library:ready", `library:${view === "search" ? "projects" : view}`],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()})`,
        true,
    );
}
