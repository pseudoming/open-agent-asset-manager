import * as fs from "node:fs";
import * as os from "node:os";
import { resolve } from "node:path";
import type { StableRegularFileRead } from "../../filesystem/filesystem-types";
import {
    observeLocalPlatformContextBuildArtifactsBounded,
    type PathEnvironment,
    type PathEnvironmentPlatform,
    type PlatformContextBuildObservationInput,
    type PlatformContextBuildObservationResult,
    type PlatformContextRegularFileReadInput,
    type PlatformContextRegularFileSnapshot,
    snapshotStableRegularFileRead,
    validatePlatformContextRegularFileReadInput,
    validatePlatformContextRegularFileSnapshotInput,
    withPathEnvironmentObservation,
    type WslHomePathResolution,
} from "../path-environment";
import { isSafeDistroName, queryWslDistroNames } from "../wsl-distro-discovery";
import { invokeLocalExecutableTreeBounded } from "./local-executable-invocation";
import { readPlatformContextRegularFileNoFollow } from "./platform-context-regular-file";
import {
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
} from "./process-observation";
import { observeSelectedWslProcessLifecycleBounded, observeSelectedWslProcessLifecyclePairBounded } from "./selected-wsl-process";

export { resolveWin32PackagedWorkerPath } from "../packaged-worker-path";
export type {
    LocalExecutableEnvironmentEntry,
    LocalExecutableTreeInvocationResult,
    LocalProcessExecutableIdentity,
    LocalProcessObservation,
    OwnedInvocationProcessIdentity,
    PathEnvironment,
    PathEnvironmentPlatform,
    PlatformContextBuildObservationInput,
    PlatformContextBuildObservationItem,
    PlatformContextBuildObservationResult,
    PlatformContextRegularFileReadInput,
    PlatformContextRegularFileSnapshot,
    WslHomePathResolution,
} from "../path-environment";
export {
    canonicalPhysicalAccessPath,
    getCanonicalPhysicalAccessPathKind,
    isAbsolutePhysicalAccessPathForRoot,
    isCanonicalPhysicalAccessPath,
    joinPhysicalAccessPath,
    normalizePhysicalAccessPathWithinRoot,
    physicalAccessPathContains,
    relatePhysicalAccessPaths,
    splitPhysicalAccessPath,
} from "../physical-access-paths";
export type { PhysicalAccessPathKind, PhysicalAccessPathRelation } from "../physical-access-paths";
export { createSelectedWslPathProjection, isSelectedWslPhysicalRootMapping } from "../selected-wsl-path-projection";
export type Platform = PathEnvironmentPlatform;

export {
    invokeLocalExecutableTreeBounded,
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
    observeSelectedWslProcessLifecycleBounded,
    observeSelectedWslProcessLifecyclePairBounded,
    readPlatformContextRegularFileNoFollow,
    withPathEnvironmentObservation,
};

/** @internal Unix-like reads are already descriptor-local; retain the same bounded async consumer shape. */
export async function readPlatformContextRegularFileNoFollowBounded(
    input: PlatformContextRegularFileReadInput,
    timeoutMilliseconds: number,
): Promise<StableRegularFileRead> {
    validatePlatformContextRegularFileReadInput(input);
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 || timeoutMilliseconds > 30_000) {
        throw new RangeError("timeoutMilliseconds must be no greater than 30000");
    }
    return readPlatformContextRegularFileNoFollow(input);
}

/** Stable facts stay with the existing descriptor-local reader on Unix-like builds. */
export async function snapshotPlatformContextRegularFileNoFollowBounded(
    input: PlatformContextRegularFileReadInput,
    timeoutMilliseconds: number,
): Promise<PlatformContextRegularFileSnapshot> {
    validatePlatformContextRegularFileSnapshotInput(input, timeoutMilliseconds);
    return snapshotStableRegularFileRead(readPlatformContextRegularFileNoFollow(input));
}

