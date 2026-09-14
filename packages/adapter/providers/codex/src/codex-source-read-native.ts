/** Codex native graph validators, including append-only historical projections. */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    NativeDialectValidationInputV1,
    ReadEntryHandle,
    VersionFileInput,
} from "@oaam/core";
import {
    buildNativeAncestorDirectories,
    comparableCandidateNativeFiles,
    comparablePersistedNativeFiles,
    hydrateValidatedNativeSourceFiles,
    projectCandidateVersionFiles,
    projectPersistedVersionFiles,
    stableSourceValueEqual,
    unavailableReferencedSourceFileRead,
    zeroSha256Digest,
} from "@oaam/adapter-framework";
import type { NativeVersionFileProjectionPolicy } from "@oaam/adapter-framework";
import {
    basename,
    codexSkillFolderForEntry,
    decodeUtf8,
    isCanonicalNativeRelativePath,
    isSafeGuidanceFallbackFilename,
    isWithin,
} from "./codex-source-read-foundation";
import {
    CODEX_NATIVE_DIALECTS,
    type CodexFileRecord,
    type CodexScanResult,
    type CodexSourceContext,
    type CodexSourceLayout,
} from "./codex-source-read-model";
import { getCodexAssetReader } from "./codex-source-read-registry";

interface NativeDialectSpec {
    kind: "Guidance" | "Skill" | "Subagent" | "Workflow" | "Memory";
    dialectId: string;
    readerDialectId: string;
    canonicalProjection: "current" | "legacy_subagent_v1";
}

export function validateCodexNativeDialect(input: NativeDialectValidationInputV1): boolean {
    const spec = nativeDialectSpec(input.representation.dialectId);
    if (
        spec === null ||
        (input.representation.schemaVersion !== 1 && input.representation.schemaVersion !== 2) ||
        (input.representation.schemaVersion === 2 && spec.kind !== "Skill") ||
        input.canonical.kind !== spec.kind ||
        !matchesNativeGraph(
            spec,
            input.representation.files.map((file) => file.relativePath),
        )
    ) {
        return false;
    }
    const files = hydrateValidatedNativeSourceFiles<CodexFileRecord>(input, (file) => ({
        handle: syntheticHandle(file.relativePath, "file"),
        observedReadEntryId: `native:${file.relativePath}`,
        relativePath: file.relativePath,
        bytes: file.bytes,
        executable: file.executable,
        text: file.contentKind === "text" ? decodeUtf8(file.bytes) : null,
    }));
    if (files === null) return false;
    const scan = nativeValidationScan(
        spec.kind,
        files,
        input.representation.schemaVersion === 2 ? input.representation.directories : undefined,
    );
    const context = nativeValidationContext(
        spec,
        files.map((file) => file.relativePath),
    );
    if (context === null) return false;
    const reader = getCodexAssetReader(spec.kind);
    if (reader.disposition !== "reader") return false;
    const built = reader.buildCandidates(context, scan);
    if (built.candidates.length !== 1) return false;
    const candidate = built.candidates[0];
    return (
        candidate !== undefined &&
        candidate.status === "complete" &&
        candidate.nativeRepresentation.representationSource !== "canonical_files" &&
        candidate.nativeRepresentation.dialectId === spec.readerDialectId &&
        (input.representation.schemaVersion === 1 ||
            (candidate.nativeRepresentation.representationSource === "separate_file_graph" &&
                stableSourceValueEqual(
                    candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                    input.representation.directories,
                ))) &&
        stableSourceValueEqual({ kind: candidate.kind, typeData: candidate.typeData }, input.canonical) &&
        stableSourceValueEqual(
            projectCandidateFiles(spec, candidate),
            projectPersistedVersionFiles(input.canonicalFiles, NATIVE_FILE_PROJECTION_POLICY),
        ) &&
        stableSourceValueEqual(
            comparableCandidateNativeFiles(candidate.nativeRepresentation.files, canonicalMediaType),
            comparablePersistedNativeFiles(input, canonicalMediaType),
        )
    );
}

