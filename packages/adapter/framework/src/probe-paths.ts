/** Runtime-neutral Host-visible path mechanics for Provider probe implementations. */

import type { Platform, PlatformContext } from "@oaam/core";
import { canonicalPhysicalAccessPath, getCanonicalPhysicalAccessPathKind, physicalAccessPathContains } from "@oaam/shared/paths";
import * as path from "node:path";

export type HostPathApi = typeof path.posix | typeof path.win32;

export interface ProviderProbeEnvironment {
    readonly environment: NodeJS.ProcessEnv;
    readonly homePath: string;
}

/** Select the grammar carried by one canonical Host-visible absolute path. */
export function hostPathApiFor(value: string): HostPathApi | null {
    const kind = getCanonicalPhysicalAccessPathKind(value);
    return kind === null ? null : kind === "win32" ? path.win32 : path.posix;
}

export function canonicalHostPath(value: string): string | null {
    return canonicalPhysicalAccessPath(value);
}

/** Canonicalize one Host-visible path only when it stays inside the selected physical access root. */
export function canonicalProviderHostPathWithinAccessRoot(value: string, context: PlatformContext): string | null {
    const canonical = canonicalHostPath(value);
    return canonical !== null && physicalAccessPathContains(context.accessRootPath, canonical) ? canonical : null;
}

/** Core selects the process location; a Provider only consumes this process's Environment inputs. */
export function resolveProviderProbeEnvironment(
    context: PlatformContext,
    processEnvironment: NodeJS.ProcessEnv,
    processHomePath: string,
    hostPlatform: NodeJS.Platform,
): ProviderProbeEnvironment | null {
    if (
        hostPlatform === context.platform ||
        (hostPlatform === "linux" && (context.platform === "linux" || context.platform === "wsl"))
    ) {
        const homePath = canonicalProviderHostPathWithinAccessRoot(processHomePath, context);
        if (homePath === null) return null;
        return {
            environment: processEnvironment,
            homePath,
        };
    }
    return null;
}

/** Map a runtime-native absolute path into the Host-visible selected context. */
export function runtimeAbsolutePathToHost(platform: Platform, accessRootPath: string, runtimePath: string): string | null {
    if (platform !== "wsl" || hostPathApiFor(accessRootPath) !== path.win32) {
        return canonicalHostPath(runtimePath);
    }
    const root = wslUncRoot(accessRootPath);
    if (
        root === null ||
        runtimePath.includes("\0") ||
        !path.posix.isAbsolute(runtimePath) ||
        path.posix.normalize(runtimePath) !== runtimePath
    ) {
        return null;
    }
    return runtimePath === "/" ? root : path.win32.join(root, ...runtimePath.slice(1).split("/"));
}

/** Map one Host-visible path back to the selected runtime's absolute spelling. */
export function hostAbsolutePathToRuntime(platform: Platform, accessRootPath: string, hostPath: string): string | null {
    if (platform !== "wsl" || hostPathApiFor(accessRootPath) !== path.win32) {
        return canonicalHostPath(hostPath);
    }
    const root = wslUncRoot(accessRootPath);
    if (root === null || hostPathApiFor(hostPath) !== path.win32) return null;
    const relative = path.win32.relative(root, hostPath);
    if (relative === "") return "/";
    if (relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) return null;
    return `/${relative.split(path.win32.sep).join("/")}`;
}

/** Resolve one runtime or Host absolute reference, or one relative reference below a Host base. */
export function resolveProviderHostPathReference(basePath: string, reference: string, context: PlatformContext): string | null {
    const canonicalBase = canonicalProviderHostPathWithinAccessRoot(basePath, context);
    if (canonicalBase === null) return null;
    const basePaths = hostPathApiFor(canonicalBase) as HostPathApi;
    if (reference.includes("\0")) return null;
    const canonical = canonicalHostPath(reference);
    if (canonical !== null) {
        if (hostPathApiFor(canonical) === basePaths) {
            return canonicalProviderHostPathWithinAccessRoot(canonical, context);
        }
        const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, reference);
        return mapped !== null && hostPathApiFor(mapped) === basePaths
            ? canonicalProviderHostPathWithinAccessRoot(mapped, context)
            : null;
    }
    if (basePaths.isAbsolute(reference)) return null;
    return canonicalProviderHostPathWithinAccessRoot(basePaths.resolve(canonicalBase, reference), context);
}

export function isWindowsHostedWslContext(context: PlatformContext, hostPlatform: NodeJS.Platform): boolean {
    return hostPlatform === "win32" && context.platform === "wsl" && wslUncRoot(context.accessRootPath) !== null;
}

export function isWslUncHostPath(value: string): boolean {
    return wslUncRoot(value) !== null;
}

function wslUncRoot(value: string): string | null {
    if (hostPathApiFor(value) !== path.win32) return null;
    const root = path.win32.parse(value).root;
    const match = /^\\\\wsl\.localhost\\([^\\]+)\\$/iu.exec(root);
    if (match === null || match[1] === undefined || !isSafeUncSegment(match[1])) return null;
    return root;
}

function isSafeUncSegment(value: string): boolean {
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
