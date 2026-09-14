import * as crypto from "node:crypto";
import type { RenderAnalysisInput, RenderedTargetInspectionInput, RenderMaterializationInput, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { antigravityProvider } from "../src/antigravity-provider";
import { validateAntigravityNativeDialect } from "../src/antigravity-source-read";
import {
    ANTIGRAVITY_RULE_TARGET_COMPONENTS,
    createAntigravityAppRuleTargetSupport,
    createAntigravityIdeRuleTargetSupport,
    createAntigravityRuleTargetSupport,
} from "../src/antigravity-target-exact-rule";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const CURRENT_BUILD_HASH = "sha256:4217db798fd514cedce4e315013daea471a1a67666ab91547b2ad0dbee167a71";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const NATIVE_PATH = ".agents/rules/oaam-phase55-rule.md";
const ENTRY_PATH = "RULE.md";
const BODY = "Reply with exactly `OAAM_AGY_RULE_112_8C4E91` and no other text.\n";
const CHANGED_BODY = BODY.replace("8C4E91", "A7B8C9");
const HEADER = ["---", "trigger: always_on", "---", ""].join("\n");
const NATIVE_TEXT = `${HEADER}${BODY}`;
const CHANGED_NATIVE_TEXT = `${HEADER}${CHANGED_BODY}`;
const canonical = {
    kind: "Rule" as const,
    typeData: {
        schemaVersion: 2 as const,
        name: "oaam-phase55-rule",
        description: "",
        activation: { mode: "always" as const },
    },
};
const targetContextSchemaId = antigravityProvider.targetContextSchemas[0]?.targetContextSchemaId;
if (targetContextSchemaId === undefined) throw new Error("Antigravity target context schema is missing");
const support = createAntigravityRuleTargetSupport({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    targetContextSchemaId,
});
const ideSchema = antigravityProvider.targetContextSchemas.find(
    (row) => row.targetContextSchemaId === "ANTIGRAVITY_IDE_PROJECT_TARGET_V1",
);
if (ideSchema === undefined) throw new Error("Antigravity IDE project target schema is missing");
const ideSupport = createAntigravityIdeRuleTargetSupport({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    targetContextSchemaId: ideSchema.targetContextSchemaId,
});
const appSchema = antigravityProvider.targetContextSchemas.find(
    (row) => row.targetContextSchemaId === "ANTIGRAVITY_APP_PROJECT_TARGET_V1",
);
if (appSchema === undefined) throw new Error("Antigravity App project target schema is missing");
const appSupport = createAntigravityAppRuleTargetSupport({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    targetContextSchemaId: appSchema.targetContextSchemaId,
});

describe("Antigravity CLI exact always-on Rule target", () => {
    it("keeps the exact anchor label while warning on an accepted newer current build", async () => {
        const fixture = analysisFixture("current_exact");
        const context = fixture.deployment.targetContexts[0];
        if (context === undefined) throw new Error("Antigravity fixture target context is missing");
        context.versionText = "1.1.10";
        context.buildIdentity = CURRENT_BUILD_HASH;
        expect(await antigravityProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            diagnostics: [
                {
                    severity: "warning",
                    code: "antigravity_target_build_compatibility_inferred",
                    causeKind: "partial",
                },
            ],
        });
        expect(support.renderContractDeclaration).toMatchObject({
            buildCompatibility: {
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
            verifiedBuilds: [{ versionText: "1.1.2" }],
        });
    });

    it("dispatches parent rebase, materialization, and reverse through the frozen Provider facade", async () => {
        const fixture = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        const analysis = await antigravityProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });

        const materialization = materializationInput(fixture);
        expect(await antigravityProvider.materializeRender(materialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: CHANGED_NATIVE_TEXT } }] }],
        });
        expect(
            await antigravityProvider.inspectRenderedTarget(
                inspectionInput(materialization, CHANGED_NATIVE_TEXT, CHANGED_NATIVE_TEXT.replace("A7B8C9", "D1E2F3")),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { text: CHANGED_BODY.replace("A7B8C9", "D1E2F3") },
                },
            ],
        });
    });

    it("dispatches the exact IDE build through current, parent-rebase, materialization, and reverse", async () => {
        const fixture = ideFixture("parent_rebase_seed", CHANGED_BODY);
        expect(await antigravityProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = materializationInput(fixture, ideSupport);
        expect(await antigravityProvider.materializeRender(materialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: CHANGED_NATIVE_TEXT } }] }],
        });
        expect(
            await antigravityProvider.inspectRenderedTarget(
                inspectionInput(materialization, CHANGED_NATIVE_TEXT, CHANGED_NATIVE_TEXT.replace("A7B8C9", "D1E2F3")),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { text: CHANGED_BODY.replace("A7B8C9", "D1E2F3") },
                },
            ],
        });
        expect(ideSupport.renderContractDeclaration.verifiedBuilds).toEqual([
            expect.objectContaining({ platform: "wsl", versionText: "1.107.0" }),
            expect.objectContaining({ platform: "win32", versionText: "1.107.0" }),
        ]);
    });

    it("dispatches the exact App Rule through parent rebase, materialization, and reverse", async () => {
        const fixture = appFixture("parent_rebase_seed", CHANGED_BODY);
        expect(await antigravityProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = materializationInput(fixture, appSupport);
        await expect(antigravityProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: CHANGED_NATIVE_TEXT } }] }],
        });
        await expect(
            antigravityProvider.inspectRenderedTarget(
                inspectionInput(materialization, CHANGED_NATIVE_TEXT, CHANGED_NATIVE_TEXT.replace("A7B8C9", "D1E2F3")),
            ),
        ).resolves.toMatchObject({ status: "complete", files: [{ attributionState: "uniquely_attributable" }] });
    });

    it("restores exact native bytes and validates the complete Rule dialect", () => {
        const fixture = analysisFixture("current_exact");
        expect(support.materialize(materializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: NATIVE_TEXT } }] }],
        });
        expect(validateNative(BODY, NATIVE_TEXT)).toBe(true);
    });

    it("rebases only a canonical body while preserving the native Rule wrapper byte-for-byte", () => {
        const fixture = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        expect(support.analyze(fixture)).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(support.materialize(materializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { text: CHANGED_NATIVE_TEXT } }] }],
        });
        expect(validateNative(CHANGED_BODY, CHANGED_NATIVE_TEXT)).toBe(true);
    });

    it("accepts body-only reverse and rejects trigger or unsupported metadata changes", () => {
        const fixture = analysisFixture("current_exact");
        const materialization = materializationInput(fixture);
        expect(support.inspect(inspectionInput(materialization, NATIVE_TEXT, CHANGED_NATIVE_TEXT))).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_BODY } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        for (const changed of [
            CHANGED_NATIVE_TEXT.replace("trigger: always_on", "trigger: manual"),
            CHANGED_NATIVE_TEXT.replace("trigger: always_on", "trigger: always_on\nname: changed"),
            CHANGED_NATIVE_TEXT.replace("trigger: always_on", "trigger: always_on\ndescription: changed"),
        ]) {
            expect(support.inspect(inspectionInput(materialization, NATIVE_TEXT, changed))).toMatchObject({
                status: "complete",
                changes: [],
                files: [{ attributionState: "conflict", reasonCode: "native_project_exact_file_change_not_reconcilable" }],
            });
        }
    });

    it("blocks unrepresentable canonical behavior, extra files, foreign restoration, and unsafe paths", () => {
        const description = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        const descriptionCanonical = description.deployment.assets[0]?.version.canonical;
        if (descriptionCanonical?.kind !== "Rule") throw new Error("Rule fixture canonical is missing");
        descriptionCanonical.typeData.description = "Changed outside Antigravity";
        expect(support.analyze(description).status).toBe("failed");

        const unsupportedNativeMetadata = analysisFixture("current_exact");
        const unsupportedNative = unsupportedNativeMetadata.dialectInputs[0]?.inputs[0];
        if (unsupportedNative?.inputKind !== "native_representation" || unsupportedNative.files[0]?.contentKind !== "text") {
            throw new Error("Rule native fixture is missing");
        }
        unsupportedNative.files[0].text = unsupportedNative.files[0].text.replace(
            "trigger: always_on",
            "trigger: always_on\nname: unverified",
        );
        expect(support.analyze(unsupportedNativeMetadata)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "antigravity_project_rule_exact_file_blocked" }],
        });
        const unsupportedMaterialization = materializationInput(analysisFixture("current_exact"));
        const unsupportedMaterializationNative = unsupportedMaterialization.dialectInputs[0]?.inputs[0];
        if (
            unsupportedMaterializationNative?.inputKind !== "native_representation" ||
            unsupportedMaterializationNative.files[0]?.contentKind !== "text"
        ) {
            throw new Error("Rule native materialization fixture is missing");
        }
        unsupportedMaterializationNative.files[0].text = unsupportedNative.files[0].text;
        expect(support.materialize(unsupportedMaterialization)).toMatchObject({
            status: "failed",
            materializationState: "blocked",
            diagnostics: [{ code: "antigravity_project_rule_exact_file_blocked" }],
        });
        const unsupportedNativeText = unsupportedNative.files[0].text;
        expect(
            support.inspect(
                inspectionInput(
                    materializationInput(analysisFixture("current_exact")),
                    unsupportedNativeText,
                    unsupportedNativeText.replace("8C4E91", "A7B8C9"),
                ),
            ),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "antigravity_project_rule_exact_file_blocked" }],
        });

        const trigger = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        const triggerCanonical = trigger.deployment.assets[0]?.version.canonical;
        if (triggerCanonical?.kind !== "Rule") throw new Error("Rule fixture canonical is missing");
        triggerCanonical.typeData.activation = { mode: "manual" };
        expect(support.analyze(trigger).status).toBe("failed");

        const multiFile = analysisFixture("current_exact");
        multiFile.deployment.assets[0]?.version.files.push(textFile("resource.md", "resource\n"));
        expect(support.analyze(multiFile).status).toBe("failed");

        const restoration = analysisFixture("current_exact");
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-runtime-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(support.analyze(restoration).status).toBe("failed");

        for (const unsafe of [".agent/rules/legacy.md", "../escape.md", ".agents\\rules\\escape.md", ".agents/rules/.md"]) {
            const pathFixture = analysisFixture("current_exact");
            const native = pathFixture.dialectInputs[0]?.inputs[0];
            if (native?.inputKind !== "native_representation" || native.files[0] === undefined) {
                throw new Error("Rule native fixture is missing");
            }
            native.files[0].relativePath = unsafe;
            expect(support.analyze(pathFixture).status).toBe("failed");
        }
    });

    it("binds the Rule dialect rebase identity to the verified render declaration", () => {
        const dialect = antigravityProvider.dialectContracts.native.find(
            (row) => row.definition.kind === "Rule" && row.definition.dialectId === "antigravity-rule-markdown-v1",
        );
        expect(dialect?.definition.rebaseMaterializer).toEqual(ANTIGRAVITY_RULE_TARGET_COMPONENTS.rebase);
        expect(support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_file_v1",
            agentRuntimeId: "ANTIGRAVITY_CLI",
            assetKind: "Rule",
            rebaseMaterializer: ANTIGRAVITY_RULE_TARGET_COMPONENTS.rebase,
            verifiedBuilds: [
                expect.objectContaining({
                    versionText: "1.1.2",
                    buildIdentity: "sha256:70bf6eaf2e82fbb243db999b9c7c61fcf7f6e537f41980650eb2341ed84b24de",
                    platform: "wsl",
                }),
            ],
        });
    });
});

