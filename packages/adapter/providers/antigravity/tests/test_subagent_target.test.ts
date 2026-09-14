import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import * as crypto from "node:crypto";
import {
    type AssetKindTypeDataV2,
    type RenderAnalysisInput,
    type RenderedTargetInspectionInput,
    type RenderMaterializationInput,
    resolveTargetBuildCompatibility,
    type Sha256Digest,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { antigravityProvider } from "../src/antigravity-provider";
import { ANTIGRAVITY_NATIVE_DIALECTS } from "../src/antigravity-source-read-model";
import { validateAntigravityNativeDialect } from "../src/antigravity-source-read-native";
import {
    ANTIGRAVITY_SUBAGENT_MODEL_DIALECT,
    ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT,
    ANTIGRAVITY_SUBAGENT_TOOL_DIALECT,
} from "../src/antigravity-subagent-markdown";
import {
    ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS,
    createAntigravityAppSubagentTargetSupports,
    createAntigravitySubagentTargetSupports,
} from "../src/antigravity-target-subagent";

type Variant = "project" | "global";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const BUILD_HASH = "sha256:4217db798fd514cedce4e315013daea471a1a67666ab91547b2ad0dbee167a71";
const WINDOWS_APP_BUILD_HASH = "sha256:4dbd1be0a6ebe48ebd370babf9b7d046630b8eac7bb69fbb0469db1aea12bcf8" as Sha256Digest;
const WINDOWS_APP_2_2_1_BUILD_HASH = "sha256:a106300d49a1f63b162d73d37ec3eec7ce06df0c6aa5d93e483fecb80785dd8e" as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const ORIGINAL_BODY = "Return OAAM_AGY_SUBAGENT_CURRENT_84D2A1.\n";
const FOREIGN_BODY = "Return OAAM_AGY_SUBAGENT_REBASE_52F7C0.\n";
const REVERSE_BODY = "Return OAAM_AGY_SUBAGENT_REVERSE_73C1E9.\n";

const projectSchema = antigravityProvider.targetContextSchemas.find(
    (row) => row.targetContextSchemaId === "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1",
);
if (projectSchema === undefined) throw new Error("Antigravity project target schema missing");
const supports = createAntigravitySubagentTargetSupports({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    projectTargetContextSchemaId: projectSchema.targetContextSchemaId,
    globalTargetContextSchemaId: "ANTIGRAVITY_CLI_GLOBAL_SKILL_TARGET_V1",
});
const appSupports = createAntigravityAppSubagentTargetSupports({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    projectTargetContextSchemaId: "ANTIGRAVITY_APP_PROJECT_TARGET_V1",
    globalTargetContextSchemaId: "ANTIGRAVITY_APP_GLOBAL_TARGET_V1",
});

describe("Antigravity CLI Markdown Subagent targets", () => {
    it("registers independent project/global exact current-build contracts", () => {
        expect(antigravityProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Subagent")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                outputContractId: "ANTIGRAVITY_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                outputContractId: "ANTIGRAVITY_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                renderStrategy: "native_graph",
                reverseExtractPolicy: "can_reconcile",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                outputContractId: "ANTIGRAVITY_APP_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1",
                entrySupportStatus: "supported",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                outputContractId: "ANTIGRAVITY_APP_NATIVE_GLOBAL_SUBAGENT_MARKDOWN_V1",
                entrySupportStatus: "supported",
            }),
            expect.objectContaining({ agentRuntimeId: "ANTIGRAVITY_IDE", entrySupportStatus: "unsupported" }),
        ]);
        for (const support of Object.values(supports)) {
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                assetKind: "Subagent",
                nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
                buildCompatibility: {
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [],
                },
                verifiedBuilds: [expect.objectContaining({ versionText: "1.1.10", buildIdentity: BUILD_HASH, platform: "wsl" })],
            });
        }
        expect(supports.global.targetContextSchema.targetContextSchemaId).toBe("ANTIGRAVITY_CLI_GLOBAL_SKILL_TARGET_V1");
        expect(
            antigravityProvider.targetContextSchemas.filter(
                (row) => row.targetContextSchemaId === "ANTIGRAVITY_CLI_GLOBAL_SKILL_TARGET_V1",
            ),
        ).toHaveLength(1);
        expect(
            antigravityProvider.dialectContracts.native.find(
                (row) => row.definition.dialectId === ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
            ),
        ).toMatchObject({ definition: { rebaseMaterializer: ANTIGRAVITY_SUBAGENT_TARGET_COMPONENTS.rebase } });
    });

    it("uses the Windows 2.2.1 target anchor while surfacing the exact 2.4.3 loader regression", async () => {
        for (const support of Object.values(appSupports)) {
            const declaration = support.renderContractDeclaration;
            expect(declaration.verifiedBuilds).toEqual([
                expect.objectContaining({
                    versionText: "2.2.1",
                    buildIdentity: "sha256:b0d127772d2983a93771055a93b673d5fdd1726d6e47db8e269b204e665972d6",
                    platform: "wsl",
                }),
                expect.objectContaining({
                    versionText: "2.2.1",
                    buildIdentity: WINDOWS_APP_2_2_1_BUILD_HASH,
                    platform: "win32",
                }),
            ]);
            expect(
                resolveTargetBuildCompatibility({
                    anchors: declaration.verifiedBuilds,
                    policy: declaration.buildCompatibility,
                    current: {
                        agentRuntimeId: "ANTIGRAVITY_APP",
                        versionText: "2.2.1",
                        buildIdentity: WINDOWS_APP_2_2_1_BUILD_HASH,
                        platform: "win32",
                    },
                }),
            ).toMatchObject({ status: "exact", anchor: { platform: "win32" } });
            expect(
                resolveTargetBuildCompatibility({
                    anchors: declaration.verifiedBuilds,
                    policy: declaration.buildCompatibility,
                    current: {
                        agentRuntimeId: "ANTIGRAVITY_APP",
                        versionText: "2.4.3",
                        buildIdentity: WINDOWS_APP_BUILD_HASH,
                        platform: "win32",
                    },
                }),
            ).toMatchObject({
                status: "compatible",
                anchor: { versionText: "2.2.1", platform: "win32" },
            });
        }

        const input = appCanonicalFixture("project");
        const context = input.deployment.targetContexts[0];
        if (context === undefined) throw new Error("App Subagent target context is missing");
        input.deployment.platform = "win32";
        input.deployment.platformInstanceId = "test-win32";
        context.versionText = "2.4.3";
        context.buildIdentity = WINDOWS_APP_BUILD_HASH;
        context.renderFacts = [
            { key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" },
        ];
        expect((await antigravityProvider.analyzeRender(input)).diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "antigravity_target_build_compatibility_inferred" }),
                expect.objectContaining({ code: "antigravity_app_2_4_3_win32_subagent_loader_regression" }),
            ]),
        );
    });

    it.each(["project", "global"] as const)("materializes new App %s Subagents as folder agent.md graphs", (variant) => {
        const support = appSupportFor(variant);
        const input = appCanonicalFixture(variant);
        expect(support.analyze(input)).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
        expect(support.materialize(materializationInput(input, variant, support))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: expect.stringMatching(
                                variant === "project"
                                    ? /^\.agents\/agents\/oaam-agent-[^/]+\/agent\.md$/u
                                    : /^config\/agents\/oaam-agent-[^/]+\/agent\.md$/u,
                            ),
                        },
                    ],
                },
            ],
        });
    });

    it.each(["project", "global"] as const)("restores exact %s bytes and rebases portable behavior", async (variant) => {
        const current = fixture(variant, "current_exact", originalCanonical(), ORIGINAL_BODY, nativeText(variant, "current"));
        expect(await antigravityProvider.analyzeRender(current)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const currentMaterialization = materializationInput(current, variant);
        expect(await antigravityProvider.materializeRender(currentMaterialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                { files: [{ relativePath: nativePath(variant), content: { text: nativeText(variant, "current") } }] },
            ],
        });

        const foreign = fixture(variant, "parent_rebase_seed", foreignCanonical(), FOREIGN_BODY, nativeText(variant, "current"));
        expect(await antigravityProvider.analyzeRender(foreign)).toMatchObject({ status: "complete", diagnostics: [] });
        const foreignMaterialization = materializationInput(foreign, variant);
        const materialized = await antigravityProvider.materializeRender(foreignMaterialization);
        expect(materialized).toMatchObject({
            status: "complete",
            materializedUnits: [
                { files: [{ relativePath: nativePath(variant), content: { text: nativeText(variant, "foreign") } }] },
            ],
        });
        expect(nativeText(variant, "foreign")).toContain("# preserve Antigravity custom-agent layout");
        expect(validateNative(variant, foreignCanonical(), FOREIGN_BODY, nativeText(variant, "foreign"))).toBe(true);
    });

    it.each(["project", "global"] as const)("attributes only body changes during %s reverse", async (variant) => {
        const input = fixture(variant, "parent_rebase_seed", foreignCanonical(), FOREIGN_BODY, nativeText(variant, "current"));
        const materialization = materializationInput(input, variant);
        const applied = nativeText(variant, "foreign");
        const current = applied.replace(FOREIGN_BODY, REVERSE_BODY);
        expect(
            await antigravityProvider.inspectRenderedTarget(inspectionInput(materialization, variant, applied, current)),
        ).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: instruction(REVERSE_BODY) } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            await supportFor(variant).inspect(
                inspectionInput(materialization, variant, applied, current.replace("hidden: true", "hidden: false")),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [],
            files: [
                {
                    attributionState: "conflict",
                    reasonCode:
                        variant === "project"
                            ? "native_project_exact_graph_content_not_reconcilable"
                            : "native_global_exact_graph_content_not_reconcilable",
                },
            ],
        });
    });

    it.each([
        "project",
        "global",
    ] as const)("materializes a reviewed portable canonical %s declaration with disclosed degradation", (variant) => {
        const input = canonicalFixture(variant);
        const analysis = supportFor(variant).analyze(input);
        expect(analysis).toMatchObject({
            status: "complete",
            semanticOptions: expect.arrayContaining([expect.objectContaining({ outcome: "degraded" })]),
        });
        const request = materializationInput(input, variant);
        const materialized = supportFor(variant).materialize(request);
        assertCanonicalEntryControls(antigravityProvider, request, materialized);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: expect.stringMatching(
                                variant === "project" ? /^\.agents\/agents\/oaam-agent-/u : /^config\/agents\/oaam-agent-/u,
                            ),
                            content: { text: expect.stringContaining("Return OAAM_AGY_SUBAGENT_CURRENT_84D2A1") },
                        },
                    ],
                },
            ],
        });
        if (materialized.status !== "complete") throw new Error("Reviewed canonical Subagent did not materialize");
        const content = materialized.materializedUnits[0]?.files[0]?.content;
        const canonical = input.deployment.assets[0]?.version.canonical;
        if (content?.contentKind !== "text") throw new Error("Reviewed canonical Subagent did not produce text");
        if (canonical === undefined) throw new Error("Reviewed canonical Subagent fixture asset is missing");
        expect(validateNative(variant, canonical, ORIGINAL_BODY, content.text)).toBe(true);
    });

    it("fails closed for mixed scopes, wrong dialects, extra files, unsafe paths, and unrepresentable canonical fields", async () => {
        const mixed = fixture("project", "current_exact", originalCanonical(), ORIGINAL_BODY, nativeText("project", "current"));
        const projectAsset = mixed.deployment.assets[0];
        if (projectAsset === undefined) throw new Error("Subagent fixture asset missing");
        mixed.deployment.assets.push({ ...structuredClone(projectAsset), scope: "global", projectId: "" });
        expect(await antigravityProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "antigravity_subagent_target_shape_ambiguous" })],
        });

        const wrongDialect = fixture(
            "project",
            "current_exact",
            originalCanonical(),
            ORIGINAL_BODY,
            nativeText("project", "current"),
        );
        firstNative(wrongDialect).representation.dialectId = ANTIGRAVITY_NATIVE_DIALECTS.subagent;
        expect(supports.project.analyze(wrongDialect).status).toBe("failed");

        const extra = fixture("project", "current_exact", originalCanonical(), ORIGINAL_BODY, nativeText("project", "current"));
        const extraFile = firstNative(extra).files[0];
        if (extraFile === undefined) throw new Error("Subagent extra-file fixture is missing its entry");
        firstNative(extra).files.push({ ...extraFile, relativePath: ".agents/agents/extra.md" });
        expect(supports.project.analyze(extra).status).toBe("failed");

        for (const relativePath of ["../agent.md", ".agents\\agents\\agent.md", ".agents/agents/deep/nested/agent.md"]) {
            const unsafe = fixture(
                "project",
                "current_exact",
                originalCanonical(),
                ORIGINAL_BODY,
                nativeText("project", "current"),
            );
            const unsafeFile = firstNative(unsafe).files[0];
            if (unsafeFile === undefined) throw new Error("Subagent unsafe-path fixture is missing its entry");
            unsafeFile.relativePath = relativePath;
            expect(supports.project.analyze(unsafe).status).toBe("failed");
        }

        const foreign = foreignCanonical();
        foreign.typeData.execution.model = {
            mode: "selected",
            dialectId: "foreign-model-v1",
            selector: "pro",
            relativeTier: 10,
        };
        expect(supports.project.analyze(canonicalFixture("project", foreign)).status).toBe("failed");
    });

    it("rejects native bytes whose canonical projection or exact file identity no longer matches", () => {
        expect(validateNative("project", originalCanonical(), ORIGINAL_BODY, nativeText("project", "current"))).toBe(true);
        expect(validateNative("global", originalCanonical(), ORIGINAL_BODY, nativeText("global", "current"))).toBe(true);
        expect(validateNative("project", foreignCanonical(), ORIGINAL_BODY, nativeText("project", "current"))).toBe(false);
        expect(validateNative("project", originalCanonical(), ORIGINAL_BODY, `${nativeText("project", "current")}drift\n`)).toBe(
            false,
        );
    });
});

