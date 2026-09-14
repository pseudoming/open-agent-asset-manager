/** Bounded ZCode config precedence and runtime-declared source paths. This module never mutates disk. */

import { canonicalProviderHostPathWithinAccessRoot, hostPathApiFor, runtimeAbsolutePathToHost } from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure, readRegularFileBounded } from "@oaam/shared/filesystem";
import { lstatSync } from "node:fs";
import * as path from "node:path";
import { diagnostic, type ResolvedZcodePath } from "./zcode-probe-foundation";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface ZcodeRuntimeConfigResolverInput {
    environment: NodeJS.ProcessEnv;
    homeDir: string;
    platformContext: PlatformContext;
}

export interface ResolveZcodeProjectConfigInput {
    hostProjectPath: string;
    runtimeProjectPath: string;
}

export interface ResolvedZcodeConfigPath extends ResolvedZcodePath {
    association: "global" | "project";
}

export interface ZcodeGlobalConfigPaths {
    storageRoot: ResolvedZcodeConfigPath | null;
    skillRoots: ResolvedZcodeConfigPath[];
}

export interface ZcodeProjectConfigResolution {
    complete: boolean;
    projectConfigDirectories: string[];
    storageRoot: ResolvedZcodeConfigPath | null;
    skillRoots: ResolvedZcodeConfigPath[];
    diagnostics: OperationDiagnostic[];
}

export interface ZcodeRuntimeConfigResolver {
    complete: boolean;
    projectContextRequired: boolean;
    diagnostics: OperationDiagnostic[];
    global: ZcodeGlobalConfigPaths;
    resolveProject(input: ResolveZcodeProjectConfigInput): ZcodeProjectConfigResolution;
}

interface ConfigPatch {
    storageDir?: string;
    skillsRoots?: string[];
}

interface ConfigDeclaration {
    value: string;
    locatorKey: "storage.dir" | "skills.roots";
    origin: "environment" | "user_config" | "project_config";
}

interface ConfigReadResult {
    complete: boolean;
    patch: ConfigPatch;
}

type WorktreeMarkerInspection = "found" | "absent" | "unknown";

export function createZcodeRuntimeConfigResolver(input: ZcodeRuntimeConfigResolverInput): ZcodeRuntimeConfigResolver {
    const diagnostics: OperationDiagnostic[] = [];
    const userConfigPath = joinHost(input.homeDir, ".zcode", "cli", "config.json");
    const user = readConfigPatch(userConfigPath, diagnostics);
    const environmentStorage = storageEnvironmentDeclaration(input, diagnostics);
    const userStorage = declarationForStorage(user.patch, "user_config");
    const globalStorage = resolveDeclarationWithoutProject(environmentStorage ?? userStorage, input, diagnostics, true);
    const globalSkills = (user.patch.skillsRoots ?? [])
        .map((value) => ({ value, locatorKey: "skills.roots" as const, origin: "user_config" as const }))
        .flatMap((declaration) => {
            const resolved = resolveDeclarationWithoutProject(declaration, input, diagnostics, false);
            return resolved === null ? [] : [resolved];
        });
    const complete = user.complete && environmentStorage !== INVALID_ENVIRONMENT_STORAGE && diagnostics.length === 0;
    const runtimePaths = input.platformContext.platform === "win32" ? path.win32 : path.posix;
    const projectContextRequired = [
        environmentStorage === null || environmentStorage === INVALID_ENVIRONMENT_STORAGE ? undefined : environmentStorage.value,
        user.patch.storageDir,
        ...(user.patch.skillsRoots ?? []),
    ].some((value) => value !== undefined && !value.startsWith("~/") && !runtimePaths.isAbsolute(value));

    return {
        complete,
        projectContextRequired,
        diagnostics,
        global: {
            storageRoot:
                environmentStorage === INVALID_ENVIRONMENT_STORAGE
                    ? null
                    : (globalStorage ?? (environmentStorage === null && userStorage === null ? defaultStorageRoot(input) : null)),
            skillRoots: uniqueResolvedPaths(globalSkills),
        },
        resolveProject: (project) => resolveProjectConfig(input, project, user, environmentStorage),
    };
}

const INVALID_ENVIRONMENT_STORAGE = Symbol("invalid-environment-storage");