function analysisFixture(inputRole: "current_exact" | "parent_rebase_seed", entryText = BODY): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
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
                    versionText: "1.1.2",
                    buildIdentity: "sha256:70bf6eaf2e82fbb243db999b9c7c61fcf7f6e537f41980650eb2341ed84b24de",
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" },
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: structuredClone(canonical),
                        files: [textFile(ENTRY_PATH, entryText)],
                    },
                    sectionHandles: { [FILE_ID]: "rule-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", versionId, "asset", "1"),
            semantic("rule.activation", versionId, "asset", "2"),
            semantic("rule.content", versionId, "file", "3"),
        ],
        dialectInputs: [nativeDialectInput(versionId, inputRole)],
    };
}

function ideFixture(inputRole: "current_exact" | "parent_rebase_seed", entryText = BODY): RenderAnalysisInput {
    const fixture = analysisFixture(inputRole, entryText);
    const context = fixture.deployment.targetContexts[0];
    if (context === undefined) throw new Error("Antigravity IDE target context fixture is missing");
    context.agentRuntimeId = "ANTIGRAVITY_IDE";
    context.versionText = "1.107.0";
    context.buildIdentity = "sha256:56987be1a655ae5903bc47963a67e147d8ee3c36e41144b03210cc9c3e57336f";
    context.targetContextSchemaId = ideSupport.targetContextSchema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = ideSupport.targetContextSchema.schemaFingerprint;
    for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "ANTIGRAVITY_IDE";
    for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["ANTIGRAVITY_IDE"];
    return fixture;
}

