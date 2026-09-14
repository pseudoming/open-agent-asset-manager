/** Bounded Codex probe-time config parsing and selected-context path materialization. */

import * as path from "node:path";
import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    runtimeAbsolutePathToHost,
} from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext, ResourceAccessStatus } from "@oaam/core";
import { decodeUtf8Strict, probeDiagnostic as diagnostic } from "@oaam/adapter-framework";
import { readRegularFileBounded, SafeFilesystemError } from "@oaam/shared/filesystem";
import { parse } from "smol-toml";
import { compareText, isSafeGuidanceFallbackFilename } from "./codex-source-read-foundation";

export const MAX_CODEX_PROBE_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_FALLBACK_FILENAMES = 64;
const MAX_PROJECT_ENTRIES = 1024;
const MAX_SKILL_CONFIG_ENTRIES = 1024;
const MAX_CONFIGURED_PATH_BYTES = 4096;
const STANDARD_FILENAMES = new Set(["AGENTS.override.md", "AGENTS.md"]);

export type CodexConfigSectionState = "known" | "partial" | "unknown";
export type CodexGuidanceFallbackSnapshot = { state: "known"; filenames: string[] } | { state: "unknown"; filenames: [] };

export interface CodexTrustedProjectConfigSnapshot {
    state: CodexConfigSectionState;
    runtimePaths: string[];
}

export interface CodexSkillConfigEntry {
    configuredPath: string;
    enabled: boolean;
}

export interface CodexSkillConfigSnapshot {
    state: CodexConfigSectionState;
    entries: CodexSkillConfigEntry[];
}

export interface CodexProbeConfigResult {
    guidance: CodexGuidanceFallbackSnapshot;
    trustedProjects: CodexTrustedProjectConfigSnapshot;
    skills: CodexSkillConfigSnapshot;
    diagnostics: OperationDiagnostic[];
}

export interface MaterializedCodexConfig {
    trustedProjects: {
        state: CodexConfigSectionState;
        entries: Array<{ runtimePath: string; hostPath: string }>;
    };
    skills: { state: CodexConfigSectionState; entries: Array<{ entryPath: string; enabled: boolean }> };
    uncheckedWslProjectReferences: Array<{ runtimePath: string; platformInstanceId: string }>;
    diagnostics: OperationDiagnostic[];
}

export function readCodexProbeConfig(
    configPath: string,
    accessStatus: ResourceAccessStatus,
    readFile: (filePath: string, maximumBytes: number) => Uint8Array = readRegularFileBounded,
): CodexProbeConfigResult {
    if (accessStatus === "not_found") return knownEmptyConfig();
    if (accessStatus !== "available") {
        return unavailableConfig(
            diagnostic(
                "codex_source_config_unavailable",
                "Codex source configuration could not be read during probe",
                accessStatus === "needs_permission" ? "permission_denied" : "partial",
                "warning",
                configPath,
            ),
        );
    }

    let parsed: Record<string, unknown>;
    try {
        const bytes = readFile(configPath, MAX_CODEX_PROBE_CONFIG_BYTES);
        const text = decodeUtf8Strict(bytes);
        if (text === null) return invalidConfig(configPath, "Codex config is not valid UTF-8");
        const value: unknown = parse(text);
        if (!isRecord(value)) return invalidConfig(configPath, "Codex config must be a TOML table");
        parsed = value;
    } catch (error) {
        const causeKind =
            error instanceof SafeFilesystemError && error.failureKind === "permission_denied"
                ? "permission_denied"
                : "invalid_schema";
        return unavailableConfig(
            diagnostic(
                "codex_source_config_invalid",
                "Codex config could not be read or parsed for source discovery",
                causeKind,
                "warning",
                configPath,
            ),
        );
    }

    const diagnostics: OperationDiagnostic[] = [];
    return {
        guidance: parseGuidanceConfig(parsed, configPath, diagnostics),
        trustedProjects: parseTrustedProjects(parsed, configPath, diagnostics),
        skills: parseSkillConfig(parsed, configPath, diagnostics),
        diagnostics,
    };
}

