/** Immutable native-dialect revalidation for Antigravity historical bytes. */

import type { AssetKind, FileReferenceV2, NativeDialectValidationInputV1, ReadEntryHandle } from "@oaam/core";
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
import { decodeUtf8 } from "./antigravity-source-read-foundation";
import {
    ANTIGRAVITY_NATIVE_DIALECTS,
    type DirectoryRecord,
    type FileRecord,
    type ScanResult,
    type SourceContext,
    type SourceLayout,
} from "./antigravity-source-read-model";
import { getAntigravityAssetReader } from "./antigravity-source-read-registry";

interface NativeDialectSpec {
    kind: Exclude<AssetKind, "Memory">;
    dialectId: string;
    layout: SourceLayout;
}

/**
 * Re-parses historical bytes with the exact registered dialect version. A new
 * runtime format must register a new dialect id; this validator never guesses
 * that old bytes have acquired new semantics.
 */
export function validateAntigravityNativeDialect(input: NativeDialectValidationInputV1): boolean {
    const spec = nativeDialectSpec(input.representation.dialectId);
    if (spec === null || input.canonical.kind !== spec.kind) return false;
    const scan = nativeValidationScan(input, spec);
    if (scan === null) return false;
    const layout = nativeValidationLayout(spec, input);
    const context: SourceContext = {
        root: {
            sourceRootId: "native-root",
            rootRole: layout === "config" ? "config" : layout === "project" ? "project_actual" : "source",
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
    };
    const reader = getAntigravityAssetReader(spec.kind);
    if (reader.disposition !== "reader") return false;
    const built = reader.buildCandidates(context, scan);
    if (built.candidates.length !== 1) return false;
    const candidate = built.candidates[0];
    if (
        candidate === undefined ||
        candidate.status !== "complete" ||
        candidate.nativeRepresentation.representationSource === "canonical_files" ||
        candidate.nativeRepresentation.dialectId !== input.representation.dialectId
    ) {
        return false;
    }
    return (
        (input.representation.schemaVersion !== 2 ||
            spec.kind !== "Skill" ||
            (candidate.nativeRepresentation.representationSource === "separate_file_graph" &&
                stableSourceValueEqual(
                    candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                    input.representation.directories,
                ))) &&
        stableSourceValueEqual({ kind: candidate.kind, typeData: candidate.typeData }, input.canonical) &&
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

function nativeDialectSpec(dialectId: string): NativeDialectSpec | null {
    switch (dialectId) {
        case ANTIGRAVITY_NATIVE_DIALECTS.guidance:
            return { kind: "Guidance", dialectId, layout: "project" };
        case ANTIGRAVITY_NATIVE_DIALECTS.rule:
            return { kind: "Rule", dialectId, layout: "project" };
        case ANTIGRAVITY_NATIVE_DIALECTS.workflow:
            return { kind: "Workflow", dialectId, layout: "project" };
        case ANTIGRAVITY_NATIVE_DIALECTS.skillFolder:
        case ANTIGRAVITY_NATIVE_DIALECTS.skillFlat:
            return { kind: "Skill", dialectId, layout: "skill_root" };
        case ANTIGRAVITY_NATIVE_DIALECTS.subagent:
            return { kind: "Subagent", dialectId, layout: "config" };
        case ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown:
            return { kind: "Subagent", dialectId, layout: "config" };
        default:
            return null;
    }
}

function nativeValidationLayout(spec: NativeDialectSpec, input: NativeDialectValidationInputV1): SourceLayout {
    const paths = input.representation.files.map((file) => file.relativePath);
    if (paths.some((path) => path.startsWith(".agents/") || path.startsWith(".agent/"))) {
        return "project";
    }
    if (spec.kind === "Skill") {
        return paths.some((path) => path.startsWith("skills/") || path.startsWith("config/skills/")) ? "config" : "skill_root";
    }
    if (spec.kind === "Workflow" || spec.kind === "Subagent") return "config";
    return spec.layout;
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
        observedReadEntryId: `native-dir:${relativePath}`,
        relativePath,
    });
    const directories =
        input.representation.schemaVersion === 2 && spec.kind === "Skill"
            ? input.representation.directories.map(buildDirectory)
            : buildNativeAncestorDirectories(
                  files.map((file) => file.relativePath),
                  buildDirectory,
              );
    const capability = {
        sourceCapabilityFingerprint: zeroSha256Digest(),
        agentRuntimeId: "ANTIGRAVITY_CLI" as const,
        entrySupportStatus: "supported" as const,
        rootLocatorKind: "runtime_known_rule" as const,
        rootRole: spec.layout === "config" ? ("config" as const) : ("source" as const),
        sourceDomain: "family_shared" as const,
        assetKind: spec.kind,
        sourcePathMechanism: "recursive_entry" as const,
        evidenceLevel: "source_code" as const,
        readPolicy: "auto_read" as const,
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
        hadIgnoredSource: false,
        attachCandidate() {},
        ignoreRecord() {},
        ignoreHandle() {},
        readReferencedFile: unavailableReferencedSourceFileRead,
    };
}

function comparableReferences(references: readonly FileReferenceV2[]): unknown[] {
    return references.map((reference) => ({
        kind: reference.kind,
        rawTarget: reference.rawTarget,
        required: reference.required,
        diagnostics: reference.diagnostics,
        resolution: reference.resolution === "resolved_asset_version" ? "unresolved" : reference.resolution,
        ...(reference.resolution === "resolved_version_file" ? { targetLogicalPath: reference.targetLogicalPath } : {}),
    }));
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
    projectReferences: comparableReferences,
};

function syntheticHandle(relativePath: string, entryKind: "file" | "directory"): ReadEntryHandle {
    return {
        readEntryHandleId: `native-handle:${entryKind}:${relativePath}`,
        sourceReadObligationId: "native-obligation",
        sourceRootId: "native-root",
        relativePath,
        entryKind,
    };
}
