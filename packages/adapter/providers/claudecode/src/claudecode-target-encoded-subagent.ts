/** Claude Code project Subagent target encoded in one native Markdown file. */

import { defineDialectComponentV1 as component, sha256SourceBytes } from "@oaam/adapter-framework";
import type {
    AgentRuntimeDescriptor,
    DecodedCanonicalSection,
    EncodedCanonicalSectionDescriptor,
    NativeGlobalEncodedFileProviderSupport,
    NativeProjectEncodedFileProviderSupport,
    NativeProjectEncodedFileRebaseInput,
    NativeProjectEncodedFileRebaseMaterializer,
    PosixRelativePath,
} from "@oaam/core";
import {
    createNativeGlobalEncodedFileProviderSupport,
    createNativeProjectEncodedFileProviderSupport,
    createVerifiedNativeGlobalEncodedFileBuild,
    createVerifiedNativeProjectEncodedFileBuild,
} from "@oaam/core/adapter-spi";
import { parseClaudeFrontmatter } from "./claudecode-frontmatter";
import { CLAUDECODE_NATIVE_DIALECTS, validateClaudeCodeNativeDialect } from "./claudecode-source-read";
import { claudeCodeTargetBuildCompatibilityFor } from "./claudecode-target-build-compatibility";

const OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_PROJECT_SUBAGENT_ENCODED_FILE_V1";
const MATERIALIZATION_PROFILE_ID = "claude-code-cli-project-subagent-encoded-file-v1";
const TARGET_RELATIVE_PATH = ".claude/agents/oaam-phase53-agent.md" as PosixRelativePath;
const APP_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_PROJECT_SUBAGENT_ENCODED_FILE_V1";
const APP_MATERIALIZATION_PROFILE_ID = "claude-code-app-project-subagent-encoded-file-v1";
const APP_TARGET_RELATIVE_PATH = ".claude/agents/oaam-phase53-app-agent.md" as PosixRelativePath;
const GLOBAL_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_GLOBAL_SUBAGENT_ENCODED_FILE_V1";
const GLOBAL_MATERIALIZATION_PROFILE_ID = "claude-code-cli-global-subagent-encoded-file-v1";
const GLOBAL_TARGET_RELATIVE_PATH = "agents/oaam-phase53-global-agent.md" as PosixRelativePath;
const APP_GLOBAL_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_GLOBAL_SUBAGENT_ENCODED_FILE_V1";
const APP_GLOBAL_MATERIALIZATION_PROFILE_ID = "claude-code-app-global-subagent-encoded-file-v1";
const APP_GLOBAL_TARGET_RELATIVE_PATH = "agents/oaam-phase53-app-global-agent.md" as PosixRelativePath;

