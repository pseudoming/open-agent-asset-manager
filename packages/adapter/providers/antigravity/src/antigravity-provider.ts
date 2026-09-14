/** Antigravity adapter family: verified source reads, target writes fail closed. */

import { defineAdapterProvider, adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterAssetTargetCapability,
    AgentRuntimeDescriptor,
    AssetKind,
    OperationDiagnostic,
    RenderAnalysisInput,
} from "@oaam/core";
import { createNativeProjectGuidanceProviderSupport, createVerifiedNativeProjectGuidanceBuild } from "@oaam/core/adapter-spi";
import { makeAntigravitySourceCapabilities, ideSubagentUnsupportedDiagnostic } from "./antigravity-source-capabilities";
import { ANTIGRAVITY_DIALECT_CONTRACTS } from "./antigravity-dialects";
import { probeAntigravity } from "./antigravity-probe";
import { ANTIGRAVITY_SOURCE_READ } from "./antigravity-source-read";
import {
    ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    appendAntigravityBuildCompatibilityWarning,
} from "./antigravity-target-build-compatibility";
import {
    createAntigravityAppRuleTargetSupport,
    createAntigravityIdeRuleTargetSupport,
    createAntigravityRuleTargetSupport,
} from "./antigravity-target-exact-rule";
import {
    createAntigravityAppGuidanceTargetSupports,
    createAntigravityIdeGuidanceTargetSupports,
} from "./antigravity-target-ide-guidance";
import {
    analyzeAntigravitySkillTargets,
    createAntigravityAppSkillTargetSupports,
    createAntigravityIdeSkillTargetSupports,
    createAntigravitySkillTargetSupports,
    selectAntigravitySkillTargetSupport,
} from "./antigravity-target-skill";
import {
    analyzeAntigravitySubagentTargets,
    createAntigravityAppSubagentTargetSupports,
    createAntigravitySubagentTargetSupports,
    selectAntigravitySubagentTargetSupport,
} from "./antigravity-target-subagent";
import {
    analyzeAntigravityAppWorkflowTargets,
    analyzeAntigravityIdeWorkflowTargets,
    createAntigravityAppWorkflowTargetSupports,
    createAntigravityIdeWorkflowTargetSupports,
    selectAntigravityIdeWorkflowTargetSupport,
} from "./antigravity-target-workflow";

const ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
const AGENT_RUNTIMES: AgentRuntimeDescriptor[] = [
    { agentRuntimeId: "ANTIGRAVITY_CLI", displayName: "Antigravity CLI", entryClass: "cli" },
    { agentRuntimeId: "ANTIGRAVITY_APP", displayName: "Antigravity App", entryClass: "app" },
    { agentRuntimeId: "ANTIGRAVITY_IDE", displayName: "Antigravity IDE", entryClass: "ide" },
];
const PROVIDER_VERSION = "0.8.0";
const PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "ANTIGRAVITY_NATIVE_PROJECT_GUIDANCE_V1";
const PROJECT_GUIDANCE_PROFILE_ID = "antigravity-cli-project-guidance-v1";
const PROJECT_GUIDANCE_TARGET = {
    relativePath: "AGENTS.md",
    targetContextSchemaId: "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1",
    requiredFacts: {
        "oaam.project-binding": "registered",
    },
} as const;
const VERIFIED_PROJECT_GUIDANCE_BUILDS = [
    createVerifiedNativeProjectGuidanceBuild({
        agentRuntimeId: "ANTIGRAVITY_CLI",
        versionText: "1.1.2",
        buildIdentity: "sha256:70bf6eaf2e82fbb243db999b9c7c61fcf7f6e537f41980650eb2341ed84b24de",
        platform: "wsl",
        materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
        fixtureId: "antigravity-cli-1.1.2-wsl-registered-project-agents-md-2026-07-14",
        targetRelativePath: "AGENTS.md",
        exactLoadMarker: "OAAM_AGY_112_AGENTS_ONLY_7C91E4",
        reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
    }),
    createVerifiedNativeProjectGuidanceBuild({
        agentRuntimeId: "ANTIGRAVITY_CLI",
        versionText: "1.1.11",
        buildIdentity: "sha256:daadeb6c2cb3df1b941beae8b5b4fdb69b6a17c795fcfeb75cebdba9c1578809",
        platform: "wsl",
        materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
        fixtureId: "antigravity-cli-1.1.11-wsl-registered-project-agents-md-2026-08-31",
        targetRelativePath: "AGENTS.md",
        exactLoadMarker: "OAAM_PHASE59_ANTIGRAVITY_WRITEBACK_CHANGED",
        reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
    }),
];
const GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
    adapterId: "ANTIGRAVITY",
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    agentRuntimeId: "ANTIGRAVITY_CLI",
    outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
    materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
    target: PROJECT_GUIDANCE_TARGET,
    buildCompatibility: ANTIGRAVITY_CLI_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: VERIFIED_PROJECT_GUIDANCE_BUILDS,
});
const RULE_TARGET_SUPPORT = createAntigravityRuleTargetSupport({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    targetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
});
const SKILL_TARGET_SUPPORT = createAntigravitySkillTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
});
const SUBAGENT_TARGET_SUPPORT = createAntigravitySubagentTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    globalTargetContextSchemaId: SKILL_TARGET_SUPPORT.globalFolder.targetContextSchema.targetContextSchemaId,
});
const IDE_GUIDANCE_TARGET_SUPPORT = createAntigravityIdeGuidanceTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
});
const IDE_RULE_TARGET_SUPPORT = createAntigravityIdeRuleTargetSupport({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    targetContextSchemaId: IDE_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
});
const IDE_SKILL_TARGET_SUPPORT = createAntigravityIdeSkillTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: IDE_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
});
const IDE_WORKFLOW_TARGET_SUPPORT = createAntigravityIdeWorkflowTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: IDE_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
    globalTargetContextSchemaId: IDE_GUIDANCE_TARGET_SUPPORT.global.targetContextSchema.targetContextSchemaId,
});
const APP_GUIDANCE_TARGET_SUPPORT = createAntigravityAppGuidanceTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
});
const APP_RULE_TARGET_SUPPORT = createAntigravityAppRuleTargetSupport({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    targetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
});
const APP_SKILL_TARGET_SUPPORT = createAntigravityAppSkillTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
});
const APP_WORKFLOW_TARGET_SUPPORT = createAntigravityAppWorkflowTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
    globalTargetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.global.targetContextSchema.targetContextSchemaId,
});
const APP_SUBAGENT_TARGET_SUPPORT = createAntigravityAppSubagentTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema.targetContextSchemaId,
    globalTargetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.global.targetContextSchema.targetContextSchemaId,
});
const SOURCE_CAPABILITIES = makeAntigravitySourceCapabilities(AGENT_RUNTIMES);

