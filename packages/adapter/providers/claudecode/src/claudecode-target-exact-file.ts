/** Claude Code one-file project targets over the Core exact-native contract. */

import * as crypto from "node:crypto";
import { defineDialectComponentV1 as component } from "@oaam/adapter-framework";
import type { AgentRuntimeDescriptor, NativeProjectExactFileProviderSupport, PosixRelativePath } from "@oaam/core";
import { createNativeProjectExactFileProviderSupport, createVerifiedNativeProjectExactFileBuild } from "@oaam/core/adapter-spi";
import { frontmatterString, frontmatterStringMap, parseClaudeFrontmatter } from "./claudecode-frontmatter";
import { CLAUDECODE_NATIVE_DIALECTS, validateClaudeCodeNativeDialect } from "./claudecode-source-read";
import { parseMemoryIndex } from "./claudecode-source-read-foundation";
import { claudeCodeTargetBuildCompatibilityFor } from "./claudecode-target-build-compatibility";

type ExactAssetKind = "Rule" | "Workflow" | "Memory";
type ExactSupportKey =
    | "Rule"
    | "AppRule"
    | "Workflow"
    | "AppWorkflow"
    | "Memory"
    | "MemoryCatalog"
    | "AppMemory"
    | "AppMemoryCatalog";
type ExactComponentKey = "Rule" | "Workflow" | "Memory" | "MemoryCatalog";
type ExactSupportInput = Parameters<typeof createNativeProjectExactFileProviderSupport>[0];
type ExactRebaseMaterializer = NonNullable<ExactSupportInput["rebaseMaterializer"]>;
type ExactRebaseInput = Parameters<ExactRebaseMaterializer["materialize"]>[0];
type ExactTextEntry = Extract<ExactRebaseInput["targetFiles"][number], { contentKind: "text" }>;

export interface ClaudeMemoryTopicRestorationPayload {
    schemaVersion: 1;
    dialectId: typeof CLAUDECODE_NATIVE_DIALECTS.memoryTopic;
    topLevelType: string;
    metadataType: string;
    metadataOriginSessionId: string;
    metadataNodeType: string;
}

interface ExactTargetSpec {
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
    componentKey: ExactComponentKey;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    assetKind: ExactAssetKind;
    nativeDialectId: string;
    outputContractId: string;
    materializerCapabilityKey?: string;
    materializationProfileId: string;
    fixtureId: string;
    parentRebaseFixtureId: string;
    targetRelativePath: PosixRelativePath;
    exactLoadMarker: string;
    reverseFixtureId: string;
    restorationDialectIds: readonly string[];
    requiredFacts: Readonly<Record<string, string>>;
    memoryRole?: "unit" | "catalog";
}

export const CLAUDECODE_EXACT_TARGET_COMPONENTS = {
    Rule: {
        path: component("claudecode.project-rule-exact-path-v1"),
        reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.rule}.native-to-canonical-parser`),
        rebase: component("claudecode.project-rule-parent-rebase-v1"),
    },
    Workflow: {
        path: component("claudecode.project-workflow-command-exact-path-v1"),
        reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.commandWorkflow}.native-to-canonical-parser`),
        rebase: component("claudecode.project-workflow-command-parent-rebase-v1"),
    },
    Memory: {
        path: component("claudecode.project-memory-topic-exact-path-v1"),
        reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.memoryTopic}.native-to-canonical-parser`),
        rebase: component("claudecode.project-memory-topic-parent-rebase-v1"),
    },
    MemoryCatalog: {
        path: component("claudecode.project-memory-catalog-exact-path-v1"),
        reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.memoryCatalog}.native-to-canonical-parser`),
        rebase: component("claudecode.project-memory-catalog-parent-rebase-v1"),
    },
} as const;

