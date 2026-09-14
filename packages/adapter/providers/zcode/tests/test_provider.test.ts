import { describe, expect, it } from "vitest";
import { validateAdapterProviderRegistration } from "../../../core/src/adapters/adapter-contract-validator";
import { BUILTIN_ASSET_KINDS } from "../../../core/src/specs/registry";
import { zcodeProvider } from "../src/zcode-provider";
import { resolveZcodeSourceContext, scanZcodeReadObligation, ZCODE_SOURCE_READ } from "../src/zcode-source-read";
import { getZcodeAssetReader, ZCODE_ASSET_READER_REGISTRY } from "../src/zcode-source-read-registry";

describe("ZCode Provider declaration", () => {
    it("declares one App entry and complete source/target matrices", () => {
        expect(zcodeProvider.agentRuntimes).toEqual([
            { agentRuntimeId: "ZCODE_APP", displayName: "ZCode App", entryClass: "app" },
        ]);
        for (const assetKind of BUILTIN_ASSET_KINDS) {
            expect(zcodeProvider.assetSourceCapabilities.filter((row) => row.assetKind === assetKind).length).toBeGreaterThan(0);
            expect(zcodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === assetKind).length).toBeGreaterThan(0);
        }
        expect(new Set(zcodeProvider.assetSourceCapabilities.map((row) => row.sourceCapabilityFingerprint)).size).toBe(
            zcodeProvider.assetSourceCapabilities.length,
        );
        expect(validateAdapterProviderRegistration(zcodeProvider, [])).toEqual([]);
    });

    it("enables five callable source kinds while keeping independent Rule unsupported", () => {
        expect(
            zcodeProvider.assetSourceCapabilities
                .filter((row) => row.assetKind !== "Rule")
                .every((row) => row.entrySupportStatus === "supported" && row.readPolicy !== "report_only"),
        ).toBe(true);
        expect(zcodeProvider.assetSourceCapabilities.filter((row) => row.assetKind === "Rule")).toEqual([
            expect.objectContaining({ entrySupportStatus: "unsupported", diagnostics: [expect.any(Object)] }),
        ]);
        expect(zcodeProvider.assetSourceCapabilities.filter((row) => row.assetKind === "Memory")).toEqual([
            expect.objectContaining({
                entrySupportStatus: "supported",
                rootLocatorKind: "runtime_known_rule",
                sourceDomain: "project_keyed",
                readPolicy: "auto_read",
            }),
            expect.objectContaining({
                entrySupportStatus: "supported",
                rootLocatorKind: "runtime_declared_path",
                sourceDomain: "project_keyed",
                readPolicy: "auto_read",
            }),
        ]);
        expect(zcodeProvider.assetSourceCapabilities).toContainEqual(
            expect.objectContaining({ assetKind: "Skill", sourceDomain: "family_shared", rootRole: "source" }),
        );
        expect(zcodeProvider.assetSourceCapabilities).toContainEqual(
            expect.objectContaining({ assetKind: "Workflow", sourceDomain: "family_shared", rootRole: "source" }),
        );
    });

    it("declares an exhaustive frozen registry with five callable readers", () => {
        expect(Object.keys(ZCODE_ASSET_READER_REGISTRY).sort()).toEqual([...BUILTIN_ASSET_KINDS].sort());
        expect(
            Object.entries(ZCODE_ASSET_READER_REGISTRY)
                .filter(([, row]) => row.disposition === "reader")
                .map(([kind]) => kind)
                .sort(),
        ).toEqual(["Guidance", "Memory", "Skill", "Subagent", "Workflow"]);
        expect(getZcodeAssetReader("Rule")).toMatchObject({ disposition: "unsupported" });
        expect(getZcodeAssetReader("Guidance")).toMatchObject({ disposition: "reader" });
        expect(getZcodeAssetReader("Workflow")).toMatchObject({ disposition: "reader" });
        expect(getZcodeAssetReader("Skill")).toMatchObject({ disposition: "reader" });
        expect(getZcodeAssetReader("Subagent")).toMatchObject({ disposition: "reader" });
        expect(getZcodeAssetReader("Memory")).toMatchObject({ disposition: "reader" });
    });

    it("binds Guidance, command Workflow, complete Skill graph, Markdown Subagent, and project Memory targets", async () => {
        expect(zcodeProvider.version).toBe("0.10.0");
        expect(zcodeProvider.assetTargetCapabilities.filter((row) => row.entrySupportStatus === "supported")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Guidance",
                renderStrategy: "native_file",
                reverseExtractPolicy: "can_reconcile",
                outputContractId: "ZCODE_NATIVE_PROJECT_GUIDANCE_V1",
            }),
            expect.objectContaining({ assetKind: "Workflow", outputContractId: "ZCODE_NATIVE_PROJECT_COMMAND_WORKFLOW_V1" }),
            expect.objectContaining({ assetKind: "Workflow", outputContractId: "ZCODE_NATIVE_GLOBAL_COMMAND_WORKFLOW_V1" }),
            expect.objectContaining({ assetKind: "Skill", outputContractId: "ZCODE_NATIVE_PROJECT_SKILL_DIRECTORY_V1" }),
            expect.objectContaining({ assetKind: "Skill", outputContractId: "ZCODE_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1" }),
            expect.objectContaining({ assetKind: "Skill", outputContractId: "ZCODE_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1" }),
            expect.objectContaining({ assetKind: "Subagent", outputContractId: "ZCODE_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1" }),
            expect.objectContaining({ assetKind: "Subagent", outputContractId: "ZCODE_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1" }),
            expect.objectContaining({ assetKind: "Memory", outputContractId: "ZCODE_NATIVE_PROJECT_MEMORY_TOPIC_V1" }),
            expect.objectContaining({ assetKind: "Memory", outputContractId: "ZCODE_NATIVE_PROJECT_MEMORY_CATALOG_V1" }),
        ]);
        expect(zcodeProvider.assetTargetCapabilities.find((row) => row.assetKind === "Rule")).toMatchObject({
            entrySupportStatus: "unsupported",
        });
        expect(
            zcodeProvider.assetTargetCapabilities
                .filter(
                    (row) =>
                        row.assetKind !== "Rule" &&
                        row.assetKind !== "Guidance" &&
                        row.assetKind !== "Workflow" &&
                        row.assetKind !== "Skill" &&
                        row.assetKind !== "Subagent" &&
                        row.assetKind !== "Memory",
                )
                .every((row) => row.entrySupportStatus === "deferred"),
        ).toBe(true);
        expect(zcodeProvider.targetContextSchemas.map((row) => row.targetContextSchemaId)).toEqual([
            "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
            "ZCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
            "ZCODE_APP_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
            "ZCODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
        ]);
        const projectAuthorities = new Set(
            zcodeProvider.renderContractDeclarations
                .filter((declaration) => declaration.declarationKind.startsWith("native_project_"))
                .map((declaration) =>
                    JSON.stringify({
                        targetContextSchemaId: declaration.target.targetContextSchemaId,
                        requiredFacts: declaration.target.requiredFacts,
                    }),
                ),
        );
        expect(projectAuthorities).toEqual(
            new Set([
                JSON.stringify({
                    targetContextSchemaId: "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
                    requiredFacts: { "oaam.project-binding": "registered" },
                }),
                JSON.stringify({
                    targetContextSchemaId: "ZCODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
                    requiredFacts: { "oaam.project-binding": "registered", "oaam.target-kind": "directory" },
                }),
            ]),
        );
        expect(zcodeProvider.materializerCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outputContractId: "ZCODE_NATIVE_PROJECT_GUIDANCE_V1",
                    materializationProfileIds: ["zcode-app-project-guidance-v1"],
                }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_PROJECT_COMMAND_WORKFLOW_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_GLOBAL_COMMAND_WORKFLOW_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_PROJECT_SKILL_DIRECTORY_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_PROJECT_MEMORY_TOPIC_V1" }),
                expect.objectContaining({ outputContractId: "ZCODE_NATIVE_PROJECT_MEMORY_CATALOG_V1" }),
            ]),
        );
        expect(zcodeProvider.renderContractDeclarations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    declarationKind: "native_project_guidance_v1",
                    agentRuntimeId: "ZCODE_APP",
                    target: {
                        relativePath: "AGENTS.md",
                        targetContextSchemaId: "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
                        requiredFacts: { "oaam.project-binding": "registered" },
                    },
                    buildCompatibility: {
                        schemaVersion: 1,
                        versionOrdering: "numeric_dotted_core_v1",
                        unknownVersionPolicy: "allow_with_warning",
                        deniedBuilds: [],
                    },
                    verifiedBuilds: [
                        expect.objectContaining({
                            versionText: "3.1.8",
                            buildIdentity: "sha256:aaab9c07d95e1d6f2d2961db21195c4b48cfaaa159a78b15c0b04f91f8fe0d73",
                            platform: "wsl",
                        }),
                        expect.objectContaining({
                            versionText: "3.3.5",
                            buildIdentity: "sha256:15fd526de795655faf302ba3f0427d6eedf5f3eca78927266580c48c7820cc10",
                            platform: "win32",
                        }),
                        expect.objectContaining({
                            versionText: "3.3.5",
                            buildIdentity: "sha256:15fd526de795655faf302ba3f0427d6eedf5f3eca78927266580c48c7820cc10",
                            platform: "wsl",
                        }),
                        expect.objectContaining({
                            versionText: "3.5.3",
                            buildIdentity: "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a",
                            platform: "win32",
                        }),
                        expect.objectContaining({
                            versionText: "3.5.3",
                            buildIdentity: "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a",
                            platform: "wsl",
                        }),
                    ],
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    assetKind: "Workflow",
                    nativeDialectId: "zcode-command-markdown-v1",
                }),
                expect.objectContaining({
                    declarationKind: "native_global_exact_graph_v1",
                    assetKind: "Workflow",
                    nativeDialectId: "zcode-command-markdown-v1",
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    assetKind: "Skill",
                    nativeDialectId: "zcode-skill-directory-v1",
                }),
                expect.objectContaining({
                    declarationKind: "native_global_exact_graph_v1",
                    assetKind: "Skill",
                    nativeDialectId: "zcode-skill-directory-v1",
                }),
                expect.objectContaining({
                    declarationKind: "native_project_exact_graph_v1",
                    assetKind: "Subagent",
                    nativeDialectId: "zcode-subagent-markdown-v1",
                }),
                expect.objectContaining({
                    declarationKind: "native_global_exact_graph_v1",
                    assetKind: "Subagent",
                    nativeDialectId: "zcode-subagent-markdown-v1",
                }),
            ]),
        );
        expect(zcodeProvider.dialectContracts.restoration).toEqual([
            expect.objectContaining({ definition: expect.objectContaining({ dialectId: "zcode-memory-topic-v1" }) }),
        ]);
        expect(zcodeProvider.dialectContracts.native.map((row) => row.definition.dialectId)).toEqual([
            "zcode-guidance-markdown-v1",
            "zcode-command-markdown-v1",
            "zcode-script-workflow-javascript-v1",
            "zcode-skill-directory-v1",
            "zcode-subagent-markdown-v1",
            "zcode-memory-catalog-v1",
            "zcode-memory-topic-v1",
        ]);
        expect(
            zcodeProvider.dialectContracts.portableEntries.map((row) => [
                row.definition.kind,
                row.definition.field,
                row.definition.dialectId,
                row.definition.applicableAgentRuntimeIds,
            ]),
        ).toEqual([
            ["Workflow", "workflow_instruction", "zcode-command-markdown-v1", ["ZCODE_APP"]],
            ["Workflow", "workflow_executable", "zcode-script-workflow-javascript-v1", ["ZCODE_APP"]],
            ["Skill", "skill_entry", "zcode-skill-markdown-v1", ["ZCODE_APP"]],
        ]);
        expect(
            zcodeProvider.dialectContracts.portableSelectors.map((row) => [row.definition.kind, row.definition.field]),
        ).toEqual([
            ["Workflow", "workflow_tool"],
            ["Workflow", "workflow_model"],
            ["Subagent", "subagent_tool"],
            ["Subagent", "subagent_permission"],
            ["Subagent", "subagent_model"],
            ["Subagent", "subagent_turn_limit"],
            ["Subagent", "subagent_color"],
        ]);
        expect(
            await zcodeProvider.analyzeRender({ deployment: { assets: [], targetContexts: [] }, requiredSemantics: [] } as never),
        ).toMatchObject({ status: "complete", outputUnits: [], semanticOptions: [] });
        expect(await zcodeProvider.materializeRender({ selection: { outputUnits: [] } } as never)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [],
        });
    });

    it("reports an unbound root without invoking unavailable source hooks", async () => {
        const root = {
            sourceRootId: "root",
            rootRole: "config",
            sourceDomain: "agent_runtime_private",
            path: "/fixture",
            accessStatus: "available",
            locatorEvidence: [{ locatorKind: "runtime_known_rule", locatorKey: "fixture", evidenceLevel: "local_artifact" }],
            diagnostics: [],
        } as const;
        const result = await zcodeProvider.read({
            target: { sourceSelector: { selectorKind: "user_selected_root", binding: { sourceRoot: root } } },
            sourceReadObligations: [],
        } as never);
        expect(result.candidates).toEqual([]);
        expect(result.sourceParseReports).toEqual([
            expect.objectContaining({ sourceRootId: "root", status: "deferred", sourceReadObligationIds: [] }),
        ]);
        expect(result.sourceParseReports[0]?.diagnostics).toEqual([
            expect.objectContaining({ code: "zcode.root_without_obligation" }),
        ]);
        expect(ZCODE_SOURCE_READ.diagnostics.unknownAuthority(undefined)).toMatchObject({ code: "zcode.read_authority_unknown" });
        expect(ZCODE_SOURCE_READ.diagnostics.capabilityNotCallable(root, {} as never)).toMatchObject({
            code: "zcode.source_capability_not_callable",
        });
        expect(
            ZCODE_SOURCE_READ.diagnostics.readerUnavailable(root, {
                disposition: "deferred",
                diagnosticCode: "zcode.fixture_deferred",
                message: "fixture deferred",
            }),
        ).toMatchObject({ code: "zcode.fixture_deferred" });
        expect(ZCODE_SOURCE_READ.diagnostics.contextUnresolved(root, {} as never)).toMatchObject({
            code: "zcode.source_scope_unresolved",
        });
        expect(resolveZcodeSourceContext({} as never, root, { assetKind: "Rule" } as never)).toBeNull();
        expect(scanZcodeReadObligation).toBeTypeOf("function");
    });

    it("resolves user-selected layouts and fails closed when a project association is not unique", () => {
        const externalRoot = {
            sourceRootId: "external-root",
            rootRole: "source",
            sourceDomain: "external_managed",
            path: "/fixture/project",
            accessStatus: "available",
            locatorEvidence: [
                { locatorKind: "user_provided_path", locatorKey: "user_selection", evidenceLevel: "user_provided" },
            ],
            diagnostics: [],
        } as const;
        const selectedProject = {
            target: {
                sourceSelector: {
                    selectorKind: "user_selected_root",
                    binding: { sourceRoot: externalRoot, assetScope: "project", projectRootPath: externalRoot.path },
                },
            },
        } as never;
        expect(resolveZcodeSourceContext(selectedProject, externalRoot, { assetKind: "Skill" } as never)).toMatchObject({
            scope: "project",
            projectRootPath: externalRoot.path,
            layout: "project",
        });
        expect(resolveZcodeSourceContext(selectedProject, externalRoot, { assetKind: "Memory" } as never)).toMatchObject({
            layout: "memory",
        });

        const associatedSkillRoot = {
            ...externalRoot,
            sourceRootId: "associated-skill-root",
            sourceDomain: "project_root",
            locatorEvidence: [
                { locatorKind: "runtime_known_rule", locatorKey: "zcode_project_skill_root", evidenceLevel: "source_code" },
                { locatorKind: "user_provided_path", locatorKey: "user_selection", evidenceLevel: "user_provided" },
            ],
        } as const;
        const missingProject = {
            target: {
                sourceSelector: {
                    selectorKind: "probe_roots",
                    sourceRootIds: [associatedSkillRoot.sourceRootId],
                    observation: { sourceRoots: [associatedSkillRoot], observedProjects: [] },
                },
            },
        } as never;
        expect(resolveZcodeSourceContext(missingProject, associatedSkillRoot, { assetKind: "Skill" } as never)).toBeNull();
    });
});