/** @internal Unix-like build observations remain descriptor-local and operation-scoped. */
export async function observePlatformContextBuildArtifactsBounded(
    input: PlatformContextBuildObservationInput,
): Promise<PlatformContextBuildObservationResult> {
    return observePlatformContextBuildArtifactsBoundedForTest(input);
}

/** @internal Exact local-read dependency seam matching the Win32 build-time surface. */
export async function observePlatformContextBuildArtifactsBoundedForTest(
    input: PlatformContextBuildObservationInput,
    overrides: {
        readonly readRegularFile?: typeof readPlatformContextRegularFileNoFollowBounded;
    } = {},
): Promise<PlatformContextBuildObservationResult> {
    return observeLocalPlatformContextBuildArtifactsBounded(
        input,
        overrides.readRegularFile ?? readPlatformContextRegularFileNoFollowBounded,
    );
}

export function getPhysicalHomeDirectory(_targetRootPath: string): string {
    return getHomeDir();
}

export function getHomeDir(): string {
    return os.homedir();
}

export function resolveHome(path: string): string {
    if (path.startsWith("~/")) {
        return resolve(os.homedir(), path.slice(2));
    }
    return resolve(path);
}

export function isWsl(): boolean {
    if (process.env.WSL_DISTRO_NAME) {
        return true;
    }
    try {
        const content = fs.readFileSync("/proc/version", "utf-8");
        return content.toLowerCase().includes("microsoft");
    } catch {
        return false;
    }
}

/**
 * Discover path environments reachable from this Unix-like process. This is
 * not physical-filesystem backend selection: the installed artifact always
 * keeps its build-selected Unix-like mechanics.
 */
export function detectReachablePathPlatforms(): Platform[] {
    const current = probeCurrentPlatform();

    if (current === "win32") {
        const distros = getRunningWslDistroNames();
        if (distros.length > 0) return ["win32", "wsl"];
        return ["win32"];
    }

    if (current === "wsl") {
        if (fs.existsSync("/mnt/c/")) return ["wsl", "win32"];
        return ["wsl"];
    }

    return [current];
}

/**
 * Enumerate concrete WSL2 distribution names on Windows via `wsl.exe -l -q`.
 * Returns [] on non-Windows or when wsl.exe is unavailable / errors.
 */
export function getWslDistroNames(): string[] {
    return queryWslDistroNames();
}

export function getRunningWslDistroNames(): string[] {
    return queryWslDistroNames("running");
}

export function getWslAccessRootPath(distroName: string): string {
    if (!isSafeDistroName(distroName)) throw new TypeError("WSL distribution name is not a safe path-context identity");
    if (isWsl() && process.env.WSL_DISTRO_NAME === distroName) return "/";
    throw new TypeError("the current Unix-like host cannot construct another WSL distribution access root");
}

export function resolveWslHomePath(distroName: string): WslHomePathResolution {
    if (!isSafeDistroName(distroName)) return { status: "unavailable", reason: "invalid_distro_name" };
    if (!isWsl() || process.env.WSL_DISTRO_NAME !== distroName) return { status: "unavailable", reason: "wrong_host" };
    return { status: "available", homePath: getHomeDir() };
}

function probeCurrentPlatform(): Platform {
    if (process.platform === "linux") {
        if (isWsl()) return "wsl";
        return "linux";
    }
    return process.platform as Platform;
}

const unixLikePathEnvironment = Object.freeze({
    getHomeDir,
    getPhysicalHomeDirectory,
    resolveHome,
    isWsl,
    detectReachablePathPlatforms,
    getWslDistroNames,
    getRunningWslDistroNames,
    getWslAccessRootPath,
    resolveWslHomePath,
    withPathEnvironmentObservation,
    readPlatformContextRegularFileNoFollow,
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
    invokeLocalExecutableTreeBounded,
    observeSelectedWslProcessLifecycleBounded,
    observeSelectedWslProcessLifecyclePairBounded,
}) satisfies PathEnvironment;

void unixLikePathEnvironment;
