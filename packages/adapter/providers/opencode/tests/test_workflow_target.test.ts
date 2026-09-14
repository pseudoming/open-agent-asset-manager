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
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import { appendOpencodeBuildCompatibilityWarning } from "../src/opencode-target-build-compatibility";
import {
    createOpencodeAppWorkflowTargetSupports,
    createOpencodeCliWorkflowTargetSupports,
    OPENCODE_WORKFLOW_TARGET_COMPONENTS,
    type OpencodeWorkflowTargetSupports,
} from "../src/opencode-target-workflow";

type Variant = keyof OpencodeWorkflowTargetSupports;

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const COMMAND_BODY = "Release $1 after reviewing $ARGUMENTS. OAAM_OPENCODE_COMMAND_ORIGINAL_9C42E1";
const CHANGED_COMMAND_BODY = COMMAND_BODY.replace("ORIGINAL", "REVERSED");

const supports = createOpencodeCliWorkflowTargetSupports({
    adapterVersion: opencodeProvider.version,
    agentRuntimes: opencodeProvider.agentRuntimes,
    projectTargetContextSchemaId: "OPENCODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
    globalTargetContextSchemaId: "OPENCODE_CLI_GLOBAL_WORKFLOW_TARGET_V1",
});
const appSupports = createOpencodeAppWorkflowTargetSupports({
    adapterVersion: opencodeProvider.version,
    agentRuntimes: opencodeProvider.agentRuntimes,
    projectTargetContextSchemaId: "OPENCODE_APP_PROJECT_GUIDANCE_TARGET_V1",
    globalTargetContextSchemaId: "OPENCODE_APP_GLOBAL_WORKFLOW_TARGET_V1",
});

const VARIANTS: readonly Variant[] = ["project", "global"];

