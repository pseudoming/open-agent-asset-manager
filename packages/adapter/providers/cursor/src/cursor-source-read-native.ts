/** Immutable revalidation for persisted Cursor native bytes. */

import type { NativeVersionFileProjectionPolicy } from "@oaam/adapter-framework";
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
import type { AdapterAssetSourceCapability, NativeDialectValidationInputV1, ReadEntryHandle } from "@oaam/core";
import { parseCursorRule } from "./cursor-source-read-guidance-rule";
import {
    CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH,
    cursorMemoryTypeData,
    parseCursorMemoryReadonlySnapshot,
} from "./cursor-source-read-memory";
import {
    CURSOR_NATIVE_DIALECTS,
    type CursorFileRecord,
    type CursorScanResult,
    type CursorSourceContext,
} from "./cursor-source-read-model";
import { buildCursorSkillCandidates } from "./cursor-source-read-skill";
import { isCursorCommandPath, parseCursorCommand } from "./cursor-source-read-workflow";
import { parseCursorMarkdownSubagent } from "./cursor-subagent-markdown";

export function validateCursorNativeDialect(input: NativeDialectValidationInputV1): boolean {
    let files: CursorFileRecord[] | null;
    try {
        files = hydrateValidatedNativeSourceFiles(input, (file) => ({
            handle: {
                readEntryHandleId: `cursor-native:${file.index}`,
                sourceReadObligationId: "cursor-native",
                sourceRootId: "cursor-native",
                relativePath: file.relativePath,
                entryKind: "file" as const,
            },
            observedReadEntryId: `cursor-native:${file.index}`,
            relativePath: file.relativePath,
            bytes: file.bytes,
            executable: file.executable,
            text: file.contentKind === "text" ? new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) : null,
        }));
    } catch {
        return false;
    }
    if (files === null) return false;
    if (input.representation.dialectId === CURSOR_NATIVE_DIALECTS.skill) {
        return validateCursorSkillGraph(input, files);
    }
    if (files.length !== 1) return false;
    const native = files[0];
    const canonical = canonicalText(input);
    if (native === undefined || native.text === null || native.executable || canonical === null) return false;
    if (input.representation.dialectId === CURSOR_NATIVE_DIALECTS.memorySnapshot) {
        const snapshot = parseCursorMemoryReadonlySnapshot(native.text);
        return (
            input.canonical.kind === "Memory" &&
            native.relativePath === CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH &&
            snapshot !== null &&
            stableSourceValueEqual(input.canonical.typeData, cursorMemoryTypeData(snapshot)) &&
            canonical.logicalPath === "memory.md" &&
            canonical.text === snapshot.item.knowledge
        );
    }
    if (input.representation.dialectId === CURSOR_NATIVE_DIALECTS.guidance) {
        return (
            input.canonical.kind === "Guidance" &&
            isGuidancePath(native.relativePath) &&
            stableSourceValueEqual(input.canonical.typeData, { schemaVersion: 1 }) &&
            canonical.logicalPath === "GUIDANCE.md" &&
            canonical.text === native.text
        );
    }
    if (
        (input.representation.dialectId === CURSOR_NATIVE_DIALECTS.agentCommandWorkflow ||
            input.representation.dialectId === CURSOR_NATIVE_DIALECTS.appCommandWorkflow) &&
        input.canonical.kind === "Workflow"
    ) {
        const app = input.representation.dialectId === CURSOR_NATIVE_DIALECTS.appCommandWorkflow;
        const scope = native.relativePath.startsWith("commands/") ? "global" : "project";
        if (!isCursorCommandPath(native.relativePath, app, scope)) return false;
        const parsed = parseCursorCommand(
            {
                agentRuntimeId: app ? "CURSOR_APP" : "CURSOR_AGENT_CLI",
                layout: scope === "global" ? "config" : "project",
            },
            native,
        );
        return (
            parsed.diagnostics.every((item) => item.severity !== "error") &&
            stableSourceValueEqual(input.canonical.typeData, parsed.typeData) &&
            canonical.logicalPath === "WORKFLOW.md" &&
            canonical.text === native.text
        );
    }
    if (input.representation.dialectId === CURSOR_NATIVE_DIALECTS.subagent && input.canonical.kind === "Subagent") {
        const parsed = parseCursorMarkdownSubagent(native.text, native.relativePath);
        return (
            isCursorSubagentPath(native.relativePath) &&
            parsed.disposition === "candidate" &&
            parsed.diagnostics.every((item) => item.severity !== "error") &&
            stableSourceValueEqual(input.canonical.typeData, parsed.typeData) &&
            canonical.logicalPath === "instructions.json" &&
            canonical.text === JSON.stringify(parsed.instruction)
        );
    }
    if (input.representation.dialectId !== CURSOR_NATIVE_DIALECTS.rule || input.canonical.kind !== "Rule") return false;
    if (!isCursorRulePath(native.relativePath)) return false;
    const parsed = parseCursorRule(native.text, native.relativePath);
    return (
        parsed.diagnostics.every((item) => item.severity !== "error") &&
        stableSourceValueEqual(input.canonical.typeData, parsed.typeData) &&
        canonical.logicalPath === "RULE.md" &&
        canonical.text === parsed.body
    );
}

