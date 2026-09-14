import { describe, expect, it } from "vitest";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { computeVersionNativeRepresentationFingerprint } from "../../../core/src/foundation/fingerprint";

import { cursorProvider } from "../src/cursor-provider";
import { CURSOR_NATIVE_DIALECTS } from "../src/cursor-source-read-model";

import { CURSOR_SKILL_REBASE_MATERIALIZER, CURSOR_SKILL_TARGET_COMPONENTS } from "../src/cursor-target-skill";

import {
    HASH,
    BUILD_HASH,
    APP_LINUX_BUILD,
    APP_WIN32_BUILD,
    ENTRY_BODY,
    CHANGED_ENTRY_BODY,
    CHANGED_SCRIPT,
    CHANGED_REFERENCE,
    CHANGED_BINARY,
    supports,
    appSupports,
    VARIANTS,
    analysisFixture,
    canonicalMaterializationFixture,
    materializationInput,
    changedInspection,
    canonicalFiles,
    changedCanonicalFiles,
    nativeFilesFor,
    skillBoundary,
    canonicalEntryPattern,
    validateNative,
    validateMaterializedNative,
    nativeInput,
    contentHash,
    sha256Bytes,
} from "./cursor-skill-target-test-fixtures";

describe("Cursor Agent CLI exact Skill targets", () => {
    it("registers project, global-config, and direct-directory contracts for the exact WSL build", () => {
        expect(
            cursorProvider.assetTargetCapabilities.filter(
                (row) =>
                    row.agentRuntimeId === "CURSOR_AGENT_CLI" &&
                    row.assetKind === "Skill" &&
                    row.entrySupportStatus === "supported",
            ),
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                outputContractId: "CURSOR_AGENT_CLI_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                outputContractId: "CURSOR_AGENT_CLI_NATIVE_GLOBAL_CONFIG_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                outputContractId: "CURSOR_AGENT_CLI_NATIVE_GLOBAL_DIRECT_SKILL_DIRECTORY_V1",
                renderStrategy: "native_graph",
            }),
        ]);
        for (const support of Object.values(supports)) {
            expect(support.renderContractDeclaration).toMatchObject({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                assetKind: "Skill",
                buildCompatibility: {
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [],
                },
                verifiedBuilds: [
                    expect.objectContaining({ versionText: "2026.07.23-e383d2b", buildIdentity: BUILD_HASH, platform: "wsl" }),
                ],
            });
        }
        expect(
            cursorProvider.dialectContracts.native
                .filter((row) => row.definition.kind === "Skill")
                .map((row) => row.definition.rebaseMaterializer),
        ).toEqual([CURSOR_SKILL_TARGET_COMPONENTS.rebase]);
    });

    it("binds independent Linux and Win32 App anchors for every complete Skill graph variant", () => {
        for (const appSupport of Object.values(appSupports)) {
            expect(appSupport.renderContractDeclaration.verifiedBuilds).toHaveLength(2);
            expect(appSupport.renderContractDeclaration.verifiedBuilds).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        platform: "linux",
                        versionText: "3.13.25",
                        buildIdentity: APP_LINUX_BUILD,
                    }),
                    expect.objectContaining({
                        platform: "win32",
                        versionText: "3.12.30",
                        buildIdentity: APP_WIN32_BUILD,
                    }),
                ]),
            );
        }
    });

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
                    representationFingerprint: computeVersionNativeRepresentationFingerprint(envelope),
                };
                expect((await cursorProvider.analyzeRender(fixture)).outputUnits[0]?.managedDirectoryBoundaries).toMatchObject([
                    { schemaVersion: 2, desiredDirectoryPaths: directories },
                ]);
            }
            expect(await cursorProvider.analyzeRender(fixture)).toMatchObject({
                status: "complete",
                blockedSemanticRefs: [],
                diagnostics: [],
            });
            const materialized = await cursorProvider.materializeRender(materializationInput(fixture, variant));
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

    it("attributes entry, text, binary, and executable reverse changes and rejects frontmatter drift", async () => {
        const fixture = analysisFixture("project_folder", "current_exact", canonicalFiles("project_folder"));
        const materialization = materializationInput(fixture, "project_folder");
        const changed = changedInspection(fixture, materialization, "project_folder");
        const inspected = await cursorProvider.inspectRenderedTarget(changed);
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
        entry.currentContent.text = entry.currentContent.text.replace(
            "disable-model-invocation: true",
            "disable-model-invocation: false",
        );
        expect(await cursorProvider.inspectRenderedTarget(drifted)).toMatchObject({
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

    it.each(
        VARIANTS,
    )("materializes an expressible canonical-only graph into the stable %s target without loss approval", async (variant) => {
        const fixture = canonicalMaterializationFixture(variant);
        expect(fixture.dialectInputs[0]!.inputs[0]).not.toHaveProperty("nativePreservationSeed");
        const analysis = await cursorProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.semanticOptions.length).toBeGreaterThan(0);
        expect(
            analysis.semanticOptions.every(
                (option) => option.outcome === "preserved" && option.approvalRequirement.approvalState === "not_required",
            ),
        ).toBe(true);
        const request = materializationInput(fixture, variant);
        const result = await cursorProvider.materializeRender(request);
        assertCanonicalEntryControls(cursorProvider, request, result);
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
    });

    it("revalidates parent-rebase authority at materialization time", () => {
        expect(CURSOR_SKILL_REBASE_MATERIALIZER.materialize({ assetKind: "Rule" } as never)).toBeNull();

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
        newerContext.versionText = "2026.08.01-e999999";
        newerContext.buildIdentity = `sha256:${"9".repeat(64)}`;
        expect(await cursorProvider.analyzeRender(newer)).toMatchObject({
            status: "complete",
            diagnostics: [expect.objectContaining({ code: "cursor_target_build_compatible_unverified" })],
        });

        expect(supports.projectFolder.renderContractDeclaration.verifiedBuilds).toHaveLength(1);
        expect(supports.projectFolder.renderContractDeclaration.verifiedBuilds).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ versionText: "2026.07.23-e383d2b", buildIdentity: BUILD_HASH, platform: "wsl" }),
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
        expect(await cursorProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "cursor_skill_target_shape_ambiguous" })],
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
        token.nativeDialectId = CURSOR_NATIVE_DIALECTS.commandWorkflow;
        expect(await cursorProvider.analyzeRender(wrongDialect)).toMatchObject({ status: "failed" });
    });
});
