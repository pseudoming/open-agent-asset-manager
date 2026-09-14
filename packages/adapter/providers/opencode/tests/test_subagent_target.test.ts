import * as crypto from "node:crypto";
import type {
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    Sha256Digest,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import {
    createOpencodeAppSubagentTargetSupports,
    createOpencodeCliSubagentTargetSupports,
    opencodeSubagentTargetInternalsForTest as internals,
    OPENCODE_SUBAGENT_TARGET_COMPONENTS,
    type OpencodeSubagentTargetSupports,
} from "../src/opencode-target-subagent";

type Variant = keyof OpencodeSubagentTargetSupports;

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const CLI_BUILD = "sha256:c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d";
const APP_BUILD = "sha256:c5fe1808131d04a1fba13ec237fbf675bb4951dcaa669a48da58cb20b3396c6f";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const ORIGINAL_BODY = "Review OAAM_OPENCODE_SUBAGENT_CURRENT_51A2 carefully.";
const REBASED_BODY = "Review OAAM_OPENCODE_SUBAGENT_REBASE_83B4 carefully.";
const REVERSE_BODY = "Review OAAM_OPENCODE_SUBAGENT_REVERSE_74C6 carefully.";

const supports = createOpencodeCliSubagentTargetSupports({
    adapterVersion: opencodeProvider.version,
    agentRuntimes: opencodeProvider.agentRuntimes,
    projectTargetContextSchemaId: "OPENCODE_CLI_PROJECT_SUBAGENT_TARGET_V1",
    globalTargetContextSchemaId: "OPENCODE_CLI_GLOBAL_SUBAGENT_TARGET_V1",
});
const appSupports = createOpencodeAppSubagentTargetSupports({
    adapterVersion: opencodeProvider.version,
    agentRuntimes: opencodeProvider.agentRuntimes,
    projectTargetContextSchemaId: "OPENCODE_APP_PROJECT_SUBAGENT_TARGET_V1",
    globalTargetContextSchemaId: "OPENCODE_APP_GLOBAL_SUBAGENT_TARGET_V1",
});

describe("OpenCode exact Subagent targets", () => {
    it("registers independent CLI/App project/global exact-build contracts and rebase authority", () => {
        expect(opencodeProvider.version).toBe("0.11.0");
        for (const [runtimeSupports, agentRuntimeId, buildIdentity] of [
            [supports, "OPENCODE_CLI", CLI_BUILD],
            [appSupports, "OPENCODE_APP", APP_BUILD],
        ] as const) {
            for (const variant of ["project", "global"] as const) {
                expect(runtimeSupports[variant].renderContractDeclaration).toMatchObject({
                    agentRuntimeId,
                    assetKind: "Subagent",
                    nativeDialectId: OPENCODE_NATIVE_DIALECTS.subagent,
                    rebaseMaterializer: OPENCODE_SUBAGENT_TARGET_COMPONENTS.rebase,
                });
                expect(runtimeSupports[variant].renderContractDeclaration.verifiedBuilds[0]).toMatchObject({
                    versionText: "1.18.15",
                    buildIdentity,
                    platform: "wsl",
                });
                expect(runtimeSupports[variant].renderContractDeclaration.verifiedBuilds.map((build) => build.platform)).toEqual(
                    agentRuntimeId === "OPENCODE_CLI" ? ["wsl", "win32"] : ["wsl"],
                );
            }
        }
        expect(supports.project.renderContractDeclaration.verifiedBuilds[1]).toMatchObject({
            platform: "win32",
            buildIdentity: "sha256:fd254474def7ee35f07416cf4674c361f07e7bcd9c7ffb284af21bb011066ee3",
        });
        expect(
            opencodeProvider.dialectContracts.native.find(
                (row) => row.definition.dialectId === OPENCODE_NATIVE_DIALECTS.subagent,
            ),
        ).toMatchObject({ definition: { rebaseMaterializer: OPENCODE_SUBAGENT_TARGET_COMPONENTS.rebase } });
    });

    it.each([
        "project",
        "global",
    ] as const)("restores exact %s private bytes and rebases only the canonical body", async (variant) => {
        const current = fixture(variant, "current_exact", ORIGINAL_BODY, nativeText(variant, ORIGINAL_BODY));
        expect(await opencodeProvider.analyzeRender(current)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(await opencodeProvider.materializeRender(materializationInput(current, variant))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                { files: [{ relativePath: nativePath(variant), content: { text: nativeText(variant, ORIGINAL_BODY) } }] },
            ],
        });

        const rebased = fixture(variant, "parent_rebase_seed", REBASED_BODY, nativeText(variant, ORIGINAL_BODY));
        expect(await opencodeProvider.analyzeRender(rebased)).toMatchObject({ status: "complete", diagnostics: [] });
        const text = `${nativePrefix()}${REBASED_BODY}`;
        expect(await opencodeProvider.materializeRender(materializationInput(rebased, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: nativePath(variant), content: { text } }] }],
        });
        expect(text).toContain("# OAAM preserves this layout and private options");
        expect(text).toContain("providerSetting: enabled");
        expect(text).toContain("futureFlag: private");
    });

    it.each(["project", "global"] as const)("reverse-accepts only an attributable %s body edit", async (variant) => {
        const input = fixture(variant, "current_exact", ORIGINAL_BODY, nativeText(variant, ORIGINAL_BODY));
        const materialization = materializationInput(input, variant);
        const applied = nativeText(variant, ORIGINAL_BODY);
        const current = nativeText(variant, REVERSE_BODY);
        expect(await opencodeProvider.inspectRenderedTarget(inspection(materialization, applied, current))).toMatchObject({
            status: "complete",
            changes: [{ replacementContent: { contentKind: "text", text: instruction(REVERSE_BODY) } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        const drift = current.replace("providerSetting: enabled", "providerSetting: changed");
        expect(await supportFor(variant).inspect(inspection(materialization, applied, drift))).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict" }],
        });
    });

    it.each(["project", "global"] as const)("materializes a reviewed portable canonical %s declaration", (variant) => {
        const input = canonicalFixture(variant);
        const analysis = supportFor(variant).analyze(input);
        expect(analysis).toMatchObject({
            status: "complete",
            semanticOptions: expect.arrayContaining([expect.objectContaining({ outcome: "degraded" })]),
        });
        const request = materializationInput(input, variant);
        const result = supportFor(variant).materialize(request);
        assertCanonicalEntryControls(opencodeProvider, request, result);
        expect(result).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath:
                                variant === "project"
                                    ? ".opencode/agents/oaam-phase57-subagent.md"
                                    : "agents/oaam-phase57-global-subagent.md",
                            content: { text: expect.stringContaining(ORIGINAL_BODY) },
                        },
                    ],
                },
            ],
        });
        if (result.status !== "complete") throw new Error("portable Subagent did not materialize");
        const file = result.materializedUnits[0]?.files[0];
        if (file?.content.contentKind !== "text") throw new Error("portable Subagent did not produce text");
        expect(file.content.text).toContain('"read": allow');
        expect(file.content.text).toContain('"shell": deny');
        expect(file.content.text).not.toContain("providerSetting");
    });

    it("routes the App cell only through its independent target context", async () => {
        const input = fixture("project", "current_exact", ORIGINAL_BODY, nativeText("project", ORIGINAL_BODY));
        const context = required(input.deployment.targetContexts[0]);
        const build = required(appSupports.project.renderContractDeclaration.verifiedBuilds[0]);
        context.agentRuntimeId = "OPENCODE_APP";
        context.versionText = build.versionText;
        context.buildIdentity = build.buildIdentity;
        context.targetContextSchemaId = appSupports.project.targetContextSchema.targetContextSchemaId;
        context.targetContextSchemaFingerprint = appSupports.project.targetContextSchema.schemaFingerprint;
        for (const semantic of input.requiredSemantics) semantic.consumerAgentRuntimeId = "OPENCODE_APP";
        for (const group of input.dialectInputs) group.consumerAgentRuntimeIds = ["OPENCODE_APP"];
        expect(await opencodeProvider.analyzeRender(input)).toMatchObject({
            status: "complete",
            outputUnits: [expect.objectContaining({ outputContractId: "OPENCODE_APP_NATIVE_PROJECT_SUBAGENT_MARKDOWN_V1" })],
        });
    });

    it("composes scopes, warns for a newer build, and keeps unclassified lineage blocked", async () => {
        const project = fixture("project", "current_exact", ORIGINAL_BODY, nativeText("project", ORIGINAL_BODY));
        const global = reidentify(fixture("global", "current_exact", ORIGINAL_BODY, nativeText("global", ORIGINAL_BODY)));
        const combined = combine(project, global);
        expect(await opencodeProvider.analyzeRender(combined)).toMatchObject({
            status: "complete",
            outputUnits: [expect.any(Object), expect.any(Object)],
        });
        required(combined.dialectInputs[1]).inputs = [];
        expect(await opencodeProvider.analyzeRender(combined)).toMatchObject({
            status: "partial",
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "opencode_subagent_native_variant_unavailable" }),
            ]),
        });

        const newer = fixture("project", "current_exact", ORIGINAL_BODY, nativeText("project", ORIGINAL_BODY));
        const context = required(newer.deployment.targetContexts[0]);
        context.versionText = "1.18.16";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await opencodeProvider.analyzeRender(newer)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred" })],
        });
    });

    it("fails closed for unsafe graphs, foreign restoration, duplicate lineage and binary reverse", async () => {
        for (const mutate of [
            (input: RenderAnalysisInput) => {
                required(firstNative(input).files[0]).relativePath = ".opencode/agents/../escape.md";
            },
            (input: RenderAnalysisInput) => {
                required(firstNative(input).files[0]).relativePath = ".opencode\\agents\\escape.md";
            },
            (input: RenderAnalysisInput) => {
                required(firstNative(input).files[0]).relativePath = ".opencode/agents/not-markdown.txt";
            },
            (input: RenderAnalysisInput) => {
                required(firstNative(input).files[0]).executable = true;
            },
            (input: RenderAnalysisInput) => {
                const file = required(firstNative(input).files[0]);
                firstNative(input).files.push({ ...file, relativePath: ".opencode/agents/extra.md" });
            },
        ]) {
            const invalid = fixture("project", "current_exact", ORIGINAL_BODY, nativeText("project", ORIGINAL_BODY));
            mutate(invalid);
            expect(supports.project.analyze(invalid).status).toBe("failed");
        }

        const restoration = fixture("global", "current_exact", ORIGINAL_BODY, nativeText("global", ORIGINAL_BODY));
        required(restoration.dialectInputs[0]).inputs.push({
            inputKind: "dialect_restoration",
            restoration: { dialectId: "foreign", restorationContractFingerprint: HASH, contentHash: HASH },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.global.analyze(restoration).status).toBe("failed");

        const duplicate = fixture("project", "current_exact", ORIGINAL_BODY, nativeText("project", ORIGINAL_BODY));
        required(duplicate.dialectInputs[0]).inputs.push(structuredClone(required(duplicate.dialectInputs[0]?.inputs[0])));
        expect(await opencodeProvider.analyzeRender(duplicate)).toMatchObject({ status: "failed", outputUnits: [] });

        const reverse = fixture("project", "current_exact", ORIGINAL_BODY, nativeText("project", ORIGINAL_BODY));
        const reverseInspection = inspection(
            materializationInput(reverse, "project"),
            nativeText("project", ORIGINAL_BODY),
            nativeText("project", ORIGINAL_BODY),
        );
        required(reverseInspection.files[0]).currentContent = { contentKind: "binary", bytes: Uint8Array.of(0xff) };
        expect(await opencodeProvider.inspectRenderedTarget(reverseInspection)).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict" }],
        });
    });

    it("blocks non-portable canonical fields and a parent whose behavioral metadata changed", () => {
        const cases: Array<(value: ReturnType<typeof subagentCanonical>) => void> = [
            (value) => {
                value.typeData.name = "../escape";
            },
            (value) => {
                value.typeData.promptContextPolicy = { mode: "selected", dialectId: "foreign", selectors: ["x"] };
            },
            (value) => {
                value.typeData.tools.availability.base = { mode: "none" };
            },
            (value) => {
                value.typeData.tools.permission.rules[0] = {
                    selector: { mode: "bound_subagent", targetAssetVersionId: "66666666-6666-4666-8666-666666666666" },
                    action: "ask",
                };
            },
            (value) => {
                value.typeData.execution.model = {
                    mode: "selected",
                    dialectId: "foreign",
                    selector: "model",
                    relativeTier: -1,
                };
            },
            (value) => {
                value.typeData.execution.scheduling = { mode: "always_background" };
            },
            (value) => {
                value.typeData.directInvocation = { mode: "agent_runtime_default" };
            },
            (value) => {
                value.typeData.presentation.listing = "visible";
            },
        ];
        for (const mutate of cases) {
            const input = canonicalFixture("project");
            const canonical = required(input.deployment.assets[0]).version.canonical;
            if (canonical.kind !== "Subagent") throw new Error("Subagent canonical missing");
            mutate(canonical);
            expect(supports.project.analyze(input).status).toBe("failed");
        }

        const rebased = fixture("project", "parent_rebase_seed", REBASED_BODY, nativeText("project", ORIGINAL_BODY));
        const canonical = required(rebased.deployment.assets[0]).version.canonical;
        if (canonical.kind !== "Subagent") throw new Error("Subagent canonical missing");
        canonical.typeData.description = "Changed metadata";
        expect(supports.project.analyze(rebased).status).toBe("failed");
    });

    it("keeps bounded parsing and path helpers fail closed", () => {
        expect(internals.instructionBody(instruction("body"))).toBe("body");
        expect(internals.instructionBody("not-json")).toBeNull();
        expect(internals.instructionBody(JSON.stringify({ schemaVersion: 1, sections: [] }))).toBeNull();
        expect(internals.splitSubagentDocument(nativeText("project", ORIGINAL_BODY))).toMatchObject({ body: ORIGINAL_BODY });
        expect(internals.splitSubagentDocument("body only")).toBeNull();
        expect(internals.splitSubagentDocument("---\ndescription: x\nbody")).toBeNull();
        expect(internals.isSubagentPath(".opencode/agent/team/review.md" as never, "project")).toBe(true);
        expect(internals.isSubagentPath("agents/team/review.md" as never, "global")).toBe(true);
        expect(internals.isSubagentPath("agents/../review.md" as never, "global")).toBe(false);
        expect(internals.isSubagentPath("agents/review.txt" as never, "global")).toBe(false);
    });
});