const SPECS: Record<ExactSupportKey, ExactTargetSpec> = {
    Rule: {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        componentKey: "Rule",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        assetKind: "Rule",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.rule,
        outputContractId: "CLAUDECODE_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
        materializerCapabilityKey: "claudecode.project-rule-exact-file-v1",
        materializationProfileId: "claude-code-cli-project-rule-exact-file-v1",
        fixtureId: "claude-code-cli-2.1.220-wsl-project-rule-exact-file-2026-08-04",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-rule-parent-rebase-v1",
        targetRelativePath: ".claude/rules/oaam-always.md",
        exactLoadMarker: "OAAM_CC_RULE_PHASE53_220_6C51E9",
        reverseFixtureId: "claude-code-project-rule-native-body-reverse-v1",
        restorationDialectIds: [],
        requiredFacts: {},
    },
    AppRule: {
        agentRuntimeId: "CLAUDE_CODE_APP",
        componentKey: "Rule",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        assetKind: "Rule",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.rule,
        outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
        materializerCapabilityKey: "claudecode.app-project-rule-exact-file-v1",
        materializationProfileId: "claude-code-app-project-rule-exact-file-v1",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-rule-exact-file-2026-08-04",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-rule-parent-rebase-v1",
        targetRelativePath: ".claude/rules/oaam-app-always.md",
        exactLoadMarker: "OAAM_APP_RULE_LOADED_20260804_R1",
        reverseFixtureId: "claude-app-project-rule-native-body-reverse-v1",
        restorationDialectIds: [],
        requiredFacts: {},
    },
    Workflow: {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        componentKey: "Workflow",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        assetKind: "Workflow",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
        outputContractId: "CLAUDECODE_NATIVE_PROJECT_WORKFLOW_COMMAND_V1",
        materializationProfileId: "claude-code-cli-project-workflow-command-v1",
        fixtureId: "claude-code-cli-2.1.220-wsl-project-workflow-command-2026-08-01",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-workflow-command-parent-rebase-v1",
        targetRelativePath: ".claude/commands/oaam-phase53-workflow.md",
        exactLoadMarker: "OAAM_CC_21220_WORKFLOW_47A9C1",
        reverseFixtureId: "claude-code-project-workflow-command-body-reverse-v1",
        restorationDialectIds: [],
        requiredFacts: {},
    },
    AppWorkflow: {
        agentRuntimeId: "CLAUDE_CODE_APP",
        componentKey: "Workflow",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        assetKind: "Workflow",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
        outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_WORKFLOW_COMMAND_V1",
        materializerCapabilityKey: "claudecode.app-project-workflow-command-exact-file-v1",
        materializationProfileId: "claude-code-app-project-workflow-command-v1",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-workflow-command-2026-08-04",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-workflow-command-parent-rebase-v1",
        targetRelativePath: ".claude/commands/oaam-phase53-app-workflow.md",
        exactLoadMarker: "OAAM_APP_WORKFLOW_LOADED_20260804_R1",
        reverseFixtureId: "claude-app-project-workflow-command-body-reverse-v1",
        restorationDialectIds: [],
        requiredFacts: {},
    },
    Memory: {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        componentKey: "Memory",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        assetKind: "Memory",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.memoryTopic,
        outputContractId: "CLAUDECODE_NATIVE_PROJECT_MEMORY_TOPIC_V1",
        materializationProfileId: "claude-code-cli-project-memory-topic-v1",
        fixtureId: "claude-code-cli-2.1.220-wsl-project-memory-topic-2026-08-03",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-memory-topic-parent-rebase-v1",
        targetRelativePath: "topics/oaam-phase53-memory.md",
        exactLoadMarker: "OAAM_CC_21220_MEMORY_5E71B4",
        reverseFixtureId: "claude-code-project-memory-topic-body-reverse-v1",
        restorationDialectIds: [CLAUDECODE_NATIVE_DIALECTS.memoryTopic],
        requiredFacts: {
            "oaam.project-binding": "registered",
            "oaam.target-kind": "directory",
        },
        memoryRole: "unit",
    },
    MemoryCatalog: {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        componentKey: "MemoryCatalog",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        assetKind: "Memory",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.memoryCatalog,
        outputContractId: "CLAUDECODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
        materializerCapabilityKey: "claudecode.project-memory-catalog-exact-file-v1",
        materializationProfileId: "claude-code-cli-project-memory-catalog-v1",
        fixtureId: "claude-code-cli-2.1.220-wsl-project-memory-catalog-2026-08-03",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-memory-catalog-parent-rebase-v1",
        targetRelativePath: "MEMORY.md",
        exactLoadMarker: "OAAM_CC_21220_MEMORY_CATALOG_7C43A1",
        reverseFixtureId: "claude-code-project-memory-catalog-membership-reverse-v1",
        restorationDialectIds: [],
        requiredFacts: {
            "oaam.project-binding": "registered",
            "oaam.target-kind": "directory",
        },
        memoryRole: "catalog",
    },
    AppMemory: {
        agentRuntimeId: "CLAUDE_CODE_APP",
        componentKey: "Memory",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        assetKind: "Memory",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.memoryTopic,
        outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1",
        materializerCapabilityKey: "claudecode.app-project-memory-topic-exact-file-v1",
        materializationProfileId: "claude-code-app-project-memory-topic-v1",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-memory-topic-2026-08-04",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-memory-topic-parent-rebase-v1",
        targetRelativePath: "topics/oaam-phase53-app-memory.md",
        exactLoadMarker: "OAAM_APP_MEMORY_LOADED_20260804_R1",
        reverseFixtureId: "claude-app-project-memory-topic-body-reverse-v1",
        restorationDialectIds: [CLAUDECODE_NATIVE_DIALECTS.memoryTopic],
        requiredFacts: {
            "oaam.project-binding": "registered",
            "oaam.target-kind": "directory",
        },
        memoryRole: "unit",
    },
    AppMemoryCatalog: {
        agentRuntimeId: "CLAUDE_CODE_APP",
        componentKey: "MemoryCatalog",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        assetKind: "Memory",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.memoryCatalog,
        outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_CATALOG_V1",
        materializerCapabilityKey: "claudecode.app-project-memory-catalog-exact-file-v1",
        materializationProfileId: "claude-code-app-project-memory-catalog-v1",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-memory-catalog-2026-08-04",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-memory-catalog-parent-rebase-v1",
        targetRelativePath: "MEMORY.md",
        exactLoadMarker: "OAAM_APP_MEMORY_CATALOG_LOADED_20260804_R1",
        reverseFixtureId: "claude-app-project-memory-catalog-membership-reverse-v1",
        restorationDialectIds: [],
        requiredFacts: {
            "oaam.project-binding": "registered",
            "oaam.target-kind": "directory",
        },
        memoryRole: "catalog",
    },
};

export function createClaudeCodeExactFileTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
    appTargetContextSchemaId: string;
    memoryTargetContextSchemaId: string;
    appMemoryTargetContextSchemaId: string;
}): Record<ExactSupportKey, NativeProjectExactFileProviderSupport> {
    return {
        Rule: createSupport(SPECS.Rule, input),
        AppRule: createSupport(SPECS.AppRule, input),
        Workflow: createSupport(SPECS.Workflow, input),
        AppWorkflow: createSupport(SPECS.AppWorkflow, input),
        Memory: createSupport(SPECS.Memory, input),
        MemoryCatalog: createSupport(SPECS.MemoryCatalog, input),
        AppMemory: createSupport(SPECS.AppMemory, input),
        AppMemoryCatalog: createSupport(SPECS.AppMemoryCatalog, input),
    };
}

function createSupport(
    spec: ExactTargetSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        targetContextSchemaId: string;
        appTargetContextSchemaId: string;
        memoryTargetContextSchemaId: string;
        appMemoryTargetContextSchemaId: string;
    },
): NativeProjectExactFileProviderSupport {
    const components = CLAUDECODE_EXACT_TARGET_COMPONENTS[spec.componentKey];
    const rebaseMaterializer: ExactRebaseMaterializer = {
        ref: components.rebase,
        materialize: (rebaseInput) => materializeParentNative(spec, rebaseInput),
    };
    const verifiedBuild = createVerifiedNativeProjectExactFileBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: spec.materializationProfileId,
        fixtureId: spec.fixtureId,
        assetKind: spec.assetKind,
        nativeDialectId: spec.nativeDialectId,
        projectPathValidator: components.path,
        reverseParser: components.reverse,
        rebaseMaterializer: components.rebase,
        restorationDialectIds: spec.restorationDialectIds,
        parentRebaseFixtureId: spec.parentRebaseFixtureId,
        targetRelativePath: spec.targetRelativePath,
        exactLoadMarker: spec.exactLoadMarker,
        reverseFixtureId: spec.reverseFixtureId,
    });
    return createNativeProjectExactFileProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: spec.assetKind,
        outputContractId: spec.outputContractId,
        ...(spec.materializerCapabilityKey === undefined ? {} : { materializerCapabilityKey: spec.materializerCapabilityKey }),
        materializationProfileId: spec.materializationProfileId,
        nativeDialectId: spec.nativeDialectId,
        projectPathValidator: {
            ref: components.path,
            validate: (relativePath) => isExactProjectPath(spec.assetKind, relativePath, spec.memoryRole),
        },
        reverseParser: {
            ref: components.reverse,
            parse: (parseInput) => {
                // The Core exact-file wrapper has already fixed the kind/dialect and validated this project path.
                const applied = splitNativeDocument(spec.assetKind, parseInput.appliedNativeText);
                const current = splitNativeDocument(spec.assetKind, parseInput.currentNativeText);
                return applied === null || current === null || applied.prefix !== current.prefix
                    ? null
                    : { canonicalEntryText: current.canonicalEntryText };
            },
        },
        ...(spec.memoryRole === "catalog"
            ? {
                  memoryCatalog: {
                      parse: (catalogInput) => {
                          if (
                              catalogInput.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.memoryCatalog ||
                              catalogInput.relativePath !== "MEMORY.md"
                          ) {
                              return null;
                          }
                          const parsed = parseMemoryIndex(catalogInput.nativeText);
                          return parsed.issues.length === 0
                              ? {
                                    members: parsed.members.map((member) => ({
                                        relativePath: member.rawTarget as PosixRelativePath,
                                        routingTitle: member.routingTitle,
                                        routingHint: member.routingHint,
                                    })),
                                }
                              : null;
                      },
                      resolveMemberPath: (memberInput) => {
                          const group = memberInput.dialectInputs.find(
                              (candidate) =>
                                  candidate.targetVersion.assetId === memberInput.memberAsset.version.ref.assetId &&
                                  candidate.targetVersion.versionId === memberInput.targetAssetVersionId,
                          );
                          const native = group?.inputs.filter(
                              (candidate) =>
                                  candidate.inputKind === "native_representation" &&
                                  candidate.representation.dialectId === CLAUDECODE_NATIVE_DIALECTS.memoryTopic,
                          );
                          const file = native?.[0]?.inputKind === "native_representation" ? native[0].files[0] : undefined;
                          return native?.length === 1 &&
                              native[0]?.inputKind === "native_representation" &&
                              native[0].files.length === 1 &&
                              file?.contentKind === "text" &&
                              isExactProjectPath("Memory", file.relativePath, "unit")
                              ? file.relativePath
                              : null;
                      },
                  },
              }
            : {}),
        rebaseMaterializer,
        restorationDialectIds: spec.restorationDialectIds,
        target: {
            targetContextSchemaId:
                spec.assetKind === "Memory"
                    ? spec.agentRuntimeId === "CLAUDE_CODE_APP"
                        ? input.appMemoryTargetContextSchemaId
                        : input.memoryTargetContextSchemaId
                    : spec.agentRuntimeId === "CLAUDE_CODE_APP"
                      ? input.appTargetContextSchemaId
                      : input.targetContextSchemaId,
            requiredFacts: spec.requiredFacts,
        },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(spec.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

function materializeParentNative(spec: ExactTargetSpec, input: ExactRebaseInput): { nativeText: string } | null {
    if (spec.assetKind === "Memory") return materializeMemoryParentNative(input);
    // Core projects only one validated entry/native parent; Rule and Workflow accept no restoration payload.
    const entry = input.targetFiles[0] as ExactTextEntry;
    const parent = splitNativeDocument(spec.assetKind, input.parent.file.text);
    const targetBody = nativeBodyForCanonicalEntry(spec.assetKind, entry.text);
    if (parent === null || targetBody === null || !parentBehaviorMatchesTarget(input, parent.canonicalEntryText)) {
        return null;
    }
    return { nativeText: `${parent.prefix}${targetBody}` };
}

function materializeMemoryParentNative(input: ExactRebaseInput): { nativeText: string } | null {
    const canonical = input.targetCanonical;
    if (canonical.kind === "Memory" && canonical.typeData.entityRole === "catalog") {
        return materializeMemoryCatalogParentNative(input);
    }
    const entry = input.targetFiles[0] as ExactTextEntry | undefined;
    const restoration = memoryRestorationInput(input);
    const parentText = input.parent.file.text;
    const parsed = parseClaudeFrontmatter(parentText);
    if (
        entry === undefined ||
        entry.contentKind !== "text" ||
        canonical.kind !== "Memory" ||
        canonical.typeData.entityRole !== "unit" ||
        restoration === null ||
        !memoryRestorationMatchesParent(restoration, parsed) ||
        !parsed.hasFrontmatter ||
        !parsed.closed ||
        parsed.diagnostics.length !== 0 ||
        parsed.body.trim() === "" ||
        entry.text.trim() === ""
    ) {
        return null;
    }
    const nativeText = rewriteMemoryTopic(
        parentText,
        parsed.body,
        input.parent.file.relativePath,
        frontmatterString(parsed, "name"),
        frontmatterString(parsed, "description"),
        canonical.typeData.card.name,
        canonical.typeData.card.description,
        entry.text,
    );
    return nativeText !== null && nativeTextMatchesTarget(input, nativeText) ? { nativeText } : null;
}

function materializeMemoryCatalogParentNative(input: ExactRebaseInput): { nativeText: string } | null {
    if (
        input.targetCanonical.kind !== "Memory" ||
        input.targetCanonical.typeData.entityRole !== "catalog" ||
        input.targetFiles.length !== 0 ||
        input.restorationInputs.length !== 0 ||
        input.parent.file.relativePath !== "MEMORY.md" ||
        input.memoryCatalogMembers.length !== input.targetCanonical.typeData.members.length
    ) {
        return null;
    }
    const nativeText = rewriteMemoryCatalog(input.parent.file.text, input.memoryCatalogMembers);
    return nativeText !== null && nativeTextMatchesTarget(input, nativeText) ? { nativeText } : null;
}

function parentBehaviorMatchesTarget(input: ExactRebaseInput, parentCanonicalEntryText: string): boolean {
    const entry = input.targetFiles[0] as ExactTextEntry;
    const { text: parentText, ...descriptor } = input.parent.file;
    return validateClaudeCodeNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: [{ ...entry, text: parentCanonicalEntryText }],
        representation: { ...input.parent.representation, files: [descriptor] },
        nativeFiles: [
            {
                relativePath: input.parent.file.relativePath,
                bytes: new TextEncoder().encode(parentText),
            },
        ],
    });
}