/** Compatibility helper retained for focused Guidance tests and callers. */
export function readCodexGuidanceConfig(configPath: string, accessStatus: ResourceAccessStatus) {
    const result = readCodexProbeConfig(configPath, accessStatus);
    return {
        snapshot: result.guidance,
        diagnostics: result.diagnostics.flatMap((item) => {
            if (item.code === "codex_source_config_unavailable") {
                return [{ ...item, code: "codex_guidance_config_unavailable" }];
            }
            if (item.code === "codex_source_config_invalid") {
                return [{ ...item, code: "codex_guidance_config_invalid" }];
            }
            return item.code.startsWith("codex_guidance_") ? [item] : [];
        }),
    };
}

export function materializeCodexConfig(
    config: CodexProbeConfigResult,
    platformContext: PlatformContext,
): MaterializedCodexConfig {
    const diagnostics: OperationDiagnostic[] = [];
    const trustedProjects: MaterializedCodexConfig["trustedProjects"]["entries"] = [];
    const uncheckedWslProjectReferences: MaterializedCodexConfig["uncheckedWslProjectReferences"] = [];
    let projectState = config.trustedProjects.state;
    for (const runtimePath of config.trustedProjects.runtimePaths) {
        const hostPath = materializeConfiguredPath(runtimePath, platformContext);
        if (hostPath === null) {
            const reference = platformContext.platform === "win32" ? classifyWslProjectReference(runtimePath) : null;
            if (reference !== null) {
                uncheckedWslProjectReferences.push({ runtimePath, platformInstanceId: reference.platformInstanceId });
                continue;
            }
            projectState = degradeState(projectState);
            diagnostics.push(
                diagnostic(
                    "codex_project_registry_path_unreachable",
                    "A trusted Codex project path is not canonical inside the selected access root",
                    "partial",
                    "warning",
                    runtimePath,
                ),
            );
            continue;
        }
        trustedProjects.push({ runtimePath, hostPath });
    }

    const skillEntries: MaterializedCodexConfig["skills"]["entries"] = [];
    const seenSkillPaths = new Set<string>();
    const duplicateSkillPaths = new Set<string>();
    let skillState = config.skills.state;
    for (const entry of config.skills.entries) {
        const configured = materializeConfiguredPath(entry.configuredPath, platformContext);
        if (configured === null) {
            skillState = degradeState(skillState);
            diagnostics.push(
                diagnostic(
                    "codex_skill_config_path_unreachable",
                    "A Codex Skill enablement path is not canonical inside the selected access root",
                    "partial",
                    "warning",
                    entry.configuredPath,
                ),
            );
            continue;
        }
        const paths = hostPathApiFor(configured);
        if (paths === null) {
            skillState = degradeState(skillState);
            diagnostics.push(skillPathDiagnostic(entry.configuredPath));
            continue;
        }
        const basename = paths.basename(configured);
        const isEntryFile = paths === path.win32 ? basename.toLowerCase() === "skill.md" : basename === "SKILL.md";
        const entryPath = isEntryFile ? configured : paths.join(configured, "SKILL.md");
        const boundedEntryPath = canonicalProviderHostPathWithinAccessRoot(entryPath, platformContext);
        if (boundedEntryPath === null) {
            skillState = degradeState(skillState);
            diagnostics.push(
                diagnostic(
                    "codex_skill_config_path_unreachable",
                    "A Codex Skill enablement entry resolves outside the selected access root",
                    "partial",
                    "warning",
                    entry.configuredPath,
                ),
            );
            continue;
        }
        const pathIdentity = hostPathIdentity(boundedEntryPath);
        if (duplicateSkillPaths.has(pathIdentity)) continue;
        if (seenSkillPaths.has(pathIdentity)) {
            skillState = degradeState(skillState);
            skillEntries.splice(
                skillEntries.findIndex((candidate) => hostPathIdentity(candidate.entryPath) === pathIdentity),
                1,
            );
            seenSkillPaths.delete(pathIdentity);
            duplicateSkillPaths.add(pathIdentity);
            diagnostics.push(
                diagnostic(
                    "codex_skill_config_duplicate_path",
                    "Multiple Codex Skill enablement entries resolve to the same source path",
                    "invalid_schema",
                    "warning",
                    boundedEntryPath,
                ),
            );
            continue;
        }
        seenSkillPaths.add(pathIdentity);
        skillEntries.push({ entryPath: boundedEntryPath, enabled: entry.enabled });
        if (!entry.enabled) {
            diagnostics.push(
                diagnostic(
                    "codex_skill_disabled_in_source_config",
                    "This Codex Skill is disabled in the observed source configuration; importing it does not enable it",
                    "partial",
                    "info",
                    boundedEntryPath,
                ),
            );
        }
    }

    const uniqueProjects = uniqueMaterializedProjects(trustedProjects);
    if (uniqueProjects.duplicatePaths.length > 0) {
        projectState = degradeState(projectState);
        for (const duplicatePath of uniqueProjects.duplicatePaths) {
            diagnostics.push(
                diagnostic(
                    "codex_project_registry_duplicate_path",
                    "Multiple Codex project registry entries resolve to the same selected-context path",
                    "invalid_schema",
                    "warning",
                    duplicatePath,
                ),
            );
        }
    }

    return {
        trustedProjects: {
            state: projectState,
            entries: uniqueProjects.entries,
        },
        skills: {
            state: skillState,
            entries: skillEntries.sort((left, right) => compareText(left.entryPath, right.entryPath)),
        },
        uncheckedWslProjectReferences: uniqueWslProjectReferences(uncheckedWslProjectReferences),
        diagnostics: [
            ...diagnostics,
            ...(projectState !== config.trustedProjects.state
                ? [
                      diagnostic(
                          "codex_project_registry_partial",
                          "Some configured Codex project anchors could not be materialized",
                          "partial",
                          "warning",
                      ),
                  ]
                : []),
        ],
    };
}

