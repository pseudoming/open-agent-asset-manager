/** ZCode App: exact source discovery and evidence-backed native targets. */

import { defineAdapterProvider, adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterAssetSourceCapability,
    AdapterAssetTargetCapability,
    AgentRuntimeDescriptor,
    AssetKind,
    RootLocatorKind,
    RootRole,
    SourceDomain,
    SourceEvidenceLevel,
} from "@oaam/core";
import {
    createAdapterAssetSourceCapability,
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeProjectGuidanceBuild,
} from "@oaam/core/adapter-spi";
import { ZCODE_DIALECT_CONTRACTS } from "./zcode-dialects";
import { probeZcode } from "./zcode-probe";
import { ZCODE_SOURCE_READ } from "./zcode-source-read";
import { appendZcodeBuildCompatibilityWarning, ZCODE_APP_TARGET_BUILD_COMPATIBILITY } from "./zcode-target-build-compatibility";
import { ZCODE_HISTORICAL_DECLARATION_FLOOR } from "./zcode-target-builds";
import { analyzeZcodeSkillTargets, createZcodeSkillTargetSupports } from "./zcode-target-skill";
import { analyzeZcodeSubagentTargets, createZcodeSubagentTargetSupports } from "./zcode-target-subagent";
import { analyzeZcodeWorkflowTargets, createZcodeWorkflowTargetSupports } from "./zcode-target-workflow";
import { analyzeZcodeMemoryTargets, createZcodeMemoryTargetSupports } from "./zcode-target-memory";

const ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
const AGENT_RUNTIMES: AgentRuntimeDescriptor[] = [{ agentRuntimeId: "ZCODE_APP", displayName: "ZCode App", entryClass: "app" }];
const PROVIDER_VERSION = "0.10.0";
const PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "ZCODE_NATIVE_PROJECT_GUIDANCE_V1";
const PROJECT_GUIDANCE_PROFILE_ID = "zcode-app-project-guidance-v1";
const PROJECT_GUIDANCE_TARGET = {
    relativePath: "AGENTS.md",
    targetContextSchemaId: "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
    requiredFacts: { "oaam.project-binding": "registered" },
} as const;
const GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
    adapterId: "ZCODE",
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    agentRuntimeId: "ZCODE_APP",
    outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
    materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
    target: PROJECT_GUIDANCE_TARGET,
    buildCompatibility: ZCODE_APP_TARGET_BUILD_COMPATIBILITY,
    verifiedBuilds: [
        createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: "ZCODE_APP",
            versionText: ZCODE_HISTORICAL_DECLARATION_FLOOR.versionText,
            buildIdentity: ZCODE_HISTORICAL_DECLARATION_FLOOR.buildIdentity,
            platform: ZCODE_HISTORICAL_DECLARATION_FLOOR.platform,
            materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
            fixtureId: "zcode-app-3.1.8-wsl-project-agents-md-historical-lifecycle-2026-08-17",
            targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
            exactLoadMarker: "OAAM_ZCODE_HISTORICAL_GUIDANCE_3_1_8",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        }),
        createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: "ZCODE_APP",
            versionText: "3.3.5",
            buildIdentity: "sha256:15fd526de795655faf302ba3f0427d6eedf5f3eca78927266580c48c7820cc10",
            platform: "win32",
            materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
            fixtureId: "zcode-app-3.3.5-cli-0.15.2-win32-project-agents-md-2026-07-22",
            targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
            exactLoadMarker: "OAAM_ZCODE_TARGET_GUIDANCE_6C1A27",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        }),
        createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: "ZCODE_APP",
            versionText: "3.3.5",
            buildIdentity: "sha256:15fd526de795655faf302ba3f0427d6eedf5f3eca78927266580c48c7820cc10",
            platform: "wsl",
            materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
            fixtureId: "zcode-app-3.3.5-cli-0.15.2-wsl-project-agents-md-2026-07-22",
            targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
            exactLoadMarker: "OAAM_ZCODE_LINUX_TARGET_GUIDANCE_92F4B8",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        }),
        createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: "ZCODE_APP",
            versionText: "3.5.3",
            buildIdentity: "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a",
            platform: "win32",
            materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
            fixtureId: "zcode-app-3.5.3-win32-project-agents-md-2026-08-07",
            targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
            exactLoadMarker: "OAAM_ZCODE_353_PROJECT_GUIDANCE_WIN32_7D3E91",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        }),
        createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: "ZCODE_APP",
            versionText: "3.5.3",
            buildIdentity: "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a",
            platform: "wsl",
            materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
            fixtureId: "zcode-app-3.5.3-wsl-project-agents-md-2026-08-07",
            targetRelativePath: PROJECT_GUIDANCE_TARGET.relativePath,
            exactLoadMarker: "OAAM_ZCODE_353_PROJECT_GUIDANCE_WSL_5A8C24",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        }),
    ],
});
const WORKFLOW_TARGET_SUPPORT = createZcodeWorkflowTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    globalTargetContextSchemaId: "ZCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
});
const SKILL_TARGET_SUPPORT = createZcodeSkillTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    globalTargetContextSchemaId: WORKFLOW_TARGET_SUPPORT.globalCommand.targetContextSchema.targetContextSchemaId,
    globalDirectoryTargetContextSchemaId: "ZCODE_APP_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
});
const SUBAGENT_TARGET_SUPPORT = createZcodeSubagentTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    projectTargetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    globalTargetContextSchemaId: WORKFLOW_TARGET_SUPPORT.globalCommand.targetContextSchema.targetContextSchemaId,
});
const MEMORY_TARGET_SUPPORT = createZcodeMemoryTargetSupports({
    adapterVersion: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    targetContextSchemaId: "ZCODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
});

