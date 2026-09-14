import * as crypto from "node:crypto";
import type {
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    Sha256Digest,
} from "@oaam/core";
import { resolveTargetBuildCompatibility } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { zcodeProvider } from "../src/zcode-provider";
import {
    ZCODE_COLOR_DIALECT,
    ZCODE_MODEL_DIALECT,
    ZCODE_PERMISSION_DIALECT,
    ZCODE_SUBAGENT_TOOL_DIALECT,
    ZCODE_TURN_LIMIT_DIALECT,
} from "../src/zcode-source-read-fields";
import { ZCODE_NATIVE_DIALECTS } from "../src/zcode-source-read-model";
import { validateZcodeNativeDialect } from "../src/zcode-source-read-native";
import {
    createZcodeSubagentTargetSupports,
    ZCODE_SUBAGENT_TARGET_COMPONENTS,
    type ZcodeSubagentTargetSupports,
} from "../src/zcode-target-subagent";

type Variant = keyof ZcodeSubagentTargetSupports;

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const BUILD_IDENTITY = "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const ORIGINAL_BODY = "Return OAAM_ZCODE_SUBAGENT_CURRENT_5C91D2.";
const FOREIGN_BODY = "Return OAAM_ZCODE_SUBAGENT_REBASE_8E47A1.";
const REVERSE_BODY = "Return OAAM_ZCODE_SUBAGENT_REVERSE_3D72F6.";

const supports = createZcodeSubagentTargetSupports({
    adapterVersion: zcodeProvider.version,
    agentRuntimes: zcodeProvider.agentRuntimes,
    projectTargetContextSchemaId: "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
    globalTargetContextSchemaId: "ZCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
});