function storageEnvironmentDeclaration(
    input: ZcodeRuntimeConfigResolverInput,
    diagnostics: OperationDiagnostic[],
): ConfigDeclaration | null | typeof INVALID_ENVIRONMENT_STORAGE {
    const value = input.environment.ZCODE_STORAGE_DIR;
    if (value === undefined) return null;
    if (value.trim() !== "") return { value, locatorKey: "storage.dir", origin: "environment" };
    diagnostics.push(
        configDiagnostic(
            "zcode_config_storage_environment_invalid",
            "ZCODE_STORAGE_DIR must be a non-empty path when it is present",
            "ZCODE_STORAGE_DIR",
        ),
    );
    return INVALID_ENVIRONMENT_STORAGE;
}

function resolveProjectConfig(
    base: ZcodeRuntimeConfigResolverInput,
    project: ResolveZcodeProjectConfigInput,
    user: ConfigReadResult,
    environmentStorage: ConfigDeclaration | null | typeof INVALID_ENVIRONMENT_STORAGE,
): ZcodeProjectConfigResolution {
    const diagnostics: OperationDiagnostic[] = [];
    const directories = resolveProjectConfigDirectories(base, project, diagnostics);
    if (directories === null) {
        return { complete: false, projectConfigDirectories: [], storageRoot: null, skillRoots: [], diagnostics };
    }

    let complete = user.complete;
    let storage = declarationForStorage(user.patch, "user_config");
    let skillDeclarations = declarationsForSkills(user.patch, "user_config");
    for (const directory of directories) {
        for (const relativePath of ["zcode.json", ".zcode/config.json"] as const) {
            const result = readConfigPatch(joinPortableHost(directory, relativePath), diagnostics);
            complete = result.complete && complete;
            if (result.patch.storageDir !== undefined) storage = declarationForStorage(result.patch, "project_config");
            if (result.patch.skillsRoots !== undefined) {
                skillDeclarations = declarationsForSkills(result.patch, "project_config");
            }
        }
    }
    if (environmentStorage === INVALID_ENVIRONMENT_STORAGE) {
        complete = false;
        storage = null;
    } else if (environmentStorage !== null) {
        storage = environmentStorage;
    }

    const storageRoot =
        environmentStorage === INVALID_ENVIRONMENT_STORAGE
            ? null
            : storage === null
              ? defaultStorageRoot(base)
              : resolveDeclarationForProject(storage, base, project, diagnostics, true);
    const skillRoots = uniqueResolvedPaths(
        skillDeclarations.flatMap((declaration) => {
            const resolved = resolveDeclarationForProject(declaration, base, project, diagnostics, false);
            return resolved === null ? [] : [resolved];
        }),
    );
    return {
        complete: complete && storageRoot !== null && diagnostics.length === 0,
        projectConfigDirectories: directories,
        storageRoot,
        skillRoots,
        diagnostics,
    };
}

function declarationForStorage(patch: ConfigPatch, origin: ConfigDeclaration["origin"]): ConfigDeclaration | null {
    return patch.storageDir === undefined ? null : { value: patch.storageDir, locatorKey: "storage.dir", origin };
}

function declarationsForSkills(patch: ConfigPatch, origin: ConfigDeclaration["origin"]): ConfigDeclaration[] {
    return (patch.skillsRoots ?? []).map((value) => ({ value, locatorKey: "skills.roots", origin }));
}

function resolveDeclarationWithoutProject(
    declaration: ConfigDeclaration | null | typeof INVALID_ENVIRONMENT_STORAGE,
    input: ZcodeRuntimeConfigResolverInput,
    diagnostics: OperationDiagnostic[],
    storage: boolean,
): ResolvedZcodeConfigPath | null {
    if (declaration === null || declaration === INVALID_ENVIRONMENT_STORAGE) return null;
    const runtimePaths = input.platformContext.platform === "win32" ? path.win32 : path.posix;
    if (!declaration.value.startsWith("~/") && !runtimePaths.isAbsolute(declaration.value)) return null;
    return resolveDeclaredPath(declaration, input, null, diagnostics, storage);
}