/** Pure classification only: this function never opens or resolves the referenced WSL path. */
export function classifyWslProjectReference(runtimePath: string): { readonly platformInstanceId: string } | null {
    const prefix = /^\\\\(?:\?\\unc\\)?(?:wsl\.localhost|wsl\$)\\/iu.exec(runtimePath);
    if (
        Buffer.byteLength(runtimePath, "utf8") > MAX_CONFIGURED_PATH_BYTES ||
        runtimePath.normalize("NFC") !== runtimePath ||
        path.win32.normalize(runtimePath) !== runtimePath ||
        prefix === null ||
        runtimePath.endsWith("\\")
    ) {
        return null;
    }
    const segments = runtimePath.slice(prefix[0].length).split("\\");
    if (segments.length < 2 || segments.some((segment) => !isSafeWindowsSegment(segment))) return null;
    return { platformInstanceId: segments[0] as string };
}

function uniqueWslProjectReferences(
    values: MaterializedCodexConfig["uncheckedWslProjectReferences"],
): MaterializedCodexConfig["uncheckedWslProjectReferences"] {
    const byEnvironment = new Map<string, MaterializedCodexConfig["uncheckedWslProjectReferences"][number]>();
    const ambiguous = new Set<string>();
    for (const value of values) {
        const key = value.platformInstanceId.toLowerCase();
        const existing = byEnvironment.get(key);
        if (existing !== undefined && existing.platformInstanceId !== value.platformInstanceId) {
            byEnvironment.delete(key);
            ambiguous.add(key);
        } else if (!ambiguous.has(key)) {
            byEnvironment.set(key, value);
        }
    }
    return [...byEnvironment.values()].sort((left, right) => compareText(left.platformInstanceId, right.platformInstanceId));
}

