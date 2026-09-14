import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { CLAUDECODE_NATIVE_DIALECTS, validateClaudeCodeNativeDialect } from "../src/claudecode-source-read";
import { claudecodeProvider } from "../src/claudecode-provider";
import {
    createClaudeCodeAppGlobalJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeAppJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeGlobalJavaScriptWorkflowGraphTargetSupport,
    createClaudeCodeJavaScriptWorkflowGraphTargetSupport,
} from "../src/claudecode-target-exact-graph";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const BOUNDARY = ".claude/workflows/oaam-phase53-js-graph";
const APP_BOUNDARY = ".claude/workflows/oaam-phase53-app-js-graph";
const GLOBAL_BOUNDARY = "workflows/oaam-phase53-global-js-graph";
const APP_GLOBAL_BOUNDARY = "workflows/oaam-phase53-app-global-js-graph";
const ENTRY_PATH = `${BOUNDARY}/workflow.js`;
const TEXT_RESOURCE_PATH = `${BOUNDARY}/resources/marker.txt`;
const BINARY_RESOURCE_PATH = `${BOUNDARY}/resources/marker.bin`;
const ORIGINAL_MARKER = "OAAM_CC_JS_WORKFLOW_GRAPH_ORIGINAL_4F2A91";
const CHANGED_MARKER = "OAAM_CC_21220_JAVASCRIPT_WORKFLOW_GRAPH_7A5D20";
const ENTRY_TEXT = javascriptEntry(ORIGINAL_MARKER);
const CHANGED_ENTRY_TEXT = javascriptEntry(CHANGED_MARKER);
const TEXT_RESOURCE = "OAAM JavaScript Workflow resource v1\n";
const CHANGED_TEXT_RESOURCE = "OAAM JavaScript Workflow resource v2\n";
const BINARY_RESOURCE = Uint8Array.of(0, 255, 1, 2);
const CHANGED_BINARY_RESOURCE = Uint8Array.of(0, 255, 4, 5);

const targetContextSchemaId = requiredTargetContextSchema("CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1");
const support = createClaudeCodeJavaScriptWorkflowGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId,
});
const globalSupport = createClaudeCodeGlobalJavaScriptWorkflowGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: requiredTargetContextSchema("CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1"),
});
const appTargetContextSchemaId = requiredTargetContextSchema("CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1");
const appSupport = createClaudeCodeAppJavaScriptWorkflowGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: appTargetContextSchemaId,
});
const appGlobalSupport = createClaudeCodeAppGlobalJavaScriptWorkflowGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: requiredTargetContextSchema("CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1"),
});
type WorkflowTargetSupport = typeof support | typeof globalSupport | typeof appSupport | typeof appGlobalSupport;

