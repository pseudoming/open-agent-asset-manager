import path from "node:path";
import {
    assertPackagedAssetUsageAuthorityUnchanged,
    diffPackagedAssetUsageAuthority,
    isPackagedAssetUsageObservabilitySnapshotComparable,
    type PackagedAssetUsageAuthoritySnapshot,
} from "./packaged-asset-usage-authority-proof";
import type { ResolveEnvironmentChoiceWslHome } from "./packaged-environment-choice-smoke";
import { PackagedOnboardingScreenshotProof } from "./packaged-onboarding-screenshot-proof";
import {
    PACKAGED_ONBOARDING_SCREENSHOT_DIRECTORY,
    type PackagedOnboardingUiSmokeWebContents,
    proveWindowsPackagedOnboardingUi,
} from "./packaged-onboarding-ui-smoke";
import {
    PACKAGED_PROVIDER_DISCOVERY_REVIEW_DIRECTORY,
    PACKAGED_PROVIDER_DISCOVERY_REVIEW_STAGES,
    type PackagedProviderDiscoveryReviewStage,
} from "./packaged-provider-discovery-review-proof";
import {
    PACKAGED_PROVIDER_PROJECT_REGISTRATION_DIRECTORY,
    PACKAGED_PROVIDER_PROJECT_REGISTRATION_STAGES,
    type PackagedProviderProjectRegistrationFixture,
    type PackagedProviderProjectRegistrationStage,
} from "./packaged-provider-project-registration-ui-smoke";
import {
    PACKAGED_PROVIDER_PROJECT_SWEEP_DIRECTORY,
    PackagedProviderProjectSweepScreenshotProof,
    proveWindowsPackagedProviderDiscoveryReview,
    proveWindowsPackagedProviderProjectRegistration,
    proveWindowsPackagedProviderProjectSweep,
} from "./packaged-provider-project-sweep-ui-smoke";
import { proveWindowsPackagedProjectAssetImport } from "./packaged-project-asset-import-ui-smoke";
import {
    PACKAGED_PROVIDER_SOURCE_IGNORE_DIRECTORY,
    PACKAGED_PROVIDER_SOURCE_IGNORE_STAGES,
    type PackagedProviderSourceIgnoreFixture,
    type PackagedProviderSourceIgnoreStage,
    proveWindowsPackagedProviderSourceIgnore,
} from "./packaged-provider-source-ignore-ui-smoke";

interface PackagedOnboardingProviderSweepWebContents extends PackagedOnboardingUiSmokeWebContents {
    capturePage(): Promise<{ toPNG(): Buffer }>;
}

interface PackagedProjectAssetImportStage {
    readonly projectAssetImportProfileRootPath: string | undefined;
}

type PackagedProviderJourneyStage =
    | boolean
    | PackagedProviderProjectRegistrationFixture
    | PackagedProviderSourceIgnoreFixture
    | PackagedProjectAssetImportStage;

const summarizeAuthority = (snapshot: PackagedAssetUsageAuthoritySnapshot) => ({
    businessAuthorityTreeFingerprint: snapshot.businessAuthorityTreeFingerprint,
    desktopPreferencesFingerprint: snapshot.desktopPreferencesFingerprint,
    observabilityTreeFingerprint: snapshot.observabilityTreeFingerprint,
    coordinationPaths: snapshot.coordinationPaths,
});

function hasExactCoordinationDelta(
    before: PackagedAssetUsageAuthoritySnapshot,
    delta: ReturnType<typeof diffPackagedAssetUsageAuthority>,
    requiredPaths: readonly string[],
): boolean {
    const expectedAdded = requiredPaths.filter((entry) => !before.coordinationPaths.includes(entry)).sort();
    return delta.coordination.removed.length === 0 && JSON.stringify(delta.coordination.added) === JSON.stringify(expectedAdded);
}

function projectRegistrationCoordinationPaths(delta: ReturnType<typeof diffPackagedAssetUsageAuthority>): readonly string[] {
    const ids = delta.businessAuthority.added.flatMap((entry) => {
        const match = /^projects\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/project\.json$/u.exec(
            entry.relativePath,
        );
        return match?.[1] === undefined ? [] : [match[1]];
    });
    if (ids.length !== 1) return [];
    return [
        "transactions",
        "transactions/authority-locks",
        "transactions/authority-locks/projects",
        `transactions/authority-locks/projects/${ids[0]}.lock`,
        "transactions/authority-locks/projects/catalog.lock",
    ];
}

