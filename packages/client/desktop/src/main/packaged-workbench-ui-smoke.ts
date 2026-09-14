import type { PackagedProofSubjectIdentity } from "../bridge/desktop-bridge";

export {
    PACKAGED_WORKBENCH_PERSISTENCE_SMOKE_SWITCH,
    PACKAGED_WORKBENCH_UI_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";
export const PACKAGED_WORKBENCH_UI_LINE = "OAAM_DESKTOP_WORKBENCH_UI_SMOKE startup=recovered settings=updated search=activated";
export const PACKAGED_WORKBENCH_PERSISTENCE_LINE = "OAAM_DESKTOP_WORKBENCH_UI_SMOKE settings=persisted restart=complete";
const PACKAGED_LIBRARY_PROJECT_VERSION_COUNT = 2;

export const PACKAGED_WORKBENCH_SCREENSHOT_DIRECTORY = "oaam-phase51-installed-workbench";
export const PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES = [
    "startup-starting",
    "startup-reconnecting",
    "startup-failed",
    "startup-recovered-workbench",
    "settings-general",
    "settings-appearance-updated",
    "search-initial",
    "search-populated",
    "search-focus-restored",
    "search-activated-asset",
] as const;
export const PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE = "settings-appearance-after-restart";
export const PACKAGED_WORKBENCH_SCREENSHOT_STAGES = [
    ...PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES,
    PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE,
] as const;

export type PackagedWorkbenchJourneyScreenshotStage = (typeof PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES)[number];
export type PackagedWorkbenchScreenshotStage = (typeof PACKAGED_WORKBENCH_SCREENSHOT_STAGES)[number];

export interface PackagedWorkbenchUiSmokeWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedWorkbenchUiProof {
    readonly status: "complete";
    readonly startup: {
        readonly starting: true;
        readonly reconnecting: true;
        readonly terminalFailure: true;
        readonly manualRetryRecovered: true;
        readonly recoveredAssetCount: 2;
    };
    readonly settings: {
        readonly enteredThroughOrdinaryControl: true;
        readonly theme: "dark";
        readonly textSize: "large";
        readonly surfacePalette: "cool";
    };
    readonly search: {
        readonly query: "oaam-proof";
        readonly exactMatchCount: number;
        readonly highlightedMatchCount: number;
        readonly focusRestored: true;
        readonly exactAssetActivated: true;
    };
}

export interface PackagedWorkbenchPersistenceProof {
    readonly status: "complete";
    readonly enteredThroughOrdinaryControl: true;
    readonly theme: "dark";
    readonly textSize: "large";
    readonly surfacePalette: "cool";
    readonly assetCount: 2;
}

interface PackagedWorkbenchUiSmokeOptions {
    readonly capture: (stage: PackagedWorkbenchJourneyScreenshotStage) => Promise<void>;
}

interface PackagedWorkbenchPersistenceSmokeOptions {
    readonly capture: (stage: typeof PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE) => Promise<void>;
}

const WAIT_FOR_STARTUP_STATE_SCRIPT = `(async (expectedState) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const selector = 'main[data-oaam-route="startup"][data-oaam-state="' + expectedState + '"]';
        const surface = document.querySelector(selector);
        if (surface instanceof HTMLElement) {
            const visibleCopy = surface.cloneNode(true);
            if (visibleCopy instanceof HTMLElement) {
                for (const technical of visibleCopy.querySelectorAll("[data-oaam-technical-detail]")) technical.remove();
                if (/\\b(?:host|session)[._][a-z0-9_.-]+/iu.test(visibleCopy.textContent ?? "")) {
                    throw new Error("startup " + expectedState + " exposes an internal reason code");
                }
            }
            return expectedState;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for startup " + expectedState);
})`;

const RETRY_TERMINAL_STARTUP_FAILURE_SCRIPT = `(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const retry = document.querySelector(
            'main[data-oaam-route="startup"][data-oaam-state="failed"] .status-card-actions button:first-child'
        );
        if (retry instanceof HTMLButtonElement && !retry.disabled) {
            retry.click();
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("terminal startup Retry is unavailable");
})`;

const WAIT_FOR_POPULATED_WORKBENCH_SCRIPT = `(async (expectedAssetCount) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const workbench = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        if (workbench instanceof HTMLElement) {
            const assetCount = Number.parseInt(workbench.dataset.oaamAssetCount ?? "", 10);
            if (assetCount === expectedAssetCount) return assetCount;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for the populated workbench with " + String(expectedAssetCount) + " Assets");
})`;

const OPEN_GENERAL_SETTINGS_SCRIPT = `(async () => {
    const controlDeadline = Date.now() + 15000;
    while (Date.now() < controlDeadline) {
        const settings = document.querySelector(".library-settings-button");
        if (settings instanceof HTMLButtonElement && !settings.disabled) {
            settings.click();
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const surfaceDeadline = Date.now() + 15000;
    while (Date.now() < surfaceDeadline) {
        const shell = document.querySelector(
            'main[data-oaam-route="settings"][data-oaam-state="ready"][data-settings-category="general"]'
        );
        const back = shell?.querySelector(".settings-return-button");
        const search = shell?.querySelector(".settings-search input");
        if (
            shell instanceof HTMLElement &&
            back instanceof HTMLButtonElement &&
            !back.disabled &&
            search instanceof HTMLInputElement &&
            !search.disabled
        ) return "general";
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("General Settings did not expose its return action and local Search");
})`;

const SELECT_APPEARANCE_PREFERENCES_SCRIPT = `(async () => {
    const waitFor = async (read, label) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const value = read();
            if (value !== undefined) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const choose = async (fieldIndex, optionIndex, datasetKey, expected) => {
        const fields = [...document.querySelectorAll(".presentation-preferences-field")];
        const field = fields[fieldIndex];
        const trigger = field?.querySelector(".workbench-select-trigger");
        if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) {
            throw new Error("appearance field " + String(fieldIndex) + " is unavailable");
        }
        trigger.click();
        const option = await waitFor(() => {
            const selector = '[role="option"][data-option-index="' + String(optionIndex) + '"]';
            const candidate = field.querySelector(selector);
            return candidate instanceof HTMLButtonElement && !candidate.disabled ? candidate : undefined;
        }, "appearance option " + String(fieldIndex) + "/" + String(optionIndex));
        option.click();
        await waitFor(
            () => document.documentElement.dataset[datasetKey] === expected ? true : undefined,
            datasetKey + "=" + expected
        );
        await waitFor(() => !trigger.disabled ? true : undefined, "saved appearance field " + String(fieldIndex));
    };
    await choose(1, 2, "oaamTheme", "dark");
    await choose(2, 2, "oaamTextSize", "large");
    await choose(3, 2, "oaamSurfacePalette", "cool");
    return {
        theme: document.documentElement.dataset.oaamTheme ?? "",
        textSize: document.documentElement.dataset.oaamTextSize ?? "",
        surfacePalette: document.documentElement.dataset.oaamSurfacePalette ?? "",
    };
})`;

const RETURN_FROM_SETTINGS_SCRIPT = `(async () => {
    const back = document.querySelector(".settings-return-button");
    if (!(back instanceof HTMLButtonElement) || back.disabled) throw new Error("Settings return-to-app is unavailable");
    back.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const workbench = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        if (workbench instanceof HTMLElement && Number.parseInt(workbench.dataset.oaamAssetCount ?? "", 10) === 2) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Settings return-to-app did not restore the populated workbench");
})`;

const OPEN_CATALOG_SEARCH_SCRIPT = `(async () => {
    const search = document.querySelector(".library-brand-search");
    if (!(search instanceof HTMLButtonElement) || search.disabled) throw new Error("ordinary catalog Search is unavailable");
    search.focus();
    search.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const input = document.querySelector(".catalog-search-input input");
        const dialog = document.querySelector(".catalog-search-dialog");
        if (
            input instanceof HTMLInputElement &&
            dialog instanceof HTMLElement &&
            document.activeElement === input
        ) {
            return dialog.getBoundingClientRect().top;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("catalog Search did not open with input focus");
})`;

const POPULATE_CATALOG_SEARCH_SCRIPT = `(async (query) => {
    const input = document.querySelector(".catalog-search-input input");
    if (!(input instanceof HTMLInputElement)) throw new Error("catalog Search input is unavailable");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("catalog Search input value setter is unavailable");
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const results = [...document.querySelectorAll(".catalog-search-result")].filter(
            (candidate) => candidate instanceof HTMLButtonElement && !candidate.disabled
        );
        const highlights = [...document.querySelectorAll("[data-oaam-search-match]")];
        const dialog = document.querySelector(".catalog-search-dialog");
        if (results.length > 0 && highlights.length > 0 && dialog instanceof HTMLElement) {
            if (highlights.some(
                (highlight) => highlight.textContent?.toLocaleLowerCase("en-US") !== query.toLocaleLowerCase("en-US")
            )) {
                throw new Error("catalog Search highlights non-matching text");
            }
            return {
                query,
                exactMatchCount: results.length,
                highlightedMatchCount: highlights.length,
                dialogTop: dialog.getBoundingClientRect().top,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("catalog Search produced no highlighted result");
})`;

const CLOSE_CATALOG_SEARCH_AND_VERIFY_FOCUS_SCRIPT = `(async () => {
    const input = document.querySelector(".catalog-search-input input");
    if (!(input instanceof HTMLInputElement)) throw new Error("catalog Search input is unavailable");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const search = document.querySelector(".library-brand-search");
        if (
            document.querySelector(".catalog-search-dialog") === null &&
            search instanceof HTMLButtonElement &&
            document.activeElement === search
        ) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("closing catalog Search did not restore focus to its opening control");
})`;

const ACTIVATE_EXACT_ASSET_SEARCH_RESULT_SCRIPT = `(async (query) => {
    const exactAsset = [...document.querySelectorAll(".catalog-search-result")].find(
        (candidate) =>
            candidate instanceof HTMLButtonElement &&
            !candidate.disabled &&
            candidate.textContent?.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US"))
    );
    if (!(exactAsset instanceof HTMLButtonElement)) throw new Error("catalog Search has no exact Asset result");
    exactAsset.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const library = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-state="ready"][data-inspector-open="true"]'
        );
        const inspectorTitle = document.querySelector(".asset-inspector .asset-inspector-header h2");
        if (
            library instanceof HTMLElement &&
            inspectorTitle instanceof HTMLHeadingElement &&
            inspectorTitle.textContent?.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US"))
        ) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("catalog Search did not activate the exact Asset route");
})`;

const VERIFY_PERSISTED_APPEARANCE_SCRIPT = `(async () => {
    const workbenchDeadline = Date.now() + 30000;
    let assetCount = -1;
    while (Date.now() < workbenchDeadline) {
        const workbench = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        if (workbench instanceof HTMLElement) {
            assetCount = Number.parseInt(workbench.dataset.oaamAssetCount ?? "", 10);
            if (assetCount === 2) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (assetCount !== 2) throw new Error("persisted workbench did not retain two Assets");
    const settings = document.querySelector(".library-settings-button");
    if (!(settings instanceof HTMLButtonElement) || settings.disabled) {
        throw new Error("persisted workbench Settings control is unavailable");
    }
    settings.click();
    const settingsDeadline = Date.now() + 15000;
    while (Date.now() < settingsDeadline) {
        const shell = document.querySelector(
            'main[data-oaam-route="settings"][data-oaam-state="ready"][data-settings-category="general"]'
        );
        if (shell instanceof HTMLElement) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!(
        document.querySelector(
            'main[data-oaam-route="settings"][data-oaam-state="ready"][data-settings-category="general"]'
        ) instanceof HTMLElement
    )) {
        throw new Error("persisted General Settings did not open through the ordinary workbench control");
    }
    const theme = document.documentElement.dataset.oaamTheme ?? "";
    const textSize = document.documentElement.dataset.oaamTextSize ?? "";
    const surfacePalette = document.documentElement.dataset.oaamSurfacePalette ?? "";
    if (theme !== "dark" || textSize !== "large" || surfacePalette !== "cool") {
        throw new Error(
            "appearance preferences did not survive restart: " + theme + "/" + textSize + "/" + surfacePalette
        );
    }
    return { theme, textSize, surfacePalette, assetCount };
})`;

function exactAppearance(value: unknown): {
    readonly theme: "dark";
    readonly textSize: "large";
    readonly surfacePalette: "cool";
} {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        (value as Record<string, unknown>).theme !== "dark" ||
        (value as Record<string, unknown>).textSize !== "large" ||
        (value as Record<string, unknown>).surfacePalette !== "cool"
    ) {
        throw new TypeError("invalid packaged workbench appearance proof");
    }
    return Object.freeze({ theme: "dark", textSize: "large", surfacePalette: "cool" });
}

