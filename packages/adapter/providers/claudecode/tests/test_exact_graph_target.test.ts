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
import { validateClaudeCodeNativeDialect } from "../src/claudecode-source-read";
import { claudecodeProvider } from "../src/claudecode-provider";
import {
    createClaudeCodeAppGlobalSkillGraphTargetSupport,
    createClaudeCodeAppSkillGraphTargetSupport,
    createClaudeCodeGlobalSkillGraphTargetSupport,
    createClaudeCodeSkillGraphTargetSupport,
} from "../src/claudecode-target-exact-graph";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const BOUNDARY = ".claude/skills/oaam-phase53-graph-skill";
const APP_BOUNDARY = ".claude/skills/oaam-phase53-app-graph-skill";
const GLOBAL_BOUNDARY = "skills/oaam-phase53-global-graph-skill";
const APP_GLOBAL_BOUNDARY = "skills/oaam-phase53-app-global-graph-skill";
const ENTRY_PATH = `${BOUNDARY}/SKILL.md`;
const SCRIPT_PATH = `${BOUNDARY}/scripts/marker.py`;
const BINARY_PATH = `${BOUNDARY}/assets/marker.bin`;
const ENTRY_BODY = "\nUse the bundled marker resources. OAAM_CC_21220_SKILL_GRAPH_4F2A91\n";
const CHANGED_ENTRY_BODY = ENTRY_BODY.replace("4F2A91", "8C7D63");
const HEADER = [
    "---",
    "# preserve this private layout",
    "name: oaam-phase53-graph-skill",
    "description: OAAM Claude Code graph Skill",
    "disable-model-invocation: true",
    "version: '1.0.0'",
    "---",
    "",
].join("\n");
const APP_HEADER = HEADER.replace("name: oaam-phase53-graph-skill", "name: oaam-phase53-app-graph-skill");
const SCRIPT = "print('OAAM_CC_SKILL_RESOURCE_V1')\n";
const CHANGED_SCRIPT = "print('OAAM_CC_SKILL_RESOURCE_V2')\n";
const BINARY = Uint8Array.of(0, 255, 1, 2);
const CHANGED_BINARY = Uint8Array.of(0, 255, 4, 5);

const targetContextSchemaId = requiredTargetContextSchema("CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1");
const support = createClaudeCodeSkillGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId,
});
const appTargetContextSchemaId = requiredTargetContextSchema("CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1");
const appSupport = createClaudeCodeAppSkillGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: appTargetContextSchemaId,
});
const globalSupport = createClaudeCodeGlobalSkillGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: requiredTargetContextSchema("CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1"),
});
const appGlobalSupport = createClaudeCodeAppGlobalSkillGraphTargetSupport({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId: requiredTargetContextSchema("CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1"),
});
type SkillSupport = typeof support | typeof appSupport | typeof globalSupport | typeof appGlobalSupport;