describe("Claude Code JavaScript Workflow exact graph target", () => {
    it("binds the complete App graph, parent rebase, and reverse to the App engine", async () => {
        expect(appSupport.renderContractDeclaration).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_APP",
            outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1",
            materializationProfileId: "claude-code-app-project-javascript-workflow-graph-v1",
            verifiedBuilds: [
                expect.objectContaining({
                    versionText: "2.1.219",
                    buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                    platform: "win32",
                }),
            ],
        });
        for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
            const fixture = analysisFixture(
                inputRole,
                inputRole === "current_exact" ? graphFiles() : changedGraphFiles(),
                "graph",
                "project",
                "app",
            );
            expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
                status: "complete",
                blockedSemanticRefs: [],
                diagnostics: [],
            });
            expect(await claudecodeProvider.materializeRender(materializationInput(fixture))).toMatchObject({
                status: "complete",
                materializationState: "materialized",
                materializedUnits: [
                    {
                        files: expect.arrayContaining([
                            expect.objectContaining({ relativePath: `${APP_BOUNDARY}/workflow.js`, executable: true }),
                            expect.objectContaining({ relativePath: `${APP_BOUNDARY}/resources/marker.bin` }),
                            expect.objectContaining({ relativePath: `${APP_BOUNDARY}/resources/marker.txt` }),
                        ]),
                    },
                ],
            });
        }
        const current = analysisFixture("current_exact", graphFiles(), "graph", "project", "app");
        expect(
            await claudecodeProvider.inspectRenderedTarget(changedInspection(current, materializationInput(current))),
        ).toMatchObject({
            status: "complete",
            files: [
                { attributionState: "uniquely_attributable" },
                { attributionState: "uniquely_attributable" },
                { attributionState: "uniquely_attributable" },
            ],
        });
    });

    it("restores a standalone Workflow without claiming the shared workflows directory", () => {
        const fixture = analysisFixture("current_exact", standaloneFiles(), "standalone");
        const analysis = support.analyze(fixture);
        expect(analysis).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [{ claims: [{ relativePath: ".claude/workflows/standalone.js" }], managedDirectoryBoundaries: [] }],
        });
        expect(support.materialize(materializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: ".claude/workflows/standalone.js",
                            content: { text: ENTRY_TEXT },
                            executable: true,
                        },
                    ],
                },
            ],
        });
    });

    it("dispatches a complete directory graph through the frozen Provider facade", async () => {
        const fixture = analysisFixture("parent_rebase_seed", changedGraphFiles());
        expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [{ managedDirectoryBoundaries: [{ relativePath: BOUNDARY }] }],
        });
        expect(await claudecodeProvider.materializeRender(materializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        { relativePath: BINARY_RESOURCE_PATH, content: { bytes: CHANGED_BINARY_RESOURCE } },
                        { relativePath: TEXT_RESOURCE_PATH, content: { text: CHANGED_TEXT_RESOURCE }, executable: true },
                        { relativePath: ENTRY_PATH, content: { text: CHANGED_ENTRY_TEXT }, executable: true },
                    ],
                },
            ],
        });
        expect(validateNative(changedGraphFiles(), nativeFilesFor(changedGraphFiles()))).toBe(true);
    });

    it("dispatches, rebases, and reverses a user-global config-root graph through the Provider facade", async () => {
        const rebased = analysisFixture("parent_rebase_seed", changedGraphFiles(), "graph", "global");
        expect(await claudecodeProvider.analyzeRender(rebased)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [{ managedDirectoryBoundaries: [{ relativePath: GLOBAL_BOUNDARY }] }],
        });
        expect(await claudecodeProvider.materializeRender(materializationInput(rebased))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: `${GLOBAL_BOUNDARY}/resources/marker.bin`,
                            content: { bytes: CHANGED_BINARY_RESOURCE },
                        },
                        {
                            relativePath: `${GLOBAL_BOUNDARY}/resources/marker.txt`,
                            content: { text: CHANGED_TEXT_RESOURCE },
                            executable: true,
                        },
                        {
                            relativePath: `${GLOBAL_BOUNDARY}/workflow.js`,
                            content: { text: CHANGED_ENTRY_TEXT },
                            executable: true,
                        },
                    ],
                },
            ],
        });

        const current = analysisFixture("current_exact", graphFiles(), "graph", "global");
        const inspection = await claudecodeProvider.inspectRenderedTarget(
            changedInspection(current, materializationInput(current)),
        );
        expect(inspection.status).toBe("complete");
        expect(inspection.files.every((file) => file.attributionState === "uniquely_attributable")).toBe(true);
        expect(inspection.changes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ changeKind: "file_content_replacement" }),
                expect.objectContaining({ changeKind: "file_executable_replacement", executable: true }),
            ]),
        );
        expect(validateNative(graphFiles(), nativeFilesFor(graphFiles(), "graph", "global"))).toBe(true);
    });

    it("binds the independently verified App global graph and does not borrow the CLI output contract", async () => {
        const fixture = analysisFixture("parent_rebase_seed", changedGraphFiles(), "graph", "global", "app");
        expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [{ managedDirectoryBoundaries: [{ relativePath: APP_GLOBAL_BOUNDARY }] }],
        });
        expect(await claudecodeProvider.materializeRender(materializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: expect.arrayContaining([
                        expect.objectContaining({ relativePath: `${APP_GLOBAL_BOUNDARY}/workflow.js`, executable: true }),
                        expect.objectContaining({ relativePath: `${APP_GLOBAL_BOUNDARY}/resources/marker.bin` }),
                        expect.objectContaining({ relativePath: `${APP_GLOBAL_BOUNDARY}/resources/marker.txt` }),
                    ]),
                },
            ],
        });
    });

    it("keeps project and global JavaScript Workflow declarations mutually exclusive", async () => {
        const project = analysisFixture("current_exact", graphFiles());
        const global = analysisFixture("current_exact", graphFiles(), "graph", "global");
        expect(globalSupport.analyze(project).status).toBe("failed");
        expect(support.analyze(global).status).toBe("failed");
        expect(await claudecodeProvider.analyzeRender(project)).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
        expect(await claudecodeProvider.analyzeRender(global)).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
    });

    it("reverses existing JavaScript, resource, binary, and executable changes", async () => {
        const fixture = analysisFixture("current_exact", graphFiles());
        const materialization = materializationInput(fixture);
        const result = await claudecodeProvider.inspectRenderedTarget(changedInspection(fixture, materialization));
        expect(result.status).toBe("complete");
        expect(result.files.every((file) => file.attributionState === "uniquely_attributable")).toBe(true);
        expect(result.changes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: CHANGED_ENTRY_TEXT },
                }),
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: CHANGED_TEXT_RESOURCE },
                }),
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "binary", bytes: CHANGED_BINARY_RESOURCE },
                }),
                expect.objectContaining({ changeKind: "file_executable_replacement", executable: true }),
            ]),
        );
    });

    it("fails closed on shared-root ownership, ambiguous entries, graph shape drift, and foreign restoration", () => {
        const sharedRoot = analysisFixture("current_exact", standaloneFiles(), "standalone");
        const sharedNative = nativeInput(sharedRoot);
        sharedNative.files.push(nativeText(".claude/workflows/shared-resource.txt", "shared", false));
        expect(support.analyze(sharedRoot).status).toBe("failed");

        const ambiguous = analysisFixture("current_exact", graphFiles());
        nativeInput(ambiguous).files.push(nativeText(`${BOUNDARY}/other.js`, javascriptEntry("OAAM_CC_AMBIGUOUS"), false));
        expect(support.analyze(ambiguous).status).toBe("failed");

        const missing = analysisFixture("parent_rebase_seed", changedGraphFiles().slice(1));
        expect(support.analyze(missing).status).toBe("failed");

        const metadata = analysisFixture("parent_rebase_seed", changedGraphFiles());
        const asset = metadata.deployment.assets[0];
        if (asset?.version.canonical.kind !== "Workflow") throw new Error("Workflow fixture missing");
        asset.version.canonical.typeData.description = "foreign metadata cannot be guessed into JavaScript";
        expect(support.analyze(metadata).status).toBe("failed");

        const restoration = analysisFixture("current_exact", graphFiles());
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(support.analyze(restoration).status).toBe("failed");
    });

    it("classifies Markdown and JavaScript Workflow variants in one deployment without overlap", async () => {
        const javascript = analysisFixture("current_exact", graphFiles());
        const markdown = markdownWorkflowFixture();
        const mixed: RenderAnalysisInput = {
            schemaVersion: 1,
            deployment: {
                ...javascript.deployment,
                assets: [...javascript.deployment.assets, ...markdown.deployment.assets],
            },
            requiredSemantics: [...javascript.requiredSemantics, ...markdown.requiredSemantics],
            dialectInputs: [...javascript.dialectInputs, ...markdown.dialectInputs],
        };
        const result = await claudecodeProvider.analyzeRender(mixed);
        expect(result).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(result.outputUnits).toHaveLength(2);
        expect(new Set(result.semanticOptions.map((option) => option.renderStrategy))).toEqual(new Set(["native_graph"]));
        expect(result.semanticOptions).toHaveLength(mixed.requiredSemantics.length);
    });

    it("fails closed when Workflow lineage is unknown or a variant returns a duplicate semantic closure", async () => {
        const unknown = analysisFixture("current_exact", graphFiles());
        nativeInput(unknown).representation.dialectId = "claudecode-unknown-workflow-v1";
        const unavailable = await claudecodeProvider.analyzeRender(unknown);
        expect(unavailable).toMatchObject({ status: "failed", outputUnits: [], semanticOptions: [] });
        expect(unavailable.blockedSemanticRefs).toHaveLength(unknown.requiredSemantics.length);
        expect(
            unavailable.blockedSemanticRefs.every(
                (blocked) => blocked.reasonCode === "claudecode_workflow_native_variant_unavailable",
            ),
        ).toBe(true);

        const duplicate = analysisFixture("current_exact", graphFiles());
        const repeated = duplicate.requiredSemantics[0];
        if (repeated === undefined) throw new Error("Workflow semantic fixture is missing");
        duplicate.requiredSemantics.push(structuredClone(repeated));
        const invalid = await claudecodeProvider.analyzeRender(duplicate);
        expect(invalid).toMatchObject({ status: "failed", outputUnits: [], semanticOptions: [] });
        expect(invalid.blockedSemanticRefs).toHaveLength(duplicate.requiredSemantics.length);
    });
});