function exactSearch(value: unknown): {
    readonly query: "oaam-proof";
    readonly exactMatchCount: number;
    readonly highlightedMatchCount: number;
} {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("invalid packaged workbench Search proof");
    }
    const record = value as Record<string, unknown>;
    if (
        record.query !== "oaam-proof" ||
        !Number.isSafeInteger(record.exactMatchCount) ||
        Number(record.exactMatchCount) < 1 ||
        !Number.isSafeInteger(record.highlightedMatchCount) ||
        Number(record.highlightedMatchCount) < 1
    ) {
        throw new TypeError("invalid packaged workbench Search proof");
    }
    return Object.freeze({
        query: "oaam-proof",
        exactMatchCount: Number(record.exactMatchCount),
        highlightedMatchCount: Number(record.highlightedMatchCount),
    });
}

function exactDialogTop(value: unknown): number {
    const top =
        typeof value === "number"
            ? value
            : typeof value === "object" && value !== null && !Array.isArray(value)
              ? (value as Record<string, unknown>).dialogTop
              : undefined;
    if (typeof top !== "number" || !Number.isFinite(top) || top < 0) {
        throw new TypeError("invalid packaged workbench Search geometry proof");
    }
    return top;
}

function assertStableSearchTop(expectedTop: number, actualTop: number): void {
    if (Math.abs(expectedTop - actualTop) > 1) {
        throw new TypeError("packaged workbench Search dialog moved when its result inventory changed");
    }
}

