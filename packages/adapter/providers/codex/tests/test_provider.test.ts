import { describe, expect, it } from "vitest";
import { BUILTIN_ASSET_KINDS } from "../../../core/src/specs/registry";
import { validateAdapterProviderRegistration } from "../../../core/src/adapters/adapter-contract-validator";
import { codexProvider } from "../src/codex-provider";
import { CODEX_CURRENT_BUILDS, CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS } from "../src/codex-runtime-builds";
import { CODEX_SOURCE_READ, resolveCodexSourceContext, scanCodexReadObligation } from "../src/codex-source-read";
import { CODEX_ASSET_READER_REGISTRY, getCodexAssetReader } from "../src/codex-source-read-registry";

describe("Codex provider declaration", () => {
    it("keeps current source evidence independent from older exact target anchors", () => {
        expect(CODEX_CURRENT_SOURCE_EVIDENCE_BUILDS.CODEX_APP).toMatchObject({
            versionText: "0.147.0-alpha.6.5",
            buildIdentity: "sha256:fb5c760e14cf8fe86e12e49e8a3e7f237af06082d6b9fe1e411e463b7229c916",
            platform: "win32",
        });
        expect(CODEX_CURRENT_BUILDS.CODEX_APP).toMatchObject({
            versionText: "0.147.0-alpha.1.2",
            buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
            platform: "win32",
        });
    });

    it("declares the CLI/App entries and complete source/target matrices", () => {
        expect(codexProvider.agentRuntimes).toEqual([
            { agentRuntimeId: "CODEX_CLI", displayName: "Codex CLI", entryClass: "cli" },
            { agentRuntimeId: "CODEX_APP", displayName: "Codex App", entryClass: "app" },
        ]);
        for (const agentRuntimeId of ["CODEX_CLI", "CODEX_APP"]) {
            for (const assetKind of BUILTIN_ASSET_KINDS) {
                expect(
                    codexProvider.assetSourceCapabilities.filter(
                        (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === assetKind,
                    ).length,
                    `${agentRuntimeId}/${assetKind} source`,
                ).toBeGreaterThan(0);
                expect(
                    codexProvider.assetTargetCapabilities.filter(
                        (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === assetKind,
                    ),
                    `${agentRuntimeId}/${assetKind} target`,
                ).toHaveLength(
                    assetKind === "Guidance" || assetKind === "Workflow" || assetKind === "Skill" || assetKind === "Subagent"
                        ? 2
                        : 1,
                );
            }
        }
        expect(new Set(codexProvider.assetSourceCapabilities.map((row) => row.sourceCapabilityFingerprint)).size).toBe(
            codexProvider.assetSourceCapabilities.length,
        );
        expect(validateAdapterProviderRegistration(codexProvider, [])).toEqual([]);
    });

    it("keeps exact CLI/App source rows truthful while excluding exec-policy Rule and reading only final Memory artifacts", () => {
        expect(
            codexProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "CODEX_CLI" && row.assetKind === "Guidance" && row.readPolicy !== "report_only",
            ),
        ).toEqual([
            expect.objectContaining({ rootRole: "config", rootLocatorKind: "runtime_known_rule", readPolicy: "auto_read" }),
            expect.objectContaining({ rootRole: "config", rootLocatorKind: "runtime_declared_path", readPolicy: "auto_read" }),
            expect.objectContaining({
                rootRole: "project_actual",
                rootLocatorKind: "project_registry_entry",
                readPolicy: "auto_read",
            }),
            expect.objectContaining({
                rootRole: "project_actual",
                rootLocatorKind: "user_provided_path",
                readPolicy: "auto_read",
            }),
            expect.objectContaining({ sourceDomain: "external_managed", readPolicy: "user_selected_root_only" }),
        ]);
        expect(
            codexProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Guidance" && row.readPolicy !== "report_only",
            ),
        ).toEqual([
            expect.objectContaining({ rootRole: "config", rootLocatorKind: "runtime_known_rule", readPolicy: "auto_read" }),
            expect.objectContaining({ rootRole: "config", rootLocatorKind: "runtime_declared_path", readPolicy: "auto_read" }),
            expect.objectContaining({ rootRole: "project_actual", rootLocatorKind: "project_registry_entry" }),
            expect.objectContaining({ rootRole: "project_actual", rootLocatorKind: "user_provided_path" }),
            expect.objectContaining({ sourceDomain: "external_managed", readPolicy: "user_selected_root_only" }),
        ]);
        expect(
            codexProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "CODEX_CLI" && row.assetKind === "Skill" && row.readPolicy !== "report_only",
            ),
        ).toEqual([
            expect.objectContaining({ rootRole: "source", sourceDomain: "family_shared", readPolicy: "auto_read" }),
            expect.objectContaining({
                rootRole: "project_actual",
                sourceDomain: "project_root",
                rootLocatorKind: "project_registry_entry",
                readPolicy: "auto_read",
            }),
            expect.objectContaining({
                rootRole: "project_actual",
                sourceDomain: "project_root",
                rootLocatorKind: "user_provided_path",
                readPolicy: "auto_read",
            }),
            expect.objectContaining({ sourceDomain: "external_managed", readPolicy: "user_selected_root_only" }),
        ]);
        expect(
            codexProvider.assetSourceCapabilities.find(
                (row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Skill" && row.sourceDomain === "family_shared",
            ),
        ).toMatchObject({ entrySupportStatus: "supported", readPolicy: "auto_read", evidenceLevel: "source_code" });
        expect(
            codexProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Skill" && row.readPolicy !== "report_only",
            ),
        ).toEqual([
            expect.objectContaining({ rootRole: "source", sourceDomain: "family_shared", readPolicy: "auto_read" }),
            expect.objectContaining({ rootRole: "project_actual", rootLocatorKind: "project_registry_entry" }),
            expect.objectContaining({ rootRole: "project_actual", rootLocatorKind: "user_provided_path" }),
            expect.objectContaining({ sourceDomain: "external_managed", readPolicy: "user_selected_root_only" }),
        ]);
        for (const agentRuntimeId of ["CODEX_CLI", "CODEX_APP"]) {
            expect(
                codexProvider.assetSourceCapabilities.filter(
                    (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === "Rule",
                ),
            ).toEqual([expect.objectContaining({ entrySupportStatus: "unsupported", diagnostics: [expect.any(Object)] })]);
            expect(
                codexProvider.assetSourceCapabilities.filter(
                    (row) => row.agentRuntimeId === agentRuntimeId && row.assetKind === "Memory",
                ),
            ).toEqual([
                expect.objectContaining({
                    entrySupportStatus: "supported",
                    rootRole: "config",
                    sourceDomain: "family_shared",
                    readPolicy: "auto_read",
                    diagnostics: [],
                }),
                expect.objectContaining({
                    entrySupportStatus: "supported",
                    rootRole: "config",
                    sourceDomain: "family_shared",
                    readPolicy: "auto_read",
                    diagnostics: [],
                }),
            ]);
        }
        expect(
            codexProvider.assetSourceCapabilities.find(
                (row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Workflow",
            ),
        ).toMatchObject({ entrySupportStatus: "unsupported" });
        expect(
            codexProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "CODEX_CLI" && row.assetKind === "Workflow" && row.readPolicy !== "report_only",
            ).length,
        ).toBeGreaterThan(0);
        expect(
            codexProvider.assetSourceCapabilities
                .filter((row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Workflow")
                .every((row) => row.readPolicy === "report_only"),
        ).toBe(true);
        for (const agentRuntimeId of ["CODEX_CLI", "CODEX_APP"]) {
            expect(
                codexProvider.assetSourceCapabilities.filter(
                    (row) =>
                        row.agentRuntimeId === agentRuntimeId && row.assetKind === "Subagent" && row.readPolicy !== "report_only",
                ).length,
            ).toBeGreaterThan(0);
        }
    });

    it("has real Guidance, Workflow, Skill, Subagent, and Memory readers with explicit unavailable Rule", () => {
        expect(Object.keys(CODEX_ASSET_READER_REGISTRY).sort()).toEqual([...BUILTIN_ASSET_KINDS].sort());
        expect(Object.values(CODEX_ASSET_READER_REGISTRY).filter((row) => row.disposition === "reader")).toHaveLength(5);
        expect(getCodexAssetReader("Rule")).toMatchObject({ disposition: "unsupported" });
        expect(getCodexAssetReader("Guidance")).toMatchObject({ disposition: "reader" });
        expect(getCodexAssetReader("Workflow")).toMatchObject({ disposition: "reader" });
        expect(getCodexAssetReader("Skill")).toMatchObject({ disposition: "reader" });
        expect(getCodexAssetReader("Subagent")).toMatchObject({ disposition: "reader" });
        expect(getCodexAssetReader("Memory")).toMatchObject({ disposition: "reader" });
    });

    it("supports exact CLI/App Guidance, reviewed Workflow migration, Skill graphs and Subagent targets", async () => {
        expect(codexProvider.assetTargetCapabilities.filter((row) => row.entrySupportStatus === "supported")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Guidance",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_PROJECT_GUIDANCE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Guidance",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_GLOBAL_GUIDANCE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Workflow",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Workflow",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Skill",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Skill",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Subagent",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Subagent",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_NATIVE_GLOBAL_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Guidance",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_GUIDANCE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Guidance",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_GUIDANCE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Workflow",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Workflow",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Skill",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Skill",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Subagent",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Subagent",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SUBAGENT_ONE_FILE_V1",
            }),
        ]);
        expect(codexProvider.assetTargetCapabilities.filter((row) => row.entrySupportStatus === "deferred")).toHaveLength(2);
        expect(codexProvider.assetTargetCapabilities.filter((row) => row.entrySupportStatus === "unsupported")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Rule",
                diagnostics: [
                    expect.objectContaining({
                        code: "codex_cli_rule_target_unsupported",
                        message: expect.stringContaining("Codex CLI .rules files are command-execution approval policy"),
                    }),
                ],
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Rule",
                diagnostics: [
                    expect.objectContaining({
                        code: "codex_app_rule_target_unsupported",
                        message: expect.stringContaining("Codex App .rules files are command-execution approval policy"),
                    }),
                ],
            }),
        ]);
        expect(codexProvider.targetContextSchemas).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                targetContextSchemaId: "CODEX_CLI_PROJECT_GUIDANCE_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                targetContextSchemaId: "CODEX_APP_PROJECT_SKILL_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                targetContextSchemaId: "CODEX_CLI_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                targetContextSchemaId: "CODEX_APP_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                targetContextSchemaId: "CODEX_CLI_GLOBAL_CONFIG_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                targetContextSchemaId: "CODEX_APP_GLOBAL_CONFIG_TARGET_V1",
            }),
        ]);
        expect(codexProvider.materializerCapabilities).toEqual([
            expect.objectContaining({
                outputContractId: "CODEX_NATIVE_PROJECT_GUIDANCE_V1",
                materializationProfileIds: ["codex-cli-project-guidance-v1"],
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-project-guidance-native-v1",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_GUIDANCE_V1",
                materializationProfileIds: ["codex-app-project-guidance-v1"],
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-project-skill-exact-graph-v1",
                outputContractId: "CODEX_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-global-skill-exact-graph-v1",
                outputContractId: "CODEX_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-project-skill-exact-graph-v1",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-global-skill-exact-graph-v1",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-project-subagent-exact-file-v1",
                outputContractId: "CODEX_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-project-subagent-exact-file-v1",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-global-guidance-native-v1",
                outputContractId: "CODEX_NATIVE_GLOBAL_GUIDANCE_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-global-subagent-exact-graph-v1",
                outputContractId: "CODEX_NATIVE_GLOBAL_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-global-guidance-native-v1",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_GUIDANCE_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-global-subagent-exact-graph-v1",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-project-workflow-as-skill-v1",
                outputContractId: "CODEX_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.cli-global-workflow-as-skill-v1",
                outputContractId: "CODEX_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-project-workflow-as-skill-v1",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                materializerCapabilityKey: "codex.app-global-workflow-as-skill-v1",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
        ]);
        expect(codexProvider.renderContractDeclarations).toEqual([
            expect.objectContaining({
                declarationKind: "native_project_guidance_v1",
                agentRuntimeId: "CODEX_CLI",
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "CODEX_CLI_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: {},
                },
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "0.142.5",
                        buildIdentity: "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
                        platform: "wsl",
                    }),
                    expect.objectContaining({
                        versionText: "0.140.0",
                        buildIdentity: "sha256:b3b2a5f4ae29a584e594287d08c717e0454d21e47602e4314fca541e327a3c3e",
                        platform: "wsl",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_project_guidance_v1",
                agentRuntimeId: "CODEX_APP",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_GUIDANCE_V1",
                target: {
                    relativePath: "AGENTS.md",
                    targetContextSchemaId: "CODEX_APP_PROJECT_SKILL_TARGET_V1",
                    requiredFacts: {},
                },
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "0.147.0-alpha.1.2",
                        buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
                        platform: "win32",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_graph_v1",
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Skill",
                outputContractId: "CODEX_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "0.142.5",
                        buildIdentity: "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
                        platform: "wsl",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_global_exact_graph_v1",
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Skill",
                outputContractId: "CODEX_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                target: expect.objectContaining({ requiredFacts: { "oaam.target-kind": "directory" } }),
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_graph_v1",
                agentRuntimeId: "CODEX_APP",
                assetKind: "Skill",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "0.147.0-alpha.1.2",
                        buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
                        platform: "win32",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_global_exact_graph_v1",
                agentRuntimeId: "CODEX_APP",
                assetKind: "Skill",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                target: expect.objectContaining({ requiredFacts: { "oaam.target-kind": "directory" } }),
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_file_v1",
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Subagent",
                outputContractId: "CODEX_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "0.142.5",
                        buildIdentity: "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
                        platform: "wsl",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_file_v1",
                agentRuntimeId: "CODEX_APP",
                assetKind: "Subagent",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
                verifiedBuilds: [
                    expect.objectContaining({
                        versionText: "0.147.0-alpha.1.2",
                        buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
                        platform: "win32",
                    }),
                ],
            }),
            expect.objectContaining({
                declarationKind: "native_global_guidance_v1",
                agentRuntimeId: "CODEX_CLI",
                outputContractId: "CODEX_NATIVE_GLOBAL_GUIDANCE_V1",
                target: expect.objectContaining({ targetContextSchemaId: "CODEX_CLI_GLOBAL_CONFIG_TARGET_V1" }),
            }),
            expect.objectContaining({
                declarationKind: "native_global_exact_graph_v1",
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Subagent",
                outputContractId: "CODEX_NATIVE_GLOBAL_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                declarationKind: "native_global_guidance_v1",
                agentRuntimeId: "CODEX_APP",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_GUIDANCE_V1",
                target: expect.objectContaining({ targetContextSchemaId: "CODEX_APP_GLOBAL_CONFIG_TARGET_V1" }),
            }),
            expect.objectContaining({
                declarationKind: "native_global_exact_graph_v1",
                agentRuntimeId: "CODEX_APP",
                assetKind: "Subagent",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SUBAGENT_ONE_FILE_V1",
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_graph_v1",
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Workflow",
                nativeDialectId: "codex-workflow-as-skill-v1",
                outputContractId: "CODEX_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
                canonicalMaterialization: expect.objectContaining({
                    reasonCode: "codex_workflow_converted_to_skill",
                    substituteAssetKind: "Skill",
                    degradationKinds: [
                        "runtime_specific_metadata_lost",
                        "target_runtime_missing_asset_kind",
                        "workflow_trigger_lost",
                    ],
                }),
            }),
            expect.objectContaining({
                declarationKind: "native_global_exact_graph_v1",
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Workflow",
                outputContractId: "CODEX_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                declarationKind: "native_project_exact_graph_v1",
                agentRuntimeId: "CODEX_APP",
                assetKind: "Workflow",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                declarationKind: "native_global_exact_graph_v1",
                agentRuntimeId: "CODEX_APP",
                assetKind: "Workflow",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
        ]);
        expect(codexProvider.dialectContracts).toMatchObject({
            native: [
                expect.objectContaining({ definition: expect.objectContaining({ dialectId: "codex-guidance-markdown-v1" }) }),
                expect.objectContaining({
                    definition: expect.objectContaining({
                        dialectId: "codex-skill-directory-v1",
                        rebaseMaterializer: expect.objectContaining({
                            componentId: "codex.skill-directory-parent-rebase-v1",
                        }),
                    }),
                }),
                expect.objectContaining({
                    definition: expect.objectContaining({
                        dialectId: "codex-subagent-toml-v1",
                    }),
                }),
                expect.objectContaining({
                    definition: expect.objectContaining({
                        dialectId: "codex-subagent-toml-v2",
                        rebaseMaterializer: expect.objectContaining({
                            componentId: "codex.project-subagent-one-file-parent-rebase-v1",
                        }),
                    }),
                }),
                expect.objectContaining({
                    definition: expect.objectContaining({ dialectId: "codex-custom-prompt-markdown-v1" }),
                }),
                expect.objectContaining({
                    definition: expect.objectContaining({
                        dialectId: "codex-workflow-as-skill-v1",
                        rebaseMaterializer: expect.objectContaining({
                            componentId: "codex.workflow-as-skill-parent-rebase-v1",
                        }),
                    }),
                }),
                expect.objectContaining({
                    definition: expect.objectContaining({
                        dialectId: "codex-consolidated-memory-v1",
                        kind: "Memory",
                        rebaseMaterializer: null,
                    }),
                }),
            ],
            restoration: [],
            portableEntries: [
                expect.objectContaining({ definition: expect.objectContaining({ dialectId: "codex-skill-markdown-v1" }) }),
                expect.objectContaining({
                    definition: expect.objectContaining({ dialectId: "codex-custom-prompt-markdown-v1" }),
                }),
            ],
            portableSelectors: [
                expect.objectContaining({ definition: expect.objectContaining({ dialectId: "codex-subagent-model-v1" }) }),
                expect.objectContaining({
                    definition: expect.objectContaining({ dialectId: "codex-subagent-reasoning-effort-v1" }),
                }),
            ],
        });
        expect(
            await codexProvider.analyzeRender({
                deployment: { assets: [], targetContexts: [] },
                requiredSemantics: [],
            } as never),
        ).toMatchObject({ status: "complete", outputUnits: [], semanticOptions: [] });
        expect(await codexProvider.materializeRender({ selection: { outputUnits: [] } } as never)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [],
        });
    });

    it("reports an unbound root instead of invoking unavailable source hooks", async () => {
        const root = {
            sourceRootId: "root",
            rootRole: "config",
            sourceDomain: "family_shared",
            path: "/fixture",
            accessStatus: "available",
            locatorEvidence: [{ locatorKind: "runtime_known_rule", locatorKey: "fixture", evidenceLevel: "local_artifact" }],
            diagnostics: [],
        } as const;
        const result = await codexProvider.read({
            target: {
                sourceSelector: {
                    selectorKind: "user_selected_root",
                    binding: { sourceRoot: root },
                },
            },
            sourceReadObligations: [],
        } as never);
        expect(result.candidates).toEqual([]);
        expect(result.sourceParseReports).toEqual([
            expect.objectContaining({ sourceRootId: "root", status: "deferred", sourceReadObligationIds: [] }),
        ]);
        expect(result.diagnostics).toEqual([]);
        expect(result.sourceParseReports[0]?.diagnostics).toEqual([
            expect.objectContaining({ code: "codex.root_without_obligation" }),
        ]);
        expect(CODEX_SOURCE_READ.diagnostics.unknownAuthority(undefined)).toMatchObject({
            code: "codex.read_authority_unknown",
        });
        expect(CODEX_SOURCE_READ.diagnostics.capabilityNotCallable(root, {} as never)).toMatchObject({
            code: "codex.source_capability_not_callable",
        });
        expect(
            CODEX_SOURCE_READ.diagnostics.readerUnavailable(root, {
                disposition: "deferred",
                diagnosticCode: "codex.fixture_deferred",
                message: "fixture deferred",
            }),
        ).toMatchObject({ code: "codex.fixture_deferred" });
        expect(CODEX_SOURCE_READ.diagnostics.contextUnresolved(root, {} as never)).toMatchObject({
            code: "codex.source_scope_unresolved",
        });
        expect(resolveCodexSourceContext({} as never, root, { assetKind: "Rule" } as never)).toBeNull();
        expect(scanCodexReadObligation).toEqual(expect.any(Function));
    });
});