function nativeDialectSpec(dialectId: string): NativeDialectSpec | null {
    if (dialectId === CODEX_NATIVE_DIALECTS.guidance) return currentSpec("Guidance", dialectId);
    if (dialectId === CODEX_NATIVE_DIALECTS.skill) return currentSpec("Skill", dialectId);
    if (dialectId === CODEX_NATIVE_DIALECTS.subagentLegacy) {
        return {
            kind: "Subagent",
            dialectId,
            readerDialectId: CODEX_NATIVE_DIALECTS.subagent,
            canonicalProjection: "legacy_subagent_v1",
        };
    }
    if (dialectId === CODEX_NATIVE_DIALECTS.subagent) return currentSpec("Subagent", dialectId);
    if (dialectId === CODEX_NATIVE_DIALECTS.workflow) return currentSpec("Workflow", dialectId);
    if (dialectId === CODEX_NATIVE_DIALECTS.memory) return currentSpec("Memory", dialectId);
    return null;
}

function currentSpec(kind: NativeDialectSpec["kind"], dialectId: string): NativeDialectSpec {
    return { kind, dialectId, readerDialectId: dialectId, canonicalProjection: "current" };
}

function projectCandidateFiles(
    spec: NativeDialectSpec,
    candidate: AdapterExtractedAssetCandidate,
): ReturnType<typeof projectCandidateVersionFiles> | null {
    if (spec.canonicalProjection === "current") {
        return projectCandidateVersionFiles(candidate.files, NATIVE_FILE_PROJECTION_POLICY);
    }
    const legacyFiles = legacySubagentCanonicalFiles(candidate);
    return legacyFiles === null ? null : projectCandidateVersionFiles(legacyFiles, NATIVE_FILE_PROJECTION_POLICY);
}

function legacySubagentCanonicalFiles(candidate: AdapterExtractedAssetCandidate): VersionFileInput[] | null {
    if (candidate.kind !== "Subagent" || candidate.files.length !== 1) return null;
    const file = candidate.files[0];
    if (file?.contentKind !== "text" || file.logicalPath !== "instructions.json") return null;
    let value: unknown;
    try {
        value = JSON.parse(file.text);
    } catch {
        return null;
    }
    if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "sections"]) || value.schemaVersion !== 1) return null;
    if (!Array.isArray(value.sections) || value.sections.length !== 1) return null;
    const section = value.sections[0];
    if (
        !isRecord(section) ||
        !hasExactKeys(section, ["content", "title"]) ||
        section.title !== "" ||
        typeof section.content !== "string"
    ) {
        return null;
    }
    return [
        {
            ...file,
            text: JSON.stringify({
                schemaVersion: 1,
                sections: [{ title: "Developer instructions", content: section.content }],
            }),
        },
    ];
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesNativeGraph(spec: NativeDialectSpec, paths: string[]): boolean {
    if (paths.length === 0 || paths.some((path) => !isCanonicalNativeRelativePath(path))) return false;
    if (spec.kind === "Guidance") {
        return paths.length === 1 && isGuidanceFilename(basename(paths[0] ?? ""));
    }
    if (spec.kind === "Subagent") {
        return paths.length === 1 && isSubagentNativePath(paths[0] ?? "");
    }
    if (spec.kind === "Workflow") {
        return paths.length === 1 && isWorkflowNativePath(paths[0] ?? "");
    }
    if (spec.kind === "Memory") {
        return paths.length === 2 && paths[0] === "memories/MEMORY.md" && paths[1] === "memories/memory_summary.md";
    }
    const layout: Extract<CodexSourceLayout, "project" | "skill_root"> = paths.some(
        (path) => path.startsWith(".agents/") || path.startsWith(".codex/"),
    )
        ? "project"
        : "skill_root";
    const entries = paths.filter((path) => codexSkillFolderForEntry(path, layout) !== null);
    if (entries.length !== 1) return false;
    const folder = codexSkillFolderForEntry(entries[0] ?? "", layout);
    return folder !== null && paths.every((path) => isWithin(path, folder));
}