function isSafeWindowsSegment(value: string): boolean {
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

function parseGuidanceConfig(
    parsed: Record<string, unknown>,
    configPath: string,
    diagnostics: OperationDiagnostic[],
): CodexGuidanceFallbackSnapshot {
    const value = parsed.project_doc_fallback_filenames;
    if (value === undefined) return knownGuidanceSnapshot([]);
    if (!Array.isArray(value) || value.length > MAX_FALLBACK_FILENAMES) {
        diagnostics.push(
            diagnostic(
                "codex_guidance_config_invalid",
                `project_doc_fallback_filenames must be an array with at most ${MAX_FALLBACK_FILENAMES} entries`,
                "invalid_schema",
                "warning",
                configPath,
            ),
        );
        return unknownGuidanceSnapshot();
    }
    const filenames: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || !isSafeGuidanceFallbackFilename(item)) {
            diagnostics.push(
                diagnostic(
                    "codex_guidance_config_invalid",
                    "project_doc_fallback_filenames entries must be bounded plain filenames without path segments",
                    "invalid_schema",
                    "warning",
                    configPath,
                ),
            );
            return unknownGuidanceSnapshot();
        }
        if (!STANDARD_FILENAMES.has(item) && !filenames.includes(item)) filenames.push(item);
    }
    return knownGuidanceSnapshot(filenames);
}

function parseTrustedProjects(
    parsed: Record<string, unknown>,
    configPath: string,
    diagnostics: OperationDiagnostic[],
): CodexTrustedProjectConfigSnapshot {
    const value = parsed.projects;
    if (value === undefined) return { state: "known", runtimePaths: [] };
    if (!isRecord(value) || Object.keys(value).length > MAX_PROJECT_ENTRIES) {
        diagnostics.push(
            diagnostic(
                "codex_project_registry_invalid",
                `Codex projects must be a table with at most ${MAX_PROJECT_ENTRIES} entries`,
                "invalid_schema",
                "warning",
                configPath,
            ),
        );
        return { state: "unknown", runtimePaths: [] };
    }
    let state: CodexConfigSectionState = "known";
    const runtimePaths: string[] = [];
    for (const [runtimePath, project] of Object.entries(value)) {
        if (!isBoundedConfiguredPath(runtimePath) || !isRecord(project)) {
            state = "partial";
            diagnostics.push(projectConfigDiagnostic(configPath));
            continue;
        }
        const trustLevel = project.trust_level;
        if (trustLevel !== "trusted" && trustLevel !== "untrusted") {
            state = "partial";
            diagnostics.push(projectConfigDiagnostic(configPath));
            continue;
        }
        if (trustLevel === "trusted") runtimePaths.push(runtimePath);
    }
    return { state, runtimePaths: [...new Set(runtimePaths)].sort(compareText) };
}

function parseSkillConfig(
    parsed: Record<string, unknown>,
    configPath: string,
    diagnostics: OperationDiagnostic[],
): CodexSkillConfigSnapshot {
    const skills = parsed.skills;
    if (skills === undefined) return { state: "known", entries: [] };
    if (!isRecord(skills)) return invalidSkillConfig(configPath, diagnostics);
    const value = skills.config;
    if (value === undefined) return { state: "known", entries: [] };
    if (!Array.isArray(value) || value.length > MAX_SKILL_CONFIG_ENTRIES) {
        return invalidSkillConfig(configPath, diagnostics);
    }
    let state: CodexConfigSectionState = "known";
    const entries: CodexSkillConfigEntry[] = [];
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of value) {
        if (
            !isRecord(item) ||
            typeof item.path !== "string" ||
            !isBoundedConfiguredPath(item.path) ||
            typeof item.enabled !== "boolean"
        ) {
            state = "partial";
            diagnostics.push(skillConfigDiagnostic(configPath));
            continue;
        }
        if (duplicates.has(item.path)) continue;
        if (seen.has(item.path)) {
            state = "partial";
            seen.delete(item.path);
            duplicates.add(item.path);
            entries.splice(
                entries.findIndex((entry) => entry.configuredPath === item.path),
                1,
            );
            diagnostics.push(skillConfigDiagnostic(configPath));
            continue;
        }
        seen.add(item.path);
        entries.push({ configuredPath: item.path, enabled: item.enabled });
    }
    return { state, entries };
}

