/** Claude Code native-dialect restoration validator. */

import type {
    AdapterAssetSourceCapability,
    AdapterExtractedAssetCandidate,
    AssetKind,
    AssetKindTypeDataV2,
    FileReferenceV2,
    NativeDialectValidationInputV1,
} from "@oaam/core";
import {
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
import { decodeUtf8 } from "./claudecode-source-read-foundation";
import { CLAUDECODE_NATIVE_DIALECTS, type FileRecord, type ScanResult, type SourceContext } from "./claudecode-source-read-model";
import { getClaudeCodeAssetReader } from "./claudecode-source-read-registry";

interface ClaudeNativeDialectSpec {
    kind: AssetKind;
}

/**
 * Re-parse one persisted Claude native graph and prove it still denotes the
 * supplied canonical Version. This is the adapter-owned half of Core's
 * immutable dialect contract; it deliberately ignores only Core-owned
 * callable-binding target ids while retaining their raw native selectors.
 */
export function validateClaudeCodeNativeDialect(input: NativeDialectValidationInputV1): boolean {
    const spec = nativeDialectSpec(input.representation.dialectId);
    if (spec === null || input.canonical.kind !== spec.kind) return false;
    const scan = nativeValidationScan(input, spec);
    if (scan === null) return false;
    const context = nativeValidationContext(spec, input);
    const built = getClaudeCodeAssetReader(spec.kind).buildCandidates(context, scan);
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

function nativeDialectSpec(dialectId: string): ClaudeNativeDialectSpec | null {
    switch (dialectId) {
        case CLAUDECODE_NATIVE_DIALECTS.guidance:
            return { kind: "Guidance" };
        case CLAUDECODE_NATIVE_DIALECTS.rule:
            return { kind: "Rule" };
        case CLAUDECODE_NATIVE_DIALECTS.commandWorkflow:
        case CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow:
            return { kind: "Workflow" };
        case CLAUDECODE_NATIVE_DIALECTS.skill:
            return { kind: "Skill" };
        case CLAUDECODE_NATIVE_DIALECTS.subagent:
            return { kind: "Subagent" };
        case CLAUDECODE_NATIVE_DIALECTS.memoryCatalog:
        case CLAUDECODE_NATIVE_DIALECTS.memoryTopic:
            return { kind: "Memory" };
        default:
            return null;
    }
}

function nativeValidationScan(input: NativeDialectValidationInputV1, spec: ClaudeNativeDialectSpec): ScanResult | null {
    const files = hydrateValidatedNativeSourceFiles<FileRecord>(input, (file) => ({
        handle: {
            readEntryHandleId: `native:${file.index}`,
            sourceReadObligationId: "native-validation",
            sourceRootId: "native-root",
            relativePath: file.relativePath,
            entryKind: "file",
        },
        observedReadEntryId: `native-entry:${file.index}`,
        relativePath: file.relativePath,
        bytes: file.bytes,
        executable: file.executable,
        text: file.contentKind === "text" ? decodeUtf8(file.bytes) : null,
    }));
    if (files === null) return null;
    const capability: AdapterAssetSourceCapability = {
        sourceCapabilityFingerprint: zeroSha256Digest(),
        agentRuntimeId: "CLAUDE_CODE_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: spec.kind === "Memory" ? "source" : "project_actual",
        sourceDomain: spec.kind === "Memory" ? "project_keyed" : "project_root",
        assetKind: spec.kind,
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: "source_code",
        readPolicy: "auto_read",
        diagnostics: [],
    };
    const obligation = {
        sourceReadObligationId: "native-validation",
        sourceRootId: "native-root",
        sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
    };
    return {
        obligation,
        capability,
        files,
        directories:
            input.representation.schemaVersion === 2 && spec.kind === "Skill"
                ? input.representation.directories.map((relativePath) => ({
                      handle: {
                          readEntryHandleId: `native-dir:${relativePath}`,
                          sourceReadObligationId: "native-validation",
                          sourceRootId: "native-root",
                          relativePath,
                          entryKind: "directory" as const,
                      },
                      observedReadEntryId: `native-dir:${relativePath}`,
                      relativePath,
                  }))
                : [],
        dispositions: [],
        observedReadEntryIds: files.map((file) => file.observedReadEntryId),
        diagnostics: [],
        hadIgnoredSource: false,
        attachCandidate: () => undefined,
        ignoreRecord: () => undefined,
        ignoreHandle: () => undefined,
        readReferencedFile: unavailableReferencedSourceFileRead,
    };
}

function nativeValidationContext(spec: ClaudeNativeDialectSpec, input: NativeDialectValidationInputV1): SourceContext {
    const layout: SourceContext["layout"] =
        spec.kind === "Memory"
            ? "memory"
            : input.representation.files.some((file) => file.relativePath.startsWith(".claude/"))
              ? "project"
              : "config";
    return {
        root: {
            sourceRootId: "native-root",
            rootRole: layout === "memory" ? "source" : layout === "config" ? "config" : "project_actual",
            sourceDomain: layout === "memory" ? "project_keyed" : layout === "config" ? "agent_runtime_private" : "project_root",
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
        scope: "project",
        projectRootPath: "/native",
        layout,
    };
}

function canonicalTypeDataMatches(candidate: AdapterExtractedAssetCandidate, input: NativeDialectValidationInputV1): boolean {
    const parsed = structuredClone({
        kind: candidate.kind,
        typeData: candidate.typeData,
    }) as AssetKindTypeDataV2;
    const expected = structuredClone(input.canonical);
    if (
        candidate.kind === "Workflow" &&
        expected.kind === "Workflow" &&
        candidate.workflowExecutionAgentBindingInput.bindingInputKind === "raw_selector" &&
        expected.typeData.implementation.kind === "instructions" &&
        expected.typeData.implementation.execution.agent.mode === "bound" &&
        parsed.kind === "Workflow" &&
        parsed.typeData.implementation.kind === "instructions"
    ) {
        parsed.typeData.implementation.execution.agent = expected.typeData.implementation.execution.agent;
    }
    if (
        candidate.kind === "Memory" &&
        candidate.typeData.entityRole === "catalog" &&
        expected.kind === "Memory" &&
        expected.typeData.entityRole === "catalog" &&
        parsed.kind === "Memory" &&
        parsed.typeData.entityRole === "catalog"
    ) {
        const observedMembers = candidate.memoryCatalogMemberBindingInputs;
        const expectedMembers = expected.typeData.members;
        if (observedMembers === undefined || observedMembers.length !== expectedMembers.length) return false;
        const reboundMembers = [];
        for (const [index, member] of observedMembers.entries()) {
            const expectedMember = expectedMembers[index];
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
