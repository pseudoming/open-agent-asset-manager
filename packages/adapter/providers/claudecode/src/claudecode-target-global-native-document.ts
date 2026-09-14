/** Claude global Rule and Markdown Workflow native-document targets. */

import { defineDialectComponentV1 as component } from "@oaam/adapter-framework";
import type {
    AgentRuntimeDescriptor,
    NativeGlobalExactGraphProviderSupport,
    NativeProjectExactGraphRebaseInput,
    PosixRelativePath,
    RenderNativeRepresentationFileInput,
} from "@oaam/core";
import { createNativeGlobalExactGraphProviderSupport, createVerifiedNativeGlobalExactGraphBuild } from "@oaam/core/adapter-spi";
import { parseClaudeFrontmatter } from "./claudecode-frontmatter";
import { CLAUDECODE_NATIVE_DIALECTS, validateClaudeCodeNativeDialect } from "./claudecode-source-read";
import { claudeCodeTargetBuildCompatibilityFor } from "./claudecode-target-build-compatibility";
import { CLAUDECODE_EXACT_TARGET_COMPONENTS } from "./claudecode-target-exact-file";
import { nativeDescriptor, textNativeFile, validatesRebasedGraph } from "./claudecode-target-exact-graph-files";

const CLAUDECODE_GLOBAL_NATIVE_DOCUMENT_COMPONENTS = {
    Rule: {
        graph: component("claudecode.global-rule-native-document-graph-v1"),
        reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.rule}.native-to-canonical-parser`),
        rebase: CLAUDECODE_EXACT_TARGET_COMPONENTS.Rule.rebase,
    },
    Workflow: {
        graph: component("claudecode.global-workflow-command-native-document-graph-v1"),
        reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.commandWorkflow}.native-to-canonical-parser`),
        rebase: CLAUDECODE_EXACT_TARGET_COMPONENTS.Workflow.rebase,
    },
} as const;

type GlobalNativeDocumentSupportKey = "Rule" | "AppRule" | "Workflow" | "AppWorkflow";
type GlobalNativeDocumentSpec = {
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
    assetKind: "Rule" | "Workflow";
    nativeDialectId: string;
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey: string;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    fixtureId: string;
    parentRebaseFixtureId: string;
    targetRelativePath: PosixRelativePath;
    exactLoadMarker: string;
    reverseFixtureId: string;
};

const GLOBAL_NATIVE_DOCUMENT_SPECS: Readonly<Record<GlobalNativeDocumentSupportKey, GlobalNativeDocumentSpec>> = {
    Rule: {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        assetKind: "Rule",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.rule,
        outputContractId: "CLAUDECODE_NATIVE_GLOBAL_RULE_EXACT_GRAPH_V1",
        materializationProfileId: "claude-code-cli-global-rule-exact-graph-v1",
        materializerCapabilityKey: "claudecode.global-rule-exact-graph-v1",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-global-rule-exact-graph-2026-08-05",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-global-rule-parent-rebase-v1",
        targetRelativePath: "rules/oaam-phase53-global-rule.md",
        exactLoadMarker: "OAAM_CC_GLOBAL_RULE_20260805_R1",
        reverseFixtureId: "claude-code-global-rule-native-body-reverse-v1",
    },
    AppRule: {
        agentRuntimeId: "CLAUDE_CODE_APP",
        assetKind: "Rule",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.rule,
        outputContractId: "CLAUDECODE_APP_NATIVE_GLOBAL_RULE_EXACT_GRAPH_V1",
        materializationProfileId: "claude-code-app-global-rule-exact-graph-v1",
        materializerCapabilityKey: "claudecode.app-global-rule-exact-graph-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-rule-exact-graph-2026-08-05",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-global-rule-parent-rebase-v1",
        targetRelativePath: "rules/oaam-phase53-app-global-rule.md",
        exactLoadMarker: "OAAM_APP_GLOBAL_RULE_20260805_R1",
        reverseFixtureId: "claude-app-global-rule-native-body-reverse-v1",
    },
    Workflow: {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        assetKind: "Workflow",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
        outputContractId: "CLAUDECODE_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1",
        materializationProfileId: "claude-code-cli-global-workflow-command-graph-v1",
        materializerCapabilityKey: "claudecode.global-workflow-command-exact-graph-v1",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-global-workflow-command-graph-2026-08-05",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-global-workflow-command-parent-rebase-v1",
        targetRelativePath: "commands/oaam-phase53-global-workflow.md",
        exactLoadMarker: "OAAM_CC_GLOBAL_WORKFLOW_20260805_R1",
        reverseFixtureId: "claude-code-global-workflow-command-body-reverse-v1",
    },
    AppWorkflow: {
        agentRuntimeId: "CLAUDE_CODE_APP",
        assetKind: "Workflow",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
        outputContractId: "CLAUDECODE_APP_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1",
        materializationProfileId: "claude-code-app-global-workflow-command-graph-v1",
        materializerCapabilityKey: "claudecode.app-global-workflow-command-exact-graph-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-workflow-command-graph-2026-08-05",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-global-workflow-command-parent-rebase-v1",
        targetRelativePath: "commands/oaam-phase53-app-global-workflow.md",
        exactLoadMarker: "OAAM_APP_GLOBAL_WORKFLOW_20260805_R1",
        reverseFixtureId: "claude-app-global-workflow-command-body-reverse-v1",
    },
};

export function createClaudeCodeGlobalNativeDocumentTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    cliTargetContextSchemaId: string;
    appTargetContextSchemaId: string;
}): Record<GlobalNativeDocumentSupportKey, NativeGlobalExactGraphProviderSupport> {
    return {
        Rule: createGlobalNativeDocumentTargetSupport(GLOBAL_NATIVE_DOCUMENT_SPECS.Rule, input),
        AppRule: createGlobalNativeDocumentTargetSupport(GLOBAL_NATIVE_DOCUMENT_SPECS.AppRule, input),
        Workflow: createGlobalNativeDocumentTargetSupport(GLOBAL_NATIVE_DOCUMENT_SPECS.Workflow, input),
        AppWorkflow: createGlobalNativeDocumentTargetSupport(GLOBAL_NATIVE_DOCUMENT_SPECS.AppWorkflow, input),
    };
}

function createGlobalNativeDocumentTargetSupport(
    spec: GlobalNativeDocumentSpec,
    input: {
        adapterVersion: string;
        agentRuntimes: readonly AgentRuntimeDescriptor[];
        cliTargetContextSchemaId: string;
        appTargetContextSchemaId: string;
    },
): NativeGlobalExactGraphProviderSupport {
    const components = CLAUDECODE_GLOBAL_NATIVE_DOCUMENT_COMPONENTS[spec.assetKind];
    const verifiedBuild = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: spec.agentRuntimeId,
        versionText: spec.versionText,
        buildIdentity: spec.buildIdentity,
        platform: spec.platform,
        materializationProfileId: spec.materializationProfileId,
        fixtureId: spec.fixtureId,
        assetKind: spec.assetKind,
        nativeDialectId: spec.nativeDialectId,
        globalGraphValidator: components.graph,
        reverseParser: components.reverse,
        rebaseMaterializer: components.rebase,
        restorationDialectIds: [],
        parentRebaseFixtureId: spec.parentRebaseFixtureId,
        targetGraphIdentity: spec.targetRelativePath,
        targetRelativePaths: [spec.targetRelativePath],
        exactLoadMarker: spec.exactLoadMarker,
        reverseFixtureId: spec.reverseFixtureId,
    });
    return createNativeGlobalExactGraphProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: spec.agentRuntimeId,
        assetKind: spec.assetKind,
        outputContractId: spec.outputContractId,
        materializationProfileId: spec.materializationProfileId,
        materializerCapabilityKey: spec.materializerCapabilityKey,
        nativeDialectId: spec.nativeDialectId,
        globalGraphValidator: {
            ref: components.graph,
            validate: (files) => projectClaudeCodeGlobalNativeDocument(files, spec),
        },
        reverseParser: {
            ref: components.reverse,
            parse: (parseInput) => parseChangedClaudeCodeNativeDocument(parseInput, spec),
        },
        rebaseMaterializer: {
            ref: components.rebase,
            materialize: (rebaseInput) => materializeClaudeCodeNativeDocumentParent(rebaseInput, spec),
        },
        restorationDialectIds: [],
        target: {
            targetContextSchemaId:
                spec.agentRuntimeId === "CLAUDE_CODE_APP" ? input.appTargetContextSchemaId : input.cliTargetContextSchemaId,
            requiredFacts: {},
        },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(spec.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

function projectClaudeCodeGlobalNativeDocument(
    files: readonly RenderNativeRepresentationFileInput[],
    spec: Pick<GlobalNativeDocumentSpec, "assetKind" | "nativeDialectId">,
): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    if (files.length !== 1) return null;
    const file = files[0];
    if (
        file?.contentKind !== "text" ||
        !isGlobalNativeDocumentPath(spec.assetKind, file.relativePath) ||
        splitClaudeCodeNativeDocument(file.text) === null
    ) {
        return null;
    }
    return {
        graphIdentityRelativePath: file.relativePath,
        files: [
            {
                nativeRelativePath: file.relativePath,
                canonicalLogicalPath: spec.assetKind === "Rule" ? "RULE.md" : "WORKFLOW.md",
            },
        ],
        managedDirectoryBoundaries: [],
    };
}