function analysisFixture(
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
    shape: "graph" | "standalone" = "graph",
    targetScope: "project" | "global" = "project",
    targetEntry: "cli" | "app" = "cli",
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const targetSupport = supportForScope(targetScope, targetEntry);
    const nativeFiles = nativeFilesFor(
        inputRole === "current_exact" ? files : shapeFiles(shape),
        shape,
        targetScope,
        targetEntry,
    );
    const runtimeId = targetEntry === "app" ? "CLAUDE_CODE_APP" : "CLAUDE_CODE_CLI";
    const build = targetSupport.renderContractDeclaration.verifiedBuilds[0];
    if (build === undefined) throw new Error("Workflow target build fixture is missing");
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: build.platform,
            platformInstanceId: targetEntry === "app" ? "test-win32" : "test-wsl",
            targetContexts: [targetContext(targetSupport)],
            assets: [workflowAsset(ASSET_ID, versionId, files, targetScope)],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: workflowSemantics(ASSET_ID, versionId, files, runtimeId),
        dialectInputs: [
            {
                targetVersion: { assetId: ASSET_ID, versionId },
                consumerAgentRuntimeIds: [runtimeId],
                inputs: [
                    inputRole === "current_exact"
                        ? nativeDialectInput(nativeFiles, inputRole)
                        : {
                              ...nativeDialectInput(nativeFiles, inputRole),
                              inputRole: "parent_rebase_seed" as const,
                              sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                          },
                ],
            },
        ],
    };
}