describe("Claude Code exact Skill directory target", () => {
    it("keeps CLI and App build, profile and output identities independent over the same graph semantics", async () => {
        expect(appSupport.renderContractDeclaration).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_APP",
            outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_SKILL_GRAPH_V1",
            materializationProfileId: "claude-code-app-project-skill-graph-v1",
            verifiedBuilds: [
                expect.objectContaining({
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    versionText: "2.1.219",
                    buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                    platform: "win32",
                }),
            ],
        });
        expect(appSupport.materializerCapability.materializerCapabilityKey).toBe("claudecode.app-project-skill-exact-graph-v1");
        expect(appSupport.renderContractDeclaration.outputContractId).not.toBe(
            support.renderContractDeclaration.outputContractId,
        );

        const fixture = appAnalysisFixture("parent_rebase_seed", changedCanonicalFiles());
        expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [{ managedDirectoryBoundaries: [{ relativePath: APP_BOUNDARY }] }],
        });
        const materialized = await claudecodeProvider.materializeRender(materializationInput(fixture, appSupport));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        { relativePath: `${APP_BOUNDARY}/SKILL.md`, content: { text: `${APP_HEADER}${CHANGED_ENTRY_BODY}` } },
                        { relativePath: `${APP_BOUNDARY}/assets/marker.bin`, content: { bytes: CHANGED_BINARY } },
                        {
                            relativePath: `${APP_BOUNDARY}/scripts/marker.py`,
                            content: { text: CHANGED_SCRIPT },
                            executable: true,
                        },
                    ],
                },
            ],
        });
    });

    it("keeps user-global CLI and App directory Skills exact across current, parent rebase, and reverse", async () => {
        for (const [targetSupport, variant] of [
            [globalSupport, "global_cli"],
            [appGlobalSupport, "global_app"],
        ] as const) {
            const boundary = skillVariant(variant).boundary;
            expect(targetSupport.renderContractDeclaration).toMatchObject({
                declarationKind: "native_global_exact_graph_v1",
                assetKind: "Skill",
            });
            for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
                const files = inputRole === "current_exact" ? canonicalFiles() : changedCanonicalFiles();
                const fixture = globalAnalysisFixture(inputRole, files, variant === "global_app");
                expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
                    status: "complete",
                    blockedSemanticRefs: [],
                    diagnostics: [],
                    outputUnits: [{ managedDirectoryBoundaries: [{ relativePath: boundary }] }],
                });
                const materialization = materializationInput(fixture, targetSupport);
                await expect(claudecodeProvider.materializeRender(materialization)).resolves.toMatchObject({
                    status: "complete",
                    materializationState: "materialized",
                    materializedUnits: [
                        {
                            files: expect.arrayContaining([
                                expect.objectContaining({ relativePath: `${boundary}/SKILL.md` }),
                                expect.objectContaining({ relativePath: `${boundary}/assets/marker.bin` }),
                                expect.objectContaining({ relativePath: `${boundary}/scripts/marker.py` }),
                            ]),
                        },
                    ],
                });
            }

            const current = globalAnalysisFixture("current_exact", canonicalFiles(), variant === "global_app");
            const materialization = materializationInput(current, targetSupport);
            await expect(
                claudecodeProvider.inspectRenderedTarget(changedInspection(current, materialization, variant)),
            ).resolves.toMatchObject({
                status: "complete",
                files: expect.arrayContaining([
                    expect.objectContaining({
                        relativePath: `${boundary}/SKILL.md`,
                        attributionState: "uniquely_attributable",
                    }),
                ]),
                changes: expect.arrayContaining([
                    expect.objectContaining({ changeKind: "file_content_replacement" }),
                    expect.objectContaining({ changeKind: "file_executable_replacement", executable: true }),
                ]),
            });
        }
    });

    it("dispatches the complete graph through the frozen Provider facade", async () => {
        const fixture = analysisFixture("parent_rebase_seed", changedCanonicalFiles());
        expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [{ managedDirectoryBoundaries: [{ relativePath: BOUNDARY }] }],
        });
        const materialized = await claudecodeProvider.materializeRender(materializationInput(fixture));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        { relativePath: ENTRY_PATH, content: { text: `${HEADER}${CHANGED_ENTRY_BODY}` } },
                        { relativePath: BINARY_PATH, content: { bytes: CHANGED_BINARY } },
                        { relativePath: SCRIPT_PATH, content: { text: CHANGED_SCRIPT }, executable: true },
                    ],
                },
            ],
        });
    });

    it("restores current native bytes for both one-file and multi-file directory Skills", () => {
        const entry = canonicalFiles().find((file) => file.file.role === "entry");
        if (entry === undefined) throw new Error("Skill graph entry fixture is missing");
        for (const files of [canonicalFiles(), [entry]]) {
            const fixture = analysisFixture("current_exact", files);
            const materialized = support.materialize(materializationInput(fixture));
            expect(materialized.materializationState).toBe("materialized");
            if (materialized.materializationState !== "materialized") throw new Error("Skill graph did not materialize");
            const expectedPaths = nativeFilesFor(files).map((file) => file.relativePath);
            expect(materialized.materializedUnits[0]?.files.map((file) => file.relativePath)).toEqual(expectedPaths);
        }
    });

    it("rebases body, text, binary and executable state while preserving the Claude header exactly", () => {
        const fixture = analysisFixture("parent_rebase_seed", changedCanonicalFiles());
        const materialized = support.materialize(materializationInput(fixture));
        expect(materialized).toMatchObject({
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        { relativePath: ENTRY_PATH, content: { text: `${HEADER}${CHANGED_ENTRY_BODY}` } },
                        { relativePath: BINARY_PATH, content: { bytes: CHANGED_BINARY } },
                        { relativePath: SCRIPT_PATH, content: { text: CHANGED_SCRIPT }, executable: true },
                    ],
                },
            ],
        });
        expect(validateNative(changedCanonicalFiles(), nativeFilesFor(changedCanonicalFiles()))).toBe(true);
    });

    it("reverse attributes existing entry, text, binary and executable changes without accepting header drift", async () => {
        const fixture = analysisFixture("current_exact", canonicalFiles());
        const materialization = materializationInput(fixture);
        const result = await claudecodeProvider.inspectRenderedTarget(changedInspection(fixture, materialization));
        expect(result.status).toBe("complete");
        expect(result.files.every((file) => file.attributionState === "uniquely_attributable")).toBe(true);
        expect(result.changes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: CHANGED_ENTRY_BODY },
                }),
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: CHANGED_SCRIPT },
                }),
                expect.objectContaining({
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "binary", bytes: CHANGED_BINARY },
                }),
                expect.objectContaining({ changeKind: "file_executable_replacement", executable: true }),
            ]),
        );

        const drifted = changedInspection(fixture, materialization);
        const entry = drifted.files.find((file) => file.relativePath === ENTRY_PATH);
        if (entry?.currentContent.contentKind !== "text") throw new Error("entry fixture missing");
        entry.currentContent.text = entry.currentContent.text.replace("version: '1.0.0'", "version: '2.0.0'");
        expect(await claudecodeProvider.inspectRenderedTarget(drifted)).toMatchObject({
            status: "complete",
            files: expect.arrayContaining([
                expect.objectContaining({
                    relativePath: ENTRY_PATH,
                    attributionState: "conflict",
                    reasonCode: "native_project_exact_graph_content_not_reconcilable",
                }),
            ]),
        });
    });

    it("blocks cross-boundary graphs, shape changes, metadata drift and foreign restoration", () => {
        const outside = analysisFixture("current_exact", canonicalFiles());
        const native = nativeInput(outside);
        const outsideFile = native.files[0];
        if (outsideFile === undefined) throw new Error("Skill native fixture is missing");
        outsideFile.relativePath = ".claude/skills/other/assets/marker.bin";
        expect(support.analyze(outside).status).toBe("failed");

        const duplicate = analysisFixture("current_exact", canonicalFiles());
        const duplicateNative = nativeInput(duplicate);
        const duplicateFile = duplicateNative.files[0];
        if (duplicateFile === undefined) throw new Error("Skill native fixture is missing");
        duplicateNative.files.push(structuredClone(duplicateFile));
        expect(support.analyze(duplicate).status).toBe("failed");

        const noEntry = analysisFixture("current_exact", canonicalFiles());
        const noEntryFile = nativeInput(noEntry).files.find((file) => file.relativePath === ENTRY_PATH);
        if (noEntryFile === undefined) throw new Error("entry fixture missing");
        noEntryFile.relativePath = `${BOUNDARY}/ENTRY.md`;
        expect(support.analyze(noEntry).status).toBe("failed");

        const twoEntries = analysisFixture("current_exact", canonicalFiles());
        const secondEntry = structuredClone(nativeInput(twoEntries).files.find((file) => file.relativePath === ENTRY_PATH));
        if (secondEntry === undefined) throw new Error("entry fixture missing");
        secondEntry.relativePath = `${BOUNDARY}/nested/SKILL.md`;
        nativeInput(twoEntries).files.push(secondEntry);
        expect(support.analyze(twoEntries).status).toBe("failed");

        const invalidBoundary = analysisFixture("current_exact", canonicalFiles());
        for (const file of nativeInput(invalidBoundary).files) {
            file.relativePath = file.relativePath.replace(BOUNDARY, ".claude/skills/../unsafe");
        }
        expect(support.analyze(invalidBoundary).status).toBe("failed");

        const missing = analysisFixture("parent_rebase_seed", changedCanonicalFiles().slice(1));
        expect(support.analyze(missing).status).toBe("failed");

        const malformedParent = analysisFixture("parent_rebase_seed", changedCanonicalFiles());
        const malformedEntry = nativeInput(malformedParent).files.find((file) => file.relativePath === ENTRY_PATH);
        if (malformedEntry?.contentKind !== "text") throw new Error("entry fixture missing");
        malformedEntry.text = "missing frontmatter";
        malformedEntry.byteSize = Buffer.byteLength(malformedEntry.text);
        malformedEntry.contentHash = sha256Text(malformedEntry.text);
        expect(support.analyze(malformedParent).status).toBe("failed");

        const metadata = analysisFixture("parent_rebase_seed", changedCanonicalFiles());
        const asset = metadata.deployment.assets[0];
        if (asset?.version.canonical.kind !== "Skill") throw new Error("Skill fixture missing");
        asset.version.canonical.typeData.description = "foreign description cannot be guessed into private header";
        expect(support.analyze(metadata).status).toBe("failed");

        const restoration = analysisFixture("current_exact", canonicalFiles());
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

        const contentKindDrift = changedInspection(
            analysisFixture("current_exact", canonicalFiles()),
            materializationInput(analysisFixture("current_exact", canonicalFiles())),
        );
        const driftedEntry = contentKindDrift.files.find((file) => file.relativePath === ENTRY_PATH);
        const driftedState = contentKindDrift.inspectionScope.fileStates.find((file) => file.relativePath === ENTRY_PATH);
        if (driftedEntry === undefined || driftedState === undefined) throw new Error("entry fixture missing");
        driftedEntry.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1, 2, 3) };
        driftedState.currentContentHash = sha256Bytes(Uint8Array.of(1, 2, 3));
        expect(support.inspect(contentKindDrift)).toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({
                    relativePath: ENTRY_PATH,
                    attributionState: "conflict",
                }),
            ]),
        });
    });
});

