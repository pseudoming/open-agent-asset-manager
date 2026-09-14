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
import { cursorProvider } from "../src/cursor-provider";
import { CURSOR_NATIVE_DIALECTS } from "../src/cursor-source-read-model";
import { validateCursorNativeDialect } from "../src/cursor-source-read-native";
import {
    CURSOR_SUBAGENT_MODEL_DIALECT,
    CURSOR_SUBAGENT_PERMISSION_DIALECT,
    CURSOR_SUBAGENT_TOOL_DIALECT,
} from "../src/cursor-subagent-markdown";
import {
    CURSOR_SUBAGENT_TARGET_COMPONENTS,
    createCursorAppSubagentTargetSupport,
    createCursorCliSubagentTargetSupport,
} from "../src/cursor-target-subagent";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const BUILD = "sha256:eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831";
const APP_LINUX_BUILD = "sha256:98c0fc2885636738e986e01af8f9c5229dad4b2d7510bc489c9ffc0924da4904";
const APP_WIN32_BUILD = "sha256:4defe15e408c98082ee766f761ec77f9504f74727f57446a135b87bb44a4254e";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const PATH = ".cursor/agents/oaam-phase58-subagent.md";
const ORIGINAL_BODY = "Return OAAM_CURSOR_SUBAGENT_CURRENT_7D31B9.\n";
const FOREIGN_BODY = "Return OAAM_CURSOR_SUBAGENT_REBASE_4A82E6.\n";
const REVERSE_BODY = "Return OAAM_CURSOR_SUBAGENT_REVERSE_9C51F2.\n";
const support = createCursorCliSubagentTargetSupport({
    adapterVersion: cursorProvider.version,
    agentRuntimes: cursorProvider.agentRuntimes,
    projectTargetContextSchemaId: "CURSOR_AGENT_CLI_PROJECT_TARGET_V1",
});
const appSupport = createCursorAppSubagentTargetSupport({
    adapterVersion: cursorProvider.version,
    agentRuntimes: cursorProvider.agentRuntimes,
    projectTargetContextSchemaId: "CURSOR_APP_PROJECT_TARGET_V1",
});