export async function proveWindowsPackagedWorkbenchUi(
    webContents: PackagedWorkbenchUiSmokeWebContents,
    options: PackagedWorkbenchUiSmokeOptions,
): Promise<PackagedWorkbenchUiProof> {
    const execute = (script: string, ...input: readonly unknown[]): Promise<unknown> =>
        webContents.executeJavaScript(`(${script})(${input.map((value) => JSON.stringify(value)).join(",")})`);

    if ((await execute(WAIT_FOR_STARTUP_STATE_SCRIPT, "starting")) !== "starting") {
        throw new TypeError("invalid packaged starting proof");
    }
    await options.capture("startup-starting");
    if ((await execute(WAIT_FOR_STARTUP_STATE_SCRIPT, "reconnecting")) !== "reconnecting") {
        throw new TypeError("invalid packaged reconnecting proof");
    }
    await options.capture("startup-reconnecting");
    if ((await execute(WAIT_FOR_STARTUP_STATE_SCRIPT, "failed")) !== "failed") {
        throw new TypeError("invalid packaged terminal startup proof");
    }
    await options.capture("startup-failed");
    if ((await execute(RETRY_TERMINAL_STARTUP_FAILURE_SCRIPT)) !== true) {
        throw new TypeError("invalid packaged Retry proof");
    }
    const recoveredAssetCount = await execute(WAIT_FOR_POPULATED_WORKBENCH_SCRIPT, 2);
    if (recoveredAssetCount !== 2) throw new TypeError("invalid packaged recovered workbench proof");
    await options.capture("startup-recovered-workbench");

    if ((await execute(OPEN_GENERAL_SETTINGS_SCRIPT)) !== "general") {
        throw new TypeError("invalid packaged Settings entry proof");
    }
    await options.capture("settings-general");
    const appearance = exactAppearance(await execute(SELECT_APPEARANCE_PREFERENCES_SCRIPT));
    await options.capture("settings-appearance-updated");
    if ((await execute(RETURN_FROM_SETTINGS_SCRIPT)) !== true) {
        throw new TypeError("invalid packaged Settings return proof");
    }

    const initialSearchTop = exactDialogTop(await execute(OPEN_CATALOG_SEARCH_SCRIPT));
    await options.capture("search-initial");
    const populatedSearch = await execute(POPULATE_CATALOG_SEARCH_SCRIPT, "oaam-proof");
    const search = exactSearch(populatedSearch);
    assertStableSearchTop(initialSearchTop, exactDialogTop(populatedSearch));
    await options.capture("search-populated");
    if ((await execute(CLOSE_CATALOG_SEARCH_AND_VERIFY_FOCUS_SCRIPT)) !== true) {
        throw new TypeError("invalid packaged Search focus-restoration proof");
    }
    await options.capture("search-focus-restored");
    const reopenedSearchTop = exactDialogTop(await execute(OPEN_CATALOG_SEARCH_SCRIPT));
    assertStableSearchTop(initialSearchTop, reopenedSearchTop);
    const reopenedSearch = await execute(POPULATE_CATALOG_SEARCH_SCRIPT, "oaam-proof");
    exactSearch(reopenedSearch);
    assertStableSearchTop(initialSearchTop, exactDialogTop(reopenedSearch));
    if ((await execute(ACTIVATE_EXACT_ASSET_SEARCH_RESULT_SCRIPT, "oaam-proof")) !== true) {
        throw new TypeError("invalid packaged Search route-activation proof");
    }
    await options.capture("search-activated-asset");

    return Object.freeze({
        status: "complete",
        startup: Object.freeze({
            starting: true,
            reconnecting: true,
            terminalFailure: true,
            manualRetryRecovered: true,
            recoveredAssetCount: 2,
        }),
        settings: Object.freeze({
            enteredThroughOrdinaryControl: true,
            ...appearance,
        }),
        search: Object.freeze({
            ...search,
            focusRestored: true,
            exactAssetActivated: true,
        }),
    });
}