export async function waitForPackagedProviderSourceIgnoreAuthorityQuiescence(
    readSnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    deadlineMilliseconds = 10_000,
): Promise<PackagedAssetUsageAuthoritySnapshot> {
    const deadline = Date.now() + deadlineMilliseconds;
    let previousIdentity: string | undefined;
    let latest: PackagedAssetUsageAuthoritySnapshot | undefined;
    while (Date.now() < deadline) {
        latest = readSnapshot();
        const identity = JSON.stringify({
            business: latest.businessAuthorityManifest,
            coordination: latest.coordinationPaths,
            preferences: latest.desktopPreferencesFingerprint,
        });
        if (isPackagedAssetUsageObservabilitySnapshotComparable(latest)) {
            if (identity === previousIdentity) return latest;
            previousIdentity = identity;
        } else {
            previousIdentity = undefined;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for stable Provider source-ignore authority: ${JSON.stringify(latest)}`);
}

export async function proveWindowsPackagedOnboardingAndProviderSweep(
    webContents: PackagedOnboardingProviderSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    temporaryRootPath: string,
    readAssetUsageAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    providerStage: boolean | PackagedProviderProjectRegistrationFixture | PackagedProviderSourceIgnoreFixture = false,
): Promise<void> {
    if (typeof providerStage === "object" && "sourcePath" in providerStage) {
        const screenshots = new PackagedProviderProjectSweepScreenshotProof<PackagedProviderSourceIgnoreStage, unknown>(
            path.join(temporaryRootPath, PACKAGED_PROVIDER_SOURCE_IGNORE_DIRECTORY),
            PACKAGED_PROVIDER_SOURCE_IGNORE_STAGES,
            "Provider-source-ignore",
        );
        let before: PackagedAssetUsageAuthoritySnapshot | undefined;
        let afterIgnored: PackagedAssetUsageAuthoritySnapshot | undefined;
        const proof = await proveWindowsPackagedProviderSourceIgnore(webContents, resolveWslHomePath, providerStage, {
            capture: (stage) => screenshots.capture(stage, webContents),
            onReadyToIgnore: async () => {
                before = await waitForPackagedProviderSourceIgnoreAuthorityQuiescence(readAssetUsageAuthoritySnapshot);
            },
            onIgnored: () => {
                afterIgnored = readAssetUsageAuthoritySnapshot();
            },
        });
        const after = readAssetUsageAuthoritySnapshot();
        if (before === undefined)
            throw new Error("packaged Provider source ignore did not establish its stable authority baseline");
        if (afterIgnored === undefined) throw new Error("packaged Provider source ignore did not publish its authority boundary");
        const ignoredDelta = diffPackagedAssetUsageAuthority(before, afterIgnored);
        const repeatedDelta = diffPackagedAssetUsageAuthority(afterIgnored, after);
        const ignoredBusinessPaths = [
            ...ignoredDelta.businessAuthority.added.map((entry) => entry.relativePath),
            ...ignoredDelta.businessAuthority.changed.map((entry) => entry.relativePath),
        ];
        const ignoreCoordination = [
            "transactions",
            "transactions/authority-locks",
            "transactions/authority-locks/projects",
            "transactions/authority-locks/settings",
            "transactions/authority-locks/settings/settings.lock",
        ];
        if (
            !ignoredDelta.businessAuthorityChanged ||
            ignoredBusinessPaths.length !== 1 ||
            ignoredBusinessPaths[0] !== "settings.json" ||
            ignoredDelta.businessAuthority.removed.length > 0 ||
            ignoredDelta.preferencesChanged ||
            proof.canonicalDefaultIncludes.some((entry) => entry.destination !== "global") ||
            !hasExactCoordinationDelta(before, ignoredDelta, ignoreCoordination) ||
            (ignoredDelta.observabilityChanged && !ignoredDelta.observability.validDurableReplacementGrowth) ||
            repeatedDelta.businessAuthorityChanged ||
            repeatedDelta.preferencesChanged ||
            repeatedDelta.coordinationChanged ||
            (repeatedDelta.observabilityChanged && !repeatedDelta.observability.validDurableReplacementGrowth)
        ) {
            screenshots.recordAuthorityChange({ schemaVersion: 2, before, afterIgnored, after, ignoredDelta, repeatedDelta });
            throw new Error("packaged Provider source ignore changed authority outside one canonical watched-source decision");
        }
        screenshots.finalize({
            status: "complete",
            proof,
            authority: {
                before: summarizeAuthority(before),
                afterIgnored: summarizeAuthority(afterIgnored),
                after: summarizeAuthority(after),
                ignoredDelta,
                repeatedDelta,
            },
        });
        return;
    }
    if (typeof providerStage === "object") {
        const screenshots = new PackagedProviderProjectSweepScreenshotProof<PackagedProviderProjectRegistrationStage, unknown>(
            path.join(temporaryRootPath, PACKAGED_PROVIDER_PROJECT_REGISTRATION_DIRECTORY),
            PACKAGED_PROVIDER_PROJECT_REGISTRATION_STAGES,
            "Provider-registration",
        );
        const before = readAssetUsageAuthoritySnapshot();
        const registration = await proveWindowsPackagedProviderProjectRegistration(
            webContents,
            resolveWslHomePath,
            providerStage,
            { capture: (stage) => screenshots.capture(stage, webContents) },
        );
        const after = readAssetUsageAuthoritySnapshot();
        const delta = diffPackagedAssetUsageAuthority(before, after);
        const registrationCoordination = projectRegistrationCoordinationPaths(delta);
        if (
            !delta.businessAuthorityChanged ||
            delta.preferencesChanged ||
            registrationCoordination.length === 0 ||
            !hasExactCoordinationDelta(before, delta, registrationCoordination) ||
            (delta.observabilityChanged && !delta.observability.validDurableReplacementGrowth)
        ) {
            screenshots.recordAuthorityChange({ schemaVersion: 2, before, after, delta });
            throw new Error("packaged Project registration changed authority outside its exact catalog write");
        }
        screenshots.finalize({
            status: "complete",
            registration,
            authority: { before: summarizeAuthority(before), after: summarizeAuthority(after), delta },
        });
        return;
    }
    if (providerStage) {
        const screenshots = new PackagedProviderProjectSweepScreenshotProof<PackagedProviderDiscoveryReviewStage, unknown>(
            path.join(temporaryRootPath, PACKAGED_PROVIDER_DISCOVERY_REVIEW_DIRECTORY),
            PACKAGED_PROVIDER_DISCOVERY_REVIEW_STAGES,
            "Provider-discovery",
        );
        const before = readAssetUsageAuthoritySnapshot();
        const discovery = await proveWindowsPackagedProviderDiscoveryReview(webContents, resolveWslHomePath, {
            capture: (stage) => screenshots.capture(stage, webContents),
            recordTerminalObservation: (receipt) => screenshots.recordProviderDiscoveryTerminalObservation(receipt),
        });
        const after = readAssetUsageAuthoritySnapshot();
        const delta = assertPackagedAssetUsageAuthorityUnchanged(before, after, (receipt) =>
            screenshots.recordAuthorityChange(receipt),
        );
        screenshots.finalize({
            status: "complete",
            discovery,
            authority: { before: summarizeAuthority(before), after: summarizeAuthority(after), delta },
        });
        return;
    }
    const onboardingScreenshots = new PackagedOnboardingScreenshotProof(
        path.join(temporaryRootPath, PACKAGED_ONBOARDING_SCREENSHOT_DIRECTORY),
    );
    const onboardingProof = await proveWindowsPackagedOnboardingUi(webContents, resolveWslHomePath, {
        capture: (stage) => onboardingScreenshots.capture(stage, webContents),
        readAssetUsageAuthoritySnapshot,
        recordAssetUsageAuthorityChange: (receipt) => onboardingScreenshots.recordAssetUsageAuthorityChange(receipt),
        recordAssetUsageTerminalObservation: (receipt) => onboardingScreenshots.recordAssetUsageTerminalObservation(receipt),
    });
    onboardingScreenshots.finalize(onboardingProof);

    const providerSweepScreenshots = new PackagedProviderProjectSweepScreenshotProof(
        path.join(temporaryRootPath, PACKAGED_PROVIDER_PROJECT_SWEEP_DIRECTORY),
    );
    const providerSweepProof = await proveWindowsPackagedProviderProjectSweep(webContents, resolveWslHomePath, {
        capture: (stage) => providerSweepScreenshots.capture(stage, webContents),
    });
    providerSweepScreenshots.finalize(providerSweepProof);
}

export async function proveWindowsPackagedProviderJourney(
    webContents: PackagedOnboardingProviderSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    temporaryRootPath: string,
    readAssetUsageAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    stage: PackagedProviderJourneyStage,
): Promise<void> {
    if (typeof stage === "object" && "projectAssetImportProfileRootPath" in stage) {
        if (stage.projectAssetImportProfileRootPath === undefined)
            throw new Error("Packaged Project Asset import has no launch authorization");
        await proveWindowsPackagedProjectAssetImport(
            webContents,
            resolveWslHomePath,
            temporaryRootPath,
            stage.projectAssetImportProfileRootPath,
            readAssetUsageAuthoritySnapshot,
        );
        return;
    }
    await proveWindowsPackagedOnboardingAndProviderSweep(
        webContents,
        resolveWslHomePath,
        temporaryRootPath,
        readAssetUsageAuthoritySnapshot,
        stage,
    );
}
