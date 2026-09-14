import { win32 as win32Path } from "node:path";
import type { WslHomePathResolution } from "@oaam/shared/paths";
import type { DesktopHostBootOptions } from "../process/control-protocol";
import type { ResolveEnvironmentChoiceWslHome } from "./packaged-environment-choice-smoke";
import type { PackagedProviderProjectRegistrationFixture } from "./packaged-provider-project-registration-ui-smoke";
import type { PackagedProviderSourceIgnoreFixture } from "./packaged-provider-source-ignore-ui-smoke";

export const PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT = "OAAM_PACKAGED_ONBOARDING_WSL_HOME";

interface PackagedOnboardingWslHome {
    readonly distroName: string;
    readonly homePath: string;
    readonly rootPath: string;
}

export function packagedOnboardingWslProjectSmokeActive(packagedRuntimeSmoke: boolean, hostPlatform: NodeJS.Platform): boolean {
    return packagedRuntimeSmoke && hostPlatform === "win32";
}

export function applyPackagedOnboardingWslProjectPlatformContexts(
    active: boolean,
    environment: NodeJS.ProcessEnv,
    platformContexts: DesktopHostBootOptions["platformContexts"],
): DesktopHostBootOptions["platformContexts"] {
    const fixture = readPackagedOnboardingWslHome(active, environment);
    if (fixture === null) return platformContexts;
    const matches = platformContexts.filter(
        (context) => context.platform === "wsl" && context.platformInstanceId === fixture.distroName,
    );
    if (matches.length !== 1 || matches[0] === undefined || !sameWindowsPath(matches[0].accessRootPath, fixture.rootPath)) {
        throw new TypeError("packaged onboarding WSL fixture requires one exact root-authorized PlatformContext");
    }
    return Object.freeze(
        platformContexts.flatMap((context) => {
            if (context.platform !== "wsl") return [context];
            if (context !== matches[0]) return [];
            return [Object.freeze({ ...context, accessRootPath: fixture.homePath })];
        }),
    );
}

export function packagedOnboardingWslHomeResolver(
    active: boolean,
    environment: NodeJS.ProcessEnv,
    fallback: ResolveEnvironmentChoiceWslHome,
): ResolveEnvironmentChoiceWslHome {
    const fixture = readPackagedOnboardingWslHome(active, environment);
    if (fixture === null) return fallback;
    return (distroName: string): WslHomePathResolution =>
        distroName === fixture.distroName
            ? Object.freeze({ status: "available", homePath: fixture.homePath })
            : Object.freeze({ status: "unavailable", reason: "not_installed" });
}

export function packagedOnboardingWslProjectRegistrationFixture(
    active: boolean,
    environment: NodeJS.ProcessEnv,
): PackagedProviderProjectRegistrationFixture | null {
    const fixture = readPackagedOnboardingWslHome(active, environment);
    return fixture === null
        ? null
        : Object.freeze({
              ownership: "current_run_exact_wsl_root",
              environment: JSON.stringify(["wsl", fixture.distroName]),
              rootPath: fixture.homePath,
              projectPath: win32Path.join(fixture.homePath, "projects", "onboarding-project"),
          });
}

export function packagedOnboardingWslProviderSourceIgnoreFixture(
    active: boolean,
    environment: NodeJS.ProcessEnv,
): PackagedProviderSourceIgnoreFixture | null {
    const fixture = readPackagedOnboardingWslHome(active, environment);
    return fixture === null
        ? null
        : Object.freeze({
              ownership: "current_run_exact_wsl_root",
              environment: JSON.stringify(["wsl", fixture.distroName]),
              rootPath: fixture.homePath,
              sourcePath: win32Path.join(fixture.homePath, ".config", "opencode"),
              projectPath: win32Path.join(fixture.homePath, "projects", "onboarding-project"),
          });
}

function readPackagedOnboardingWslHome(active: boolean, environment: NodeJS.ProcessEnv): PackagedOnboardingWslHome | null {
    const value = environment[PACKAGED_ONBOARDING_WSL_HOME_ENVIRONMENT];
    if (!active) {
        if (value !== undefined) {
            throw new TypeError("packaged onboarding WSL fixture is valid only for the runtime package proof");
        }
        return null;
    }
    if (typeof value !== "string" || value === "" || value.includes("\0")) {
        throw new TypeError("packaged onboarding runtime proof requires one WSL fixture HOME");
    }
    const rootMatch = /^\\\\wsl\.localhost\\([^\\]+)\\/iu.exec(value);
    if (
        rootMatch?.[1] === undefined ||
        !win32Path.isAbsolute(value) ||
        win32Path.normalize(value) !== value ||
        !safeDistroName(rootMatch[1])
    ) {
        throw new TypeError("packaged onboarding WSL fixture HOME must be one canonical WSL UNC child");
    }
    const rootPath = `\\\\wsl.localhost\\${rootMatch[1]}\\`;
    const relative = win32Path.relative(rootPath, value);
    if (relative === "" || relative === ".." || relative.startsWith(`..${win32Path.sep}`) || win32Path.isAbsolute(relative)) {
        throw new TypeError("packaged onboarding WSL fixture HOME must be one canonical WSL UNC child");
    }
    return Object.freeze({ distroName: rootMatch[1], homePath: value, rootPath });
}

function sameWindowsPath(left: string, right: string): boolean {
    return left.localeCompare(right, "en", { sensitivity: "accent" }) === 0;
}

function safeDistroName(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        value.trim() === value &&
        !value.endsWith(".") &&
        !value.endsWith(" ") &&
        ![...value].some((character) => character.charCodeAt(0) < 0x20 || '\\\\/:*?"<>|'.includes(character))
    );
}
