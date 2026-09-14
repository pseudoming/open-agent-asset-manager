import * as crypto from "node:crypto";
import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    Sha256Digest,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { resolveProviderExactFileDialectInputs } from "../../../core/src/render/render-dialect-authority";
import { codexProvider } from "../src/codex-provider";
import { CODEX_NATIVE_DIALECTS } from "../src/codex-source-read-model";
import {
    createCodexWorkflowMigrationTargetSupports,
    validateCodexWorkflowAsSkillDialect,
} from "../src/codex-target-workflow-migration";

type CodexRuntime = "CODEX_CLI" | "CODEX_APP";
type WorkflowVariant = "project_cli" | "global_cli" | "project_app" | "global_app";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const FILE_ID = "66666666-6666-4666-8666-666666666666";
const BODY = "Review the selected change. OAAM_CODEX_WORKFLOW_MIGRATION_41A7D2\n";
const CHANGED_BODY = BODY.replace("41A7D2", "99C4E1");

const supports = createCodexWorkflowMigrationTargetSupports({
    adapterVersion: codexProvider.version,
    agentRuntimes: codexProvider.agentRuntimes,
});

describe("Codex reviewed Workflow-to-Skill migration", () => {
    it("registers exact CLI/App project/global migration declarations without changing source truth", () => {
        expect(codexProvider.version).toBe("0.19.0");
        expect(codexProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Workflow")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                entrySupportStatus: "supported",
                outputContractId: "CODEX_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                entrySupportStatus: "supported",
                outputContractId: "CODEX_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                entrySupportStatus: "supported",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_WORKFLOW_AS_SKILL_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                entrySupportStatus: "supported",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_WORKFLOW_AS_SKILL_V1",
            }),
        ]);
        expect(
            codexProvider.assetSourceCapabilities.find(
                (row) => row.agentRuntimeId === "CODEX_APP" && row.assetKind === "Workflow",
            ),
        ).toMatchObject({ entrySupportStatus: "unsupported", readPolicy: "report_only" });
        expect(supports.CODEX_CLI.project.renderContractDeclaration.canonicalMaterialization).toMatchObject({
            reasonCode: "codex_workflow_converted_to_skill",
            substituteAssetKind: "Skill",
            degradationKinds: ["runtime_specific_metadata_lost", "target_runtime_missing_asset_kind", "workflow_trigger_lost"],
        });
    });

    it.each([
        "project_cli",
        "global_cli",
        "project_app",
        "global_app",
    ] as const)("migrates %s canonical content only after explicit semantic-degradation review", async (variant) => {
        const fixture = canonicalMigrationFixture(variant);
        expect(fixture.dialectInputs[0]?.inputs).toEqual([
            expect.objectContaining({
                inputKind: "canonical_materialization",
                nativeDialectId: CODEX_NATIVE_DIALECTS.workflowAsSkill,
                reasonCode: "codex_workflow_converted_to_skill",
                substituteAssetKind: "Skill",
            }),
        ]);
        const analysis = await codexProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.semanticOptions).toHaveLength(fixture.requiredSemantics.length);
        for (const option of analysis.semanticOptions) {
            expect(option.diagnostics).toEqual([
                expect.objectContaining({
                    code: "render.canonical_conversion_review_required",
                    causeKind: "partial",
                    severity: "warning",
                }),
            ]);
        }
        expect(analysis.semanticOptions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "degraded",
                    reasonCode: "codex_workflow_converted_to_skill",
                    substituteAssetKind: "Skill",
                    degradationKinds: [
                        "runtime_specific_metadata_lost",
                        "target_runtime_missing_asset_kind",
                        "workflow_trigger_lost",
                    ],
                    approvalRequirement: expect.objectContaining({
                        approvalState: "required",
                        concerns: ["semantic_degradation"],
                    }),
                }),
            ]),
        );
        const request = materializationInput(fixture, variant);
        const materialized = await codexProvider.materializeRender(request);
        assertCanonicalEntryControls(codexProvider, request, materialized);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: targetPath(variant),
                            content: {
                                contentKind: "text",
                                text: nativeText(BODY),
                            },
                            executable: false,
                        },
                    ],
                },
            ],
        });
    });

    it.each([
        "project_cli",
        "global_cli",
        "project_app",
        "global_app",
    ] as const)("restores current exact and rebases the immediate parent for %s", async (variant) => {
        const current = nativeFixture(variant, "current_exact", BODY, BODY);
        const currentAnalysis = await codexProvider.analyzeRender(current);
        expect(currentAnalysis.status).toBe("complete");
        expect(currentAnalysis.semanticOptions.every((option) => option.outcome === "preserved")).toBe(true);
        expect(await codexProvider.materializeRender(materializationInput(current, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: nativeText(BODY) } }] }],
        });

        const rebased = nativeFixture(variant, "parent_rebase_seed", BODY, CHANGED_BODY);
        const rebaseAnalysis = await codexProvider.analyzeRender(rebased);
        expect(rebaseAnalysis.status).toBe("complete");
        expect(rebaseAnalysis.semanticOptions.every((option) => option.outcome === "preserved")).toBe(true);
        expect(await codexProvider.materializeRender(materializationInput(rebased, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: nativeText(CHANGED_BODY) } }] }],
        });
    });

    it("reverses only the migrated body and rejects frontmatter drift", async () => {
        const fixture = nativeFixture("project_cli", "current_exact", BODY, BODY);
        const materialization = materializationInput(fixture, "project_cli");
        const inspection = changedInspection(fixture, materialization, nativeText(BODY), nativeText(CHANGED_BODY));
        expect(await codexProvider.inspectRenderedTarget(inspection)).toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: CHANGED_BODY },
                }),
            ],
        });

        const drifted = changedInspection(
            fixture,
            materialization,
            nativeText(BODY),
            nativeText(CHANGED_BODY).replace('description: "Reviewed Codex Workflow"', 'description: "Changed"'),
        );
        expect(await codexProvider.inspectRenderedTarget(drifted)).toMatchObject({
            status: "complete",
            files: [expect.objectContaining({ attributionState: "conflict" })],
            changes: [],
        });

        const malformed = changedInspection(fixture, materialization, nativeText(BODY), "missing frontmatter\n");
        expect(supportFor("project_cli").inspect(malformed).files).toEqual([
            expect.objectContaining({ attributionState: "conflict" }),
        ]);

        const binary = changedInspection(fixture, materialization, nativeText(BODY), nativeText(CHANGED_BODY));
        const changed = binary.files[0];
        if (changed?.fileState !== "baseline_changed") throw new Error("Workflow changed-file fixture is missing");
        changed.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
        expect(supportFor("project_cli").inspect(binary).files).toEqual([
            expect.objectContaining({ attributionState: "conflict" }),
        ]);
    });

    it("rejects malformed immediate-parent graphs before they can seed a migration", () => {
        const extra = nativeFixture("project_cli", "parent_rebase_seed", BODY, CHANGED_BODY);
        const extraParent = firstNativeInput(extra);
        extraParent.files.push(structuredClone(required(extraParent.files[0], "Workflow parent file is missing")));
        expect(supportFor("project_cli").analyze(extra)).toMatchObject({ status: "failed", outputUnits: [] });

        const binary = nativeFixture("project_cli", "parent_rebase_seed", BODY, CHANGED_BODY);
        const binaryParent = firstNativeInput(binary);
        const binaryFile = required(binaryParent.files[0], "Workflow parent file is missing");
        binaryParent.files[0] = {
            ...binaryFile,
            contentKind: "binary",
            bytes: Uint8Array.of(1),
        } as never;
        expect(supportFor("project_cli").analyze(binary)).toMatchObject({ status: "failed", outputUnits: [] });

        const wrongPath = nativeFixture("project_cli", "parent_rebase_seed", BODY, CHANGED_BODY);
        const wrongPathParent = firstNativeInput(wrongPath);
        required(wrongPathParent.files[0], "Workflow parent file is missing").relativePath = "foreign/SKILL.md";
        expect(supportFor("project_cli").analyze(wrongPath)).toMatchObject({ status: "failed", outputUnits: [] });
    });

    it("preserves ordinary foreign Workflow Shell examples while still rejecting source prompt substitutions", async () => {
        const body =
            'Review the project.\n\n```bash\ngit -C "$TARGET_DIR" diff "$LAST_REPORT_COMMIT"\nprintf \'%s\\n\' "$PLAN_FILE" "$PHASE_TITLE"\n```\n';
        const fixture = canonicalMigrationFixture("project_cli");
        const canonical = workflowTypeData(fixture);
        if (canonical.implementation.kind !== "instructions") throw new Error("Workflow instructions missing");
        canonical.implementation.instructionDialectId = "antigravity-workflow-markdown-v1";
        canonical.invocation.commandNames = ["review"];
        fixture.deployment.assets[0]!.version.files = canonicalFiles(body);
        const analysis = await codexProvider.analyzeRender(fixture);
        expect(analysis.status).toBe("complete");
        expect(analysis.semanticOptions.every((option) => option.outcome === "degraded")).toBe(true);
        const materialized = await codexProvider.materializeRender(materializationInput(fixture, "project_cli"));
        expect(materialized).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ content: { text: nativeText(body) } }] }],
        });
        canonical.invocation.argumentNames = ["TARGET_DIR"];
        expect((await codexProvider.analyzeRender(fixture)).status).toBe("failed");
        canonical.invocation.argumentNames = [];
        canonical.implementation.instructionDialectId = CODEX_NATIVE_DIALECTS.workflow;
        expect((await codexProvider.analyzeRender(fixture)).status).toBe("failed");
    });

    it("blocks arguments, explicit execution policy, extra files and mixed scopes instead of erasing behavior", async () => {
        const cases = [
            (fixture: RenderAnalysisInput) => {
                workflowTypeData(fixture).invocation.argumentHint = "FILE";
                workflowTypeData(fixture).invocation.argumentNames = ["FILE"];
            },
            (fixture: RenderAnalysisInput) => {
                required(fixture.deployment.assets[0], "Workflow fixture asset is missing").version.files = [
                    textFile("WORKFLOW.md", `${BODY}Review $1 without declared argument metadata.\n`, "entry"),
                ];
            },
            (fixture: RenderAnalysisInput) => {
                const implementation = workflowTypeData(fixture).implementation;
                if (implementation.kind !== "instructions") throw new Error("Workflow fixture is not instructional");
                implementation.execution.model = {
                    mode: "selected",
                    dialectId: "codex-model-v1",
                    selector: "gpt-5",
                    relativeTier: 1,
                };
            },
            (fixture: RenderAnalysisInput) => {
                const implementation = workflowTypeData(fixture).implementation;
                if (implementation.kind !== "instructions") throw new Error("Workflow fixture is not instructional");
                implementation.toolPolicy.preapproved.push({ dialectId: "codex-tool-v1", selector: "shell" });
            },
            (fixture: RenderAnalysisInput) => {
                fixture.deployment.assets[0]?.version.files.push(textFile("RESOURCE.md", "not safely mapped\n", "resource"));
            },
        ];
        for (const mutate of cases) {
            const fixture = canonicalMigrationFixture("project_cli");
            mutate(fixture);
            expect(await codexProvider.analyzeRender(fixture)).toMatchObject({ status: "failed", outputUnits: [] });
        }

        const mixed = canonicalMigrationFixture("project_cli");
        const global = structuredClone(mixed.deployment.assets[0]);
        if (global === undefined) throw new Error("Workflow fixture asset is missing");
        global.scope = "global";
        global.projectId = "";
        mixed.deployment.assets.push(global);
        expect(await codexProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "codex_workflow_migration_scope_ambiguous" })],
        });
    });

    it("validates the new dialect against canonical content instead of accepting wrapper-only similarity", () => {
        const canonical = workflowCanonical();
        const files = canonicalFiles(BODY);
        const file = nativeFile("project_cli", BODY);
        const validInput = {
            canonical,
            canonicalFiles: files,
            representation: {
                schemaVersion: 1 as const,
                dialectId: CODEX_NATIVE_DIALECTS.workflowAsSkill,
                dialectContractFingerprint: HASH,
                canonicalContentFingerprint: HASH,
                representationFingerprint: HASH,
                files: [{ ...file, text: undefined }].map(({ text: _text, ...descriptor }) => descriptor),
            },
            nativeFiles: [{ relativePath: file.relativePath, bytes: new TextEncoder().encode(file.text) }],
        };
        expect(validateCodexWorkflowAsSkillDialect(validInput)).toBe(true);

        const changedContent = structuredClone(validInput);
        required(changedContent.nativeFiles[0], "Workflow native file is missing").bytes = new TextEncoder().encode(
            nativeText(CHANGED_BODY),
        );
        expect(validateCodexWorkflowAsSkillDialect(changedContent)).toBe(false);

        const wrongShape = structuredClone(validInput);
        wrongShape.representation.schemaVersion = 2 as never;
        expect(validateCodexWorkflowAsSkillDialect(wrongShape)).toBe(false);

        const invalidUtf8 = structuredClone(validInput);
        const invalidBytes = Uint8Array.of(0xff);
        required(invalidUtf8.nativeFiles[0], "Workflow native file is missing").bytes = invalidBytes;
        const invalidDescriptor = required(invalidUtf8.representation.files[0], "Workflow descriptor is missing");
        invalidDescriptor.contentHash = sha256Bytes(invalidBytes);
        invalidDescriptor.byteSize = invalidBytes.byteLength;
        expect(validateCodexWorkflowAsSkillDialect(invalidUtf8)).toBe(false);

        const fallbackCanonical = workflowCanonical();
        fallbackCanonical.typeData.description = "";
        const fallbackText = nativeText(BODY).replace(
            'description: "Reviewed Codex Workflow"',
            'description: "Migrated OAAM Workflow review"',
        );
        const fallbackBytes = new TextEncoder().encode(fallbackText);
        const fallback = structuredClone(validInput);
        fallback.canonical = fallbackCanonical;
        required(fallback.nativeFiles[0], "Workflow native file is missing").bytes = fallbackBytes;
        const fallbackDescriptor = required(fallback.representation.files[0], "Workflow descriptor is missing");
        fallbackDescriptor.contentHash = sha256Bytes(fallbackBytes);
        fallbackDescriptor.byteSize = fallbackBytes.byteLength;
        expect(validateCodexWorkflowAsSkillDialect(fallback)).toBe(true);
    });

    it("uses an explicit fallback description when a reviewed Workflow has none", async () => {
        const fixture = canonicalMigrationFixture("project_cli");
        workflowTypeData(fixture).description = "";
        expect(await codexProvider.materializeRender(materializationInput(fixture, "project_cli"))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            content: {
                                contentKind: "text",
                                text: expect.stringContaining('description: "Migrated OAAM Workflow review"'),
                            },
                        },
                    ],
                },
            ],
        });
    });
});

