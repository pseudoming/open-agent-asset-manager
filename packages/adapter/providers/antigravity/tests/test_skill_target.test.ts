import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    MaterializedRenderFile,
    NativeProjectExactGraphRebaseInput,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { antigravityProvider } from "../src/antigravity-provider";
import { ANTIGRAVITY_NATIVE_DIALECTS } from "../src/antigravity-source-read-model";
import { validateAntigravityNativeDialect } from "../src/antigravity-source-read-native";
import {
    ANTIGRAVITY_SKILL_REBASE_MATERIALIZER,
    ANTIGRAVITY_SKILL_TARGET_COMPONENTS,
    createAntigravitySkillTargetSupports,
} from "../src/antigravity-target-skill";

type SkillVariant = "project_folder" | "global_folder";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const BUILD_HASH = "sha256:4217db798fd514cedce4e315013daea471a1a67666ab91547b2ad0dbee167a71";
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const ENTRY_BODY = "Use the bundled resources. OAAM_AGY_SKILL_GRAPH_41A7D2\n";
const CHANGED_ENTRY_BODY = ENTRY_BODY.replace("41A7D2", "99C4E1");
const SCRIPT = "print('OAAM_AGY_RESOURCE_V1')\n";
const CHANGED_SCRIPT = "print('OAAM_AGY_RESOURCE_V2')\n";
const REFERENCE = "OAAM_AGY_REFERENCE_V1\n";
const CHANGED_REFERENCE = "OAAM_AGY_REFERENCE_V2\n";
const BINARY = Uint8Array.of(0, 255, 1, 2);
const CHANGED_BINARY = Uint8Array.of(0, 255, 4, 5);

const projectSchema = antigravityProvider.targetContextSchemas.find(
    (row) => row.targetContextSchemaId === "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1",
);
if (projectSchema === undefined) throw new Error("Antigravity project target schema is missing");
const supports = createAntigravitySkillTargetSupports({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
    projectTargetContextSchemaId: projectSchema.targetContextSchemaId,
});