describe("Cursor Agent CLI exact project Subagent target", () => {
    it("registers one exact project contract and native rebase authority", () => {
        expect(cursorProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Subagent")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                entrySupportStatus: "supported",
                outputContractId: "CURSOR_AGENT_CLI_NATIVE_PROJECT_SUBAGENT_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CURSOR_APP",
                entrySupportStatus: "supported",
                outputContractId: "CURSOR_APP_NATIVE_PROJECT_SUBAGENT_V1",
            }),
        ]);
        expect(support.renderContractDeclaration).toMatchObject({
            agentRuntimeId: "CURSOR_AGENT_CLI",
            assetKind: "Subagent",
            nativeDialectId: CURSOR_NATIVE_DIALECTS.subagent,
            rebaseMaterializer: CURSOR_SUBAGENT_TARGET_COMPONENTS.rebase,
            verifiedBuilds: [{ versionText: "2026.07.23-e383d2b", buildIdentity: BUILD, platform: "wsl" }],
        });
        expect(appSupport.renderContractDeclaration.verifiedBuilds).toHaveLength(2);
        expect(appSupport.renderContractDeclaration.verifiedBuilds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    versionText: "3.13.25",
                    buildIdentity: APP_LINUX_BUILD,
                    platform: "linux",
                }),
                expect.objectContaining({
                    versionText: "3.12.30",
                    buildIdentity: APP_WIN32_BUILD,
                    platform: "win32",
                }),
            ]),
        );
    });

    it("restores exact native bytes and rebases portable fields while preserving comments", async () => {
        const current = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        expect(await cursorProvider.analyzeRender(current)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(await cursorProvider.materializeRender(materializationInput(current))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: PATH, content: { text: nativeText(false) } }] }],
        });

        const parent = nativeFixture("parent_rebase_seed", canonical(true), FOREIGN_BODY, nativeText(false));
        expect(await cursorProvider.analyzeRender(parent)).toMatchObject({ status: "complete", diagnostics: [] });
        const expected = nativeText(true);
        expect(await cursorProvider.materializeRender(materializationInput(parent))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: PATH, content: { text: expected } }] }],
        });
        expect(expected).toContain("# preserve Cursor Subagent layout");
        expect(validateNative(canonical(true), FOREIGN_BODY, PATH, expected)).toBe(true);
    });

    it("materializes reviewed same-family canonical behavior with an explicit degradation", () => {
        const input = canonicalFixture(canonical(false));
        expect(support.analyze(input)).toMatchObject({
            status: "complete",
            semanticOptions: expect.arrayContaining([expect.objectContaining({ outcome: "degraded" })]),
        });
        const request = materializationInput(input);
        const materialized = support.materialize(request);
        assertCanonicalEntryControls(cursorProvider, request, materialized);
        expect(materialized).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: expect.stringMatching(/^\.cursor\/agents\/oaam-subagent-/u),
                            content: { text: expect.stringContaining("OAAM_CURSOR_SUBAGENT_CURRENT_7D31B9") },
                        },
                    ],
                },
            ],
        });
        if (materialized.status !== "complete") throw new Error("Cursor canonical Subagent did not materialize");
        const file = required(materialized.materializedUnits[0]?.files[0]);
        if (file.content.contentKind !== "text") throw new Error("Cursor canonical Subagent did not produce text");
        expect(validateNative(canonical(false), ORIGINAL_BODY, file.relativePath, file.content.text)).toBe(true);
    });

    it("reverse-accepts only attributable body changes", async () => {
        const input = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        const materialization = materializationInput(input);
        const applied = nativeText(false);
        const current = applied.replace(ORIGINAL_BODY, REVERSE_BODY);
        expect(await cursorProvider.inspectRenderedTarget(inspectionInput(materialization, applied, current))).toMatchObject({
            status: "complete",
            changes: [{ replacementContent: { contentKind: "text", text: instruction(REVERSE_BODY) } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            await support.inspect(inspectionInput(materialization, applied, current.replace('model: "fast"', 'model: "slow"'))),
        ).toMatchObject({ status: "complete", changes: [], files: [{ attributionState: "conflict" }] });
        const binary = inspectionInput(materialization, applied, current);
        required(binary.files[0]).currentContent = { contentKind: "binary", bytes: Uint8Array.of(0xff) };
        expect(await cursorProvider.inspectRenderedTarget(binary)).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict" }],
        });
    });

    it("fails closed for wrong dialects, graph shape, unsafe paths and restoration input", () => {
        const wrong = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        firstNative(wrong).representation.dialectId = CURSOR_NATIVE_DIALECTS.skill;
        expect(support.analyze(wrong).status).toBe("failed");

        const extra = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        firstNative(extra).files.push({ ...required(firstNative(extra).files[0]), relativePath: ".cursor/agents/extra.md" });
        expect(support.analyze(extra).status).toBe("failed");

        for (const path of ["../escape.md", ".cursor\\agents\\escape.md", ".cursor/agents/not-agent.txt"]) {
            const invalid = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
            required(firstNative(invalid).files[0]).relativePath = path;
            expect(support.analyze(invalid).status).toBe("failed");
        }
        const executable = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        required(firstNative(executable).files[0]).executable = true;
        expect(support.analyze(executable).status).toBe("failed");

        const restoration = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: { dialectId: "foreign-v1", restorationContractFingerprint: HASH, contentHash: HASH },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(support.analyze(restoration).status).toBe("failed");
    });

    it("blocks unrepresentable canonical behavior and missing target authority", () => {
        for (const mutate of [
            (value: ReturnType<typeof canonical>) => {
                value.typeData.execution.model = {
                    mode: "selected",
                    dialectId: "foreign",
                    selector: "fast",
                    relativeTier: -1,
                };
            },
            (value: ReturnType<typeof canonical>) => {
                value.typeData.tools.permission.otherwise = "deny";
            },
            (value: ReturnType<typeof canonical>) => {
                value.typeData.presentation.listing = "hidden";
            },
        ]) {
            const value = canonical(false);
            mutate(value);
            expect(support.analyze(canonicalFixture(value)).status).toBe("failed");
        }
        const noAuthority = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        noAuthority.deployment.targetContexts = [];
        expect(support.analyze(noAuthority).status).toBe("failed");

        const invalidParent = nativeFixture("parent_rebase_seed", canonical(true), FOREIGN_BODY, nativeText(false));
        const invalidParentMaterialization = materializationInput(invalidParent);
        const targetCanonical = required(invalidParentMaterialization.deployment.assets[0]).version.canonical;
        if (targetCanonical.kind !== "Subagent") throw new Error("Cursor Subagent canonical fixture missing");
        targetCanonical.typeData.presentation.listing = "hidden";
        expect(support.materialize(invalidParentMaterialization)).toMatchObject({ status: "failed" });

        const invalidCanonical = canonicalFixture(canonical(false));
        const invalidCanonicalMaterialization = materializationInput(invalidCanonical);
        const canonicalAsset = required(invalidCanonicalMaterialization.deployment.assets[0]).version.canonical;
        if (canonicalAsset.kind !== "Subagent") throw new Error("Cursor Subagent canonical fixture missing");
        canonicalAsset.typeData.tools.permission.otherwise = "deny";
        expect(support.materialize(invalidCanonicalMaterialization)).toMatchObject({ status: "failed" });

        const executableParent = materializationInput(
            nativeFixture("parent_rebase_seed", canonical(true), FOREIGN_BODY, nativeText(false)),
        );
        required(required(executableParent.deployment.assets[0]).version.files[0]).file.executable = true;
        expect(support.materialize(executableParent)).toMatchObject({ status: "failed" });

        const globalCanonical = materializationInput(canonicalFixture(canonical(false)));
        Object.assign(required(globalCanonical.deployment.assets[0]), { scope: "global", projectId: undefined });
        expect(support.materialize(globalCanonical)).toMatchObject({ status: "failed" });
    });

    it("warns for a newer compatible build without relabelling it exact", async () => {
        const input = nativeFixture("current_exact", canonical(false), ORIGINAL_BODY, nativeText(false));
        const context = required(input.deployment.targetContexts[0]);
        context.versionText = "2026.08.01-next";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await cursorProvider.analyzeRender(input)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "cursor_target_build_compatible_unverified" })],
        });
    });
});