describe("ZCode App exact Subagent targets", () => {
    it("registers project/global current-build contracts and native rebase authority", () => {
        expect(zcodeProvider.version).toBe("0.10.0");
        expect(zcodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Subagent")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                entrySupportStatus: "supported",
            }),
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                entrySupportStatus: "supported",
            }),
        ]);
        for (const support of Object.values(supports)) {
            const declaration = support.renderContractDeclaration;
            expect(declaration).toMatchObject({
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Subagent",
                nativeDialectId: ZCODE_NATIVE_DIALECTS.subagent,
                verifiedBuilds: [
                    expect.objectContaining({ platform: "wsl", versionText: "3.5.3", buildIdentity: BUILD_IDENTITY }),
                    expect.objectContaining({ platform: "win32", versionText: "3.5.3", buildIdentity: BUILD_IDENTITY }),
                    expect.objectContaining({
                        platform: "wsl",
                        versionText: "3.2.1",
                        buildIdentity: "sha256:9257ab957da7cf195af859c256447b7724b768dce36d172aeee069c03e575459",
                    }),
                ],
                buildCompatibility: {
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [
                        expect.objectContaining({
                            versionText: "3.1.8",
                            reasonCode: "zcode_subagent_root_absent_3_1_8",
                        }),
                    ],
                },
            });
            expect(
                resolveTargetBuildCompatibility({
                    anchors: declaration.verifiedBuilds,
                    policy: declaration.buildCompatibility,
                    current: {
                        agentRuntimeId: "ZCODE_APP",
                        versionText: "3.1.8",
                        buildIdentity: "sha256:aaab9c07d95e1d6f2d2961db21195c4b48cfaaa159a78b15c0b04f91f8fe0d73",
                        platform: "wsl",
                    },
                }),
            ).toEqual({
                status: "blocked",
                reason: "denied_build",
                denyReasonCode: "zcode_subagent_root_absent_3_1_8",
            });
        }
        expect(
            zcodeProvider.dialectContracts.native.find((row) => row.definition.dialectId === ZCODE_NATIVE_DIALECTS.subagent),
        ).toMatchObject({ definition: { rebaseMaterializer: ZCODE_SUBAGENT_TARGET_COMPONENTS.rebase } });
    });

    it.each(["project", "global"] as const)("restores exact %s bytes and rebases supported behavior", async (variant) => {
        const current = fixture(variant, "current_exact", currentCanonical(variant), ORIGINAL_BODY, nativeText(variant, false));
        expect(await zcodeProvider.analyzeRender(current)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(await zcodeProvider.materializeRender(materializationInput(current, variant))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                { files: [{ relativePath: nativePath(variant), content: { text: nativeText(variant, false) } }] },
            ],
        });

        const foreign = fixture(
            variant,
            "parent_rebase_seed",
            foreignCanonical(variant),
            FOREIGN_BODY,
            nativeText(variant, false),
        );
        expect(await zcodeProvider.analyzeRender(foreign)).toMatchObject({ status: "complete", diagnostics: [] });
        const expected = nativeText(variant, true);
        expect(await zcodeProvider.materializeRender(materializationInput(foreign, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: nativePath(variant), content: { text: expected } }] }],
        });
        expect(expected).toContain("# preserve ZCode Subagent layout");
        expect(expected.includes("permissionMode: plan")).toBe(variant === "project");
        expect(validateNative(variant, foreignCanonical(variant), FOREIGN_BODY, expected)).toBe(true);
    });

    it.each([
        "project",
        "global",
    ] as const)("composes the 3.2.1 exact consumer floor with %s target and reverse", async (variant) => {
        const applied = nativeText(variant, false);
        const input = fixture(variant, "current_exact", currentCanonical(variant), ORIGINAL_BODY, applied);
        bindExactBuild(input, variant, "3.2.1");
        expect(await zcodeProvider.analyzeRender(input)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = materializationInput(input, variant);
        await expect(zcodeProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        await expect(
            zcodeProvider.inspectRenderedTarget(
                inspectionInput(materialization, variant, applied, applied.replace(ORIGINAL_BODY, REVERSE_BODY)),
            ),
        ).resolves.toMatchObject({
            status: "complete",
            changes: [{ replacementContent: { text: instruction(REVERSE_BODY.trim()) } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });

    it.each(["project", "global"] as const)("materializes reviewed portable canonical %s behavior", (variant) => {
        const input = canonicalFixture(variant, currentCanonical(variant));
        const analysis = supportFor(variant).analyze(input);
        expect(analysis).toMatchObject({
            status: "complete",
            semanticOptions: expect.arrayContaining([expect.objectContaining({ outcome: "degraded" })]),
        });
        const request = materializationInput(input, variant);
        const materialized = supportFor(variant).materialize(request);
        assertCanonicalEntryControls(zcodeProvider, request, materialized);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: expect.stringMatching(
                                variant === "project" ? /^\.zcode\/agents\/oaam-subagent-/u : /^agents\/oaam-subagent-/u,
                            ),
                            content: { text: expect.stringContaining("OAAM_ZCODE_SUBAGENT_CURRENT_5C91D2") },
                        },
                    ],
                },
            ],
        });
        if (materialized.status !== "complete") throw new Error("canonical Subagent did not materialize");
        const file = materialized.materializedUnits[0]?.files[0];
        if (file?.content.contentKind !== "text") throw new Error("canonical Subagent did not produce text");
        expect(
            validateNativeAtPath(variant, currentCanonical(variant), ORIGINAL_BODY, file.relativePath, file.content.text),
        ).toBe(true);
    });

    it("blocks a project permission policy that the exact loader ignores but accepts it globally", () => {
        const selected = currentCanonical("global");
        expect(supports.project.analyze(canonicalFixture("project", selected)).status).toBe("failed");
        expect(supports.global.analyze(canonicalFixture("global", selected)).status).toBe("complete");
    });

    it.each(["project", "global"] as const)("attributes only body changes during %s reverse", async (variant) => {
        const input = fixture(variant, "current_exact", currentCanonical(variant), ORIGINAL_BODY, nativeText(variant, false));
        const materialization = materializationInput(input, variant);
        const applied = nativeText(variant, false);
        const current = applied.replace(ORIGINAL_BODY, REVERSE_BODY);
        expect(
            await zcodeProvider.inspectRenderedTarget(inspectionInput(materialization, variant, applied, current)),
        ).toMatchObject({
            status: "complete",
            changes: [{ replacementContent: { contentKind: "text", text: instruction(REVERSE_BODY.trim()) } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            await supportFor(variant).inspect(
                inspectionInput(materialization, variant, applied, current.replace("color: blue", "color: green")),
            ),
        ).toMatchObject({ status: "complete", changes: [], files: [{ attributionState: "conflict" }] });
    });

    it("composes project and global targets without borrowing scope evidence", async () => {
        const project = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        const global = fixture("global", "current_exact", currentCanonical("global"), ORIGINAL_BODY, nativeText("global", false));
        const combined = combine(project, global);
        expect(await zcodeProvider.analyzeRender(combined)).toMatchObject({
            status: "complete",
            outputUnits: [expect.any(Object), expect.any(Object)],
            blockedSemanticRefs: [],
        });
        combined.deployment.targetContexts = combined.deployment.targetContexts.filter(
            (context) => context.targetContextSchemaId !== supports.global.targetContextSchema.targetContextSchemaId,
        );
        expect(await zcodeProvider.analyzeRender(combined)).toMatchObject({
            status: "partial",
            outputUnits: [expect.any(Object)],
            blockedSemanticRefs: expect.any(Array),
        });
    });

    it("fails closed for wrong dialects, extra files, unsafe paths, restoration input and binary reverse", async () => {
        const wrong = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        firstNative(wrong).representation.dialectId = ZCODE_NATIVE_DIALECTS.commandWorkflow;
        expect(supports.project.analyze(wrong).status).toBe("failed");

        const extra = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        const file = required(firstNative(extra).files[0]);
        firstNative(extra).files.push({ ...file, relativePath: ".zcode/agents/extra.md" });
        expect(supports.project.analyze(extra).status).toBe("failed");

        for (const path of ["../agent.md", ".zcode\\agents\\agent.md", ".agents/agents/not-loaded.md"]) {
            const unsafe = fixture(
                "project",
                "current_exact",
                currentCanonical("project"),
                ORIGINAL_BODY,
                nativeText("project", false),
            );
            required(firstNative(unsafe).files[0]).relativePath = path;
            expect(supports.project.analyze(unsafe).status).toBe("failed");
        }

        const restoration = fixture(
            "global",
            "current_exact",
            currentCanonical("global"),
            ORIGINAL_BODY,
            nativeText("global", false),
        );
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: { dialectId: "foreign", restorationContractFingerprint: HASH, contentHash: HASH },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.global.analyze(restoration).status).toBe("failed");

        const reverse = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        const inspection = inspectionInput(
            materializationInput(reverse, "project"),
            "project",
            nativeText("project", false),
            nativeText("project", false),
        );
        required(inspection.files[0]).currentContent = { contentKind: "binary", bytes: Uint8Array.of(0xff) };
        expect(await zcodeProvider.inspectRenderedTarget(inspection)).toMatchObject({
            status: "complete",
            files: [{ attributionState: "conflict" }],
            changes: [],
        });
    });

    it("warns for a newer comparable App while keeping exact current builds distinct", async () => {
        const input = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        const context = required(input.deployment.targetContexts[0]);
        context.versionText = "3.5.4";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await zcodeProvider.analyzeRender(input)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "zcode_target_build_compatibility_inferred" })],
        });
    });

    it("fails an unclassified scope, a missing target authority, and non-Markdown or executable graphs", async () => {
        const unclassified = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        (required(unclassified.deployment.assets[0]) as { scope: string }).scope = "future";
        expect(await zcodeProvider.analyzeRender(unclassified)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "zcode_subagent_scope_unavailable" })],
        });

        const missingAuthority = fixture(
            "project",
            "current_exact",
            currentCanonical("project"),
            ORIGINAL_BODY,
            nativeText("project", false),
        );
        missingAuthority.deployment.targetContexts = [];
        expect(await zcodeProvider.analyzeRender(missingAuthority)).toMatchObject({ status: "failed" });

        for (const mutate of [
            (file: ReturnType<typeof firstNative>["files"][number]) => {
                file.relativePath = ".zcode/agents/not-markdown.txt";
            },
            (file: ReturnType<typeof firstNative>["files"][number]) => {
                file.executable = true;
            },
        ]) {
            const invalid = fixture(
                "project",
                "current_exact",
                currentCanonical("project"),
                ORIGINAL_BODY,
                nativeText("project", false),
            );
            mutate(required(firstNative(invalid).files[0]));
            expect(supports.project.analyze(invalid).status).toBe("failed");
        }
    });
});