function supportFor(variant: Variant) {
    return supports[variant];
}

function fixture(
    variant: Variant,
    inputRole: "current_exact" | "parent_rebase_seed",
    body: string,
    native: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const file = nativeFile(variant, native);
    const { text: _text, ...descriptor } = file;
    const input = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: OPENCODE_NATIVE_DIALECTS.subagent,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [descriptor],
        },
        files: [file],
    };
    return baseFixture(variant, versionId, body, [
        inputRole === "current_exact"
            ? input
            : {
                  ...input,
                  inputRole: "parent_rebase_seed" as const,
                  sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
              },
    ]);
}

function canonicalFixture(variant: Variant): RenderAnalysisInput {
    const declaration = supportFor(variant).renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Subagent canonical materializer missing");
    return baseFixture(variant, VERSION_ID, ORIGINAL_BODY, [
        {
            inputKind: "canonical_materialization",
            nativeDialectId: OPENCODE_NATIVE_DIALECTS.subagent,
            materializer: declaration.materializer,
            degradationKinds: [...declaration.degradationKinds],
            reasonCode: declaration.reasonCode,
        },
    ]);
}

function baseFixture(
    variant: Variant,
    versionId: string,
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
                    agentRuntimeId: "OPENCODE_CLI",
                    versionText: "1.18.15",
                    buildIdentity: CLI_BUILD,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        ...(scope === "project"
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
                        canonical: subagentCanonical(variant),
                        files: [canonicalFile(body)],
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
        dialectInputs: [{ targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: ["OPENCODE_CLI"], inputs }],
    };
}

