import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import {
    ACTUAL_RENDER_CASES,
    EXPECTED_ACTUAL_RENDER_JOURNEY_STATES,
    EXPECTED_ACTUAL_RENDER_ROUTE_STATES,
    EXPECTED_ACTUAL_RENDER_SURFACE_GAPS,
} from "../desktop-actual-render-scenarios.mjs";
import { validateDesktopVisualMatrix } from "../desktop-visual-matrix.mjs";
import { inspectCompleteDirectoryPreviewCase } from "./desktop-actual-render-complete-directory-preview.mjs";
import {
    assertImportStepBounds,
    proveDenseProjectSidebar,
    proveOnboardingContainment,
} from "./desktop-actual-render-containment.mjs";
import { inspectDeploymentCase } from "./desktop-actual-render-deployment.mjs";
import { inspectDeploymentOperationsCase } from "./desktop-actual-render-deployment-operations.mjs";
import { inspectEmptyJourneyCase } from "./desktop-actual-render-empty-journey.mjs";
import {
    inspectImportCandidateDeselect,
    inspectImportPreviewSoftWrap,
    inspectImportReviewLayout,
} from "./desktop-actual-render-import-review.mjs";
import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";
import { inspectLibraryViewCase } from "./desktop-actual-render-library-views.mjs";
import { loadAndInspectSurfaceLoading } from "./desktop-actual-render-loading.mjs";
import { inspectProjectAssetOperationsCase } from "./desktop-actual-render-project-assets.mjs";
import { inspectProjectGuidanceApplyRehearsalCase } from "./desktop-actual-render-project-guidance-apply.mjs";
import { inspectJourneyProjectRegistration } from "./desktop-actual-render-project-registration.mjs";
import { projectGuidanceProductionRenderReceipt } from "./desktop-actual-render-promotion-authorization.mjs";
import { inspectRendererFailureCase } from "./desktop-actual-render-renderer-failure.mjs";
import { createReviewScreenshotRecorder } from "./desktop-actual-render-review-screenshots.mjs";
import { inspectSourceImportFeedbackCase } from "./desktop-actual-render-source-import-feedback.mjs";
import { inspectStateDiagnosticsOperationsCase } from "./desktop-actual-render-state-diagnostics.mjs";
import { observeMissingProjectGuidanceTarget } from "./desktop-actual-render-target-observation.mjs";
import {
    proveDeploymentWheelReachability,
    proveTransientSidebar,
    proveWheelReachability,
} from "./desktop-actual-render-workbench.mjs";

