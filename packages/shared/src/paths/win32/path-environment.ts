import * as os from "node:os";
import { posix, resolve, win32 } from "node:path";
import { SafeFilesystemError } from "../../filesystem/filesystem-types";
import {
    observeLocalPlatformContextBuildArtifactsBounded,
    observeWslHomePathOnce,
    type PathEnvironment,
    type PathEnvironmentPlatform,
    type PlatformContextBuildObservationInput,
    type PlatformContextBuildObservationResult,
    validatePlatformContextBuildObservationInput,
    withPathEnvironmentObservation,
    type WslHomePathResolution,
} from "../path-environment";
import { isSafeDistroName, queryWslDistroNames, queryWslHomePath } from "../wsl-distro-discovery";
import { invokeLocalExecutableTreeBounded } from "./local-executable-invocation";
import {
    readPlatformContextRegularFileNoFollow,
    readPlatformContextRegularFileNoFollowBounded,
    snapshotPlatformContextRegularFileNoFollowBounded,
} from "./platform-context-regular-file";
import {
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
} from "./process-observation";
import { observeSelectedWslProcessLifecycleBounded } from "./selected-wsl-process-lifecycle";
import { observeSelectedWslProcessLifecyclePairBounded } from "./selected-wsl-process-lifecycle-pair";

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
    readPlatformContextRegularFileNoFollowBounded,
    snapshotPlatformContextRegularFileNoFollowBounded,
    withPathEnvironmentObservation,
};

interface BuildObservationDependencies {
    readonly readRegularFile: typeof readPlatformContextRegularFileNoFollowBounded;
}

const DEFAULT_BUILD_OBSERVATION_DEPENDENCIES: BuildObservationDependencies = {
    readRegularFile: readPlatformContextRegularFileNoFollowBounded,
};

/** @internal One immutable build-observation wave in this Windows process. */
export async function observePlatformContextBuildArtifactsBounded(
    input: PlatformContextBuildObservationInput,
): Promise<PlatformContextBuildObservationResult> {
    return observePlatformContextBuildArtifactsBoundedForTest(input);
}

/** @internal Exact local-read dependency seam for operation-wave tests. */
export async function observePlatformContextBuildArtifactsBoundedForTest(
    input: PlatformContextBuildObservationInput,
    overrides: Partial<BuildObservationDependencies> = {},
): Promise<PlatformContextBuildObservationResult> {
    validatePlatformContextBuildObservationInput(input);
    if (input.platform === "wsl") {
        throw new SafeFilesystemError({
            failureKind: "unsupported_platform",
            operation: "read_regular_file",
            targetPath: input.accessRootPath,
            systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION",
            message: "selected WSL build artifacts must be observed in their Linux execution context",
        });
    }
    const dependencies = { ...DEFAULT_BUILD_OBSERVATION_DEPENDENCIES, ...overrides };
    return observeLocalPlatformContextBuildArtifactsBounded(input, dependencies.readRegularFile);
}

export function getHomeDir(): string {
    return process.env.USERPROFILE || os.homedir();
}
export function getPhysicalHomeDirectory(targetRootPath: string): string {
    const selected = /^\\\\wsl\.localhost\\([^\\]+)\\/u.exec(targetRootPath);
    if (selected === null) return getHomeDir();
    const observed = resolveWslHomePath(selected[1]!);
    if (observed.status !== "available") throw new Error("selected distribution home is unavailable");
    return observed.homePath;
}

export function resolveHome(path: string): string {
    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return resolve(getHomeDir(), path.slice(2));
    }
    return resolve(path);
}

export function getWslDistroNames(): string[] {
    return queryWslDistroNames();
}

export function getRunningWslDistroNames(): string[] {
    return queryWslDistroNames("running");
}

export function getWslAccessRootPath(distroName: string): string {
    if (!isSafeDistroName(distroName)) throw new TypeError("WSL distribution name is not a safe UNC share segment");
    return `\\\\wsl.localhost\\${distroName}\\`;
}

export function resolveWslHomePath(distroName: string): WslHomePathResolution {
    return observeWslHomePathOnce(distroName, () => resolveWslHomePathDirect(distroName));
}

function resolveWslHomePathDirect(distroName: string): WslHomePathResolution {
    if (!isSafeDistroName(distroName)) return { status: "unavailable", reason: "invalid_distro_name" };
    if (!getWslDistroNames().includes(distroName)) return { status: "unavailable", reason: "not_installed" };
    const logicalHome = queryWslHomePath(distroName);
    if (logicalHome === null) return { status: "unavailable", reason: "command_failed" };
    if (logicalHome === "/" || !posix.isAbsolute(logicalHome) || posix.normalize(logicalHome) !== logicalHome) {
        return { status: "unavailable", reason: "invalid_home" };
    }
    const homePath = win32.join(getWslAccessRootPath(distroName), ...logicalHome.slice(1).split("/"));
    return { status: "available", homePath };
}

export function isWsl(): boolean {
    return false;
}

export function detectReachablePathPlatforms(): Platform[] {
    return getRunningWslDistroNames().length > 0 ? ["win32", "wsl"] : ["win32"];
}

const win32PathEnvironment = Object.freeze({
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

void win32PathEnvironment;
