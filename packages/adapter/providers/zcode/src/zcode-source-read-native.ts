/** Immutable native-dialect revalidation for ZCode source bytes. */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AssetKindTypeDataV2,
    NativeDialectValidationInputV1,
    ReadEntryHandle,
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
import { decodeUtf8, isCanonicalNativeRelativePath, isWithin, skillFolderForEntry } from "./zcode-source-read-foundation";
import {
    ZCODE_NATIVE_DIALECTS,
    type ZcodeFileRecord,
    type ZcodeScanResult,
    type ZcodeSourceContext,
    type ZcodeSourceLayout,
} from "./zcode-source-read-model";
import { getZcodeAssetReader } from "./zcode-source-read-registry";

interface NativeDialectSpec {
    kind: "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory";
    dialectId: string;
}

export function validateZcodeNativeDialect(input: NativeDialectValidationInputV1): boolean {
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
    const files = hydrateValidatedNativeSourceFiles<ZcodeFileRecord>(input, (file) => ({
        handle: syntheticHandle(file.relativePath, "file"),
        observedReadEntryId: `native:${file.relativePath}`,
        relativePath: file.relativePath,
        bytes: file.bytes,
        executable: file.executable,
        text: file.contentKind === "text" ? decodeUtf8(file.bytes) : null,
    }));
    if (files === null) return false;
    const context = nativeValidationContext(
        spec,
        files.map((file) => file.relativePath),
    );
    if (context === null) return false;
    const scan = nativeValidationScan(
        spec.kind,
        context,
        files,
        input.representation.schemaVersion === 2 ? input.representation.directories : undefined,
    );
    const reader = getZcodeAssetReader(spec.kind);
    if (reader.disposition !== "reader") return false;
    const built = reader.buildCandidates(context, scan);
    if (built.candidates.length !== 1) return false;
    const candidate = built.candidates[0];
    const expectedRepresentationSource = spec.kind === "Skill" ? "separate_file_graph" : "separate_files";
    return (
        candidate !== undefined &&
        candidate.status === "complete" &&
        candidate.nativeRepresentation.representationSource === expectedRepresentationSource &&
        candidate.nativeRepresentation.dialectId === spec.dialectId &&
        (candidate.nativeRepresentation.representationSource !== "separate_file_graph" ||
            input.representation.schemaVersion === 1 ||
            (input.representation.schemaVersion === 2 &&
                stableSourceValueEqual(
                    candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                    input.representation.directories,
                ))) &&
        canonicalTypeDataMatches(candidate, input) &&
        stableSourceValueEqual(
            projectCandidateVersionFiles(candidate.files, NATIVE_FILE_PROJECTION_POLICY),
            projectPersistedVersionFiles(input.canonicalFiles, NATIVE_FILE_PROJECTION_POLICY),
        ) &&
        stableSourceValueEqual(
            comparableCandidateNativeFiles(candidate.nativeRepresentation.files, canonicalMediaType),
            comparablePersistedNativeFiles(input, canonicalMediaType),
        )
    );
}

function canonicalTypeDataMatches(candidate: AdapterExtractedAssetCandidate, input: NativeDialectValidationInputV1): boolean {
    const parsed = structuredClone({ kind: candidate.kind, typeData: candidate.typeData }) as AssetKindTypeDataV2;
    const expected = structuredClone(input.canonical);
    if (
        candidate.kind === "Memory" &&
        candidate.typeData.entityRole === "catalog" &&
        expected.kind === "Memory" &&
        expected.typeData.entityRole === "catalog" &&
        parsed.kind === "Memory" &&
        parsed.typeData.entityRole === "catalog"
    ) {
        const observedMembers = candidate.memoryCatalogMemberBindingInputs;
        if (observedMembers === undefined || observedMembers.length !== expected.typeData.members.length) return false;
        const reboundMembers = [];
        for (const [index, member] of observedMembers.entries()) {
            const expectedMember = expected.typeData.members[index];
            if (expectedMember === undefined) return false;
            reboundMembers.push({
                targetAssetVersionId: expectedMember.targetAssetVersionId,
                routingTitle: member.routingTitle,
                routingHint: member.routingHint,
            });
        }
        parsed.typeData.members = reboundMembers;
    }
    return stableSourceValueEqual(parsed, expected);
}

function nativeDialectSpec(dialectId: string): NativeDialectSpec | null {
    if (dialectId === ZCODE_NATIVE_DIALECTS.guidance) return { kind: "Guidance", dialectId };
    if (dialectId === ZCODE_NATIVE_DIALECTS.commandWorkflow) return { kind: "Workflow", dialectId };
    if (dialectId === ZCODE_NATIVE_DIALECTS.scriptWorkflow) return { kind: "Workflow", dialectId };
    if (dialectId === ZCODE_NATIVE_DIALECTS.skill) return { kind: "Skill", dialectId };
    if (dialectId === ZCODE_NATIVE_DIALECTS.subagent) return { kind: "Subagent", dialectId };
    if (dialectId === ZCODE_NATIVE_DIALECTS.memoryCatalog) return { kind: "Memory", dialectId };
    if (dialectId === ZCODE_NATIVE_DIALECTS.memoryTopic) return { kind: "Memory", dialectId };
    return null;
}