function supportFor(variant: Variant) {
    return variant === "project" ? supports.project : supports.global;
}

function appSupportFor(variant: Variant) {
    return variant === "project" ? appSupports.project : appSupports.global;
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
            dialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
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

function canonicalFixture(
    variant: Variant,
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }> = originalCanonical(),
): RenderAnalysisInput {
    const support = supportFor(variant);
    const declaration = support.renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Subagent canonical materializer missing");
    return baseFixture(variant, VERSION_ID, canonical, ORIGINAL_BODY, [
        {
            inputKind: "canonical_materialization",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
            materializer: declaration.materializer,
            degradationKinds: [...declaration.degradationKinds],
            reasonCode: declaration.reasonCode,
        },
    ]);
}

function appCanonicalFixture(variant: Variant): RenderAnalysisInput {
    const input = canonicalFixture(variant);
    const support = appSupportFor(variant);
    const build = support.renderContractDeclaration.verifiedBuilds[0];
    const context = input.deployment.targetContexts[0];
    if (build === undefined || context === undefined) throw new Error("App Subagent verified build is missing");
    input.deployment.platform = build.platform;
    input.deployment.platformInstanceId = `test-${build.platform}`;
    context.agentRuntimeId = "ANTIGRAVITY_APP";
    context.versionText = build.versionText;
    context.buildIdentity = build.buildIdentity;
    context.targetContextSchemaId = support.targetContextSchema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = support.targetContextSchema.schemaFingerprint;
    context.renderFacts = [
        { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" },
        ...(variant === "project"
            ? [
                  {
                      key: "oaam.project-binding",
                      value: "registered",
                      evidenceLevel: "agent_runtime_verified" as const,
                  },
              ]
            : []),
    ];
    for (const semantic of input.requiredSemantics) semantic.consumerAgentRuntimeId = "ANTIGRAVITY_APP";
    for (const group of input.dialectInputs) group.consumerAgentRuntimeIds = ["ANTIGRAVITY_APP"];
    return input;
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
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    versionText: "1.1.10",
                    buildIdentity: BUILD_HASH,
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
                            : []),
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
        dialectInputs: [
            { targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"], inputs },
        ],
    };
}