describe("Antigravity CLI exact Skill targets", () => {
    it("registers project and global folder contracts for the exact current build", () => {
        expect(antigravityProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Skill")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                outputContractId: "ANTIGRAVITY_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                outputContractId: "ANTIGRAVITY_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                outputContractId: "ANTIGRAVITY_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                outputContractId: "ANTIGRAVITY_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_IDE",
                outputContractId: "ANTIGRAVITY_IDE_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_IDE",
                outputContractId: "ANTIGRAVITY_IDE_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
        ]);
        for (const support of Object.values(supports)) {
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                assetKind: "Skill",
                buildCompatibility: {
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [],
                },
                verifiedBuilds: [expect.objectContaining({ versionText: "1.1.10", buildIdentity: BUILD_HASH, platform: "wsl" })],
            });
        }
        expect(
            antigravityProvider.dialectContracts.native
                .filter((row) => row.definition.kind === "Skill")
                .map((row) => row.definition.rebaseMaterializer),
        ).toEqual([ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase, ANTIGRAVITY_SKILL_TARGET_COMPONENTS.rebase]);
    });

    it.each([
        "project_folder",
        "global_folder",
    ] as const)("restores current-exact bytes and rebases the complete %s graph", async (variant) => {
        for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
            const files = inputRole === "current_exact" ? canonicalFiles(variant) : changedCanonicalFiles(variant);
            const fixture = analysisFixture(variant, inputRole, files);
            expect(await antigravityProvider.analyzeRender(fixture)).toMatchObject({
                status: "complete",
                blockedSemanticRefs: [],
                diagnostics: [],
            });
            const materialized = await antigravityProvider.materializeRender(materializationInput(fixture, variant));
            expect(materialized).toMatchObject({
                status: "complete",
                materializationState: "materialized",
                materializedUnits: [
                    {
                        files: expect.arrayContaining(
                            nativeFilesFor(files, variant).map((file) =>
                                expect.objectContaining({
                                    relativePath: file.relativePath,
                                    executable: file.executable,
                                }),
                            ),
                        ),
                    },
                ],
            });
        }
    });

    it("preserves entry frontmatter while rebasing text, binary, and executable resources", () => {
        const fixture = analysisFixture("project_folder", "parent_rebase_seed", changedCanonicalFiles("project_folder"));
        const result = supports.projectFolder.materialize(materializationInput(fixture, "project_folder"));
        expect(result).toMatchObject({
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        { content: { text: expect.stringContaining(CHANGED_ENTRY_BODY) } },
                        { content: { bytes: CHANGED_BINARY } },
                        { content: { text: CHANGED_REFERENCE } },
                        { content: { text: CHANGED_SCRIPT }, executable: true },
                    ],
                },
            ],
        });
        expect(
            validateNative(
                changedCanonicalFiles("project_folder"),
                nativeFilesFor(changedCanonicalFiles("project_folder"), "project_folder"),
                "project_folder",
            ),
        ).toBe(true);
    });

    it("preserves the historical flat source dialect without registering a flat target", () => {
        const nativeFile = nativeText(
            `.agents/skills/${skillName("project_folder")}.md`,
            `${skillHeader("project_folder")}${ENTRY_BODY}`,
            false,
        );
        const input: NativeProjectExactGraphRebaseInput = {
            assetKind: "Skill",
            nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFlat,
            targetCanonical: skillCanonical(skillName("project_folder")),
            targetFiles: [textFile("SKILL.md", CHANGED_ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false)],
            parent: {
                sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                representation: {
                    schemaVersion: 1,
                    dialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFlat,
                    dialectContractFingerprint: HASH,
                    canonicalContentFingerprint: HASH,
                    representationFingerprint: HASH,
                },
                files: [nativeFile],
            },
            restorationInputs: [],
        };
        expect(ANTIGRAVITY_SKILL_REBASE_MATERIALIZER.materialize(input)).toMatchObject({
            nativeFiles: [
                {
                    relativePath: nativeFile.relativePath,
                    contentKind: "text",
                    text: `${skillHeader("project_folder")}${CHANGED_ENTRY_BODY}`,
                },
            ],
        });
        expect(
            ANTIGRAVITY_SKILL_REBASE_MATERIALIZER.materialize({
                ...input,
                parent: { ...input.parent, files: [nativeFile, structuredClone(nativeFile)] },
            }),
        ).toBeNull();
        expect(
            antigravityProvider.renderContractDeclarations.some(
                (row) => row.assetKind === "Skill" && row.nativeDialectId === ANTIGRAVITY_NATIVE_DIALECTS.skillFlat,
            ),
        ).toBe(false);
    });

    it("attributes entry, text, binary, and executable reverse changes and rejects frontmatter drift", async () => {
        const fixture = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const materialization = materializationInput(fixture, "project_folder");
        const changed = changedInspection(fixture, materialization, "project_folder");
        const inspected = await antigravityProvider.inspectRenderedTarget(changed);
        expect(inspected.status).toBe("complete");
        expect(inspected.files.every((file) => file.attributionState === "uniquely_attributable")).toBe(true);
        expect(inspected.changes).toEqual(
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

        const drifted = changedInspection(fixture, materialization, "project_folder");
        const entry = drifted.files.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (entry?.currentContent.contentKind !== "text") throw new Error("Skill entry fixture is missing");
        entry.currentContent.text = entry.currentContent.text.replace("license: MIT", "license: Apache-2.0");
        expect(await antigravityProvider.inspectRenderedTarget(drifted)).toMatchObject({
            status: "complete",
            files: expect.arrayContaining([
                expect.objectContaining({
                    relativePath: expect.stringMatching(/SKILL\.md$/),
                    attributionState: "conflict",
                    reasonCode: "native_project_exact_graph_content_not_reconcilable",
                }),
            ]),
        });

        const contentKindDrift = changedInspection(fixture, materialization, "project_folder");
        const driftedEntry = contentKindDrift.files.find((file) => file.relativePath.endsWith("/SKILL.md"));
        const driftedState = contentKindDrift.inspectionScope.fileStates.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (driftedEntry === undefined || driftedState === undefined) throw new Error("Skill entry fixture is missing");
        driftedEntry.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1, 2, 3) };
        driftedState.currentContentHash = sha256Bytes(Uint8Array.of(1, 2, 3));
        expect(supports.projectFolder.inspect(contentKindDrift)).toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({ relativePath: expect.stringMatching(/SKILL\.md$/), attributionState: "conflict" }),
            ]),
        });
    });

    it.each([
        "project_folder",
        "global_folder",
    ] as const)("materializes a reviewed foreign canonical graph into the stable %s target", async (variant) => {
        const fixture = canonicalMaterializationFixture(variant);
        const analysis = await antigravityProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.semanticOptions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "degraded",
                    reasonCode: "antigravity_skill_reviewed_canonical_conversion",
                    degradationKinds: [
                        "permission_or_tool_boundary_lost",
                        "runtime_specific_metadata_lost",
                        "trigger_or_loading_level_lost",
                    ],
                    approvalRequirement: expect.objectContaining({ approvalState: "required" }),
                }),
            ]),
        );
        const request = materializationInput(fixture, variant);
        const result = await antigravityProvider.materializeRender(request);
        assertCanonicalEntryControls(antigravityProvider, request, result);
        expect(result).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: expect.arrayContaining([
                        expect.objectContaining({
                            relativePath: expect.stringMatching(
                                variant === "project_folder"
                                    ? /^\.agents\/skills\/oaam-skill-11111111\/SKILL\.md$/
                                    : /^config\/skills\/oaam-skill-11111111\/SKILL\.md$/,
                            ),
                            content: { contentKind: "text", text: expect.stringContaining(ENTRY_BODY) },
                        }),
                    ]),
                },
            ],
        });
        if (result.materializationState !== "materialized" || result.materializedUnits[0] === undefined) {
            throw new Error("reviewed canonical Skill graph did not materialize");
        }
        expect(validateMaterializedNative(canonicalFiles(variant), result.materializedUnits[0].files, variant)).toBe(true);
    });

    it("blocks malformed reviewed canonical graphs during materialization", () => {
        const invalidTypeDataFixture = canonicalMaterializationFixture("project_folder");
        const invalidTypeData = materializationInput(invalidTypeDataFixture, "project_folder");
        const invalidCanonical = invalidTypeData.deployment.assets[0]?.version.canonical;
        if (invalidCanonical?.kind !== "Skill") throw new Error("Skill canonical fixture is missing");
        invalidCanonical.typeData.description = "";
        expect(supports.projectFolder.materialize(invalidTypeData)).toMatchObject({ materializationState: "blocked" });

        const duplicatePathFixture = canonicalMaterializationFixture("project_folder");
        const duplicatePath = materializationInput(duplicatePathFixture, "project_folder");
        const duplicateFiles = duplicatePath.deployment.assets[0]?.version.files;
        if (duplicateFiles?.[1] === undefined) throw new Error("Skill resource fixture is missing");
        duplicateFiles[1].file.logicalPath = "SKILL.md";
        expect(supports.projectFolder.materialize(duplicatePath)).toMatchObject({ materializationState: "blocked" });

        const noPortableMetadataFixture = canonicalMaterializationFixture("global_folder");
        const noPortableMetadata = materializationInput(noPortableMetadataFixture, "global_folder");
        const portableCanonical = noPortableMetadata.deployment.assets[0]?.version.canonical;
        if (portableCanonical?.kind !== "Skill") throw new Error("Skill canonical fixture is missing");
        portableCanonical.typeData.portableMetadata = { license: "", compatibility: "", metadata: {} };
        expect(supports.globalFolder.materialize(noPortableMetadata)).toMatchObject({ materializationState: "materialized" });
    });

    it("revalidates parent-rebase authority at materialization time", () => {
        expect(ANTIGRAVITY_SKILL_REBASE_MATERIALIZER.materialize({ assetKind: "Rule" } as never)).toBeNull();

        const restorationFixture = analysisFixture(
            "project_folder",
            "parent_rebase_seed",
            changedCanonicalFiles("project_folder"),
        );
        const restoration = materializationInput(restorationFixture, "project_folder");
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.projectFolder.materialize(restoration)).toMatchObject({ materializationState: "blocked" });

        const missingPathFixture = analysisFixture(
            "project_folder",
            "parent_rebase_seed",
            changedCanonicalFiles("project_folder"),
        );
        const missingPath = materializationInput(missingPathFixture, "project_folder");
        const missingFile = missingPath.deployment.assets[0]?.version.files[1];
        if (missingFile === undefined) throw new Error("Skill resource fixture is missing");
        missingFile.file.logicalPath = "references/missing.txt";
        expect(supports.projectFolder.materialize(missingPath)).toMatchObject({ materializationState: "blocked" });

        const misplacedEntryFixture = analysisFixture(
            "project_folder",
            "parent_rebase_seed",
            changedCanonicalFiles("project_folder"),
        );
        const misplacedEntry = materializationInput(misplacedEntryFixture, "project_folder");
        const entry = misplacedEntry.deployment.assets[0]?.version.files[0];
        const resource = misplacedEntry.deployment.assets[0]?.version.files[1];
        if (entry === undefined || resource === undefined) throw new Error("Skill graph fixture is missing");
        entry.file.role = "resource";
        resource.file.role = "entry";
        expect(supports.projectFolder.materialize(misplacedEntry)).toMatchObject({ materializationState: "blocked" });
    });

    it("labels a compatible newer build without relabelling the exact evidence anchor", async () => {
        const newer = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const newerContext = newer.deployment.targetContexts[0];
        if (newerContext === undefined) throw new Error("target context is missing");
        newerContext.versionText = "1.1.11";
        newerContext.buildIdentity = `sha256:${"9".repeat(64)}`;
        expect(await antigravityProvider.analyzeRender(newer)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "antigravity_target_build_compatibility_inferred" })],
        });

        expect(supports.projectFolder.renderContractDeclaration.verifiedBuilds).toEqual([
            expect.objectContaining({ versionText: "1.1.10", buildIdentity: BUILD_HASH }),
        ]);
    });

    it("fails closed for mixed scope, wrong roots, unsafe graphs, foreign restoration, and canonical flat conversion", async () => {
        const mixed = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const second = structuredClone(mixed.deployment.assets[0]);
        if (second === undefined) throw new Error("Skill fixture is missing");
        second.scope = "global";
        second.projectId = "";
        mixed.deployment.assets.push(second);
        expect(await antigravityProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "antigravity_skill_target_shape_ambiguous" })],
        });

        for (const path of [
            ".gemini/skills/oaam/SKILL.md",
            "skills/oaam/SKILL.md",
            "config/skills/oaam/../escape.md",
            ".agents/skills/oaam/../../escape.md",
        ]) {
            const outside = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
            const native = nativeInput(outside);
            if (native.files[0] === undefined) throw new Error("native Skill fixture is missing");
            native.files[0].relativePath = path;
            expect(supports.projectFolder.analyze(outside).status).toBe("failed");
        }

        const duplicate = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const duplicateFile = nativeInput(duplicate).files[0];
        if (duplicateFile === undefined) throw new Error("native Skill fixture is missing");
        nativeInput(duplicate).files.push(structuredClone(duplicateFile));
        expect(supports.projectFolder.analyze(duplicate).status).toBe("failed");

        const restoration = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.projectFolder.analyze(restoration).status).toBe("failed");

        const flatCanonical = canonicalMaterializationFixture("project_folder");
        const token = flatCanonical.dialectInputs[0]?.inputs[0];
        if (token?.inputKind !== "canonical_materialization") throw new Error("canonical token is missing");
        token.nativeDialectId = ANTIGRAVITY_NATIVE_DIALECTS.skillFlat;
        expect(await antigravityProvider.analyzeRender(flatCanonical)).toMatchObject({ status: "failed" });
    });
});