export async function proveWindowsPackagedWorkbenchPersistence(
    webContents: PackagedWorkbenchUiSmokeWebContents,
    options: PackagedWorkbenchPersistenceSmokeOptions,
): Promise<PackagedWorkbenchPersistenceProof> {
    const value = await webContents.executeJavaScript(`(${VERIFY_PERSISTED_APPEARANCE_SCRIPT})()`);
    const appearance = exactAppearance(value);
    const assetCount =
        typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>).assetCount
            : undefined;
    if (assetCount !== 2) throw new TypeError("invalid packaged persisted workbench Asset count");
    await options.capture(PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE);
    return Object.freeze({
        status: "complete",
        enteredThroughOrdinaryControl: true,
        ...appearance,
        assetCount: 2,
    });
}

export { PACKAGED_LIBRARY_UI_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
export const PACKAGED_LIBRARY_UI_LINE =
    "OAAM_DESKTOP_LIBRARY_UI_SMOKE project=reviewed asset=compared delete=restored purge=reviewed";
export const PACKAGED_LIBRARY_SCREENSHOT_DIRECTORY = "oaam-phase51-installed-library";
export const PACKAGED_LIBRARY_SCREENSHOT_STAGES = [
    "project-library",
    "project-manage",
    "project-stop-review",
    "project-asset-inspector",
    "project-asset-comparison",
    "global-bounded-library",
    "asset-delete-review",
    "asset-deleted",
    "asset-purge-review",
    "asset-restored",
] as const;

export type PackagedLibraryScreenshotStage = (typeof PACKAGED_LIBRARY_SCREENSHOT_STAGES)[number];

export interface PackagedLibraryUiProof {
    readonly status: "complete";
    readonly project: {
        readonly selectedProjectId: string;
        readonly selectedAssetId: string;
        readonly visibleProjectCount: number;
        readonly unrelatedProjectCount: number;
        readonly selectedProjectAssetCount: 1;
        readonly totalAssetCount: number;
        readonly manageDialog: true;
        readonly destructiveReview: true;
        readonly backupGate: true;
        readonly reviewCancelled: true;
        readonly comparedVersionCount: 2;
    };
    readonly asset: {
        readonly boundedGlobalCount: 50;
        readonly comparisonRendered: true;
        readonly deleteReviewed: true;
        readonly deleted: true;
        readonly purgeReviewed: true;
        readonly restoreCompleted: true;
    };
}

interface PackagedLibraryUiSmokeOptions {
    readonly capture: (stage: PackagedLibraryScreenshotStage) => Promise<void>;
    readonly subject: PackagedProofSubjectIdentity;
}

const ENTER_PROJECT_LIBRARY_SCRIPT = `(async (subject) => {
    const deadline = Date.now() + 45000;
    let onboardingDismissed = false;
    while (Date.now() < deadline) {
        const onboarding = document.querySelector(
            'main[data-oaam-route="onboarding"][data-oaam-state="ready"][data-oaam-step="welcome"]'
        );
        if (onboarding instanceof HTMLElement) {
            const later = onboarding.querySelector(".onboarding-actions .library-secondary-button");
            if (!(later instanceof HTMLButtonElement) || later.disabled) {
                throw new Error("onboarding Set up later is unavailable");
            }
            later.click();
            onboardingDismissed = true;
        }
        const library = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        if (library instanceof HTMLElement) {
            if (library.dataset.oaamSubject !== "projects") {
                const projects = library.querySelector('[data-oaam-subject-choice="projects"]');
                if (projects instanceof HTMLButtonElement && !projects.disabled) projects.click();
            } else {
                const projectButtons = [...library.querySelectorAll(".asset-tree-project[data-oaam-project-id]")];
                const exactProjectButtons = projectButtons.filter(
                    (candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.oaamProjectId === subject.projectId,
                );
                if (exactProjectButtons.length !== 1) {
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    continue;
                }
                const exactProject = exactProjectButtons[0];
                if (!(exactProject instanceof HTMLButtonElement) || exactProject.disabled) {
                    throw new Error("the exact packaged Project is unavailable");
                }
                if (library.dataset.oaamProjectId !== subject.projectId) {
                    exactProject.click();
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    continue;
                }
                const visibleProjectCount = projectButtons.length;
                const unrelatedProjectCount = projectButtons.filter(
                    (candidate) => candidate instanceof HTMLElement && candidate.dataset.oaamProjectId !== subject.projectId,
                ).length;
                const totalAssetCount = Number.parseInt(library.dataset.oaamAssetCount ?? "", 10);
                const projectCollection = library.querySelector('.asset-collection[data-oaam-total-count="1"]');
                const exactAssets = [...(projectCollection?.querySelectorAll(".asset-library-item[data-oaam-asset-id]") ?? [])].filter(
                    (candidate) => candidate instanceof HTMLElement && candidate.dataset.oaamAssetId === subject.assetId,
                );
                const selectedProjectAssetCount = projectCollection?.querySelectorAll(".asset-library-item").length ?? 0;
                if (
                    visibleProjectCount >= 2 &&
                    unrelatedProjectCount >= 1 &&
                    exactAssets.length === 1 &&
                    selectedProjectAssetCount === 1 &&
                    Number.isSafeInteger(totalAssetCount) &&
                    totalAssetCount >= 52
                ) {
                    return {
                        selectedProjectId: subject.projectId,
                        selectedAssetId: subject.assetId,
                        visibleProjectCount,
                        unrelatedProjectCount,
                        selectedProjectAssetCount,
                        totalAssetCount,
                        onboardingDismissed,
                    };
                }
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for the exact packaged Project library with an unrelated-Project counterexample");
})`;

const OPEN_PROJECT_MANAGE_SCRIPT = `(async (subject) => {
    const open = [...document.querySelectorAll('[data-oaam-action="manage-project"][data-oaam-project-id]')].find(
        (candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.oaamProjectId === subject.projectId,
    );
    if (!(open instanceof HTMLButtonElement) || open.disabled) throw new Error("Manage Project is unavailable");
    open.focus();
    open.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const dialog = document.querySelector('[data-oaam-dialog="project_lifecycle"]');
        const content = dialog?.querySelector('[data-oaam-project-lifecycle-state="idle"]');
        if (dialog instanceof HTMLElement && content instanceof HTMLElement) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Manage Project did not open its ordinary dialog");
})`;

const OPEN_PROJECT_STOP_REVIEW_SCRIPT = `(async () => {
    const stop = document.querySelector('[data-oaam-project-action="stop_managing"]');
    if (!(stop instanceof HTMLButtonElement) || stop.disabled) throw new Error("Stop managing review is unavailable");
    stop.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const content = document.querySelector('[data-oaam-project-lifecycle-state="review"]');
        const backup = content?.querySelector(".project-lifecycle-backup-gate");
        const warning = content?.querySelector(".workbench-notice");
        if (content instanceof HTMLElement && backup instanceof HTMLElement && warning instanceof HTMLElement) {
            return { destructiveReview: true, backupGate: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Stop managing did not reach reviewed backup-gated state");
})`;

const CANCEL_PROJECT_REVIEW_SCRIPT = `(async (subject) => {
    const dialog = document.querySelector('[data-oaam-dialog="project_lifecycle"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("Project review dialog is unavailable");
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const open = [...document.querySelectorAll('[data-oaam-action="manage-project"][data-oaam-project-id]')].find(
            (candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.oaamProjectId === subject.projectId,
        );
        if (
            document.querySelector('[data-oaam-dialog="project_lifecycle"]') === null &&
            open instanceof HTMLButtonElement &&
            document.activeElement === open
        ) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("cancelling Project review did not restore focus without mutation");
})`;

const OPEN_PROJECT_ASSET_SCRIPT = `(async (subject) => {
    const assetItem = [...document.querySelectorAll(".asset-library-item[data-oaam-asset-id]")].find(
        (candidate) => candidate instanceof HTMLElement && candidate.dataset.oaamAssetId === subject.assetId,
    );
    const asset = assetItem?.querySelector('[data-oaam-action="inspect-asset"]');
    if (!(asset instanceof HTMLButtonElement) || asset.disabled) throw new Error("Project Asset is unavailable");
    asset.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const inspector = document.querySelector('.asset-inspector[data-oaam-state="ready"]');
        if (
            inspector instanceof HTMLElement &&
            inspector.dataset.oaamAssetId === subject.assetId &&
            inspector.dataset.oaamVersionCount === "${PACKAGED_LIBRARY_PROJECT_VERSION_COUNT}" &&
            inspector.dataset.oaamAssetDeleted === "false"
        ) {
            return { versionCount: ${PACKAGED_LIBRARY_PROJECT_VERSION_COUNT} };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Project Asset did not open the expected two-Version inspector");
})`;

const COMPARE_PROJECT_ASSET_SCRIPT = `(async () => {
    const compare = document.querySelector('[data-oaam-journey-action="asset.compare"]');
    if (!(compare instanceof HTMLButtonElement) || compare.disabled) throw new Error("Asset comparison is unavailable");
    compare.click();
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const result = document.querySelector(".asset-diff-result");
        if (result instanceof HTMLElement) {
            result.scrollIntoView({ block: "start" });
            return { comparisonRendered: true, changedFileCount: result.querySelectorAll("[data-change-kind]").length };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Asset comparison did not render");
})`;

const OPEN_GLOBAL_LIBRARY_SCRIPT = `(async () => {
    const global = document.querySelector('[data-oaam-subject-choice="global"]');
    if (!(global instanceof HTMLButtonElement) || global.disabled) throw new Error("Global library is unavailable");
    global.click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const library = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-state="ready"][data-oaam-subject="global"]'
        );
        const globalCollection = library?.querySelector('.asset-collection[data-oaam-total-count="50"]');
        const assets = globalCollection?.querySelectorAll(".asset-library-item");
        if (
            library instanceof HTMLElement &&
            assets?.length === 50 &&
            library.querySelector(".show-more-button") === null
        ) {
            return { boundedGlobalCount: assets.length };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Global Asset library did not expose its exact bounded page");
})`;

const OPEN_ASSET_DELETE_REVIEW_SCRIPT = `(async () => {
    const assetDeadline = Date.now() + 20000;
    let selected = false;
    while (Date.now() < assetDeadline) {
        const globalCollection = document.querySelector('.asset-collection[data-oaam-total-count="50"]');
        const asset = globalCollection?.querySelector(
            '.asset-library-item [data-oaam-action="inspect-asset"]'
        );
        if (asset instanceof HTMLButtonElement && !asset.disabled) {
            asset.focus();
            asset.click();
            selected = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!selected) throw new Error("Global Asset is unavailable after the current collection refresh");
    const inspectorDeadline = Date.now() + 20000;
    while (Date.now() < inspectorDeadline) {
        const inspector = document.querySelector('.asset-inspector[data-oaam-state="ready"]');
        const open = inspector?.querySelector('[data-oaam-journey-action="asset.delete_open"]');
        if (inspector instanceof HTMLElement && open instanceof HTMLButtonElement && !open.disabled) {
            open.scrollIntoView({ block: "center" });
            open.click();
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const reviewDeadline = Date.now() + 10000;
    while (Date.now() < reviewDeadline) {
        const form = document.querySelector('[data-oaam-action-mode="delete"] .asset-action-form');
        const confirmation = form?.querySelector(".workbench-confirmation input");
        if (form instanceof HTMLElement && confirmation instanceof HTMLInputElement) {
            form.scrollIntoView({ block: "center" });
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Asset delete did not reach explicit review");
})`;

const COMMIT_ASSET_DELETE_SCRIPT = `(async () => {
    const confirmation = document.querySelector('[data-oaam-action-mode="delete"] .workbench-confirmation input');
    const commit = document.querySelector('[data-oaam-journey-action="asset.delete_commit"]');
    if (!(confirmation instanceof HTMLInputElement) || !(commit instanceof HTMLButtonElement)) {
        throw new Error("Asset delete confirmation controls are unavailable");
    }
    confirmation.click();
    if (commit.disabled) throw new Error("Asset delete remained disabled after exact confirmation");
    commit.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const inspector = document.querySelector(
            '.asset-inspector[data-oaam-state="ready"][data-oaam-asset-deleted="true"]'
        );
        const restore = inspector?.querySelector('[data-oaam-journey-action="asset.restore"]');
        if (inspector instanceof HTMLElement && restore instanceof HTMLButtonElement && !restore.disabled) {
            restore.scrollIntoView({ block: "center" });
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Asset delete did not remain visibly restorable");
})`;

const OPEN_ASSET_PURGE_REVIEW_SCRIPT = `(async () => {
    const open = document.querySelector('[data-oaam-journey-action="asset.purge_review"]');
    if (!(open instanceof HTMLButtonElement) || open.disabled) throw new Error("Asset purge review is unavailable");
    open.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const form = document.querySelector('[data-oaam-action-mode="purge"] .asset-action-form');
        const input = form?.querySelector("input");
        const commit = form?.querySelector('[data-oaam-journey-action="asset.purge_commit"]');
        const backup = form?.querySelector(".workbench-switch");
        const title = document.querySelector(".asset-inspector-header h2");
        if (
            form instanceof HTMLElement &&
            input instanceof HTMLInputElement &&
            commit instanceof HTMLButtonElement &&
            backup instanceof HTMLButtonElement &&
            title instanceof HTMLHeadingElement
        ) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (setter === undefined) throw new Error("Asset purge confirmation setter is unavailable");
            setter.call(input, title.textContent ?? "");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (commit.disabled) throw new Error("Asset purge review did not bind the exact display name");
            form.scrollIntoView({ block: "center" });
            return { purgeReviewed: true, backupGate: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Asset purge did not reach exact backup-gated review");
})`;

const CANCEL_PURGE_AND_RESTORE_SCRIPT = `(async () => {
    const form = document.querySelector('[data-oaam-action-mode="purge"] .asset-action-form');
    const cancel = form?.querySelector(".detail-actions .library-secondary-button:last-child");
    if (!(cancel instanceof HTMLButtonElement) || cancel.disabled) throw new Error("Asset purge Cancel is unavailable");
    cancel.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const restore = document.querySelector('[data-oaam-journey-action="asset.restore"]');
        if (restore instanceof HTMLButtonElement && !restore.disabled) {
            restore.click();
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const restoredDeadline = Date.now() + 20000;
    while (Date.now() < restoredDeadline) {
        const inspector = document.querySelector(
            '.asset-inspector[data-oaam-state="ready"][data-oaam-asset-deleted="false"]'
        );
        if (inspector instanceof HTMLElement && inspector.querySelector('[data-oaam-journey-action="asset.delete_open"]')) {
            inspector.scrollTo({ top: 0 });
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Asset restore did not return to the active inspector");
})`;

function exactLibraryRecord(value: unknown, expected: Readonly<Record<string, number | boolean>>, label: string): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`invalid packaged ${label} proof`);
    }
    const record = value as Record<string, unknown>;
    if (Object.entries(expected).some(([key, expectedValue]) => record[key] !== expectedValue)) {
        throw new TypeError(`invalid packaged ${label} proof`);
    }
}

