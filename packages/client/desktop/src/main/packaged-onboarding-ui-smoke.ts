import {
    type PackagedAlreadyUsableAssetUiProof,
    type PackagedAssetUsageAuthorityChangeReceipt,
    type PackagedAssetUsageProofTerminalReceipt,
    type PackagedAssetUsageAuthoritySnapshot,
    proveWindowsPackagedAlreadyUsableAssetUi,
} from "./packaged-asset-usage-ui-smoke";
import {
    type EnvironmentChoiceSmokeWebContents,
    proveWindowsWslEnvironmentChoice,
    type ResolveEnvironmentChoiceWslHome,
} from "./packaged-environment-choice-smoke";
import {
    PACKAGED_GUIDED_IMPORT_SCREENSHOT_STAGES,
    type PackagedGuidedImportUiProof,
    proveWindowsPackagedGuidedImportUi,
} from "./packaged-guided-import-ui-smoke";
import { importPackagedAsset, preparePackagedAssetReview } from "./packaged-import-review-ui-smoke";
import {
    completePackagedProjectRegistration,
    openPackagedProjectRegistration,
    type PackagedProjectRegistrationProof,
} from "./packaged-project-registration-ui-smoke";
import { type PackagedSourceReviewProof, reviewPackagedPhysicalSources } from "./packaged-source-review-ui-smoke";

export const PACKAGED_ONBOARDING_SCREENSHOT_DIRECTORY = "oaam-phase51-installed-onboarding";

const PACKAGED_FIRST_RUN_SCREENSHOT_STAGES = [
    "onboarding-welcome",
    "onboarding-locations",
    "onboarding-tools",
    "onboarding-project-registration",
    "onboarding-content-sources",
    "onboarding-content-assets",
    "onboarding-complete",
    "onboarding-workbench",
] as const;

export const PACKAGED_ONBOARDING_SCREENSHOT_STAGES = [
    ...PACKAGED_FIRST_RUN_SCREENSHOT_STAGES,
    ...PACKAGED_GUIDED_IMPORT_SCREENSHOT_STAGES,
    "asset-usage-already-usable",
] as const;

export type PackagedOnboardingScreenshotStage = (typeof PACKAGED_ONBOARDING_SCREENSHOT_STAGES)[number];

export interface PackagedFirstRunUiProof {
    readonly projectRegistration: PackagedProjectRegistrationProof;
    readonly source: PackagedSourceReviewProof;
    readonly candidateCount: 1;
    readonly importedCandidateCount: 1;
    readonly finalAssetCount: 1;
    readonly visibleGlobalAssetCount: 1;
}

export interface PackagedOnboardingUiProof {
    readonly status: "complete";
    readonly firstRun: PackagedFirstRunUiProof;
    readonly guidedImport: PackagedGuidedImportUiProof;
    readonly assetUsage: PackagedAlreadyUsableAssetUiProof;
}

export interface PackagedOnboardingUiSmokeWebContents extends EnvironmentChoiceSmokeWebContents {}

export interface PackagedOnboardingUiSmokeOptions {
    readonly capture: (stage: PackagedOnboardingScreenshotStage) => Promise<void>;
    readonly readAssetUsageAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot;
    readonly recordAssetUsageAuthorityChange: (receipt: PackagedAssetUsageAuthorityChangeReceipt) => void;
    readonly recordAssetUsageTerminalObservation: (receipt: PackagedAssetUsageProofTerminalReceipt) => void;
}

