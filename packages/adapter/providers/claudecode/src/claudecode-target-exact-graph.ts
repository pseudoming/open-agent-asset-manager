/** Claude Code project Skill and JavaScript Workflow targets over the Core exact-graph contract. */

import { defineDialectComponentV1 as component } from "@oaam/adapter-framework";
import type {
    AgentRuntimeDescriptor,
    NativeGlobalExactGraphProviderSupport,
    NativeProjectExactGraphProviderSupport,
    NativeProjectExactGraphRebaseInput,
    NativeProjectExactGraphRebaseMaterializer,
    PosixRelativePath,
    RenderNativeRepresentationFileInput,
} from "@oaam/core";
import {
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
} from "@oaam/core/adapter-spi";
import { parseClaudeFrontmatter } from "./claudecode-frontmatter";
import { CLAUDECODE_NATIVE_DIALECTS } from "./claudecode-source-read";
import { parseJavaScriptWorkflowMeta } from "./claudecode-source-read-javascript";
import { claudeCodeTargetBuildCompatibilityFor } from "./claudecode-target-build-compatibility";
import { binaryNativeFile, compareText, textNativeFile, validatesRebasedGraph } from "./claudecode-target-exact-graph-files";

export { createClaudeCodeGlobalNativeDocumentTargetSupports } from "./claudecode-target-global-native-document";

import { claudeSkillCanonicalDeclaration, createClaudeSkillCanonicalMaterializer } from "./claudecode-target-skill-canonical";

const ENTRY_NAME = "SKILL.md";
const PROJECT_SKILL_PREFIX = ".claude/skills/";
const OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_PROJECT_SKILL_GRAPH_V1";
const PROFILE_ID = "claude-code-cli-project-skill-graph-v1";
const APP_SKILL_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_PROJECT_SKILL_GRAPH_V1";
const APP_SKILL_PROFILE_ID = "claude-code-app-project-skill-graph-v1";
const WORKFLOW_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1";
const WORKFLOW_PROFILE_ID = "claude-code-cli-project-javascript-workflow-graph-v1";
const APP_WORKFLOW_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1";
const APP_WORKFLOW_PROFILE_ID = "claude-code-app-project-javascript-workflow-graph-v1";
const GLOBAL_WORKFLOW_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1";
const GLOBAL_WORKFLOW_PROFILE_ID = "claude-code-cli-global-javascript-workflow-graph-v1";
const APP_GLOBAL_WORKFLOW_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1";
const APP_GLOBAL_WORKFLOW_PROFILE_ID = "claude-code-app-global-javascript-workflow-graph-v1";
const GLOBAL_SKILL_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_GLOBAL_SKILL_GRAPH_V1";
const GLOBAL_SKILL_PROFILE_ID = "claude-code-cli-global-skill-graph-v1";
const APP_GLOBAL_SKILL_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_GLOBAL_SKILL_GRAPH_V1";
const APP_GLOBAL_SKILL_PROFILE_ID = "claude-code-app-global-skill-graph-v1";

