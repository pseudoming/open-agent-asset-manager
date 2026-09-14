/** Claude Code adapter-family provider: source conformance first, target fail-closed. */

import type { AdapterFrameworkProviderDefinition } from "@oaam/adapter-framework";
import { makeClaudeCodeSourceCapabilities } from "./claudecode-provider-source-capabilities";
import type { SourceContext, ScanResult } from "./claudecode-source-read-model";
import type { AdapterAssetTargetCapability, AgentRuntimeDescriptor, AssetKind } from "@oaam/core";
import {
    createNativeGlobalGuidanceProviderSupport,
    createNativeGlobalRuleProviderSupport,
    createNativeProjectGuidanceProviderSupport,
    createNativeProjectRuleProviderSupport,
    createVerifiedNativeGlobalGuidanceBuild,
    createVerifiedNativeGlobalRuleBuild,
    createVerifiedNativeProjectGuidanceBuild,
    createVerifiedNativeProjectRuleBuild,
} from "@oaam/core/adapter-spi";
import { createClaudeWorkflowCanonicalSupports } from "./claudecode-target-workflow-canonical";
import { CLAUDECODE_DIALECT_CONTRACTS } from "./claudecode-dialects";
import { probeClaudeCode } from "./claudecode-probe";
import {
    analyzeClaudeCodeMemoryTargets,
    analyzeClaudeCodeRuleTargets,
    analyzeClaudeCodeWorkflowTargets,
    analyzeScopeVariant,
} from "./claudecode-provider-target-analysis";
import { CLAUDECODE_SOURCE_READ } from "./claudecode-source-read";
import {
    appendClaudeCodeBuildCompatibilityWarning,
    CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
    CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
} from "./claudecode-target-build-compatibility";
import {
    createClaudeCodeAppEncodedSubagentTargetSupport,
    createClaudeCodeAppGlobalEncodedSubagentTargetSupport,
    createClaudeCodeEncodedSubagentTargetSupport,
    createClaudeCodeGlobalEncodedSubagentTargetSupport,
} from "./claudecode-target-encoded-subagent";
import { createClaudeCodeExactFileTargetSupports } from "./claudecode-target-exact-file";
import {
    createClaudeCodeAppGlobalJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeAppGlobalSkillGraphTargetSupport,
    createClaudeCodeAppJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeAppSkillGraphTargetSupport,
    createClaudeCodeGlobalJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeGlobalNativeDocumentTargetSupports,
    createClaudeCodeGlobalSkillGraphTargetSupport,
    createClaudeCodeJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeSkillGraphTargetSupport,
} from "./claudecode-target-exact-graph";