function supportFor(variant: SkillVariant) {
    return variant === "project_folder" ? supports.projectFolder : supports.globalFolder;
}

function analysisFixture(
    variant: SkillVariant,
    inputRole: "current_exact" | "parent_rebase_seed",
    files: AssetVersionFileContentV2[],
): RenderAnalysisInput {
    const support = supportFor(variant);
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const baseFiles = inputRole === "current_exact" ? files : canonicalFiles(variant);
    const nativeFiles = nativeFilesFor(baseFiles, variant);
    const native = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(nativeDescriptor),
        },
        files: nativeFiles,
    };
    return baseAnalysisFixture(
        variant,
        versionId,
        files,
        [
            inputRole === "current_exact"
                ? native
                : {
                      ...native,
                      inputRole: "parent_rebase_seed" as const,
                      sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                  },
        ],
        support,
    );
}

function canonicalMaterializationFixture(variant: "project_folder" | "global_folder"): RenderAnalysisInput {
    const support = supportFor(variant);
    const declaration = support.renderContractDeclaration.canonicalMaterialization;
    if (declaration === undefined) throw new Error("canonical Skill materializer is missing");
    return baseAnalysisFixture(
        variant,
        VERSION_ID,
        canonicalFiles(variant),
        [
            {
                inputKind: "canonical_materialization",
                nativeDialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
                materializer: declaration.materializer,
                degradationKinds: [...declaration.degradationKinds],
                reasonCode: declaration.reasonCode,
            },
        ],
        support,
    );
}