describe("OpenCode CLI exact Workflow targets", () => {
    it("explains an instruction Workflow's unsupported model invocation without changing its semantics", async () => {
        const fixture = canonicalFixture("project");
        const canonical = fixture.deployment.assets[0]!.version.canonical;
        if (canonical.kind !== "Workflow") throw new Error("Workflow fixture missing");
        canonical.typeData.invocation.agentInvocable = true;
        const before = structuredClone(canonical);
        const result = await opencodeProvider.analyzeRender(fixture);
        expect(result).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: expect.arrayContaining([
                expect.objectContaining({ reasonCode: "opencode_workflow_model_invocation_unsupported" }),
            ]),
            diagnostics: [
                expect.objectContaining({
                    code: "opencode_workflow_model_invocation_unsupported",
                    causeKind: "unsupported",
                    retryable: false,
                }),
            ],
        });
        expect(result.blockedSemanticRefs).toHaveLength(fixture.requiredSemantics.length);
        expect(
            result.blockedSemanticRefs.every((item) => item.reasonCode === "opencode_workflow_model_invocation_unsupported"),
        ).toBe(true);
        expect(canonical).toEqual(before);
        canonical.typeData.invocation.agentInvocable = false;
        const ordinary = await opencodeProvider.analyzeRender(fixture);
        expect(ordinary.diagnostics.some((item) => item.code === "opencode_workflow_model_invocation_unsupported")).toBe(false);
    });

    it("registers project/global CLI and App cells against independent exact platform fixtures", () => {
        for (const [runtimeSupports, agentRuntimeId, buildIdentity, expectedPlatforms] of [
            [supports, "OPENCODE_CLI", CURRENT_BUILD_IDENTITY, ["wsl", "win32"]],
            [appSupports, "OPENCODE_APP", APP_BUILD_IDENTITY, ["wsl"]],
        ] as const) {
            for (const variant of VARIANTS) {
                const declaration = runtimeSupports[variant].renderContractDeclaration;
                expect(declaration).toMatchObject({
                    agentRuntimeId,
                    assetKind: "Workflow",
                });
                expect(declaration.verifiedBuilds[0]).toMatchObject({ platform: "wsl", versionText: "1.18.15" });
                expect(declaration.verifiedBuilds.map((build) => build.platform)).toEqual(expectedPlatforms);
                expect(declaration.verifiedBuilds[0]?.buildIdentity).toBe(buildIdentity);
                if (agentRuntimeId === "OPENCODE_CLI") {
                    expect(declaration.verifiedBuilds[1]).toMatchObject({
                        platform: "win32",
                        buildIdentity: "sha256:fd254474def7ee35f07416cf4674c361f07e7bcd9c7ffb284af21bb011066ee3",
                    });
                }
            }
        }
        expect(supports.project.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_graph_v1",
            nativeDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
            projectGraphValidator: OPENCODE_WORKFLOW_TARGET_COMPONENTS.project,
            rebaseMaterializer: OPENCODE_WORKFLOW_TARGET_COMPONENTS.rebase,
        });
        expect(supports.global.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            nativeDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
            globalGraphValidator: OPENCODE_WORKFLOW_TARGET_COMPONENTS.global,
            rebaseMaterializer: OPENCODE_WORKFLOW_TARGET_COMPONENTS.rebase,
        });
    });

    it("routes the independent App consumer only with an exact App context", async () => {
        const fixture = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        const context = required(fixture.deployment.targetContexts[0], "Workflow target context is missing");
        const build = required(appSupports.project.renderContractDeclaration.verifiedBuilds[0], "App build is missing");
        context.agentRuntimeId = "OPENCODE_APP";
        context.versionText = build.versionText;
        context.buildIdentity = build.buildIdentity;
        context.targetContextSchemaId = appSupports.project.targetContextSchema.targetContextSchemaId;
        context.targetContextSchemaFingerprint = appSupports.project.targetContextSchema.schemaFingerprint;
        for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "OPENCODE_APP";
        for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["OPENCODE_APP"];
        expect(await opencodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            outputUnits: [expect.objectContaining({ outputContractId: "OPENCODE_APP_NATIVE_PROJECT_WORKFLOW_MARKDOWN_V1" })],
            blockedSemanticRefs: [],
        });
    });

    it.each(VARIANTS)("restores current bytes and rebases an immediate parent for %s", async (variant) => {
        const currentText = nativeText(variant, canonicalBody(variant));
        const current = nativeFixture(variant, "current_exact", currentText, canonicalBody(variant));
        const analysis = await opencodeProvider.analyzeRender(current);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialized = await opencodeProvider.materializeRender(materializationInput(current, variant));
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
        expect(await opencodeProvider.analyzeRender(rebased)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(await opencodeProvider.materializeRender(materializationInput(rebased, variant))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: targetPath(variant),
                            executable: false,
                            content: { text: `${nativePrefix()}${changed}` },
                        },
                    ],
                },
            ],
        });
    });

    it.each(VARIANTS)("reverse-accepts content changes but rejects private metadata drift for %s", async (variant) => {
        const applied = nativeText(variant, canonicalBody(variant));
        const current = nativeText(variant, changedCanonicalBody(variant));
        const fixture = nativeFixture(variant, "current_exact", applied, canonicalBody(variant));
        const materialization = materializationInput(fixture, variant);
        expect(
            await opencodeProvider.inspectRenderedTarget(changedInspection(fixture, materialization, applied, current)),
        ).toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [{ replacementContent: { contentKind: "text", text: `${changedCanonicalBody(variant)}\n` } }],
        });

        const drifted = current.replace("model: openai/gpt-5", "model: future/model");
        expect(
            await opencodeProvider.inspectRenderedTarget(changedInspection(fixture, materialization, applied, drifted)),
        ).toMatchObject({
            status: "complete",
            files: [{ attributionState: "conflict" }],
            changes: [],
        });
    });

    it("composes project/global commands without borrowing scope evidence", async () => {
        const project = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        const global = nativeFixture("global", "current_exact", nativeText("global", COMMAND_BODY), COMMAND_BODY, 1);
        const mixed = combine(project, global);
        expect(await opencodeProvider.analyzeRender(mixed)).toMatchObject({
            status: "complete",
            outputUnits: [expect.any(Object), expect.any(Object)],
            blockedSemanticRefs: [],
        });

        mixed.dialectInputs[1] = { ...required(mixed.dialectInputs[1], "global command dialect input is missing"), inputs: [] };
        expect(await opencodeProvider.analyzeRender(mixed)).toMatchObject({
            status: "partial",
            outputUnits: [expect.any(Object)],
            diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "opencode_workflow_native_variant_unavailable" }),
            ]),
        });
    });

    it("warns for a comparable newer App and blocks malformed native graphs", async () => {
        const fixture = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        const context = required(fixture.deployment.targetContexts[0], "Workflow target context is missing");
        context.versionText = "1.18.16";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await opencodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred", severity: "warning" })],
        });

        const unsafe = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        const native = firstNative(unsafe);
        required(native.files[0], "Workflow native file is missing").relativePath = ".opencode/commands/../escape.md";
        expect(supports.project.analyze(unsafe).status).toBe("failed");

        const extra = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        const commandNative = firstNative(extra);
        commandNative.files.push(structuredClone(required(commandNative.files[0], "command native file is missing")));
        expect(supports.project.analyze(extra).status).toBe("failed");

        const executable = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        required(firstNative(executable).files[0], "Workflow native file is missing").executable = true;
        expect(supports.project.analyze(executable).status).toBe("failed");

        const restoration = nativeFixture("global", "current_exact", nativeText("global", COMMAND_BODY), COMMAND_BODY);
        required(restoration.dialectInputs[0], "Workflow dialect group is missing").inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.global.analyze(restoration).status).toBe("failed");
    });

    it.each([
        ["project", ".opencode/command/team/release.md"],
        ["global", "commands/team/release.md"],
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
        ["project", ".opencode/workflows/not-a-command.md"],
        ["global", "commands/not-markdown.txt"],
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

    it("materializes a reviewed portable canonical command and blocks behavior-changing reverse input", async () => {
        const canonicalOnly = canonicalFixture("project");
        expect(await opencodeProvider.analyzeRender(canonicalOnly)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            semanticOptions: expect.arrayContaining([expect.objectContaining({ outcome: "degraded" })]),
        });
        const request = materializationInput(canonicalOnly, "project");
        const result = await opencodeProvider.materializeRender(request);
        assertCanonicalEntryControls(opencodeProvider, request, result);
        expect(result).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        expect.objectContaining({
                            relativePath: ".opencode/commands/oaam-phase57-workflow.md",
                            content: expect.objectContaining({ contentKind: "text" }),
                        }),
                    ],
                },
            ],
        });

        const fixture = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        const materialization = materializationInput(fixture, "project");
        const changedArguments = nativeText("project", COMMAND_BODY.replace("$1", "$2"));
        expect(
            await opencodeProvider.inspectRenderedTarget(
                changedInspection(fixture, materialization, nativeText("project", COMMAND_BODY), changedArguments),
            ),
        ).toMatchObject({ files: [{ attributionState: "conflict" }], changes: [] });
    });

    it("fails closed for non-portable canonical behavior and malformed private frontmatter", () => {
        const nonPortable = canonicalFixture("project");
        const canonical = required(nonPortable.deployment.assets[0], "Workflow asset is missing").version.canonical;
        if (canonical.kind !== "Workflow" || canonical.typeData.implementation.kind !== "instructions") {
            throw new Error("Workflow canonical fixture is missing");
        }
        canonical.typeData.implementation.toolPolicy.preapproved.push({
            dialectId: "foreign-tool-selector-v1",
            selector: "Write",
        });
        expect(supports.project.analyze(nonPortable).status).toBe("failed");

        const malformed = nativeFixture(
            "project",
            "current_exact",
            ["---", "unknown-private-key: true", "---", "Run the release."].join("\n"),
            "Run the release.",
        );
        expect(supports.project.analyze(malformed).status).toBe("failed");

        const restoration = nativeFixture(
            "project",
            "parent_rebase_seed",
            nativeText("project", COMMAND_BODY),
            CHANGED_COMMAND_BODY,
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
        expect(supports.project.analyze(restoration).status).toBe("failed");

        const extraCanonicalFile = nativeFixture(
            "project",
            "parent_rebase_seed",
            nativeText("project", COMMAND_BODY),
            CHANGED_COMMAND_BODY,
        );
        const asset = required(extraCanonicalFile.deployment.assets[0], "Workflow asset is missing");
        const resource = structuredClone(required(asset.version.files[0], "Workflow entry is missing"));
        resource.file.fileId = "77777777-7777-4777-8777-777777777777";
        resource.file.logicalPath = "REFERENCE.md";
        resource.file.role = "resource";
        asset.version.files.push(resource);
        expect(supports.project.analyze(extraCanonicalFile).status).toBe("failed");
    });

    it("fails the closure when one Version claims two native command representations", async () => {
        const fixture = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
        required(fixture.dialectInputs[0], "Workflow dialect group is missing").inputs.push(
            nativeInput("project", nativeText("project", CHANGED_COMMAND_BODY), "current_exact"),
        );
        expect(await opencodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            diagnostics: expect.any(Array),
        });
    });

    it("blocks parent rebase when canonical metadata no longer matches the preserved command prefix", () => {
        const fixture = nativeFixture("project", "parent_rebase_seed", nativeText("project", COMMAND_BODY), CHANGED_COMMAND_BODY);
        const canonical = required(fixture.deployment.assets[0], "Workflow asset is missing").version.canonical;
        if (canonical.kind !== "Workflow") throw new Error("Workflow canonical fixture is missing");
        canonical.typeData.description = "A description that the preserved native prefix does not contain.";
        expect(supports.project.analyze(fixture).status).toBe("failed");
    });

    it("keeps build-warning projection inert without one valid OpenCode target context", () => {
        const fixture = nativeFixture("project", "current_exact", nativeText("project", COMMAND_BODY), COMMAND_BODY);
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
            appendOpencodeBuildCompatibilityWarning(baseline, withoutContext, supports.project.renderContractDeclaration),
        ).toBe(baseline);

        const invalidPlatform = structuredClone(fixture);
        required(invalidPlatform.deployment.targetContexts[0], "target context is missing").renderFacts[0] = {
            key: "oaam.platform",
            value: "future-platform",
            evidenceLevel: "agent_runtime_verified",
        };
        expect(
            appendOpencodeBuildCompatibilityWarning(baseline, invalidPlatform, supports.project.renderContractDeclaration),
        ).toBe(baseline);
    });

    it.each(VARIANTS)("rejects binary reverse content for %s", async (variant) => {
        const applied = nativeText(variant, canonicalBody(variant));
        const fixture = nativeFixture(variant, "current_exact", applied, canonicalBody(variant));
        const inspection = changedInspection(fixture, materializationInput(fixture, variant), applied, applied);
        const changed = required(inspection.files[0], "inspection file is missing");
        changed.currentContent = { contentKind: "binary", bytes: Uint8Array.of(0xff) };
        expect(await opencodeProvider.inspectRenderedTarget(inspection)).toMatchObject({
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
            consumerAgentRuntimeIds: ["OPENCODE_CLI"],
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

function canonicalFixture(variant: Variant): RenderAnalysisInput {
    const fixture = baseFixture(variant, versionId(0), COMMAND_BODY, 0);
    const declaration = supports[variant].renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Workflow canonical materialization is missing");
    fixture.dialectInputs = [
        {
            targetVersion: { assetId: assetId(0), versionId: versionId(0) },
            consumerAgentRuntimeIds: ["OPENCODE_CLI"],
            inputs: [
                {
                    inputKind: "canonical_materialization",
                    nativeDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
                    materializer: declaration.materializer,
                    degradationKinds: [...declaration.degradationKinds],
                    reasonCode: declaration.reasonCode,
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
                    agentRuntimeId: "OPENCODE_CLI",
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
                instructionDialectId: OPENCODE_NATIVE_DIALECTS.commandWorkflow,
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: {
                        mode: "selected",
                        dialectId: "opencode-model-selector-v1",
                        selector: "openai/gpt-5",
                        relativeTier: -1,
                    },
                    effort: { mode: "inherit" },
                    shell: { mode: "none" },
                },
                toolPolicy: {
                    preapproved: [],
                    denied: [],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            invocation: {
                commandNames: [commandName(variant)],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
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
    return `${nativePrefix()}${canonical.trim()}\n`;
}

function nativePrefix(): string {
    return ["---", "description: Release the selected target.", "model: openai/gpt-5", "---", ""].join("\n");
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
        project: ".opencode/commands/oaam-phase57-workflow.md",
        global: "commands/oaam-phase57-global-workflow.md",
    }[variant];
}

function commandName(variant: Variant): string {
    return variant === "project" ? "oaam-phase57-workflow" : "oaam-phase57-global-workflow";
}

function dialectId(variant: Variant): string {
    void variant;
    return OPENCODE_NATIVE_DIALECTS.commandWorkflow;
}

function isProject(variant: Variant): boolean {
    return variant === "project";
}

function firstNative(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("Workflow native input is missing");
    return candidate;
}

function semantic(semanticKind: string, identity: number, subjectKind: "asset" | "file") {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${identity}:${subjectKind}`),
        consumerAgentRuntimeId: "OPENCODE_CLI" as const,
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

const CURRENT_BUILD_IDENTITY = "sha256:c1971d3d4d42abe8e15b2e320ecc1acbdb8377914d4e2cfa47c9bce2316caa7d";
const APP_BUILD_IDENTITY = "sha256:c5fe1808131d04a1fba13ec237fbf675bb4951dcaa669a48da58cb20b3396c6f";
