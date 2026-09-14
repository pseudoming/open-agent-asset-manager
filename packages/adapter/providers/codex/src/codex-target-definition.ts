/** Version-bound Codex target composition for current use and retained inspection. */
import {
    createTargetCoordinator,
    type AdapterFrameworkTargetDefinition,
    adapterOperationDiagnostic as diagnostic,
} from "@oaam/adapter-framework";
import type {
    AdapterRetainedInspectionBindingV1,
    AdapterAssetTargetCapability,
    AgentRuntimeDescriptor,
    AssetKind,
} from "@oaam/core";
import { createNativeProjectGuidanceProviderSupport, createVerifiedNativeProjectGuidanceBuild } from "@oaam/core/adapter-spi";
import {
    CODEX_CURRENT_BUILDS,
    CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS,
    CODEX_HISTORICAL_TARGET_BUILDS,
} from "./codex-runtime-builds";
import {
    appendCodexBuildCompatibilityWarning,
    CODEX_APP_TARGET_BUILD_COMPATIBILITY,
    CODEX_CLI_TARGET_BUILD_COMPATIBILITY,
} from "./codex-target-build-compatibility";
import { CODEX_APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID, createCodexSubagentTargetSupports } from "./codex-target-exact-file";
import { analyzeCodexSkillGraphTargets, createCodexSkillGraphTargetSupports } from "./codex-target-exact-graph";
import { analyzeCodexScopeTargets, createCodexGlobalTargetSupports } from "./codex-target-global";
import {
    analyzeCodexWorkflowMigrationTargets,
    createCodexWorkflowMigrationTargetSupports,
} from "./codex-target-workflow-migration";

export const CODEX_ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
export type CodexAgentRuntimeId = "CODEX_CLI" | "CODEX_APP";
export const CODEX_AGENT_RUNTIMES: Array<AgentRuntimeDescriptor & { agentRuntimeId: CodexAgentRuntimeId }> = [
    { agentRuntimeId: "CODEX_CLI", displayName: "Codex CLI", entryClass: "cli" },
    { agentRuntimeId: "CODEX_APP", displayName: "Codex App", entryClass: "app" },
];

