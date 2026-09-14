/** Version-bound OpenCode target composition, shared by current use and retained inspection. */
import { createTargetCoordinator, adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterRetainedInspectionBindingV1,
    AdapterAssetTargetCapability,
    AgentRuntimeDescriptor,
    AssetKind,
} from "@oaam/core";
import { createNativeProjectGuidanceProviderSupport, createVerifiedNativeProjectGuidanceBuild } from "@oaam/core/adapter-spi";
import {
    appendOpencodeBuildCompatibilityWarning,
    OPENCODE_TARGET_BUILD_COMPATIBILITY,
} from "./opencode-target-build-compatibility";
import {
    OPENCODE_APP_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    OPENCODE_APP_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
    OPENCODE_CLI_TARGET_BUILD_ANCHORS,
} from "./opencode-target-builds";
import { analyzeOpencodeSkillTargets, createOpencodeSkillTargetSupports } from "./opencode-target-skill";
import {
    analyzeOpencodeSubagentTargets,
    createOpencodeAppSubagentTargetSupports,
    createOpencodeCliSubagentTargetSupports,
} from "./opencode-target-subagent";
import {
    analyzeOpencodeWorkflowTargets,
    createOpencodeAppWorkflowTargetSupports,
    createOpencodeCliWorkflowTargetSupports,
} from "./opencode-target-workflow";