export function createClaudeCodeProviderDefinition(
    PROVIDER_VERSION: string,
    currentCanonicalTargets = true,
): AdapterFrameworkProviderDefinition<SourceContext, ScanResult> {
    const ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
    const AGENT_RUNTIMES: AgentRuntimeDescriptor[] = [
        { agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "Claude Code CLI", entryClass: "cli" },
        { agentRuntimeId: "CLAUDE_CODE_APP", displayName: "Claude Code App", entryClass: "app" },
    ];
    const PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_PROJECT_GUIDANCE_V1";
    const PROJECT_GUIDANCE_PROFILE_ID = "claude-code-cli-project-guidance-v1";
    const APP_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_PROJECT_GUIDANCE_V1";
    const APP_PROJECT_GUIDANCE_PROFILE_ID = "claude-code-app-project-guidance-v1";
    const PROJECT_RULE_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_PROJECT_RULE_V1";
    const PROJECT_RULE_PROFILE_ID = "claude-code-cli-project-rule-v1";
    const APP_PROJECT_RULE_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_PROJECT_RULE_V1";
    const APP_PROJECT_RULE_PROFILE_ID = "claude-code-app-project-rule-v1";
    const GLOBAL_GUIDANCE_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_GLOBAL_GUIDANCE_V1";
    const GLOBAL_GUIDANCE_PROFILE_ID = "claude-code-cli-global-guidance-v1";
    const APP_GLOBAL_GUIDANCE_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_GLOBAL_GUIDANCE_V1";
    const APP_GLOBAL_GUIDANCE_PROFILE_ID = "claude-code-app-global-guidance-v1";
    const GLOBAL_RULE_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_GLOBAL_RULE_V1";
    const GLOBAL_RULE_PROFILE_ID = "claude-code-cli-global-rule-v1";
    const APP_GLOBAL_RULE_OUTPUT_CONTRACT_ID = "CLAUDECODE_APP_NATIVE_GLOBAL_RULE_V1";
    const APP_GLOBAL_RULE_PROFILE_ID = "claude-code-app-global-rule-v1";
    const GLOBAL_TARGET_CONTEXT_SCHEMA_ID = "CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1";
    const APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID = "CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1";
    const PROJECT_MEMORY_TARGET_CONTEXT_SCHEMA_ID = "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1";
    const APP_PROJECT_MEMORY_TARGET_CONTEXT_SCHEMA_ID = "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1";
    const PROJECT_GUIDANCE_TARGET = {
        relativePath: "CLAUDE.md",
        targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
        requiredFacts: {},
    } as const;
    const APP_PROJECT_GUIDANCE_TARGET = {
        relativePath: "CLAUDE.md",
        targetContextSchemaId: "CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1",
        requiredFacts: {},
    } as const;
    const PROJECT_RULE_TARGET = {
        relativeDirectory: ".claude/rules",
        fileNameSuffix: ".md",
        targetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
        requiredFacts: PROJECT_GUIDANCE_TARGET.requiredFacts,
    } as const;
    const APP_PROJECT_RULE_TARGET = {
        ...PROJECT_RULE_TARGET,
        targetContextSchemaId: APP_PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    } as const;
    const VERIFIED_PROJECT_GUIDANCE_BUILDS = [
        createVerifiedNativeProjectGuidanceBuild({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            versionText: "2.1.191",
            buildIdentity: "sha256:1038dba88bdf1b80941dc3e383e93b088325b00497329ac50da460c8786d5bee",
            platform: "wsl",
            materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
            fixtureId: "claude-code-cli-2.1.191-wsl-project-claude-md-2026-07-14",
            targetRelativePath: "CLAUDE.md",
            exactLoadMarker: "OAAM_CC_21191_CLAUDE_ONLY_B7F24D",
            reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
        }),
    ];
    const GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
        materializationProfileId: PROJECT_GUIDANCE_PROFILE_ID,
        target: PROJECT_GUIDANCE_TARGET,
        buildCompatibility: CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: VERIFIED_PROJECT_GUIDANCE_BUILDS,
    });
    const APP_GUIDANCE_TARGET_SUPPORT = createNativeProjectGuidanceProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_PROJECT_GUIDANCE_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-project-guidance-native-v1",
        target: APP_PROJECT_GUIDANCE_TARGET,
        buildCompatibility: CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId: "CLAUDE_CODE_APP",
                versionText: "2.1.219",
                buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                platform: "win32",
                materializationProfileId: APP_PROJECT_GUIDANCE_PROFILE_ID,
                fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-claude-md-2026-08-03",
                targetRelativePath: "CLAUDE.md",
                exactLoadMarker: "OAAM_APP_GUIDANCE_LOADED_20260803_ENGINE_R1",
                reverseFixtureId: "claude-app-project-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const RULE_TARGET_SUPPORT = createNativeProjectRuleProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: PROJECT_RULE_OUTPUT_CONTRACT_ID,
        materializationProfileId: PROJECT_RULE_PROFILE_ID,
        target: PROJECT_RULE_TARGET,
        buildCompatibility: CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectRuleBuild({
                agentRuntimeId: "CLAUDE_CODE_CLI",
                versionText: "2.1.220",
                buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                platform: "wsl",
                materializationProfileId: PROJECT_RULE_PROFILE_ID,
                fixtureId: "claude-code-cli-2.1.220-wsl-project-unconditional-rule-canonical-2026-08-04",
                targetRelativeDirectory: PROJECT_RULE_TARGET.relativeDirectory,
                targetFileNameSuffix: PROJECT_RULE_TARGET.fileNameSuffix,
                fixtureRuleName: "oaam-canonical-always",
                exactLoadMarker: "OAAM_CC_CANONICAL_RULE_PHASE53_220_44",
                reverseFixtureId: "claude-code-project-rule-canonical-whole-file-reverse-v1",
            }),
        ],
    });
    const APP_RULE_TARGET_SUPPORT = createNativeProjectRuleProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_PROJECT_RULE_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_PROJECT_RULE_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-project-rule-native-v1",
        target: APP_PROJECT_RULE_TARGET,
        buildCompatibility: CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeProjectRuleBuild({
                agentRuntimeId: "CLAUDE_CODE_APP",
                versionText: "2.1.219",
                buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                platform: "win32",
                materializationProfileId: APP_PROJECT_RULE_PROFILE_ID,
                fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-project-unconditional-rule-canonical-2026-08-04",
                targetRelativeDirectory: APP_PROJECT_RULE_TARGET.relativeDirectory,
                targetFileNameSuffix: APP_PROJECT_RULE_TARGET.fileNameSuffix,
                fixtureRuleName: "oaam-app-canonical-always",
                exactLoadMarker: "OAAM_APP_CANONICAL_RULE_LOADED_20260804_R14",
                reverseFixtureId: "claude-app-project-rule-canonical-whole-file-reverse-v1",
            }),
        ],
    });
    const GLOBAL_GUIDANCE_TARGET_SUPPORT = createNativeGlobalGuidanceProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: GLOBAL_GUIDANCE_OUTPUT_CONTRACT_ID,
        materializationProfileId: GLOBAL_GUIDANCE_PROFILE_ID,
        target: {
            relativePath: "CLAUDE.md",
            targetContextSchemaId: GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: {},
        },
        buildCompatibility: CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeGlobalGuidanceBuild({
                agentRuntimeId: "CLAUDE_CODE_CLI",
                versionText: "2.1.220",
                buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                platform: "wsl",
                materializationProfileId: GLOBAL_GUIDANCE_PROFILE_ID,
                fixtureId: "claude-code-cli-2.1.220-wsl-global-claude-md-2026-08-05",
                targetRelativePath: "CLAUDE.md",
                exactLoadMarker: "OAAM_CC_GLOBAL_GUIDANCE_20260805_R1",
                reverseFixtureId: "claude-code-global-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const APP_GLOBAL_GUIDANCE_TARGET_SUPPORT = createNativeGlobalGuidanceProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_GLOBAL_GUIDANCE_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_GLOBAL_GUIDANCE_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-global-guidance-native-v1",
        target: {
            relativePath: "CLAUDE.md",
            targetContextSchemaId: APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: {},
        },
        buildCompatibility: CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeGlobalGuidanceBuild({
                agentRuntimeId: "CLAUDE_CODE_APP",
                versionText: "2.1.219",
                buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                platform: "win32",
                materializationProfileId: APP_GLOBAL_GUIDANCE_PROFILE_ID,
                fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-claude-md-2026-08-05",
                targetRelativePath: "CLAUDE.md",
                exactLoadMarker: "OAAM_APP_GLOBAL_GUIDANCE_20260805_R1",
                reverseFixtureId: "claude-app-global-guidance-whole-file-reverse-v1",
            }),
        ],
    });
    const GLOBAL_RULE_TARGET_SUPPORT = createNativeGlobalRuleProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        outputContractId: GLOBAL_RULE_OUTPUT_CONTRACT_ID,
        materializationProfileId: GLOBAL_RULE_PROFILE_ID,
        target: {
            relativeDirectory: "rules",
            fileNameSuffix: ".md",
            targetContextSchemaId: GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: {},
        },
        buildCompatibility: CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeGlobalRuleBuild({
                agentRuntimeId: "CLAUDE_CODE_CLI",
                versionText: "2.1.220",
                buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                platform: "wsl",
                materializationProfileId: GLOBAL_RULE_PROFILE_ID,
                fixtureId: "claude-code-cli-2.1.220-wsl-global-unconditional-rule-canonical-2026-08-05",
                targetRelativeDirectory: "rules",
                targetFileNameSuffix: ".md",
                fixtureRuleName: "oaam-global-canonical-always",
                exactLoadMarker: "OAAM_CC_GLOBAL_CANONICAL_RULE_20260805_R1",
                reverseFixtureId: "claude-code-global-rule-canonical-whole-file-reverse-v1",
            }),
        ],
    });
    const APP_GLOBAL_RULE_TARGET_SUPPORT = createNativeGlobalRuleProviderSupport({
        adapterId: "CLAUDECODE",
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        agentRuntimeId: "CLAUDE_CODE_APP",
        outputContractId: APP_GLOBAL_RULE_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_GLOBAL_RULE_PROFILE_ID,
        materializerCapabilityKey: "claudecode.app-global-rule-native-v1",
        target: {
            relativeDirectory: "rules",
            fileNameSuffix: ".md",
            targetContextSchemaId: APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
            requiredFacts: {},
        },
        buildCompatibility: CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds: [
            createVerifiedNativeGlobalRuleBuild({
                agentRuntimeId: "CLAUDE_CODE_APP",
                versionText: "2.1.219",
                buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                platform: "win32",
                materializationProfileId: APP_GLOBAL_RULE_PROFILE_ID,
                fixtureId: "claude-app-1.24012.9-engine-2.1.219-win32-global-unconditional-rule-canonical-2026-08-05",
                targetRelativeDirectory: "rules",
                targetFileNameSuffix: ".md",
                fixtureRuleName: "oaam-app-global-canonical-always",
                exactLoadMarker: "OAAM_APP_GLOBAL_CANONICAL_RULE_20260805_R1",
                reverseFixtureId: "claude-app-global-rule-canonical-whole-file-reverse-v1",
            }),
        ],
    });
    const historicalExactFileSupports = createClaudeCodeExactFileTargetSupports({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
        appTargetContextSchemaId: APP_PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
        memoryTargetContextSchemaId: PROJECT_MEMORY_TARGET_CONTEXT_SCHEMA_ID,
        appMemoryTargetContextSchemaId: APP_PROJECT_MEMORY_TARGET_CONTEXT_SCHEMA_ID,
    });
    const ENCODED_SUBAGENT_TARGET_SUPPORT = createClaudeCodeEncodedSubagentTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    });
    const APP_ENCODED_SUBAGENT_TARGET_SUPPORT = createClaudeCodeAppEncodedSubagentTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    });
    const GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT = createClaudeCodeGlobalEncodedSubagentTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT = createClaudeCodeAppGlobalEncodedSubagentTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const SKILL_GRAPH_TARGET_SUPPORT = createClaudeCodeSkillGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        canonicalSkill: currentCanonicalTargets,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    });
    const APP_SKILL_GRAPH_TARGET_SUPPORT = createClaudeCodeAppSkillGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        canonicalSkill: currentCanonicalTargets,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    });
    const GLOBAL_SKILL_GRAPH_TARGET_SUPPORT = createClaudeCodeGlobalSkillGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        canonicalSkill: currentCanonicalTargets,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT = createClaudeCodeAppGlobalSkillGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        canonicalSkill: currentCanonicalTargets,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT = createClaudeCodeJavaScriptWorkflowGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    });
    const APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT = createClaudeCodeAppJavaScriptWorkflowGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_PROJECT_GUIDANCE_TARGET.targetContextSchemaId,
    });
    const GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT = createClaudeCodeGlobalJavaScriptWorkflowGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT = createClaudeCodeAppGlobalJavaScriptWorkflowGraphTargetSupport({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemaId: APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const historicalGlobalDocumentSupports = createClaudeCodeGlobalNativeDocumentTargetSupports({
        adapterVersion: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        cliTargetContextSchemaId: GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
        appTargetContextSchemaId: APP_GLOBAL_TARGET_CONTEXT_SCHEMA_ID,
    });
    const canonicalWorkflowSupports = currentCanonicalTargets
        ? createClaudeWorkflowCanonicalSupports({
              adapterVersion: PROVIDER_VERSION,
              agentRuntimes: AGENT_RUNTIMES,
              cliProjectSchema: GUIDANCE_TARGET_SUPPORT.targetContextSchema.targetContextSchemaId,
              appProjectSchema: APP_GUIDANCE_TARGET_SUPPORT.targetContextSchema.targetContextSchemaId,
              cliGlobalSchema: GLOBAL_GUIDANCE_TARGET_SUPPORT.targetContextSchema.targetContextSchemaId,
              appGlobalSchema: APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.targetContextSchema.targetContextSchemaId,
          })
        : undefined;
    const canonicalWorkflowRows = Object.values(canonicalWorkflowSupports ?? {});
    // Each current consumer/dialect has one support. The 0.8 factory retains its original declarations.
    const EXACT_FILE_TARGET_SUPPORT = {
        ...historicalExactFileSupports,
        ...(canonicalWorkflowSupports === undefined
            ? {}
            : {
                  Workflow: canonicalWorkflowSupports.project,
                  AppWorkflow: canonicalWorkflowSupports.appProject,
              }),
    };
    const GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT = {
        ...historicalGlobalDocumentSupports,
        ...(canonicalWorkflowSupports === undefined
            ? {}
            : {
                  Workflow: canonicalWorkflowSupports.global,
                  AppWorkflow: canonicalWorkflowSupports.appGlobal,
              }),
    };
    const SOURCE_CAPABILITIES = makeClaudeCodeSourceCapabilities(AGENT_RUNTIMES);

    return {
        adapterId: "CLAUDECODE",
        displayName: "Claude Code",
        version: PROVIDER_VERSION,
        agentRuntimes: AGENT_RUNTIMES,
        targetContextSchemas: [
            GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            APP_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            GLOBAL_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.targetContextSchema,
            EXACT_FILE_TARGET_SUPPORT.Memory.targetContextSchema,
            EXACT_FILE_TARGET_SUPPORT.AppMemory.targetContextSchema,
        ],
        assetSourceCapabilities: SOURCE_CAPABILITIES,
        assetTargetCapabilities: makeTargetCapabilities(),
        materializerCapabilities: [
            GUIDANCE_TARGET_SUPPORT.materializerCapability,
            APP_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            GLOBAL_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.materializerCapability,
            RULE_TARGET_SUPPORT.materializerCapability,
            APP_RULE_TARGET_SUPPORT.materializerCapability,
            GLOBAL_RULE_TARGET_SUPPORT.materializerCapability,
            APP_GLOBAL_RULE_TARGET_SUPPORT.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.Rule.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.AppRule.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.Workflow.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.AppWorkflow.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.Memory.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.MemoryCatalog.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.AppMemory.materializerCapability,
            EXACT_FILE_TARGET_SUPPORT.AppMemoryCatalog.materializerCapability,
            JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materializerCapability,
            APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materializerCapability,
            GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materializerCapability,
            APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materializerCapability,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Rule.materializerCapability,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppRule.materializerCapability,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Workflow.materializerCapability,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppWorkflow.materializerCapability,
            SKILL_GRAPH_TARGET_SUPPORT.materializerCapability,
            APP_SKILL_GRAPH_TARGET_SUPPORT.materializerCapability,
            GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.materializerCapability,
            APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.materializerCapability,
            ENCODED_SUBAGENT_TARGET_SUPPORT.materializerCapability,
            APP_ENCODED_SUBAGENT_TARGET_SUPPORT.materializerCapability,
            GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.materializerCapability,
            APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.materializerCapability,
        ],
        renderContractDeclarations: [
            GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            GLOBAL_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
            RULE_TARGET_SUPPORT.renderContractDeclaration,
            APP_RULE_TARGET_SUPPORT.renderContractDeclaration,
            GLOBAL_RULE_TARGET_SUPPORT.renderContractDeclaration,
            APP_GLOBAL_RULE_TARGET_SUPPORT.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.Rule.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.AppRule.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.Workflow.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.AppWorkflow.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.Memory.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.MemoryCatalog.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.AppMemory.renderContractDeclaration,
            EXACT_FILE_TARGET_SUPPORT.AppMemoryCatalog.renderContractDeclaration,
            JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Rule.renderContractDeclaration,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppRule.renderContractDeclaration,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Workflow.renderContractDeclaration,
            GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppWorkflow.renderContractDeclaration,
            SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            APP_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
            ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
            APP_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
            GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
            APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
        ],
        ...(currentCanonicalTargets
            ? {
                  canonicalMaterializationValidators: [
                      ...canonicalWorkflowRows,
                      SKILL_GRAPH_TARGET_SUPPORT,
                      APP_SKILL_GRAPH_TARGET_SUPPORT,
                      GLOBAL_SKILL_GRAPH_TARGET_SUPPORT,
                      APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT,
                  ].flatMap((support) => support.canonicalMaterializationValidators),
              }
            : {}),
        dialectContracts: CLAUDECODE_DIALECT_CONTRACTS,
        sourceRead: CLAUDECODE_SOURCE_READ,

        async probe(context) {
            return probeClaudeCode(context);
        },
        targetRender: {
            consumers: [
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Guidance",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeScopeVariant(input, GUIDANCE_TARGET_SUPPORT, GLOBAL_GUIDANCE_TARGET_SUPPORT, "guidance"),
                            input,
                            GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    assetKind: "Guidance",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeScopeVariant(
                                input,
                                APP_GUIDANCE_TARGET_SUPPORT,
                                APP_GLOBAL_GUIDANCE_TARGET_SUPPORT,
                                "guidance",
                            ),
                            input,
                            APP_GUIDANCE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Rule",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeClaudeCodeRuleTargets(input, {
                                projectExact: EXACT_FILE_TARGET_SUPPORT.Rule,
                                projectCanonical: RULE_TARGET_SUPPORT,
                                globalExact: GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Rule,
                                globalCanonical: GLOBAL_RULE_TARGET_SUPPORT,
                            }),
                            input,
                            RULE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    assetKind: "Rule",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeClaudeCodeRuleTargets(input, {
                                projectExact: EXACT_FILE_TARGET_SUPPORT.AppRule,
                                projectCanonical: APP_RULE_TARGET_SUPPORT,
                                globalExact: GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppRule,
                                globalCanonical: APP_GLOBAL_RULE_TARGET_SUPPORT,
                            }),
                            input,
                            APP_RULE_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Workflow",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeClaudeCodeWorkflowTargets(input, {
                                command: EXACT_FILE_TARGET_SUPPORT.Workflow,
                                projectCanonical: canonicalWorkflowSupports?.project,
                                globalCanonical: canonicalWorkflowSupports?.global,
                                globalCommand: GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Workflow,
                                projectJavaScript: JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT,
                                globalJavaScript: GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT,
                            }),
                            input,
                            EXACT_FILE_TARGET_SUPPORT.Workflow.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    assetKind: "Workflow",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeClaudeCodeWorkflowTargets(input, {
                                command: EXACT_FILE_TARGET_SUPPORT.AppWorkflow,
                                projectCanonical: canonicalWorkflowSupports?.appProject,
                                globalCanonical: canonicalWorkflowSupports?.appGlobal,
                                globalCommand: GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppWorkflow,
                                projectJavaScript: APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT,
                                globalJavaScript: APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT,
                            }),
                            input,
                            EXACT_FILE_TARGET_SUPPORT.AppWorkflow.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Skill",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeScopeVariant(
                                input,
                                SKILL_GRAPH_TARGET_SUPPORT,
                                GLOBAL_SKILL_GRAPH_TARGET_SUPPORT,
                                "skill",
                            ),
                            input,
                            SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    assetKind: "Skill",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeScopeVariant(
                                input,
                                APP_SKILL_GRAPH_TARGET_SUPPORT,
                                APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT,
                                "skill",
                            ),
                            input,
                            APP_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Subagent",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeScopeVariant(
                                input,
                                ENCODED_SUBAGENT_TARGET_SUPPORT,
                                GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT,
                                "subagent",
                            ),
                            input,
                            ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    assetKind: "Subagent",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeScopeVariant(
                                input,
                                APP_ENCODED_SUBAGENT_TARGET_SUPPORT,
                                APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT,
                                "subagent",
                            ),
                            input,
                            APP_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    assetKind: "Memory",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeClaudeCodeMemoryTargets(
                                input,
                                EXACT_FILE_TARGET_SUPPORT.Memory,
                                EXACT_FILE_TARGET_SUPPORT.MemoryCatalog,
                            ),
                            input,
                            EXACT_FILE_TARGET_SUPPORT.Memory.renderContractDeclaration,
                        ),
                },
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    assetKind: "Memory",
                    analyze: async (input) =>
                        appendClaudeCodeBuildCompatibilityWarning(
                            await analyzeClaudeCodeMemoryTargets(
                                input,
                                EXACT_FILE_TARGET_SUPPORT.AppMemory,
                                EXACT_FILE_TARGET_SUPPORT.AppMemoryCatalog,
                            ),
                            input,
                            EXACT_FILE_TARGET_SUPPORT.AppMemory.renderContractDeclaration,
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
                    outputContractId: APP_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => APP_GUIDANCE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_GUIDANCE_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: GLOBAL_GUIDANCE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => GLOBAL_GUIDANCE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => GLOBAL_GUIDANCE_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_GLOBAL_GUIDANCE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: PROJECT_RULE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => RULE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => RULE_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_PROJECT_RULE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => APP_RULE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_RULE_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: GLOBAL_RULE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => GLOBAL_RULE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => GLOBAL_RULE_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_GLOBAL_RULE_OUTPUT_CONTRACT_ID,
                    materialize: async (input) => APP_GLOBAL_RULE_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_GLOBAL_RULE_TARGET_SUPPORT.inspect(input),
                },
                ...Object.values(EXACT_FILE_TARGET_SUPPORT).map((support) => ({
                    outputContractId: support.renderContractDeclaration.outputContractId,
                    materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                    inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
                })),
                {
                    outputContractId: ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => ENCODED_SUBAGENT_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => ENCODED_SUBAGENT_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => APP_ENCODED_SUBAGENT_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_ENCODED_SUBAGENT_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId:
                        APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                ...Object.values(GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT).map((support) => ({
                    outputContractId: support.renderContractDeclaration.outputContractId,
                    materialize: async (input: Parameters<typeof support.materialize>[0]) => support.materialize(input),
                    inspect: async (input: Parameters<typeof support.inspect>[0]) => support.inspect(input),
                })),
                {
                    outputContractId: SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => SKILL_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => SKILL_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => APP_SKILL_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_SKILL_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.inspect(input),
                },
                {
                    outputContractId: APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.renderContractDeclaration.outputContractId,
                    materialize: async (input) => APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.materialize(input),
                    inspect: async (input) => APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.inspect(input),
                },
            ],
        },
    };

    function makeTargetCapabilities(): AdapterAssetTargetCapability[] {
        return AGENT_RUNTIMES.flatMap((descriptor) =>
            ASSET_KINDS.flatMap((assetKind) =>
                descriptor.agentRuntimeId === "CLAUDE_CODE_CLI" && assetKind === "Guidance"
                    ? [GUIDANCE_TARGET_SUPPORT.targetCapability, GLOBAL_GUIDANCE_TARGET_SUPPORT.targetCapability]
                    : descriptor.agentRuntimeId === "CLAUDE_CODE_APP" && assetKind === "Guidance"
                      ? [APP_GUIDANCE_TARGET_SUPPORT.targetCapability, APP_GLOBAL_GUIDANCE_TARGET_SUPPORT.targetCapability]
                      : descriptor.agentRuntimeId === "CLAUDE_CODE_APP" && assetKind === "Skill"
                        ? [
                              APP_SKILL_GRAPH_TARGET_SUPPORT.targetCapability,
                              APP_GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.targetCapability,
                          ]
                        : descriptor.agentRuntimeId === "CLAUDE_CODE_APP" && assetKind === "Rule"
                          ? [
                                APP_RULE_TARGET_SUPPORT.targetCapability,
                                EXACT_FILE_TARGET_SUPPORT.AppRule.targetCapability,
                                APP_GLOBAL_RULE_TARGET_SUPPORT.targetCapability,
                                GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppRule.targetCapability,
                            ]
                          : descriptor.agentRuntimeId === "CLAUDE_CODE_APP" && assetKind === "Workflow"
                            ? [
                                  EXACT_FILE_TARGET_SUPPORT.AppWorkflow.targetCapability,
                                  APP_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.targetCapability,
                                  GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.AppWorkflow.targetCapability,
                                  APP_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.targetCapability,
                              ]
                            : descriptor.agentRuntimeId === "CLAUDE_CODE_APP" && assetKind === "Subagent"
                              ? [
                                    APP_ENCODED_SUBAGENT_TARGET_SUPPORT.targetCapability,
                                    APP_GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.targetCapability,
                                ]
                              : descriptor.agentRuntimeId === "CLAUDE_CODE_APP" && assetKind === "Memory"
                                ? [
                                      EXACT_FILE_TARGET_SUPPORT.AppMemory.targetCapability,
                                      EXACT_FILE_TARGET_SUPPORT.AppMemoryCatalog.targetCapability,
                                  ]
                                : descriptor.agentRuntimeId === "CLAUDE_CODE_CLI" && assetKind === "Rule"
                                  ? [
                                        RULE_TARGET_SUPPORT.targetCapability,
                                        EXACT_FILE_TARGET_SUPPORT.Rule.targetCapability,
                                        GLOBAL_RULE_TARGET_SUPPORT.targetCapability,
                                        GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Rule.targetCapability,
                                    ]
                                  : descriptor.agentRuntimeId === "CLAUDE_CODE_CLI" && assetKind === "Workflow"
                                    ? [
                                          EXACT_FILE_TARGET_SUPPORT.Workflow.targetCapability,
                                          JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.targetCapability,
                                          GLOBAL_NATIVE_DOCUMENT_TARGET_SUPPORT.Workflow.targetCapability,
                                          GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_TARGET_SUPPORT.targetCapability,
                                      ]
                                    : descriptor.agentRuntimeId === "CLAUDE_CODE_CLI" && assetKind === "Skill"
                                      ? [
                                            SKILL_GRAPH_TARGET_SUPPORT.targetCapability,
                                            GLOBAL_SKILL_GRAPH_TARGET_SUPPORT.targetCapability,
                                        ]
                                      : descriptor.agentRuntimeId === "CLAUDE_CODE_CLI" && assetKind === "Subagent"
                                        ? [
                                              ENCODED_SUBAGENT_TARGET_SUPPORT.targetCapability,
                                              GLOBAL_ENCODED_SUBAGENT_TARGET_SUPPORT.targetCapability,
                                          ]
                                        : descriptor.agentRuntimeId === "CLAUDE_CODE_CLI" && assetKind === "Memory"
                                          ? [
                                                EXACT_FILE_TARGET_SUPPORT.Memory.targetCapability,
                                                EXACT_FILE_TARGET_SUPPORT.MemoryCatalog.targetCapability,
                                            ]
                                          : [],
            ),
        );
    }
}
