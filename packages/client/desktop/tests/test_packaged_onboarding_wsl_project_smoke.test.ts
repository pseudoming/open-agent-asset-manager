import { describe, expect, it, vi } from "vitest";
import {
    applyPackagedOnboardingWslProjectPlatformContexts,
    PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT,
    packagedOnboardingWslHomeResolver,
    packagedOnboardingWslProjectRegistrationFixture,
    packagedOnboardingWslProjectSmokeActive,
    packagedOnboardingWslProviderSourceIgnoreFixture,
} from "../src/main/packaged-onboarding-wsl-project-smoke";

const FIXTURE_HOME = "\\\\wsl.localhost\\Ubuntu\\tmp\\oaam-windows-package-onboarding-fixture";
const CONTEXTS = [
    { platform: "win32" as const, platformInstanceId: "desktop-local", accessRootPath: "C:\\" },
    { platform: "wsl" as const, platformInstanceId: "Debian", accessRootPath: "\\\\wsl.localhost\\Debian\\" },
    { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: "\\\\wsl.localhost\\Ubuntu\\" },
];

describe("packaged onboarding isolated WSL Project fixture", () => {
    it("activates only for the Windows runtime package proof", () => {
        expect(packagedOnboardingWslProjectSmokeActive(true, "win32")).toBe(true);
        expect(packagedOnboardingWslProjectSmokeActive(true, "linux")).toBe(false);
        expect(packagedOnboardingWslProjectSmokeActive(true, "darwin")).toBe(false);
        expect(packagedOnboardingWslProjectSmokeActive(false, "win32")).toBe(false);
    });

    it("narrows the runtime proof to one exact fixture HOME and resolver", () => {
        const environment = { [PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT]: FIXTURE_HOME };
        expect(packagedOnboardingWslProjectRegistrationFixture(true, environment)?.projectPath).toBe(
            `${FIXTURE_HOME}\\projects\\onboarding-project`,
        );
        expect(packagedOnboardingWslProviderSourceIgnoreFixture(true, environment)?.sourcePath).toBe(
            `${FIXTURE_HOME}\\.config\\opencode`,
        );
        expect(applyPackagedOnboardingWslProjectPlatformContexts(true, environment, CONTEXTS)).toEqual([
            CONTEXTS[0],
            { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: FIXTURE_HOME },
        ]);
        expect(CONTEXTS[2]?.accessRootPath).toBe("\\\\wsl.localhost\\Ubuntu\\");

        const fallback = vi.fn(() => ({ status: "unavailable" as const, reason: "command_failed" as const }));
        const resolver = packagedOnboardingWslHomeResolver(true, environment, fallback);
        expect(resolver("Ubuntu")).toEqual({ status: "available", homePath: FIXTURE_HOME });
        expect(resolver("Debian")).toEqual({ status: "unavailable", reason: "not_installed" });
        expect(fallback).not.toHaveBeenCalled();
    });

    it("leaves ordinary launches untouched and rejects every mismatched fixture authority", () => {
        const fallback = vi.fn(() => ({ status: "unavailable" as const, reason: "command_failed" as const }));
        expect(applyPackagedOnboardingWslProjectPlatformContexts(false, {}, CONTEXTS)).toBe(CONTEXTS);
        expect(packagedOnboardingWslHomeResolver(false, {}, fallback)).toBe(fallback);
        expect(packagedOnboardingWslProjectRegistrationFixture(false, {})).toBeNull();
        expect(packagedOnboardingWslProviderSourceIgnoreFixture(false, {})).toBeNull();
        expect(() =>
            applyPackagedOnboardingWslProjectPlatformContexts(
                false,
                { [PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT]: FIXTURE_HOME },
                CONTEXTS,
            ),
        ).toThrow(/valid only for the runtime package proof/u);

        for (const invalid of [
            "",
            "\\\\wsl.localhost\\Ubuntu\\",
            "\\\\wsl.localhost\\Ubuntu\\tmp\\fixture\\..\\foreign",
            "\\\\wsl.localhost\\Unknown\\tmp\\fixture",
            "C:\\fixture",
        ]) {
            expect(() =>
                applyPackagedOnboardingWslProjectPlatformContexts(
                    true,
                    { [PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT]: invalid },
                    CONTEXTS,
                ),
            ).toThrow();
        }
        expect(() =>
            applyPackagedOnboardingWslProjectPlatformContexts(
                true,
                { [PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT]: FIXTURE_HOME },
                CONTEXTS.map((context) =>
                    context.platform === "wsl" && context.platformInstanceId === "Ubuntu"
                        ? { ...context, accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example" }
                        : context,
                ),
            ),
        ).toThrow(/root-authorized/u);
    });
});