function validateCursorSkillGraph(input: NativeDialectValidationInputV1, files: CursorFileRecord[]): boolean {
    if (input.canonical.kind !== "Skill") return false;
    const context = cursorSkillValidationContext(files.map((file) => file.relativePath));
    if (context === null) return false;
    const capability: AdapterAssetSourceCapability = {
        sourceCapabilityFingerprint: zeroSha256Digest(),
        agentRuntimeId: "CURSOR_AGENT_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: context.root.rootRole,
        sourceDomain: context.root.sourceDomain,
        assetKind: "Skill",
        sourcePathMechanism: "recursive_entry",
        evidenceLevel: "agent_runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
    };
    const buildDirectory = (relativePath: string): CursorScanResult["directories"][number] => ({
        handle: syntheticHandle(relativePath, "directory"),
        observedReadEntryId: `cursor-native-directory:${relativePath}`,
        relativePath,
    });
    const directories =
        input.representation.schemaVersion === 2
            ? input.representation.directories.map(buildDirectory)
            : buildNativeAncestorDirectories(
                  files.map((file) => file.relativePath),
                  buildDirectory,
              );
    const scan: CursorScanResult = {
        obligation: {
            sourceReadObligationId: "cursor-native-obligation",
            sourceRootId: "cursor-native-root",
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
    const built = buildCursorSkillCandidates(context, scan);
    if (built.candidates.length !== 1) return false;
    const candidate = built.candidates[0];
    return (
        candidate !== undefined &&
        candidate.status === "complete" &&
        candidate.kind === "Skill" &&
        candidate.nativeRepresentation.representationSource === "separate_file_graph" &&
        candidate.nativeRepresentation.dialectId === CURSOR_NATIVE_DIALECTS.skill &&
        (input.representation.schemaVersion === 1 ||
            stableSourceValueEqual(
                candidate.nativeRepresentation.directories.map((directory) => directory.relativePath),
                input.representation.directories,
            )) &&
        stableSourceValueEqual(candidate.typeData, input.canonical.typeData) &&
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

function cursorSkillValidationContext(paths: string[]): CursorSourceContext | null {
    if (paths.length === 0 || paths.some((value) => !isCanonicalPath(value))) return null;
    const projectCursor = paths.some((value) => value.startsWith(".cursor/skills/"));
    const projectShared = paths.some((value) => value.startsWith(".agents/skills/"));
    const globalCursor = paths.some((value) => value.startsWith("skills/"));
    if (Number(projectCursor) + Number(projectShared) + Number(globalCursor) > 1) return null;
    const layout = projectCursor || projectShared ? "project" : globalCursor ? "config" : "skill_root";
    const context: CursorSourceContext = {
        root: {
            sourceRootId: "cursor-native-root",
            rootRole: layout === "project" ? "project_actual" : layout === "config" ? "config" : "source",
            sourceDomain: layout === "project" ? "project_root" : layout === "config" ? "agent_runtime_private" : "family_shared",
            path: "/cursor-native",
            accessStatus: "available",
            locatorEvidence: [
                { locatorKind: "runtime_known_rule", locatorKey: "cursor_native_validation", evidenceLevel: "source_code" },
            ],
            diagnostics: [],
        },
        scope: layout === "project" ? "project" : "global",
        projectRootPath: layout === "project" ? "/cursor-native" : "",
        layout,
        agentRuntimeId: "CURSOR_AGENT_CLI",
        ownsSharedPhysicalSource: true,
    };
    return context;
}

function syntheticHandle(relativePath: string, entryKind: ReadEntryHandle["entryKind"]): ReadEntryHandle {
    return {
        readEntryHandleId: `cursor-native:${entryKind}:${relativePath}`,
        sourceReadObligationId: "cursor-native-obligation",
        sourceRootId: "cursor-native-root",
        relativePath,
        entryKind,
    };
}

export function isCursorRulePath(relativePath: string): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const segments = relativePath.split("/");
    return (
        segments.length >= 3 &&
        segments[0] === ".cursor" &&
        segments[1] === "rules" &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
        (segments.at(-1)?.endsWith(".mdc") ?? false) &&
        segments.at(-1) !== ".mdc"
    );
}

export function isCursorSubagentPath(relativePath: string): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const prefix = ".cursor/agents/";
    if (!relativePath.startsWith(prefix)) return false;
    const suffix = relativePath.slice(prefix.length);
    const segments = suffix.split("/");
    return (
        segments.length >= 1 &&
        segments.length <= 11 &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
        /\.(md|mdc|markdown)$/u.test(segments.at(-1) ?? "")
    );
}

function isGuidancePath(relativePath: string): boolean {
    return ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".cursorrules"].includes(relativePath);
}

function canonicalText(input: NativeDialectValidationInputV1): { logicalPath: string; text: string } | null {
    if (input.canonicalFiles.length !== 1) return null;
    const entry = input.canonicalFiles[0];
    if (
        entry?.contentKind !== "text" ||
        entry.file.role !== "entry" ||
        entry.file.executable ||
        entry.file.references.length !== 0
    ) {
        return null;
    }
    return { logicalPath: entry.file.logicalPath, text: entry.text };
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

function isCanonicalPath(value: string): boolean {
    return (
        value !== "" &&
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

const NATIVE_FILE_PROJECTION_POLICY: NativeVersionFileProjectionPolicy = {
    normalizeMediaType: canonicalMediaType,
    projectCandidateText: normalizeText,
    projectPersistedText: (text) => text,
    normalizeBinary: (bytes) => Buffer.from(bytes).toString("base64"),
    projectReferences: (references) => references,
};