export const zcodeProvider = defineAdapterProvider({
    adapterId: "ZCODE",
    displayName: "ZCode",
    version: PROVIDER_VERSION,
    agentRuntimes: AGENT_RUNTIMES,
    targetContextSchemas: [
        GUIDANCE_TARGET_SUPPORT.targetContextSchema,
        WORKFLOW_TARGET_SUPPORT.globalCommand.targetContextSchema,
        SKILL_TARGET_SUPPORT.globalDirectoryFolder.targetContextSchema,
        MEMORY_TARGET_SUPPORT.unit.targetContextSchema,
    ],
    assetSourceCapabilities: makeSourceCapabilities(),
    assetTargetCapabilities: makeTargetCapabilities(),
    materializerCapabilities: [
        GUIDANCE_TARGET_SUPPORT.materializerCapability,
        ...Object.values(WORKFLOW_TARGET_SUPPORT).map((support) => support.materializerCapability),
        ...Object.values(SKILL_TARGET_SUPPORT).map((support) => support.materializerCapability),
        ...Object.values(SUBAGENT_TARGET_SUPPORT).map((support) => support.materializerCapability),
        ...Object.values(MEMORY_TARGET_SUPPORT).map((support) => support.materializerCapability),
    ],
    renderContractDeclarations: [
        GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
        ...Object.values(WORKFLOW_TARGET_SUPPORT).map((support) => support.renderContractDeclaration),
        ...Object.values(SKILL_TARGET_SUPPORT).map((support) => support.renderContractDeclaration),
        ...Object.values(SUBAGENT_TARGET_SUPPORT).map((support) => support.renderContractDeclaration),
        ...Object.values(MEMORY_TARGET_SUPPORT).map((support) => support.renderContractDeclaration),
    ],
    canonicalMaterializationValidators: [
        ...Object.values(SKILL_TARGET_SUPPORT),
        ...Object.values(SUBAGENT_TARGET_SUPPORT),
    ].flatMap((support) => support.canonicalMaterializationValidators),
    dialectContracts: ZCODE_DIALECT_CONTRACTS,
    sourceRead: ZCODE_SOURCE_READ,
    probe: probeZcode,
    targetRender: {
        consumers: [
            {
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Guidance",
                analyze: async (input) =>
                    appendZcodeBuildCompatibilityWarning(
                        GUIDANCE_TARGET_SUPPORT.analyze(input),
                        input,
                        GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                    ),
            },
            {
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Workflow",
                analyze: async (input) => analyzeZcodeWorkflowTargets(input, WORKFLOW_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Skill",
                analyze: async (input) => analyzeZcodeSkillTargets(input, SKILL_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Subagent",
                analyze: async (input) => analyzeZcodeSubagentTargets(input, SUBAGENT_TARGET_SUPPORT),
            },
            {
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Memory",
                analyze: async (input) => analyzeZcodeMemoryTargets(input, MEMORY_TARGET_SUPPORT),
            },
        ],
        materializers: [
            {
                outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                materialize: async (input) => GUIDANCE_TARGET_SUPPORT.materialize(input),
                inspect: async (input) => GUIDANCE_TARGET_SUPPORT.inspect(input),
            },
            ...Object.values(WORKFLOW_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
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
            ...Object.values(MEMORY_TARGET_SUPPORT).map((support) => ({
                outputContractId: support.renderContractDeclaration.outputContractId,
                materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
            })),
        ],
    },
});

function makeSourceCapabilities(): AdapterAssetSourceCapability[] {
    return ASSET_KINDS.flatMap((assetKind) => {
        if (assetKind === "Rule") {
            return [unavailableSource("Rule", "unsupported", "zcode_rule_source_unsupported")];
        }
        if (assetKind === "Guidance") return guidanceSourceRows();
        if (assetKind === "Workflow") return workflowSourceRows();
        if (assetKind === "Skill") return skillSourceRows();
        if (assetKind === "Subagent") return subagentSourceRows();
        if (assetKind === "Memory") return memorySourceRows();
        throw new Error(`Unhandled ZCode AssetKind: ${assetKind}`);
    });
}

function memorySourceRows(): AdapterAssetSourceCapability[] {
    return [
        callableSource("Memory", "runtime_known_rule", "source", "project_keyed", "auto_read", "source_code"),
        callableSource("Memory", "runtime_declared_path", "source", "project_keyed", "auto_read", "source_code"),
    ];
}

function guidanceSourceRows(): AdapterAssetSourceCapability[] {
    return [
        callableGuidance("runtime_known_rule", "config", "agent_runtime_private", "auto_read", "source_code"),
        callableGuidance("project_registry_entry", "project_actual", "project_root", "auto_read", "local_artifact"),
        callableGuidance("user_provided_path", "project_actual", "project_root", "auto_read", "user_provided"),
        callableGuidance("user_provided_path", "source", "external_managed", "user_selected_root_only", "user_provided"),
    ];
}

function skillSourceRows(): AdapterAssetSourceCapability[] {
    return [
        callableSource("Skill", "runtime_known_rule", "source", "agent_runtime_private", "auto_read", "source_code"),
        callableSource("Skill", "runtime_known_rule", "source", "project_root", "auto_read", "source_code"),
        callableSource("Skill", "runtime_declared_path", "source", "external_managed", "auto_read", "source_code"),
        callableSource("Skill", "user_provided_path", "source", "external_managed", "user_selected_root_only", "user_provided"),
        callableSource("Skill", "runtime_known_rule", "source", "family_shared", "auto_read", "source_code"),
    ];
}

function workflowSourceRows(): AdapterAssetSourceCapability[] {
    return [
        callableSource("Workflow", "runtime_known_rule", "config", "agent_runtime_private", "auto_read", "source_code"),
        callableSource("Workflow", "project_registry_entry", "project_actual", "project_root", "auto_read", "local_artifact"),
        callableSource("Workflow", "user_provided_path", "project_actual", "project_root", "auto_read", "user_provided"),
        callableSource(
            "Workflow",
            "user_provided_path",
            "source",
            "external_managed",
            "user_selected_root_only",
            "user_provided",
        ),
        callableSource("Workflow", "runtime_known_rule", "source", "family_shared", "auto_read", "source_code"),
    ];
}

function subagentSourceRows(): AdapterAssetSourceCapability[] {
    return [
        callableSource("Subagent", "runtime_known_rule", "source", "agent_runtime_private", "auto_read", "source_code"),
        callableSource("Subagent", "runtime_declared_path", "source", "agent_runtime_private", "auto_read", "source_code"),
        callableSource("Subagent", "project_registry_entry", "project_actual", "project_root", "auto_read", "local_artifact"),
        callableSource("Subagent", "user_provided_path", "project_actual", "project_root", "auto_read", "user_provided"),
        callableSource(
            "Subagent",
            "user_provided_path",
            "source",
            "external_managed",
            "user_selected_root_only",
            "user_provided",
        ),
    ];
}

function callableGuidance(
    rootLocatorKind: RootLocatorKind,
    rootRole: RootRole,
    sourceDomain: SourceDomain,
    readPolicy: AdapterAssetSourceCapability["readPolicy"],
    evidenceLevel: SourceEvidenceLevel,
): AdapterAssetSourceCapability {
    return callableSource("Guidance", rootLocatorKind, rootRole, sourceDomain, readPolicy, evidenceLevel);
}

function callableSource(
    assetKind: "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory",
    rootLocatorKind: RootLocatorKind,
    rootRole: RootRole,
    sourceDomain: SourceDomain,
    readPolicy: AdapterAssetSourceCapability["readPolicy"],
    evidenceLevel: SourceEvidenceLevel,
): AdapterAssetSourceCapability {
    return sourceCapability({
        agentRuntimeId: "ZCODE_APP",
        entrySupportStatus: "supported",
        rootLocatorKind,
        rootRole,
        sourceDomain,
        assetKind,
        sourcePathMechanism: "recursive_entry",
        evidenceLevel,
        readPolicy,
        diagnostics: [],
    });
}

function unavailableSource(assetKind: "Rule", entrySupportStatus: "unsupported", code: string): AdapterAssetSourceCapability {
    return sourceCapability({
        agentRuntimeId: "ZCODE_APP",
        entrySupportStatus,
        rootLocatorKind: "unknown",
        rootRole: "unknown",
        sourceDomain: "unknown",
        assetKind,
        sourcePathMechanism: "unknown",
        evidenceLevel: "source_code",
        readPolicy: "report_only",
        diagnostics: [
            diagnostic(
                "read",
                code,
                "ZCode exposes no independent Rule mechanism; AGENTS.md is Guidance and commands are Workflow",
                "unsupported",
                "warning",
            ),
        ],
    });
}

function sourceCapability(
    input: Omit<AdapterAssetSourceCapability, "sourceCapabilityFingerprint">,
): AdapterAssetSourceCapability {
    return createAdapterAssetSourceCapability({ adapterId: "ZCODE", agentRuntimes: AGENT_RUNTIMES }, input);
}

function makeTargetCapabilities(): AdapterAssetTargetCapability[] {
    return ASSET_KINDS.flatMap((assetKind): AdapterAssetTargetCapability[] => {
        if (assetKind === "Guidance") return [GUIDANCE_TARGET_SUPPORT.targetCapability];
        if (assetKind === "Workflow") {
            return Object.values(WORKFLOW_TARGET_SUPPORT).map((support) => support.targetCapability);
        }
        if (assetKind === "Skill") {
            return Object.values(SKILL_TARGET_SUPPORT).map((support) => support.targetCapability);
        }
        if (assetKind === "Subagent") {
            return Object.values(SUBAGENT_TARGET_SUPPORT).map((support) => support.targetCapability);
        }
        if (assetKind === "Memory") {
            return Object.values(MEMORY_TARGET_SUPPORT).map((support) => support.targetCapability);
        }
        return [
            {
                agentRuntimeId: "ZCODE_APP",
                entrySupportStatus: assetKind === "Rule" ? ("unsupported" as const) : ("deferred" as const),
                assetKind,
                diagnostics: [
                    diagnostic(
                        "render",
                        assetKind === "Rule" ? "zcode_rule_target_unsupported" : "zcode_target_conformance_deferred",
                        assetKind === "Rule"
                            ? "ZCode exposes no independent Rule target mechanism"
                            : "ZCode target materialization and reverse remain blocked pending exact fixtures",
                        "unsupported",
                        assetKind === "Rule" ? "warning" : "error",
                    ),
                ],
            },
        ];
    });
}