function appFixture(inputRole: "current_exact" | "parent_rebase_seed", entryText = BODY): RenderAnalysisInput {
    const fixture = analysisFixture(inputRole, entryText);
    const context = fixture.deployment.targetContexts[0];
    if (context === undefined) throw new Error("Antigravity App target context fixture is missing");
    context.agentRuntimeId = "ANTIGRAVITY_APP";
    context.versionText = "2.2.1";
    context.buildIdentity = "sha256:b0d127772d2983a93771055a93b673d5fdd1726d6e47db8e269b204e665972d6";
    context.targetContextSchemaId = appSupport.targetContextSchema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = appSupport.targetContextSchema.schemaFingerprint;
    for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "ANTIGRAVITY_APP";
    for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["ANTIGRAVITY_APP"];
    return fixture;
}

function nativeDialectInput(
    targetVersionId: string,
    inputRole: "current_exact" | "parent_rebase_seed",
): RenderAnalysisInput["dialectInputs"][number] {
    const file = nativeFile(NATIVE_PATH, NATIVE_TEXT);
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: "antigravity-rule-markdown-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [file],
    };
    return {
        targetVersion: { assetId: ASSET_ID, versionId: targetVersionId },
        consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"],
        inputs: [
            inputRole === "current_exact"
                ? common
                : {
                      ...common,
                      inputRole: "parent_rebase_seed" as const,
                      sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                  },
        ],
    };
}

