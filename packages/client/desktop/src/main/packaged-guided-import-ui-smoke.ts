import { proveWindowsWslEnvironmentChoice, type ResolveEnvironmentChoiceWslHome } from "./packaged-environment-choice-smoke";
import { importPackagedAsset, preparePackagedAssetReview } from "./packaged-import-review-ui-smoke";
import { type PackagedSourceReviewProof, reviewPackagedPhysicalSources } from "./packaged-source-review-ui-smoke";

export const PACKAGED_GUIDED_IMPORT_SCREENSHOT_STAGES = [
    "guided-import-locations",
    "guided-import-tools",
    "guided-import-content-sources",
    "guided-import-content-assets",
    "guided-import-complete",
    "guided-import-workbench",
] as const;

export type PackagedGuidedImportScreenshotStage = (typeof PACKAGED_GUIDED_IMPORT_SCREENSHOT_STAGES)[number];

export interface PackagedGuidedImportUiProof {
    readonly source: PackagedSourceReviewProof;
    readonly candidateCount: 1;
    readonly importedCandidateCount: 1;
    readonly finalAssetCount: 2;
}

export interface PackagedGuidedImportUiSmokeWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedGuidedImportUiSmokeOptions {
    readonly capture: (stage: PackagedGuidedImportScreenshotStage) => Promise<void>;
}

const ENTER_GUIDED_IMPORT_SCRIPT = `(async () => {
    const deadline = Date.now() + 15000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const globalLibrary = await waitFor(() => {
        const value = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="global"][data-oaam-state="ready"]',
        );
        return value instanceof HTMLElement ? value : false;
    }, "the completed first-run Global workbench");
    if (Number.parseInt(globalLibrary.dataset.oaamAssetCount ?? "", 10) !== 1) {
        throw new Error("guided import did not start from the one-Asset first-run catalog");
    }
    const guidedImportActions = [...globalLibrary.querySelectorAll(
        '.library-toolbar-actions > [data-oaam-action="start-guided-import"]',
    )]
        .filter((button) => button instanceof HTMLButtonElement && !button.disabled);
    if (guidedImportActions.length !== 1 || !(guidedImportActions[0] instanceof HTMLButtonElement)) {
        throw new Error("the Global library has no unique contextual guided-import action");
    }
    guidedImportActions[0].click();
    const journey = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="locations"]');
        return value instanceof HTMLElement ? value : false;
    }, "the ordinary guided-import location stage");
    if (Number.parseInt(journey.dataset.oaamAssetCount ?? "", 10) !== 1) {
        throw new Error("ordinary guided import did not preserve the existing catalog");
    }
    if (journey.dataset.oaamTargetProjectId !== undefined) {
        throw new Error("ordinary guided import was incorrectly restricted to one Project");
    }
    return { status: "ready" };
})()`;

const RETURN_TO_WORKBENCH_SCRIPT = `(async () => {
    const deadline = Date.now() + 15000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const journey = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="complete"]');
        return value instanceof HTMLElement ? value : false;
    }, "the completed ordinary guided import");
    const done = journey.querySelector(".onboarding-completion .onboarding-actions button:not(.library-secondary-button)");
    if (!(done instanceof HTMLButtonElement) || done.disabled) {
        throw new Error("the guided-import workbench return action is unavailable");
    }
    done.click();
    const library = await waitFor(() => {
        const value = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="global"][data-oaam-state="ready"]',
        );
        return value instanceof HTMLElement ? value : false;
    }, "the contextual Global workbench after guided import");
    const assetCount = Number.parseInt(library.dataset.oaamAssetCount ?? "", 10);
    if (assetCount !== 2) throw new Error("guided import did not expose exactly two final Assets");
    if (document.querySelector('main[data-oaam-route="onboarding"]') !== null) {
        throw new Error("ordinary guided import incorrectly returned to first-run onboarding");
    }
    return { status: "complete", finalAssetCount: assetCount };
})()`;

function parseReady(value: unknown): void {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as Record<string, unknown>).status !== "ready"
    ) {
        throw new TypeError("invalid packaged guided-import entry proof");
    }
}

function parseFinalAssetCount(value: unknown): 2 {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "finalAssetCount,status" ||
        (value as Record<string, unknown>).status !== "complete" ||
        (value as Record<string, unknown>).finalAssetCount !== 2
    ) {
        throw new TypeError("invalid packaged guided-import workbench proof");
    }
    return 2;
}

export async function proveWindowsPackagedGuidedImportUi(
    webContents: PackagedGuidedImportUiSmokeWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    options: PackagedGuidedImportUiSmokeOptions,
): Promise<PackagedGuidedImportUiProof> {
    parseReady(await webContents.executeJavaScript(ENTER_GUIDED_IMPORT_SCRIPT));
    await proveWindowsWslEnvironmentChoice(webContents, resolveWslHomePath, {
        selectedAdapterIds: ["CLAUDECODE", "OPENCODE"],
        onStageReady: (stage) => options.capture(`guided-import-${stage}`),
    });
    const source = await reviewPackagedPhysicalSources(webContents, "compatible_only");
    await options.capture("guided-import-content-sources");
    const candidateCount = await preparePackagedAssetReview(webContents, "guided_import");
    await options.capture("guided-import-content-assets");
    const importedCandidateCount = await importPackagedAsset(webContents, "guided_import");
    await options.capture("guided-import-complete");
    const finalAssetCount = parseFinalAssetCount(await webContents.executeJavaScript(RETURN_TO_WORKBENCH_SCRIPT));
    await options.capture("guided-import-workbench");
    return Object.freeze({
        source,
        candidateCount,
        importedCandidateCount,
        finalAssetCount,
    });
}