export function createCodexTargetDefinition(
    adapterVersion: string,
    canonicalSkills = true,
    requiresNativeSourceAssessment = true,
) {
    const PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "CODEX_NATIVE_PROJECT_GUIDANCE_V1";
    const PROJECT_GUIDANCE_PROFILE_ID = "codex-cli-project-guidance-v1";
    const PROJECT_GUIDANCE_TARGET = {
        relativePath: "AGENTS.md",
        targetContextSchemaId: "CODEX_CLI_PROJECT_GUIDANCE_TARGET_V1",
        requiredFacts: {},
    } as const;
    const GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "CODEX",
        adapterVersion: adapterVersion,
        agentRuntimes: CODEX_AGENT_RUNTIMES,
        agentRuntimeId: "CODEX_CLI",
        outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
        materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
        target: PROJECT_GUIDANCE_TARGET,
        buildCompatibility: CODEX_CLI_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CODEX_CLI",
                versionText: CODEX_CURRENT_BUILDS.CODEX_CLI.versionText,
                buildIdentity: CODEX_CURRENT_BUILDS.CODEX_CLI.buildIdentity,
                platform: CODEX_CURRENT_BUILDS.CODEX_CLI.platform,
                materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
                fixtureId: "codex-cli-0.142.5-wsl-project-agents-md-2026-07-22",
                targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
                exactLoadMarker: "OAAM_CODEX_TARGET_GUIDANCE_4F9C27",
                reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
            }),
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CODEX_CLI",
                versionText: CODEX_HISTORICAL_TARGET_BUILDS.CODEX_CLI_GUIDANCE_FLOOR.versionText,
                buildIdentity: CODEX_HISTORICAL_TARGET_BUILDS.CODEX_CLI_GUIDANCE_FLOOR.buildIdentity,
                platform: CODEX_HISTORICAL_TARGET_BUILDS.CODEX_CLI_GUIDANCE_FLOOR.platform,
                materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
                fixtureId: `${CODEX_HISTORICAL_TARGET_BUILDS.CODEX_CLI_GUIDANCE_FLOOR.fixturePrefix}-project-agents-md-historical-lifecycle-2026-08-17`,
                targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
                exactLoadMarker: "oaam-historical-codex-cli-wsl-0-140-0-836e4bca86821682",
                reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const APP_GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "CODEX",
        adapterVersion: adapterVersion,
        agentRuntimes: CODEX_AGENT_RUNTIMES,
        agentRuntimeId: "CODEX_APP",
        outputContractId: "CODEX_APP_NATIVE_PROJECT_GUIDANCE_V1",
        materializationProfileId: "codex-app-project-guidance-v1",
        materializerCapabilityKey: "codex.app-project-guidance-native-v1",
        target: {
            relativePath: "AGENTS.md",
            targetContextSchemaId: CODEX_APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: {},
        },
        buildCompatibility: CODEX_APP_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CODEX_APP",
                versionText: CODEX_CURRENT_BUILDS.CODEX_APP.versionText,
                buildIdentity: CODEX_CURRENT_BUILDS.CODEX_APP.buildIdentity,
                platform: CODEX_CURRENT_BUILDS.CODEX_APP.platform,
                materializationProfileId: "codex-app-project-guidance-v1",
                fixtureId: `${CODEX_CURRENT_BUILDS.CODEX_APP.fixturePrefix}-project-agents-md-2026-08-06`,
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "OAAM_PHASE54_APP_TARGET_GUIDANCE_2F71C9",
                reverseFixtureId: "codex-app-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const SKILL_GRAPH_TARGET_SUPPORT = createCodexSkillGraphTargetSupports({
        canonicalSkills,
        requiresNativeSourceAssessment,
        adapterVersion: adapterVersion,
        agentRuntimes: CODEX_AGENT_RUNTIMES,
    });
    const SUBAGENT_TARGET_SUPPORT = createCodexSubagentTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: CODEX_AGENT_RUNTIMES,
    });
    const GLOBAL_TARGET_SUPPORT = createCodexGlobalTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: CODEX_AGENT_RUNTIMES,
    });
    const WORKFLOW_MIGRATION_TARGET_SUPPORT = createCodexWorkflowMigrationTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: CODEX_AGENT_RUNTIMES,
    });

    const targetRender: AdapterFrameworkTargetDefinition = {
        consumers: [
            {
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Guidance",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexScopeTargets(input, GUIDANCE_TARGET_SUPPORT, GLOBAL_TARGET_SUPPORT.CODEX_CLI.guidance),
                        input,
                        GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_APP",
                assetKind: "Guidance",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexScopeTargets(
                            input,
                            APP_GUIDANCE_TARGET_SUPPORT,
                            GLOBAL_TARGET_SUPPORT.CODEX_APP.guidance,
                        ),
                        input,
                        APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Skill",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexSkillGraphTargets(input, SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI),
                        input,
                        SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI.project.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_APP",
                assetKind: "Skill",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexSkillGraphTargets(input, SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP),
                        input,
                        SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP.project.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Subagent",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexScopeTargets(
                            input,
                            SUBAGENT_TARGET_SUPPORT.CODEX_CLI,
                            GLOBAL_TARGET_SUPPORT.CODEX_CLI.subagent,
                        ),
                        input,
                        SUBAGENT_TARGET_SUPPORT.CODEX_CLI.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_APP",
                assetKind: "Subagent",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexScopeTargets(
                            input,
                            SUBAGENT_TARGET_SUPPORT.CODEX_APP,
                            GLOBAL_TARGET_SUPPORT.CODEX_APP.subagent,
                        ),
                        input,
                        SUBAGENT_TARGET_SUPPORT.CODEX_APP.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Workflow",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexWorkflowMigrationTargets(input, WORKFLOW_MIGRATION_TARGET_SUPPORT.CODEX_CLI),
                        input,
                        WORKFLOW_MIGRATION_TARGET_SUPPORT.CODEX_CLI.project.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "CODEX_APP",
                assetKind: "Workflow",
                analyze: async (input) =>
                    appendCodexBuildCompatibilityWarning(
                        await analyzeCodexWorkflowMigrationTargets(input, WORKFLOW_MIGRATION_TARGET_SUPPORT.CODEX_APP),
                        input,
                        WORKFLOW_MIGRATION_TARGET_SUPPORT.CODEX_APP.project.renderContractDeclaration,
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
                outputContractId: APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                materialize: async (input) => APP_GUIDANCE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => APP_GUIDANCE_TARGET_SUPPORT.inspect(input),
            },
            ...Object.values(SKILL_GRAPH_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).map((support) => ({
                    outputContractId: support.renderContractDeclaration.outputContractId,
                    materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                    inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
                })),
            ),
            ...Object.values(SUBAGENT_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
            ...Object.values(GLOBAL_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).map((support) => ({
                    outputContractId: support.renderContractDeclaration.outputContractId,
                    materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                    inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
                })),
            ),
            ...Object.values(WORKFLOW_MIGRATION_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).map((support) => ({
                    outputContractId: support.renderContractDeclaration.outputContractId,
                    materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                    inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
                })),
            ),
        ],
    };
    return {
        agentRuntimes: CODEX_AGENT_RUNTIMES,
        targetContextSchemas: [
            GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            APP_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI.global.targetContextSchema,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP.global.targetContextSchema,
            GLOBAL_TARGET_SUPPORT.CODEX_CLI.guidance.targetContextSchema,
            GLOBAL_TARGET_SUPPORT.CODEX_APP.guidance.targetContextSchema,
        ],
        assetTargetCapabilities: makeTargetCapabilities(),
        materializerCapabilities: [
            GUIDANCE_TARGET_SUPPORT.materializerCapability,
            APP_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI.project.materializerCapability,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI.global.materializerCapability,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP.project.materializerCapability,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP.global.materializerCapability,
            SUBAGENT_TARGET_SUPPORT.CODEX_CLI.materializerCapability,
            SUBAGENT_TARGET_SUPPORT.CODEX_APP.materializerCapability,
            GLOBAL_TARGET_SUPPORT.CODEX_CLI.guidance.materializerCapability,
            GLOBAL_TARGET_SUPPORT.CODEX_CLI.subagent.materializerCapability,
            GLOBAL_TARGET_SUPPORT.CODEX_APP.guidance.materializerCapability,
            GLOBAL_TARGET_SUPPORT.CODEX_APP.subagent.materializerCapability,
            ...Object.values(WORKFLOW_MIGRATION_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).map((support) => support.materializerCapability),
            ),
        ],
        renderContractDeclarations: [
            GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI.project.renderContractDeclaration,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_CLI.global.renderContractDeclaration,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP.project.renderContractDeclaration,
            SKILL_GRAPH_TARGET_SUPPORT.CODEX_APP.global.renderContractDeclaration,
            SUBAGENT_TARGET_SUPPORT.CODEX_CLI.renderContractDeclaration,
            SUBAGENT_TARGET_SUPPORT.CODEX_APP.renderContractDeclaration,
            GLOBAL_TARGET_SUPPORT.CODEX_CLI.guidance.renderContractDeclaration,
            GLOBAL_TARGET_SUPPORT.CODEX_CLI.subagent.renderContractDeclaration,
            GLOBAL_TARGET_SUPPORT.CODEX_APP.guidance.renderContractDeclaration,
            GLOBAL_TARGET_SUPPORT.CODEX_APP.subagent.renderContractDeclaration,
            ...Object.values(WORKFLOW_MIGRATION_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).map((support) => support.renderContractDeclaration),
            ),
        ],
        canonicalMaterializationValidators: [
            ...Object.values(SKILL_GRAPH_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).flatMap((support) => support.canonicalMaterializationValidators),
            ),
            ...Object.values(WORKFLOW_MIGRATION_TARGET_SUPPORT).flatMap((supports) =>
                Object.values(supports).flatMap((support) => support.canonicalMaterializationValidators),
            ),
        ],
        targetRender,
    };
    function makeTargetCapabilities(): AdapterAssetTargetCapability[] {
        return CODEX_AGENT_RUNTIMES.flatMap((runtime) =>
            CODEX_ASSET_KINDS.flatMap((assetKind) => {
                if (assetKind === "Workflow") {
                    return [
                        WORKFLOW_MIGRATION_TARGET_SUPPORT[runtime.agentRuntimeId].project.targetCapability,
                        WORKFLOW_MIGRATION_TARGET_SUPPORT[runtime.agentRuntimeId].global.targetCapability,
                    ];
                }
                return assetKind === "Guidance"
                    ? [
                          runtime.agentRuntimeId === "CODEX_CLI"
                              ? GUIDANCE_TARGET_SUPPORT.targetCapability
                              : APP_GUIDANCE_TARGET_SUPPORT.targetCapability,
                          GLOBAL_TARGET_SUPPORT[runtime.agentRuntimeId].guidance.targetCapability,
                      ]
                    : assetKind === "Skill"
                      ? [
                            SKILL_GRAPH_TARGET_SUPPORT[runtime.agentRuntimeId].project.targetCapability,
                            SKILL_GRAPH_TARGET_SUPPORT[runtime.agentRuntimeId].global.targetCapability,
                        ]
                      : assetKind === "Subagent"
                        ? [
                              SUBAGENT_TARGET_SUPPORT[runtime.agentRuntimeId].targetCapability,
                              GLOBAL_TARGET_SUPPORT[runtime.agentRuntimeId].subagent.targetCapability,
                          ]
                        : [retainedTargetCapability(runtime.agentRuntimeId, assetKind)];
            }),
        );
    }

    function retainedTargetCapability(
        agentRuntimeId: CodexAgentRuntimeId,
        assetKind: "Rule" | "Memory",
    ): AdapterAssetTargetCapability {
        const retained = retainedTargetDisposition(agentRuntimeId, assetKind);
        return {
            agentRuntimeId,
            entrySupportStatus: assetKind === "Rule" ? "unsupported" : "deferred",
            assetKind,
            diagnostics: [
                diagnostic("render", retained.code, retained.message, "unsupported", assetKind === "Rule" ? "warning" : "error"),
            ],
        };
    }

    function retainedTargetDisposition(
        agentRuntimeId: CodexAgentRuntimeId,
        assetKind: "Rule" | "Memory",
    ): { code: string; message: string } {
        const runtimeName = agentRuntimeId === "CODEX_CLI" ? "Codex CLI" : "Codex App";
        const runtimeCode = agentRuntimeId === "CODEX_CLI" ? "codex_cli" : "codex_app";
        if (assetKind === "Rule") {
            return {
                code: `${runtimeCode}_rule_target_unsupported`,
                message:
                    `${runtimeName} .rules files are command-execution approval policy, not OAAM knowledge Rule targets; ` +
                    "writing one as a Rule would change executable policy semantics. Reopen only for a distinct native " +
                    "declarative knowledge-rule target.",
            };
        }
        return agentRuntimeId === "CODEX_CLI"
            ? {
                  code: "codex_cli_memory_target_deferred",
                  message:
                      "Codex CLI 0.142.5 loads the final Memory files, but its asynchronous model-mediated consolidation can " +
                      "overwrite them without an OAAM receipt or unique reverse attribution. The final files are readable; an " +
                      "ordinary Deployment remains deferred until Codex exposes a stable target owner and refresh receipt.",
              }
            : {
                  code: "codex_app_memory_target_deferred",
                  message:
                      `Codex App embedded ${CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS.CODEX_APP.versionText} loads the final Memory files, but its ` +
                      "asynchronous model-mediated consolidation can overwrite them without an OAAM receipt or unique reverse " +
                      "attribution. The final files are readable; an ordinary Deployment remains deferred until Codex exposes " +
                      "a stable target owner and refresh receipt.",
              };
    }
}

export function createCodexHistoricalInspectionBinding(
    rendererVersion: "0.17.0" | "0.18.0" = "0.17.0",
): AdapterRetainedInspectionBindingV1 {
    const { targetRender, ...metadata } = createCodexTargetDefinition(rendererVersion, rendererVersion === "0.18.0", false);
    const { inspectRenderedTarget } = createTargetCoordinator({
        adapterId: "CODEX",
        adapterVersion: rendererVersion,
        assetTargetCapabilities: metadata.assetTargetCapabilities,
        materializerCapabilities: metadata.materializerCapabilities,
        targetRender,
    });
    return { schemaVersion: 1, rendererVersion, ...metadata, inspectRenderedTarget };
}
