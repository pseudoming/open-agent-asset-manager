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
import { zcodeProvider } from "../src/zcode-provider";
import { ZCODE_NATIVE_DIALECTS } from "../src/zcode-source-read-model";
import {
    createZcodeWorkflowTargetSupports,
    ZCODE_WORKFLOW_TARGET_COMPONENTS,
    type ZcodeWorkflowTargetSupports,
} from "../src/zcode-target-workflow";
import { appendZcodeBuildCompatibilityWarning } from "../src/zcode-target-build-compatibility";

type Variant = keyof ZcodeWorkflowTargetSupports;

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const COMMAND_BODY = "Release $1 after reviewing $ARGUMENTS. OAAM_ZCODE_COMMAND_ORIGINAL_9C42E1";
const CHANGED_COMMAND_BODY = COMMAND_BODY.replace("ORIGINAL", "REVERSED");

const supports = createZcodeWorkflowTargetSupports({
    adapterVersion: zcodeProvider.version,
    agentRuntimes: zcodeProvider.agentRuntimes,
    projectTargetContextSchemaId: "ZCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
    globalTargetContextSchemaId: "ZCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
});

const VARIANTS: readonly Variant[] = ["projectCommand", "globalCommand"];

describe("ZCode App exact Workflow targets", () => {
    it("explains an instruction Workflow's unsupported model invocation without changing its semantics", async () => {
        const fixture = baseFixture("projectCommand", versionId(0), COMMAND_BODY, 0);
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Workflow") throw new Error("Workflow fixture missing");
        canonical.typeData.invocation.agentInvocable = true;
        const before = structuredClone(canonical);
        const result = await zcodeProvider.analyzeRender(fixture);
        expect(result).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: expect.arrayContaining([
                expect.objectContaining({ reasonCode: "zcode_workflow_model_invocation_unsupported" }),
            ]),
            diagnostics: [
                expect.objectContaining({
                    code: "zcode_workflow_model_invocation_unsupported",
                    causeKind: "unsupported",
                    retryable: false,
                }),
            ],
        });
        expect(result.blockedSemanticRefs).toHaveLength(fixture.requiredSemantics.length);
        expect(
            result.blockedSemanticRefs.every((item) => item.reasonCode === "zcode_workflow_model_invocation_unsupported"),
        ).toBe(true);
        expect(canonical).toEqual(before);
        canonical.typeData.invocation.agentInvocable = false;
        const ordinary = await zcodeProvider.analyzeRender(fixture);
        expect(ordinary.diagnostics.some((item) => item.code === "zcode_workflow_model_invocation_unsupported")).toBe(false);
    });

    it("registers project/global command variants against separate Win32 and WSL exact fixtures", () => {
        for (const variant of VARIANTS) {
            const declaration = supports[variant].renderContractDeclaration;
            expect(declaration).toMatchObject({
                agentRuntimeId: "ZCODE_APP",
                assetKind: "Workflow",
                verifiedBuilds: [
                    expect.objectContaining({ platform: "wsl", versionText: "3.5.3" }),
                    expect.objectContaining({ platform: "win32", versionText: "3.5.3" }),
                    expect.objectContaining({
                        platform: "wsl",
                        versionText: "3.1.8",
                        buildIdentity: "sha256:aaab9c07d95e1d6f2d2961db21195c4b48cfaaa159a78b15c0b04f91f8fe0d73",
                    }),
                ],
            });
            expect(declaration.verifiedBuilds.slice(0, 2).every((build) => build.buildIdentity === CURRENT_BUILD_IDENTITY)).toBe(
                true,
            );
        }
        expect(supports.projectCommand.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_graph_v1",
            nativeDialectId: ZCODE_NATIVE_DIALECTS.commandWorkflow,
            projectGraphValidator: ZCODE_WORKFLOW_TARGET_COMPONENTS.projectCommand,
            rebaseMaterializer: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandRebase,
        });
        expect(supports.globalCommand.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            nativeDialectId: ZCODE_NATIVE_DIALECTS.commandWorkflow,
            globalGraphValidator: ZCODE_WORKFLOW_TARGET_COMPONENTS.globalCommand,
            rebaseMaterializer: ZCODE_WORKFLOW_TARGET_COMPONENTS.commandRebase,
        });
    });

    it.each(VARIANTS)("restores current bytes and rebases an immediate parent for %s", async (variant) => {
        const currentText = nativeText(variant, canonicalBody(variant));
        const current = nativeFixture(variant, "current_exact", currentText, canonicalBody(variant));
        const analysis = await zcodeProvider.analyzeRender(current);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialized = await zcodeProvider.materializeRender(materializationInput(current, variant));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: targetPath(variant),
                            executable: false,
                            content: { text: currentText },
                        },
                    ],
                },
            ],
        });

        const changed = changedCanonicalBody(variant);
        const rebased = nativeFixture(variant, "parent_rebase_seed", currentText, changed);
        expect(await zcodeProvider.analyzeRender(rebased)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(await zcodeProvider.materializeRender(materializationInput(rebased, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: targetPath(variant),
                            executable: false,
                            content: { text: nativeText(variant, changed) },
                        },
                    ],
                },
            ],
        });
    });

    it.each(VARIANTS)("composes the 3.1.8 exact consumer floor with %s target and reverse", async (variant) => {
        const applied = nativeText(variant, canonicalBody(variant));
        const fixture = nativeFixture(variant, "current_exact", applied, canonicalBody(variant));
        bindExactBuild(fixture, variant, "3.1.8");
        expect(await zcodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = materializationInput(fixture, variant);
        await expect(zcodeProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        await expect(
            zcodeProvider.inspectRenderedTarget(
                changedInspection(fixture, materialization, applied, nativeText(variant, changedCanonicalBody(variant))),
            ),
        ).resolves.toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [{ replacementContent: { text: changedCanonicalBody(variant) } }],
        });
    });

    it.each(VARIANTS)("reverse-accepts content changes but rejects private metadata drift for %s", async (variant) => {
        const applied = nativeText(variant, canonicalBody(variant));
        const current = nativeText(variant, changedCanonicalBody(variant));
        const fixture = nativeFixture(variant, "current_exact", applied, canonicalBody(variant));
        const materialization = materializationInput(fixture, variant);
        expect(
            await zcodeProvider.inspectRenderedTarget(changedInspection(fixture, materialization, applied, current)),
        ).toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [{ replacementContent: { contentKind: "text", text: changedCanonicalBody(variant) } }],
        });

        const drifted = current.replace("model: glm-5", "model: future-model");
        expect(
            await zcodeProvider.inspectRenderedTarget(changedInspection(fixture, materialization, applied, drifted)),
        ).toMatchObject({
            status: "complete",
            files: [{ attributionState: "conflict" }],
            changes: [],
        });
    });

    it("composes project/global commands without borrowing scope evidence", async () => {
        const projectCommand = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        const globalCommand = nativeFixture(
            "globalCommand",
            "current_exact",
            nativeText("globalCommand", COMMAND_BODY),
            COMMAND_BODY,
            1,
        );
        const mixed = combine(projectCommand, globalCommand);
        expect(await zcodeProvider.analyzeRender(mixed)).toMatchObject({
            status: "complete",
            outputUnits: [expect.any(Object), expect.any(Object)],
            blockedSemanticRefs: [],
        });

        mixed.dialectInputs[1] = { ...required(mixed.dialectInputs[1], "global command dialect input is missing"), inputs: [] };
        expect(await zcodeProvider.analyzeRender(mixed)).toMatchObject({
            status: "partial",
            outputUnits: [expect.any(Object)],
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: "zcode_workflow_native_variant_unavailable" })]),
        });
    });

    it("warns for a comparable newer App and blocks malformed native graphs", async () => {
        const fixture = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        const context = required(fixture.deployment.targetContexts[0], "Workflow target context is missing");
        context.versionText = "3.5.4";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await zcodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "zcode_target_build_compatibility_inferred", severity: "warning" })],
        });

        const unsafe = nativeFixture("projectCommand", "current_exact", nativeText("projectCommand", COMMAND_BODY), COMMAND_BODY);
        const native = firstNative(unsafe);
        required(native.files[0], "Workflow native file is missing").relativePath = ".zcode/commands/../escape.md";
        expect(supports.projectCommand.analyze(unsafe).status).toBe("failed");

        const extra = nativeFixture("projectCommand", "current_exact", nativeText("projectCommand", COMMAND_BODY), COMMAND_BODY);
        const commandNative = firstNative(extra);
        commandNative.files.push(structuredClone(required(commandNative.files[0], "command native file is missing")));
        expect(supports.projectCommand.analyze(extra).status).toBe("failed");

        const executable = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        required(firstNative(executable).files[0], "Workflow native file is missing").executable = true;
        expect(supports.projectCommand.analyze(executable).status).toBe("failed");

        const restoration = nativeFixture(
            "globalCommand",
            "current_exact",
            nativeText("globalCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        required(restoration.dialectInputs[0], "Workflow dialect group is missing").inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.globalCommand.analyze(restoration).status).toBe("failed");
    });

    it.each([
        ["projectCommand", ".agents/commands/team/release.md"],
        ["globalCommand", "commands/team/release.md"],
    ] as const)("preserves a user-owned nested target path for %s", (variant, relativePath) => {
        const fixture = nativeFixture(
            variant,
            "current_exact",
            nativeText(variant, canonicalBody(variant)),
            canonicalBody(variant),
        );
        required(firstNative(fixture).files[0], "Workflow native file is missing").relativePath = relativePath;
        expect(supports[variant].analyze(fixture)).toMatchObject({ status: "complete", diagnostics: [] });
    });

    it.each([
        ["projectCommand", ".zcode/workflows/not-a-command.md"],
        ["globalCommand", "commands/not-markdown.txt"],
    ] as const)("rejects a path outside the exact %s loader surface", (variant, relativePath) => {
        const fixture = nativeFixture(
            variant,
            "current_exact",
            nativeText(variant, canonicalBody(variant)),
            canonicalBody(variant),
        );
        required(firstNative(fixture).files[0], "Workflow native file is missing").relativePath = relativePath;
        expect(supports[variant].analyze(fixture).status).toBe("failed");
    });

    it("blocks canonical-only and behavior-changing reverse input rather than erasing native semantics", async () => {
        const canonicalOnly = baseFixture("projectCommand", versionId(0), COMMAND_BODY, 0);
        expect(await zcodeProvider.analyzeRender(canonicalOnly)).toMatchObject({
            status: "failed",
            outputUnits: [],
            diagnostics: [expect.objectContaining({ code: "zcode_workflow_native_variant_unavailable" })],
        });

        const fixture = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        const materialization = materializationInput(fixture, "projectCommand");
        const changedArguments = nativeText("projectCommand", COMMAND_BODY.replace("$1", "$2"));
        expect(
            await zcodeProvider.inspectRenderedTarget(
                changedInspection(fixture, materialization, nativeText("projectCommand", COMMAND_BODY), changedArguments),
            ),
        ).toMatchObject({ files: [{ attributionState: "conflict" }], changes: [] });
    });

    it("blocks JavaScript Workflow against the exact App consumer while preserving the source dialect", async () => {
        const fixture = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        const native = firstNative(fixture);
        native.representation.dialectId = ZCODE_NATIVE_DIALECTS.scriptWorkflow;
        expect(await zcodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: expect.arrayContaining([
                expect.objectContaining({
                    reasonCode: "zcode_script_workflow_target_unsupported_current_app_consumer_absent",
                }),
            ]),
            diagnostics: [
                expect.objectContaining({
                    causeKind: "unsupported",
                    code: "zcode_script_workflow_target_unsupported_current_app_consumer_absent",
                    message: expect.stringMatching(
                        /App Command service loads only Markdown commands.*source import and exact native preservation remain available/u,
                    ),
                }),
            ],
        });
    });

    it("fails the closure when one Version claims two native command representations", async () => {
        const fixture = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        required(fixture.dialectInputs[0], "Workflow dialect group is missing").inputs.push(
            nativeInput("projectCommand", nativeText("projectCommand", CHANGED_COMMAND_BODY), "current_exact"),
        );
        expect(await zcodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            diagnostics: expect.any(Array),
        });
    });

    it("blocks parent rebase when canonical metadata no longer matches the preserved command prefix", () => {
        const fixture = nativeFixture(
            "projectCommand",
            "parent_rebase_seed",
            nativeText("projectCommand", COMMAND_BODY),
            CHANGED_COMMAND_BODY,
        );
        const canonical = required(fixture.deployment.assets[0], "Workflow asset is missing").version.canonical;
        if (canonical.kind !== "Workflow") throw new Error("Workflow canonical fixture is missing");
        canonical.typeData.description = "A description that the preserved native prefix does not contain.";
        expect(supports.projectCommand.analyze(fixture).status).toBe("failed");
    });

    it("keeps build-warning projection inert without one valid ZCode target context", () => {
        const fixture = nativeFixture(
            "projectCommand",
            "current_exact",
            nativeText("projectCommand", COMMAND_BODY),
            COMMAND_BODY,
        );
        const baseline = {
            status: "complete",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: [],
            diagnostics: [],
        } as const;
        const withoutContext = structuredClone(fixture);
        withoutContext.deployment.targetContexts = [];
        expect(
            appendZcodeBuildCompatibilityWarning(baseline, withoutContext, supports.projectCommand.renderContractDeclaration),
        ).toBe(baseline);

        const invalidPlatform = structuredClone(fixture);
        required(invalidPlatform.deployment.targetContexts[0], "target context is missing").renderFacts[0] = {
            key: "oaam.platform",
            value: "future-platform",
            evidenceLevel: "agent_runtime_verified",
        };
        expect(
            appendZcodeBuildCompatibilityWarning(baseline, invalidPlatform, supports.projectCommand.renderContractDeclaration),
        ).toBe(baseline);
    });

    it.each(VARIANTS)("rejects binary reverse content for %s", async (variant) => {
        const applied = nativeText(variant, canonicalBody(variant));
        const fixture = nativeFixture(variant, "current_exact", applied, canonicalBody(variant));
        const inspection = changedInspection(fixture, materializationInput(fixture, variant), applied, applied);
        const changed = required(inspection.files[0], "inspection file is missing");
        changed.currentContent = { contentKind: "binary", bytes: Uint8Array.of(0xff) };
        expect(await zcodeProvider.inspectRenderedTarget(inspection)).toMatchObject({
            status: "complete",
            files: [{ attributionState: "conflict" }],
            changes: [],
        });
    });
});

