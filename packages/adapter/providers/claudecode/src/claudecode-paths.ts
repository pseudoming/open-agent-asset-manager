import {
    canonicalProviderHostPathWithinAccessRoot,
    canonicalHostPath,
    hostPathApiFor,
    isWslUncHostPath,
    runtimeAbsolutePathToHost,
} from "@oaam/adapter-framework";
import { getHomeDir } from "@oaam/shared/paths";
import type { Platform, PlatformContext, RootLocatorKind } from "@oaam/core";

/** Current source-artifact limit for a Claude project-key path component. */
export const MAX_SANITIZED_PROJECT_KEY_LENGTH = 200;

export interface ClaudeCodePathRule {
    platform: Platform;
    configRoot: string;
    projectsDir: string;
    memoryDirPattern: string;
}

export interface ResolvedClaudePath {
    path: string;
    locatorKind: Exclude<RootLocatorKind, "unknown">;
    locatorKey: string;
}

/**
 * Claude Code project path -> project-key directory name.
 *
 * The installed source replaces every non-ASCII-alphanumeric character, one
 * for one. It does not collapse separator runs. Node-side OAAM uses the same
 * deterministic fallback hash used by the Claude SDK for long keys; probe can
 * additionally discover a matching existing Bun-created prefix on disk.
 */
export function sanitizePath(projectPath: string): string {
    let sanitized = "";
    for (let index = 0; index < projectPath.length; index += 1) {
        const character = projectPath.charAt(index);
        const code = projectPath.charCodeAt(index);
        const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
        sanitized += alphanumeric ? character : "-";
    }
    if (sanitized.length <= MAX_SANITIZED_PROJECT_KEY_LENGTH) return sanitized;
    return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_KEY_LENGTH)}-${simpleHash(projectPath)}`;
}

export function resolveClaudeConfigRoot(
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
): ResolvedClaudePath | null {
    const override = environment.CLAUDE_CONFIG_DIR;
    if (override !== undefined && override.trim() !== "") {
        const path = canonicalAbsolutePath(override, false, homeDir);
        return path === null
            ? null
            : {
                  path,
                  locatorKind: "runtime_declared_path",
                  locatorKey: "CLAUDE_CONFIG_DIR",
              };
    }
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return null;
    const path = canonicalAbsolutePath(paths.join(homeDir, ".claude"), false, homeDir);
    return path === null ? null : { path, locatorKind: "runtime_known_rule", locatorKey: "claude_config_default" };
}

export function resolveFullMemoryOverride(
    rawPath: string | undefined,
    locatorKey: string,
    expandHome: boolean,
    homeDir: string = getHomeDir(),
    platformContext?: PlatformContext,
): ResolvedClaudePath | null {
    if (rawPath === undefined || rawPath.trim() === "") return null;
    const runtimePath = canonicalAbsolutePath(rawPath, expandHome, homeDir);
    if (runtimePath === null || isDangerouslyBroadMemoryRoot(runtimePath)) return null;
    const hostPath = materializeSelectedEnvironmentPath(runtimePath, platformContext);
    if (hostPath === null || isDangerouslyBroadMemoryRoot(hostPath)) return null;
    return { path: hostPath, locatorKind: "runtime_declared_path", locatorKey };
}

export function resolveProjectMemoryRoot(input: {
    configRoot: string;
    projectRootPath: string;
    remoteMemoryBase?: string;
    homeDir?: string;
    platformContext?: PlatformContext;
}): ResolvedClaudePath | null {
    const homeDir = input.homeDir ?? getHomeDir();
    const baseRaw = input.remoteMemoryBase ?? input.configRoot;
    const runtimeBase = canonicalAbsolutePath(baseRaw, false, homeDir);
    if (runtimeBase === null) return null;
    const base = materializeSelectedEnvironmentPath(runtimeBase, input.platformContext);
    if (base === null) return null;
    const paths = hostPathApiFor(base);
    if (paths === null) return null;
    return {
        path: paths.join(base, "projects", sanitizePath(input.projectRootPath), "memory"),
        locatorKind: input.remoteMemoryBase === undefined ? "runtime_known_rule" : "runtime_declared_path",
        locatorKey: input.remoteMemoryBase === undefined ? "claude_project_memory_default" : "CLAUDE_CODE_REMOTE_MEMORY_DIR",
    };
}

export function getPathRule(
    platform: Platform,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
): ClaudeCodePathRule | null {
    const config = resolveClaudeConfigRoot(environment, homeDir);
    if (config === null) return null;
    const paths = hostPathApiFor(config.path);
    if (paths === null) return null;
    return {
        platform,
        configRoot: config.path,
        projectsDir: paths.join(config.path, "projects"),
        memoryDirPattern: paths.join(config.path, "projects", "{sanitized}", "memory"),
    };
}

function canonicalAbsolutePath(rawPath: string, expandHome: boolean, homeDir: string): string | null {
    if (rawPath.includes("\0")) return null;
    let candidate = rawPath;
    if (expandHome && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
        const paths = hostPathApiFor(homeDir);
        if (paths === null) return null;
        const remainder = candidate.slice(2);
        const normalizedRemainder = paths.normalize(remainder || ".");
        if (
            normalizedRemainder === "." ||
            normalizedRemainder === ".." ||
            normalizedRemainder.startsWith(`..${paths.sep}`) ||
            paths.isAbsolute(normalizedRemainder)
        )
            return null;
        candidate = paths.join(homeDir, normalizedRemainder);
    }
    const normalized = canonicalHostPath(candidate);
    if (normalized === null) return null;
    return normalized.startsWith("\\\\") && !isWslUncHostPath(normalized) ? null : normalized;
}

function isDangerouslyBroadMemoryRoot(path: string): boolean {
    const paths = hostPathApiFor(path);
    return paths === null || paths.parse(path).root === path;
}

function materializeSelectedEnvironmentPath(value: string, context: PlatformContext | undefined): string | null {
    if (context === undefined) return value;
    const accessPaths = hostPathApiFor(context.accessRootPath);
    const valuePaths = hostPathApiFor(value);
    if (accessPaths === null || valuePaths === null) return null;
    if (accessPaths === valuePaths) {
        return canonicalProviderHostPathWithinAccessRoot(value, context);
    }
    const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, value);
    return mapped !== null && hostPathApiFor(mapped) === accessPaths
        ? canonicalProviderHostPathWithinAccessRoot(mapped, context)
        : null;
}

function simpleHash(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
}