function resolveDeclarationForProject(
    declaration: ConfigDeclaration,
    input: ZcodeRuntimeConfigResolverInput,
    project: ResolveZcodeProjectConfigInput,
    diagnostics: OperationDiagnostic[],
    storage: boolean,
): ResolvedZcodeConfigPath | null {
    return resolveDeclaredPath(declaration, input, project, diagnostics, storage);
}

function resolveDeclaredPath(
    declaration: ConfigDeclaration,
    input: ZcodeRuntimeConfigResolverInput,
    project: ResolveZcodeProjectConfigInput | null,
    diagnostics: OperationDiagnostic[],
    storage: boolean,
): ResolvedZcodeConfigPath | null {
    let candidate: string | null = null;
    try {
        if (declaration.value.includes("\0")) throw new Error("NUL path");
        if (declaration.value.startsWith("~/")) {
            candidate = joinPortableHost(input.homeDir, declaration.value.slice(2));
        } else {
            const runtimePaths = input.platformContext.platform === "win32" ? path.win32 : path.posix;
            if (runtimePaths.isAbsolute(declaration.value)) {
                candidate = runtimeAbsolutePathToHost(
                    input.platformContext.platform,
                    input.platformContext.accessRootPath,
                    declaration.value,
                );
            } else if (project !== null) {
                candidate = runtimeAbsolutePathToHost(
                    input.platformContext.platform,
                    input.platformContext.accessRootPath,
                    runtimePaths.resolve(project.runtimeProjectPath, declaration.value),
                );
            }
        }
    } catch {
        candidate = null;
    }
    const canonical = candidate === null ? null : canonicalProviderHostPathWithinAccessRoot(candidate, input.platformContext);
    if (canonical === null) {
        diagnostics.push(
            configDiagnostic(
                storage ? "zcode_config_storage_path_invalid" : "zcode_config_skill_root_invalid",
                storage
                    ? "ZCode storage.dir must resolve inside the selected physical access root"
                    : "ZCode skills.roots entry must resolve inside the selected physical access root",
                declaration.locatorKey,
            ),
        );
        return null;
    }
    const runtimePaths = input.platformContext.platform === "win32" ? path.win32 : path.posix;
    const globalDeclaration =
        declaration.origin !== "project_config" &&
        (declaration.value.startsWith("~/") || runtimePaths.isAbsolute(declaration.value));
    return {
        path: canonical,
        locatorKind: "runtime_declared_path",
        locatorKey: declaration.locatorKey,
        association: globalDeclaration ? "global" : "project",
    };
}

function defaultStorageRoot(input: ZcodeRuntimeConfigResolverInput): ResolvedZcodeConfigPath {
    return {
        path: joinHost(input.homeDir, ".zcode"),
        locatorKind: "runtime_known_rule",
        locatorKey: "zcode_default_storage_root",
        association: "global",
    };
}

function resolveProjectConfigDirectories(
    input: ZcodeRuntimeConfigResolverInput,
    project: ResolveZcodeProjectConfigInput,
    diagnostics: OperationDiagnostic[],
): string[] | null {
    const paths = hostPathApiFor(project.hostProjectPath);
    const canonicalProject = canonicalProviderHostPathWithinAccessRoot(project.hostProjectPath, input.platformContext);
    if (paths === null || canonicalProject === null) {
        diagnostics.push(
            configDiagnostic(
                "zcode_config_project_boundary_invalid",
                "ZCode project config discovery cannot establish the selected project boundary",
                project.hostProjectPath,
            ),
        );
        return null;
    }

    const traversed = [canonicalProject];
    let current = canonicalProject;
    for (;;) {
        const marker = inspectWorktreeMarker(paths.join(current, ".git"), diagnostics);
        if (marker === "found") return traversed.reverse();
        if (marker === "unknown") return null;
        const parent = paths.dirname(current);
        if (parent === current) return [canonicalProject];
        const boundedParent = canonicalProviderHostPathWithinAccessRoot(parent, input.platformContext);
        if (boundedParent === null) {
            diagnostics.push(
                configDiagnostic(
                    "zcode_config_project_ancestor_unobserved",
                    "ZCode may load project config above the selected physical access root; declared roots are withheld",
                    project.hostProjectPath,
                    "partial",
                ),
            );
            return null;
        }
        traversed.push(boundedParent);
        current = boundedParent;
    }
}

