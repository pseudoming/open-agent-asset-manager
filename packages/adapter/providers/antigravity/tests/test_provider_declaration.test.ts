import { resolveTargetBuildCompatibility } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { validateAdapterRenderContractRegistration } from "../../../core/src/render/adapter-render-contract-registration";
import { ANTIGRAVITY_DIALECT_CONTRACTS } from "../src/antigravity-dialects";
import { antigravityProvider } from "../src/antigravity-provider";

describe("Antigravity provider declaration", () => {
    it("registers every supported render declaration against its exact native dialect components", () => {
        expect(validateAdapterRenderContractRegistration([antigravityProvider])).toEqual([]);
    });

    it("declares CLI, App, and IDE as separate entries", () => {
        expect(antigravityProvider.agentRuntimes).toEqual([
            { agentRuntimeId: "ANTIGRAVITY_CLI", displayName: "Antigravity CLI", entryClass: "cli" },
            { agentRuntimeId: "ANTIGRAVITY_APP", displayName: "Antigravity App", entryClass: "app" },
            { agentRuntimeId: "ANTIGRAVITY_IDE", displayName: "Antigravity IDE", entryClass: "ide" },
        ]);
    });

    it("uses 1.1.11 as the nearest Guidance anchor for the current stable 1.1.22 CLI", () => {
        const declaration = antigravityProvider.renderContractDeclarations.find(
            (row) => row.outputContractId === "ANTIGRAVITY_NATIVE_PROJECT_GUIDANCE_V1",
        );
        if (declaration === undefined) throw new Error("Antigravity CLI Guidance declaration is missing");
        expect(
            resolveTargetBuildCompatibility({
                anchors: declaration.verifiedBuilds,
                policy: declaration.buildCompatibility,
                current: {
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    versionText: "1.1.22",
                    buildIdentity: "sha256:2822292f90deea4556938a8728fe4ed02a1d66d1525cf75fa07a171e36a38c25",
                    platform: "wsl",
                },
            }),
        ).toMatchObject({ status: "compatible", anchor: { versionText: "1.1.11" } });
    });

    it("declares the full runtime x kind matrix while allowing multiple exact CLI roots", () => {
        for (const descriptor of antigravityProvider.agentRuntimes) {
            const sourceKinds = new Set(
                antigravityProvider.assetSourceCapabilities
                    .filter((row) => row.agentRuntimeId === descriptor.agentRuntimeId)
                    .map((row) => row.assetKind),
            );
            const targetKinds = new Set(
                antigravityProvider.assetTargetCapabilities
                    .filter((row) => row.agentRuntimeId === descriptor.agentRuntimeId)
                    .map((row) => row.assetKind),
            );
            expect(sourceKinds).toEqual(new Set(["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"]));
            expect(targetKinds).toEqual(sourceKinds);
        }
        expect(
            antigravityProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "ANTIGRAVITY_CLI" && row.entrySupportStatus === "supported",
            ).length,
        ).toBeGreaterThan(6);
        expect(new Set(antigravityProvider.assetSourceCapabilities.map((row) => row.sourceCapabilityFingerprint)).size).toBe(
            antigravityProvider.assetSourceCapabilities.length,
        );
        expect(antigravityProvider.assetSourceCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    assetKind: "Skill",
                    rootRole: "source",
                    sourceDomain: "agent_runtime_private",
                    readPolicy: "report_only",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Skill",
                    rootRole: "source",
                    sourceDomain: "agent_runtime_private",
                    readPolicy: "report_only",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Guidance",
                    rootRole: "project_actual",
                    sourceDomain: "project_root",
                    entrySupportStatus: "supported",
                    evidenceLevel: "agent_runtime_verified",
                    readPolicy: "auto_read",
                }),
            ]),
        );
    });

    it("keeps Memory unsupported and upgrades only exact proven CLI, App, and IDE target cells", () => {
        const memorySourceRows = antigravityProvider.assetSourceCapabilities.filter((row) => row.assetKind === "Memory");
        expect(memorySourceRows).toHaveLength(3);
        expect(memorySourceRows.every((row) => row.entrySupportStatus === "unsupported")).toBe(true);
        const supportedTargets = antigravityProvider.assetTargetCapabilities.filter(
            (row) => row.entrySupportStatus === "supported",
        );
        expect(supportedTargets).toHaveLength(22);
        expect(supportedTargets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    assetKind: "Guidance",
                    renderStrategy: "native_file",
                    reverseExtractPolicy: "can_reconcile",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    assetKind: "Rule",
                    renderStrategy: "native_file",
                    reverseExtractPolicy: "can_reconcile",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    assetKind: "Skill",
                    outputContractId: "ANTIGRAVITY_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    assetKind: "Skill",
                    outputContractId: "ANTIGRAVITY_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    assetKind: "Subagent",
                    outputContractId: "ANTIGRAVITY_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    assetKind: "Subagent",
                    outputContractId: "ANTIGRAVITY_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                    renderStrategy: "native_graph",
                    reverseExtractPolicy: "can_reconcile",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Guidance",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_PROJECT_GUIDANCE_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Guidance",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_GLOBAL_GUIDANCE_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Rule",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_PROJECT_RULE_ALWAYS_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Workflow",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Workflow",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Skill",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    assetKind: "Skill",
                    outputContractId: "ANTIGRAVITY_IDE_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    assetKind: "Guidance",
                    outputContractId: "ANTIGRAVITY_APP_NATIVE_PROJECT_GUIDANCE_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    assetKind: "Rule",
                    outputContractId: "ANTIGRAVITY_APP_NATIVE_PROJECT_RULE_ALWAYS_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    assetKind: "Workflow",
                    outputContractId: "ANTIGRAVITY_APP_NATIVE_GLOBAL_WORKFLOW_MARKDOWN_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    assetKind: "Skill",
                    outputContractId: "ANTIGRAVITY_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    assetKind: "Subagent",
                    outputContractId: "ANTIGRAVITY_APP_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                }),
            ]),
        );
        expect(antigravityProvider.targetContextSchemas).toEqual([
            expect.objectContaining({ agentRuntimeId: "ANTIGRAVITY_CLI" }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                targetContextSchemaId: "ANTIGRAVITY_CLI_GLOBAL_SKILL_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_IDE",
                targetContextSchemaId: "ANTIGRAVITY_IDE_PROJECT_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_IDE",
                targetContextSchemaId: "ANTIGRAVITY_IDE_GLOBAL_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                targetContextSchemaId: "ANTIGRAVITY_APP_PROJECT_TARGET_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                targetContextSchemaId: "ANTIGRAVITY_APP_GLOBAL_TARGET_V1",
            }),
        ]);
        expect(antigravityProvider.materializerCapabilities).toHaveLength(22);
        expect(antigravityProvider.materializerCapabilities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    materializationProfileIds: ["antigravity-cli-project-guidance-v1"],
                }),
                expect.objectContaining({
                    materializationProfileIds: ["antigravity-cli-project-rule-always-v1"],
                }),
                expect.objectContaining({
                    materializationProfileIds: ["antigravity-cli-project-skill-directory-v1"],
                }),
                expect.objectContaining({
                    materializationProfileIds: ["antigravity-cli-global-skill-directory-v1"],
                }),
                expect.objectContaining({
                    materializationProfileIds: ["antigravity-cli-project-subagent-markdown-v1"],
                }),
                expect.objectContaining({
                    materializationProfileIds: ["antigravity-cli-global-subagent-markdown-v1"],
                }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-project-guidance-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-global-guidance-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-project-rule-always-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-project-workflow-markdown-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-global-workflow-markdown-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-project-skill-directory-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-ide-global-skill-directory-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-project-guidance-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-global-guidance-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-project-rule-always-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-project-workflow-markdown-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-global-workflow-markdown-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-project-skill-directory-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-global-skill-directory-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-project-subagent-markdown-v1"] }),
                expect.objectContaining({ materializationProfileIds: ["antigravity-app-global-subagent-markdown-v1"] }),
            ]),
        );
        expect(
            antigravityProvider.renderContractDeclarations.find(
                (row) => row.outputContractId === "ANTIGRAVITY_NATIVE_PROJECT_GUIDANCE_V1",
            ),
        ).toMatchObject({
            agentRuntimeId: "ANTIGRAVITY_CLI",
            buildCompatibility: {
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
            verifiedBuilds: [
                { versionText: "1.1.2" },
                {
                    versionText: "1.1.11",
                    buildIdentity: "sha256:daadeb6c2cb3df1b941beae8b5b4fdb69b6a17c795fcfeb75cebdba9c1578809",
                    platform: "wsl",
                },
            ],
        });
        expect(
            antigravityProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "ANTIGRAVITY_CLI" && row.assetKind === "Workflow",
            ),
        ).toEqual([
            expect.objectContaining({ entrySupportStatus: "supported", evidenceLevel: "local_artifact" }),
            expect.objectContaining({ entrySupportStatus: "supported", evidenceLevel: "local_artifact" }),
            expect.objectContaining({
                entrySupportStatus: "supported",
                evidenceLevel: "user_provided",
                sourceDomain: "project_root",
                rootRole: "project_actual",
                rootLocatorKind: "user_provided_path",
                readPolicy: "auto_read",
            }),
            expect.objectContaining({
                entrySupportStatus: "supported",
                evidenceLevel: "user_provided",
                sourceDomain: "external_managed",
                readPolicy: "user_selected_root_only",
            }),
        ]);
        expect(
            antigravityProvider.assetTargetCapabilities.filter(
                (row) => row.agentRuntimeId === "ANTIGRAVITY_CLI" && row.assetKind === "Workflow",
            ),
        ).toEqual([
            expect.objectContaining({
                entrySupportStatus: "unsupported",
                diagnostics: [
                    expect.objectContaining({
                        code: "antigravity_cli_workflow_target_unsupported_current_loader_absent",
                        message: expect.stringContaining("1.1.11"),
                    }),
                ],
            }),
        ]);
        expect(
            antigravityProvider.assetSourceCapabilities.filter(
                (row) => row.agentRuntimeId === "ANTIGRAVITY_IDE" && row.assetKind === "Subagent",
            ),
        ).toEqual([
            expect.objectContaining({
                entrySupportStatus: "unsupported",
                evidenceLevel: "agent_runtime_verified",
                diagnostics: [expect.objectContaining({ code: "antigravity_ide_subagent_unsupported_current_loader_absent" })],
            }),
        ]);
        expect(
            antigravityProvider.assetTargetCapabilities.filter(
                (row) => row.agentRuntimeId === "ANTIGRAVITY_IDE" && row.assetKind === "Subagent",
            ),
        ).toEqual([
            expect.objectContaining({
                entrySupportStatus: "unsupported",
                diagnostics: [expect.objectContaining({ code: "antigravity_ide_subagent_unsupported_current_loader_absent" })],
            }),
        ]);
    });

    it("registers immutable validators for every supported native source dialect", () => {
        expect(ANTIGRAVITY_DIALECT_CONTRACTS.native.map((row) => [row.definition.kind, row.definition.dialectId])).toEqual([
            ["Guidance", "antigravity-guidance-markdown-v1"],
            ["Rule", "antigravity-rule-markdown-v1"],
            ["Workflow", "antigravity-workflow-markdown-v1"],
            ["Skill", "antigravity-skill-folder-v1"],
            ["Skill", "antigravity-skill-flat-v1"],
            ["Subagent", "antigravity-subagent-json-v1"],
            ["Subagent", "antigravity-subagent-markdown-v1"],
        ]);
        expect(ANTIGRAVITY_DIALECT_CONTRACTS.restoration).toEqual([]);
    });

    it("routes malformed IDE Skill analysis through the exact IDE handler and fails closed", async () => {
        const analysis = await antigravityProvider.analyzeRender({
            deployment: {
                assets: [
                    {
                        scope: "project",
                        version: { ref: { assetId: "asset", versionId: "version" }, canonical: { kind: "Skill" } },
                    },
                ],
                targetContexts: [],
            },
            requiredSemantics: [
                {
                    semanticRefFingerprint: "sha256:semantic",
                    consumerAgentRuntimeId: "ANTIGRAVITY_IDE",
                    subject: { subjectKind: "asset", assetId: "asset", versionId: "version" },
                },
            ],
            dialectInputs: [],
        } as never);
        expect(analysis).toMatchObject({
            status: "failed",
            outputUnits: [],
            diagnostics: [{ code: "antigravity_skill_target_shape_ambiguous" }],
        });
    });

    it.each([
        "Guidance",
        "Rule",
        "Workflow",
        "Skill",
        "Subagent",
    ] as const)("routes malformed App %s analysis through its exact handler and fails closed", async (assetKind) => {
        const analysis = await antigravityProvider.analyzeRender({
            deployment: {
                assets: [
                    {
                        scope: "project",
                        version: { ref: { assetId: "asset", versionId: "version" }, canonical: { kind: assetKind } },
                    },
                ],
                targetContexts: [],
            },
            requiredSemantics: [
                {
                    semanticRefFingerprint: "sha256:semantic",
                    consumerAgentRuntimeId: "ANTIGRAVITY_APP",
                    subject: { subjectKind: "asset", assetId: "asset", versionId: "version" },
                },
            ],
            dialectInputs: [],
        } as never);
        expect(analysis).toMatchObject({ status: "failed", outputUnits: [], blockedSemanticRefs: [expect.any(Object)] });
        if (assetKind === "Workflow") {
            expect(analysis.diagnostics).toContainEqual(
                expect.objectContaining({ code: "antigravity_app_workflow_target_shape_ambiguous" }),
            );
        }
        const nativeDialectId = {
            Workflow: "antigravity-workflow-markdown-v1",
            Skill: "antigravity-skill-folder-v1",
            Subagent: "antigravity-subagent-markdown-v1",
        }[assetKind as "Workflow" | "Skill" | "Subagent"];
        if (nativeDialectId !== undefined) {
            const selectedHandler = await antigravityProvider.analyzeRender({
                deployment: {
                    assets: [
                        {
                            scope: "project",
                            version: { ref: { assetId: "asset", versionId: "version" }, canonical: { kind: assetKind } },
                        },
                    ],
                    targetContexts: [],
                },
                requiredSemantics: [
                    {
                        semanticRefFingerprint: "sha256:semantic",
                        consumerAgentRuntimeId: "ANTIGRAVITY_APP",
                        subject: { subjectKind: "asset", assetId: "asset", versionId: "version" },
                    },
                ],
                dialectInputs: [
                    {
                        targetVersion: { assetId: "asset", versionId: "version" },
                        consumerAgentRuntimeIds: ["ANTIGRAVITY_APP"],
                        inputs: [
                            {
                                inputKind: "native_representation",
                                inputRole: "current_exact",
                                representation: { dialectId: nativeDialectId },
                                files: [],
                            },
                        ],
                    },
                ],
            } as never);
            expect(selectedHandler).toMatchObject({ status: "failed", outputUnits: [] });
        }
    });

    it("fails closed at the Framework boundary for malformed target closures", async () => {
        const outputContractId = antigravityProvider.materializerCapabilities[0]?.outputContractId;
        if (outputContractId === undefined) throw new Error("Antigravity Guidance materializer fixture is missing");
        const outputUnit = { outputUnitFingerprint: "sha256:foreign", outputContractId };
        const analysis = await antigravityProvider.analyzeRender({
            deployment: {
                assets: [
                    {
                        version: {
                            ref: { assetId: "asset", versionId: "version" },
                            canonical: { kind: "Guidance" },
                        },
                    },
                ],
                targetContexts: [],
            },
            requiredSemantics: [
                {
                    semanticRefFingerprint: "sha256:semantic",
                    consumerAgentRuntimeId: "ANTIGRAVITY_CLI",
                    subject: { subjectKind: "asset", assetId: "asset", versionId: "version" },
                },
            ],
            dialectInputs: [],
        } as never);
        expect(analysis.status).toBe("failed");
        expect(analysis.blockedSemanticRefs[0]?.reasonCode).toBe("project_guidance_target_not_applicable");
        expect(
            (
                await antigravityProvider.materializeRender({
                    deployment: { assets: [], targetContexts: [] },
                    requiredSemantics: [],
                    dialectInputs: [],
                    selection: {
                        outputUnits: [outputUnit],
                        outputUnitRenderers: [],
                        semanticOptions: [],
                    },
                } as never)
            ).materializationState,
        ).toBe("blocked");
        expect(
            await antigravityProvider.inspectRenderedTarget({
                files: [{ relativePath: "foreign.md" }],
                inventoryDeltas: [],
                appliedRenderSnapshot: { decisions: [], outputUnits: [outputUnit] },
                inspectionScope: {
                    fileStates: [{ relativePath: "foreign.md", outputUnitFingerprint: outputUnit.outputUnitFingerprint }],
                    directoryInventories: [],
                },
            } as never),
        ).toMatchObject({ status: "failed", changes: [], files: [] });

        for (const appOutputContractId of [
            "ANTIGRAVITY_APP_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1",
            "ANTIGRAVITY_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            "ANTIGRAVITY_APP_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
        ]) {
            const appOutputUnit = {
                outputUnitFingerprint: `sha256:${appOutputContractId}`,
                outputContractId: appOutputContractId,
            };
            await expect(
                antigravityProvider.materializeRender({
                    deployment: { assets: [], targetContexts: [] },
                    requiredSemantics: [],
                    dialectInputs: [],
                    selection: { outputUnits: [appOutputUnit], outputUnitRenderers: [], semanticOptions: [] },
                } as never),
            ).resolves.toMatchObject({ status: "failed", materializationState: "blocked" });
            await expect(
                antigravityProvider.inspectRenderedTarget({
                    files: [{ relativePath: "foreign.md" }],
                    inventoryDeltas: [],
                    appliedRenderSnapshot: { decisions: [], outputUnits: [appOutputUnit] },
                    inspectionScope: {
                        fileStates: [{ relativePath: "foreign.md", outputUnitFingerprint: appOutputUnit.outputUnitFingerprint }],
                        directoryInventories: [],
                    },
                } as never),
            ).resolves.toMatchObject({ status: "failed", changes: [], files: [] });
        }
    });
});