export const antigravityProvider = defineAdapterProvider({
    adapterId: "ANTIGRAVITY",
    displayName: "Antigravity",
    version: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    targetContextSchemas: [
        GUIDANCE_TARGET_SUPPORT.targetContextSchema,
        SKILL_TARGET_SUPPORT.globalFolder.targetContextSchema,
        IDE_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema,
        IDE_GUIDANCE_TARGET_SUPPORT.global.targetContextSchema,
        APP_GUIDANCE_TARGET_SUPPORT.project.targetContextSchema,
        APP_GUIDANCE_TARGET_SUPPORT.global.targetContextSchema,
    ],
    assetSourceCapabilities: SOURCE_CAPABILITIES,
    assetTargetCapabilities: makeTargetCapabilities(),
    materializerCapabilities: [
        GUIDANCE_TARGET_SUPPORT.materializerCapability,
        RULE_TARGET_SUPPORT.materializerCapability,
        SKILL_TARGET_SUPPORT.projectFolder.materializerCapability,
        SKILL_TARGET_SUPPORT.globalFolder.materializerCapability,
        SUBAGENT_TARGET_SUPPORT.project.materializerCapability,
        SUBAGENT_TARGET_SUPPORT.global.materializerCapability,
        IDE_GUIDANCE_TARGET_SUPPORT.project.materializerCapability,
        IDE_GUIDANCE_TARGET_SUPPORT.global.materializerCapability,
        IDE_RULE_TARGET_SUPPORT.materializerCapability,
        IDE_WORKFLOW_TARGET_SUPPORT.project.materializerCapability,
        IDE_WORKFLOW_TARGET_SUPPORT.global.materializerCapability,
        IDE_SKILL_TARGET_SUPPORT.projectFolder.materializerCapability,
        IDE_SKILL_TARGET_SUPPORT.globalFolder.materializerCapability,
        APP_GUIDANCE_TARGET_SUPPORT.project.materializerCapability,
        APP_GUIDANCE_TARGET_SUPPORT.global.materializerCapability,
        APP_RULE_TARGET_SUPPORT.materializerCapability,
        APP_WORKFLOW_TARGET_SUPPORT.project.materializerCapability,
        APP_WORKFLOW_TARGET_SUPPORT.global.materializerCapability,
        APP_SKILL_TARGET_SUPPORT.projectFolder.materializerCapability,
        APP_SKILL_TARGET_SUPPORT.globalFolder.materializerCapability,
        APP_SUBAGENT_TARGET_SUPPORT.project.materializerCapability,
        APP_SUBAGENT_TARGET_SUPPORT.global.materializerCapability,
    ],
    renderContractDeclarations: [
        GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
        RULE_TARGET_SUPPORT.renderContractDeclaration,
        SKILL_TARGET_SUPPORT.projectFolder.renderContractDeclaration,
        SKILL_TARGET_SUPPORT.globalFolder.renderContractDeclaration,
        SUBAGENT_TARGET_SUPPORT.project.renderContractDeclaration,
        SUBAGENT_TARGET_SUPPORT.global.renderContractDeclaration,
        IDE_GUIDANCE_TARGET_SUPPORT.project.renderContractDeclaration,
        IDE_GUIDANCE_TARGET_SUPPORT.global.renderContractDeclaration,
        IDE_RULE_TARGET_SUPPORT.renderContractDeclaration,
        IDE_WORKFLOW_TARGET_SUPPORT.project.renderContractDeclaration,
        IDE_WORKFLOW_TARGET_SUPPORT.global.renderContractDeclaration,
        IDE_SKILL_TARGET_SUPPORT.projectFolder.renderContractDeclaration,
        IDE_SKILL_TARGET_SUPPORT.globalFolder.renderContractDeclaration,
        APP_GUIDANCE_TARGET_SUPPORT.project.renderContractDeclaration,
        APP_GUIDANCE_TARGET_SUPPORT.global.renderContractDeclaration,
        APP_RULE_TARGET_SUPPORT.renderContractDeclaration,
        APP_WORKFLOW_TARGET_SUPPORT.project.renderContractDeclaration,
        APP_WORKFLOW_TARGET_SUPPORT.global.renderContractDeclaration,
        APP_SKILL_TARGET_SUPPORT.projectFolder.renderContractDeclaration,
        APP_SKILL_TARGET_SUPPORT.globalFolder.renderContractDeclaration,
        APP_SUBAGENT_TARGET_SUPPORT.project.renderContractDeclaration,
        APP_SUBAGENT_TARGET_SUPPORT.global.renderContractDeclaration,
    ],
    canonicalMaterializationValidators: [
        ...Object.values(SKILL_TARGET_SUPPORT),
        ...Object.values(IDE_SKILL_TARGET_SUPPORT),
        ...Object.values(APP_SKILL_TARGET_SUPPORT),
        ...Object.values(SUBAGENT_TARGET_SUPPORT),
        ...Object.values(APP_SUBAGENT_TARGET_SUPPORT),
        ...Object.values(IDE_WORKFLOW_TARGET_SUPPORT),
        ...Object.values(APP_WORKFLOW_TARGET_SUPPORT),
    ].flatMap((support) => support.canonicalMaterializationValidators),
    dialectContracts: ANTIGRAVITY_DIALECT_CONTRACTS,
    sourceRead: ANTIGRAVITY_SOURCE_READ,

    async probe(context) {
        return probeAntigravity(context);
    },
    targetRender: {
        consumers: [
            {
                agentRuntimeId: "ANTIGRAVITY_CLI",
                assetKind: "Guidance",
                analyze: async (input) =>
                    appendAntigravityBuildCompatibilityWarning(
                        GUIDANCE_TARGET_SUPPORT.analyze(input),
                        input,
                        GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "ANTIGRAVITY_CLI",
                assetKind: "Rule",
                analyze: async (input) =>
                    appendAntigravityBuildCompatibilityWarning(
                        RULE_TARGET_SUPPORT.analyze(input),
                        input,
                        RULE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "ANTIGRAVITY_CLI",
                assetKind: "Skill",
                analyze: async (input) => {
                    const result = await analyzeAntigravitySkillTargets(input, SKILL_TARGET_SUPPORT);
                    const support = selectAntigravitySkillTargetSupport(input, SKILL_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_CLI",
                assetKind: "Subagent",
                analyze: async (input) => {
                    const result = await analyzeAntigravitySubagentTargets(input, SUBAGENT_TARGET_SUPPORT);
                    const support = selectAntigravitySubagentTargetSupport(input, SUBAGENT_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_APP",
                assetKind: "Guidance",
                analyze: async (input) => {
                    const support = selectScopeSupport(input, APP_GUIDANCE_TARGET_SUPPORT);
                    const result = support === null ? failAmbiguousScope(input, "Guidance", "App") : await support.analyze(input);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_APP",
                assetKind: "Rule",
                analyze: async (input) =>
                    appendAntigravityBuildCompatibilityWarning(
                        APP_RULE_TARGET_SUPPORT.analyze(input),
                        input,
                        APP_RULE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "ANTIGRAVITY_APP",
                assetKind: "Workflow",
                analyze: async (input) => {
                    const result = await analyzeAntigravityAppWorkflowTargets(input, APP_WORKFLOW_TARGET_SUPPORT);
                    const support = selectAntigravityIdeWorkflowTargetSupport(input, APP_WORKFLOW_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_APP",
                assetKind: "Skill",
                analyze: async (input) => {
                    const result = await analyzeAntigravitySkillTargets(input, APP_SKILL_TARGET_SUPPORT);
                    const support = selectAntigravitySkillTargetSupport(input, APP_SKILL_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_APP",
                assetKind: "Subagent",
                analyze: async (input) => {
                    const result = await analyzeAntigravitySubagentTargets(input, APP_SUBAGENT_TARGET_SUPPORT);
                    const support = selectAntigravitySubagentTargetSupport(input, APP_SUBAGENT_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_IDE",
                assetKind: "Guidance",
                analyze: async (input) => {
                    const support = selectScopeSupport(input, IDE_GUIDANCE_TARGET_SUPPORT);
                    const result = support === null ? failAmbiguousScope(input, "Guidance", "IDE") : await support.analyze(input);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_IDE",
                assetKind: "Rule",
                analyze: async (input) =>
                    appendAntigravityBuildCompatibilityWarning(
                        IDE_RULE_TARGET_SUPPORT.analyze(input),
                        input,
                        IDE_RULE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "ANTIGRAVITY_IDE",
                assetKind: "Workflow",
                analyze: async (input) => {
                    const result = await analyzeAntigravityIdeWorkflowTargets(input, IDE_WORKFLOW_TARGET_SUPPORT);
                    const support = selectAntigravityIdeWorkflowTargetSupport(input, IDE_WORKFLOW_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
            {
                agentRuntimeId: "ANTIGRAVITY_IDE",
                assetKind: "Skill",
                analyze: async (input) => {
                    const result = await analyzeAntigravitySkillTargets(input, IDE_SKILL_TARGET_SUPPORT);
                    const support = selectAntigravitySkillTargetSupport(input, IDE_SKILL_TARGET_SUPPORT);
                    return support === null
                        ? result
                        : appendAntigravityBuildCompatibilityWarning(result, input, support.renderContractDeclaration);
                },
            },
        ],
        materializers: [
            {
                outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materialize: async (input) => GUIDANCE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => GUIDANCE_TARGET_SUPPORT.inspect(input),
            },
            {
                outputContractId: RULE_TARGET_SUPPORT.materializerCapability.outputContractId,
                materialize: async (input) => RULE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => RULE_TARGET_SUPPORT.inspect(input),
            },
            ...Object.values(SKILL_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(SUBAGENT_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(IDE_GUIDANCE_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            {
                outputContractId: IDE_RULE_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                materialize: async (input) => IDE_RULE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => IDE_RULE_TARGET_SUPPORT.inspect(input),
            },
            ...Object.values(IDE_WORKFLOW_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(IDE_SKILL_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(APP_GUIDANCE_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            {
                outputContractId: APP_RULE_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                materialize: async (input) => APP_RULE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => APP_RULE_TARGET_SUPPORT.inspect(input),
            },
            ...Object.values(APP_WORKFLOW_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(APP_SKILL_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(APP_SUBAGENT_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
        ],
    },
});

function makeTargetCapabilities(): AdapterAssetTargetCapability[] {
    return AGENT_RUNTIMES.flatMap((descriptor) =>
        ASSET_KINDS.flatMap((assetKind): AdapterAssetTargetCapability[] => {
            if (descriptor.agentRuntimeId === "ANTIGRAVITY_CLI") {
                if (assetKind === "Guidance") return [GUIDANCE_TARGET_SUPPORT.targetCapability];
                if (assetKind === "Rule") return [RULE_TARGET_SUPPORT.targetCapability];
                if (assetKind === "Workflow") {
                    return [
                        {
                            agentRuntimeId: descriptor.agentRuntimeId,
                            entrySupportStatus: "unsupported",
                            assetKind,
                            diagnostics: [cliWorkflowTargetUnsupportedDiagnostic()],
                        },
                    ];
                }
                if (assetKind === "Skill") {
                    return Object.values(SKILL_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Subagent") {
                    return Object.values(SUBAGENT_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
            }
            if (descriptor.agentRuntimeId === "ANTIGRAVITY_APP") {
                if (assetKind === "Guidance") {
                    return Object.values(APP_GUIDANCE_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Rule") return [APP_RULE_TARGET_SUPPORT.targetCapability];
                if (assetKind === "Workflow") {
                    return Object.values(APP_WORKFLOW_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Skill") {
                    return Object.values(APP_SKILL_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Subagent") {
                    return Object.values(APP_SUBAGENT_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
            }
            if (descriptor.agentRuntimeId === "ANTIGRAVITY_IDE") {
                if (assetKind === "Guidance") {
                    return Object.values(IDE_GUIDANCE_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Rule") return [IDE_RULE_TARGET_SUPPORT.targetCapability];
                if (assetKind === "Workflow") {
                    return Object.values(IDE_WORKFLOW_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Skill") {
                    return Object.values(IDE_SKILL_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (assetKind === "Subagent") {
                    return [
                        {
                            agentRuntimeId: descriptor.agentRuntimeId,
                            entrySupportStatus: "unsupported",
                            assetKind,
                            diagnostics: [ideSubagentUnsupportedDiagnostic("render")],
                        },
                    ];
                }
            }
            return [
                {
                    agentRuntimeId: descriptor.agentRuntimeId,
                    entrySupportStatus: "unsupported" as const,
                    assetKind: "Memory" as const,
                    diagnostics: [
                        diagnostic(
                            "render",
                            "antigravity_memory_unsupported",
                            "Antigravity has no native Memory target",
                            "unsupported",
                            "warning",
                        ),
                    ],
                },
            ];
        }),
    );
}

function selectScopeSupport<T extends { project: unknown; global: unknown }>(
    input: RenderAnalysisInput,
    supports: T,
): T["project"] | T["global"] | null {
    const scopes = new Set(input.deployment.assets.map((asset) => asset.scope));
    if (scopes.size === 1 && scopes.has("project")) return supports.project;
    if (scopes.size === 1 && scopes.has("global")) return supports.global;
    return null;
}

function failAmbiguousScope(input: RenderAnalysisInput, assetKind: AssetKind, entry: "App" | "IDE") {
    const slug = entry.toLowerCase();
    const item = diagnostic(
        "render",
        `antigravity_${slug}_target_scope_ambiguous`,
        `One Antigravity ${entry} ${assetKind} Deployment must use one exact Project or Global scope`,
        "conflict",
        "error",
    );
    return {
        status: "failed" as const,
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: item.code,
            diagnostics: [item],
        })),
        diagnostics: [item],
    };
}

function cliWorkflowTargetUnsupportedDiagnostic(): OperationDiagnostic {
    return diagnostic(
        "render",
        "antigravity_cli_workflow_target_unsupported_current_loader_absent",
        "Antigravity CLI 1.1.11 does not register Project or Global standalone Workflow paths; source import remains available, and a future build requires new entry-specific evidence before target write",
        "unsupported",
        "error",
    );
}