function exactProjectLibraryRecord(
    value: unknown,
    subject: PackagedProofSubjectIdentity,
): {
    readonly visibleProjectCount: number;
    readonly unrelatedProjectCount: number;
    readonly selectedProjectAssetCount: 1;
    readonly totalAssetCount: number;
} {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("invalid packaged Project library proof");
    }
    const record = value as Record<string, unknown>;
    if (
        record.selectedProjectId !== subject.projectId ||
        record.selectedAssetId !== subject.assetId ||
        !Number.isSafeInteger(record.visibleProjectCount) ||
        Number(record.visibleProjectCount) < 2 ||
        !Number.isSafeInteger(record.unrelatedProjectCount) ||
        Number(record.unrelatedProjectCount) < 1 ||
        Number(record.unrelatedProjectCount) !== Number(record.visibleProjectCount) - 1 ||
        record.selectedProjectAssetCount !== 1 ||
        !Number.isSafeInteger(record.totalAssetCount) ||
        Number(record.totalAssetCount) < 52
    ) {
        throw new TypeError("invalid packaged Project library proof");
    }
    return Object.freeze({
        visibleProjectCount: Number(record.visibleProjectCount),
        unrelatedProjectCount: Number(record.unrelatedProjectCount),
        selectedProjectAssetCount: 1,
        totalAssetCount: Number(record.totalAssetCount),
    });
}

