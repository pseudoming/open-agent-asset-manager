import * as crypto from "node:crypto";
import type { RenderAnalysisInput, RenderedTargetInspectionInput, RenderMaterializationInput, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { cursorProvider } from "../src/cursor-provider";
import { validateCursorNativeDialect } from "../src/cursor-source-read";
import { CURSOR_RULE_TARGET_COMPONENTS, createCursorRuleTargetSupport } from "../src/cursor-target-rule";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const BUILD = "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831";
const APP_BUILD = "sha256:98c0fc2885636738e986e01af8f9c5229dad4b2d7510bc489c9ffc0924da4904";
const APP_WIN32_BUILD = "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const NATIVE_PATH = ".cursor/rules/oaam-phase58-rule.mdc";
const APP_NATIVE_PATH = ".cursor/rules/oaam-app-rule.mdc";
const BODY = "Reply with exactly OAAM_PHASE58_CURSOR_RULE_8B3D71.\n";
const CHANGED_BODY = BODY.replace("8B3D71", "A7B8C9");
const HEADER = "---\ndescription: OAAM exact Rule fixture\nglobs: **/*.ts\nalwaysApply: false\n---\n";
const NATIVE_TEXT = `${HEADER}${BODY}`;
const CHANGED_NATIVE_TEXT = `${HEADER}${CHANGED_BODY}`;
const canonical = {
    kind: "Rule" as const,
    typeData: {
        schemaVersion: 2 as const,
        name: "oaam-phase58-rule",
        description: "OAAM exact Rule fixture",
        activation: { mode: "path" as const, globs: ["**/*.ts"] },
    },
};
const schema = cursorProvider.targetContextSchemas.find(
    (row) => row.targetContextSchemaId === "CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
);
if (schema === undefined) throw new Error("Cursor project target schema missing");
const support = createCursorRuleTargetSupport({
    adapterVersion: cursorProvider.version,
    agentRuntimes: cursorProvider.agentRuntimes,
    targetContextSchemaId: schema.targetContextSchemaId,
});

describe("Cursor exact `.mdc` Rule target", () => {
    it("restores current bytes and rebases only the canonical body", () => {
        const current = analysisFixture("current_exact");
        expect(support.analyze(current)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(support.materialize(materializationInput(current))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: NATIVE_TEXT } }] }],
        });

        const parent = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        expect(support.analyze(parent)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(support.materialize(materializationInput(parent))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: CHANGED_NATIVE_TEXT } }] }],
        });
        expect(validateNative(CHANGED_BODY, CHANGED_NATIVE_TEXT)).toBe(true);
    });

    it("accepts body-only reverse and conflicts on selector/frontmatter mutation", () => {
        const materialization = materializationInput(analysisFixture("current_exact"));
        expect(support.inspect(inspectionInput(materialization, NATIVE_TEXT, CHANGED_NATIVE_TEXT))).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_BODY } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        for (const changed of [
            CHANGED_NATIVE_TEXT.replace("**/*.ts", "**/*.js"),
            CHANGED_NATIVE_TEXT.replace("alwaysApply: false", "alwaysApply: true"),
            CHANGED_NATIVE_TEXT.replace("description: OAAM exact Rule fixture", "description: changed"),
        ]) {
            expect(support.inspect(inspectionInput(materialization, NATIVE_TEXT, changed))).toMatchObject({
                status: "complete",
                changes: [],
                files: [{ attributionState: "conflict" }],
            });
        }
    });

    it("blocks foreign canonical creation, malformed native bytes, unsafe paths, and foreign restoration", () => {
        const foreign = analysisFixture("current_exact");
        foreign.dialectInputs = [];
        expect(support.analyze(foreign)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "cursor_project_rule_native_parent_required" }],
        });

        const malformed = analysisFixture("current_exact");
        const malformedNative = malformed.dialectInputs[0]?.inputs[0];
        if (malformedNative?.inputKind !== "native_representation" || malformedNative.files[0]?.contentKind !== "text") {
            throw new Error("Cursor malformed fixture missing");
        }
        malformedNative.files[0].text = "---\nalwaysApply: nope\n---\nbody\n";
        expect(support.analyze(malformed).status).toBe("failed");

        for (const unsafe of ["../escape.mdc", ".cursor\\rules\\escape.mdc", ".cursor/rules/.mdc"]) {
            const fixture = analysisFixture("current_exact");
            const native = fixture.dialectInputs[0]?.inputs[0];
            if (native?.inputKind !== "native_representation" || native.files[0] === undefined) throw new Error("native missing");
            native.files[0].relativePath = unsafe;
            expect(support.analyze(fixture).status).toBe("failed");
        }

        const restoration = analysisFixture("current_exact");
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: { dialectId: "foreign-v1", restorationContractFingerprint: HASH, contentHash: HASH },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(support.analyze(restoration).status).toBe("failed");

        const blockedMaterializationInput = materializationInput(analysisFixture("current_exact"));
        blockedMaterializationInput.dialectInputs = [];
        expect(support.materialize(blockedMaterializationInput)).toMatchObject({
            status: "failed",
            materializationState: "blocked",
            reasonCode: "cursor_project_rule_native_parent_required",
        });

        const validMaterialization = materializationInput(analysisFixture("current_exact"));
        const blockedInspectionInput = inspectionInput(validMaterialization, NATIVE_TEXT, CHANGED_NATIVE_TEXT);
        const inspectionFile = blockedInspectionInput.files[0];
        if (inspectionFile === undefined) throw new Error("Cursor inspection fixture missing");
        inspectionFile.fileState = "added_managed_descendant";
        expect(support.inspect(blockedInspectionInput)).toMatchObject({
            status: "failed",
            changes: [],
            files: [],
            diagnostics: [{ code: "cursor_project_rule_native_parent_required" }],
        });
    });

    it("dispatches through the Provider and warns without relabelling a newer compatible build exact", async () => {
        const fixture = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        const context = fixture.deployment.targetContexts[0];
        if (context === undefined) throw new Error("target context missing");
        context.versionText = "2026.08.01-next";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await cursorProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            diagnostics: [{ code: "cursor_target_build_compatible_unverified", severity: "warning" }],
        });

        const exact = analysisFixture("parent_rebase_seed", CHANGED_BODY);
        const materialization = materializationInput(exact);
        await expect(cursorProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ content: { text: CHANGED_NATIVE_TEXT } }] }],
        });
        await expect(
            cursorProvider.inspectRenderedTarget(inspectionInput(materialization, CHANGED_NATIVE_TEXT, NATIVE_TEXT)),
        ).resolves.toMatchObject({ status: "complete" });
    });

    it("dispatches the independently anchored Linux App Rule without borrowing the CLI cell", async () => {
        const fixture = analysisFixture("current_exact");
        fixture.deployment.platform = "linux";
        fixture.deployment.platformInstanceId = "linux:cursor-app";
        const context = fixture.deployment.targetContexts[0];
        if (context === undefined) throw new Error("target context missing");
        const appDeclaration = cursorProvider.renderContractDeclarations.find(
            (row) =>
                row.declarationKind === "native_project_exact_file_v1" &&
                row.agentRuntimeId === "CURSOR_APP" &&
                row.assetKind === "Rule",
        );
        if (appDeclaration === undefined || appDeclaration.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("Cursor App Rule declaration missing");
        }
        const appSchema = cursorProvider.targetContextSchemas.find(
            (row) => row.targetContextSchemaId === appDeclaration.target.targetContextSchemaId,
        );
        if (appSchema === undefined) throw new Error("Cursor App target schema missing");
        Object.assign(context, {
            agentRuntimeId: "CURSOR_APP",
            versionText: "3.13.25",
            buildIdentity: APP_BUILD,
            targetContextSchemaId: appSchema.targetContextSchemaId,
            targetContextSchemaFingerprint: appSchema.schemaFingerprint,
        });
        context.renderFacts[0] = { key: "oaam.platform", value: "linux", evidenceLevel: "agent_runtime_verified" };
        for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "CURSOR_APP";
        for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["CURSOR_APP"];
        const native = fixture.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation" || native.files[0] === undefined) {
            throw new Error("Cursor App Rule native fixture missing");
        }
        native.files[0].relativePath = APP_NATIVE_PATH;
        await expect(cursorProvider.analyzeRender(fixture)).resolves.toMatchObject({ status: "complete", diagnostics: [] });
    });

    it("dispatches the independently anchored Win32 App Rule without borrowing Linux evidence", async () => {
        const fixture = analysisFixture("current_exact");
        fixture.deployment.platform = "win32";
        fixture.deployment.platformInstanceId = "win32:cursor-app";
        const context = fixture.deployment.targetContexts[0];
        if (context === undefined) throw new Error("target context missing");
        const appDeclaration = cursorProvider.renderContractDeclarations.find(
            (row) =>
                row.declarationKind === "native_project_exact_file_v1" &&
                row.agentRuntimeId === "CURSOR_APP" &&
                row.assetKind === "Rule",
        );
        if (appDeclaration === undefined || appDeclaration.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("Cursor App Rule declaration missing");
        }
        const appSchema = cursorProvider.targetContextSchemas.find(
            (row) => row.targetContextSchemaId === appDeclaration.target.targetContextSchemaId,
        );
        if (appSchema === undefined) throw new Error("Cursor App target schema missing");
        Object.assign(context, {
            agentRuntimeId: "CURSOR_APP",
            versionText: "3.12.30",
            buildIdentity: APP_WIN32_BUILD,
            targetContextSchemaId: appSchema.targetContextSchemaId,
            targetContextSchemaFingerprint: appSchema.schemaFingerprint,
        });
        context.renderFacts[0] = { key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" };
        for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "CURSOR_APP";
        for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["CURSOR_APP"];
        const native = fixture.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation" || native.files[0] === undefined) {
            throw new Error("Cursor App Rule native fixture missing");
        }
        native.files[0].relativePath = APP_NATIVE_PATH;
        await expect(cursorProvider.analyzeRender(fixture)).resolves.toMatchObject({ status: "complete", diagnostics: [] });
    });

    it("binds dialect rebase and exact build identity", () => {
        expect(
            cursorProvider.dialectContracts.native.find((row) => row.definition.dialectId === "cursor-rule-mdc-v1")?.definition
                .rebaseMaterializer,
        ).toEqual(CURSOR_RULE_TARGET_COMPONENTS.rebase);
        expect(support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_file_v1",
            agentRuntimeId: "CURSOR_AGENT_CLI",
            buildCompatibility: { unknownVersionPolicy: "allow_with_warning" },
            verifiedBuilds: [{ versionText: "2026.07.23-e383d2b", buildIdentity: BUILD, platform: "wsl" }],
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
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    versionText: "2026.07.23-e383d2b",
                    buildIdentity: BUILD,
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
                        files: [textFile("RULE.md", entryText)],
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
            dialectId: "cursor-rule-mdc-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [file],
    };
    return {
        targetVersion: { assetId: ASSET_ID, versionId: targetVersionId },
        consumerAgentRuntimeIds: ["CURSOR_AGENT_CLI"],
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

function materializationInput(analysisInput: RenderAnalysisInput): RenderMaterializationInput {
    const analysis = support.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("Cursor Rule analysis fixture did not close");
    const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Cursor target profile missing");
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
                outcome: "preserved" as const,
            })),
        },
    };
}

function inspectionInput(
    materialization: RenderMaterializationInput,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Cursor output unit missing");
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
                consumerOwnerAdapterId: "CURSOR",
                consumerOwnerAdapterVersion: cursorProvider.version,
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
                relativePath: NATIVE_PATH,
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

function validateNative(entryText: string, nativeText: string): boolean {
    const descriptor = nativeFile(NATIVE_PATH, nativeText);
    const { text: _text, ...file } = descriptor;
    return validateCursorNativeDialect({
        canonical,
        canonicalFiles: [textFile("RULE.md", entryText)],
        representation: {
            schemaVersion: 1,
            dialectId: "cursor-rule-mdc-v1",
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
        consumerAgentRuntimeId: "CURSOR_AGENT_CLI",
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
            fileId: FILE_ID,
            logicalPath,
            role: "entry" as const,
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