function baseAnalysisFixture(
    variant: SkillVariant,
    versionId: string,
    files: AssetVersionFileContentV2[],
    inputs: RenderAnalysisInput["dialectInputs"][number]["inputs"],
    support: ReturnType<typeof supportFor>,
): RenderAnalysisInput {
    const scope = variant === "global_folder" ? ("global" as const) : ("project" as const);
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
                    versionText: "1.1.10",
                    buildIdentity: BUILD_HASH,
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
                            : []),
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
                        canonical: skillCanonical(skillName(variant)),
                        files: structuredClone(files),
                    },
                    sectionHandles: Object.fromEntries(files.map((file) => [file.file.fileId, `skill-${file.file.logicalPath}`])),
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", versionId, "asset"),
            semantic("skill.discovery_metadata", versionId, "asset"),
            ...files.map((file) =>
                semantic(file.file.role === "entry" ? "skill.body" : "skill.resource", versionId, "file", file.file.fileId),
            ),
        ] as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [
            { targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"], inputs },
        ],
    };
}

function materializationInput(fixture: RenderAnalysisInput, variant: SkillVariant): RenderMaterializationInput {
    const support = supportFor(variant);
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete") throw new Error("Skill graph analysis fixture did not close");
    const contract = makeNativeProjectExactGraphContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Skill graph materialization profile is missing");
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
    variant: SkillVariant,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Skill graph output unit is missing");
    const baseCanonical = canonicalFiles(variant);
    const changedCanonical = changedCanonicalFiles(variant);
    const applied = nativeFilesFor(baseCanonical, variant);
    const current = nativeFilesFor(changedCanonical, variant);
    const files = applied.map((appliedFile) => {
        const currentFile = current.find((file) => file.relativePath === appliedFile.relativePath);
        if (currentFile === undefined || currentFile.contentKind !== appliedFile.contentKind) throw new Error("graph mismatch");
        const fileId = baseCanonical.find(
            (file) => `${skillBoundary(variant)}/${file.file.logicalPath}` === appliedFile.relativePath,
        )?.file.fileId;
        if (fileId === undefined) throw new Error("canonical graph mismatch");
        const appliedContent = fileContent(appliedFile);
        const currentContent = fileContent(currentFile);
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
            attributeChanges:
                appliedFile.executable === currentFile.executable
                    ? []
                    : [
                          {
                              attributeChangeFingerprint: sha256Text(`${appliedFile.relativePath}:executable`),
                              attributeKind: "executable" as const,
                              appliedValue: appliedFile.executable,
                              currentValue: currentFile.executable,
                          },
                      ],
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
                    boundary: { relativePath: skillBoundary(variant), boundaryKind: "directory_inventory" },
                    currentDescendantPaths: current.map((file) => file.relativePath),
                },
            ],
        },
        files,
        inventoryDeltas: [],
    };
}