function materializationInput(input: RenderAnalysisInput, variant: Variant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(input);
    if (analysis.status !== "complete")
        throw new Error(`Subagent analysis did not close: ${JSON.stringify(analysis.diagnostics)}`);
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
                rendererAdapterId: "OPENCODE",
                rendererAdapterVersion: opencodeProvider.version,
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

function inspection(
    materialization: RenderMaterializationInput,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = required(materialization.selection.outputUnits[0]);
    const relativePath = required(unit.claims[0]?.relativePath);
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
                consumerOwnerAdapterId: "OPENCODE",
                consumerOwnerAdapterVersion: opencodeProvider.version,
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

function subagentCanonical(variant: Variant): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: variant === "project" ? "oaam-phase57-subagent" : "oaam-phase57-global-subagent",
            description: "Review the isolated project carefully.",
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: { base: { mode: "inherit_available" }, unavailable: [] },
                permission: {
                    rules: [permission("read", "preapproved"), permission("shell", "deny")],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: { mode: "bounded", dialectId: "opencode-steps-v1", limit: 4 },
                model: {
                    mode: "selected",
                    dialectId: "opencode-model-selector-v1",
                    selector: "openai/gpt-5",
                    relativeTier: -1,
                },
                effort: {
                    mode: "selected",
                    dialectId: "opencode-variant-selector-v1",
                    selector: "high",
                    relativeTier: -1,
                },
                sampling: { temperature: { mode: "selected", value: 0.2 }, topP: { mode: "selected", value: 0.8 } },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: {
                listing: "hidden",
                color: { mode: "selected", dialectId: "opencode-color-v1", selector: "info" },
            },
        },
    };
}

