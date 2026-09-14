/** Current Cursor targets and the exact old Applied inspection partition. */
import {
    createTargetCoordinator,
    type AdapterFrameworkTargetDefinition,
    type AdapterTargetMaterializerHandler,
} from "@oaam/adapter-framework";
import type {
    AdapterAssetTargetCapability,
    AdapterRetainedInspectionBindingV1,
    AdapterRenderedTargetInspectionResult,
    AssetKind,
    OutputContractId,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
} from "@oaam/core";
import { createNativeProjectGuidanceProviderSupport, createVerifiedNativeProjectGuidanceBuild } from "@oaam/core/adapter-spi";
import { ASSET_KINDS, AGENT_RUNTIMES, capabilityDiagnostic } from "./cursor-capabilities";
import {
    appendCursorBuildCompatibilityWarning,
    CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
} from "./cursor-target-build-compatibility";
import { createCursorAppRuleTargetSupport, createCursorRuleTargetSupport } from "./cursor-target-rule";
import {
    analyzeCursorSkillTargets,
    createCursorAppSkillTargetSupports,
    createCursorCliSkillTargetSupports,
} from "./cursor-target-skill";
import {
    analyzeCursorSubagentTarget,
    createCursorAppSubagentTargetSupport,
    createCursorCliSubagentTargetSupport,
} from "./cursor-target-subagent";
import {
    analyzeCursorWorkflowTargets,
    createCursorAppWorkflowTargetSupports,
    createCursorCliWorkflowTargetSupports,
} from "./cursor-target-workflow";

