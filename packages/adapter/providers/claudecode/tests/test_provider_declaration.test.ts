import { describe, expect, it } from "vitest";
import { validateAdapterRenderContractRegistration } from "../../../core/src/render/adapter-render-contract-registration";
import { claudecodeProvider } from "../src/claudecode-provider";
import { EXPECTED_AGENT_RUNTIMES, KINDS } from "./claudecode-provider-test-expectations";

const EXPECTED_TARGET_COUNTS = {
    CLAUDE_CODE_CLI: { Guidance: 2, Rule: 4, Workflow: 4, Skill: 2, Subagent: 2, Memory: 2 },
    CLAUDE_CODE_APP: { Guidance: 2, Rule: 4, Workflow: 4, Skill: 2, Subagent: 2, Memory: 2 },
} as const;

const EXPECTED_OUTPUT_CONTRACT_IDS = [
    "CLAUDECODE_NATIVE_PROJECT_GUIDANCE_V1",
    "CLAUDECODE_NATIVE_GLOBAL_GUIDANCE_V1",
    "CLAUDECODE_NATIVE_PROJECT_RULE_V1",
    "CLAUDECODE_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
    "CLAUDECODE_NATIVE_GLOBAL_RULE_V1",
    "CLAUDECODE_NATIVE_GLOBAL_RULE_EXACT_GRAPH_V1",
    "CLAUDECODE_NATIVE_PROJECT_WORKFLOW_COMMAND_V1_CANONICAL_V1",
    "CLAUDECODE_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1",
    "CLAUDECODE_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1_CANONICAL_V1",
    "CLAUDECODE_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1",
    "CLAUDECODE_NATIVE_PROJECT_SKILL_GRAPH_V1",
    "CLAUDECODE_NATIVE_GLOBAL_SKILL_GRAPH_V1",
    "CLAUDECODE_NATIVE_PROJECT_SUBAGENT_ENCODED_FILE_V1",
    "CLAUDECODE_NATIVE_GLOBAL_SUBAGENT_ENCODED_FILE_V1",
    "CLAUDECODE_NATIVE_PROJECT_MEMORY_TOPIC_V1",
    "CLAUDECODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_GUIDANCE_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_RULE_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_RULE_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_RULE_EXACT_GRAPH_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_WORKFLOW_COMMAND_V1_CANONICAL_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1_CANONICAL_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_SKILL_GRAPH_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_SKILL_GRAPH_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_SUBAGENT_ENCODED_FILE_V1",
    "CLAUDECODE_APP_NATIVE_GLOBAL_SUBAGENT_ENCODED_FILE_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1",
    "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_CATALOG_V1",
] as const;

