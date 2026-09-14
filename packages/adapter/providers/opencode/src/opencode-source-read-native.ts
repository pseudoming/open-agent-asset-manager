/** OpenCode native-dialect restoration validator. */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AssetKind,
    FileReferenceV2,
    NativeDialectValidationInputV1,
    ReadEntryHandle,
    RenderNativeRepresentationFileInput,
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
import { parseOpencodeFrontmatter } from "./opencode-frontmatter";
import {
    basenamePath,
    decodeUtf8,
    isCanonicalNativeRelativePath,
    isWithin,
    parentPath,
    parseOpenCodeAtReferenceTokens,
} from "./opencode-source-read-foundation";
import {
    OPENCODE_NATIVE_DIALECTS,
    type DirectoryRecord,
    type FileRecord,
    type ScanResult,
    type SourceContext,
    type SourceLayout,
    type WorkflowReferenceClassification,
} from "./opencode-source-read-model";
import { getOpencodeAssetReader } from "./opencode-source-read-registry";
import { buildSkillCandidates } from "./opencode-source-read-skill";
import { OPENCODE_RULE_FRAGMENT_LOGICAL_PATH, opencodeRuleGraph } from "./opencode-rule-config";

export function validateOpencodeNativeDialect(input: NativeDialectValidationInputV1): boolean {
    if (input.representation.dialectId === OPENCODE_NATIVE_DIALECTS.instructionsRule) {
        return validateInstructionRuleNative(input);
    }
    const spec = nativeDialectSpec(input.representation.dialectId);
    if (
        spec === null ||
        input.canonical.kind !== spec.kind ||
        (input.representation.schemaVersion !== 1 && input.representation.schemaVersion !== 2) ||
        (input.representation.schemaVersion === 2 && spec.kind !== "Skill")
    )
        return false;
    if (
        !matchesNativeFileGraph(
            spec,
            input.representation.files.map((file) => file.relativePath),
        )
    ) {
        return false;
    }
    const scan = nativeValidationScan(input, spec);
    if (scan === null) return false;
    const context = nativeValidationContext(spec, scan.files);
    const built = getOpencodeAssetReader(spec.kind);
    if (built.disposition !== "reader") return false;
    const parsed =
        spec.kind === "Skill"
            ? buildSkillCandidates(context, scan, spec.dialectId === OPENCODE_NATIVE_DIALECTS.skillCli ? 2 : 1)
            : built.buildCandidates(context, scan);
    if (parsed.candidates.length !== 1) return false;
    const candidate = parsed.candidates[0];
    return (
        candidate !== undefined &&
        candidate.status === "complete" &&
        candidate.nativeRepresentation.representationSource !== "canonical_files" &&
        candidate.nativeRepresentation.dialectId === spec.dialectId &&
        (input.representation.schemaVersion === 1 ||
            (candidate.nativeRepresentation.representationSource === "separate_file_graph" &&
                stableSourceValueEqual(
                    candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                    input.representation.directories,
                ))) &&
        nativeCanonicalMatches(candidate, input.canonical) &&
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

function validateInstructionRuleNative(input: NativeDialectValidationInputV1): boolean {
    if (
        input.canonical.kind !== "Rule" ||
        input.representation.schemaVersion !== 1 ||
        input.canonical.typeData.schemaVersion !== 2 ||
        input.canonical.typeData.activation.mode !== "always" ||
        input.canonical.typeData.name.trim() === ""
    ) {
        return false;
    }
    const sourceFiles = hydrateValidatedNativeSourceFiles<FileRecord>(input, (file) => ({
        handle: syntheticHandle(file.relativePath, "file"),
        observedReadEntryId: `native:${file.relativePath}`,
        relativePath: file.relativePath,
        bytes: file.bytes,
        executable: file.executable,
        text: file.contentKind === "text" ? decodeUtf8(file.bytes) : null,
    }));
    if (
        sourceFiles === null ||
        sourceFiles.some(
            (file) => file.text === null && file.relativePath !== "opencode.json" && file.relativePath !== "opencode.jsonc",
        )
    ) {
        return false;
    }
    const renderFiles = sourceFiles.map(
        (file): RenderNativeRepresentationFileInput =>
            file.text === null
                ? {
                      relativePath: file.relativePath,
                      contentKind: "binary",
                      mediaType: "application/jsonc",
                      executable: file.executable,
                      contentHash: zeroSha256Digest(),
                      byteSize: file.bytes.byteLength,
                      bytes: new Uint8Array(file.bytes),
                  }
                : {
                      relativePath: file.relativePath,
                      contentKind: "text",
                      mediaType: "text/markdown",
                      executable: file.executable,
                      contentHash: zeroSha256Digest(),
                      byteSize: file.bytes.byteLength,
                      text: file.text,
                  },
    );
    const projection = opencodeRuleGraph(renderFiles);
    if (projection === null || projection.files.length !== input.canonicalFiles.length) return false;
    const nativeByPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
    const canonicalByPath = new Map(input.canonicalFiles.map((file) => [file.file.logicalPath, file]));
    if (nativeByPath.size !== sourceFiles.length || canonicalByPath.size !== input.canonicalFiles.length) return false;
    for (const item of projection.files) {
        const native = nativeByPath.get(item.nativeRelativePath);
        const canonical = canonicalByPath.get(item.canonicalLogicalPath);
        if (native === undefined || canonical === undefined) return false;
        if (item.canonicalLogicalPath === OPENCODE_RULE_FRAGMENT_LOGICAL_PATH) {
            if (
                canonical.contentKind !== "binary" ||
                canonical.file.role !== "resource" ||
                canonical.file.executable ||
                native.executable ||
                !Buffer.from(canonical.bytes).equals(Buffer.from(native.bytes))
            ) {
                return false;
            }
            continue;
        }
        if (
            canonical.contentKind !== "text" ||
            native.text === null ||
            canonical.file.executable !== native.executable ||
            canonical.file.role !== (item.canonicalLogicalPath === "RULE.md" ? "entry" : "resource") ||
            normalizeText(canonical.text) !== normalizeText(native.text)
        ) {
            return false;
        }
    }
    return true;
}

function matchesNativeFileGraph(spec: NativeDialectSpec, paths: string[]): boolean {
    if (paths.length === 0 || paths.some((path) => !isCanonicalNativeRelativePath(path))) return false;
    if (spec.kind === "Guidance") {
        return paths.length === 1 && (paths[0] === "AGENTS.md" || paths[0] === "CLAUDE.md" || paths[0] === "CONTEXT.md");
    }
    if (spec.kind === "Workflow") {
        return (
            paths.length === 1 &&
            matchesDeclarationPath(paths[0] ?? "", ["command/", "commands/", ".opencode/command/", ".opencode/commands/"])
        );
    }
    if (spec.kind === "Subagent") {
        return (
            paths.length === 1 &&
            matchesDeclarationPath(paths[0] ?? "", ["agent/", "agents/", ".opencode/agent/", ".opencode/agents/"])
        );
    }
    const entries = paths.filter((path) => basenamePath(path) === "SKILL.md");
    if (entries.length !== 1) return false;
    const owner = parentPath(entries[0] ?? "");
    return paths.every((path) => isWithin(path, owner));
}

function matchesDeclarationPath(path: string, prefixes: string[]): boolean {
    return path.endsWith(".md") && prefixes.some((prefix) => path.startsWith(prefix) && path.length > prefix.length);
}

function nativeDialectSpec(dialectId: string): NativeDialectSpec | null {
    switch (dialectId) {
        case OPENCODE_NATIVE_DIALECTS.guidance:
            return { kind: "Guidance", dialectId };
        case OPENCODE_NATIVE_DIALECTS.commandWorkflow:
            return { kind: "Workflow", dialectId };
        case OPENCODE_NATIVE_DIALECTS.skill:
        case OPENCODE_NATIVE_DIALECTS.skillCli:
            return { kind: "Skill", dialectId };
        case OPENCODE_NATIVE_DIALECTS.subagent:
            return { kind: "Subagent", dialectId };
        default:
            return null;
    }
}

function nativeValidationScan(input: NativeDialectValidationInputV1, spec: NativeDialectSpec): ScanResult | null {
    const files = hydrateValidatedNativeSourceFiles<FileRecord>(input, (file) => ({
        handle: syntheticHandle(file.relativePath, "file"),
        observedReadEntryId: `native:${file.relativePath}`,
        relativePath: file.relativePath,
        bytes: file.bytes,
        executable: file.executable,
        text: file.contentKind === "text" ? decodeUtf8(file.bytes) : null,
    }));
    if (files === null) return null;
    const buildDirectory = (relativePath: string): DirectoryRecord => ({
        handle: syntheticHandle(relativePath, "directory"),
        observedReadEntryId: `native:${relativePath}`,
        relativePath,
    });
    const directories =
        input.representation.schemaVersion === 2
            ? input.representation.directories.map(buildDirectory)
            : buildNativeAncestorDirectories(
                  files.map((file) => file.relativePath),
                  buildDirectory,
              );
    const workflowReferencesByPath =
        spec.kind === "Workflow"
            ? nativeWorkflowReferenceClassifications(input, files)
            : new Map<string, WorkflowReferenceClassification>();
    if (workflowReferencesByPath === null) return null;
    const capability: AdapterAssetSourceCapability = {
        sourceCapabilityFingerprint: zeroSha256Digest(),
        agentRuntimeId: "OPENCODE_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: "config",
        sourceDomain: "agent_runtime_private",
        assetKind: spec.kind,
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: "source_code",
        readPolicy: "auto_read",
        diagnostics: [],
    };
    return {
        obligation: {
            sourceReadObligationId: "native-obligation",
            sourceRootId: "native-root",
            sourceCapabilityFingerprint: zeroSha256Digest(),
        },
        capability,
        files,
        directories,
        dispositions: [],
        observedReadEntryIds: files.map((file) => file.observedReadEntryId),
        diagnostics: [],
        unreadableRelativePaths: [],
        workflowReferencesByPath,
        hadIgnoredSource: false,
        attachCandidate() {},
        ignoreRecord() {},
        ignoreHandle() {},
        readReferencedFile: unavailableReferencedSourceFileRead,
    };
}

function nativeValidationContext(spec: NativeDialectSpec, files: FileRecord[]): SourceContext {
    const paths = files.map((file) => file.relativePath);
    const layout: SourceLayout =
        spec.kind === "Skill" && !paths.some((path) => path.startsWith(".opencode/"))
            ? "skill_root"
            : paths.some((path) => path.startsWith(".opencode/")) || paths.includes("AGENTS.md")
              ? "project"
              : "config";
    return {
        root: {
            sourceRootId: "native-root",
            rootRole: layout === "project" ? "project_actual" : layout === "config" ? "config" : "source",
            sourceDomain: layout === "project" ? "project_root" : "agent_runtime_private",
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
        platform: "linux",
        guidanceEnabled: true,
        projectConfigEnabled: true,
        externalSkillsEnabled: true,
        claudePromptEnabled: true,
        claudeSkillsEnabled: true,
    };
}

function nativeCanonicalMatches(
    candidate: AdapterExtractedAssetCandidate,
    canonical: NativeDialectValidationInputV1["canonical"],
): boolean {
    if (candidate.kind !== "Workflow" || canonical.kind !== "Workflow") {
        return stableSourceValueEqual({ kind: candidate.kind, typeData: candidate.typeData }, canonical);
    }
    const sourceTypeData = structuredClone(candidate.typeData);
    const sourceImplementation = sourceTypeData.implementation;
    const canonicalImplementation = canonical.typeData.implementation;
    if (
        sourceImplementation.kind === "instructions" &&
        canonicalImplementation.kind === "instructions" &&
        sourceImplementation.execution.agent.mode === "agent_runtime_named" &&
        canonicalImplementation.execution.agent.mode === "bound"
    ) {
        sourceImplementation.execution.agent = structuredClone(canonicalImplementation.execution.agent);
    }
    return stableSourceValueEqual({ kind: "Workflow", typeData: sourceTypeData }, canonical);
}

function nativeWorkflowReferenceClassifications(
    input: NativeDialectValidationInputV1,
    files: FileRecord[],
): Map<string, WorkflowReferenceClassification> | null {
    const source = files[0];
    const canonicalEntry = input.canonicalFiles.find((file) => file.file.logicalPath === "WORKFLOW.md");
    if (source?.text === null || source === undefined || canonicalEntry?.contentKind !== "text") {
        return null;
    }
    const parsed = parseOpencodeFrontmatter(source.text);
    const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : source.text;
    const rawTargets = parseOpenCodeAtReferenceTokens(body);
    const references = canonicalEntry.file.references;
    if (
        rawTargets.length !== references.length ||
        references.some(
            (reference, index) => reference.rawTarget !== rawTargets[index] || !isValidPersistedOpenCodeAtReference(reference),
        )
    ) {
        return null;
    }
    return new Map([
        [source.relativePath, { references: structuredClone(references), diagnostics: [], classificationHandles: [] }],
    ]);
}

function isValidPersistedOpenCodeAtReference(reference: FileReferenceV2): boolean {
    if (
        reference.kind === "include" &&
        reference.required === false &&
        (reference.resolution === "unresolved" || reference.resolution === "external")
    ) {
        return true;
    }
    return (
        reference.kind === "execute" &&
        reference.required === true &&
        (reference.resolution === "unresolved" || reference.resolution === "resolved_asset_version")
    );
}

function comparableReferences(references: readonly FileReferenceV2[]): unknown[] {
    return references.map((reference) => ({
        kind: reference.kind,
        rawTarget: reference.rawTarget,
        required: reference.required,
        resolution: reference.resolution,
        ...("targetLogicalPath" in reference ? { targetLogicalPath: reference.targetLogicalPath } : {}),
        ...("targetAssetVersionId" in reference ? { targetAssetVersionId: reference.targetAssetVersionId } : {}),
    }));
}

function normalizeText(text: string): string {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function canonicalMediaType(input: string): string {
    return input.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const NATIVE_FILE_PROJECTION_POLICY: NativeVersionFileProjectionPolicy = {
    normalizeMediaType: canonicalMediaType,
    projectCandidateText: normalizeText,
    projectPersistedText: normalizeText,
    normalizeBinary: (bytes) => [...bytes],
    projectReferences: comparableReferences,
};

function syntheticHandle(relativePath: string, entryKind: "file" | "directory"): ReadEntryHandle {
    return {
        readEntryHandleId: `native:${entryKind}:${relativePath}`,
        sourceReadObligationId: "native-obligation",
        sourceRootId: "native-root",
        relativePath,
        entryKind,
    };
}
interface NativeDialectSpec {
    kind: Exclude<AssetKind, "Rule" | "Memory">;
    dialectId: string;
}