function supportFor(variant: Variant) {
    return supports[variant];
}

function fixture(
    variant: Variant,
    inputRole: "current_exact" | "parent_rebase_seed",
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    native: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: ZCODE_NATIVE_DIALECTS.subagent,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [nativeFile(variant, native)],
    };
    return baseFixture(variant, versionId, canonical, body, [
        inputRole === "current_exact"
            ? common
            : {
                  ...common,
                  inputRole: "parent_rebase_seed" as const,
                  sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
              },
    ]);
}

function canonicalFixture(variant: Variant, canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>): RenderAnalysisInput {
    const declaration = supportFor(variant).renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Subagent canonical materializer missing");
    return baseFixture(variant, VERSION_ID, canonical, ORIGINAL_BODY, [
        {
            inputKind: "canonical_materialization",
            nativeDialectId: ZCODE_NATIVE_DIALECTS.subagent,
            materializer: declaration.materializer,
            degradationKinds: [...declaration.degradationKinds],
            reasonCode: declaration.reasonCode,
        },
    ]);
}

function baseFixture(
    variant: Variant,
    versionId: string,
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    inputs: RenderAnalysisInput["dialectInputs"][number]["inputs"],
): RenderAnalysisInput {
    const support = supportFor(variant);
    const scope = variant === "project" ? ("project" as const) : ("global" as const);
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "ZCODE_APP",
                    versionText: "3.5.3",
                    buildIdentity: BUILD_IDENTITY,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        ...(variant === "project"
                            ? [
                                  {
                                      key: "oaam.project-binding",
                                      value: "registered",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]
                            : [
                                  {
                                      key: "oaam.target-kind",
                                      value: "global",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]),
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope,
                    projectId: scope === "project" ? PROJECT_ID : "",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: structuredClone(canonical),
                        files: [textFile(body)],
                    },
                    sectionHandles: { [FILE_ID]: "subagent-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", "asset", versionId),
            semantic("subagent.delegation_metadata", "asset", versionId),
            semantic("subagent.tool_boundary", "asset", versionId),
            semantic("subagent.model_hint", "asset", versionId),
            semantic("subagent.invoked_context", "file", versionId),
        ],
        dialectInputs: [{ targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: ["ZCODE_APP"], inputs }],
    };
}

