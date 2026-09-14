import { describe, expect, it } from "vitest";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { computeVersionNativeRepresentationFingerprint } from "../../../../core/src/foundation/fingerprint";
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import { OPENCODE_CLI_SKILL_REBASE_MATERIALIZER } from "../src/opencode-target-skill";
import { assertDerivedSkillReverse } from "./opencode-canonical-skill-reverse-controls";

import {
    analysisFixture,
    BUILD_HASH,
    bindExactBuild,
    CHANGED_BINARY,
    CHANGED_ENTRY_BODY,
    CHANGED_REFERENCE,
    CHANGED_SCRIPT,
    canonicalEntryPattern,
    canonicalFiles,
    canonicalMaterializationFixture,
    changedCanonicalFiles,
    changedInspection,
    ENTRY_BODY,
    HASH,
    materializationInput,
    nativeDescriptor,
    nativeFilesFor,
    nativeInput,
    sha256Bytes,
    skillBoundary,
    skillCanonical,
    supports,
    VARIANTS,
    validateMaterializedNative,
    validateNative,
} from "./opencode-skill-target-test-fixtures";

describe("OpenCode CLI exact Skill targets", () => {
    it.each(
        VARIANTS.flatMap((variant) => [1, 2].map((schemaVersion) => ({ variant, schemaVersion }))),
    )("restores and rebases $variant with native carrier $schemaVersion", async ({ variant, schemaVersion }) => {
        for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
            const files = inputRole === "current_exact" ? canonicalFiles(variant) : changedCanonicalFiles(variant);
            const fixture = analysisFixture(variant, inputRole, files);
            if (schemaVersion === 2) {
                const native = nativeInput(fixture);
                const { representationFingerprint: _hash, ...metadata } = native.representation;
                const directories = [
                    ...new Set([
                        ...native.files.map((file) => file.relativePath.slice(0, file.relativePath.lastIndexOf("/"))),
                        `${skillBoundary(variant)}/empty`,
                    ]),
                ].sort();
                const envelope = { ...metadata, schemaVersion: 2 as const, directories };
                native.representation = {
                    ...envelope,
                    representationFingerprint: computeVersionNativeRepresentationFingerprint({
                        ...envelope,
                        files: native.files.map(nativeDescriptor),
                    }),
                };
                expect((await opencodeProvider.analyzeRender(fixture)).outputUnits[0]?.managedDirectoryBoundaries).toMatchObject([
                    { schemaVersion: 2, desiredDirectoryPaths: directories },
                ]);
            }
            expect(await opencodeProvider.analyzeRender(fixture)).toMatchObject({
                status: "complete",
                blockedSemanticRefs: [],
                diagnostics: [],
            });
            const materialized = await opencodeProvider.materializeRender(materializationInput(fixture, variant));
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

    it("composes the 1.17.11 CLI project-Skill consumer floor with target and reverse", async () => {
        const fixture = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        bindExactBuild(fixture, "project_folder", "1.17.11");
        expect(await opencodeProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = materializationInput(fixture, "project_folder");
        await expect(opencodeProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        const inspection = await opencodeProvider.inspectRenderedTarget(
            changedInspection(fixture, materialization, "project_folder"),
        );
        expect(inspection.status).toBe("complete");
        expect(inspection.files.every((file) => file.attributionState === "uniquely_attributable")).toBe(true);
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

    it("attributes entry, text, binary, and executable reverse changes and rejects frontmatter drift", async () => {
        const fixture = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const materialization = materializationInput(fixture, "project_folder");
        const changed = changedInspection(fixture, materialization, "project_folder");
        const inspected = await opencodeProvider.inspectRenderedTarget(changed);
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
        expect(await opencodeProvider.inspectRenderedTarget(drifted)).toMatchObject({
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
        if (driftedEntry === undefined || driftedState === undefined || driftedState.state !== "changed")
            throw new Error("Skill entry fixture is missing");
        driftedEntry.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1, 2, 3) };
        driftedState.currentContentHash = sha256Bytes(Uint8Array.of(1, 2, 3));
        expect(supports.projectFolder.inspect(contentKindDrift)).toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({ relativePath: expect.stringMatching(/SKILL\.md$/), attributionState: "conflict" }),
            ]),
        });
    });

    it.each(VARIANTS)("preserves an already-direct portable canonical graph in the stable %s target", async (variant) => {
        const fixture = canonicalMaterializationFixture(variant);
        const analysis = await opencodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.semanticOptions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "preserved",
                    reasonCode: "opencode_skill_reviewed_canonical_conversion",
                    approvalRequirement: { approvalState: "not_required" },
                    diagnostics: [],
                }),
            ]),
        );
        const request = materializationInput(fixture, variant);
        const result = await opencodeProvider.materializeRender(request);
        assertCanonicalEntryControls(opencodeProvider, request, result);
        await assertDerivedSkillReverse(request);
        expect(result).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: expect.arrayContaining([
                        expect.objectContaining({
                            relativePath: expect.stringMatching(canonicalEntryPattern(variant)),
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

        const noPortableMetadataFixture = canonicalMaterializationFixture("global_config_folder");
        const noPortableMetadata = materializationInput(noPortableMetadataFixture, "global_config_folder");
        const portableCanonical = noPortableMetadata.deployment.assets[0]?.version.canonical;
        if (portableCanonical?.kind !== "Skill") throw new Error("Skill canonical fixture is missing");
        portableCanonical.typeData.portableMetadata = { license: "", compatibility: "", metadata: {} };
        expect(supports.globalConfigFolder.materialize(noPortableMetadata)).toMatchObject({
            materializationState: "materialized",
        });

        const orderedMetadataFixture = canonicalMaterializationFixture("shared_directory_folder");
        const orderedMetadata = materializationInput(orderedMetadataFixture, "shared_directory_folder");
        const orderedCanonical = orderedMetadata.deployment.assets[0]?.version.canonical;
        if (orderedCanonical?.kind !== "Skill") throw new Error("Skill canonical fixture is missing");
        orderedCanonical.typeData.portableMetadata.metadata = { zeta: "last", alpha: "first" };
        expect(supports.sharedDirectoryFolder.materialize(orderedMetadata)).toMatchObject({
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: expect.arrayContaining([
                        expect.objectContaining({
                            content: {
                                contentKind: "text",
                                text: expect.stringMatching(/metadata:\n {2}"alpha": "first"\n {2}"zeta": "last"/),
                            },
                        }),
                    ]),
                },
            ],
        });
    });

    it("revalidates parent-rebase authority at materialization time", () => {
        expect(OPENCODE_CLI_SKILL_REBASE_MATERIALIZER.materialize({ assetKind: "Rule" } as never)).toBeNull();
        expect(
            OPENCODE_CLI_SKILL_REBASE_MATERIALIZER.materialize({
                assetKind: "Skill",
                nativeDialectId: OPENCODE_NATIVE_DIALECTS.skillCli,
                targetCanonical: skillCanonical("oaam-empty-parent"),
                restorationInputs: [],
                parent: { files: [] },
                targetFiles: canonicalFiles("project_folder"),
            } as never),
        ).toBeNull();

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
        const resource = misplacedEntry.deployment.assets[0]?.version.files[2];
        if (entry === undefined || resource === undefined) throw new Error("Skill graph fixture is missing");
        entry.file.role = "resource";
        resource.file.role = "entry";
        expect(supports.projectFolder.materialize(misplacedEntry)).toMatchObject({ materializationState: "blocked" });
    });

    it("labels a compatible newer build without relabelling the exact evidence anchor", async () => {
        const newer = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const newerContext = newer.deployment.targetContexts[0];
        if (newerContext === undefined) throw new Error("target context is missing");
        newerContext.versionText = "1.18.16";
        newerContext.buildIdentity = `sha256:${"9".repeat(64)}`;
        expect(await opencodeProvider.analyzeRender(newer)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred" })],
        });

        expect(supports.projectFolder.renderContractDeclaration.verifiedBuilds).toHaveLength(3);
        expect(supports.projectFolder.renderContractDeclaration.verifiedBuilds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ versionText: "1.18.15", buildIdentity: BUILD_HASH, platform: "wsl" }),
                expect.objectContaining({
                    versionText: "1.17.11",
                    buildIdentity: "sha256:0254a429cd0e6cf0ba53fc01672cf98e4a8dc728f7fa94be88f1e4b3645e6ded",
                    platform: "wsl",
                }),
            ]),
        );
    });

    it("fails closed for mixed scope, wrong roots, unsafe graphs, foreign restoration, and wrong dialect conversion", async () => {
        const mixed = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const second = structuredClone(mixed.deployment.assets[0]);
        if (second === undefined) throw new Error("Skill fixture is missing");
        second.scope = "global";
        second.projectId = "";
        mixed.deployment.assets.push(second);
        expect(await opencodeProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "opencode_skill_target_shape_ambiguous" })],
        });

        for (const path of [
            ".gemini/skills/oaam/SKILL.md",
            "skills/oaam/SKILL.md",
            "skills/oaam/../escape.md",
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

        const emptyGraph = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const emptyNative = nativeInput(emptyGraph);
        emptyNative.files = [];
        expect(supports.projectFolder.analyze(emptyGraph).status).toBe("failed");

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

        const wrongDialect = canonicalMaterializationFixture("project_folder");
        const token = wrongDialect.dialectInputs[0]?.inputs[0];
        if (token?.inputKind !== "canonical_materialization") throw new Error("canonical token is missing");
        token.nativeDialectId = OPENCODE_NATIVE_DIALECTS.commandWorkflow;
        expect(await opencodeProvider.analyzeRender(wrongDialect)).toMatchObject({ status: "failed" });
    });
});