function canonicalFiles(_variant: SkillVariant): AssetVersionFileContentV2[] {
    return [
        textFile("SKILL.md", ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        binaryFile("assets/marker.bin", BINARY, "22222222-2222-4222-8222-222222222223"),
        textFile("references/marker.txt", REFERENCE, "33333333-3333-4333-8333-333333333333", "resource", false),
        textFile("scripts/marker.py", SCRIPT, "44444444-4444-4444-8444-444444444444", "resource", false),
    ];
}

function changedCanonicalFiles(_variant: SkillVariant): AssetVersionFileContentV2[] {
    return [
        textFile("SKILL.md", CHANGED_ENTRY_BODY, "11111111-1111-4111-8111-111111111111", "entry", false),
        binaryFile("assets/marker.bin", CHANGED_BINARY, "22222222-2222-4222-8222-222222222223"),
        textFile("references/marker.txt", CHANGED_REFERENCE, "33333333-3333-4333-8333-333333333333", "resource", false),
        textFile("scripts/marker.py", CHANGED_SCRIPT, "44444444-4444-4444-8444-444444444444", "resource", true),
    ];
}

function nativeFilesFor(files: AssetVersionFileContentV2[], variant: SkillVariant) {
    const prefix = skillHeader(variant);
    return files
        .map((file) => {
            const relativePath = `${skillBoundary(variant)}/${file.file.logicalPath}`;
            if (file.contentKind === "binary") return nativeBinary(relativePath, file.bytes, file.file.executable);
            return nativeText(
                relativePath,
                file.file.role === "entry" ? `${prefix}${file.text}` : file.text,
                file.file.executable,
            );
        })
        .sort((left, right) => compareText(left.relativePath, right.relativePath));
}

function skillBoundary(variant: SkillVariant): string {
    if (variant === "global_folder") return "config/skills/oaam-phase55-global-folder-skill";
    return ".agents/skills/oaam-phase55-project-folder-skill";
}

function skillName(variant: SkillVariant): string {
    return variant === "global_folder" ? "oaam-phase55-global-folder-skill" : "oaam-phase55-project-folder-skill";
}

function skillHeader(variant: SkillVariant): string {
    return `${[
        "---",
        "# preserve Antigravity Skill layout",
        `name: ${skillName(variant)}`,
        "description: OAAM Antigravity graph Skill",
        "license: MIT",
        "compatibility: Antigravity",
        "metadata:",
        "  owner: oaam",
        "---",
    ].join("\n")}\n`;
}

function skillCanonical(name: string): Extract<AssetKindTypeDataV2, { kind: "Skill" }> {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name,
            description: "OAAM Antigravity graph Skill",
            whenToUse: "OAAM Antigravity graph Skill",
            entryDialectId: "antigravity-skill-markdown-v1",
            portableMetadata: { license: "MIT", compatibility: "Antigravity", metadata: { owner: "oaam" } },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: name },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        },
    };
}