function bindExactBuild(input: RenderAnalysisInput, variant: Variant, versionText: string): void {
    const build = supportFor(variant).renderContractDeclaration.verifiedBuilds.find(
        (candidate) => candidate.platform === "wsl" && candidate.versionText === versionText,
    );
    const context = input.deployment.targetContexts[0];
    if (build === undefined || context === undefined) throw new Error(`Subagent ${versionText} verified build is missing`);
    context.versionText = build.versionText;
    context.buildIdentity = build.buildIdentity;
}

function materializationInput(input: RenderAnalysisInput, variant: Variant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(input);
    if (analysis.status !== "complete") throw new Error("Subagent analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = required(contract.materializationProfiles[0]);
    return {
        schemaVersion: 1,
        deployment: structuredClone(input.deployment),
        requiredSemantics: structuredClone(input.requiredSemantics),
        dialectInputs: structuredClone(input.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "ZCODE",
                rendererAdapterVersion: zcodeProvider.version,
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

function inspectionInput(
    materialization: RenderMaterializationInput,
    variant: Variant,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = required(materialization.selection.outputUnits[0]);
    const path = nativePath(variant);
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
            decisions: materialization.requiredSemantics.map((semanticRef) => ({
                semanticRef,
                consumerOwnerAdapterId: "ZCODE",
                consumerOwnerAdapterVersion: zcodeProvider.version,
                optionFingerprint: HASH,
                renderStrategy: "native_graph",
                actualReverseExtractPolicy: "can_reconcile",
                outputUnitFingerprints: [unit.outputUnitFingerprint],
                outcome: "preserved",
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
                        hunkFingerprint: HASH,
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
                    semanticRefFingerprints: materialization.requiredSemantics.map((item) => item.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function currentCanonical(variant: Variant): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return canonical(variant, false);
}

function foreignCanonical(variant: Variant): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return canonical(variant, true);
}

function canonical(variant: Variant, foreign: boolean): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: foreign ? "oaam-auditor" : "oaam-reviewer",
            description: foreign ? "Audit the isolated project" : "Review the isolated project",
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base: foreign
                        ? { mode: "allowlist", allowed: [runtimeTool("Bash")] }
                        : { mode: "allowlist", allowed: [runtimeTool("Read"), runtimeTool("Grep")] },
                    unavailable: foreign ? [] : [runtimeTool("Write")],
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission:
                    variant === "global"
                        ? {
                              mode: "selected",
                              dialectId: ZCODE_PERMISSION_DIALECT,
                              selector: foreign ? "dontAsk" : "plan",
                              effect: foreign ? "auto_deny_unapproved" : "read_only",
                          }
                        : { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: foreign ? { mode: "always_background" } : { mode: "always_foreground" },
                turnLimit: {
                    mode: "bounded",
                    dialectId: ZCODE_TURN_LIMIT_DIALECT,
                    limit: foreign ? 3 : 7,
                },
                model: {
                    mode: "selected",
                    dialectId: ZCODE_MODEL_DIALECT,
                    selector: foreign ? "glm-4.5" : "glm-5",
                    relativeTier: -1,
                },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: {
                listing: "visible",
                color: {
                    mode: "selected",
                    dialectId: ZCODE_COLOR_DIALECT,
                    selector: foreign ? "purple" : "blue",
                },
            },
        },
    };
}

function nativeText(variant: Variant, foreign: boolean): string {
    return [
        "---",
        "# preserve ZCode Subagent layout",
        `name: ${JSON.stringify(foreign ? "oaam-auditor" : "oaam-reviewer")}`,
        `description: ${JSON.stringify(foreign ? "Audit the isolated project" : "Review the isolated project")}`,
        `tools: ${JSON.stringify(foreign ? ["Bash"] : ["Read", "Grep"])}`,
        `disallowedTools: ${JSON.stringify(foreign ? [] : ["Write"])}`,
        `model: ${JSON.stringify(foreign ? "glm-4.5" : "glm-5")}`,
        `permissionMode: ${variant === "project" ? "plan" : foreign ? '"dontAsk"' : "plan"}`,
        `maxTurns: ${foreign ? "3" : "7"}`,
        `background: ${foreign ? "true" : "false"}`,
        `color: ${foreign ? '"purple"' : "blue"}`,
        "---",
        foreign ? FOREIGN_BODY : ORIGINAL_BODY,
    ].join("\n");
}

function validateNative(
    variant: Variant,
    canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    text: string,
): boolean {
    return validateNativeAtPath(variant, canonicalValue, body, nativePath(variant), text);
}

function validateNativeAtPath(
    _variant: Variant,
    canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    path: string,
    text: string,
): boolean {
    const descriptor = nativeFileAt(path, text);
    const { text: _text, ...file } = descriptor;
    return validateZcodeNativeDialect({
        canonical: canonicalValue,
        canonicalFiles: [textFile(body)],
        representation: {
            schemaVersion: 1,
            dialectId: ZCODE_NATIVE_DIALECTS.subagent,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: path, bytes: new TextEncoder().encode(text) }],
    });
}

function textFile(body: string) {
    const text = instruction(body);
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: FILE_ID,
            logicalPath: "instructions.json",
            role: "entry" as const,
            contentHash: sha256Text(text),
            contentKind: "text" as const,
            mediaType: "application/json",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function nativeFile(variant: Variant, text: string) {
    return nativeFileAt(nativePath(variant), text);
}

function nativeFileAt(path: string, text: string) {
    return {
        relativePath: path,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function nativePath(variant: Variant): string {
    return variant === "project" ? ".zcode/agents/oaam-phase56-subagent.md" : "agents/oaam-phase56-global-subagent.md";
}

function instruction(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function runtimeTool(selector: string) {
    return { mode: "agent_runtime_tool" as const, selector: { dialectId: ZCODE_SUBAGENT_TOOL_DIALECT, selector } };
}

function semantic(
    semanticKind: string,
    subjectKind: "asset" | "file",
    versionId: string,
): RenderAnalysisInput["requiredSemantics"][number] {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${versionId}`),
        consumerAgentRuntimeId: "ZCODE_APP",
        subject:
            subjectKind === "file"
                ? { subjectKind: "file", assetId: ASSET_ID, versionId, fileId: FILE_ID }
                : { subjectKind: "asset", assetId: ASSET_ID, versionId },
        semanticKind,
    } as RenderAnalysisInput["requiredSemantics"][number];
}

function firstNative(input: RenderAnalysisInput) {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Subagent native fixture missing");
    return native;
}

function combine(left: RenderAnalysisInput, right: RenderAnalysisInput): RenderAnalysisInput {
    const adjusted = structuredClone(right);
    const asset = required(adjusted.deployment.assets[0]);
    asset.version.ref.assetId = "99999999-9999-4999-8999-999999999999";
    asset.version.ref.versionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dialect = required(adjusted.dialectInputs[0]);
    dialect.targetVersion = structuredClone(asset.version.ref);
    for (const semanticRef of adjusted.requiredSemantics) {
        semanticRef.subject.assetId = asset.version.ref.assetId;
        semanticRef.subject.versionId = asset.version.ref.versionId;
        semanticRef.semanticRefFingerprint = sha256Text(`${semanticRef.semanticKind}:${asset.version.ref.versionId}`);
    }
    return {
        schemaVersion: 1,
        deployment: {
            ...structuredClone(left.deployment),
            targetContexts: [...structuredClone(left.deployment.targetContexts), ...adjusted.deployment.targetContexts],
            assets: [...structuredClone(left.deployment.assets), ...adjusted.deployment.assets],
        },
        requiredSemantics: [...structuredClone(left.requiredSemantics), ...adjusted.requiredSemantics],
        dialectInputs: [...structuredClone(left.dialectInputs), ...adjusted.dialectInputs],
    };
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("required fixture value missing");
    return value;
}

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}