export const CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS = {
    graph: component("claudecode.project-skill-directory-graph-v1"),
    reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.skill}.native-to-canonical-parser`),
    rebase: component("claudecode.project-skill-directory-parent-rebase-v1"),
} as const;

export const CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS = {
    graph: component("claudecode.project-javascript-workflow-graph-v1"),
    reverse: component(`${CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow}.native-to-canonical-parser`),
    rebase: component("claudecode.project-javascript-workflow-parent-rebase-v1"),
} as const;

export const CLAUDECODE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS = {
    graph: component("claudecode.global-javascript-workflow-graph-v1"),
    reverse: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.reverse,
    rebase: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.rebase,
} as const;

export const CLAUDECODE_GLOBAL_SKILL_GRAPH_TARGET_COMPONENTS = {
    graph: component("claudecode.global-skill-directory-graph-v1"),
    reverse: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
    rebase: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
} as const;

export function createClaudeCodeJavaScriptWorkflowGraphTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactGraphProviderSupport {
    return createProjectJavaScriptWorkflowGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: WORKFLOW_OUTPUT_CONTRACT_ID,
        materializationProfileId: WORKFLOW_PROFILE_ID,
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-project-javascript-workflow-graph-2026-08-03",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-javascript-workflow-graph-parent-rebase-v1",
        targetBoundary: ".claude/workflows/oaam-phase53-js-graph",
        exactLoadMarker: "OAAM_CC_JS_WORKFLOW_GRAPH_ORIGINAL_4F2A91",
        reverseFixtureId: "claude-code-project-javascript-workflow-graph-existing-files-reverse-v1",
    });
}

export function createClaudeCodeAppJavaScriptWorkflowGraphTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactGraphProviderSupport {
    return createProjectJavaScriptWorkflowGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_WORKFLOW_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_WORKFLOW_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-project-javascript-workflow-exact-graph-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-javascript-workflow-graph-2026-08-04",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-javascript-workflow-graph-parent-rebase-v1",
        targetBoundary: ".claude/workflows/oaam-phase53-app-js-graph",
        exactLoadMarker: "OAAM_APP_JS_WORKFLOW_GRAPH_ORIGINAL_20260804_R1",
        reverseFixtureId: "claude-app-project-javascript-workflow-graph-existing-files-reverse-v1",
    });
}

function createProjectJavaScriptWorkflowGraphTargetSupport(input: {
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
    targetBoundary: string;
    exactLoadMarker: string;
    reverseFixtureId: string;
}): NativeProjectExactGraphProviderSupport {
    const targetRelativePaths = [
        `${input.targetBoundary}/workflow.js`,
        `${input.targetBoundary}/resources/marker.bin`,
        `${input.targetBoundary}/resources/marker.txt`,
    ] as PosixRelativePath[];
    const verifiedBuild = createVerifiedNativeProjectExactGraphBuild({
        agentRuntimeId: input.agentRuntimeId,
        versionText: input.versionText,
        buildIdentity: input.buildIdentity,
        platform: input.platform,
        materializationProfileId: input.materializationProfileId,
        fixtureId: input.fixtureId,
        assetKind: "Workflow",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
        projectGraphValidator: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.graph,
        reverseParser: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.rebase,
        restorationDialectIds: [],
        parentRebaseFixtureId: input.parentRebaseFixtureId,
        targetGraphIdentity: targetRelativePaths[0] as PosixRelativePath,
        targetRelativePaths,
        exactLoadMarker: input.exactLoadMarker,
        reverseFixtureId: input.reverseFixtureId,
    });
    return createNativeProjectExactGraphProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: "Workflow",
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        materializerCapabilityKey: input.materializerCapabilityKey,
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
        projectGraphValidator: {
            ref: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.graph,
            project: projectClaudeCodeJavaScriptWorkflowGraph,
        },
        reverseParser: {
            ref: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.reverse,
            parse: parseChangedClaudeCodeJavaScriptWorkflowFile,
        },
        rebaseMaterializer: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_REBASE_MATERIALIZER,
        restorationDialectIds: [],
        target: { targetContextSchemaId: input.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(input.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

export function createClaudeCodeGlobalJavaScriptWorkflowGraphTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeGlobalExactGraphProviderSupport {
    return createGlobalJavaScriptWorkflowGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: GLOBAL_WORKFLOW_OUTPUT_CONTRACT_ID,
        materializationProfileId: GLOBAL_WORKFLOW_PROFILE_ID,
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-global-javascript-workflow-graph-2026-08-03",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-global-javascript-workflow-graph-parent-rebase-v1",
        targetBoundary: "workflows/oaam-phase53-global-js-graph",
        exactLoadMarker: "OAAM_CC_GLOBAL_JS_WORKFLOW_GRAPH_ORIGINAL_4F2A91",
        reverseFixtureId: "claude-code-global-javascript-workflow-graph-existing-files-reverse-v1",
    });
}

export function createClaudeCodeAppGlobalJavaScriptWorkflowGraphTargetSupport(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeGlobalExactGraphProviderSupport {
    return createGlobalJavaScriptWorkflowGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_GLOBAL_WORKFLOW_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_GLOBAL_WORKFLOW_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-global-javascript-workflow-exact-graph-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-javascript-workflow-graph-2026-08-05",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-global-javascript-workflow-graph-parent-rebase-v1",
        targetBoundary: "workflows/oaam-phase53-app-global-js-graph",
        exactLoadMarker: "OAAM_APP_GLOBAL_JS_WORKFLOW_GRAPH_20260805_R1",
        reverseFixtureId: "claude-app-global-javascript-workflow-graph-existing-files-reverse-v1",
    });
}

function createGlobalJavaScriptWorkflowGraphTargetSupport(input: {
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
    targetBoundary: string;
    exactLoadMarker: string;
    reverseFixtureId: string;
}): NativeGlobalExactGraphProviderSupport {
    const targetRelativePaths = [
        `${input.targetBoundary}/workflow.js`,
        `${input.targetBoundary}/resources/marker.bin`,
        `${input.targetBoundary}/resources/marker.txt`,
    ] as PosixRelativePath[];
    const verifiedBuild = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: input.agentRuntimeId,
        versionText: input.versionText,
        buildIdentity: input.buildIdentity,
        platform: input.platform,
        materializationProfileId: input.materializationProfileId,
        fixtureId: input.fixtureId,
        assetKind: "Workflow",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
        globalGraphValidator: CLAUDECODE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.graph,
        reverseParser: CLAUDECODE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CLAUDECODE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.rebase,
        restorationDialectIds: [],
        parentRebaseFixtureId: input.parentRebaseFixtureId,
        targetGraphIdentity: targetRelativePaths[0] as PosixRelativePath,
        targetRelativePaths,
        exactLoadMarker: input.exactLoadMarker,
        reverseFixtureId: input.reverseFixtureId,
    });
    return createNativeGlobalExactGraphProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: "Workflow",
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        materializerCapabilityKey: input.materializerCapabilityKey,
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
        globalGraphValidator: {
            ref: CLAUDECODE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.graph,
            validate: projectClaudeCodeGlobalJavaScriptWorkflowGraph,
        },
        reverseParser: {
            ref: CLAUDECODE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.reverse,
            parse: parseChangedClaudeCodeJavaScriptWorkflowFile,
        },
        rebaseMaterializer: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_REBASE_MATERIALIZER,
        restorationDialectIds: [],
        target: { targetContextSchemaId: input.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(input.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

export function createClaudeCodeSkillGraphTargetSupport(input: {
    adapterVersion: string;
    canonicalSkill?: boolean;
    linuxProjectSkill?: boolean;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactGraphProviderSupport {
    return createSkillGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: OUTPUT_CONTRACT_ID,
        materializationProfileId: PROFILE_ID,
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        builds: [
            {
                platform: "wsl",
                fixtureId: "claude-code-cli-2.1.220-wsl-project-skill-directory-2026-08-03",
                parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-project-skill-directory-parent-rebase-v1",
                targetBoundary: ".claude/skills/oaam-phase53-graph-skill",
                exactLoadMarker: "OAAM_CC_21220_SKILL_GRAPH_4F2A91",
                reverseFixtureId: "claude-code-project-skill-directory-existing-files-reverse-v1",
            },
            ...(input.linuxProjectSkill === false
                ? []
                : [
                      {
                          platform: "linux" as const,
                          fixtureId: "claude-code-cli-2.1.220-linux-project-skill-directory-2026-09-15",
                          parentRebaseFixtureId: "claude-code-cli-2.1.220-linux-project-skill-directory-parent-rebase-2026-09-15",
                          targetBoundary: ".claude/skills/oaam-phase60-linux-skill",
                          exactLoadMarker: "OAAM_CC_LINUX_SKILL_GRAPH_ORIGINAL_20260915",
                          reverseFixtureId: "claude-code-linux-project-skill-directory-existing-files-reverse-2026-09-15",
                      },
                  ]),
        ],
    });
}

export function createClaudeCodeAppSkillGraphTargetSupport(input: {
    adapterVersion: string;
    canonicalSkill?: boolean;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeProjectExactGraphProviderSupport {
    return createSkillGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_SKILL_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_SKILL_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-project-skill-exact-graph-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        builds: [
            {
                platform: "win32",
                fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-skill-directory-2026-08-03",
                parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-project-skill-directory-parent-rebase-v1",
                targetBoundary: ".claude/skills/oaam-phase53-app-graph-skill",
                exactLoadMarker: "OAAM_APP_SKILL_GRAPH_LOADED_20260803_R1",
                reverseFixtureId: "claude-app-project-skill-directory-existing-files-reverse-v1",
            },
        ],
    });
}

export function createClaudeCodeGlobalSkillGraphTargetSupport(input: {
    adapterVersion: string;
    canonicalSkill?: boolean;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeGlobalExactGraphProviderSupport {
    return createGlobalSkillGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: GLOBAL_SKILL_OUTPUT_CONTRACT_ID,
        materializationProfileId: GLOBAL_SKILL_PROFILE_ID,
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        fixtureId: "claude-code-cli-2.1.220-wsl-global-skill-directory-2026-08-05",
        parentRebaseFixtureId: "claude-code-cli-2.1.220-wsl-global-skill-directory-parent-rebase-v1",
        targetBoundary: "skills/oaam-phase53-global-graph-skill",
        exactLoadMarker: "OAAM_CC_GLOBAL_SKILL_GRAPH_20260805_R1",
        reverseFixtureId: "claude-code-global-skill-directory-existing-files-reverse-v1",
    });
}

export function createClaudeCodeAppGlobalSkillGraphTargetSupport(input: {
    adapterVersion: string;
    canonicalSkill?: boolean;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): NativeGlobalExactGraphProviderSupport {
    return createGlobalSkillGraphTargetSupport({
        ...input,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_GLOBAL_SKILL_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_GLOBAL_SKILL_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-global-skill-exact-graph-v1",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-skill-directory-2026-08-05",
        parentRebaseFixtureId: "claude-app-engine-2.1.219-win32-global-skill-directory-parent-rebase-v1",
        targetBoundary: "skills/oaam-phase53-app-global-graph-skill",
        exactLoadMarker: "OAAM_APP_GLOBAL_SKILL_GRAPH_20260805_R1",
        reverseFixtureId: "claude-app-global-skill-directory-existing-files-reverse-v1",
    });
}

function createSkillGraphTargetSupport(input: {
    adapterVersion: string;
    canonicalSkill?: boolean;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
    outputContractId: string;
    materializationProfileId: string;
    materializerCapabilityKey?: string;
    versionText: string;
    buildIdentity: `sha256:${string}`;
    builds: readonly {
        platform: "wsl" | "linux" | "win32";
        fixtureId: string;
        parentRebaseFixtureId: string;
        targetBoundary: string;
        exactLoadMarker: string;
        reverseFixtureId: string;
    }[];
}): NativeProjectExactGraphProviderSupport {
    const canonicalMaterializer = input.canonicalSkill === false ? undefined : createClaudeSkillCanonicalMaterializer("project");
    const canonicalDeclaration =
        canonicalMaterializer === undefined
            ? {}
            : { canonicalMaterialization: claudeSkillCanonicalDeclaration(canonicalMaterializer) };
    const verifiedBuilds = input.builds.map((build) => {
        const targetRelativePaths = [
            `${build.targetBoundary}/${ENTRY_NAME}`,
            `${build.targetBoundary}/assets/marker.bin`,
            `${build.targetBoundary}/references/details.md`,
            `${build.targetBoundary}/scripts/marker.py`,
        ];
        return createVerifiedNativeProjectExactGraphBuild({
            agentRuntimeId: input.agentRuntimeId,
            versionText: input.versionText,
            buildIdentity: input.buildIdentity,
            platform: build.platform,
            materializationProfileId: input.materializationProfileId,
            fixtureId: build.fixtureId,
            assetKind: "Skill",
            nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.skill,
            projectGraphValidator: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.graph,
            reverseParser: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
            rebaseMaterializer: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
            ...canonicalDeclaration,
            restorationDialectIds: [],
            parentRebaseFixtureId: build.parentRebaseFixtureId,
            targetGraphIdentity: targetRelativePaths[0] as PosixRelativePath,
            targetRelativePaths: targetRelativePaths as PosixRelativePath[],
            exactLoadMarker: build.exactLoadMarker,
            reverseFixtureId: build.reverseFixtureId,
        });
    });
    return createNativeProjectExactGraphProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: "Skill",
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        materializerCapabilityKey: input.materializerCapabilityKey,
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.skill,
        projectGraphValidator: {
            ref: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.graph,
            project: projectClaudeCodeSkillGraph,
        },
        reverseParser: {
            ref: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
            parse: parseChangedClaudeCodeSkillFile,
        },
        rebaseMaterializer: CLAUDECODE_SKILL_GRAPH_REBASE_MATERIALIZER,
        ...(canonicalMaterializer === undefined ? {} : { canonicalMaterializer }),
        restorationDialectIds: [],
        target: { targetContextSchemaId: input.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(input.agentRuntimeId),
        verifiedBuilds,
    });
}

function createGlobalSkillGraphTargetSupport(input: {
    adapterVersion: string;
    canonicalSkill?: boolean;
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
    targetBoundary: string;
    exactLoadMarker: string;
    reverseFixtureId: string;
}): NativeGlobalExactGraphProviderSupport {
    const canonicalMaterializer = input.canonicalSkill === false ? undefined : createClaudeSkillCanonicalMaterializer("global");
    const canonicalDeclaration =
        canonicalMaterializer === undefined
            ? {}
            : { canonicalMaterialization: claudeSkillCanonicalDeclaration(canonicalMaterializer) };
    const targetRelativePaths = [
        `${input.targetBoundary}/${ENTRY_NAME}`,
        `${input.targetBoundary}/assets/marker.bin`,
        `${input.targetBoundary}/references/details.md`,
        `${input.targetBoundary}/scripts/marker.py`,
    ] as PosixRelativePath[];
    const verifiedBuild = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: input.agentRuntimeId,
        versionText: input.versionText,
        buildIdentity: input.buildIdentity,
        platform: input.platform,
        materializationProfileId: input.materializationProfileId,
        fixtureId: input.fixtureId,
        assetKind: "Skill",
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.skill,
        globalGraphValidator: CLAUDECODE_GLOBAL_SKILL_GRAPH_TARGET_COMPONENTS.graph,
        reverseParser: CLAUDECODE_GLOBAL_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
        rebaseMaterializer: CLAUDECODE_GLOBAL_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
        ...canonicalDeclaration,
        restorationDialectIds: [],
        parentRebaseFixtureId: input.parentRebaseFixtureId,
        targetGraphIdentity: targetRelativePaths[0] as PosixRelativePath,
        targetRelativePaths,
        exactLoadMarker: input.exactLoadMarker,
        reverseFixtureId: input.reverseFixtureId,
    });
    return createNativeGlobalExactGraphProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: "Skill",
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        materializerCapabilityKey: input.materializerCapabilityKey,
        nativeDialectId: CLAUDECODE_NATIVE_DIALECTS.skill,
        globalGraphValidator: {
            ref: CLAUDECODE_GLOBAL_SKILL_GRAPH_TARGET_COMPONENTS.graph,
            validate: projectClaudeCodeGlobalSkillGraph,
        },
        reverseParser: {
            ref: CLAUDECODE_GLOBAL_SKILL_GRAPH_TARGET_COMPONENTS.reverse,
            parse: parseChangedClaudeCodeSkillFile,
        },
        rebaseMaterializer: CLAUDECODE_SKILL_GRAPH_REBASE_MATERIALIZER,
        ...(canonicalMaterializer === undefined ? {} : { canonicalMaterializer }),
        restorationDialectIds: [],
        target: { targetContextSchemaId: input.targetContextSchemaId, requiredFacts: {} },
        buildCompatibility: claudeCodeTargetBuildCompatibilityFor(input.agentRuntimeId),
        verifiedBuilds: [verifiedBuild],
    });
}

export const CLAUDECODE_SKILL_GRAPH_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: CLAUDECODE_SKILL_GRAPH_TARGET_COMPONENTS.rebase,
    materialize: materializeClaudeCodeSkillParentGraph,
};

function projectClaudeCodeSkillGraph(files: readonly RenderNativeRepresentationFileInput[]): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    return projectClaudeCodeSkillGraphForScope(files, "project");
}

function projectClaudeCodeGlobalSkillGraph(files: readonly RenderNativeRepresentationFileInput[]): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    return projectClaudeCodeSkillGraphForScope(files, "global");
}

function projectClaudeCodeSkillGraphForScope(
    files: readonly RenderNativeRepresentationFileInput[],
    targetScope: "project" | "global",
): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = paths.filter((relativePath) => relativePath.endsWith(`/${ENTRY_NAME}`));
    if (entries.length !== 1) return null;
    const [entryPath] = entries as [PosixRelativePath];
    const boundary = entryPath.slice(0, -(ENTRY_NAME.length + 1));
    if (!isSkillBoundary(boundary, targetScope)) return null;
    if (paths.some((relativePath) => !isStrictDescendant(relativePath, boundary))) return null;
    const boundaryRelativePath = boundary as PosixRelativePath;
    return {
        graphIdentityRelativePath: entryPath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: logicalPathWithinBoundary(nativeRelativePath, boundaryRelativePath),
        })),
        managedDirectoryBoundaries: [boundaryRelativePath],
    };
}

const CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_REBASE_MATERIALIZER: NativeProjectExactGraphRebaseMaterializer = {
    ref: CLAUDECODE_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_COMPONENTS.rebase,
    materialize: materializeClaudeCodeJavaScriptWorkflowParentGraph,
};

function projectClaudeCodeJavaScriptWorkflowGraph(files: readonly RenderNativeRepresentationFileInput[]): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    return projectClaudeCodeJavaScriptWorkflowGraphForScope(files, "project");
}

function projectClaudeCodeGlobalJavaScriptWorkflowGraph(files: readonly RenderNativeRepresentationFileInput[]): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    return projectClaudeCodeJavaScriptWorkflowGraphForScope(files, "global");
}

function projectClaudeCodeJavaScriptWorkflowGraphForScope(
    files: readonly RenderNativeRepresentationFileInput[],
    targetScope: "project" | "global",
): {
    graphIdentityRelativePath: PosixRelativePath;
    files: { nativeRelativePath: PosixRelativePath; canonicalLogicalPath: PosixRelativePath }[];
    managedDirectoryBoundaries: PosixRelativePath[];
} | null {
    if (files.length === 0) return null;
    const paths = files.map((file) => file.relativePath);
    if (new Set(paths).size !== paths.length) return null;
    const entries = files.filter(
        (file) =>
            file.contentKind === "text" &&
            isJavaScriptWorkflowTargetPath(file.relativePath, targetScope) &&
            parseJavaScriptWorkflowMeta(file.text).name !== undefined,
    );
    if (entries.length !== 1) return null;
    const [entry] = entries as [Extract<RenderNativeRepresentationFileInput, { contentKind: "text" }>];
    const boundary = parentPath(entry.relativePath);
    if (
        files.length > 1 &&
        (boundary === javascriptWorkflowTargetBase(targetScope) || paths.some((path) => !isStrictDescendant(path, boundary)))
    ) {
        return null;
    }
    const managedDirectoryBoundaries = files.length > 1 ? [boundary as PosixRelativePath] : [];
    return {
        graphIdentityRelativePath: entry.relativePath,
        files: paths.map((nativeRelativePath) => ({
            nativeRelativePath,
            canonicalLogicalPath: logicalPathWithinBoundary(nativeRelativePath, boundary as PosixRelativePath),
        })),
        managedDirectoryBoundaries,
    };
}

function materializeClaudeCodeJavaScriptWorkflowParentGraph(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow ||
        input.targetCanonical.kind !== "Workflow" ||
        input.targetCanonical.typeData.implementation.kind !== "executable" ||
        input.targetCanonical.typeData.implementation.executableDialectId !== CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow ||
        input.restorationInputs.length !== 0
    ) {
        return null;
    }
    const projections = (["project", "global"] as const)
        .map((scope) => projectClaudeCodeJavaScriptWorkflowGraphForScope(input.parent.files, scope))
        .filter((projection) => projection !== null);
    if (projections.length !== 1) return null;
    const [projection] = projections;
    if (projection === null || projection.files.length !== input.targetFiles.length) return null;
    const nativePathByLogicalPath = new Map(
        projection.files.map((mapping) => [mapping.canonicalLogicalPath, mapping.nativeRelativePath]),
    );
    if (
        nativePathByLogicalPath.size !== input.targetFiles.length ||
        input.targetFiles.some((file) => !nativePathByLogicalPath.has(file.file.logicalPath))
    ) {
        return null;
    }
    const nativeFiles = input.targetFiles.map((target) => {
        const relativePath = nativePathByLogicalPath.get(target.file.logicalPath) as PosixRelativePath;
        return target.contentKind === "text"
            ? textNativeFile(relativePath, target.text, target.file.mediaType, target.file.executable)
            : binaryNativeFile(relativePath, target.bytes, target.file.mediaType, target.file.executable);
    });
    nativeFiles.sort((left, right) => compareText(left.relativePath, right.relativePath));
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

function parseChangedClaudeCodeJavaScriptWorkflowFile(input: {
    assetKind: "Workflow";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Workflow" ||
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow ||
        input.appliedContent.contentKind !== input.currentContent.contentKind
    ) {
        return null;
    }
    return input.currentContent.contentKind === "text"
        ? { canonicalContent: { contentKind: "text" as const, text: input.currentContent.text } }
        : { canonicalContent: { contentKind: "binary" as const, bytes: new Uint8Array(input.currentContent.bytes) } };
}

function isJavaScriptWorkflowTargetPath(value: string, targetScope: "project" | "global"): value is PosixRelativePath {
    if (
        !value.startsWith(`${javascriptWorkflowTargetBase(targetScope)}/`) ||
        !value.endsWith(".js") ||
        value.includes("\0") ||
        value.includes("\\")
    ) {
        return false;
    }
    const segments = value.split("/");
    const minimumSegments = targetScope === "project" ? 3 : 2;
    return (
        segments.length >= minimumSegments && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

function javascriptWorkflowTargetBase(targetScope: "project" | "global"): string {
    return targetScope === "project" ? ".claude/workflows" : "workflows";
}

function materializeClaudeCodeSkillParentGraph(
    input: NativeProjectExactGraphRebaseInput,
): { nativeFiles: RenderNativeRepresentationFileInput[] } | null {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.skill ||
        input.targetCanonical.kind !== "Skill" ||
        input.restorationInputs.length !== 0
    ) {
        return null;
    }
    const projections = (["project", "global"] as const)
        .map((scope) => projectClaudeCodeSkillGraphForScope(input.parent.files, scope))
        .filter((projection) => projection !== null);
    if (projections.length !== 1) return null;
    const [projection] = projections;
    if (projection === null) return null;
    const parentByLogicalPath = new Map(
        projection.files.map((mapping) => [
            mapping.canonicalLogicalPath,
            input.parent.files.find((file) => file.relativePath === mapping.nativeRelativePath),
        ]),
    );
    if (
        parentByLogicalPath.size !== input.targetFiles.length ||
        input.targetFiles.some((file) => !parentByLogicalPath.has(file.file.logicalPath))
    ) {
        return null;
    }
    const nativeFiles: RenderNativeRepresentationFileInput[] = [];
    for (const target of input.targetFiles) {
        const parent = parentByLogicalPath.get(target.file.logicalPath);
        if (parent === undefined || parent.contentKind !== target.contentKind) return null;
        const relativePath = projection.files.find(
            (mapping) => mapping.canonicalLogicalPath === target.file.logicalPath,
        )?.nativeRelativePath;
        if (relativePath === undefined) return null;
        if (target.file.role === "entry") {
            if (target.file.logicalPath !== ENTRY_NAME || target.contentKind !== "text" || parent.contentKind !== "text") {
                return null;
            }
            const split = splitSkillDocument(parent.text);
            if (split === null) return null;
            nativeFiles.push(
                textNativeFile(relativePath, `${split.prefix}${target.text}`, target.file.mediaType, target.file.executable),
            );
        } else if (target.contentKind === "text") {
            nativeFiles.push(textNativeFile(relativePath, target.text, target.file.mediaType, target.file.executable));
        } else {
            nativeFiles.push(binaryNativeFile(relativePath, target.bytes, target.file.mediaType, target.file.executable));
        }
    }
    nativeFiles.sort((left, right) => compareText(left.relativePath, right.relativePath));
    return validatesRebasedGraph(input, nativeFiles) ? { nativeFiles } : null;
}

function parseChangedClaudeCodeSkillFile(input: {
    assetKind: "Skill";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== CLAUDECODE_NATIVE_DIALECTS.skill ||
        input.appliedContent.contentKind !== input.currentContent.contentKind
    ) {
        return null;
    }
    if (input.relativePath.endsWith(`/${ENTRY_NAME}`)) {
        if (input.appliedContent.contentKind !== "text" || input.currentContent.contentKind !== "text") return null;
        const applied = splitSkillDocument(input.appliedContent.text);
        const current = splitSkillDocument(input.currentContent.text);
        return applied === null || current === null || applied.prefix !== current.prefix
            ? null
            : { canonicalContent: { contentKind: "text" as const, text: current.body } };
    }
    return input.currentContent.contentKind === "text"
        ? { canonicalContent: { contentKind: "text" as const, text: input.currentContent.text } }
        : { canonicalContent: { contentKind: "binary" as const, bytes: new Uint8Array(input.currentContent.bytes) } };
}

function splitSkillDocument(nativeText: string): { prefix: string; body: string } | null {
    const parsed = parseClaudeFrontmatter(nativeText);
    if (!parsed.hasFrontmatter || !parsed.closed || parsed.diagnostics.length !== 0 || parsed.body.trim() === "") return null;
    return { prefix: nativeText.slice(0, nativeText.length - parsed.body.length), body: parsed.body };
}

function isSkillBoundary(value: string, targetScope: "project" | "global"): boolean {
    const prefix = targetScope === "project" ? PROJECT_SKILL_PREFIX : "skills/";
    if (!value.startsWith(prefix) || value.includes("\0") || value.includes("\\")) return false;
    const segments = value.split("/");
    return (
        segments.length === (targetScope === "project" ? 3 : 2) &&
        (targetScope === "project" ? segments[0] === ".claude" && segments[1] === "skills" : segments[0] === "skills") &&
        segments.at(-1) !== "" &&
        segments.at(-1) !== "." &&
        segments.at(-1) !== ".."
    );
}

function isStrictDescendant(relativePath: string, boundary: string): boolean {
    return relativePath.startsWith(`${boundary}/`) && !relativePath.includes("\0") && !relativePath.includes("\\");
}

function logicalPathWithinBoundary(relativePath: PosixRelativePath, boundary: PosixRelativePath): PosixRelativePath {
    return relativePath.slice(boundary.length + 1) as PosixRelativePath;
}

function parentPath(relativePath: PosixRelativePath): string {
    const separator = relativePath.lastIndexOf("/");
    return separator < 0 ? "" : relativePath.slice(0, separator);
}