function materializationInput(
    fixtureInput: RenderAnalysisInput,
    variant: Variant,
    support = supportFor(variant),
): RenderMaterializationInput {
    const analysis = support.analyze(fixtureInput);
    if (analysis.status !== "complete") throw new Error("Subagent analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Subagent materialization profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixtureInput.deployment),
        requiredSemantics: structuredClone(fixtureInput.requiredSemantics),
        dialectInputs: structuredClone(fixtureInput.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "ANTIGRAVITY",
                rendererAdapterVersion: antigravityProvider.version,
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
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Subagent output unit missing");
    const relativePath = nativePath(variant);
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
                consumerOwnerAdapterId: "ANTIGRAVITY",
                consumerOwnerAdapterVersion: antigravityProvider.version,
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
                    relativePath,
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
                relativePath,
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

function originalCanonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return subagentCanonical("oaam-phase55-subagent", "OAAM isolated Subagent", false, "pro", "sandbox", false);
}

function foreignCanonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return subagentCanonical("oaam-phase55-auditor", "OAAM rebased Subagent", true, "flash", "auto", true);
}

function subagentCanonical(
    name: string,
    description: string,
    mainAgent: boolean,
    model: "flash" | "pro",
    permission: "auto" | "sandbox",
    hidden: boolean,
): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name,
            description,
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base: {
                        mode: "allowlist",
                        allowed: [
                            {
                                mode: "agent_runtime_tool",
                                selector: { dialectId: ANTIGRAVITY_SUBAGENT_TOOL_DIALECT, selector: "view_file" },
                            },
                        ],
                    },
                    unavailable: [],
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: {
                    mode: "selected",
                    dialectId: ANTIGRAVITY_SUBAGENT_PERMISSION_DIALECT,
                    selector: permission,
                    effect: permission === "auto" ? "classifier_mediated" : "auto_approve_selected_operations",
                },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: { mode: "agent_runtime_default" },
                model: {
                    mode: "selected",
                    dialectId: ANTIGRAVITY_SUBAGENT_MODEL_DIALECT,
                    selector: model,
                    relativeTier: model === "flash" ? 1 : 10,
                },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: mainAgent
                ? { mode: "user_selectable", initialPrompt: { mode: "none" } }
                : { mode: "delegated_only" },
            presentation: { listing: hidden ? "hidden" : "visible", color: { mode: "agent_runtime_default" } },
        },
    };
}