function nativeFixture(
    variant: Variant,
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
            consumerAgentRuntimeIds: ["ZCODE_APP"],
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

function baseFixture(variant: Variant, currentVersionId: string, content: string, identity: number): RenderAnalysisInput {
    const support = supports[variant];
    const build = required(
        support.renderContractDeclaration.verifiedBuilds.find((candidate) => candidate.platform === "wsl"),
        "Workflow verified build is missing",
    );
    const scope = isProject(variant) ? "project" : "global";
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: build.platform,
            platformInstanceId: "test-wsl",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "ZCODE_APP",
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" },
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
                        ref: { assetId: assetId(identity), versionId: currentVersionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: workflowCanonical(variant),
                        files: [canonicalFile(variant, content, identity)],
                    },
                    sectionHandles: { [fileId(identity)]: `workflow-entry-${identity}` },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", identity, "asset"),
            semantic("workflow.activation", identity, "asset"),
            semantic("workflow.content", identity, "file"),
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

function bindExactBuild(fixture: RenderAnalysisInput, variant: Variant, versionText: string): void {
    const build = required(
        supports[variant].renderContractDeclaration.verifiedBuilds.find(
            (candidate) => candidate.platform === "wsl" && candidate.versionText === versionText,
        ),
        `Workflow ${versionText} verified build is missing`,
    );
    const context = required(fixture.deployment.targetContexts[0], "Workflow target context is missing");
    context.versionText = build.versionText;
    context.buildIdentity = build.buildIdentity;
}

function materializationInput(fixture: RenderAnalysisInput, variant: Variant): RenderMaterializationInput {
    const support = supports[variant];
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete")
        throw new Error(`Workflow analysis did not close: ${JSON.stringify(analysis.diagnostics)}`);
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = required(contract.materializationProfiles[0], "Workflow materialization profile is missing");
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
                outcome: "preserved" as const,
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

function nativeInput(variant: Variant, text: string, inputRole: "current_exact" | "parent_rebase_seed") {
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

function nativeFile(variant: Variant, text: string) {
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

function workflowCanonical(variant: Variant): Extract<AssetKindTypeDataV2, { kind: "Workflow" }> {
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: commandName(variant),
            description: "Release the selected target.",
            implementation: {
                kind: "instructions",
                instructionDialectId: ZCODE_NATIVE_DIALECTS.commandWorkflow,
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "selected", dialectId: "zcode-model-selector-v1", selector: "glm-5", relativeTier: -1 },
                    effort: { mode: "inherit" },
                    shell: { mode: "none" },
                },
                toolPolicy: {
                    preapproved: [{ dialectId: "zcode-command-tool-selector-v1", selector: "Read" }],
                    denied: [],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            invocation: {
                commandNames: [commandName(variant)],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "<target>",
                argumentNames: ["1", "ARGUMENTS"],
            },
        },
    };
}

function canonicalFile(_variant: Variant, text: string, identity: number): AssetVersionFileContentV2 {
    const logicalPath = "WORKFLOW.md";
    return {
        contentKind: "text",
        text,
        file: {
            fileId: fileId(identity),
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

function nativeText(_variant: Variant, canonical: string): string {
    return [
        "---",
        "description: Release the selected target.",
        "allowed-tools: Read",
        "argument-hint: <target>",
        "model: glm-5",
        "---",
        "",
        canonical.trim(),
        "",
    ].join("\n");
}

function canonicalBody(variant: Variant): string {
    void variant;
    return COMMAND_BODY;
}

function changedCanonicalBody(variant: Variant): string {
    void variant;
    return CHANGED_COMMAND_BODY;
}

function targetPath(variant: Variant): string {
    return {
        projectCommand: ".zcode/commands/oaam-phase56-workflow.md",
        globalCommand: "commands/oaam-phase56-global-workflow.md",
    }[variant];
}

function commandName(variant: Variant): string {
    return variant === "projectCommand" ? "oaam-phase56-workflow" : "oaam-phase56-global-workflow";
}

function dialectId(variant: Variant): string {
    void variant;
    return ZCODE_NATIVE_DIALECTS.commandWorkflow;
}

function isProject(variant: Variant): boolean {
    return variant === "projectCommand";
}

function firstNative(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("Workflow native input is missing");
    return candidate;
}

function semantic(semanticKind: string, identity: number, subjectKind: "asset" | "file") {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${identity}:${subjectKind}`),
        consumerAgentRuntimeId: "ZCODE_APP" as const,
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

function required<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}

const CURRENT_BUILD_IDENTITY = "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a";