function required<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}

function firstNativeInput(input: RenderAnalysisInput) {
    const group = required(input.dialectInputs[0], "Workflow dialect group is missing");
    const native = required(group.inputs[0], "Workflow parent fixture is missing");
    if (native.inputKind !== "native_representation") throw new Error("Workflow parent fixture is missing");
    return native;
}

function canonicalMigrationFixture(variant: WorkflowVariant): RenderAnalysisInput {
    const fixture = baseFixture(variant, VERSION_ID, BODY);
    const legacy = nativeFile(variant, BODY, "prompts/review.md");
    fixture.dialectInputs = resolveProviderExactFileDialectInputs({
        provider: codexProvider,
        deployment: fixture.deployment,
        semantics: fixture.requiredSemantics,
        available: [
            {
                targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                inputs: [nativeDialectInput(legacy, "current_exact", CODEX_NATIVE_DIALECTS.workflow)],
            },
        ],
    });
    return fixture;
}

function nativeFixture(
    variant: WorkflowVariant,
    inputRole: "current_exact" | "parent_rebase_seed",
    nativeBody: string,
    canonicalBody: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : NEXT_VERSION_ID;
    const fixture = baseFixture(variant, versionId, canonicalBody);
    const input = nativeDialectInput(nativeFile(variant, nativeBody), inputRole, CODEX_NATIVE_DIALECTS.workflowAsSkill);
    fixture.dialectInputs = [
        {
            targetVersion: { assetId: ASSET_ID, versionId },
            consumerAgentRuntimeIds: [fixture.requiredSemantics[0]!.consumerAgentRuntimeId],
            inputs: [
                inputRole === "current_exact"
                    ? input
                    : {
                          ...input,
                          inputRole: "parent_rebase_seed",
                          sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                      },
            ],
        },
    ];
    return fixture;
}

