/** ZCode project-keyed Memory paths derived from the effective bounded runtime configuration. */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { canonicalProviderHostPathWithinAccessRoot, hostPathApiFor } from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import {
    createZcodeRuntimeConfigResolver,
    type ResolveZcodeProjectConfigInput,
    type ZcodeProjectConfigResolution,
    type ZcodeRuntimeConfigResolver,
    type ZcodeRuntimeConfigResolverInput,
} from "./zcode-probe-config-paths";
import { diagnostic, type ResolvedZcodePath } from "./zcode-probe-foundation";

export type ZcodeMemoryRootResolverInput = ZcodeRuntimeConfigResolverInput;
export type ResolveZcodeProjectMemoryRootInput = ResolveZcodeProjectConfigInput;

export interface ZcodeProjectMemoryRootResolution {
    resolved: ResolvedZcodePath | null;
    diagnostics: OperationDiagnostic[];
}

export interface ZcodeMemoryRootResolver {
    diagnostics: OperationDiagnostic[];
    resolveProject(input: ResolveZcodeProjectMemoryRootInput): ZcodeProjectMemoryRootResolution;
}

export function createZcodeMemoryRootResolver(
    input: ZcodeMemoryRootResolverInput,
    configResolver: ZcodeRuntimeConfigResolver = createZcodeRuntimeConfigResolver(input),
): ZcodeMemoryRootResolver {
    return {
        diagnostics: configResolver.diagnostics,
        resolveProject: (project) => resolveZcodeProjectMemoryRoot(input, project, configResolver),
    };
}

function resolveZcodeProjectMemoryRoot(
    base: ZcodeMemoryRootResolverInput,
    project: ResolveZcodeProjectMemoryRootInput,
    configResolver: ZcodeRuntimeConfigResolver,
): ZcodeProjectMemoryRootResolution {
    const config = configResolver.resolveProject(project);
    const memory = resolveZcodeProjectMemoryRootFromConfig(base, project, config);
    return { ...memory, diagnostics: [...configResolver.diagnostics, ...config.diagnostics, ...memory.diagnostics] };
}

export function resolveZcodeProjectMemoryRootFromConfig(
    base: ZcodeMemoryRootResolverInput,
    project: ResolveZcodeProjectMemoryRootInput,
    config: ZcodeProjectConfigResolution,
): ZcodeProjectMemoryRootResolution {
    const diagnostics: OperationDiagnostic[] = [];
    if (config.storageRoot === null) return { resolved: null, diagnostics };
    const storageRoot = config.storageRoot.path;
    const hostPaths = hostPathApiFor(storageRoot);
    if (hostPaths === null) {
        diagnostics.push(
            diagnostic(
                "zcode_memory_storage_path_unsupported",
                "ZCode storage path does not match a supported Host-visible path grammar",
                "invalid_schema",
                "warning",
                storageRoot,
            ),
        );
        return { resolved: null, diagnostics };
    }
    const cliStorageRoot = hostPaths.basename(storageRoot) === "cli" ? storageRoot : hostPaths.join(storageRoot, "cli");
    const projectKey = createZcodeProjectMemoryKey(project.runtimeProjectPath, base.platformContext.platform);
    if (projectKey === null) {
        diagnostics.push(
            diagnostic(
                "zcode_memory_project_path_invalid",
                "ZCode project path cannot be converted to the runtime project Memory key",
                "invalid_schema",
                "warning",
                project.hostProjectPath,
            ),
        );
        return { resolved: null, diagnostics };
    }
    const candidate = hostPaths.join(cliStorageRoot, "memories", "projects", projectKey);
    const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, base.platformContext);
    if (canonical === null || hostPathApiFor(canonical) !== hostPaths) {
        diagnostics.push(
            diagnostic(
                "zcode_memory_root_outside_access_boundary",
                "Resolved ZCode Memory root is outside the selected physical access root",
                "invalid_schema",
                "warning",
                candidate,
            ),
        );
        return { resolved: null, diagnostics };
    }
    return {
        resolved: {
            path: canonical,
            locatorKind: config.storageRoot.locatorKind,
            locatorKey: config.storageRoot.locatorKey,
        },
        diagnostics,
    };
}

export function createZcodeProjectMemoryKey(runtimeProjectPath: string, platform: PlatformContext["platform"]): string | null {
    if (runtimeProjectPath.trim() === "" || runtimeProjectPath.includes("\0")) return null;
    const runtimePaths = platform === "win32" ? path.win32 : path.posix;
    if (!runtimePaths.isAbsolute(runtimeProjectPath)) return null;
    const resolved = runtimePaths.resolve(runtimeProjectPath);
    const hashed = platform === "win32" ? resolved.toLowerCase() : resolved;
    const digest = crypto.createHash("sha256").update(hashed).digest("hex").slice(0, 16);
    const rawSlug = runtimePaths.basename(resolved).toLowerCase();
    const slug = sanitizeProjectSlug(rawSlug);
    return `${slug}-${digest}`;
}

function sanitizeProjectSlug(value: string): string {
    let result = "";
    let inInvalidRun = false;
    for (const character of value) {
        const allowed =
            (character >= "a" && character <= "z") ||
            (character >= "0" && character <= "9") ||
            character === "." ||
            character === "_" ||
            character === "-";
        if (allowed) {
            result += character;
            inInvalidRun = false;
        } else if (!inInvalidRun) {
            result += "-";
            inInvalidRun = true;
        }
    }
    while (result.startsWith("-")) result = result.slice(1);
    while (result.endsWith("-")) result = result.slice(0, -1);
    result = result.slice(0, 48);
    return result === "" ? "project" : result;
}