function splitNativeDocument(kind: ExactAssetKind, nativeText: string): { prefix: string; canonicalEntryText: string } | null {
    const parsed = parseClaudeFrontmatter(nativeText);
    if (!parsed.hasFrontmatter) {
        return (kind === "Rule" || kind === "Workflow") && nativeText.trim() !== ""
            ? { prefix: "", canonicalEntryText: nativeText }
            : null;
    }
    if (!parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    const prefix = nativeText.slice(0, nativeText.length - parsed.body.length);
    const canonicalEntryText = canonicalEntryForNativeBody(kind, parsed.body);
    return canonicalEntryText === null ? null : { prefix, canonicalEntryText };
}

function canonicalEntryForNativeBody(kind: ExactAssetKind, body: string): string | null {
    return kind === "Rule" || kind === "Workflow" || kind === "Memory" ? body : null;
}

function nativeBodyForCanonicalEntry(kind: ExactAssetKind, entryText: string): string | null {
    return (kind === "Rule" || kind === "Workflow" || kind === "Memory") && entryText.trim() !== "" ? entryText : null;
}

function isExactProjectPath(
    kind: ExactAssetKind,
    relativePath: PosixRelativePath,
    memoryRole: "unit" | "catalog" | undefined,
): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    const fileName = segments.at(-1) ?? "";
    if (!fileName.endsWith(".md") || fileName === ".md") return false;
    if (kind === "Memory") {
        return memoryRole === "catalog" ? relativePath === "MEMORY.md" : segments[0] !== "team" && fileName !== "MEMORY.md";
    }
    return segments.length >= 3 && segments[0] === ".claude" && segments[1] === (kind === "Rule" ? "rules" : "commands");
}

