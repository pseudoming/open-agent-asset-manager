import { posix, win32 } from "node:path";
import type { HostPlatformContext } from "@oaam/app-server-bootstrap";

type DesktopHostPlatform = Exclude<HostPlatformContext["platform"], "wsl">;

const REVIEWED_NON_USER_WSL_DISTRIBUTIONS = new Set(["docker-desktop", "docker-desktop-data"]);

export interface DesktopPlatformContextDiscovery {
    readonly hostPlatform: DesktopHostPlatform;
    readonly homePath: string;
    readonly getRunningWslDistroNames: () => readonly string[];
    readonly getWslAccessRootPath: (distroName: string) => string;
}

function localAccessRoot(hostPlatform: DesktopHostPlatform, homePath: string): string {
    const root = hostPlatform === "win32" ? win32.parse(homePath).root : posix.parse(homePath).root;
    if (root.length === 0) throw new TypeError("Desktop home path must be absolute");
    return root;
}

function isEligibleWslDistribution(distroName: string): boolean {
    return !REVIEWED_NON_USER_WSL_DISTRIBUTIONS.has(distroName.toLowerCase());
}

/**
 * Builds the contexts the Desktop Host can expose without inspecting an agent
 * runtime. WSL enumeration is Windows-only, running-only and does not select
 * or probe a distribution.
 */
export function discoverDesktopPlatformContexts(discovery: DesktopPlatformContextDiscovery): readonly HostPlatformContext[] {
    const local = Object.freeze({
        platform: discovery.hostPlatform,
        platformInstanceId: "desktop-local",
        accessRootPath: localAccessRoot(discovery.hostPlatform, discovery.homePath),
    });
    if (discovery.hostPlatform !== "win32") return Object.freeze([local]);

    const distroNames = [...new Set(discovery.getRunningWslDistroNames())].filter(isEligibleWslDistribution).sort();
    return Object.freeze([
        local,
        ...distroNames.map((distroName) =>
            Object.freeze({
                platform: "wsl" as const,
                platformInstanceId: distroName,
                accessRootPath: discovery.getWslAccessRootPath(distroName),
            }),
        ),
    ]);
}
