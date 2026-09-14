import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
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
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { antigravityProvider } from "../src/antigravity-provider";
import { ANTIGRAVITY_NATIVE_DIALECTS } from "../src/antigravity-source-read-model";
import {
    ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS,
    createAntigravityIdeWorkflowTargetSupports,
} from "../src/antigravity-target-workflow";

type Variant = "project" | "global";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const FILE_ID = "66666666-6666-4666-8666-666666666666";
const BODY = "Review the selected change. OAAM_PHASE55_IDE_WORKFLOW_41A7D2\n";
const CHANGED_BODY = BODY.replace("41A7D2", "99C4E1");

const projectSchema = required(
    antigravityProvider.targetContextSchemas.find((row) => row.targetContextSchemaId === "ANTIGRAVITY_IDE_PROJECT_TARGET_V1"),
    "IDE project schema is missing",
);
const globalSchema = required(
    antigravityProvider.targetContextSchemas.find((row) => row.targetContextSchemaId === "ANTIGRAVITY_IDE_GLOBAL_TARGET_V1"),
    "IDE global schema is missing",
);
const supports = createAntigravityIdeWorkflowTargetSupports({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    projectTargetContextSchemaId: projectSchema.targetContextSchemaId,
    globalTargetContextSchemaId: globalSchema.targetContextSchemaId,
});

describe("Antigravity IDE exact Workflow targets", () => {
    it("registers exact WSL/Win32 project and global declarations with reviewed canonical conversion", () => {
        for (const support of Object.values(supports)) {
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: "ANTIGRAVITY_IDE",
                assetKind: "Workflow",
                rebaseMaterializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.rebase,
                canonicalMaterialization: {
                    materializer: ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.canonical,
                    degradationKinds: ["runtime_specific_metadata_lost"],
                },
                verifiedBuilds: [
                    expect.objectContaining({ platform: "wsl", versionText: "1.107.0" }),
                    expect.objectContaining({ platform: "win32", versionText: "1.107.0" }),
                ],
            });
        }
        expect(
            antigravityProvider.dialectContracts.native.find(
                (row) => row.definition.kind === "Workflow" && row.definition.dialectId === ANTIGRAVITY_NATIVE_DIALECTS.workflow,
            )?.definition.rebaseMaterializer,
        ).toEqual(ANTIGRAVITY_WORKFLOW_TARGET_COMPONENTS.rebase);
    });

    it.each([
        "project",
        "global",
    ] as const)("restores exact bytes and rebases the immediate parent for %s scope", async (variant) => {
        const current = nativeFixture(variant, "current_exact", BODY, BODY);
        expect(await antigravityProvider.analyzeRender(current)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(await antigravityProvider.materializeRender(materializationInput(current, variant))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: nativeText(BODY) } }] }],
        });

        const rebased = nativeFixture(variant, "parent_rebase_seed", BODY, CHANGED_BODY);
        expect(await antigravityProvider.analyzeRender(rebased)).toMatchObject({ status: "complete" });
        expect(await antigravityProvider.materializeRender(materializationInput(rebased, variant))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: nativeText(CHANGED_BODY) } }] }],
        });
    });

    it.each([
        "project",
        "global",
    ] as const)("materializes reviewed portable canonical Workflow content for %s scope", async (variant) => {
        const fixture = canonicalFixture(variant);
        const analysis = await antigravityProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.semanticOptions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "degraded",
                    reasonCode: "antigravity_ide_workflow_reviewed_canonical_conversion",
                    degradationKinds: ["runtime_specific_metadata_lost"],
                    approvalRequirement: expect.objectContaining({ approvalState: "required" }),
                }),
            ]),
        );
        const request = materializationInput(fixture, variant);
        const result = await antigravityProvider.materializeRender(request);
        assertCanonicalEntryControls(antigravityProvider, request, result);
        expect(result).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath:
                                variant === "project"
                                    ? ".agents/workflows/oaam-workflow-11111111.md"
                                    : "config/global_workflows/oaam-workflow-11111111.md",
                            content: { text: nativeText(BODY) },
                        },
                    ],
                },
            ],
        });
    });

    it("reverses body-only changes and rejects private frontmatter drift", async () => {
        const fixture = nativeFixture("project", "current_exact", BODY, BODY);
        const materialization = materializationInput(fixture, "project");
        expect(
            await antigravityProvider.inspectRenderedTarget(
                changedInspection(fixture, materialization, nativeText(BODY), nativeText(CHANGED_BODY)),
            ),
        ).toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [expect.objectContaining({ replacementContent: { contentKind: "text", text: CHANGED_BODY } })],
        });

        const drifted = changedInspection(
            fixture,
            materialization,
            nativeText(BODY),
            nativeText(CHANGED_BODY).replace('description: "Reviewed Antigravity Workflow"', 'description: "Changed"'),
        );
        expect(await antigravityProvider.inspectRenderedTarget(drifted)).toMatchObject({
            status: "complete",
            files: [expect.objectContaining({ attributionState: "conflict" })],
            changes: [],
        });
    });

    it("blocks unsafe paths, extra files, foreign restoration, and unrepresentable canonical execution", async () => {
        const unsafe = nativeFixture("project", "current_exact", BODY, BODY);
        required(firstNativeInput(unsafe).files[0], "unsafe Workflow file is missing").relativePath =
            ".agents/workflows/../escape.md";
        expect(supports.project.analyze(unsafe).status).toBe("failed");

        const extra = nativeFixture("project", "current_exact", BODY, BODY);
        const extraNative = firstNativeInput(extra);
        extraNative.files.push(structuredClone(required(extraNative.files[0], "extra Workflow file is missing")));
        expect(supports.project.analyze(extra).status).toBe("failed");

        const restoration = nativeFixture("global", "current_exact", BODY, BODY);
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.global.analyze(restoration).status).toBe("failed");

        const canonical = canonicalFixture("project");
        const implementation = workflowTypeData(canonical).implementation;
        if (implementation.kind !== "instructions") throw new Error("Workflow fixture is not instructional");
        implementation.execution.shell = { mode: "selected", dialectId: "shell-v1", selector: "bash" };
        expect(await antigravityProvider.analyzeRender(canonical)).toMatchObject({ status: "failed", outputUnits: [] });
    });

    it("fails closed when one Workflow Deployment mixes Project and Global ownership", async () => {
        const mixed = nativeFixture("project", "current_exact", BODY, BODY);
        const projectAsset = mixed.deployment.assets[0];
        if (projectAsset === undefined) throw new Error("Workflow project asset is missing");
        mixed.deployment.assets.push({
            ...structuredClone(projectAsset),
            scope: "global",
            projectId: "",
        });

        expect(await antigravityProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            diagnostics: [{ code: "antigravity_ide_workflow_target_shape_ambiguous", severity: "error" }],
        });
    });
});