export function parseClaudeMemoryTopicRestorationPayload(bytes: Uint8Array): ClaudeMemoryTopicRestorationPayload | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const expected = [
            "dialectId",
            "metadataNodeType",
            "metadataOriginSessionId",
            "metadataType",
            "schemaVersion",
            "topLevelType",
        ].sort();
        if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
        if (
            record.schemaVersion !== 1 ||
            record.dialectId !== CLAUDECODE_NATIVE_DIALECTS.memoryTopic ||
            typeof record.topLevelType !== "string" ||
            typeof record.metadataType !== "string" ||
            typeof record.metadataOriginSessionId !== "string" ||
            typeof record.metadataNodeType !== "string"
        ) {
            return null;
        }
        const recognized = new Set(["user", "feedback", "project", "reference"]);
        if (
            !(
                (record.topLevelType !== "" && recognized.has(record.topLevelType)) ||
                (record.metadataType !== "" && recognized.has(record.metadataType))
            ) ||
            (record.topLevelType !== "" && record.metadataType !== "" && record.topLevelType !== record.metadataType)
        ) {
            return null;
        }
        return record as unknown as ClaudeMemoryTopicRestorationPayload;
    } catch {
        return null;
    }
}

function memoryRestorationInput(input: ExactRebaseInput): ClaudeMemoryTopicRestorationPayload | null {
    const restoration = input.restorationInputs[0];
    return input.restorationInputs.length === 1 &&
        restoration?.restoration.dialectId === CLAUDECODE_NATIVE_DIALECTS.memoryTopic &&
        restoration.content.contentKind === "binary"
        ? parseClaudeMemoryTopicRestorationPayload(restoration.content.bytes)
        : null;
}