function materializationInput(analysisInput: RenderAnalysisInput): RenderMaterializationInput {
    const targetSupport = supportForFixture(analysisInput);
    const analysis = targetSupport.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("JavaScript Workflow graph analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(targetSupport.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("JavaScript Workflow graph target profile is missing");
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
                rendererAdapterId: "CLAUDECODE",
                rendererAdapterVersion: claudecodeProvider.version,
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

function changedInspection(
    fixture: RenderAnalysisInput,
    materialization: RenderMaterializationInput,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("JavaScript Workflow graph output unit missing");
    const targetScope = fixture.deployment.assets[0]?.scope;
    if (targetScope !== "project" && targetScope !== "global") throw new Error("Workflow fixture scope is missing");
    const targetEntry = fixture.deployment.targetContexts[0]?.agentRuntimeId === "CLAUDE_CODE_APP" ? "app" : "cli";
    const boundary =
        targetScope === "project"
            ? targetEntry === "app"
                ? APP_BOUNDARY
                : BOUNDARY
            : targetEntry === "app"
              ? APP_GLOBAL_BOUNDARY
              : GLOBAL_BOUNDARY;
    const applied = nativeFilesFor(graphFiles(), "graph", targetScope, targetEntry);
    const current = nativeFilesFor(changedGraphFiles(), "graph", targetScope, targetEntry);
    const canonical = graphFiles();
    const files = applied.map((appliedFile) => {
        const currentFile = current.find((file) => file.relativePath === appliedFile.relativePath);
        const canonicalFile = canonical.find((file) => `${boundary}/${file.file.logicalPath}` === appliedFile.relativePath);
        if (currentFile === undefined || canonicalFile === undefined || currentFile.contentKind !== appliedFile.contentKind) {
            throw new Error("JavaScript Workflow graph fixture mismatch");
        }
        const appliedContent = targetContent(appliedFile);
        const currentContent = targetContent(currentFile);
        const executableChanged = appliedFile.executable !== currentFile.executable;
        return {
            fileState: "baseline_changed" as const,
            relativePath: appliedFile.relativePath,
            appliedContent,
            currentContent,
            diffHunks: [
                {
                    hunkFingerprint: sha256Text(appliedFile.relativePath),
                    appliedStartByte: 0,
                    appliedEndByte: appliedFile.byteSize,
                    currentStartByte: 0,
                    currentEndByte: currentFile.byteSize,
                },
            ],
            attributeChanges: executableChanged
                ? [
                      {
                          attributeChangeFingerprint: sha256Text(`${appliedFile.relativePath}:executable`),
                          attributeKind: "executable" as const,
                          appliedValue: appliedFile.executable,
                          currentValue: currentFile.executable,
                      },
                  ]
                : [],
            provenance: {
                schemaVersion: 1 as const,
                appliedRenderSnapshotFingerprint: HASH,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                semanticRefFingerprints: fixture.requiredSemantics
                    .filter(
                        (item) =>
                            item.subject.subjectKind === "asset" ||
                            (item.subject.subjectKind === "file" && item.subject.fileId === canonicalFile.file.fileId),
                    )
                    .map((item) => item.semanticRefFingerprint),
                sectionBindings: [],
                materializationFingerprint: HASH,
                provenanceFingerprint: HASH,
            },
        };
    });
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
            decisions: materialization.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: "CLAUDECODE",
                consumerOwnerAdapterVersion: claudecodeProvider.version,
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
            fileStates: files.map((file) => ({
                relativePath: file.relativePath,
                state: "changed" as const,
                appliedContentHash: contentHash(file.appliedContent),
                currentContentHash: contentHash(file.currentContent),
                appliedExecutable: file.attributeChanges[0]?.appliedValue ?? false,
                currentExecutable: file.attributeChanges[0]?.currentValue ?? false,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                provenanceFingerprint: HASH,
            })),
            directoryInventories: [
                {
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    boundary: { relativePath: boundary, boundaryKind: "directory_inventory" },
                    currentDescendantPaths: current.map((file) => file.relativePath),
                },
            ],
        },
        files,
        inventoryDeltas: [],
    };
}