export function createCursorTargetDefinition(adapterVersion: string, assessSkillLoss = true) {
    const CLI_PROJECT_TARGET_CONTEXT_SCHEMA_ID = "CURSOR_AGENT_CLI_PROJECT_TARGET_V1";
    const APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID = "CURSOR_APP_PROJECT_TARGET_V1";
    const CLI_GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "CURSOR",
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CURSOR_AGENT_CLI",
        outputContractId: "CURSOR_AGENT_CLI_NATIVE_PROJECT_GUIDANCE_V1",
        materializationProfileId: "cursor-agent-cli-project-guidance-v1",
        materializerCapabilityKey: "cursor.agent-cli-project-guidance-native-v1",
        target: {
            relativePath: "AGENTS.md",
            targetContextSchemaId: CLI_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: { "oaam.project-binding": "registered" },
        },
        buildCompatibility: CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                versionText: "2026.07.23-e383d2b",
                buildIdentity: "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
                platform: "wsl",
                materializationProfileId: "cursor-agent-cli-project-guidance-v1",
                fixtureId: "cursor-agent-cli-2026.07.23-wsl-project-agents-md-2026-08-08",
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "OAAM_PHASE58_CURSOR_GUIDANCE_4F2A19",
                reverseFixtureId: "cursor-agent-cli-2026.07.23-wsl-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const APP_GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "CURSOR",
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CURSOR_APP",
        outputContractId: "CURSOR_APP_NATIVE_PROJECT_GUIDANCE_V1",
        materializationProfileId: "cursor-app-project-guidance-v1",
        materializerCapabilityKey: "cursor.app-project-guidance-native-v1",
        target: {
            relativePath: "AGENTS.md",
            targetContextSchemaId: APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: { "oaam.project-binding": "registered" },
        },
        buildCompatibility: CURSOR_AGENT_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CURSOR_APP",
                versionText: "3.13.25",
                buildIdentity: "sha256:98c0fc2885636738e986e01af8f9c5229dad4b2d7510bc489c9ffc0924da4904",
                platform: "linux",
                materializationProfileId: "cursor-app-project-guidance-v1",
                fixtureId: "cursor-app-3.13.25-linux-project-agents-md-2026-08-09",
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "OAAM_CURSOR_APP_GUIDANCE_92BD",
                reverseFixtureId: "cursor-app-3.13.25-linux-project-guidance-whole-file-reverse-v1",
            }),
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CURSOR_APP",
                versionText: "3.12.30",
                buildIdentity: "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e",
                platform: "win32",
                materializationProfileId: "cursor-app-project-guidance-v1",
                fixtureId: "cursor-app-3.12.30-win32-project-agents-md-2026-08-09",
                targetRelativePath: "AGENTS.md",
                exactLoadMarker: "OAAM_CURSOR_APP_GUIDANCE_92BD",
                reverseFixtureId: "cursor-app-3.12.30-win32-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const CLI_RULE_TARGET_SUPPORT = createCursorRuleTargetSupport({
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: CLI_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
    });
    const APP_RULE_TARGET_SUPPORT = createCursorAppRuleTargetSupport({
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
    });
    const CLI_WORKFLOW_TARGET_SUPPORT = createCursorCliWorkflowTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        projectTargetContextSchemaId: CLI_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
        globalTargetContextSchemaId: "CURSOR_AGENT_CLI_GLOBAL_WORKFLOW_TARGET_V1",
    });
    const APP_WORKFLOW_TARGET_SUPPORT = createCursorAppWorkflowTargetSupports({
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        projectTargetContextSchemaId: APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
        globalTargetContextSchemaId: "CURSOR_APP_GLOBAL_WORKFLOW_TARGET_V1",
    });
    const CLI_SKILL_TARGET_SUPPORT = createCursorCliSkillTargetSupports({
        adapterVersion: adapterVersion,
        assessCanonicalLoss: assessSkillLoss,
        agentRuntimes: AGENT_RUNTIMES,
        projectTargetContextSchemaId: CLI_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
        globalTargetContextSchemaId: CLI_WORKFLOW_TARGET_SUPPORT.global.targetContextSchema.targetContextSchemaId,
        globalDirectoryTargetContextSchemaId: "CURSOR_AGENT_CLI_GLOBAL_SHARED_SKILL_TARGET_V1",
    });
    const APP_SKILL_TARGET_SUPPORT = createCursorAppSkillTargetSupports({
        adapterVersion: adapterVersion,
        assessCanonicalLoss: assessSkillLoss,
        agentRuntimes: AGENT_RUNTIMES,
        projectTargetContextSchemaId: APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
        globalTargetContextSchemaId: APP_WORKFLOW_TARGET_SUPPORT.global.targetContextSchema.targetContextSchemaId,
        globalDirectoryTargetContextSchemaId: "CURSOR_APP_GLOBAL_SHARED_SKILL_TARGET_V1",
    });
    const CLI_SUBAGENT_TARGET_SUPPORT = createCursorCliSubagentTargetSupport({
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        projectTargetContextSchemaId: CLI_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
    });
    const APP_SUBAGENT_TARGET_SUPPORT = createCursorAppSubagentTargetSupport({
        adapterVersion: adapterVersion,
        agentRuntimes: AGENT_RUNTIMES,
        projectTargetContextSchemaId: APP_PROJECT_TARGET_CONTEXT_SCHEMA_ID,
    });

    return {
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemas: [
            CLI_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            APP_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            CLI_WORKFLOW_TARGET_SUPPORT.global.targetContextSchema,
            APP_WORKFLOW_TARGET_SUPPORT.global.targetContextSchema,
            CLI_SKILL_TARGET_SUPPORT.globalDirectoryFolder.targetContextSchema,
            APP_SKILL_TARGET_SUPPORT.globalDirectoryFolder.targetContextSchema,
        ],
        assetTargetCapabilities: makeTargetCapabilities(),
        materializerCapabilities: [
            CLI_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            APP_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            CLI_RULE_TARGET_SUPPORT.materializerCapability,
            APP_RULE_TARGET_SUPPORT.materializerCapability,
            ...workflowSupports().map((support) => support.materializerCapability),
            ...skillSupports().map((support) => support.materializerCapability),
            CLI_SUBAGENT_TARGET_SUPPORT.materializerCapability,
            APP_SUBAGENT_TARGET_SUPPORT.materializerCapability,
        ],
        renderContractDeclarations: [
            CLI_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            CLI_RULE_TARGET_SUPPORT.renderContractDeclaration,
            APP_RULE_TARGET_SUPPORT.renderContractDeclaration,
            ...workflowSupports().map((support) => support.renderContractDeclaration),
            ...skillSupports().map((support) => support.renderContractDeclaration),
            CLI_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
            APP_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
        ],
        canonicalMaterializationValidators: [
            ...workflowSupports(),
            ...skillSupports(),
            CLI_SUBAGENT_TARGET_SUPPORT,
            APP_SUBAGENT_TARGET_SUPPORT,
        ].flatMap((support) => support.canonicalMaterializationValidators),
        targetRender: {
            consumers: [
                {
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    assetKind: "Guidance",
                    analyze: async (input) =>
                        appendCursorBuildCompatibilityWarning(
                            CLI_GUIDANCE_TARGET_SUPPORT.analyze(input),
                            input,
                            CLI_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    assetKind: "Skill",
                    analyze: async (input) => analyzeCursorSkillTargets(input, CLI_SKILL_TARGET_SUPPORT),
                },
                {
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    assetKind: "Workflow",
                    analyze: async (input) => analyzeCursorWorkflowTargets(input, CLI_WORKFLOW_TARGET_SUPPORT),
                },
                {
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    assetKind: "Rule",
                    analyze: async (input) =>
                        appendCursorBuildCompatibilityWarning(
                            CLI_RULE_TARGET_SUPPORT.analyze(input),
                            input,
                            CLI_RULE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    assetKind: "Subagent",
                    analyze: async (input) => analyzeCursorSubagentTarget(input, CLI_SUBAGENT_TARGET_SUPPORT),
                },
                {
                    agentRuntimeId: "CURSOR_APP",
                    assetKind: "Guidance",
                    analyze: async (input) =>
                        appendCursorBuildCompatibilityWarning(
                            APP_GUIDANCE_TARGET_SUPPORT.analyze(input),
                            input,
                            APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CURSOR_APP",
                    assetKind: "Skill",
                    analyze: async (input) => analyzeCursorSkillTargets(input, APP_SKILL_TARGET_SUPPORT),
                },
                {
                    agentRuntimeId: "CURSOR_APP",
                    assetKind: "Workflow",
                    analyze: async (input) => analyzeCursorWorkflowTargets(input, APP_WORKFLOW_TARGET_SUPPORT),
                },
                {
                    agentRuntimeId: "CURSOR_APP",
                    assetKind: "Rule",
                    analyze: async (input) =>
                        appendCursorBuildCompatibilityWarning(
                            APP_RULE_TARGET_SUPPORT.analyze(input),
                            input,
                            APP_RULE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CURSOR_APP",
                    assetKind: "Subagent",
                    analyze: async (input) => analyzeCursorSubagentTarget(input, APP_SUBAGENT_TARGET_SUPPORT),
                },
            ],
            materializers: [
                targetMaterializerHandler(CLI_GUIDANCE_TARGET_SUPPORT),
                targetMaterializerHandler(APP_GUIDANCE_TARGET_SUPPORT),
                targetMaterializerHandler(CLI_RULE_TARGET_SUPPORT),
                targetMaterializerHandler(APP_RULE_TARGET_SUPPORT),
                ...workflowSupports().map(targetMaterializerHandler),
                ...skillSupports().map(targetMaterializerHandler),
                targetMaterializerHandler(CLI_SUBAGENT_TARGET_SUPPORT),
                targetMaterializerHandler(APP_SUBAGENT_TARGET_SUPPORT),
            ],
        } satisfies AdapterFrameworkTargetDefinition,
    };

    function makeTargetCapabilities(): AdapterAssetTargetCapability[] {
        return AGENT_RUNTIMES.flatMap((runtime) =>
            ASSET_KINDS.flatMap((assetKind): AdapterAssetTargetCapability[] => {
                if (runtime.agentRuntimeId === "CURSOR_AGENT_CLI" && assetKind === "Guidance") {
                    return [CLI_GUIDANCE_TARGET_SUPPORT.targetCapability];
                }
                if (runtime.agentRuntimeId === "CURSOR_AGENT_CLI" && assetKind === "Rule") {
                    return [CLI_RULE_TARGET_SUPPORT.targetCapability];
                }
                if (runtime.agentRuntimeId === "CURSOR_AGENT_CLI" && assetKind === "Workflow") {
                    return Object.values(CLI_WORKFLOW_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (runtime.agentRuntimeId === "CURSOR_AGENT_CLI" && assetKind === "Skill") {
                    return Object.values(CLI_SKILL_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (runtime.agentRuntimeId === "CURSOR_AGENT_CLI" && assetKind === "Subagent") {
                    return [CLI_SUBAGENT_TARGET_SUPPORT.targetCapability];
                }
                if (runtime.agentRuntimeId === "CURSOR_APP" && assetKind === "Guidance") {
                    return [APP_GUIDANCE_TARGET_SUPPORT.targetCapability];
                }
                if (runtime.agentRuntimeId === "CURSOR_APP" && assetKind === "Rule") {
                    return [APP_RULE_TARGET_SUPPORT.targetCapability];
                }
                if (runtime.agentRuntimeId === "CURSOR_APP" && assetKind === "Workflow") {
                    return Object.values(APP_WORKFLOW_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (runtime.agentRuntimeId === "CURSOR_APP" && assetKind === "Skill") {
                    return Object.values(APP_SKILL_TARGET_SUPPORT).map((support) => support.targetCapability);
                }
                if (runtime.agentRuntimeId === "CURSOR_APP" && assetKind === "Subagent") {
                    return [APP_SUBAGENT_TARGET_SUPPORT.targetCapability];
                }
                if (runtime.agentRuntimeId === "CURSOR_APP" && assetKind === "Memory") {
                    return [
                        {
                            agentRuntimeId: runtime.agentRuntimeId,
                            entrySupportStatus: "unsupported",
                            assetKind,
                            diagnostics: [capabilityDiagnostic("render", runtime.displayName, assetKind)],
                        },
                    ];
                }
                return [
                    {
                        agentRuntimeId: runtime.agentRuntimeId,
                        entrySupportStatus: "deferred",
                        assetKind,
                        diagnostics: [capabilityDiagnostic("render", runtime.displayName, assetKind)],
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

    interface SynchronousTargetMaterializerSupport {
        renderContractDeclaration: { outputContractId: OutputContractId };
        materialize(input: RenderMaterializationInput): RenderMaterializationResult;
        inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
    }

    function targetMaterializerHandler(support: SynchronousTargetMaterializerSupport): AdapterTargetMaterializerHandler {
        return {
            outputContractId: support.renderContractDeclaration.outputContractId,
            materialize: async (input) => support.materialize(input),
            inspect: async (input) => support.inspect(input),
        };
    }
}

export function createCursorHistoricalInspectionBinding(): AdapterRetainedInspectionBindingV1 {
    const rendererVersion = "0.1.0";
    const { targetRender, ...metadata } = createCursorTargetDefinition(rendererVersion, false);
    const { inspectRenderedTarget } = createTargetCoordinator({
        adapterId: "CURSOR",
        adapterVersion: rendererVersion,
        assetTargetCapabilities: metadata.assetTargetCapabilities,
        materializerCapabilities: metadata.materializerCapabilities,
        targetRender,
    });
    return { schemaVersion: 1, rendererVersion, ...metadata, inspectRenderedTarget };
}