function analysisFixture(
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const asset = {
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: skillCanonical(),
            files: structuredClone(files),
        },
        sectionHandles: Object.fromEntries(files.map((file) => [file.file.fileId, `skill-${file.file.logicalPath}`])),
    };
    const nativeFiles = nativeFilesFor(inputRole === "current_exact" ? files : canonicalFiles());
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: "claudecode-skill-directory-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(({ text: _text, bytes: _bytes, ...descriptor }) => descriptor),
        },
        files: nativeFiles,
    };
    const semantics = [
        semantic("asset.file_inventory", versionId, "asset"),
        semantic("skill.discovery_metadata", versionId, "asset"),
        ...files.map((file) =>
            semantic(file.file.role === "entry" ? "skill.body" : "skill.resource", versionId, "file", file.file.fileId),
        ),
    ];
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    versionText: "2.1.220",
                    buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [{ key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" }],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: semantics as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [
            {
                targetVersion: { assetId: ASSET_ID, versionId },
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                inputs: [
                    inputRole === "current_exact"
                        ? common
                        : {
                              ...common,
                              inputRole: "parent_rebase_seed" as const,
                              sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                          },
                ],
            },
        ],
    };
}

function appAnalysisFixture(
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
): RenderAnalysisInput {
    const fixture = analysisFixture(inputRole, files);
    fixture.deployment.platform = "win32";
    fixture.deployment.platformInstanceId = "test-win32";
    const context = fixture.deployment.targetContexts[0];
    if (context === undefined) throw new Error("Skill target context is missing");
    context.agentRuntimeId = "CLAUDE_CODE_APP";
    context.versionText = "2.1.219";
    context.buildIdentity = "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637";
    context.targetContextSchemaId = appSupport.targetContextSchema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = appSupport.targetContextSchema.schemaFingerprint;
    context.renderFacts = [{ key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" }];
    for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "CLAUDE_CODE_APP";
    for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["CLAUDE_CODE_APP"];
    for (const asset of fixture.deployment.assets) {
        if (asset.version.canonical.kind === "Skill") {
            asset.version.canonical.typeData.name = "oaam-phase53-app-graph-skill";
            asset.version.canonical.typeData.invocation.user.commandName = "oaam-phase53-app-graph-skill";
        }
    }
    for (const input of fixture.dialectInputs.flatMap((entry) => entry.inputs)) {
        if (input.inputKind !== "native_representation") continue;
        for (const file of input.files) {
            file.relativePath = file.relativePath.replace(BOUNDARY, APP_BOUNDARY) as typeof file.relativePath;
            if (file.relativePath === `${APP_BOUNDARY}/SKILL.md` && file.contentKind === "text") {
                file.text = file.text.replace("name: oaam-phase53-graph-skill", "name: oaam-phase53-app-graph-skill");
                file.byteSize = Buffer.byteLength(file.text);
                file.contentHash = sha256Text(file.text);
            }
        }
        for (const file of input.representation.files) {
            file.relativePath = file.relativePath.replace(BOUNDARY, APP_BOUNDARY) as typeof file.relativePath;
            const content = input.files.find((candidate) => candidate.relativePath === file.relativePath);
            if (content !== undefined) {
                file.byteSize = content.byteSize;
                file.contentHash = content.contentHash;
            }
        }
    }
    return fixture;
}

function globalAnalysisFixture(
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
    isApp: boolean,
): RenderAnalysisInput {
    const fixture = isApp ? appAnalysisFixture(inputRole, files) : analysisFixture(inputRole, files);
    const variant = isApp ? ("global_app" as const) : ("global_cli" as const);
    const targetSupport = isApp ? appGlobalSupport : globalSupport;
    const sourceVariant = isApp ? skillVariant("project_app") : skillVariant("project_cli");
    const targetVariant = skillVariant(variant);
    const asset = fixture.deployment.assets[0];
    const context = fixture.deployment.targetContexts[0];
    if (asset?.version.canonical.kind !== "Skill" || context === undefined) {
        throw new Error("global Skill fixture is incomplete");
    }
    asset.scope = "global";
    asset.projectId = "";
    asset.version.canonical.typeData.name = targetVariant.name;
    asset.version.canonical.typeData.invocation.user.commandName = targetVariant.name;
    context.targetContextSchemaId = targetSupport.targetContextSchema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = targetSupport.targetContextSchema.schemaFingerprint;
    for (const input of fixture.dialectInputs.flatMap((entry) => entry.inputs)) {
        if (input.inputKind !== "native_representation") continue;
        for (const file of input.files) {
            file.relativePath = file.relativePath.replace(
                sourceVariant.boundary,
                targetVariant.boundary,
            ) as typeof file.relativePath;
            if (file.relativePath === `${targetVariant.boundary}/SKILL.md` && file.contentKind === "text") {
                file.text = file.text.replace(`name: ${sourceVariant.name}`, `name: ${targetVariant.name}`);
                file.byteSize = Buffer.byteLength(file.text);
                file.contentHash = sha256Text(file.text);
            }
        }
        for (const file of input.representation.files) {
            file.relativePath = file.relativePath.replace(
                sourceVariant.boundary,
                targetVariant.boundary,
            ) as typeof file.relativePath;
            const content = input.files.find((candidate) => candidate.relativePath === file.relativePath);
            if (content !== undefined) {
                file.byteSize = content.byteSize;
                file.contentHash = content.contentHash;
            }
        }
    }
    return fixture;
}

function materializationInput(
    analysisInput: RenderAnalysisInput,
    targetSupport: SkillSupport = support,
): RenderMaterializationInput {
    const analysis = targetSupport.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("Skill graph analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(targetSupport.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Skill graph target profile is missing");
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
    variant: SkillVariant = "project_cli",
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Skill graph output unit missing");
    const selected = skillVariant(variant);
    const applied = nativeFilesFor(canonicalFiles(), variant);
    const current = nativeFilesFor(changedCanonicalFiles(), variant);
    const files = applied.map((appliedFile) => {
        const currentFile = current.find((file) => file.relativePath === appliedFile.relativePath);
        if (currentFile === undefined || currentFile.contentKind !== appliedFile.contentKind) throw new Error("graph mismatch");
        const fileId = canonicalFiles().find(
            (file) => `${selected.boundary}/${file.file.logicalPath}` === appliedFile.relativePath,
        )?.file.fileId;
        if (fileId === undefined) throw new Error("canonical graph mismatch");
        const appliedContent =
            appliedFile.contentKind === "text"
                ? { contentKind: "text" as const, text: appliedFile.text }
                : { contentKind: "binary" as const, bytes: new Uint8Array(appliedFile.bytes) };
        const currentContent =
            currentFile.contentKind === "text"
                ? { contentKind: "text" as const, text: currentFile.text }
                : { contentKind: "binary" as const, bytes: new Uint8Array(currentFile.bytes) };
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
                            (item.subject.subjectKind === "file" && item.subject.fileId === fileId),
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
                    boundary: { relativePath: selected.boundary, boundaryKind: "directory_inventory" },
                    currentDescendantPaths: current.map((file) => file.relativePath),
                },
            ],
        },
        files,
        inventoryDeltas: [],
    };
}