function nativeFixture(
    variant: Variant,
    inputRole: "current_exact" | "parent_rebase_seed",
    nativeBody: string,
    canonicalBody: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : NEXT_VERSION_ID;
    const fixture = baseFixture(variant, versionId, canonicalBody);
    const native = nativeDialectInput(nativeFile(variant, nativeBody), inputRole);
    fixture.dialectInputs = [
        {
            targetVersion: { assetId: ASSET_ID, versionId },
            consumerAgentRuntimeIds: ["ANTIGRAVITY_IDE"],
            inputs: [
                inputRole === "current_exact"
                    ? native
                    : {
                          ...native,
                          inputRole: "parent_rebase_seed",
                          sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                      },
            ],
        },
    ];
    return fixture;
}

function canonicalFixture(variant: Variant): RenderAnalysisInput {
    const fixture = baseFixture(variant, VERSION_ID, BODY);
    const declaration = supportFor(variant).renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Workflow canonical materialization is missing");
    fixture.dialectInputs = [
        {
            targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
            consumerAgentRuntimeIds: ["ANTIGRAVITY_IDE"],
            inputs: [
                {
                    inputKind: "canonical_materialization",
                    nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
                    materializer: declaration.materializer,
                    degradationKinds: [...declaration.degradationKinds],
                    reasonCode: declaration.reasonCode,
                },
            ],
        },
    ];
    return fixture;
}

function baseFixture(variant: Variant, versionId: string, body: string): RenderAnalysisInput {
    const support = supportFor(variant);
    const build = required(support.renderContractDeclaration.verifiedBuilds[0], "Workflow build is missing");
    const files = canonicalFiles(body);
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: build.platform,
            platformInstanceId: `test-${build.platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
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
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope: variant,
                    projectId: variant === "project" ? PROJECT_ID : "",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: workflowCanonical(),
                        files,
                    },
                    sectionHandles: { [FILE_ID]: "workflow-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", versionId, "asset"),
            semantic("workflow.activation", versionId, "asset"),
            semantic("workflow.content", versionId, "file"),
        ] as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [],
    };
}

function materializationInput(fixture: RenderAnalysisInput, variant: Variant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete") throw new Error("Workflow analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = required(contract.materializationProfiles[0], "Workflow profile is missing");
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

function changedInspection(
    fixture: RenderAnalysisInput,
    materialization: RenderMaterializationInput,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = required(materialization.selection.outputUnits[0], "Workflow output unit is missing");
    const relativePath = required(unit.claims[0]?.relativePath, "Workflow output path is missing");
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
                        hunkFingerprint: sha256Text(relativePath),
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

function supportFor(variant: Variant) {
    return variant === "project" ? supports.project : supports.global;
}

function targetPath(variant: Variant): string {
    return variant === "project"
        ? ".agents/workflows/oaam-phase55-ide-workflow.md"
        : "config/global_workflows/oaam-phase55-ide-global-workflow.md";
}

function nativeText(body: string): string {
    return ["---", 'name: "review"', 'description: "Reviewed Antigravity Workflow"', "---", body].join("\n");
}

function nativeFile(variant: Variant, body: string) {
    const text = nativeText(body);
    return {
        relativePath: targetPath(variant) as never,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function nativeDialectInput(file: ReturnType<typeof nativeFile>, inputRole: "current_exact" | "parent_rebase_seed") {
    const { text: _text, ...descriptor } = file;
    return {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
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
            description: "Reviewed Antigravity Workflow",
            implementation: {
                kind: "instructions",
                instructionDialectId: ANTIGRAVITY_NATIVE_DIALECTS.workflow,
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
                commandNames: ["review"],
                userInvocable: true,
                agentInvocable: true,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}

function canonicalFiles(body: string): AssetVersionFileContentV2[] {
    return [textFile("WORKFLOW.md", body)];
}

function textFile(logicalPath: string, text: string): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId: FILE_ID,
            logicalPath,
            role: "entry",
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
    if (canonical?.kind !== "Workflow") throw new Error("Workflow canonical data is missing");
    return canonical.typeData;
}

function firstNativeInput(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("Workflow native input is missing");
    return candidate;
}

function semantic(semanticKind: string, versionId: string, subjectKind: "asset" | "file") {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${subjectKind}`),
        consumerAgentRuntimeId: "ANTIGRAVITY_IDE" as const,
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: FILE_ID },
        semanticKind,
    };
}

function required<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}