function materializeConfiguredPath(runtimePath: string, context: PlatformContext): string | null {
    if (canonicalHostPath(runtimePath) !== runtimePath.normalize("NFC")) return null;
    const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, runtimePath);
    return mapped === null ? null : canonicalProviderHostPathWithinAccessRoot(mapped, context);
}

function invalidConfig(path: string, message: string): CodexProbeConfigResult {
    return unavailableConfig(diagnostic("codex_source_config_invalid", message, "invalid_schema", "warning", path));
}

function unavailableConfig(item: OperationDiagnostic): CodexProbeConfigResult {
    return {
        guidance: unknownGuidanceSnapshot(),
        trustedProjects: { state: "unknown", runtimePaths: [] },
        skills: { state: "unknown", entries: [] },
        diagnostics: [item],
    };
}

function knownEmptyConfig(): CodexProbeConfigResult {
    return {
        guidance: knownGuidanceSnapshot([]),
        trustedProjects: { state: "known", runtimePaths: [] },
        skills: { state: "known", entries: [] },
        diagnostics: [],
    };
}

function knownGuidanceSnapshot(filenames: string[]): CodexGuidanceFallbackSnapshot {
    return { state: "known", filenames: [...new Set(filenames)] };
}

function unknownGuidanceSnapshot(): CodexGuidanceFallbackSnapshot {
    return { state: "unknown", filenames: [] };
}

function invalidSkillConfig(configPath: string, diagnostics: OperationDiagnostic[]): CodexSkillConfigSnapshot {
    diagnostics.push(skillConfigDiagnostic(configPath));
    return { state: "unknown", entries: [] };
}

function projectConfigDiagnostic(configPath: string): OperationDiagnostic {
    return diagnostic(
        "codex_project_registry_entry_invalid",
        "A Codex project entry must have a bounded path and trusted or untrusted trust_level",
        "invalid_schema",
        "warning",
        configPath,
    );
}

function skillConfigDiagnostic(configPath: string): OperationDiagnostic {
    return diagnostic(
        "codex_skill_config_invalid",
        "Each Codex Skill config entry must have one bounded path and a boolean enabled value",
        "invalid_schema",
        "warning",
        configPath,
    );
}

function skillPathDiagnostic(configuredPath: string): OperationDiagnostic {
    return diagnostic(
        "codex_skill_config_path_unreachable",
        "A Codex Skill enablement path could not be interpreted in the selected host path environment",
        "partial",
        "warning",
        configuredPath,
    );
}

function isBoundedConfiguredPath(value: string): boolean {
    return value !== "" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_CONFIGURED_PATH_BYTES;
}

function degradeState(state: CodexConfigSectionState): CodexConfigSectionState {
    return state === "unknown" ? "unknown" : "partial";
}

function uniqueMaterializedProjects(values: MaterializedCodexConfig["trustedProjects"]["entries"]): {
    entries: MaterializedCodexConfig["trustedProjects"]["entries"];
    duplicatePaths: string[];
} {
    const unique = new Map<string, MaterializedCodexConfig["trustedProjects"]["entries"][number]>();
    const duplicates = new Map<string, string>();
    for (const entry of values) {
        const identity = hostPathIdentity(entry.hostPath);
        if (duplicates.has(identity)) continue;
        if (unique.has(identity)) {
            unique.delete(identity);
            duplicates.set(identity, entry.hostPath);
            continue;
        }
        unique.set(identity, entry);
    }
    return {
        entries: [...unique.values()].sort((left, right) => compareText(left.hostPath, right.hostPath)),
        duplicatePaths: [...duplicates.values()].sort(compareText),
    };
}

function hostPathIdentity(value: string): string {
    return hostPathApiFor(value) === path.win32 ? value.toLowerCase() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