const ENTER_WORKBENCH_SCRIPT = `(async () => {
    const deadline = Date.now() + 120000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const onboarding = await waitFor(
        () => document.querySelector('main[data-oaam-route="onboarding"][data-oaam-step="complete"]'),
        "the completed onboarding stage",
    );
    const finish = onboarding.querySelector(".onboarding-completion .onboarding-actions button:not(.library-secondary-button)");
    if (!(finish instanceof HTMLButtonElement) || finish.disabled) {
        throw new Error("the workbench entry action is unavailable");
    }
    finish.click();
    const library = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        if (!(value instanceof HTMLElement)) return false;
        const count = Number.parseInt(value.dataset.oaamAssetCount ?? "", 10);
        if (count > 1) throw new Error("the fresh ordinary workbench exposed more than one Asset");
        return count === 1 ? value : false;
    }, "the ordinary Project-first workbench with the imported Asset");
    const globalChoice = library.querySelector('[data-oaam-subject-choice="global"]');
    if (!(globalChoice instanceof HTMLButtonElement) || globalChoice.disabled) {
        throw new Error("the ordinary workbench did not expose the Global Asset choice");
    }
    globalChoice.click();
    const globalLibrary = await waitFor(
        () => document.querySelector('main[data-oaam-route="library"][data-oaam-subject="global"]'),
        "the Global Asset workspace",
    );
    const globalCollection = await waitFor(() => {
        const value = globalLibrary.querySelector('[data-oaam-collection-id="global"]');
        if (!(value instanceof HTMLElement)) return false;
        const count = Number.parseInt(value.dataset.oaamTotalCount ?? "", 10);
        if (count > 1) throw new Error("the fresh Global library exposed more than one Asset");
        return count === 1 ? value : false;
    }, "the Global Asset collection containing the imported Asset");
    const ordinaryText = globalLibrary.textContent ?? "";
    if (
        ordinaryText.includes("win32:desktop-local") ||
        ordinaryText.includes("wsl:Ubuntu") ||
        /(^|[^a-z])scope([^a-z]|$)/iu.test(ordinaryText)
    ) {
        throw new Error("the ordinary workbench still exposes an internal Environment or scope label");
    }
    if (globalLibrary.querySelector(".environment-filter") !== null) {
        throw new Error("the Asset library exposed a source Environment as an Asset filter");
    }
    const globalTreeRoot = globalLibrary.querySelector(".asset-tree-global");
    if (!(globalTreeRoot instanceof HTMLButtonElement)) {
        throw new Error("the Global Asset tree root is unavailable");
    }
    const assetCount = Number.parseInt(library.dataset.oaamAssetCount ?? "", 10);
    const visibleGlobalAssetCount = Number.parseInt(globalCollection.dataset.oaamTotalCount ?? "", 10);
    return { status: "complete", finalAssetCount: assetCount, visibleGlobalAssetCount };
})()`;

function parseWorkbenchProof(value: unknown): {
    readonly finalAssetCount: 1;
    readonly visibleGlobalAssetCount: 1;
} {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("invalid packaged workbench proof");
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== "finalAssetCount,status,visibleGlobalAssetCount" ||
        record.status !== "complete" ||
        record.finalAssetCount !== 1 ||
        record.visibleGlobalAssetCount !== 1
    ) {
        throw new TypeError("invalid packaged workbench proof");
    }
    return Object.freeze({ finalAssetCount: 1, visibleGlobalAssetCount: 1 });
}

export async function proveWindowsPackagedOnboardingUi(
    webContents: PackagedOnboardingUiSmokeWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    options: PackagedOnboardingUiSmokeOptions,
): Promise<PackagedOnboardingUiProof> {
    await options.capture("onboarding-welcome");
    await proveWindowsWslEnvironmentChoice(webContents, resolveWslHomePath, {
        selectedAdapterIds: ["CLAUDECODE", "OPENCODE"],
        onStageReady: (stage) => options.capture(`onboarding-${stage}`),
    });
    const projectRegistrationReady = await openPackagedProjectRegistration(webContents);
    await options.capture("onboarding-project-registration");
    const projectRegistration = await completePackagedProjectRegistration(webContents, projectRegistrationReady);
    const source = await reviewPackagedPhysicalSources(webContents, "native_primary");
    await options.capture("onboarding-content-sources");
    const candidateCount = await preparePackagedAssetReview(webContents, "onboarding");
    await options.capture("onboarding-content-assets");
    const importedCandidateCount = await importPackagedAsset(webContents, "onboarding");
    await options.capture("onboarding-complete");
    const workbench = parseWorkbenchProof(await webContents.executeJavaScript(ENTER_WORKBENCH_SCRIPT));
    await options.capture("onboarding-workbench");
    const firstRun = Object.freeze({
        projectRegistration,
        source,
        candidateCount,
        importedCandidateCount,
        ...workbench,
    });
    const guidedImport = await proveWindowsPackagedGuidedImportUi(webContents, resolveWslHomePath, {
        capture: options.capture,
    });
    const assetUsage = await proveWindowsPackagedAlreadyUsableAssetUi(webContents, projectRegistration, {
        capture: () => options.capture("asset-usage-already-usable"),
        readAuthoritySnapshot: options.readAssetUsageAuthoritySnapshot,
        recordAuthorityChange: options.recordAssetUsageAuthorityChange,
        recordTerminalObservation: options.recordAssetUsageTerminalObservation,
    });
    return Object.freeze({
        status: "complete",
        firstRun,
        guidedImport,
        assetUsage,
    });
}