function permission(selector: string, action: "preapproved" | "ask" | "deny") {
    return {
        selector: {
            mode: "agent_runtime_tool" as const,
            selector: { dialectId: "opencode-permission-selector-v1", selector },
        },
        action,
    };
}

function canonicalFile(body: string) {
    const text = instruction(body);
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: FILE_ID,
            logicalPath: "instructions.json" as const,
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

function nativeText(_variant: Variant, body: string): string {
    return `${nativePrefix()}${body}`;
}

function nativePrefix(): string {
    return [
        "---",
        "# OAAM preserves this layout and private options",
        "description: Review the isolated project carefully.",
        "mode: subagent",
        "model: openai/gpt-5",
        "variant: high",
        "temperature: 0.2",
        "top_p: 0.8",
        "steps: 4",
        "hidden: true",
        "color: info",
        "permission:",
        "  read: allow",
        "  shell: deny",
        "options:",
        "  providerSetting: enabled",
        "futureFlag: private",
        "---",
        "",
    ].join("\n");
}

function nativeFile(variant: Variant, text: string) {
    return {
        relativePath: nativePath(variant) as never,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function nativePath(variant: Variant): string {
    return variant === "project" ? ".opencode/agents/oaam-phase57-subagent.md" : "agents/oaam-phase57-global-subagent.md";
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
        semanticRefFingerprint: sha256Text(`${semanticKind}:${versionId}`),
        consumerAgentRuntimeId: "OPENCODE_CLI",
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

function reidentify(input: RenderAnalysisInput): RenderAnalysisInput {
    const assetId = "99999999-9999-4999-8999-999999999999";
    const versionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const asset = required(input.deployment.assets[0]);
    asset.version.ref = { assetId, versionId };
    required(asset.version.files[0]).file.fileId = fileId;
    asset.sectionHandles = { [fileId]: "global-subagent-entry" };
    required(input.dialectInputs[0]).targetVersion = { assetId, versionId };
    for (const semanticRef of input.requiredSemantics) {
        semanticRef.subject.assetId = assetId;
        semanticRef.subject.versionId = versionId;
        if (semanticRef.subject.subjectKind === "file") semanticRef.subject.fileId = fileId;
        semanticRef.semanticRefFingerprint = sha256Text(`${semanticRef.semanticKind}:${versionId}`);
    }
    return input;
}

function combine(left: RenderAnalysisInput, right: RenderAnalysisInput): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: {
            ...left.deployment,
            targetContexts: [...left.deployment.targetContexts, ...right.deployment.targetContexts],
            assets: [...left.deployment.assets, ...right.deployment.assets],
        },
        requiredSemantics: [...left.requiredSemantics, ...right.requiredSemantics],
        dialectInputs: [...left.dialectInputs, ...right.dialectInputs],
    };
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("required fixture value missing");
    return value;
}

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}