function nativeFixture(
    inputRole: "current_exact" | "parent_rebase_seed",
    canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    native: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: CURSOR_NATIVE_DIALECTS.subagent,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [nativeFile(PATH, native)],
    };
    return baseFixture(versionId, canonicalValue, body, [
        inputRole === "current_exact"
            ? common
            : {
                  ...common,
                  inputRole: "parent_rebase_seed" as const,
                  sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
              },
    ]);
}

function canonicalFixture(canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>): RenderAnalysisInput {
    const declaration = support.renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("Cursor Subagent canonical materializer missing");
    return baseFixture(VERSION_ID, canonicalValue, ORIGINAL_BODY, [
        {
            inputKind: "canonical_materialization",
            nativeDialectId: CURSOR_NATIVE_DIALECTS.subagent,
            materializer: declaration.materializer,
            degradationKinds: [...declaration.degradationKinds],
            reasonCode: declaration.reasonCode,
        },
    ]);
}

function baseFixture(
    versionId: string,
    canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    inputs: RenderAnalysisInput["dialectInputs"][number]["inputs"],
): RenderAnalysisInput {
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
                        canonical: structuredClone(canonicalValue),
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
            { targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: ["CURSOR_AGENT_CLI"], inputs },
        ],
    };
}

function materializationInput(input: RenderAnalysisInput): RenderMaterializationInput {
    const analysis = support.analyze(input);
    if (analysis.status !== "complete") throw new Error("Cursor Subagent analysis fixture did not close");
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

function inspectionInput(
    materialization: RenderMaterializationInput,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = required(materialization.selection.outputUnits[0]);
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
                    relativePath: PATH,
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
                relativePath: PATH,
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

function canonical(foreign: boolean): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: foreign ? "oaam-auditor" : "oaam-reviewer",
            description: foreign ? "Audit the isolated project" : "Review the isolated project",
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: {
                    base: {
                        mode: "allowlist",
                        allowed: foreign ? [runtimeTool("Bash")] : [runtimeTool("Read"), runtimeTool("Grep")],
                    },
                    unavailable: [],
                },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: foreign
                    ? { mode: "inherit" }
                    : {
                          mode: "selected",
                          dialectId: CURSOR_SUBAGENT_PERMISSION_DIALECT,
                          selector: "readonly",
                          effect: "read_only",
                      },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: foreign ? { mode: "always_background" } : { mode: "always_foreground" },
                turnLimit: { mode: "agent_runtime_default" },
                model: foreign
                    ? { mode: "inherit" }
                    : {
                          mode: "selected",
                          dialectId: CURSOR_SUBAGENT_MODEL_DIALECT,
                          selector: "fast",
                          relativeTier: -1,
                      },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: { listing: "visible", color: { mode: "agent_runtime_default" } },
        },
    };
}

function nativeText(foreign: boolean): string {
    return [
        "---",
        "# preserve Cursor Subagent layout",
        `name: ${JSON.stringify(foreign ? "oaam-auditor" : "oaam-reviewer")}`,
        `description: ${JSON.stringify(foreign ? "Audit the isolated project" : "Review the isolated project")}`,
        `tools: ${JSON.stringify(foreign ? "Bash" : "Read, Grep")}`,
        ...(foreign ? [] : ['model: "fast"', "readonly: true"]),
        `background: ${foreign ? "true" : "false"}`,
        "force-default-model: false",
        "---",
        foreign ? FOREIGN_BODY : ORIGINAL_BODY,
    ].join("\n");
}

function validateNative(
    canonicalValue: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    body: string,
    path: string,
    text: string,
): boolean {
    const descriptor = nativeFile(path, text);
    const { text: _text, ...file } = descriptor;
    return validateCursorNativeDialect({
        canonical: canonicalValue,
        canonicalFiles: [textFile(body)],
        representation: {
            schemaVersion: 1,
            dialectId: CURSOR_NATIVE_DIALECTS.subagent,
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

function nativeFile(path: string, text: string) {
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

function semantic(
    semanticKind: string,
    subjectKind: "asset" | "file",
    versionId: string,
): RenderAnalysisInput["requiredSemantics"][number] {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${versionId}`),
        consumerAgentRuntimeId: "CURSOR_AGENT_CLI",
        subject:
            subjectKind === "file"
                ? { subjectKind, assetId: ASSET_ID, versionId, fileId: FILE_ID }
                : { subjectKind, assetId: ASSET_ID, versionId },
        semanticKind,
    } as RenderAnalysisInput["requiredSemantics"][number];
}

function firstNative(input: RenderAnalysisInput) {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Cursor Subagent native fixture missing");
    return native;
}

function runtimeTool(selector: string) {
    return { mode: "agent_runtime_tool" as const, selector: { dialectId: CURSOR_SUBAGENT_TOOL_DIALECT, selector } };
}

function instruction(body: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: body }] });
}

function required<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error("required Cursor Subagent fixture missing");
    return value;
}

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}