export const CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS = {
    path: component("claudecode.project-subagent-encoded-file-path-v1"),
    reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.subagent}.native-to-canonical-parser`),
    rebase: component("claudecode.project-subagent-encoded-file-parent-rebase-v1"),
} as const;

export const CLAUDECODE_GLOBAL_ENCODED_SUBAGENT_TARGET_COMPONENTS = {
    path: component("claudecode.global-subagent-encoded-file-path-v1"),
    reverse: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.reverse,
    rebase: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.rebase,
} as const;

const CLAUDECODE_ENCODED_SUBAGENT_REBASE_MATERIALIZER: NativeProjectEncodedFileRebaseMaterializer = {
    ref: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.rebase,
    materialize: materializeClaudeCodeSubagentParent,
};

interface ParsedSubagentDocument {
    prefix: string;
    body: string;
    initialPrompt: string | undefined;
}

export function createClaudeCodeEncodedSubagentTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectEncodedFileProviderSupport {
    return createEncodedSubagentTargetSupport({
        ...input,
        targetScope: "project",
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: OUTPUT_CONTRACT_ID,
        materializationProfileId: MATERIALIZATION_PROFILE_ID,
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-project-subagent-encoded-file-2026-08-03",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-subagent-encoded-file-parent-rebase-v1",
        targetRelativePath: TARGET_RELATIVE_PATH,
        exactLoadMarker: "OAAM_CC_21220_SUBAGENT_INITIAL_PROMPT_C614EF",
        reverseFixtureId: "claude-code-project-subagent-encoded-file-section-reverse-v1",
    }) as NativeProjectEncodedFileProviderSupport;
}

export function createClaudeCodeAppEncodedSubagentTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectEncodedFileProviderSupport {
    return createEncodedSubagentTargetSupport({
        ...input,
        targetScope: "project",
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_MATERIALIZATION_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-project-subagent-encoded-file-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-subagent-encoded-file-2026-08-04",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-subagent-encoded-file-parent-rebase-v1",
        targetRelativePath: APP_TARGET_RELATIVE_PATH,
        exactLoadMarker: "OAAM_APP_SUBAGENT_INITIAL_PROMPT_20260804_R1",
        reverseFixtureId: "claude-app-project-subagent-encoded-file-section-reverse-v1",
    }) as NativeProjectEncodedFileProviderSupport;
}

export function createClaudeCodeGlobalEncodedSubagentTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeGlobalEncodedFileProviderSupport {
    return createEncodedSubagentTargetSupport({
        ...input,
        targetScope: "global",
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: GLOBAL_OUTPUT_CONTRACT_ID,
        materializationProfileId: GLOBAL_MATERIALIZATION_PROFILE_ID,
        materializerCapabilityKey: "claudecode.global-subagent-encoded-file-v1",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-global-subagent-encoded-file-2026-08-05",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-global-subagent-encoded-file-parent-rebase-v1",
        targetRelativePath: GLOBAL_TARGET_RELATIVE_PATH,
        exactLoadMarker: "OAAM_CC_GLOBAL_SUBAGENT_20260805_R1",
        reverseFixtureId: "claude-code-global-subagent-encoded-file-section-reverse-v1",
    }) as NativeGlobalEncodedFileProviderSupport;
}

export function createClaudeCodeAppGlobalEncodedSubagentTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeGlobalEncodedFileProviderSupport {
    return createEncodedSubagentTargetSupport({
        ...input,
        targetScope: "global",
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_GLOBAL_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_GLOBAL_MATERIALIZATION_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-global-subagent-encoded-file-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-subagent-encoded-file-2026-08-05",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-global-subagent-encoded-file-parent-rebase-v1",
        targetRelativePath: APP_GLOBAL_TARGET_RELATIVE_PATH,
        exactLoadMarker: "OAAM_APP_GLOBAL_SUBAGENT_20260805_R1",
        reverseFixtureId: "claude-app-global-subagent-encoded-file-section-reverse-v1",
    }) as NativeGlobalEncodedFileProviderSupport;
}

function createEncodedSubagentTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey?: string;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    fixtureId: string;
    parentRebaseFixtureId: string;
    targetRelativePath: PosixRelativePath;
    exactLoadMarker: string;
    reverseFixtureId: string;
    targetScope: "project" | "global";
}): NativeProjectEncodedFileProviderSupport | NativeGlobalEncodedFileProviderSupport {
    const buildInput = {
        agentRuntimeId: input.agentRuntimeId,
        versionText: input.versionText,
        buildIdentity: input.buildIdentity,
        platform: input.platform,
        materializationProfileId: input.materializationProfileId,
        fixtureId: input.fixtureId,
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.subagent,
        reverseParser: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.rebase,
        restorationDialectIds: [],
        parentRebaseFixtureId: input.parentRebaseFixtureId,
        targetRelativePath: input.targetRelativePath,
        canonicalLogicalPaths: ["initial-prompt.md", "instructions.json"],
        exactLoadMarker: input.exactLoadMarker,
        reverseFixtureId: input.reverseFixtureId,
    };
    const verifiedBuild =
        input.targetScope === "project"
            ? createVerifiedNativeProjectEncodedFileBuild({
                  ...buildInput,
                  projectPathValidator: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.path,
              })
            : createVerifiedNativeGlobalEncodedFileBuild({
                  ...buildInput,
                  globalPathValidator: CLAUDECODE_GLOBAL_ENCODED_SUBAGENT_TARGET_COMPONENTS.path,
              });
    const common = {
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: input.agentRuntimeId,
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        materializerCapabilityKey: input.materializerCapabilityKey,
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.subagent,
        reverseParser: {
            ref: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.reverse,
            decode: decodeClaudeCodeSubagent,
        },
        rebaseMaterializer: CLAUDECODE_ENCODED_SUBAGENT_REBASE_MATERIALIZER,
        restorationDialectIds: [],
        target: { targetContextSchemaId: input.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(input.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    };
    return input.targetScope === "project"
        ? createNativeProjectEncodedFileProviderSupport({
              ...common,
              projectPathValidator: {
                  ref: CLAUDECODE_ENCODED_SUBAGENT_TARGET_COMPONENTS.path,
                  validate: isClaudeCodeProjectSubagentPath,
              },
              verifiedBuilds: [verifiedBuild as ReturnType<typeof createVerifiedNativeProjectEncodedFileBuild>],
          })
        : createNativeGlobalEncodedFileProviderSupport({
              ...common,
              globalPathValidator: {
                  ref: CLAUDECODE_GLOBAL_ENCODED_SUBAGENT_TARGET_COMPONENTS.path,
                  validate: isClaudeCodeGlobalSubagentPath,
              },
              verifiedBuilds: [verifiedBuild as ReturnType<typeof createVerifiedNativeGlobalEncodedFileBuild>],
          });
}

function decodeClaudeCodeSubagent(input: {
    assetKind: "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    nativeText: string;
    sections: EncodedCanonicalSectionDescriptor[];
}): { sections: DecodedCanonicalSection[] } | null {
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.subagent ||
        !isClaudeCodeSubagentPath(input.relativePath)
    ) {
        return null;
    }
    const parsed = parseSubagentDocument(input.nativeText);
    const instructionSections = input.sections.filter((section) => section.semanticKind === "subagent.invoked_context");
    const promptSections = input.sections.filter((section) => section.semanticKind === "subagent.resource");
    if (
        parsed === null ||
        instructionSections.length !== 1 ||
        promptSections.length > 1 ||
        instructionSections.length + promptSections.length !== input.sections.length ||
        (parsed.initialPrompt === undefined) !== (promptSections.length === 0)
    ) {
        return null;
    }
    const instructionSection = instructionSections[0];
    if (instructionSection === undefined) return null;
    const decoded: DecodedCanonicalSection[] = [
        {
            sectionHandle: instructionSection.sectionHandle,
            canonicalContent: { contentKind: "text", text: canonicalEntryForBody(parsed.body) },
        },
    ];
    const promptSection = promptSections[0];
    if (promptSection !== undefined && parsed.initialPrompt !== undefined) {
        decoded.push({
            sectionHandle: promptSection.sectionHandle,
            canonicalContent: { contentKind: "text", text: parsed.initialPrompt },
        });
    }
    return { sections: decoded };
}

function materializeClaudeCodeSubagentParent(input: NativeProjectEncodedFileRebaseInput): { nativeText: string } | null {
    const entry = input.targetFiles.find((file) => file.file.role === "entry");
    const resources = input.targetFiles.filter((file) => file.file.role === "resource");
    const prompt = resources[0];
    const parent = parseSubagentDocument(input.parent.file.text);
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.subagent ||
        entry?.contentKind !== "text" ||
        resources.length > 1 ||
        (prompt !== undefined &&
            (prompt.contentKind !== "text" || prompt.file.executable || prompt.text.trim() !== prompt.text)) ||
        parent === null
    ) {
        return null;
    }
    const body = nativeBodyForCanonicalEntry(entry.text);
    if (body === null) return null;
    const prefix = rewriteInitialPrompt(parent.prefix, prompt?.contentKind === "text" ? prompt.text : undefined);
    if (prefix === null) return null;
    const nativeText = `${prefix}${body}`;
    return nativeDocumentMatchesTarget(input, nativeText) ? { nativeText } : null;
}

function nativeDocumentMatchesTarget(input: NativeProjectEncodedFileRebaseInput, nativeText: string): boolean {
    const bytes = new TextEncoder().encode(nativeText);
    const { text: _parentText, ...parentFile } = input.parent.file;
    const nativeFile = {
        ...parentFile,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
    };
    return validateClaudeCodeNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: [nativeFile] },
        nativeFiles: [
            {
                relativePath: nativeFile.relativePath,
                bytes,
            },
        ],
    });
}

function parseSubagentDocument(nativeText: string): ParsedSubagentDocument | null {
    const parsed = parseClaudeFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    const hasInitialPrompt = parsed.presentKeys.includes("initialPrompt");
    const rawInitialPrompt = parsed.values.initialPrompt;
    const initialPrompt = typeof rawInitialPrompt === "string" ? rawInitialPrompt.trim() : undefined;
    if (hasInitialPrompt && (initialPrompt === undefined || initialPrompt === "")) return null;
    return {
        prefix: nativeText.slice(0, nativeText.length - parsed.body.length),
        body: parsed.body,
        initialPrompt,
    };
}

function rewriteInitialPrompt(prefix: string, targetPrompt: string | undefined): string | null {
    const lines = prefix.split("\n");
    const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
    if (lines[0] !== "---" || closingIndex < 1) return null;
    const promptIndices = lines.flatMap((line, index) =>
        index > 0 && index < closingIndex && /^initialPrompt[ ]*:/u.test(line) ? [index] : [],
    );
    if (promptIndices.length > 1) return null;
    const promptIndex = promptIndices[0];
    if (targetPrompt === undefined) {
        if (promptIndex === undefined) return prefix;
        const comment = trailingComment(lines[promptIndex]?.slice((lines[promptIndex]?.indexOf(":") ?? -1) + 1) ?? "");
        if (comment === "") lines.splice(promptIndex, 1);
        else lines[promptIndex] = comment;
        return lines.join("\n");
    }
    if (targetPrompt.trim() === "" || targetPrompt.trim() !== targetPrompt) return null;
    const serialized = JSON.stringify(targetPrompt);
    if (promptIndex === undefined) {
        lines.splice(closingIndex, 0, `initialPrompt: ${serialized}`);
    } else {
        const line = lines[promptIndex] as string;
        const separator = line.indexOf(":");
        if (separator < 1) return null;
        const comment = trailingComment(line.slice(separator + 1));
        lines[promptIndex] = `${line.slice(0, separator + 1)} ${serialized}${comment === "" ? "" : ` ${comment}`}`;
    }
    return lines.join("\n");
}

function trailingComment(value: string): string {
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (quote !== null) {
            if (character === "\\" && quote === '"') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === "'" || character === '"') quote = character;
        else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] as string))) {
            return value.slice(index).trimStart();
        }
    }
    return "";
}

function canonicalEntryForBody(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function nativeBodyForCanonicalEntry(entryText: string): string | null {
    try {
        const value: unknown = JSON.parse(entryText);
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        if (Object.keys(record).sort().join("\0") !== "schemaVersion\0sections" || record.schemaVersion !== 1) return null;
        if (!Array.isArray(record.sections) || record.sections.length !== 1) return null;
        const section = record.sections[0];
        if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
        const sectionRecord = section as Record<string, unknown>;
        if (Object.keys(sectionRecord).sort().join("\0") !== "content\0title") return null;
        return sectionRecord.title === "" && typeof sectionRecord.content === "string" && sectionRecord.content.trim() !== ""
            ? sectionRecord.content
            : null;
    } catch {
        return null;
    }
}

function isClaudeCodeProjectSubagentPath(relativePath: PosixRelativePath): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const segments = relativePath.split("/");
    return (
        segments.length === 3 &&
        segments[0] === ".claude" &&
        segments[1] === "agents" &&
        (segments[2]?.endsWith(".md") ?? false) &&
        segments[2] !== ".md"
    );
}

function isClaudeCodeGlobalSubagentPath(relativePath: PosixRelativePath): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const segments = relativePath.split("/");
    return (
        segments.length >= 2 &&
        segments[0] === "agents" &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
        (segments.at(-1)?.endsWith(".md") ?? false) &&
        segments.at(-1) !== ".md"
    );
}

function isClaudeCodeSubagentPath(relativePath: PosixRelativePath): boolean {
    return isClaudeCodeProjectSubagentPath(relativePath) || isClaudeCodeGlobalSubagentPath(relativePath);
}

/** Narrow direct seam for callback fail-closed regression tests; not exported by the package entry point. */
export const claudeCodeEncodedSubagentTargetInternalsForTest = {
    decode: decodeClaudeCodeSubagent,
    materializeParent: materializeClaudeCodeSubagentParent,
};