function canonicalFiles(): AssetVersionFileContentV2[] {
    return [
        binaryFile("assets/marker.bin", BINARY, "44444444-4444-4444-8444-444444444444"),
        textFile("SKILL.md", ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        textFile("scripts/marker.py", SCRIPT, "33333333-3333-4333-8333-333333333333", "resource", false),
    ];
}

function changedCanonicalFiles(): AssetVersionFileContentV2[] {
    return [
        binaryFile("assets/marker.bin", CHANGED_BINARY, "44444444-4444-4444-8444-444444444444"),
        textFile("SKILL.md", CHANGED_ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        textFile("scripts/marker.py", CHANGED_SCRIPT, "33333333-3333-4333-8333-333333333333", "resource", true),
    ];
}

type SkillVariant = "project_cli" | "project_app" | "global_cli" | "global_app";

function skillVariant(variant: SkillVariant): { boundary: string; header: string; name: string } {
    switch (variant) {
        case "project_cli":
            return { boundary: BOUNDARY, header: HEADER, name: "oaam-phase53-graph-skill" };
        case "project_app":
            return { boundary: APP_BOUNDARY, header: APP_HEADER, name: "oaam-phase53-app-graph-skill" };
        case "global_cli": {
            const name = "oaam-phase53-global-graph-skill";
            return {
                boundary: GLOBAL_BOUNDARY,
                header: HEADER.replace("name: oaam-phase53-graph-skill", `name: ${name}`),
                name,
            };
        }
        case "global_app": {
            const name = "oaam-phase53-app-global-graph-skill";
            return {
                boundary: APP_GLOBAL_BOUNDARY,
                header: HEADER.replace("name: oaam-phase53-graph-skill", `name: ${name}`),
                name,
            };
        }
    }
}

function nativeFilesFor(files: AssetVersionFileContentV2[], variant: SkillVariant = "project_cli") {
    const selected = skillVariant(variant);
    return files
        .map((file) => {
            const relativePath = `${selected.boundary}/${file.file.logicalPath}`;
            if (file.contentKind === "binary") return nativeBinary(relativePath, file.bytes, file.file.executable);
            const text = file.file.role === "entry" ? `${selected.header}${file.text}` : file.text;
            return nativeText(relativePath, text, file.file.executable);
        })
        .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
}

function validateNative(files: AssetVersionFileContentV2[], nativeFiles: ReturnType<typeof nativeFilesFor>): boolean {
    return validateClaudeCodeNativeDialect({
        canonical: skillCanonical(),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: "claudecode-skill-directory-v1",
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

function skillCanonical(): Extract<AssetKindTypeDataV2, { kind: "Skill" }> {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name: "oaam-phase53-graph-skill",
            description: "OAAM Claude Code graph Skill",
            whenToUse: "",
            entryDialectId: "claudecode-skill-markdown-v1",
            portableMetadata: { license: "", compatibility: "", metadata: {} },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: "oaam-phase53-graph-skill" },
                model: { mode: "disabled" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        },
    };
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

function semantic(kind: string, versionId: string, subjectKind: "asset" | "file", fileId?: string) {
    return {
        semanticRefFingerprint: sha256Text(`${kind}:${fileId ?? "asset"}`),
        consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: fileId as string },
        semanticKind: kind,
    };
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

function requiredTargetContextSchema(targetContextSchemaId: string): string {
    const schema = claudecodeProvider.targetContextSchemas.find(
        (candidate) => candidate.targetContextSchemaId === targetContextSchemaId,
    );
    if (schema === undefined) throw new Error(`Claude Code target context schema is missing: ${targetContextSchemaId}`);
    return schema.targetContextSchemaId;
}