function baseFixture(variant: WorkflowVariant, versionId: string, body: string): RenderAnalysisInput {
    const runtime = runtimeFor(variant);
    const support = supportFor(variant);
    const build = support.renderContractDeclaration.verifiedBuilds[0];
    if (build === undefined) throw new Error("Workflow migration build fixture is missing");
    const files = canonicalFiles(body);
    const asset = {
        scope: variant.startsWith("global") ? ("global" as const) : ("project" as const),
        projectId: variant.startsWith("global") ? "" : PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: workflowCanonical(),
            files,
        },
        sectionHandles: { [FILE_ID]: "workflow-entry" },
    };
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: build.platform,
            platformInstanceId: `test-${build.platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: runtime,
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" as const },
                        ...(variant.startsWith("global")
                            ? [
                                  {
                                      key: "oaam.target-kind",
                                      value: "directory",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]
                            : []),
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", runtime, versionId, "asset"),
            semantic("workflow.activation", runtime, versionId, "asset"),
            semantic("workflow.content", runtime, versionId, "file"),
        ] as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [],
    };
}

function materializationInput(fixture: RenderAnalysisInput, variant: WorkflowVariant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete") throw new Error("Workflow migration analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Workflow migration profile is missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CODEX",
                rendererAdapterVersion: codexProvider.version,
                materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: support.renderContractDeclaration.materializationProfileId,
                profileConstraintFingerprint: profile.profileConstraintFingerprint,
            })),
            semanticOptions: analysis.semanticOptions.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                ...(option.outcome === "degraded"
                    ? { outcome: "degraded" as const, degradationFingerprint: option.degradationFingerprint }
                    : { outcome: "preserved" as const }),
            })),
        },
    };
}

function changedInspection(
    fixture: RenderAnalysisInput,
    materialization: RenderMaterializationInput,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Workflow migration output unit is missing");
    const path = unit.claims[0]?.relativePath;
    if (path === undefined) throw new Error("Workflow migration target path is missing");
    const semanticRefFingerprints = fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint);
    return {
        schemaVersion: 1,
        deploymentId: "77777777-7777-4777-8777-777777777777",
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: HASH,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: HASH,
            compilationFingerprint: HASH,
            decisions: fixture.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: "CODEX",
                consumerOwnerAdapterVersion: codexProvider.version,
                optionFingerprint: HASH,
                renderStrategy: "native_graph" as const,
                actualReverseExtractPolicy: "can_reconcile" as const,
                outputUnitFingerprints: [unit.outputUnitFingerprint],
                outcome: "preserved" as const,
            })),
            outputUnits: [unit],
            outputUnitRenderers: materialization.selection.outputUnitRenderers,
            semanticCoverageProofs: [],
        },
        inspectionScope: {
            inspectionScopeFingerprint: HASH,
            fileStates: [
                {
                    relativePath: path,
                    state: "changed",
                    appliedContentHash: sha256Text(appliedText),
                    currentContentHash: sha256Text(currentText),
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    provenanceFingerprint: HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: path,
                appliedContent: { contentKind: "text", text: appliedText },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: sha256Text(path),
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(appliedText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints,
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function supportFor(variant: WorkflowVariant) {
    const runtime = runtimeFor(variant);
    return variant.startsWith("global") ? supports[runtime].global : supports[runtime].project;
}

function runtimeFor(variant: WorkflowVariant): CodexRuntime {
    return variant.endsWith("app") ? "CODEX_APP" : "CODEX_CLI";
}

function targetPath(variant: WorkflowVariant) {
    return variant.startsWith("global") ? "oaam-workflow-11111111/SKILL.md" : ".agents/skills/oaam-workflow-11111111/SKILL.md";
}

function nativeText(body: string): string {
    return ["---", 'name: "review"', 'description: "Reviewed Codex Workflow"', "---", body].join("\n");
}

function nativeFile(variant: WorkflowVariant, body: string, path = targetPath(variant)) {
    const text = nativeText(body);
    return {
        relativePath: path as never,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function nativeDialectInput(
    file: ReturnType<typeof nativeFile>,
    inputRole: "current_exact" | "parent_rebase_seed",
    dialectId: string,
) {
    const { text: _text, ...descriptor } = file;
    return {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [descriptor],
        },
        files: [file],
    };
}

function workflowCanonical(): Extract<AssetKindTypeDataV2, { kind: "Workflow" }> {
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "Reviewed Codex Workflow",
            implementation: {
                kind: "instructions",
                instructionDialectId: CODEX_NATIVE_DIALECTS.workflow,
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "inherit" },
                    effort: { mode: "inherit" },
                    shell: { mode: "none" },
                },
                toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            },
            invocation: {
                commandNames: ["prompts:review"],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}

function canonicalFiles(body: string): AssetVersionFileContentV2[] {
    return [textFile("WORKFLOW.md", body, "entry")];
}

function textFile(logicalPath: string, text: string, role: "entry" | "resource"): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId: role === "entry" ? FILE_ID : "99999999-9999-4999-8999-999999999999",
            logicalPath,
            role,
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: inferCanonicalMediaType(logicalPath, "text"),
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function workflowTypeData(fixture: RenderAnalysisInput) {
    const canonical = fixture.deployment.assets[0]?.version.canonical;
    if (canonical?.kind !== "Workflow") throw new Error("Workflow fixture canonical data is missing");
    return canonical.typeData;
}

function semantic(semanticKind: string, consumerAgentRuntimeId: CodexRuntime, versionId: string, subjectKind: "asset" | "file") {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${subjectKind}`),
        consumerAgentRuntimeId,
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: FILE_ID },
        semanticKind,
    };
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
