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
import { cursorProvider } from "../src/cursor-provider";
import { CURSOR_NATIVE_DIALECTS } from "../src/cursor-source-read-model";
import { parseCursorCommand } from "../src/cursor-source-read-workflow";
import {
    analyzeCursorWorkflowTargets,
    CURSOR_WORKFLOW_TARGET_COMPONENTS,
    type CursorWorkflowTargetSupports,
    createCursorAppWorkflowTargetSupports,
    createCursorCliWorkflowTargetSupports,
} from "../src/cursor-target-workflow";

type RuntimeVariant = "cliProject" | "cliGlobal" | "appProject" | "appGlobal";
type ScopeVariant = keyof CursorWorkflowTargetSupports;

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const BODY = "# Release\nRelease $1 after reviewing $ARGUMENTS. OAAM_CURSOR_WORKFLOW_ORIGINAL_61D4A8\n";
const CHANGED_BODY = BODY.replace("ORIGINAL", "REVERSED");
const CLI_BUILD = "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831";
const APP_BUILD = "sha256:98c0fc2885636738e986e01af8f9c5229dad4b2d7510bc489c9ffc0924da4904";
const APP_WIN32_BUILD = "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e";
const CLI_SUPPORTS = createCursorCliWorkflowTargetSupports({
    adapterVersion: cursorProvider.version,
    agentRuntimes: cursorProvider.agentRuntimes,
    projectTargetContextSchemaId: "CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
    globalTargetContextSchemaId: "CURSOR_AGENT_CLI_GLOBAL_WORKFLOW_TARGET_V1",
});
const APP_SUPPORTS = createCursorAppWorkflowTargetSupports({
    adapterVersion: cursorProvider.version,
    agentRuntimes: cursorProvider.agentRuntimes,
    projectTargetContextSchemaId: "CURSOR_APP_PROJECT_TARGET_V1",
    globalTargetContextSchemaId: "CURSOR_APP_GLOBAL_WORKFLOW_TARGET_V1",
});
const VARIANTS: readonly RuntimeVariant[] = ["cliProject", "cliGlobal", "appProject", "appGlobal"];