function memoryRestorationMatchesParent(
    restoration: ClaudeMemoryTopicRestorationPayload,
    parsed: ReturnType<typeof parseClaudeFrontmatter>,
): boolean {
    const metadata = frontmatterStringMap(parsed, "metadata") ?? {};
    return (
        (frontmatterString(parsed, "type")?.trim() ?? "") === restoration.topLevelType &&
        (metadata.type?.trim() ?? "") === restoration.metadataType &&
        (metadata.originSessionId ?? "") === restoration.metadataOriginSessionId &&
        (metadata.node_type ?? "") === restoration.metadataNodeType
    );
}

function rewriteMemoryTopic(
    parentText: string,
    parentBody: string,
    relativePath: PosixRelativePath,
    parentName: string | undefined,
    parentDescription: string | undefined,
    targetName: string,
    targetDescription: string,
    targetBody: string,
): string | null {
    const prefixLength = parentText.length - parentBody.length;
    const prefix = parentText.slice(0, prefixLength);
    if (!prefix.startsWith("---\n")) return null;
    const closingStart = prefix.lastIndexOf("\n---");
    if (closingStart < 4) return null;
    const closingSuffix = prefix.slice(closingStart);
    if (!closingSuffix.startsWith("\n---\n")) return null;
    const headerLines = prefix.slice(4, closingStart).split("\n");
    const fallbackName = (relativePath.split("/").at(-1) ?? "").replace(/\.md$/u, "");
    if (
        updateTopLevelScalar(
            headerLines,
            "name",
            parentName,
            targetName,
            parentName === undefined && targetName === fallbackName,
        ) === false ||
        updateTopLevelScalar(headerLines, "description", parentDescription, targetDescription, false) === false
    ) {
        return null;
    }
    return `---\n${headerLines.join("\n")}${closingSuffix}${targetBody}`;
}