function inspectWorktreeMarker(markerPath: string, diagnostics: OperationDiagnostic[]): WorktreeMarkerInspection {
    try {
        const stat = lstatSync(markerPath);
        if (stat.isSymbolicLink()) {
            diagnostics.push(
                configDiagnostic(
                    "zcode_config_project_marker_symlink_untrusted",
                    "ZCode project config discovery does not follow a symlinked .git marker",
                    markerPath,
                    "partial",
                ),
            );
            return "unknown";
        }
        return stat.isFile() || stat.isDirectory() ? "found" : "absent";
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")) {
            return "absent";
        }
        diagnostics.push(
            configDiagnostic(
                failure.failureKind === "permission_denied"
                    ? "zcode_config_project_marker_permission_denied"
                    : "zcode_config_project_marker_unreadable",
                failure.failureKind === "permission_denied"
                    ? "ZCode project marker could not be inspected because access was denied"
                    : "ZCode project marker could not be inspected safely",
                markerPath,
                failure.failureKind === "permission_denied" ? "permission_denied" : "partial",
            ),
        );
        return "unknown";
    }
}

function readConfigPatch(configPath: string, diagnostics: OperationDiagnostic[]): ConfigReadResult {
    try {
        const bytes = readRegularFileBounded(configPath, MAX_CONFIG_BYTES);
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!isRecord(parsed)) return invalidConfig(configPath, "ZCode config must be a JSON object", diagnostics);
        const patch: ConfigPatch = {};
        if (parsed.storage !== undefined) {
            if (!isRecord(parsed.storage)) return invalidConfig(configPath, "storage must be a JSON object", diagnostics);
            if (parsed.storage.dir !== undefined) {
                if (typeof parsed.storage.dir !== "string" || parsed.storage.dir.trim() === "") {
                    return invalidConfig(configPath, "storage.dir must be a non-empty string", diagnostics);
                }
                patch.storageDir = parsed.storage.dir;
            }
        }
        if (parsed.skills !== undefined) {
            if (!isRecord(parsed.skills)) return invalidConfig(configPath, "skills must be a JSON object", diagnostics);
            if (parsed.skills.roots !== undefined) {
                if (!Array.isArray(parsed.skills.roots) || parsed.skills.roots.some((value) => typeof value !== "string")) {
                    return invalidConfig(configPath, "skills.roots must be an array of strings", diagnostics);
                }
                patch.skillsRoots = [...parsed.skills.roots];
            }
        }
        return { complete: true, patch };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (
            failure.failureKind === "not_found" ||
            (failure.failureKind === "wrong_entry_type" && failure.systemCode === "ENOTDIR")
        ) {
            return { complete: true, patch: {} };
        }
        diagnostics.push(
            configDiagnostic(
                failure.failureKind === "permission_denied" ? "zcode_config_permission_denied" : "zcode_config_invalid",
                failure.failureKind === "permission_denied"
                    ? "ZCode config could not be read because access was denied; the runtime fallback is used"
                    : "ZCode config is not a bounded UTF-8 JSON object; the runtime fallback is used",
                configPath,
                failure.failureKind === "permission_denied" ? "permission_denied" : "invalid_schema",
            ),
        );
        return { complete: false, patch: {} };
    }
}

function invalidConfig(configPath: string, message: string, diagnostics: OperationDiagnostic[]): ConfigReadResult {
    diagnostics.push(configDiagnostic("zcode_config_invalid", `${message}; the runtime ignores this config file`, configPath));
    return { complete: false, patch: {} };
}

function uniqueResolvedPaths(paths: ResolvedZcodeConfigPath[]): ResolvedZcodeConfigPath[] {
    const byIdentity = new Map<string, ResolvedZcodeConfigPath>();
    for (const item of paths) byIdentity.set(`${item.path}\0${item.association}`, item);
    return [...byIdentity.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function joinHost(base: string, ...segments: string[]): string {
    const paths = hostPathApiFor(base);
    if (paths === null) return path.join(base, ...segments);
    return paths.join(base, ...segments);
}

function joinPortableHost(base: string, portablePath: string): string {
    return joinHost(base, ...portablePath.split("/"));
}

function configDiagnostic(
    code: string,
    message: string,
    subject: string,
    causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
): OperationDiagnostic {
    return diagnostic(code, message, causeKind, "warning", subject);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