describe("Cursor exact command Workflow targets", () => {
    it("explains an instruction Workflow's unsupported model invocation without changing its semantics", async () => {
        const fixture = canonicalFixture("cliProject");
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Workflow") throw new Error("Workflow fixture missing");
        canonical.typeData.invocation.agentInvocable = true;
        const before = structuredClone(canonical);
        const result = await cursorProvider.analyzeRender(fixture);
        expect(result).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: expect.arrayContaining([
                expect.objectContaining({ reasonCode: "cursor_workflow_model_invocation_unsupported" }),
            ]),
            diagnostics: [
                expect.objectContaining({
                    code: "cursor_workflow_model_invocation_unsupported",
                    causeKind: "unsupported",
                    retryable: false,
                }),
            ],
        });
        expect(result.blockedSemanticRefs).toHaveLength(fixture.requiredSemantics.length);
        expect(
            result.blockedSemanticRefs.every((item) => item.reasonCode === "cursor_workflow_model_invocation_unsupported"),
        ).toBe(true);
        expect(canonical).toEqual(before);
        canonical.typeData.invocation.agentInvocable = false;
        const ordinary = await cursorProvider.analyzeRender(fixture);
        expect(ordinary.diagnostics.some((item) => item.code === "cursor_workflow_model_invocation_unsupported")).toBe(false);
    });

    it("registers independently anchored CLI/App project/personal variants", () => {
        for (const variant of VARIANTS) {
            const support = supportFor(variant);
            const app = variant.startsWith("app");
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: app ? "CURSOR_APP" : "CURSOR_AGENT_CLI",
                assetKind: "Workflow",
                nativeDialectId: dialectId(variant),
            });
            expect(support.renderContractDeclaration.verifiedBuilds).toHaveLength(app ? 2 : 1);
            expect(support.renderContractDeclaration.verifiedBuilds).toEqual(
                expect.arrayContaining(
                    app
                        ? [
                              expect.objectContaining({
                                  platform: "linux",
                                  versionText: "3.13.25",
                                  buildIdentity: APP_BUILD,
                              }),
                              expect.objectContaining({
                                  platform: "win32",
                                  versionText: "3.12.30",
                                  buildIdentity: APP_WIN32_BUILD,
                              }),
                          ]
                        : [
                              expect.objectContaining({
                                  platform: "wsl",
                                  versionText: "2026.07.23-e383d2b",
                                  buildIdentity: CLI_BUILD,
                              }),
                          ],
                ),
            );
            expect(support.renderContractDeclaration.rebaseMaterializer).toEqual(CURSOR_WORKFLOW_TARGET_COMPONENTS.rebase);
            expect(support.renderContractDeclaration.reverseParser).toEqual(
                app ? CURSOR_WORKFLOW_TARGET_COMPONENTS.appReverse : CURSOR_WORKFLOW_TARGET_COMPONENTS.agentReverse,
            );
            expect(support.renderContractDeclaration.canonicalMaterialization).toMatchObject({
                materializer: CURSOR_WORKFLOW_TARGET_COMPONENTS.canonical,
                degradationKinds: ["runtime_specific_metadata_lost"],
            });
        }
        expect(CLI_SUPPORTS.project.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_graph_v1",
            projectGraphValidator: CURSOR_WORKFLOW_TARGET_COMPONENTS.project,
        });
        expect(CLI_SUPPORTS.global.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            globalGraphValidator: CURSOR_WORKFLOW_TARGET_COMPONENTS.global,
        });
        expect(APP_SUPPORTS.project.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_graph_v1",
            projectGraphValidator: CURSOR_WORKFLOW_TARGET_COMPONENTS.project,
        });
        expect(APP_SUPPORTS.global.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            globalGraphValidator: CURSOR_WORKFLOW_TARGET_COMPONENTS.global,
        });
    });

    it.each(VARIANTS)("restores current native bytes and immediate-parent canonical changes for %s", async (variant) => {
        const current = nativeFixture(variant, "current_exact", BODY, BODY);
        expect(await cursorProvider.analyzeRender(current)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(await cursorProvider.materializeRender(materializationInput(current, variant))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: targetPath(variant),
                            executable: false,
                            content: { text: BODY },
                        },
                    ],
                },
            ],
        });

        const rebased = nativeFixture(variant, "parent_rebase_seed", BODY, CHANGED_BODY);
        expect(await cursorProvider.analyzeRender(rebased)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(await cursorProvider.materializeRender(materializationInput(rebased, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: CHANGED_BODY } }] }],
        });
    });

    it.each(VARIANTS)("reverse-accepts body changes and conflicts on command semantics for %s", async (variant) => {
        const fixture = nativeFixture(variant, "current_exact", BODY, BODY);
        const materialization = materializationInput(fixture, variant);
        expect(
            await cursorProvider.inspectRenderedTarget(changedInspection(fixture, materialization, BODY, CHANGED_BODY)),
        ).toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [{ replacementContent: { contentKind: "text", text: CHANGED_BODY } }],
        });

        const changedArguments = CHANGED_BODY.replace("$1", "$2");
        expect(
            await cursorProvider.inspectRenderedTarget(changedInspection(fixture, materialization, BODY, changedArguments)),
        ).toMatchObject({ status: "complete", files: [{ attributionState: "conflict" }], changes: [] });
        const changedDescription = CHANGED_BODY.replace("# Release", "# Different title");
        expect(
            await cursorProvider.inspectRenderedTarget(changedInspection(fixture, materialization, BODY, changedDescription)),
        ).toMatchObject({ status: "complete", files: [{ attributionState: "conflict" }], changes: [] });
    });

    it.each(VARIANTS)("materializes reviewed same-family canonical command semantics for %s", async (variant) => {
        const fixture = canonicalFixture(variant);
        expect(await cursorProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            semanticOptions: expect.arrayContaining([expect.objectContaining({ outcome: "degraded" })]),
        });
        const canonicalMaterializationInput = materializationInput(fixture, variant);
        const materialized = await cursorProvider.materializeRender(canonicalMaterializationInput);
        assertCanonicalEntryControls(cursorProvider, canonicalMaterializationInput, materialized);
        expect(materialized).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        expect.objectContaining({
                            relativePath: defaultConvertedPath(variant),
                            content: { contentKind: "text", text: BODY },
                        }),
                    ],
                },
            ],
        });
    });

    it("composes project and personal Workflow variants without borrowing scope evidence", async () => {
        const project = nativeFixture("cliProject", "current_exact", BODY, BODY, 0);
        const global = nativeFixture("cliGlobal", "current_exact", BODY, BODY, 1);
        const mixed = combine(project, global);
        expect(await cursorProvider.analyzeRender(mixed)).toMatchObject({
            status: "complete",
            outputUnits: [expect.any(Object), expect.any(Object)],
            blockedSemanticRefs: [],
        });

        required(mixed.dialectInputs[1]).inputs = [];
        expect(await cursorProvider.analyzeRender(mixed)).toMatchObject({
            status: "partial",
            outputUnits: [expect.any(Object)],
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "cursor_workflow_native_variant_unavailable" }),
            ]),
        });
    });

    it("rejects duplicate semantic identities across independently valid scope variants", async () => {
        const project = nativeFixture("cliProject", "current_exact", BODY, BODY, 0);
        const global = nativeFixture("cliGlobal", "current_exact", BODY, BODY, 1);
        global.requiredSemantics.forEach((semantic, index) => {
            semantic.semanticRefFingerprint = required(project.requiredSemantics[index]).semanticRefFingerprint;
        });
        expect(await analyzeCursorWorkflowTargets(combine(project, global), CLI_SUPPORTS)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            diagnostics: [{ code: "cursor_workflow_variant_closure_invalid" }],
        });
    });

    it("keeps the CLI loader surface flat and Markdown-only", () => {
        const cliNested = nativeFixture("cliProject", "current_exact", BODY, BODY);
        required(firstNative(cliNested).files[0]).relativePath = ".cursor/commands/team/release.md" as never;
        expect(supportFor("cliProject").analyze(cliNested).status).toBe("failed");
        const cliText = nativeFixture("cliProject", "current_exact", BODY, BODY);
        required(firstNative(cliText).files[0]).relativePath = ".cursor/commands/release.txt" as never;
        expect(supportFor("cliProject").analyze(cliText).status).toBe("failed");
    });

    it("fails closed for malformed graphs, restoration inputs, and non-portable behavior", async () => {
        const unsafe = nativeFixture("cliProject", "current_exact", BODY, BODY);
        required(firstNative(unsafe).files[0]).relativePath = ".cursor/commands/../escape.md" as never;
        expect(supportFor("cliProject").analyze(unsafe).status).toBe("failed");

        const extra = nativeFixture("cliProject", "current_exact", BODY, BODY);
        firstNative(extra).files.push(structuredClone(required(firstNative(extra).files[0])));
        expect(supportFor("cliProject").analyze(extra).status).toBe("failed");

        const executable = nativeFixture("cliGlobal", "current_exact", BODY, BODY);
        required(firstNative(executable).files[0]).executable = true;
        expect(supportFor("cliGlobal").analyze(executable).status).toBe("failed");

        const restoration = nativeFixture("cliGlobal", "parent_rebase_seed", BODY, CHANGED_BODY);
        required(restoration.dialectInputs[0]).inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supportFor("cliGlobal").analyze(restoration).status).toBe("failed");

        const nonPortable = canonicalFixture("cliProject");
        const canonical = required(nonPortable.deployment.assets[0]).version.canonical;
        if (canonical.kind !== "Workflow" || canonical.typeData.implementation.kind !== "instructions") {
            throw new Error("Cursor Workflow canonical fixture missing");
        }
        canonical.typeData.implementation.toolPolicy.preapproved.push({
            dialectId: "foreign-tool-selector-v1",
            selector: "Write",
        });
        expect(supportFor("cliProject").analyze(nonPortable).status).toBe("failed");
    });

    it("blocks parent rebase when canonical metadata or graph shape no longer matches the preserved command", () => {
        const changedMetadata = nativeFixture("cliProject", "parent_rebase_seed", BODY, CHANGED_BODY);
        const changedCanonical = required(changedMetadata.deployment.assets[0]).version.canonical;
        if (changedCanonical.kind !== "Workflow") throw new Error("Cursor Workflow canonical fixture missing");
        changedCanonical.typeData.description = "A different command description";
        expect(supportFor("cliProject").analyze(changedMetadata).status).toBe("failed");

        const extraResource = nativeFixture("cliProject", "parent_rebase_seed", BODY, CHANGED_BODY);
        required(extraResource.deployment.assets[0]).version.files.push({
            contentKind: "text",
            text: "resource",
            file: {
                fileId: "99999999-9999-4999-8999-999999999999",
                logicalPath: "RESOURCE.md",
                role: "resource",
                contentHash: sha256Text("resource"),
                contentKind: "text",
                mediaType: "text/markdown",
                byteSize: 8,
                executable: false,
                references: [],
            },
        });
        expect(supportFor("cliProject").analyze(extraResource).status).toBe("failed");
    });

    it("warns for a newer compatible build without lending the exact anchor label", async () => {
        const fixture = nativeFixture("cliProject", "current_exact", BODY, BODY);
        const context = required(fixture.deployment.targetContexts[0]);
        context.versionText = "2026.08.01-next";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await cursorProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "cursor_target_build_compatible_unverified", severity: "warning" })],
        });
    });

    it("fails one-Version/two-native closure and rejects binary reverse content", async () => {
        const duplicate = nativeFixture("cliProject", "current_exact", BODY, BODY);
        required(duplicate.dialectInputs[0]).inputs.push(nativeInput("cliProject", CHANGED_BODY, "current_exact"));
        expect(await cursorProvider.analyzeRender(duplicate)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
        });

        const fixture = nativeFixture("cliGlobal", "current_exact", BODY, BODY);
        const materialization = materializationInput(fixture, "cliGlobal");
        const inspection = changedInspection(fixture, materialization, BODY, BODY);
        required(inspection.files[0]).currentContent = { contentKind: "binary", bytes: Uint8Array.of(0xff) };
        expect(await cursorProvider.inspectRenderedTarget(inspection)).toMatchObject({
            status: "complete",
            files: [{ attributionState: "conflict" }],
            changes: [],
        });
    });
});