function rewriteMemoryCatalog(parentText: string, members: ExactRebaseInput["memoryCatalogMembers"]): string | null {
    const parsedParent = parseMemoryIndex(parentText);
    if (parsedParent.issues.length !== 0) return null;
    const hadTrailingNewline = parentText.endsWith("\n");
    const lines = parentText.split("\n");
    if (hadTrailingNewline) lines.pop();
    const memberIndexes = lines.flatMap((line, index) => {
        const parsed = parseMemoryIndex(`${line}\n`);
        return parsed.issues.length === 0 && parsed.members.length === 1 ? [index] : [];
    });
    const rendered = members.map((member) => {
        if (
            member.relativePath.includes("]") ||
            member.relativePath.includes("(") ||
            member.relativePath.includes(")") ||
            member.routingTitle.includes("]") ||
            member.routingTitle.includes("\n") ||
            member.routingHint.includes("\n")
        ) {
            return null;
        }
        return `- [${member.routingTitle}](${member.relativePath})${member.routingHint === "" ? "" : ` — ${member.routingHint}`}`;
    });
    if (rendered.some((line) => line === null)) return null;
    const next = rendered as string[];
    if (memberIndexes.length === 0) {
        if (next.length > 0 && lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
        lines.push(...next);
    } else {
        let consumed = 0;
        const output: string[] = [];
        const memberSet = new Set(memberIndexes);
        for (const [index, line] of lines.entries()) {
            if (!memberSet.has(index)) {
                output.push(line);
                continue;
            }
            if (consumed < next.length) output.push(next[consumed] as string);
            consumed += 1;
            if (index === memberIndexes.at(-1) && next.length > consumed) {
                output.push(...next.slice(consumed));
                consumed = next.length;
            }
        }
        lines.splice(0, lines.length, ...output);
    }
    const result = `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
    const parsedResult = parseMemoryIndex(result);
    return parsedResult.issues.length === 0 && parsedResult.members.length === members.length ? result : null;
}

function updateTopLevelScalar(
    lines: string[],
    key: "name" | "description",
    currentValue: string | undefined,
    targetValue: string,
    missingAlreadyRepresentsTarget: boolean,
): boolean {
    if (targetValue.includes("\0") || targetValue.includes("\n") || targetValue.includes("\r")) return false;
    const matcher = new RegExp(`^${key}[\\t ]*:`);
    const indexes = lines.flatMap((line, index) => (matcher.test(line) ? [index] : []));
    if (indexes.length > 1 || (key === "description" && indexes.length !== 1)) return false;
    if (currentValue === targetValue || (indexes.length === 0 && missingAlreadyRepresentsTarget)) return true;
    const encoded = JSON.stringify(targetValue);
    if (indexes.length === 0) {
        lines.push(`${key}: ${encoded}`);
        return true;
    }
    const index = indexes[0] as number;
    const line = lines[index] as string;
    const colon = line.indexOf(":");
    const comment = trailingYamlComment(line.slice(colon + 1));
    lines[index] = `${line.slice(0, colon + 1)} ${encoded}${comment}`;
    return true;
}

function trailingYamlComment(value: string): string {
    let quoted: "'" | '"' | null = null;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index] as string;
        if (quoted === '"' && character === "\\" && !escaped) {
            escaped = true;
            continue;
        }
        if ((character === '"' || character === "'") && !escaped) {
            quoted = quoted === character ? null : quoted === null ? character : quoted;
        }
        if (character === "#" && quoted === null && (index === 0 || /\s/u.test(value[index - 1] as string))) {
            return ` ${value.slice(index).trimStart()}`;
        }
        escaped = false;
    }
    return "";
}

function nativeTextMatchesTarget(input: ExactRebaseInput, nativeText: string): boolean {
    const bytes = new TextEncoder().encode(nativeText);
    const { text: _text, ...parentDescriptor } = input.parent.file;
    const descriptor = {
        ...parentDescriptor,
        contentHash: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` as const,
        byteSize: bytes.byteLength,
    };
    return validateClaudeCodeNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: [descriptor] },
        nativeFiles: [{ relativePath: input.parent.file.relativePath, bytes }],
    });
}

/** Existing same-entry Markdown-command build evidence, reused by the reviewed graph conversion. */
export function claudeCodeProjectWorkflowSpec(agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP") {
    return SPECS[agentRuntimeId === "CLAUDE_CODE_CLI" ? "Workflow" : "AppWorkflow"];
}
