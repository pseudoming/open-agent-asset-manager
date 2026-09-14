import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    onboardingRoots: [] as string[],
    providerRoots: [] as string[],
    discoveryRoots: [] as string[],
    onboardingCapture: vi.fn(async () => undefined),
    onboardingAuthorityChange: vi.fn(),
    onboardingTerminalObservation: vi.fn(),
    providerCapture: vi.fn(async () => undefined),
    onboardingFinalize: vi.fn(),
    providerFinalize: vi.fn(),
    discoveryFinalize: vi.fn(),
    discoveryAuthorityChange: vi.fn(),
    discoveryTerminalObservation: vi.fn(),
    proveOnboarding: vi.fn(),
    proveDiscovery: vi.fn(),
    proveRegistration: vi.fn(),
    proveSourceIgnore: vi.fn(),
    proveProviderSweep: vi.fn(),
}));

vi.mock("../src/main/packaged-onboarding-screenshot-proof", () => ({
    PackagedOnboardingScreenshotProof: class {
        public constructor(rootPath: string) {
            mocks.onboardingRoots.push(rootPath);
        }

        public capture(stage: string, webContents: unknown) {
            return mocks.onboardingCapture(stage, webContents);
        }

        public recordAssetUsageAuthorityChange(receipt: unknown) {
            mocks.onboardingAuthorityChange(receipt);
        }

        public recordAssetUsageTerminalObservation(receipt: unknown) {
            mocks.onboardingTerminalObservation(receipt);
        }

        public finalize(proof: unknown) {
            mocks.onboardingFinalize(proof);
        }
    },
}));

vi.mock("../src/main/packaged-onboarding-ui-smoke", () => ({
    PACKAGED_ONBOARDING_SCREENSHOT_DIRECTORY: "onboarding-proof",
    proveWindowsPackagedOnboardingUi: mocks.proveOnboarding,
}));

vi.mock("../src/main/packaged-provider-discovery-review-proof", () => ({
    PACKAGED_PROVIDER_DISCOVERY_REVIEW_DIRECTORY: "provider-discovery-proof",
    PACKAGED_PROVIDER_DISCOVERY_REVIEW_STAGES: [
        "provider-discovery-locations",
        "provider-discovery-tools",
        "provider-discovery-source-review",
    ],
}));

vi.mock("../src/main/packaged-provider-project-sweep-ui-smoke", () => ({
    PACKAGED_PROVIDER_PROJECT_SWEEP_DIRECTORY: "provider-sweep-proof",
    PackagedProviderProjectSweepScreenshotProof: class {
        public constructor(rootPath: string) {
            (rootPath.endsWith("provider-discovery-proof") ? mocks.discoveryRoots : mocks.providerRoots).push(rootPath);
        }

        public capture(stage: string, webContents: unknown) {
            return mocks.providerCapture(stage, webContents);
        }

        public recordAuthorityChange(receipt: unknown) {
            mocks.discoveryAuthorityChange(receipt);
        }

        public recordProviderDiscoveryTerminalObservation(receipt: unknown) {
            mocks.discoveryTerminalObservation(receipt);
        }

        public finalize(proof: unknown) {
            (proof && typeof proof === "object" && "discovery" in proof ? mocks.discoveryFinalize : mocks.providerFinalize)(
                proof,
            );
        }
    },
    proveWindowsPackagedProviderDiscoveryReview: mocks.proveDiscovery,
    proveWindowsPackagedProviderProjectRegistration: mocks.proveRegistration,
    proveWindowsPackagedProviderProjectSweep: mocks.proveProviderSweep,
}));

vi.mock("../src/main/packaged-provider-source-ignore-ui-smoke", () => ({
    PACKAGED_PROVIDER_SOURCE_IGNORE_DIRECTORY: "provider-source-ignore-proof",
    PACKAGED_PROVIDER_SOURCE_IGNORE_STAGES: ["provider-source-ignore-compact", "provider-source-ignore-repeated"],
    proveWindowsPackagedProviderSourceIgnore: mocks.proveSourceIgnore,
}));

import {
    proveWindowsPackagedOnboardingAndProviderSweep,
    proveWindowsPackagedProviderJourney,
} from "../src/main/packaged-onboarding-provider-sweep";