function supportFor(variant: RuntimeVariant) {
    return (variant.startsWith("app") ? APP_SUPPORTS : CLI_SUPPORTS)[scopeOf(variant)];
}

function nativeFixture(
    variant: RuntimeVariant,
    inputRole: "current_exact" | "parent_rebase_seed",
    nativeContent: string,
    canonicalContent: string,
    identity = 0,
): RenderAnalysisInput {
    const fixture = baseFixture(variant, versionId(identity), canonicalContent, identity);
    const native = nativeInput(variant, nativeContent, inputRole);
    fixture.dialectInputs = [
        {
            targetVersion: { assetId: assetId(identity), versionId: versionId(identity) },
            consumerAgentRuntimeIds: [runtimeId(variant)],
            inputs: [
                inputRole === "current_exact"
                    ? native
                    : {
                          ...native,
                          inputRole: "parent_rebase_seed",
                          sourceVersion: { assetId: assetId(identity), versionId: PARENT_VERSION_ID },
                      },
            ],
        },
    ];
    return fixture;
}

function canonicalFixture(variant: RuntimeVariant): RenderAnalysisInput {
    const fixture = baseFixture(variant, versionId(0), BODY, 0, oppositeDialect(variant));
    const declaration = supportFor(variant).renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Cursor Workflow canonical materialization declaration missing");
    fixture.dialectInputs = [
        {
            targetVersion: { assetId: assetId(0), versionId: versionId(0) },
            consumerAgentRuntimeIds: [runtimeId(variant)],
            inputs: [
                {
                    inputKind: "canonical_materialization",
                    nativeDialectId: dialectId(variant),
                    materializer: declaration.materializer,
                    degradationKinds: [...declaration.degradationKinds],
                    reasonCode: declaration.reasonCode,
                },
            ],
        },
    ];
    return fixture;
}