function markdownWorkflowFixture(): RenderAnalysisInput {
    const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const body = "Review this change.\n";
    const nativeText = `---\nname: review\ndescription: Review changes\n---\n${body}`;
    const canonical: Extract<AssetKindTypeDataV2, { kind: "Workflow" }> = {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "Review changes",
            implementation: {
                kind: "instructions",
                instructionDialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "inherit" },
                    effort: { mode: "inherit" },
                    shell: { mode: "agent_runtime_default" },
                },
                toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            },
            invocation: {
                commandNames: ["review"],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
    const files = [textFile("WORKFLOW.md", body, fileId, "entry", false)];
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetContexts: [targetContext()],
            assets: [
                {
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical,
                        files,
                    },
                    sectionHandles: { [fileId]: "workflow-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: workflowSemantics(assetId, versionId, files),
        dialectInputs: [
            {
                targetVersion: { assetId, versionId },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                inputs: [
                    {
                        inputKind: "native_representation",
                        inputRole: "current_exact",
                        representation: {
                            schemaVersion: 1,
                            dialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
                            dialectContractFingerprint: HASH,
                            canonicalContentFingerprint: HASH,
                            representationFingerprint: HASH,
                        },
                        files: [nativeTextFile(".claude/commands/review.md", nativeText, false)],
                    },
                ],
            },
        ],
    };
}

function workflowAsset(
    assetId: string,
    versionId: string,
    files: AssetVersionFileContentV2[],
    targetScope: "project" | "global" = "project",
) {
    return {
        scope: targetScope,
        projectId: targetScope === "project" ? PROJECT_ID : "",
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: workflowCanonical(),
            files: structuredClone(files),
        },
        sectionHandles: Object.fromEntries(files.map((file) => [file.file.fileId, `workflow-${file.file.logicalPath}`])),
    };
}