function validateNative(
    files: AssetVersionFileContentV2[],
    nativeFiles: ReturnType<typeof nativeFilesFor>,
    variant: SkillVariant,
): boolean {
    return validateAntigravityNativeDialect({
        canonical: skillCanonical(skillName(variant)),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: nativeFiles.map(nativeDescriptor),
        },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
        })),
    });
}

function validateMaterializedNative(
    files: AssetVersionFileContentV2[],
    nativeFiles: MaterializedRenderFile[],
    variant: SkillVariant,
): boolean {
    const descriptors = nativeFiles.map((nativeFile) => {
        const canonical = files.find((file) => nativeFile.relativePath.endsWith(`/${file.file.logicalPath}`));
        if (canonical === undefined || canonical.contentKind !== nativeFile.content.contentKind) {
            throw new Error(`materialized Skill file ${nativeFile.relativePath} has no canonical owner`);
        }
        const bytes =
            nativeFile.content.contentKind === "text"
                ? new TextEncoder().encode(nativeFile.content.text)
                : new Uint8Array(nativeFile.content.bytes);
        return {
            relativePath: nativeFile.relativePath,
            contentKind: nativeFile.content.contentKind,
            mediaType: canonical.file.mediaType,
            contentHash: sha256Bytes(bytes),
            byteSize: bytes.byteLength,
            executable: nativeFile.executable,
        };
    });
    return validateAntigravityNativeDialect({
        canonical: skillCanonical(skillName(variant)),
        canonicalFiles: files,
        representation: {
            schemaVersion: 1,
            dialectId: ANTIGRAVITY_NATIVE_DIALECTS.skillFolder,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: descriptors,
        },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes:
                file.content.contentKind === "text"
                    ? new TextEncoder().encode(file.content.text)
                    : new Uint8Array(file.content.bytes),
        })),
    });
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

function nativeDescriptor(file: ReturnType<typeof nativeText> | ReturnType<typeof nativeBinary>) {
    const { text: _text, bytes: _bytes, ...descriptor } = file as typeof file & { text?: string; bytes?: Uint8Array };
    return descriptor;
}

function nativeInput(input: RenderAnalysisInput) {
    const candidate = input.dialectInputs[0]?.inputs[0];
    if (candidate?.inputKind !== "native_representation") throw new Error("native graph fixture is missing");
    return candidate;
}

function fileContent(file: ReturnType<typeof nativeText> | ReturnType<typeof nativeBinary>) {
    return file.contentKind === "text"
        ? { contentKind: "text" as const, text: file.text }
        : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
}

function semantic(kind: string, versionId: string, subjectKind: "asset" | "file", fileId?: string) {
    return {
        semanticRefFingerprint: sha256Text(`${kind}:${fileId ?? "asset"}`),
        consumerAgentRuntimeId: "ANTIGRAVITY_CLI" as const,
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: fileId as string },
        semanticKind: kind,
    };
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