export async function proveWindowsPackagedLibraryUi(
    webContents: PackagedWorkbenchUiSmokeWebContents,
    options: PackagedLibraryUiSmokeOptions,
): Promise<PackagedLibraryUiProof> {
    const execute = (script: string, ...input: readonly unknown[]): Promise<unknown> =>
        webContents.executeJavaScript(`(${script})(${input.map((value) => JSON.stringify(value)).join(",")})`);
    const projectLibrary = exactProjectLibraryRecord(
        await execute(ENTER_PROJECT_LIBRARY_SCRIPT, options.subject),
        options.subject,
    );
    await options.capture("project-library");
    if ((await execute(OPEN_PROJECT_MANAGE_SCRIPT, options.subject)) !== true) {
        throw new TypeError("invalid packaged Manage Project proof");
    }
    await options.capture("project-manage");
    exactLibraryRecord(
        await execute(OPEN_PROJECT_STOP_REVIEW_SCRIPT),
        { destructiveReview: true, backupGate: true },
        "Project destructive review",
    );
    await options.capture("project-stop-review");
    if ((await execute(CANCEL_PROJECT_REVIEW_SCRIPT, options.subject)) !== true) {
        throw new TypeError("invalid packaged Project cancel proof");
    }
    exactLibraryRecord(
        await execute(OPEN_PROJECT_ASSET_SCRIPT, options.subject),
        { versionCount: PACKAGED_LIBRARY_PROJECT_VERSION_COUNT },
        "Project Asset inspector",
    );
    await options.capture("project-asset-inspector");
    exactLibraryRecord(await execute(COMPARE_PROJECT_ASSET_SCRIPT), { comparisonRendered: true }, "Asset comparison");
    await options.capture("project-asset-comparison");
    exactLibraryRecord(await execute(OPEN_GLOBAL_LIBRARY_SCRIPT), { boundedGlobalCount: 50 }, "Global Asset page");
    await options.capture("global-bounded-library");
    if ((await execute(OPEN_ASSET_DELETE_REVIEW_SCRIPT)) !== true) throw new TypeError("invalid packaged Asset delete review");
    await options.capture("asset-delete-review");
    if ((await execute(COMMIT_ASSET_DELETE_SCRIPT)) !== true) throw new TypeError("invalid packaged Asset delete proof");
    await options.capture("asset-deleted");
    exactLibraryRecord(
        await execute(OPEN_ASSET_PURGE_REVIEW_SCRIPT),
        { purgeReviewed: true, backupGate: true },
        "Asset purge review",
    );
    await options.capture("asset-purge-review");
    if ((await execute(CANCEL_PURGE_AND_RESTORE_SCRIPT)) !== true) throw new TypeError("invalid packaged Asset restore proof");
    await options.capture("asset-restored");
    return Object.freeze({
        status: "complete",
        project: Object.freeze({
            selectedProjectId: options.subject.projectId,
            selectedAssetId: options.subject.assetId,
            ...projectLibrary,
            manageDialog: true,
            destructiveReview: true,
            backupGate: true,
            reviewCancelled: true,
            comparedVersionCount: 2,
        }),
        asset: Object.freeze({
            boundedGlobalCount: 50,
            comparisonRendered: true,
            deleteReviewed: true,
            deleted: true,
            purgeReviewed: true,
            restoreCompleted: true,
        }),
    });
}