function targetContext(targetSupport: WorkflowTargetSupport = support) {
    const build = targetSupport.renderContractDeclaration.verifiedBuilds[0];
    if (build === undefined) throw new Error("Workflow target build fixture is missing");
    return {
        schemaVersion: 1 as const,
        agentRuntimeId: targetSupport.renderContractDeclaration.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: targetSupport.targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: targetSupport.targetContextSchema.schemaFingerprint,
        renderFacts: [{ key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" as const }],
        targetApplicabilityFingerprint: HASH,
    };
}

function nativeDialectInput(files: ReturnType<typeof nativeFilesFor>, inputRole: "current_exact" | "parent_rebase_seed") {
    return {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: files.map(({ text: _text, bytes: _bytes, ...descriptor }) => descriptor),
        },
        files,
    };
}

function workflowSemantics(
    assetId: string,
    versionId: string,
    files: AssetVersionFileContentV2[],
    consumerAgentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP" = "CLAUDE_CODE_CLI",
) {
    return [
        semantic("asset.file_inventory", assetId, versionId, "asset", undefined, consumerAgentRuntimeId),
        semantic("workflow.activation", assetId, versionId, "asset", undefined, consumerAgentRuntimeId),
        ...files.map((file) =>
            semantic("workflow.content", assetId, versionId, "file", file.file.fileId, consumerAgentRuntimeId),
        ),
    ] as RenderAnalysisInput["requiredSemantics"];
}

function semantic(
    kind: "asset.file_inventory" | "workflow.activation" | "workflow.content",
    assetId: string,
    versionId: string,
    subjectKind: "asset" | "file",
    fileId?: string,
    consumerAgentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP" = "CLAUDE_CODE_CLI",
) {
    return {
        semanticRefFingerprint: sha256Text(`${kind}:${assetId}:${versionId}:${fileId ?? "asset"}`),
        consumerAgentRuntimeId,
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId, versionId }
                : { subjectKind: "file" as const, assetId, versionId, fileId: fileId as string },
        semanticKind: kind,
    };
}

function graphFiles(): AssetVersionFileContentV2[] {
    return [
        binaryFile("resources/marker.bin", BINARY_RESOURCE, "44444444-4444-4444-8444-444444444444"),
        textFile("resources/marker.txt", TEXT_RESOURCE, "33333333-3333-4333-8333-333333333333", "resource", false),
        textFile("workflow.js", ENTRY_TEXT, "11111111-1111-4111-8111-111111111111", "entry", true),
    ];
}

function changedGraphFiles(): AssetVersionFileContentV2[] {
    return [
        binaryFile("resources/marker.bin", CHANGED_BINARY_RESOURCE, "44444444-4444-4444-8444-444444444444"),
        textFile("resources/marker.txt", CHANGED_TEXT_RESOURCE, "33333333-3333-4333-8333-333333333333", "resource", true),
        textFile("workflow.js", CHANGED_ENTRY_TEXT, "11111111-1111-4111-8111-111111111111", "entry", true),
    ];
}

function standaloneFiles(): AssetVersionFileContentV2[] {
    return [textFile("standalone.js", ENTRY_TEXT, "11111111-1111-4111-8111-111111111111", "entry", true)];
}

function shapeFiles(shape: "graph" | "standalone") {
    return shape === "graph" ? graphFiles() : standaloneFiles();
}

function nativeFilesFor(
    files: AssetVersionFileContentV2[],
    shape: "graph" | "standalone" = "graph",
    targetScope: "project" | "global" = "project",
    targetEntry: "cli" | "app" = "cli",
) {
    return files
        .map((file) => {
            const root = targetScope === "project" ? ".claude/workflows" : "workflows";
            const boundary =
                targetScope === "project"
                    ? targetEntry === "app"
                        ? APP_BOUNDARY
                        : BOUNDARY
                    : targetEntry === "app"
                      ? APP_GLOBAL_BOUNDARY
                      : GLOBAL_BOUNDARY;
            const relativePath =
                shape === "standalone" ? `${root}/${file.file.logicalPath}` : `${boundary}/${file.file.logicalPath}`;
            return file.contentKind === "text"
                ? nativeText(relativePath, file.text, file.file.executable)
                : nativeBinary(relativePath, file.bytes, file.file.executable);
        })
        .sort((left, right) => compareText(left.relativePath, right.relativePath));
}