import type { AdapterFrameworkTargetDefinition } from "@oaam/adapter-framework";
import type { OpencodeSkillInterpretation } from "./opencode-source-read-model";
export const OPENCODE_ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
type OpenCodeAgentRuntimeId = "OPENCODE_CLI" | "OPENCODE_APP";
export const OPENCODE_AGENT_RUNTIMES: Array<AgentRuntimeDescriptor & { agentRuntimeId: OpenCodeAgentRuntimeId }> = [
    { agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" },
    { agentRuntimeId: "OPENCODE_APP", displayName: "OpenCode App", entryClass: "app" },
];

export function createOpencodeTargetDefinition(
    adapterVersion: string,
    skillInterpretation: OpencodeSkillInterpretation,
    requiresNativeSourceAssessment = true,
) {
    const PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "OPENCODE_NATIVE_PROJECT_GUIDANCE_V1";
    const PROJECT_GUIDANCE_PROFILE_ID = "opencode-cli-project-guidance-v1";
    const PROJECT_GUIDANCE_TARGET = {
        relativePath: "AGENTS.md",
        targetContextSchemaId: "OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
        requiredFacts: {},
    } as const;
    const GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "OPENCODE",
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        agentRuntimeId: "OPENCODE_CLI",
        outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
        materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
        target: PROJECT_GUIDANCE_TARGET,
        buildCompatibility: OPENCODE_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "OPENCODE_CLI",
                versionText: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[0].versionText,
                buildIdentity: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[0].buildIdentity,
                platform: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[0].platform,
                materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
                fixtureId: "opencode-cli-1.17.11-wsl-project-agents-md-2026-07-29",
                targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
                exactLoadMarker: "OPENCODE_GUIDANCE_LOAD_MARKER_20260729",
                reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
            }),
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "OPENCODE_CLI",
                versionText: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[1].versionText,
                buildIdentity: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[1].buildIdentity,
                platform: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[1].platform,
                materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
                fixtureId: "opencode-cli-1.18.15-wsl-project-agents-md-2026-08-08",
                targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
                exactLoadMarker: "OAAM_PHASE57_OPENCODE_CLI_GUIDANCE_1_18_15",
                reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
            }),
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "OPENCODE_CLI",
                versionText: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[2].versionText,
                buildIdentity: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[2].buildIdentity,
                platform: OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_BUILD_ANCHORS[2].platform,
                materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
                fixtureId: "opencode-cli-1.18.15-win32-project-agents-md-2026-08-09",
                targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
                exactLoadMarker: "OAAM_PHASE59_OPENCODE_WIN32_GUIDANCE",
                reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const APP_GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "OPENCODE",
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        agentRuntimeId: "OPENCODE_APP",
        outputContractId: "OPENCODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
        materializationProfileId: "opencode-app-project-guidance-v1",
        materializerCapabilityKey: "opencode.app-project-guidance-native-v1",
        target: {
            relativePath: "AGENTS.md",
            targetContextSchemaId: "OPENCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
            requiredFacts: {},
        },
        buildCompatibility: OPENCODE_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "OPENCODE_APP",
                versionText: OPENCODE_APP_TARGET_BUILD_ANCHORS[0].versionText,
                buildIdentity: OPENCODE_APP_TARGET_BUILD_ANCHORS[0].buildIdentity,
                platform: OPENCODE_APP_TARGET_BUILD_ANCHORS[0].platform,
                materializationProfileId: "opencode-app-project-guidance-v1",
                fixtureId: "opencode-app-1.18.15-wsl-project-agents-md-2026-08-08",
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "oaam-phase57-app-current-loader",
                reverseFixtureId: "opencode-app-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const CLI_WORKFLOW_TARGET_SUPPORT = createOpencodeCliWorkflowTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        projectTargetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
        globalTargetContextSchemaId: "OPENCODE_CLI_GLOBAL_WORKFLOW_TARGET_V1",
    });
    const APP_WORKFLOW_TARGET_SUPPORT = createOpencodeAppWorkflowTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        projectTargetContextSchemaId: APP_GUIDANCE_TARGET_SUPPORT.targetContextSchema.targetContextSchemaId,
        globalTargetContextSchemaId: "OPENCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
    });
    const CLI_SKILL_TARGET_SUPPORT = createOpencodeSkillTargetSupports({
        skillInterpretation,
        requiresNativeSourceAssessment,
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        agentRuntimeId: "OPENCODE_CLI",
        runtimeSlug: "cli",
        targetBuilds: OPENCODE_CLI_TARGET_BUILD_ANCHORS,
        projectTargetBuilds: OPENCODE_CLI_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
        projectTargetContextSchemaId: "OPENCODE_CLI_PROJECT_SKILL_TARGET_V1",
        globalTargetContextSchemaId: "OPENCODE_CLI_GLOBAL_CONFIG_SKILL_TARGET_V1",
        sharedDirectoryTargetContextSchemaId: "OPENCODE_CLI_SHARED_SKILL_DIRECTORY_TARGET_V1",
    });
    const APP_SKILL_TARGET_SUPPORT = createOpencodeSkillTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        agentRuntimeId: "OPENCODE_APP",
        runtimeSlug: "app",
        targetBuilds: OPENCODE_APP_TARGET_BUILD_ANCHORS,
        projectTargetBuilds: OPENCODE_APP_PROJECT_SKILL_TARGET_BUILD_ANCHORS,
        projectTargetContextSchemaId: "OPENCODE_APP_PROJECT_SKILL_TARGET_V1",
        globalTargetContextSchemaId: "OPENCODE_APP_GLOBAL_CONFIG_SKILL_TARGET_V1",
        sharedDirectoryTargetContextSchemaId: "OPENCODE_APP_SHARED_SKILL_DIRECTORY_TARGET_V1",
    });
    const CLI_SUBAGENT_TARGET_SUPPORT = createOpencodeCliSubagentTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        projectTargetContextSchemaId: "OPENCODE_CLI_PROJECT_SUBAGENT_TARGET_V1",
        globalTargetContextSchemaId: "OPENCODE_CLI_GLOBAL_SUBAGENT_TARGET_V1",
    });
    const APP_SUBAGENT_TARGET_SUPPORT = createOpencodeAppSubagentTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        projectTargetContextSchemaId: "OPENCODE_APP_PROJECT_SUBAGENT_TARGET_V1",
        globalTargetContextSchemaId: "OPENCODE_APP_GLOBAL_SUBAGENT_TARGET_V1",
    });

    const targetRender: AdapterFrameworkTargetDefinition = {
        consumers: [
            {
                agentRuntimeId: "OPENCODE_CLI",
                assetKind: "Guidance",
                analyze: async (input) =>
                    appendOpencodeBuildCompatibilityWarning(
                        GUIDANCE_TARGET_SUPPORT.analyze(input),
                        input,
                        GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "OPENCODE_CLI",
                assetKind: "Workflow",
                analyze: async (input) => analyzeOpencodeWorkflowTargets(input, CLI_WORKFLOW_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "OPENCODE_APP",
                assetKind: "Workflow",
                analyze: async (input) => analyzeOpencodeWorkflowTargets(input, APP_WORKFLOW_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "OPENCODE_CLI",
                assetKind: "Skill",
                analyze: async (input) => analyzeOpencodeSkillTargets(input, CLI_SKILL_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "OPENCODE_APP",
                assetKind: "Skill",
                analyze: async (input) => analyzeOpencodeSkillTargets(input, APP_SKILL_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "OPENCODE_CLI",
                assetKind: "Subagent",
                analyze: async (input) => analyzeOpencodeSubagentTargets(input, CLI_SUBAGENT_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "OPENCODE_APP",
                assetKind: "Subagent",
                analyze: async (input) => analyzeOpencodeSubagentTargets(input, APP_SUBAGENT_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "OPENCODE_APP",
                assetKind: "Guidance",
                analyze: async (input) =>
                    appendOpencodeBuildCompatibilityWarning(
                        APP_GUIDANCE_TARGET_SUPPORT.analyze(input),
                        input,
                        APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
        ],
        materializers: [
            {
                outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materialize: async (input) => GUIDANCE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => GUIDANCE_TARGET_SUPPORT.inspect(input),
            },
            {
                outputContractId: "OPENCODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
                materialize: async (input) => APP_GUIDANCE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => APP_GUIDANCE_TARGET_SUPPORT.inspect(input),
            },
            ...workflowSupports().map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...skillSupports().map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...subagentSupports().map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
        ],
    };
    return {
        agentRuntimes: OPENCODE_AGENT_RUNTIMES,
        targetContextSchemas: [
            GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            APP_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            CLI_WORKFLOW_TARGET_SUPPORT.global.targetContextSchema,
            APP_WORKFLOW_TARGET_SUPPORT.global.targetContextSchema,
            ...skillSupports().map((support) => support.targetContextSchema),
            ...subagentSupports().map((support) => support.targetContextSchema),
        ],
        assetTargetCapabilities: makeTargetCapabilities(),
        materializerCapabilities: [
            GUIDANCE_TARGET_SUPPORT.materializerCapability,
            APP_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            ...workflowSupports().map((support) => support.materializerCapability),
            ...skillSupports().map((support) => support.materializerCapability),
            ...subagentSupports().map((support) => support.materializerCapability),
        ],
        renderContractDeclarations: [
            GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            ...workflowSupports().map((support) => support.renderContractDeclaration),
            ...skillSupports().map((support) => support.renderContractDeclaration),
            ...subagentSupports().map((support) => support.renderContractDeclaration),
        ],
        canonicalMaterializationValidators: [...workflowSupports(), ...skillSupports(), ...subagentSupports()].flatMap(
            (support) => support.canonicalMaterializationValidators,
        ),
        targetRender,
    };
    function makeTargetCapabilities(): AdapterAssetTargetCapability[] {
        return OPENCODE_AGENT_RUNTIMES.flatMap((runtime) =>
            OPENCODE_ASSET_KINDS.flatMap((assetKind): AdapterAssetTargetCapability[] => {
                if (assetKind === "Guidance") {
                    return [
                        runtime.agentRuntimeId === "OPENCODE_CLI"
                            ? GUIDANCE_TARGET_SUPPORT.targetCapability
                            : APP_GUIDANCE_TARGET_SUPPORT.targetCapability,
                    ];
                }
                if (assetKind === "Workflow") {
                    return Object.values(
                        runtime.agentRuntimeId === "OPENCODE_CLI" ? CLI_WORKFLOW_TARGET_SUPPORT : APP_WORKFLOW_TARGET_SUPPORT,
                    ).map((support) => support.targetCapability);
                }
                if (assetKind === "Rule") {
                    return [
                        {
                            agentRuntimeId: runtime.agentRuntimeId,
                            entrySupportStatus: "unsupported",
                            assetKind,
                            diagnostics: [
                                diagnostic(
                                    "render",
                                    "opencode_rule_unsupported",
                                    "OpenCode has no independent native Rule target",
                                    "unsupported",
                                    "warning",
                                ),
                            ],
                        },
                    ];
                }
                if (assetKind === "Skill") {
                    return Object.values(
                        runtime.agentRuntimeId === "OPENCODE_CLI" ? CLI_SKILL_TARGET_SUPPORT : APP_SKILL_TARGET_SUPPORT,
                    ).map((support) => support.targetCapability);
                }
                if (assetKind === "Subagent") {
                    return Object.values(
                        runtime.agentRuntimeId === "OPENCODE_CLI" ? CLI_SUBAGENT_TARGET_SUPPORT : APP_SUBAGENT_TARGET_SUPPORT,
                    ).map((support) => support.targetCapability);
                }
                return [
                    {
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "unsupported",
                        assetKind,
                        diagnostics: [
                            diagnostic(
                                "render",
                                "opencode_memory_unsupported",
                                "OpenCode has no independent native Memory target",
                                "unsupported",
                                "warning",
                            ),
                        ],
                    },
                ];
            }),
        );
    }

    function workflowSupports() {
        return [...Object.values(CLI_WORKFLOW_TARGET_SUPPORT), ...Object.values(APP_WORKFLOW_TARGET_SUPPORT)];
    }

    function skillSupports() {
        return [...Object.values(CLI_SKILL_TARGET_SUPPORT), ...Object.values(APP_SKILL_TARGET_SUPPORT)];
    }

    function subagentSupports() {
        return [...Object.values(CLI_SUBAGENT_TARGET_SUPPORT), ...Object.values(APP_SUBAGENT_TARGET_SUPPORT)];
    }
}

export function createOpencodeHistoricalInspectionBinding(
    rendererVersion: "0.9.0" | "0.10.0" = "0.9.0",
): AdapterRetainedInspectionBindingV1 {
    const { targetRender, ...metadata } = createOpencodeTargetDefinition(
        rendererVersion,
        rendererVersion === "0.10.0" ? 2 : 1,
        false,
    );
    const { inspectRenderedTarget } = createTargetCoordinator({
        adapterId: "OPENCODE",
        adapterVersion: rendererVersion,
        assetTargetCapabilities: metadata.assetTargetCapabilities,
        materializerCapabilities: metadata.materializerCapabilities,
        targetRender,
    });
    return { schemaVersion: 1, rendererVersion, ...metadata, inspectRenderedTarget };
}