describe("Claude Code provider declaration", () => {
    it("keeps CLI/App source rows exact while making the verified shared configuration root callable", () => {
        expect(claudecodeProvider.version).toBe("0.9.0");
        expect(claudecodeProvider.agentRuntimes).toEqual(EXPECTED_AGENT_RUNTIMES);
        for (const kind of KINDS) {
            expect(
                claudecodeProvider.assetSourceCapabilities.some(
                    (row) =>
                        row.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                        row.assetKind === kind &&
                        row.entrySupportStatus === "supported",
                ),
            ).toBe(true);
            const appRows = claudecodeProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "CLAUDE_CODE_APP" && row.assetKind === kind,
            );
            expect(appRows).toHaveLength(kind === "Memory" ? 2 : 4);
            expect(appRows.every((row) => row.entrySupportStatus === "supported" && row.readPolicy === "auto_read")).toBe(true);
            if (kind === "Memory") {
                expect(appRows.every((row) => row.rootRole === "source" && row.sourceDomain === "project_keyed")).toBe(true);
            } else {
                expect(appRows).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            rootLocatorKind: "runtime_known_rule",
                            rootRole: "config",
                            sourceDomain: "agent_runtime_private",
                            evidenceLevel: "agent_runtime_verified",
                            diagnostics: [],
                        }),
                        expect.objectContaining({
                            rootLocatorKind: "runtime_declared_path",
                            rootRole: "config",
                            sourceDomain: "agent_runtime_private",
                            evidenceLevel: "agent_runtime_verified",
                            diagnostics: [],
                        }),
                        expect.objectContaining({
                            rootLocatorKind: "user_provided_path",
                            rootRole: "project_actual",
                            sourceDomain: "project_root",
                            evidenceLevel: "agent_runtime_verified",
                            diagnostics: [],
                        }),
                        expect.objectContaining({
                            rootLocatorKind: "project_registry_entry",
                            rootRole: "project_actual",
                            sourceDomain: "project_root",
                            evidenceLevel: "local_artifact",
                            diagnostics: [],
                        }),
                    ]),
                );
            }
        }
        expect(new Set(claudecodeProvider.assetSourceCapabilities.map((row) => row.sourceCapabilityFingerprint)).size).toBe(
            claudecodeProvider.assetSourceCapabilities.length,
        );
    });

    it("declares one exact project/global lifecycle matrix for each CLI and App entry", () => {
        expect(claudecodeProvider.assetTargetCapabilities).toHaveLength(EXPECTED_OUTPUT_CONTRACT_IDS.length);
        expect(claudecodeProvider.assetTargetCapabilities.every((row) => row.entrySupportStatus === "supported")).toBe(true);
        for (const [runtimeId, kindCounts] of Object.entries(EXPECTED_TARGET_COUNTS)) {
            for (const [assetKind, expectedCount] of Object.entries(kindCounts)) {
                expect(
                    claudecodeProvider.assetTargetCapabilities.filter(
                        (row) => row.agentRuntimeId === runtimeId && row.assetKind === assetKind,
                    ),
                ).toHaveLength(expectedCount);
            }
        }

        const targetIds = claudecodeProvider.assetTargetCapabilities.map((row) => row.outputContractId).sort();
        const materializerIds = claudecodeProvider.materializerCapabilities.map((row) => row.outputContractId).sort();
        const declarationIds = claudecodeProvider.renderContractDeclarations.map((row) => row.outputContractId).sort();
        expect(targetIds).toEqual([...EXPECTED_OUTPUT_CONTRACT_IDS].sort());
        expect(materializerIds).toEqual(targetIds);
        expect(declarationIds).toEqual(targetIds);
        expect(new Set(claudecodeProvider.materializerCapabilities.map((row) => row.materializerCapabilityKey)).size).toBe(
            claudecodeProvider.materializerCapabilities.length,
        );

        expect(claudecodeProvider.targetContextSchemas.map((schema) => schema.targetContextSchemaId)).toEqual([
            "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
            "CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1",
            "CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1",
            "CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1",
            "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
            "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
        ]);
        expect(
            claudecodeProvider.renderContractDeclarations.filter((row) => row.declarationKind.startsWith("native_global_")),
        ).toHaveLength(14);
        expect(
            claudecodeProvider.renderContractDeclarations.filter(
                (row) => row.declarationKind === "native_global_encoded_file_v1",
            ),
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_CLI",
                assetKind: "Subagent",
                outputContractId: "CLAUDECODE_NATIVE_GLOBAL_SUBAGENT_ENCODED_FILE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_APP",
                assetKind: "Subagent",
                outputContractId: "CLAUDECODE_APP_NATIVE_GLOBAL_SUBAGENT_ENCODED_FILE_V1",
            }),
        ]);
    });

    it("retains one versioned Claude native dialect owner across project and global declarations", () => {
        expect(
            claudecodeProvider.dialectContracts.native
                .filter((contract) => contract.definition.kind !== "Memory")
                .map((contract) => [contract.definition.kind, contract.definition.dialectId]),
        ).toEqual([
            ["Guidance", "claudecode-guidance-markdown-v1"],
            ["Rule", "claudecode-rule-markdown-v1"],
            ["Workflow", "claudecode-command-markdown-v1"],
            ["Workflow", "claudecode-js-workflow-v1"],
            ["Skill", "claudecode-skill-directory-v1"],
            ["Subagent", "claudecode-subagent-markdown-v1"],
        ]);
        expect(
            claudecodeProvider.dialectContracts.native
                .filter((contract) => contract.definition.kind !== "Memory" && contract.definition.rebaseMaterializer != null)
                .map((contract) => contract.definition.rebaseMaterializer?.componentId),
        ).toEqual([
            "claudecode.project-rule-parent-rebase-v1",
            "claudecode.project-workflow-command-parent-rebase-v1",
            "claudecode.project-javascript-workflow-parent-rebase-v1",
            "claudecode.project-skill-directory-parent-rebase-v1",
            "claudecode.project-subagent-encoded-file-parent-rebase-v1",
        ]);
    });

    it("registers the complete project and global declaration set with Core", () => {
        expect(validateAdapterRenderContractRegistration([claudecodeProvider])).toEqual([]);
    });
});