describe("packaged onboarding and Provider sweep composition", () => {
    it("finishes the established onboarding proof before the cumulative six-Provider Project sweep", async () => {
        const onboardingProof = { status: "complete", journey: "onboarding" };
        const providerProof = { status: "complete", journey: "provider_sweep" };
        mocks.proveOnboarding.mockImplementationOnce(async (_webContents, _resolveWslHomePath, options) => {
            await options.capture("onboarding-welcome");
            return onboardingProof;
        });
        mocks.proveProviderSweep.mockImplementationOnce(async (_webContents, _resolveWslHomePath, options) => {
            await options.capture("provider-sweep-locations");
            return providerProof;
        });
        const webContents = {
            executeJavaScript: vi.fn(async () => undefined),
            capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(24) })),
        };
        const resolveWslHomePath = vi.fn(() => ({ status: "unavailable" as const, reason: "not_found" as const }));
        const readAssetUsageAuthoritySnapshot = vi.fn(() => ({
            businessAuthorityEntryCount: 1,
            businessAuthorityTreeFingerprint: "a".repeat(64),
            businessAuthorityManifest: [{ relativePath: "oaam.sqlite", kind: "file" as const, size: 8, sha256: "c".repeat(64) }],
            observabilityEntryCount: 0,
            observabilityTreeFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            observabilityManifest: [] as const,
            desktopPreferencesFingerprint: "b".repeat(64),
            desktopPreferences: {
                schemaVersion: 4,
                onboardingCompleted: true,
                lastSelectedProjectId: "11111111-1111-4111-8111-111111111111",
                assetLayout: "list" as const,
            },
            coordinationPaths: [] as const,
        }));

        await expect(
            proveWindowsPackagedProviderJourney(webContents, resolveWslHomePath, "/proof/temp", readAssetUsageAuthoritySnapshot),
        ).resolves.toBeUndefined();
        expect(mocks.onboardingRoots).toEqual([path.join("/proof/temp", "onboarding-proof")]);
        expect(mocks.providerRoots).toEqual([path.join("/proof/temp", "provider-sweep-proof")]);
        expect(mocks.onboardingCapture).toHaveBeenCalledWith("onboarding-welcome", webContents);
        const onboardingOptions = mocks.proveOnboarding.mock.calls[0]?.[2];
        onboardingOptions.recordAssetUsageAuthorityChange({ receipt: true });
        expect(mocks.onboardingAuthorityChange).toHaveBeenCalledWith({ receipt: true });
        onboardingOptions.recordAssetUsageTerminalObservation({ terminal: true });
        expect(mocks.onboardingTerminalObservation).toHaveBeenCalledWith({ terminal: true });
        expect(mocks.providerCapture).toHaveBeenCalledWith("provider-sweep-locations", webContents);
        expect(mocks.onboardingFinalize).toHaveBeenCalledWith(onboardingProof);
        expect(mocks.providerFinalize).toHaveBeenCalledWith(providerProof);
        expect(mocks.proveOnboarding.mock.calls[0]?.[2].readAssetUsageAuthoritySnapshot).toBe(readAssetUsageAuthoritySnapshot);
        expect(mocks.proveOnboarding.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.proveProviderSweep.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );

        const discoveryProof = { status: "complete", journey: "read_only_discovery" };
        mocks.proveDiscovery.mockImplementationOnce(async (_webContents, _resolveWslHomePath, options) => {
            await options.capture("provider-discovery-source-review");
            options.recordTerminalObservation({ raw: true });
            return discoveryProof;
        });
        await expect(
            proveWindowsPackagedOnboardingAndProviderSweep(
                webContents,
                resolveWslHomePath,
                "/proof/temp",
                readAssetUsageAuthoritySnapshot,
                true,
            ),
        ).resolves.toBeUndefined();
        expect(mocks.discoveryRoots).toEqual([path.join("/proof/temp", "provider-discovery-proof")]);
        expect(mocks.discoveryTerminalObservation).toHaveBeenCalledWith({ raw: true });
        expect(mocks.discoveryFinalize).toHaveBeenCalledWith(
            expect.objectContaining({ discovery: discoveryProof, authority: expect.any(Object) }),
        );
        expect(mocks.proveOnboarding).toHaveBeenCalledTimes(1);
        expect(mocks.proveProviderSweep).toHaveBeenCalledTimes(1);

        const baseline = readAssetUsageAuthoritySnapshot();
        let snapshotIndex = 0;
        mocks.proveDiscovery.mockResolvedValueOnce(discoveryProof);
        await expect(
            proveWindowsPackagedOnboardingAndProviderSweep(
                webContents,
                resolveWslHomePath,
                "/proof/drift",
                () => ({
                    ...baseline,
                    desktopPreferencesFingerprint: (snapshotIndex++ === 0 ? "b" : "f").repeat(64),
                }),
                true,
            ),
        ).rejects.toThrow(/changed business authority/u);
        expect(mocks.discoveryAuthorityChange).toHaveBeenCalledOnce();

        const registrationProof = { status: "complete", target: "current-fixture" };
        mocks.proveRegistration.mockResolvedValueOnce(registrationProof);
        const registered = structuredClone(baseline);
        registered.businessAuthorityEntryCount = 2;
        registered.businessAuthorityTreeFingerprint = "d".repeat(64);
        registered.businessAuthorityManifest.push({
            relativePath: "projects/11111111-1111-4111-8111-111111111111/project.json",
            kind: "file",
            size: 2,
            sha256: "d".repeat(64),
        });
        registered.coordinationPaths = [
            "transactions",
            "transactions/authority-locks",
            "transactions/authority-locks/projects",
            "transactions/authority-locks/projects/11111111-1111-4111-8111-111111111111.lock",
            "transactions/authority-locks/projects/catalog.lock",
        ];
        const readRegistrationSnapshot = vi.fn().mockReturnValueOnce(baseline).mockReturnValueOnce(registered);
        await expect(
            proveWindowsPackagedOnboardingAndProviderSweep(
                webContents,
                resolveWslHomePath,
                "/proof/registration",
                readRegistrationSnapshot,
                { ownership: "current_run_exact_wsl_root", environment: "wsl", rootPath: "root", projectPath: "project" },
            ),
        ).resolves.toBeUndefined();
        expect(mocks.providerFinalize).toHaveBeenLastCalledWith(
            expect.objectContaining({ registration: registrationProof, authority: expect.any(Object) }),
        );
        mocks.proveRegistration.mockResolvedValueOnce(registrationProof);
        const readUnchangedRegistration = vi.fn().mockReturnValueOnce(baseline).mockReturnValueOnce(baseline);
        await expect(
            proveWindowsPackagedOnboardingAndProviderSweep(
                webContents,
                resolveWslHomePath,
                "/proof/registration-drift",
                readUnchangedRegistration,
                { ownership: "current_run_exact_wsl_root", environment: "wsl", rootPath: "root", projectPath: "project" },
            ),
        ).rejects.toThrow(/outside its exact catalog write/u);
        mocks.proveRegistration.mockResolvedValueOnce(registrationProof);
        const registeredWithForeignLock = structuredClone(registered);
        registeredWithForeignLock.coordinationPaths.push("transactions/authority-locks/projects/foreign.lock");
        registeredWithForeignLock.coordinationPaths.sort();
        await expect(
            proveWindowsPackagedOnboardingAndProviderSweep(
                webContents,
                resolveWslHomePath,
                "/proof/registration-foreign-lock",
                vi.fn().mockReturnValueOnce(baseline).mockReturnValueOnce(registeredWithForeignLock),
                { ownership: "current_run_exact_wsl_root", environment: "wsl", rootPath: "root", projectPath: "project" },
            ),
        ).rejects.toThrow(/outside its exact catalog write/u);

        const ignoreProof = { status: "complete", target: "current-source" };
        const ignored = structuredClone(baseline);
        ignored.businessAuthorityEntryCount = 2;
        ignored.businessAuthorityTreeFingerprint = "e".repeat(64);
        ignored.businessAuthorityManifest.push({
            relativePath: "settings.json",
            kind: "file",
            size: 2,
            sha256: "e".repeat(64),
        });
        ignored.coordinationPaths = [
            "transactions",
            "transactions/authority-locks",
            "transactions/authority-locks/projects",
            "transactions/authority-locks/settings",
            "transactions/authority-locks/settings/settings.lock",
        ];
        mocks.proveSourceIgnore.mockImplementationOnce(async (_webContents, _resolver, _fixture, options) => {
            await options.onReadyToIgnore();
            options.onIgnored();
            return { ...ignoreProof, canonicalDefaultIncludes: [{ destination: "global" }] };
        });
        const readIgnored = vi
            .fn()
            .mockReturnValueOnce(baseline)
            .mockReturnValueOnce(baseline)
            .mockReturnValueOnce(ignored)
            .mockReturnValueOnce(ignored);
        await expect(
            proveWindowsPackagedOnboardingAndProviderSweep(webContents, resolveWslHomePath, "/proof/ignore", readIgnored, {
                ownership: "current_run_exact_wsl_root",
                environment: "wsl",
                rootPath: "root",
                sourcePath: "source",
                projectPath: "project",
            }),
        ).resolves.toBeUndefined();
        expect(mocks.proveSourceIgnore).toHaveBeenCalledOnce();
    });
});