function nativeValidationScan(
    kind: NativeDialectSpec["kind"],
    files: CodexFileRecord[],
    explicitDirectories?: readonly string[],
): CodexScanResult {
    const capability: AdapterAssetSourceCapability = {
        sourceCapabilityFingerprint: zeroSha256Digest(),
        agentRuntimeId: "CODEX_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: kind === "Guidance" ? "project_actual" : kind === "Skill" ? "source" : "config",
        sourceDomain: kind === "Guidance" ? "project_root" : "family_shared",
        assetKind: kind,
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: "source_code",
        readPolicy: "auto_read",
        diagnostics: [],
    };
    const buildDirectory = (relativePath: string): CodexScanResult["directories"][number] => ({
        handle: syntheticHandle(relativePath, "directory"),
        observedReadEntryId: `native:${relativePath}`,
        relativePath,
    });
    const directories =
        explicitDirectories === undefined
            ? buildNativeAncestorDirectories(
                  files.map((file) => file.relativePath),
                  buildDirectory,
              )
            : explicitDirectories.map(buildDirectory);
    return {
        obligation: {
            sourceReadObligationId: "native-obligation",
            sourceRootId: "native-root",
            sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
        },
        capability,
        files,
        directories,
        dispositions: [],
        observedReadEntryIds: [...files, ...directories].map((record) => record.observedReadEntryId),
        diagnostics: [],
        unreadableRelativePaths: [],
        hadIgnoredSource: false,
        attachCandidate() {},
        ignoreRecord() {},
        ignoreHandle() {},
        readReferencedFile: unavailableReferencedSourceFileRead,
    };
}

function nativeValidationContext(spec: NativeDialectSpec, paths: string[]): CodexSourceContext | null {
    let layout: CodexSourceLayout;
    let fallbackFilenames: string[] = [];
    if (spec.kind === "Guidance") {
        layout = "project";
        const filename = basename(paths[0] ?? "");
        fallbackFilenames = filename === "AGENTS.override.md" || filename === "AGENTS.md" ? [] : [filename];
    } else if (spec.kind === "Skill") {
        layout = paths.some((path) => path.startsWith(".agents/") || path.startsWith(".codex/")) ? "project" : "skill_root";
    } else if (spec.kind === "Subagent") {
        layout = paths.some((path) => path.startsWith(".codex/")) ? "project" : "config";
    } else if (spec.kind === "Memory") {
        layout = "memory";
    } else {
        layout = "config";
    }
    return {
        root: {
            sourceRootId: "native-root",
            rootRole: layout === "project" ? "project_actual" : spec.kind === "Skill" ? "source" : "config",
            sourceDomain: layout === "project" ? "project_root" : "family_shared",
            path: "/native",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "native_validation",
                    evidenceLevel: "source_code",
                },
            ],
            diagnostics: [],
        },
        scope: layout === "project" ? "project" : "global",
        projectRootPath: layout === "project" ? "/native" : "",
        layout,
        fallbackConfigurationKnown: true,
        fallbackFilenames,
    };
}

function isSubagentNativePath(path: string): boolean {
    const segments = path.split("/");
    if (!path.endsWith(".toml")) return false;
    return (
        (segments.length === 2 && segments[0] === "agents") ||
        (segments.length === 3 && segments[0] === ".codex" && segments[1] === "agents")
    );
}

function isWorkflowNativePath(path: string): boolean {
    const segments = path.split("/");
    return segments.length === 2 && segments[0] === "prompts" && path.endsWith(".md");
}

function syntheticHandle(relativePath: string, entryKind: ReadEntryHandle["entryKind"]): ReadEntryHandle {
    return {
        readEntryHandleId: `native:${entryKind}:${relativePath}`,
        sourceReadObligationId: "native-obligation",
        sourceRootId: "native-root",
        relativePath,
        entryKind,
    };
}

function isGuidanceFilename(filename: string): boolean {
    return filename === "AGENTS.override.md" || filename === "AGENTS.md" || isSafeGuidanceFallbackFilename(filename);
}

function normalizeText(text: string): string {
    const withoutBom = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
    return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function canonicalMediaType(input: string): string {
    const trimmed = input.trim().toLowerCase();
    if (trimmed === "") return "application/octet-stream";
    const separator = trimmed.indexOf(";");
    const base = separator < 0 ? trimmed : trimmed.slice(0, separator).trim();
    return base === "" ? "application/octet-stream" : base;
}

const NATIVE_FILE_PROJECTION_POLICY: NativeVersionFileProjectionPolicy = {
    normalizeMediaType: canonicalMediaType,
    projectCandidateText: normalizeText,
    projectPersistedText: (text) => text,
    normalizeBinary: (bytes) => Buffer.from(bytes).toString("base64"),
    projectReferences: (references) => references,
};