export function materializeClaudeCodeNativeDocumentParent(
    input: NativeProjectExactGraphRebaseInput,
    spec: Pick<GlobalNativeDocumentSpec, "assetKind" | "nativeDialectId">,
    scope: "project" | "global" = "global",
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== spec.assetKind ||
        input.nativeDialectId !== spec.nativeDialectId ||
        input.targetCanonical.kind !== spec.assetKind ||
        input.restorationInputs.length !== 0 ||
        input.parent.files.length !== 1 ||
        input.targetFiles.length !== 1
    ) {
        return null;
    }
    const parent = input.parent.files[0];
    const target = input.targetFiles[0];
    if (
        parent?.contentKind !== "text" ||
        target?.contentKind !== "text" ||
        target.file.role !== "entry" ||
        target.file.logicalPath !== (spec.assetKind === "Rule" ? "RULE.md" : "WORKFLOW.md") ||
        !isGlobalNativeDocumentPath(spec.assetKind, parent.relativePath, scope)
    ) {
        return null;
    }
    const parsed = splitClaudeCodeNativeDocument(parent.text);
    if (parsed === null) return null;
    if (
        !validateClaudeCodeNativeDialect({
            canonical: input.targetCanonical,
            canonicalFiles: [{ ...target, text: parsed.canonicalEntryText }],
            representation: { ...input.parent.representation, files: [nativeDescriptor(parent)] },
            nativeFiles: [{ relativePath: parent.relativePath, bytes: new TextEncoder().encode(parent.text) }],
        })
    ) {
        return null;
    }
    const nativeFiles = [
        textNativeFile(parent.relativePath, `${parsed.prefix}${target.text}`, target.file.mediaType, target.file.executable),
    ];
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

export function parseChangedClaudeCodeNativeDocument(
    input: {
        assetKind: "Rule" | "Workflow" | "Skill" | "Subagent";
        nativeDialectId: string;
        relativePath: PosixRelativePath;
        appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
        currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    },
    spec: Pick<GlobalNativeDocumentSpec, "assetKind" | "nativeDialectId">,
    scope: "project" | "global" = "global",
) {
    if (
        input.assetKind !== spec.assetKind ||
        input.nativeDialectId !== spec.nativeDialectId ||
        input.appliedContent.contentKind !== "text" ||
        input.currentContent.contentKind !== "text" ||
        !isGlobalNativeDocumentPath(spec.assetKind, input.relativePath, scope)
    ) {
        return null;
    }
    const applied = splitClaudeCodeNativeDocument(input.appliedContent.text);
    const current = splitClaudeCodeNativeDocument(input.currentContent.text);
    return applied === null || current === null || applied.prefix !== current.prefix
        ? null
        : { canonicalContent: { contentKind: "text" as const, text: current.canonicalEntryText } };
}

export function splitClaudeCodeNativeDocument(nativeText: string): { prefix: string; canonicalEntryText: string } | null {
    const parsed = parseClaudeFrontmatter(nativeText);
    if (!parsed.hasFrontmatter) {
        return nativeText.trim() === "" ? null : { prefix: "", canonicalEntryText: nativeText };
    }
    if (!parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    const prefix = nativeText.slice(0, nativeText.length - parsed.body.length);
    return { prefix, canonicalEntryText: parsed.body };
}

function isGlobalNativeDocumentPath(
    assetKind: "Rule" | "Workflow",
    relativePath: PosixRelativePath,
    scope: "project" | "global" = "global",
): boolean {
    const prefix = (scope === "project" ? ".claude/" : "") + (assetKind === "Rule" ? "rules/" : "commands/");
    if (
        !relativePath.startsWith(prefix) ||
        !relativePath.endsWith(".md") ||
        relativePath.includes("\0") ||
        relativePath.includes("\\")
    ) {
        return false;
    }
    const segments = relativePath.split("/");
    return segments.length >= 2 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Existing same-entry global Markdown-command build evidence. */
export function claudeCodeGlobalWorkflowSpec(agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP") {
    return GLOBAL_NATIVE_DOCUMENT_SPECS[agentRuntimeId === "CLAUDE_CODE_CLI" ? "Workflow" : "AppWorkflow"];
}