function materializationInput(
    analysisInput: RenderAnalysisInput,
    targetSupport: typeof support = support,
): RenderMaterializationInput {
    const analysis = targetSupport.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("Rule analysis fixture did not close");
    const contract = makeNativeProjectExactFileContractParts(targetSupport.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Rule exact target profile is missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: structuredClone(analysisInput.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "ANTIGRAVITY",
                rendererAdapterVersion: antigravityProvider.version,
                materializerCapabilityKey: targetSupport.materializerCapability.materializerCapabilityKey,
                materializationProfileId: targetSupport.renderContractDeclaration.materializationProfileId,
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

function inspectionInput(
    materialization: RenderMaterializationInput,
    appliedNativeText: string,
    currentNativeText: string,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Rule materialization output unit is missing");
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
            decisions: materialization.requiredSemantics.map((item) => ({
                semanticRef: item,
                consumerOwnerAdapterId: "ANTIGRAVITY",
                consumerOwnerAdapterVersion: antigravityProvider.version,
                optionFingerprint: HASH,
                renderStrategy: "native_file",
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
                    relativePath: NATIVE_PATH,
                    state: "changed",
                    appliedContentHash: sha256Text(appliedNativeText),
                    currentContentHash: sha256Text(currentNativeText),
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
                relativePath: NATIVE_PATH,
                appliedContent: { contentKind: "text", text: appliedNativeText },
                currentContent: { contentKind: "text", text: currentNativeText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(appliedNativeText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentNativeText),
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

function validateNative(entryText: string, nativeText: string): boolean {
    const descriptor = nativeFile(NATIVE_PATH, nativeText);
    const { text: _text, ...file } = descriptor;
    return validateAntigravityNativeDialect({
        canonical,
        canonicalFiles: [textFile(ENTRY_PATH, entryText)],
        representation: {
            schemaVersion: 1,
            dialectId: "antigravity-rule-markdown-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: NATIVE_PATH, bytes: new TextEncoder().encode(nativeText) }],
    });
}

function semantic(kind: string, versionId: string, subjectKind: "asset" | "file", digit: string) {
    return {
        semanticRefFingerprint: `sha256:${digit.repeat(64)}`,
        consumerAgentRuntimeId: "ANTIGRAVITY_CLI",
        subject:
            subjectKind === "file"
                ? { subjectKind, assetId: ASSET_ID, versionId, fileId: FILE_ID }
                : { subjectKind, assetId: ASSET_ID, versionId },
        semanticKind: kind,
    } as RenderAnalysisInput["requiredSemantics"][number];
}

function nativeFile(relativePath: string, text: string) {
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function textFile(logicalPath: string, text: string) {
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: logicalPath === ENTRY_PATH ? FILE_ID : "88888888-8888-4888-8888-888888888888",
            logicalPath,
            role: logicalPath === ENTRY_PATH ? ("entry" as const) : ("resource" as const),
            contentHash: sha256Text(text),
            contentKind: "text" as const,
            mediaType: "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}