function matchesNativeGraph(spec: NativeDialectSpec, paths: string[]): boolean {
    if (paths.length === 0 || paths.some((path) => !isCanonicalNativeRelativePath(path))) return false;
    if (spec.kind === "Guidance") return paths.length === 1 && paths[0] === "AGENTS.md";
    if (spec.dialectId === ZCODE_NATIVE_DIALECTS.commandWorkflow) {
        return paths.length === 1 && commandPathLayout(paths[0] ?? "") !== null;
    }
    if (spec.dialectId === ZCODE_NATIVE_DIALECTS.scriptWorkflow) {
        return paths.length === 1 && scriptWorkflowPathLayout(paths[0] ?? "") !== null;
    }
    if (spec.kind === "Subagent") return paths.length === 1 && subagentPathLayout(paths[0] ?? "") !== null;
    if (spec.dialectId === ZCODE_NATIVE_DIALECTS.memoryCatalog) return paths.length === 1 && paths[0] === "MEMORY.md";
    if (spec.dialectId === ZCODE_NATIVE_DIALECTS.memoryTopic) {
        const segments = (paths[0] ?? "").split("/");
        return paths.length === 1 && segments.length === 2 && segments[0] === "topics" && (segments[1] ?? "").endsWith(".md");
    }
    const base = nativeSkillBase(paths);
    if (base === null) return false;
    const entries = paths.filter((path) => skillFolderForEntry(path, base) !== null);
    if (entries.length !== 1) return false;
    const folder = skillFolderForEntry(entries[0] ?? "", base);
    return folder !== null && paths.every((path) => isWithin(path, folder));
}

function nativeSkillBase(paths: string[]): string | null {
    const usesZcodeProject = paths.some((path) => path.startsWith(".zcode/skills/"));
    const usesAgentsProject = paths.some((path) => path.startsWith(".agents/skills/"));
    const usesConfig = paths.some((path) => path.startsWith("skills/"));
    const layouts = Number(usesZcodeProject) + Number(usesAgentsProject) + Number(usesConfig);
    if (layouts > 1) return null;
    if (usesZcodeProject) return ".zcode/skills";
    if (usesAgentsProject) return ".agents/skills";
    if (usesConfig) return "skills";
    return "";
}

function nativeValidationScan(
    kind: NativeDialectSpec["kind"],
    context: ZcodeSourceContext,
    files: ZcodeFileRecord[],
    explicitDirectories?: readonly string[],
): ZcodeScanResult {
    const capability: AdapterAssetSourceCapability = {
        sourceCapabilityFingerprint: zeroSha256Digest(),
        agentRuntimeId: "ZCODE_APP",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: context.root.rootRole,
        sourceDomain: context.root.sourceDomain,
        assetKind: kind,
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: "source_code",
        readPolicy: "auto_read",
        diagnostics: [],
    };
    const buildDirectory = (relativePath: string): ZcodeScanResult["directories"][number] => ({
        handle: syntheticHandle(relativePath, "directory"),
        observedReadEntryId: `native:${relativePath}`,
        relativePath,
    });
    const directories =
        explicitDirectories === undefined
            ? buildNativeAncestorDirectories<ZcodeScanResult["directories"][number]>(
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
        unreadableDirectoryPaths: [],
        hadIgnoredSource: false,
        attachCandidate() {},
        ignoreRecord() {},
        ignoreHandle() {},
        readReferencedFile: unavailableReferencedSourceFileRead,
    };
}

function nativeValidationContext(spec: NativeDialectSpec, paths: string[]): ZcodeSourceContext | null {
    let layout: ZcodeSourceLayout;
    if (spec.kind === "Guidance") {
        layout = "project";
    } else if (spec.kind === "Memory") {
        layout = "memory";
    } else if (spec.dialectId === ZCODE_NATIVE_DIALECTS.commandWorkflow) {
        const resolved = commandPathLayout(paths[0] ?? "");
        if (resolved === null) return null;
        layout = resolved;
    } else if (spec.dialectId === ZCODE_NATIVE_DIALECTS.scriptWorkflow) {
        const resolved = scriptWorkflowPathLayout(paths[0] ?? "");
        if (resolved === null) return null;
        layout = resolved;
    } else if (spec.kind === "Subagent") {
        const resolved = subagentPathLayout(paths[0] ?? "");
        if (resolved === null) return null;
        layout = resolved;
    } else {
        const base = nativeSkillBase(paths);
        if (base === null) return null;
        layout = base === "skills" ? "config" : base === "" ? "skill_root" : "project";
    }
    return {
        root: {
            sourceRootId: "native-root",
            rootRole: layout === "project" ? "project_actual" : layout === "config" ? "config" : "source",
            sourceDomain:
                layout === "memory"
                    ? "project_keyed"
                    : layout === "project"
                      ? "project_root"
                      : layout === "config"
                        ? "agent_runtime_private"
                        : layout === "command_root" || layout === "skill_root"
                          ? "family_shared"
                          : "external_managed",
            path: "/native",
            accessStatus: "available",
            locatorEvidence: [
                { locatorKind: "runtime_known_rule", locatorKey: "native_validation", evidenceLevel: "source_code" },
            ],
            diagnostics: [],
        },
        scope: layout === "project" || layout === "memory" ? "project" : "global",
        projectRootPath: layout === "project" || layout === "memory" ? "/native" : "",
        layout,
    };
}

function commandPathLayout(path: string): ZcodeSourceLayout | null {
    if (!path.toLowerCase().endsWith(".md")) return null;
    if (path.startsWith("commands/")) return "config";
    if (path.startsWith(".zcode/commands/") || path.startsWith(".agents/commands/")) return "project";
    return "command_root";
}

function scriptWorkflowPathLayout(path: string): ZcodeSourceLayout | null {
    if (!path.toLowerCase().endsWith(".workflow.js")) return null;
    if (path.startsWith("workflows/")) return "config";
    if (path.startsWith(".zcode/workflows/")) return "project";
    return "external";
}

function subagentPathLayout(path: string): ZcodeSourceLayout | null {
    const lower = path.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) return null;
    if (path.startsWith("agents/")) return "config";
    if (path.startsWith(".zcode/agents/")) return "project";
    return "external";
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