const outputRoot = process.env.OAAM_ACTUAL_RENDER_OUTPUT;
if (outputRoot === undefined || outputRoot === "") throw new Error("OAAM_ACTUAL_RENDER_OUTPUT is required");
const screenshotOutputRoot = process.env.OAAM_ACTUAL_RENDER_SCREENSHOT_OUTPUT;
function fail(message) {
    throw new Error(message);
}
function trace(message) {
    if (process.env.OAAM_ACTUAL_RENDER_TRACE === "1") process.stdout.write(`OAAM_ACTUAL_RENDER_TRACE ${message}\n`);
}
async function inspectRenderedCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspect(entryValue, assertOrdinarySurfaceLanguage, ordinarySurfaceLanguageLexicon) {
            const waitFor = async (predicate, label, timeoutMs = 5000) => {
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
            const visibleRect = (element) => {
                const rect = element.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            };
            const click = (element) => {
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };
            const assertOrdinaryLanguage = (root, label) =>
                assertOrdinarySurfaceLanguage(root, label, entryValue.id, ordinarySurfaceLanguageLexicon);
            const observedDialogs = [];
            const observedJourneyStates = [];
            const observeDialog = (dialog, expectedId, label) => {
                assert(dialog instanceof HTMLElement, `${label} dialog is missing`);
                assert(dialog.getAttribute("data-oaam-dialog") === expectedId, `${label} dialog identity is incorrect`);
                assert(dialog.getAttribute("aria-modal") === "true", `${label} is not modal`);
                const backdrop = dialog.parentElement;
                assert(
                    backdrop instanceof HTMLElement &&
                        backdrop.matches("[data-oaam-dialog-backdrop]") &&
                        backdrop.parentElement === document.body,
                    `${label} backdrop is not mounted at the application window level`,
                );
                const backdropBounds = backdrop.getBoundingClientRect();
                assert(getComputedStyle(backdrop).position === "fixed", `${label} backdrop is not viewport-fixed`);
                assert(
                    backdropBounds.left <= 1 &&
                        backdropBounds.top <= 1 &&
                        backdropBounds.right >= window.innerWidth - 1 &&
                        backdropBounds.bottom >= window.innerHeight - 1,
                    `${label} backdrop does not cover the current viewport`,
                );
                const bounds = dialog.getBoundingClientRect();
                assert(
                    bounds.left >= 0 &&
                        bounds.top >= 0 &&
                        bounds.right <= window.innerWidth &&
                        bounds.bottom <= window.innerHeight,
                    `${label} escapes the current viewport`,
                );
                assertOrdinaryLanguage(dialog, label);
                observedDialogs.push(expectedId);
            };
            await waitFor(() => document.querySelector(".project-library-shell"), "Project library shell");
            await waitFor(() => document.querySelector(".library-toolbar-actions"), "Asset toolbar controls");
            const sidebar = document.querySelector(".library-sidebar");
            const sidebarScroll = document.querySelector(".library-sidebar-scroll");
            const workbench = document.querySelector(".library-workbench");
            const toggle = document.querySelector(".desktop-window-leading-actions button");
            assert(sidebar instanceof HTMLElement, "Library sidebar is missing");
            assert(sidebarScroll instanceof HTMLElement, "Library sidebar scroll owner is missing");
            assert(workbench instanceof HTMLElement, "Library workbench is missing");
            assert(toggle instanceof HTMLButtonElement, "persistent sidebar toggle is missing");
            assertOrdinaryLanguage(document.body, "Project library");
            assert(
                document.querySelector(".project-library-shell")?.getAttribute("data-oaam-asset-count") === "1",
                "ordinary workbench does not expose its populated Asset state",
            );
            observedJourneyStates.push("project_management:populated");
            assert(
                sidebarScroll.scrollWidth <= sidebarScroll.clientWidth + 1,
                `Library sidebar overflows horizontally (${sidebarScroll.scrollWidth} > ${sidebarScroll.clientWidth})`,
            );
            const workbenchBeforeHide = visibleRect(workbench);
            click(toggle);
            await waitFor(() => sidebar.hidden && getComputedStyle(sidebar).display === "none", "hidden Library sidebar");
            const hiddenLibraryRect = visibleRect(sidebar);
            const workbenchAfterHide = visibleRect(workbench);
            assert(hiddenLibraryRect.width === 0 && hiddenLibraryRect.height === 0, "hidden Library sidebar still paints");
            assert(!sidebar.contains(document.activeElement), "hidden Library sidebar retains focus");
            assert(
                workbenchAfterHide.width > workbenchBeforeHide.width,
                "Library workbench did not reclaim persistent sidebar width",
            );
            click(toggle);
            await waitFor(() => !sidebar.hidden && getComputedStyle(sidebar).display !== "none", "restored Library sidebar");
            const displayControls = document.querySelector(".library-toolbar-actions");
            const deletedFilter = document.querySelector(".library-show-deleted");
            const displaySeparator = document.querySelector(".library-toolbar-separator");
            const layoutSwitch = document.querySelector("fieldset.layout-switch");
            assert(displayControls instanceof HTMLElement, "Asset toolbar control group is missing");
            assert(deletedFilter instanceof HTMLElement, "deleted-Asset filter is missing");
            assert(
                displaySeparator instanceof HTMLElement === layoutSwitch instanceof HTMLElement,
                "Asset layout choice and its visual separator disagree",
            );
            if (displaySeparator instanceof HTMLElement && layoutSwitch instanceof HTMLElement) {
                const filterRect = deletedFilter.getBoundingClientRect();
                const separatorRect = displaySeparator.getBoundingClientRect();
                const layoutRect = layoutSwitch.getBoundingClientRect();
                assert(
                    separatorRect.left >= filterRect.right && separatorRect.right <= layoutRect.left,
                    "deleted filter and layout choice are not visually separated",
                );
            }
            const searchButton = document.querySelector(".library-brand-search");
            assert(searchButton instanceof HTMLButtonElement, "catalog search button is missing");
            searchButton.focus();
            click(searchButton);
            const searchInput = await waitFor(
                () => document.querySelector(".catalog-search-input input"),
                "catalog search input",
            );
            assert(searchInput instanceof HTMLInputElement, "catalog search input has the wrong element type");
            assert(searchInput.value === "", "catalog search did not open in its initial state");
            observedJourneyStates.push("unified_search:initial");
            searchInput.focus();
            const searchContainer = searchInput.closest(".catalog-search-input");
            assert(searchContainer instanceof HTMLElement, "catalog search focus owner is missing");
            assert(getComputedStyle(searchInput).boxShadow === "none", "search input still owns a duplicate focus ring");
            assert(getComputedStyle(searchContainer).boxShadow !== "none", "search container has no visible focus ring");
            const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (valueSetter === undefined) throw new Error("HTML input value setter is unavailable");
            valueSetter.call(searchInput, "guide");
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            const matches = await waitFor(() => {
                const values = [...document.querySelectorAll("[data-oaam-search-match]")];
                return values.length >= 1 ? values : undefined;
            }, "exact catalog match highlighting");
            assert(
                matches.every((match) => match.textContent?.toLocaleLowerCase("en-US") === "guide"),
                "catalog highlighting includes non-matching text",
            );
            observedJourneyStates.push("unified_search:populated");
            const searchDialog = document.querySelector(".catalog-search-dialog");
            observeDialog(searchDialog, "catalog_search", "Catalog search");
            searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await waitFor(() => document.querySelector(".catalog-search-dialog") === null, "closed catalog search");
            await waitFor(() => document.activeElement === searchButton, "restored Catalog search focus");
            observedJourneyStates.push("unified_search:closed");
            const manageProject = document.querySelector("[data-oaam-action='manage-project']");
            assert(manageProject instanceof HTMLButtonElement, "Project management action is missing");
            manageProject.focus();
            click(manageProject);
            const projectDialog = await waitFor(
                () => document.querySelector("[data-oaam-dialog='project_lifecycle']"),
                "Project management dialog",
            );
            observeDialog(projectDialog, "project_lifecycle", "Project management");
            projectDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await waitFor(
                () => document.querySelector("[data-oaam-dialog='project_lifecycle']") === null,
                "closed Project management",
            );
            await waitFor(() => document.activeElement === manageProject, "restored Project management focus");
            const helpMenu = document.getElementById("oaam-window-menu-help-trigger");
            assert(helpMenu instanceof HTMLButtonElement, "Help menu is missing");
            click(helpMenu);
            const aboutMenuItem = await waitFor(
                () => document.querySelector("[data-oaam-window-menu='help'] [role='menuitem']"),
                "About menu item",
            );
            click(aboutMenuItem);
            const aboutDialog = await waitFor(() => document.querySelector("[data-oaam-dialog='about']"), "About dialog");
            observeDialog(aboutDialog, "about", "About");
            aboutDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await waitFor(() => document.querySelector("[data-oaam-dialog='about']") === null, "closed About dialog");
            const settingsButton = document.querySelector(".library-settings-button");
            assert(settingsButton instanceof HTMLButtonElement, "Settings navigation button is missing");
            click(settingsButton);
            const settingsShell = await waitFor(() => document.querySelector(".settings-workbench-shell"), "Settings workbench");
            const settingsSidebar = document.querySelector(".settings-sidebar");
            const settingsWorkbench = document.querySelector(".settings-workbench");
            const settingsToolbar = document.querySelector(".settings-toolbar");
            const settingsHeading = document.querySelector(".settings-toolbar h1");
            const settingsScroll = document.querySelector(".settings-scroll");
            assert(settingsShell instanceof HTMLElement, "Settings shell has the wrong type");
            assert(settingsSidebar instanceof HTMLElement, "Settings sidebar is missing");
            assert(settingsWorkbench instanceof HTMLElement, "Settings workbench is missing");
            assert(settingsToolbar instanceof HTMLElement, "Settings toolbar is missing");
            assert(settingsHeading instanceof HTMLElement, "Settings heading is missing");
            assert(settingsScroll instanceof HTMLElement, "Settings scroll owner is missing");
            assertOrdinaryLanguage(settingsShell, "Settings");
            assert(settingsShell.getAttribute("data-settings-category") === "general", "Settings did not open General");
            observedJourneyStates.push("settings_and_appearance:general");
            assert(document.querySelector(".settings-category-copy") === null, "verbose Settings category copy remains");
            const toolbarRect = settingsToolbar.getBoundingClientRect();
            const headingRect = settingsHeading.getBoundingClientRect();
            const settingsWorkbenchRect = settingsWorkbench.getBoundingClientRect();
            assert(
                headingRect.top >= toolbarRect.top &&
                    headingRect.bottom <= toolbarRect.bottom &&
                    headingRect.top >= settingsWorkbenchRect.top,
                "Settings heading escapes or clips through its toolbar",
            );
            const scrollStyle = getComputedStyle(settingsScroll);
            assert(scrollStyle.overflowY === "auto", `Settings scroll owner overflow is ${scrollStyle.overflowY}`);
            assert(
                Math.abs(settingsScroll.getBoundingClientRect().width - settingsWorkbench.getBoundingClientRect().width) <= 2,
                "Settings scroll owner is an unintended narrow centered column",
            );
            const settingsBeforeHide = visibleRect(settingsWorkbench);
            click(toggle);
            await waitFor(
                () => settingsSidebar.hidden && getComputedStyle(settingsSidebar).display === "none",
                "hidden Settings sidebar",
            );
            const hiddenSettingsRect = visibleRect(settingsSidebar);
            const settingsAfterHide = visibleRect(settingsWorkbench);
            assert(hiddenSettingsRect.width === 0 && hiddenSettingsRect.height === 0, "hidden Settings sidebar still paints");
            assert(
                settingsAfterHide.width > settingsBeforeHide.width,
                "Settings workbench did not reclaim persistent sidebar width",
            );
            assert(
                Math.abs(settingsAfterHide.y - settingsBeforeHide.y) <= 1,
                `hidden Settings sidebar moved above the workbench (${settingsBeforeHide.y} -> ${settingsAfterHide.y})`,
            );
            click(toggle);
            await waitFor(
                () => !settingsSidebar.hidden && getComputedStyle(settingsSidebar).display !== "none",
                "restored Settings sidebar",
            );
            const categories = [...document.querySelectorAll(".settings-category-button")];
            const maintenance = categories.at(-1);
            assert(maintenance instanceof HTMLButtonElement, "Maintenance category is missing");
            click(maintenance);
            await waitFor(() => document.querySelector("#desktop-maintenance-settings"), "Maintenance settings");
            assert(
                settingsShell.getAttribute("data-settings-category") === "maintenance",
                "Settings did not retain the Maintenance category",
            );
            observedJourneyStates.push("settings_and_appearance:maintenance");
            const maintenanceScroll = document.querySelector(".settings-scroll");
            const sentinel = document.querySelector("[data-oaam-settings-scroll-sentinel='maintenance']");
            assert(maintenanceScroll instanceof HTMLElement, "Maintenance scroll owner is missing");
            assert(sentinel instanceof HTMLElement, "Maintenance final sentinel is missing");
            assertOrdinaryLanguage(maintenanceScroll, "Maintenance settings");
            const scrollRect = maintenanceScroll.getBoundingClientRect();
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: observedDialogs,
                journeyStates: observedJourneyStates,
                routeStates: ["library:ready", "settings:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
                scrollProbe: {
                    x: Math.floor(scrollRect.left + scrollRect.width / 2),
                    y: Math.floor(scrollRect.top + Math.min(scrollRect.height / 2, 80)),
                    scrollHeight: maintenanceScroll.scrollHeight,
                    clientHeight: maintenanceScroll.clientHeight,
                },
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()})`,
        true,
    );
}
async function inspectJourneyCase(webContents, entry) {
    if (entry.onboardingContainment) {
        await webContents.executeJavaScript("document.documentElement.dataset.oaamHoldGlobalProbe = 'true'", true);
    }
    const journey = webContents.executeJavaScript(
        `(${async function inspectJourney(
            entryValue,
            inspectProjectRegistration,
            inspectCandidateDeselect,
            inspectReviewLayout,
            inspectPreviewSoftWrap,
            inspectStepBounds,
            assertOrdinarySurfaceLanguage,
            ordinarySurfaceLanguageLexicon,
        ) {
            const SHARED_SOURCE_PATH = "C:\\Users\\Example\\.claude";
            const COMPATIBLE_ONLY_SOURCE_PATH = "C:\\Users\\Example\\.config\\opencode";
            const PROJECT_SOURCE_PATH = "C:\\Users\\Example\\work\\sample-project";
            const waitFor = async (predicate, label, timeoutMs = 30_000) => {
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
            const observedJourneyStates = [];
            const observedDialogs = [];
            const click = (element) => {
                assert(element instanceof HTMLButtonElement, "journey action is not a button");
                assert(!element.disabled, "journey action is disabled");
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };
            const buttonWithIcon = (root, icon) =>
                [...root.querySelectorAll("button")].find((button) => button.querySelector(`[data-oaam-icon='${icon}']`));
            const assertOrdinaryLanguage = (root, label) =>
                assertOrdinarySurfaceLanguage(root, label, entryValue.id, ordinarySurfaceLanguageLexicon);
            const assertInsideViewport = (root, label) => {
                const rect = root.getBoundingClientRect();
                assert(
                    rect.left >= -1 &&
                        rect.top >= -1 &&
                        rect.right <= window.innerWidth + 1 &&
                        rect.bottom <= window.innerHeight + 1,
                    `${label} escapes the current viewport`,
                );
            };
            const routeStage = async (route, step) =>
                waitFor(
                    () => document.querySelector(`[data-oaam-route='${route}'][data-oaam-step='${step}']`),
                    `${route} ${step}`,
                );
            const assertProgress = (root, label) => {
                assert(
                    root.querySelectorAll(".import-journey-steps > li").length === 6,
                    `${label} does not show six user-decision stages`,
                );
                inspectStepBounds(root, assert, label);
            };
            const continueFrom = (root, stage) => {
                const action = root.querySelector(`[data-oaam-journey-continue='${stage}']`);
                click(action);
            };
            const reviewJourney = async (route, journeyId, sourceSelectionMode) => {
                const locations = await routeStage(route, "locations");
                assertInsideViewport(locations, `${route} locations`);
                assertProgress(locations, `${route} locations`);
                assertOrdinaryLanguage(locations, `${route} locations`);
                observedJourneyStates.push(`${journeyId}:locations`);
                const environmentCards = [...locations.querySelectorAll(".environment-card")];
                assert(environmentCards.length === 2, `${route} does not present Local Windows plus WSL`);
                const windowsCard = environmentCards.find(
                    (card) => card.getAttribute("data-oaam-environment-platform") === "win32",
                );
                const wslCard = environmentCards.find((card) => card.getAttribute("data-oaam-environment-platform") === "wsl");
                const windowsInput = windowsCard?.querySelector("input[type='checkbox']");
                const wslInput = wslCard?.querySelector("input[type='checkbox']");
                assert(windowsInput instanceof HTMLInputElement && windowsInput.checked, "Local Windows is not selected");
                assert(wslInput instanceof HTMLInputElement && !wslInput.checked, "WSL is not opt-in");
                continueFrom(locations, "locations");
                const tools = await routeStage(route, "tools");
                assertInsideViewport(tools, `${route} tools`);
                assertProgress(tools, `${route} tools`);
                assertOrdinaryLanguage(tools, `${route} tools`);
                assert(tools.querySelectorAll(".provider-card").length === 2, `${route} does not present both user tools`);
                observedJourneyStates.push(`${journeyId}:tools`);
                continueFrom(tools, "tools");
                const sources = await routeStage(route, "sources");
                assertInsideViewport(sources, `${route} sources`);
                assert(
                    document.documentElement.dataset.oaamProbeAdapterIds === '["CLAUDECODE","OPENCODE"]',
                    `${route} did not scan the two selected tools`,
                );
                assert(
                    document.documentElement.dataset.oaamProbeEnvironmentCount === "1",
                    `${route} scanned an unselected Environment`,
                );
                await waitFor(() => sources.querySelectorAll(".source-review-card").length === 3, `${route} source cards`);
                if (entryValue.onboardingContainment && route === "onboarding") {
                    document.documentElement.dataset.oaamContainmentStage = "sources";
                    await new Promise((resolve) =>
                        window.addEventListener("oaam-actual-render-release-sources", resolve, { once: true }),
                    );
                }
                assertProgress(sources, `${route} sources`);
                assertOrdinaryLanguage(sources, `${route} sources`);
                const cards = [...sources.querySelectorAll(".source-review-card")];
                for (let index = 1; index < cards.length; index += 1) {
                    const previous = cards[index - 1].getBoundingClientRect();
                    const current = cards[index].getBoundingClientRect();
                    assert(
                        Math.abs(current.left - previous.left) <= 1 &&
                            Math.abs(current.right - previous.right) <= 1 &&
                            current.top >= previous.bottom - 1,
                        "source-review locations must form one ordered column",
                    );
                }
                const cardFor = (displayPath) =>
                    cards.find((card) => card.querySelector(".source-review-heading code")?.textContent?.trim() === displayPath);
                const sharedCard = cardFor(SHARED_SOURCE_PATH);
                const compatibleOnlyCard = cardFor(COMPATIBLE_ONLY_SOURCE_PATH);
                const projectCard = cardFor(PROJECT_SOURCE_PATH);
                assert(sharedCard instanceof HTMLElement, "native plus compatible path is not reviewed exactly once");
                assert(compatibleOnlyCard instanceof HTMLElement, "compatible-only path is not reviewed");
                assert(projectCard instanceof HTMLElement, "exact Project path is not reviewed");
                const sharedRelationships = JSON.parse(sharedCard.dataset.oaamSourceClaimKinds ?? "null");
                const compatibleOnlyRelationships = JSON.parse(compatibleOnlyCard.dataset.oaamSourceClaimKinds ?? "null");
                assert(
                    JSON.stringify(sharedRelationships) === JSON.stringify(["native", "compatible_shared"]),
                    "native plus compatible claims were lost, duplicated, or reordered",
                );
                assert(
                    JSON.stringify(compatibleOnlyRelationships) === JSON.stringify(["compatible_shared"]),
                    "compatible-only claim was lost or duplicated",
                );
                assert(
                    sharedCard.querySelector(".source-relationship-list") === null &&
                        compatibleOnlyCard.querySelector(".source-relationship-list") === null,
                    "ordinary source cards repeat technical relationship labels",
                );
                assert(
                    sources.querySelector(".source-review-card input[type='checkbox']") === null,
                    "source review still reinforces inclusion with checkbox controls",
                );
                assert(
                    sharedCard.dataset.oaamSourceSelected === "true" &&
                        sharedCard.dataset.oaamSourceWatchSelected === "true" &&
                        sharedCard.dataset.oaamSourceState === "included",
                    "native physical path is not included by default",
                );
                assert(
                    compatibleOnlyCard.dataset.oaamSourceDefaultIncluded === "true" &&
                        compatibleOnlyCard.dataset.oaamSourceSelected === "true" &&
                        compatibleOnlyCard.dataset.oaamSourceWatchSelected === "true" &&
                        compatibleOnlyCard.dataset.oaamSourceState === "included",
                    "one readable compatible-only path is not selected by default",
                );
                await inspectProjectRegistration({
                    projectCard,
                    projectSourcePath: PROJECT_SOURCE_PATH,
                    route,
                    waitFor,
                    click,
                    assert,
                    assertOrdinaryLanguage,
                    observedDialogs,
                });
                if (sourceSelectionMode === "compatible_only") {
                    const ignore = sharedCard.querySelector('[data-oaam-source-action="ignore"]');
                    click(ignore);
                    const confirmation = await waitFor(
                        () => sharedCard.querySelector('[data-oaam-source-ignore-confirmation="true"]'),
                        `${route} source ignore confirmation`,
                    );
                    click(confirmation.querySelector('[data-oaam-source-action="confirm-ignore"]'));
                    await waitFor(() => {
                        const currentCards = [...sources.querySelectorAll(".source-review-card")];
                        const currentShared = currentCards.find(
                            (card) => card.getAttribute("data-oaam-source-path") === SHARED_SOURCE_PATH,
                        );
                        const currentCompatible = currentCards.find(
                            (card) => card.getAttribute("data-oaam-source-path") === COMPATIBLE_ONLY_SOURCE_PATH,
                        );
                        return (
                            currentShared?.getAttribute("data-oaam-source-selected") === "false" &&
                            currentShared?.getAttribute("data-oaam-source-watch-selected") === "false" &&
                            currentShared?.getAttribute("data-oaam-source-state") === "ignored" &&
                            currentCompatible?.getAttribute("data-oaam-source-selected") === "true"
                        );
                    }, `${route} exact confirmed compatible-only selection`);
                }
                observedJourneyStates.push(`${journeyId}:sources`);
                continueFrom(sources, "sources");
                const assets = await routeStage(route, "assets");
                assertInsideViewport(assets, `${route} Assets`);
                await waitFor(() => assets.querySelector(".import-candidate-list > li"), `${route} Asset candidate`);
                assertProgress(assets, `${route} Assets`);
                assertOrdinaryLanguage(assets, `${route} Assets`);
                assert(assets.textContent?.includes("Portable instructions"), `${route} does not render the reviewed Asset`);
                inspectReviewLayout({ assets, route, assert });
                const candidateInput = assets.querySelector("[data-oaam-import-candidate-id] input[type='checkbox']");
                const importAction = assets.querySelector("[data-oaam-import-commit]");
                assert(
                    candidateInput instanceof HTMLInputElement && candidateInput.checked,
                    `${route} does not select the fresh importable Asset by default`,
                );
                assert(importAction instanceof HTMLButtonElement && !importAction.disabled, `${route} import starts disabled`);
                click(assets.querySelector("[data-oaam-import-candidate-id] .detail-actions button"));
                const inspector = await waitFor(
                    () => assets.querySelector(".import-preview-inspector"),
                    `${route} right-side file inspector`,
                );
                assert(inspector.querySelectorAll("[role='tab']").length === 1, `${route} file inspector lost its tab`);
                await waitFor(
                    () =>
                        inspector
                            .querySelector(".import-preview-source")
                            ?.textContent?.includes("Actual-render preview receipt.") &&
                        inspector.querySelectorAll(".import-preview-line-number").length >= 3 &&
                        inspector.querySelector(".import-preview-token-markup") instanceof HTMLElement,
                    `${route} exact file preview`,
                );
                const inspectorHeader = inspector.querySelector(".import-preview-inspector-header");
                assert(inspectorHeader instanceof HTMLElement, `${route} file inspector header is missing`);
                assert(
                    inspectorHeader.querySelector("h2") === null &&
                        !inspectorHeader.textContent?.includes("Scan result") &&
                        inspector.querySelector("details[data-oaam-technical-detail]") === null,
                    `${route} file inspector retained redundant ready-state chrome`,
                );
                const inspectorContent = inspector.querySelector(".import-preview-inspector-content");
                const previewDocument = inspector.querySelector(".import-preview-document");
                const inspectorContentRect = inspectorContent.getBoundingClientRect();
                const previewDocumentRect = previewDocument.getBoundingClientRect();
                assert(
                    Math.abs(previewDocumentRect.left - inspectorContentRect.left) <= 1 &&
                        Math.abs(previewDocumentRect.right - inspectorContentRect.right) <= 1 &&
                        Math.abs(previewDocumentRect.top - inspectorContentRect.top) <= 1 &&
                        Math.abs(previewDocumentRect.bottom - inspectorContentRect.bottom) <= 1,
                    `${route} file content is still constrained inside a nested preview card`,
                );
                const inspectorRect = inspector.getBoundingClientRect();
                const resizeHandle = inspector.querySelector(".workbench-resize-separator");
                const resizeHandleRect = resizeHandle?.getBoundingClientRect();
                assert(
                    resizeHandle instanceof HTMLElement &&
                        resizeHandleRect.width >= 8 &&
                        resizeHandleRect.left >= inspectorRect.left &&
                        document.elementFromPoint(
                            resizeHandleRect.left + resizeHandleRect.width / 2,
                            resizeHandleRect.top + resizeHandleRect.height / 2,
                        ) === resizeHandle,
                    `${route} file inspector resize handle is clipped or cannot receive pointer input`,
                );
                const reviewMain = assets.querySelector(".import-review-main");
                assert(reviewMain instanceof HTMLElement, `${route} import review main panel is missing`);
                const reviewMainRect = reviewMain.getBoundingClientRect();
                assert(
                    inspectorRect.left >= reviewMainRect.right - 1,
                    `${route} file inspector is nested inside or overlaps the import card ` +
                        `(inspectorLeft=${String(inspectorRect.left)}, reviewRight=${String(reviewMainRect.right)})`,
                );
                assert(
                    Math.abs(inspectorRect.right - window.innerWidth) <= 1,
                    `${route} file inspector is not anchored to the window's right edge`,
                );
                const desktopContent = document.querySelector(".desktop-window-content");
                assert(desktopContent instanceof HTMLElement, `${route} Desktop window content is missing`);
                const desktopContentRect = desktopContent.getBoundingClientRect();
                assert(
                    Math.abs(inspectorRect.top - desktopContentRect.top) <= 1 &&
                        Math.abs(inspectorRect.bottom - window.innerHeight) <= 1,
                    `${route} file inspector does not fill the window content height`,
                );
                await inspectPreviewSoftWrap({ inspector, route, click, waitFor, assert });
                click(buttonWithIcon(inspectorHeader, "list"), `${route} file-list toggle`);
                await waitFor(
                    () => inspector.querySelector(".import-preview-file-list button")?.textContent?.trim() === "AGENTS.md",
                    `${route} exact Asset file list`,
                );
                const revealCountBefore = Number.parseInt(
                    document.documentElement.dataset.oaamImportPreviewFileRevealCount ?? "0",
                    10,
                );
                click(buttonWithIcon(inspectorHeader, "reveal"), `${route} reveal file directory`);
                await waitFor(
                    () =>
                        Number.parseInt(document.documentElement.dataset.oaamImportPreviewFileRevealCount ?? "0", 10) >=
                        revealCountBefore + 1,
                    `${route} file reveal dispatch`,
                );
                const revealCountAfter = Number.parseInt(
                    document.documentElement.dataset.oaamImportPreviewFileRevealCount ?? "0",
                    10,
                );
                assert(revealCountAfter === revealCountBefore + 1, `${route} dispatched the file reveal more than once`);
                const revealReference = JSON.parse(document.documentElement.dataset.oaamImportPreviewFileReference ?? "null");
                assert(
                    revealReference?.previewToken === "actual-render-preview-token" &&
                        revealReference?.candidateId === "actual-render-guidance" &&
                        revealReference?.logicalPath === "AGENTS.md" &&
                        Object.keys(revealReference).length === 3,
                    `${route} did not retain the exact opaque file reveal reference`,
                );
                const inspectorActions = inspectorHeader.querySelector("nav");
                assert(inspectorActions instanceof HTMLElement, `${route} file inspector actions are missing`);
                click(buttonWithIcon(inspectorActions, "close"), `${route} hide file inspector`);
                await waitFor(() => assets.querySelector(".import-preview-inspector") === null, `${route} hidden file inspector`);
                const reviewHeaderActions = assets.querySelector(".section-heading-actions");
                assert(reviewHeaderActions instanceof HTMLElement, `${route} review header actions are missing`);
                click(buttonWithIcon(reviewHeaderActions, "inspector"), `${route} restore file inspector`);
                await waitFor(() => assets.querySelector(".import-preview-inspector"), `${route} restored file inspector`);
                click(buttonWithIcon(reviewHeaderActions, "inspector"), `${route} hide restored file inspector`);
                await waitFor(
                    () => assets.querySelector(".import-preview-inspector") === null,
                    `${route} hidden restored file inspector`,
                );
                await inspectCandidateDeselect({ assets, candidateInput, route, sourceSelectionMode, waitFor, assert });
                observedJourneyStates.push(`${journeyId}:assets`);
                const finishWithoutImport = [...assets.querySelectorAll(".onboarding-actions button")].at(-1);
                click(finishWithoutImport);
                const complete = await routeStage(route, "complete");
                assertInsideViewport(complete, `${route} completion`);
                assertProgress(complete, `${route} completion`);
                assertOrdinaryLanguage(complete, `${route} completion`);
                observedJourneyStates.push(`${journeyId}:complete`);
                const done = [...complete.querySelectorAll(".onboarding-actions button")].at(-1);
                click(done);
            };

            const welcome = await routeStage("onboarding", "welcome");
            assertInsideViewport(welcome, "onboarding welcome");
            assert(welcome.querySelector(".import-journey-steps") === null, "welcome incorrectly consumes a numbered stage");
            assertOrdinaryLanguage(welcome, "onboarding welcome");
            observedJourneyStates.push("first_run_onboarding:welcome");
            click(welcome.querySelector("[data-oaam-onboarding-start]"));
            await reviewJourney("onboarding", "first_run_onboarding", "default_both");
            const library = await waitFor(() => document.querySelector(".project-library-shell"), "Project-first workbench");
            assertInsideViewport(library, "Project-first workbench");
            assert(
                library.getAttribute("data-oaam-asset-count") === "0",
                "journey workbench does not expose the expected empty Asset library",
            );
            assert(library.querySelector(".library-empty-state") instanceof HTMLElement, "empty Project state is missing");
            observedJourneyStates.push("project_management:empty", "asset_library_lifecycle:empty");
            assert(
                document.documentElement.dataset.oaamOnboardingCompletionCount === "1",
                "first-run completion did not persist exactly once",
            );
            const openGuidedImport = library.querySelector("[data-oaam-action='start-guided-import']");
            click(openGuidedImport);
            await reviewJourney("guided_import", "ordinary_guided_import", "compatible_only");
            await waitFor(
                () => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"),
                "exact Asset library after guided import",
            );
            assert(
                document.querySelector("[data-oaam-route='sources']") === null,
                "empty-library import inserted the Import-sources management task into the guided journey",
            );
            assert(
                document.documentElement.dataset.oaamOnboardingCompletionCount === "1",
                "ordinary guided import mutated first-run completion",
            );
            assert(
                document.documentElement.dataset.oaamPreviewCancellationCount === "4",
                `return and finish actions did not cancel all four previews: ${document.documentElement.dataset.oaamPreviewCancellationCount}`,
            );
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: observedDialogs,
                journeyStates: observedJourneyStates,
                sourceRuntimeSelection: document.documentElement.dataset.oaamSourceRuntimeSelection,
                routeStates: ["onboarding:ready", "library:ready", "guided_import:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, (${inspectJourneyProjectRegistration.toString()}), (${inspectImportCandidateDeselect.toString()}), (${inspectImportReviewLayout.toString()}), (${inspectImportPreviewSoftWrap.toString()}), (${assertImportStepBounds.toString()}), ${ordinaryLanguageRendererArguments()})`,
        true,
    );
    return entry.onboardingContainment ? proveOnboardingContainment(webContents, entry, journey) : journey;
}
async function inspectStaticCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspect(entryValue, assertOrdinarySurfaceLanguage, ordinarySurfaceLanguageLexicon) {
            const waitFor = async (predicate, label, timeoutMs = 5000) => {
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
            const ordinaryText = (root) => {
                const copy = root.cloneNode(true);
                for (const hidden of copy.querySelectorAll("[hidden], [data-oaam-technical-detail]")) hidden.remove();
                return copy.textContent ?? "";
            };
            const expected =
                entryValue.scenario === "startup_starting"
                    ? { route: "startup", state: "starting" }
                    : entryValue.scenario === "startup_reconnecting"
                      ? { route: "startup", state: "reconnecting" }
                      : entryValue.scenario === "startup_failed_empty_reason"
                        ? { route: "startup", state: "failed" }
                        : entryValue.scenario === "startup_client_unavailable"
                          ? { route: "startup", state: "client_unavailable" }
                          : { route: "recovery_settings", state: "ready" };
            const surface = await waitFor(
                () => document.querySelector(`[data-oaam-route="${expected.route}"][data-oaam-state="${expected.state}"]`),
                `${expected.route}:${expected.state}`,
            );
            assert(surface instanceof HTMLElement, "static surface has the wrong element type");
            const ordinary = ordinaryText(surface);
            assertOrdinarySurfaceLanguage(surface, "static surface", entryValue.id, ordinarySurfaceLanguageLexicon);
            assert(
                !/\b(?:host\\.|session\\.|host_|session_)[a-z0-9_.-]*/iu.test(ordinary),
                "static surface exposes an internal reason code",
            );
            if (entryValue.scenario === "startup_reconnecting" || entryValue.scenario === "startup_client_unavailable") {
                const technical = surface.querySelector("[data-oaam-technical-detail]");
                assert(technical instanceof HTMLElement, "failure reason is not retained in attributed technical detail");
                const reasonCode = technical.querySelector("code");
                assert(
                    reasonCode instanceof HTMLElement && (reasonCode.textContent?.trim().length ?? 0) > 0,
                    "failure reason technical detail contains an empty code value",
                );
            }
            if (entryValue.scenario === "startup_failed_empty_reason") {
                assert(
                    surface.querySelector("[data-oaam-technical-detail]") === null &&
                        surface.querySelector(".host-failure-reason code") === null,
                    "empty startup failure code still renders a technical label or code value",
                );
                const recoveryActions = [
                    surface.querySelector('[data-oaam-interaction-entry="app.app.002"]'),
                    surface.querySelector('[data-oaam-interaction-entry="app.app.003"]'),
                ];
                assert(
                    recoveryActions.every(
                        (action) =>
                            action instanceof HTMLButtonElement &&
                            !action.disabled &&
                            (action.textContent?.trim().length ?? 0) > 0,
                    ),
                    "empty startup failure does not retain enabled retry and log actions",
                );
            }
            if (entryValue.scenario === "recovery_settings") {
                await waitFor(
                    () => surface.querySelector("[data-oaam-settings-scroll-sentinel='backup_recovery']"),
                    "recovery Settings scroll sentinel",
                );
            }
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: [
                    entryValue.scenario === "recovery_settings"
                        ? "state_backup_and_recovery:initial"
                        : `host_startup_and_recovery:${expected.state}`,
                ],
                routeStates: [`${expected.route}:${expected.state}`],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()})`,
        true,
    );
}
async function run() {
    validateDesktopVisualMatrix();
    const projectGuidanceObservedTargetState = observeMissingProjectGuidanceTarget();
    const projectGuidanceRenderReceipt = await projectGuidanceProductionRenderReceipt();
    await app.whenReady();
    const reviewScreenshots = createReviewScreenshotRecorder(screenshotOutputRoot, fail);
    const window = new BrowserWindow({
        show: true,
        useContentSize: true,
        width: 860,
        height: 560,
        webPreferences: {
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    const observedRouteStates = new Set();
    const observedDialogStates = new Set();
    const observedJourneyStates = new Set();
    let dialogInventory;
    let surfaceInventory;
    try {
        await window.loadURL("about:blank");
        window.webContents.debugger.attach("1.3");
        for (const entry of ACTUAL_RENDER_CASES) {
            trace(`${entry.id} start`);
            const physicalWidth = Math.round(entry.windowCssViewport.width * entry.deviceScaleFactor);
            const physicalHeight = Math.round(entry.windowCssViewport.height * entry.deviceScaleFactor);
            window.setContentSize(physicalWidth, physicalHeight);
            const url = new URL(pathToFileURL(path.join(outputRoot, "index.html")).href);
            url.searchParams.set("locale", entry.locale);
            url.searchParams.set("theme", entry.theme);
            url.searchParams.set("textSize", entry.textSize);
            url.searchParams.set("palette", entry.palette);
            url.searchParams.set("systemDark", String(entry.systemDark));
            url.searchParams.set("scenario", entry.scenario);
            if (entry.projectCount !== undefined) url.searchParams.set("projectCount", String(entry.projectCount));
            if (entry.scenario === "deployment") {
                url.searchParams.set("deploymentAssetChoiceCount", String(entry.deploymentAssetChoiceCount));
                url.searchParams.set("deploymentProviderCount", String(entry.deploymentProviderCount ?? 2));
            }
            if (entry.scenario === "project_guidance_apply_rehearsal") {
                url.searchParams.set("variant", entry.variant);
                url.searchParams.set("targetObservation", projectGuidanceObservedTargetState);
                url.searchParams.set("productionRenderReceipt", JSON.stringify(projectGuidanceRenderReceipt));
            }
            let result;
            if (entry.scenario === "surface_loading") {
                await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
                    features: [
                        {
                            name: "prefers-reduced-motion",
                            value: entry.reducedMotion ? "reduce" : "no-preference",
                        },
                        {
                            name: "prefers-contrast",
                            value: entry.highContrast === true ? "more" : "no-preference",
                        },
                    ],
                });
                window.focus();
                result = await loadAndInspectSurfaceLoading(window, url, entry);
            } else {
                await window.loadURL(url.href);
                trace(`${entry.id} loaded`);
                await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
                    features: [
                        {
                            name: "prefers-reduced-motion",
                            value: entry.reducedMotion ? "reduce" : "no-preference",
                        },
                        {
                            name: "prefers-contrast",
                            value: entry.highContrast === true ? "more" : "no-preference",
                        },
                    ],
                });
                trace(`${entry.id} media`);
                window.webContents.setZoomFactor(entry.deviceScaleFactor);
                await window.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true);
                window.focus();
                await new Promise((resolve) => setTimeout(resolve, 50));
                result =
                    entry.scenario === "source_import_feedback"
                        ? await inspectSourceImportFeedbackCase(window.webContents, entry)
                        : entry.scenario === "journey"
                          ? await inspectJourneyCase(window.webContents, entry)
                          : entry.scenario === "journey_empty"
                            ? await inspectEmptyJourneyCase(window.webContents, entry)
                            : entry.scenario === "asset_library_project_review" ||
                                entry.scenario === "asset_library_global_review" ||
                                entry.scenario === "asset_library_empty_review" ||
                                entry.scenario === "import_sources_review" ||
                                entry.scenario === "catalog_search_context_review"
                              ? await inspectLibraryViewCase(window.webContents, entry)
                              : entry.scenario === "workbench"
                                ? await inspectRenderedCase(window.webContents, entry)
                                : entry.scenario === "deployment"
                                  ? await inspectDeploymentCase(window.webContents, entry)
                                  : entry.scenario === "project_asset_operations"
                                    ? await inspectProjectAssetOperationsCase(window.webContents, entry)
                                    : entry.scenario === "state_diagnostics_operations"
                                      ? await inspectStateDiagnosticsOperationsCase(window.webContents, entry)
                                      : entry.scenario === "deployment_operations"
                                        ? await inspectDeploymentOperationsCase(window.webContents, entry)
                                        : entry.scenario === "complete_directory_preview"
                                          ? await inspectCompleteDirectoryPreviewCase(window.webContents, entry)
                                          : entry.scenario === "project_guidance_apply_rehearsal"
                                            ? await inspectProjectGuidanceApplyRehearsalCase(window.webContents, entry)
                                            : entry.scenario === "renderer_failure"
                                              ? await inspectRendererFailureCase(window.webContents, entry)
                                              : await inspectStaticCase(window.webContents, entry);
            }
            trace(`${entry.id} inspected`);
            if (entry.projectCount === 64) await proveDenseProjectSidebar(window.webContents, entry);
            if (Math.abs(result.innerWidth - entry.windowCssViewport.width) > 2) {
                fail(`${entry.id}: CSS viewport width ${String(result.innerWidth)} != ${String(entry.windowCssViewport.width)}`);
            }
            if (Math.abs(result.innerHeight - entry.windowCssViewport.height) > 2) {
                fail(
                    `${entry.id}: CSS viewport height ${String(result.innerHeight)} != ${String(entry.windowCssViewport.height)}`,
                );
            }
            const expectedTheme = entry.theme === "system" ? (entry.systemDark ? "dark" : "light") : entry.theme;
            if (result.resolvedTheme !== expectedTheme) {
                fail(`${entry.id}: resolved theme ${String(result.resolvedTheme)} != ${expectedTheme}`);
            }
            if (result.resolvedLocale !== entry.locale) {
                fail(`${entry.id}: resolved locale ${String(result.resolvedLocale)} != ${entry.locale}`);
            }
            await reviewScreenshots.capture(window, entry);
            for (const routeState of result.routeStates) observedRouteStates.add(routeState);
            for (const dialogState of result.dialogStates) observedDialogStates.add(dialogState);
            for (const journeyState of result.journeyStates) observedJourneyStates.add(journeyState);
            const currentDialogInventory = [...result.dialogInventory].sort();
            if (dialogInventory === undefined) dialogInventory = currentDialogInventory;
            else if (JSON.stringify(dialogInventory) !== JSON.stringify(currentDialogInventory)) {
                fail(`${entry.id}: production dialog inventory changed between actual-render cases`);
            }
            const currentSurfaceInventory = [...result.surfaceInventory].sort();
            if (surfaceInventory === undefined) surfaceInventory = currentSurfaceInventory;
            else if (JSON.stringify(surfaceInventory) !== JSON.stringify(currentSurfaceInventory)) {
                fail(`${entry.id}: production surface inventory changed between actual-render cases`);
            }
            if (entry.scenario === "workbench") {
                await proveWheelReachability(window.webContents, entry, result.scrollProbe);
                trace(`${entry.id} wheel`);
                await proveTransientSidebar(window.webContents, entry);
            } else if (entry.scenario === "deployment" && entry.deploymentAssetChoiceCount === 1) {
                await proveDeploymentWheelReachability(window.webContents, entry, result.scrollProbe);
                trace(`${entry.id} deployment-wheel`);
            }
            trace(`${entry.id} done`);
        }
        if (surfaceInventory === undefined) fail("production surface inventory was not rendered");
        if (dialogInventory === undefined) fail("production dialog inventory was not rendered");
        const observedSurfaces = [...new Set([...observedRouteStates].map((value) => value.split(":")[0]))].sort();
        const surfaceGaps = surfaceInventory.filter((surface) => !observedSurfaces.includes(surface)).sort();
        if (JSON.stringify(surfaceGaps) !== JSON.stringify([...EXPECTED_ACTUAL_RENDER_SURFACE_GAPS].sort())) {
            fail(`actual-render surface gaps ${JSON.stringify(surfaceGaps)} do not equal reviewed gaps`);
        }
        const missingRouteStates = EXPECTED_ACTUAL_RENDER_ROUTE_STATES.filter((value) => !observedRouteStates.has(value));
        if (missingRouteStates.length !== 0) {
            fail(`actual-render route states are missing ${JSON.stringify(missingRouteStates)}`);
        }
        const missingJourneyStates = EXPECTED_ACTUAL_RENDER_JOURNEY_STATES.filter((value) => !observedJourneyStates.has(value));
        const unexpectedJourneyStates = [...observedJourneyStates]
            .filter((value) => !EXPECTED_ACTUAL_RENDER_JOURNEY_STATES.includes(value))
            .sort();
        if (missingJourneyStates.length !== 0 || unexpectedJourneyStates.length !== 0) {
            fail(
                `actual-render journey state drift: missing=${JSON.stringify(missingJourneyStates)} ` +
                    `unexpected=${JSON.stringify(unexpectedJourneyStates)}`,
            );
        }
        const dialogGaps = dialogInventory.filter((dialogId) => !observedDialogStates.has(dialogId)).sort();
        if (dialogGaps.length !== 0) {
            fail(`actual-render dialog gaps ${JSON.stringify(dialogGaps)} are not allowed`);
        }
        reviewScreenshots.writeManifest();
        process.stdout.write(`OAAM_ACTUAL_RENDER verified=${String(ACTUAL_RENDER_CASES.length)}\n`);
        process.stdout.write(`OAAM_ACTUAL_RENDER surface_gaps=${surfaceGaps.length === 0 ? "none" : surfaceGaps.join(",")}\n`);
        process.stdout.write(`OAAM_ACTUAL_RENDER dialog_gaps=${dialogGaps.length === 0 ? "none" : dialogGaps.join(",")}\n`);
        process.stdout.write("OAAM_ACTUAL_RENDER journey_state_gaps=none\n");
    } finally {
        if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
        window.destroy();
        app.quit();
    }
}
run().catch((error) => {
    process.stderr.write(`OAAM_ACTUAL_RENDER failed=${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
});