function baseFixture(
    variant: RuntimeVariant,
    currentVersionId: string,
    content: string,
    identity: number,
    canonicalDialect = dialectId(variant),
): RenderAnalysisInput {
    const support = supportFor(variant);
    const build = required(support.renderContractDeclaration.verifiedBuilds[0]);
    const scope = scopeOf(variant);
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: build.platform,
            platformInstanceId: `test-${build.platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: runtimeId(variant),
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" },
                        scope === "project"
                            ? { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" }
                            : { key: "oaam.target-kind", value: "global", evidenceLevel: "agent_runtime_verified" },
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
                        ref: { assetId: assetId(identity), versionId: currentVersionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: workflowCanonical(variant, content, canonicalDialect),
                        files: [canonicalFile(content, identity)],
                    },
                    sectionHandles: { [fileId(identity)]: `workflow-entry-${identity}` },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", variant, identity, "asset"),
            semantic("workflow.activation", variant, identity, "asset"),
            semantic("workflow.content", variant, identity, "file"),
        ],
        dialectInputs: [],
    };
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

function materializationInput(fixture: RenderAnalysisInput, variant: RuntimeVariant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete") {
        throw new Error(`Cursor Workflow analysis did not close: ${JSON.stringify(analysis.diagnostics)}`);
    }
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = required(contract.materializationProfiles[0]);
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
                rendererAdapterId: "CURSOR",
                rendererAdapterVersion: cursorProvider.version,
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
    const unit = required(materialization.selection.outputUnits[0]);
    const relativePath = required(unit.claims[0]?.relativePath);
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
                consumerOwnerAdapterId: "CURSOR",
                consumerOwnerAdapterVersion: cursorProvider.version,
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

function nativeInput(variant: RuntimeVariant, text: string, inputRole: "current_exact" | "parent_rebase_seed") {
    const file = nativeFile(variant, text);
    const { text: _text, ...descriptor } = file;
    return {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: dialectId(variant),
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [descriptor],
        },
        files: [file],
    };
}

function nativeFile(variant: RuntimeVariant, text: string) {
    const relativePath = targetPath(variant);
    return {
        relativePath: relativePath as never,
        contentKind: "text" as const,
        mediaType: relativePath.endsWith(".txt") ? "text/plain" : "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function workflowCanonical(
    variant: RuntimeVariant,
    content: string,
    canonicalDialect: string,
): Extract<AssetKindTypeDataV2, { kind: "Workflow" }> {
    const sourceRuntime = canonicalDialect === CURSOR_NATIVE_DIALECTS.appCommandWorkflow ? "CURSOR_APP" : "CURSOR_AGENT_CLI";
    const name = commandName(variant);
    const parsed = parseCursorCommand(
        { agentRuntimeId: sourceRuntime, layout: scopeOf(variant) === "global" ? "config" : "project" },
        {
            relativePath: scopeOf(variant) === "global" ? `commands/${name}.md` : `.cursor/commands/${name}.md`,
            text: content,
        },
    );
    return { kind: "Workflow", typeData: parsed.typeData };
}

function canonicalFile(text: string, identity: number): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId: fileId(identity),
            logicalPath: "WORKFLOW.md",
            role: "entry",
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: inferCanonicalMediaType("WORKFLOW.md", "text"),
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function targetPath(variant: RuntimeVariant): string {
    return {
        cliProject: ".cursor/commands/oaam-phase58-cli-workflow.md",
        cliGlobal: "commands/oaam-phase58-cli-workflow.md",
        appProject: ".cursor/commands/oaam-app-workflow.md",
        appGlobal: "commands/oaam-phase59-app-global-workflow.md",
    }[variant];
}

function defaultConvertedPath(variant: RuntimeVariant): string {
    const prefix = scopeOf(variant) === "project" ? ".cursor/commands" : "commands";
    return `${prefix}/${commandName(variant)}.md`;
}

function commandName(variant: RuntimeVariant): string {
    if (variant === "appProject") return "oaam-app-workflow";
    if (variant === "appGlobal") return "oaam-phase59-app-global-workflow";
    return "oaam-phase58-cli-workflow";
}

function dialectId(variant: RuntimeVariant): string {
    return variant.startsWith("app") ? CURSOR_NATIVE_DIALECTS.appCommandWorkflow : CURSOR_NATIVE_DIALECTS.agentCommandWorkflow;
}

function oppositeDialect(variant: RuntimeVariant): string {
    return variant.startsWith("app") ? CURSOR_NATIVE_DIALECTS.agentCommandWorkflow : CURSOR_NATIVE_DIALECTS.appCommandWorkflow;
}

function scopeOf(variant: RuntimeVariant): ScopeVariant {
    return variant.endsWith("Project") ? "project" : "global";
}

function firstNative(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("Cursor Workflow native input missing");
    return candidate;
}

function semantic(semanticKind: string, variant: RuntimeVariant, identity: number, subjectKind: "asset" | "file") {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${variant}:${identity}:${subjectKind}`),
        consumerAgentRuntimeId: runtimeId(variant),
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: assetId(identity), versionId: versionId(identity) }
                : {
                      subjectKind: "file" as const,
                      assetId: assetId(identity),
                      versionId: versionId(identity),
                      fileId: fileId(identity),
                  },
        semanticKind,
    } as RenderAnalysisInput["requiredSemantics"][number];
}

function runtimeId(variant: RuntimeVariant): "CURSOR_AGENT_CLI" | "CURSOR_APP" {
    return variant.startsWith("app") ? "CURSOR_APP" : "CURSOR_AGENT_CLI";
}

function assetId(identity: number): string {
    return `11111111-1111-4111-8111-${String(identity + 1).padStart(12, "0")}`;
}

function versionId(identity: number): string {
    return `22222222-2222-4222-8222-${String(identity + 1).padStart(12, "0")}`;
}

function fileId(identity: number): string {
    return `66666666-6666-4666-8666-${String(identity + 1).padStart(12, "0")}`;
}

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("Cursor Workflow fixture value missing");
    return value;
}