function nativeText(_variant: Variant, state: "current" | "foreign"): string {
    const foreign = state === "foreign";
    return [
        "---",
        "# preserve Antigravity custom-agent layout",
        `name: ${JSON.stringify(foreign ? "oaam-phase55-auditor" : "oaam-phase55-subagent")}`,
        `description: ${JSON.stringify(foreign ? "OAAM rebased Subagent" : "OAAM isolated Subagent")}`,
        "subagent: true",
        'tools: ["view_file"]',
        `mainAgent: ${foreign ? "true" : "false"}`,
        `model: ${foreign ? '"flash"' : "pro"}`,
        `commandExecutionPolicy: ${foreign ? '"auto"' : "sandbox"}`,
        `hidden: ${foreign ? "true" : "false"}`,
        "---",
        foreign ? FOREIGN_BODY : ORIGINAL_BODY,
    ].join("\n");
}

function validateNative(
    variant: Variant,
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    text: string,
): boolean {
    const descriptor = nativeFile(variant, text);
    const { text: _text, ...file } = descriptor;
    return validateAntigravityNativeDialect({
        canonical,
        canonicalFiles: [textFile(body)],
        representation: {
            schemaVersion: 1,
            dialectId: ANTIGRAVITY_NATIVE_DIALECTS.subagentMarkdown,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: nativePath(variant), bytes: new TextEncoder().encode(text) }],
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
    return {
        relativePath: nativePath(variant),
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function nativePath(variant: Variant): string {
    return variant === "project" ? ".agents/agents/oaam-phase55-subagent.md" : "config/agents/oaam-phase55-global-subagent.md";
}

function instruction(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function semantic(
    semanticKind: string,
    subjectKind: "asset" | "file",
    versionId: string,
): RenderAnalysisInput["requiredSemantics"][number] {
    return {
        semanticRefFingerprint: sha256Text(semanticKind),
        consumerAgentRuntimeId: "ANTIGRAVITY_CLI",
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

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}