function supportForFixture(input: RenderAnalysisInput): WorkflowTargetSupport {
    const scope = input.deployment.assets[0]?.scope;
    if (scope !== "project" && scope !== "global") throw new Error("Workflow fixture scope is missing");
    const runtimeId = input.deployment.targetContexts[0]?.agentRuntimeId;
    return supportForScope(scope, runtimeId === "CLAUDE_CODE_APP" ? "app" : "cli");
}

function supportForScope(targetScope: "project" | "global", targetEntry: "cli" | "app" = "cli"): WorkflowTargetSupport {
    if (targetScope === "global") return targetEntry === "app" ? appGlobalSupport : globalSupport;
    return targetEntry === "app" ? appSupport : support;
}

function requiredTargetContextSchema(targetContextSchemaId: string): string {
    const schema = claudecodeProvider.targetContextSchemas.find(
        (candidate) => candidate.targetContextSchemaId === targetContextSchemaId,
    );
    if (schema === undefined) throw new Error(`Claude Code target context schema is missing: ${targetContextSchemaId}`);
    return schema.targetContextSchemaId;
}

function validateNative(files: AssetVersionFileContentV2[], nativeFiles: ReturnType<typeof nativeFilesFor>): boolean {
    return validateClaudeCodeNativeDialect({
        canonical: workflowCanonical(),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(({ text: _text, bytes: _bytes, ...descriptor }) => descriptor),
        },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
        })),
    });
}

function workflowCanonical(): Extract<AssetKindTypeDataV2, { kind: "Workflow" }> {
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: "oaam-phase53-js-graph",
            description: "OAAM Claude Code JavaScript Workflow graph",
            implementation: {
                kind: "executable",
                executableDialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
            },
            invocation: {
                commandNames: ["oaam-phase53-js-graph"],
                userInvocable: false,
                agentInvocable: true,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}

function javascriptEntry(marker: string): string {
    return [
        "export const meta = {",
        '  name: "oaam-phase53-js-graph",',
        '  description: "OAAM Claude Code JavaScript Workflow graph",',
        "};",
        `export default async function run() { return "${marker}"; }`,
        "",
    ].join("\n");
}

function textFile(
    logicalPath: string,
    text: string,
    fileId: string,
    role: "entry" | "resource",
    executable: boolean,
): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId,
            logicalPath,
            role,
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: inferCanonicalMediaType(logicalPath, "text"),
            byteSize: Buffer.byteLength(text),
            executable,
            references: [],
        },
    };
}

function binaryFile(logicalPath: string, source: Uint8Array, fileId: string): AssetVersionFileContentV2 {
    const bytes = new Uint8Array(source);
    return {
        contentKind: "binary",
        bytes,
        file: {
            fileId,
            logicalPath,
            role: "resource",
            contentHash: sha256Bytes(bytes),
            contentKind: "binary",
            mediaType: inferCanonicalMediaType(logicalPath, "binary"),
            byteSize: bytes.byteLength,
            executable: false,
            references: [],
        },
    };
}

function nativeText(relativePath: string, text: string, executable: boolean) {
    return nativeTextFile(relativePath, text, executable);
}

function nativeTextFile(relativePath: string, text: string, executable: boolean) {
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: inferCanonicalMediaType(relativePath, "text"),
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable,
        text,
    };
}

function nativeBinary(relativePath: string, source: Uint8Array, executable: boolean) {
    const bytes = new Uint8Array(source);
    return {
        relativePath,
        contentKind: "binary" as const,
        mediaType: inferCanonicalMediaType(relativePath, "binary"),
        contentHash: sha256Bytes(bytes),
        byteSize: bytes.byteLength,
        executable,
        bytes,
    };
}

function targetContent(file: ReturnType<typeof nativeFilesFor>[number]) {
    return file.contentKind === "text"
        ? { contentKind: "text" as const, text: file.text }
        : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
}

function nativeInput(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("native graph fixture missing");
    return candidate;
}

function contentHash(content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array }) {
    return content.contentKind === "text" ? sha256Text(content.text) : sha256Bytes(content.bytes);
}

function sha256Text(text: string): Sha256Digest {
    return sha256Bytes(new TextEncoder().encode(text));
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
