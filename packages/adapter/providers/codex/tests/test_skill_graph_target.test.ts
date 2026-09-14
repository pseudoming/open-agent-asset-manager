import { describe, expect, it } from "vitest";
import { computeVersionNativeRepresentationFingerprint } from "../../../core/src/foundation/fingerprint";

import { validateAdapterRenderContractRegistration } from "../../../core/src/render/adapter-render-contract-registration";

import { codexProvider } from "../src/codex-provider";

import {
    HASH,
    CHANGED_ENTRY_BODY,
    CHANGED_SCRIPT,
    PRIVATE_METADATA,
    CHANGED_BINARY,
    supports,
    supportFor,
    analysisFixture,
    materializationInput,
    changedInspection,
    canonicalFiles,
    changedCanonicalFiles,
    skillVariant,
    nativeFilesFor,
    validateNative,
    nativeInput,
    contentHash,
    sha256Text,
    sha256Bytes,
} from "./codex-skill-target-test-fixtures";

describe("Codex exact Skill directory targets", () => {
    it("registers independent CLI/App project/global graph contracts and exact builds", () => {
        expect(validateAdapterRenderContractRegistration([codexProvider])).toEqual([]);
        expect(codexProvider.version).toBe("0.19.0");
        expect(codexProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Skill")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                renderStrategy: "native_graph",
                outputContractId: "CODEX_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                renderStrategy: "native_graph",
                outputContractId: "CODEX_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                renderStrategy: "native_graph",
                outputContractId: "CODEX_APP_NATIVE_PROJECT_SKILL_DIRECTORY_V1",
            }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                renderStrategy: "native_graph",
                outputContractId: "CODEX_APP_NATIVE_GLOBAL_SKILL_DIRECTORY_V1",
            }),
        ]);
        expect(supports.CODEX_CLI.project.renderContractDeclaration).toMatchObject({
            declarationKind: "native_project_exact_graph_v1",
            verifiedBuilds: [
                expect.objectContaining({
                    agentRuntimeId: "CODEX_CLI",
                    versionText: "0.142.5",
                    platform: "wsl",
                }),
            ],
        });
        expect(supports.CODEX_APP.global.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            target: { requiredFacts: { "oaam.target-kind": "directory" }, targetContextSchemaId: expect.any(String) },
            verifiedBuilds: [
                expect.objectContaining({
                    agentRuntimeId: "CODEX_APP",
                    versionText: "0.147.0-alpha.1.2",
                    platform: "win32",
                }),
            ],
        });
    });

    it.each(
        (["project_cli", "project_app", "global_cli", "global_app"] as const).flatMap((variant) =>
            [1, 2].map((schemaVersion) => ({ variant, schemaVersion })),
        ),
    )("restores and rebases $variant with native carrier $schemaVersion", async ({ variant, schemaVersion }) => {
        for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
            const files = inputRole === "current_exact" ? canonicalFiles() : changedCanonicalFiles();
            const fixture = analysisFixture(variant, inputRole, files);
            if (schemaVersion === 2) {
                const native = nativeInput(fixture);
                const { representationFingerprint: _hash, ...metadata } = native.representation;
                const directories = [
                    ...new Set([
                        ...native.files.map((file) => file.relativePath.slice(0, file.relativePath.lastIndexOf("/"))),
                        `${skillVariant(variant).boundary}/empty`,
                    ]),
                ].sort();
                const envelope = { ...metadata, schemaVersion: 2 as const, directories };
                native.representation = {
                    ...envelope,
                    representationFingerprint: computeVersionNativeRepresentationFingerprint(envelope),
                };
                expect((await codexProvider.analyzeRender(fixture)).outputUnits[0]?.managedDirectoryBoundaries).toMatchObject([
                    { schemaVersion: 2, relativePath: skillVariant(variant).boundary, desiredDirectoryPaths: directories },
                ]);
            }
            const analysis = await codexProvider.analyzeRender(fixture);
            expect(analysis).toMatchObject({
                status: "complete",
                blockedSemanticRefs: [],
                diagnostics: [],
            });
            const materialization = materializationInput(fixture, supportFor(variant));
            const materialized = await codexProvider.materializeRender(materialization);
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

    it("preserves Codex-only openai.yaml state while rebasing portable body and resources", () => {
        const fixture = analysisFixture("project_cli", "parent_rebase_seed", changedCanonicalFiles());
        const materialized = supports.CODEX_CLI.project.materialize(materializationInput(fixture, supports.CODEX_CLI.project));
        expect(materialized).toMatchObject({
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        { content: { text: expect.stringContaining(CHANGED_ENTRY_BODY) } },
                        { content: { text: PRIVATE_METADATA } },
                        { content: { bytes: CHANGED_BINARY } },
                        { content: { text: CHANGED_SCRIPT }, executable: true },
                    ],
                },
            ],
        });
        expect(validateNative(changedCanonicalFiles(), nativeFilesFor(changedCanonicalFiles(), "project_cli"))).toBe(true);
    });

    it("attributes entry, text, binary and executable reverse changes without accepting private-header drift", async () => {
        const fixture = analysisFixture("project_cli", "current_exact", canonicalFiles());
        const materialization = materializationInput(fixture, supports.CODEX_CLI.project);
        const changed = changedInspection(fixture, materialization, "project_cli");
        const inspected = await codexProvider.inspectRenderedTarget(changed);
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

        const drifted = changedInspection(fixture, materialization, "project_cli");
        const entry = drifted.files.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (entry?.currentContent.contentKind !== "text") throw new Error("entry fixture missing");
        entry.currentContent.text = entry.currentContent.text.replace("license: MIT", "license: Apache-2.0");
        expect(await codexProvider.inspectRenderedTarget(drifted)).toMatchObject({
            status: "complete",
            files: expect.arrayContaining([
                expect.objectContaining({
                    relativePath: expect.stringMatching(/SKILL\.md$/),
                    attributionState: "conflict",
                    reasonCode: "native_project_exact_graph_content_not_reconcilable",
                }),
            ]),
        });

        const contentKindDrift = changedInspection(fixture, materialization, "project_cli");
        const driftedEntry = contentKindDrift.files.find((file) => file.relativePath.endsWith("/SKILL.md"));
        const driftedState = contentKindDrift.inspectionScope.fileStates.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (driftedEntry === undefined || driftedState === undefined) throw new Error("entry fixture missing");
        driftedEntry.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1, 2, 3) };
        driftedState.currentContentHash = sha256Bytes(Uint8Array.of(1, 2, 3));
        expect(supports.CODEX_CLI.project.inspect(contentKindDrift)).toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({
                    relativePath: expect.stringMatching(/SKILL\.md$/),
                    attributionState: "conflict",
                }),
            ]),
        });
    });

    it("fails closed for mixed scopes, unsafe graphs, shape drift and foreign restoration", async () => {
        const mixed = analysisFixture("project_cli", "current_exact", canonicalFiles());
        const second = structuredClone(mixed.deployment.assets[0]);
        if (second === undefined) throw new Error("asset fixture missing");
        second.scope = "global";
        second.projectId = "";
        mixed.deployment.assets.push(second);
        expect(await codexProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "codex_skill_target_scope_ambiguous" })],
        });

        const outside = analysisFixture("project_cli", "current_exact", canonicalFiles());
        const outsideFile = nativeInput(outside).files[0];
        if (outsideFile === undefined) throw new Error("native file fixture missing");
        outsideFile.relativePath = ".agents/skills/other/assets/marker.bin";
        expect(supports.CODEX_CLI.project.analyze(outside).status).toBe("failed");

        const duplicate = analysisFixture("project_cli", "current_exact", canonicalFiles());
        const duplicateFile = nativeInput(duplicate).files[0];
        if (duplicateFile === undefined) throw new Error("native file fixture missing");
        nativeInput(duplicate).files.push(structuredClone(duplicateFile));
        expect(supports.CODEX_CLI.project.analyze(duplicate).status).toBe("failed");

        const noEntry = analysisFixture("project_cli", "current_exact", canonicalFiles());
        const noEntryFile = nativeInput(noEntry).files.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (noEntryFile === undefined) throw new Error("entry fixture missing");
        noEntryFile.relativePath = noEntryFile.relativePath.replace("SKILL.md", "ENTRY.md");
        expect(supports.CODEX_CLI.project.analyze(noEntry).status).toBe("failed");

        const malformed = analysisFixture("project_cli", "parent_rebase_seed", changedCanonicalFiles());
        const malformedEntry = nativeInput(malformed).files.find((file) => file.relativePath.endsWith("/SKILL.md"));
        if (malformedEntry?.contentKind !== "text") throw new Error("entry fixture missing");
        malformedEntry.text = "missing frontmatter";
        malformedEntry.byteSize = Buffer.byteLength(malformedEntry.text);
        malformedEntry.contentHash = sha256Text(malformedEntry.text);
        expect(supports.CODEX_CLI.project.analyze(malformed).status).toBe("failed");

        const metadata = analysisFixture("project_cli", "parent_rebase_seed", changedCanonicalFiles());
        const asset = metadata.deployment.assets[0];
        if (asset?.version.canonical.kind !== "Skill") throw new Error("Skill fixture missing");
        asset.version.canonical.typeData.description = "Foreign metadata cannot be guessed into Codex frontmatter";
        expect(supports.CODEX_CLI.project.analyze(metadata).status).toBe("failed");

        const restoration = analysisFixture("project_cli", "current_exact", canonicalFiles());
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.CODEX_CLI.project.analyze(restoration).status).toBe("failed");

        const parentRestoration = analysisFixture("project_cli", "parent_rebase_seed", changedCanonicalFiles());
        parentRestoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports.CODEX_CLI.project.analyze(parentRestoration).status).toBe("failed");

        const missingLogicalPath = analysisFixture("project_cli", "parent_rebase_seed", changedCanonicalFiles());
        const missingLogicalFile = missingLogicalPath.deployment.assets[0]?.version.files.find(
            (file) => file.file.role === "resource",
        );
        if (missingLogicalFile === undefined) throw new Error("resource fixture missing");
        missingLogicalFile.file.logicalPath = "references/missing.md";
        expect(supports.CODEX_CLI.project.analyze(missingLogicalPath).status).toBe("failed");

        const misplacedEntry = analysisFixture("project_cli", "parent_rebase_seed", changedCanonicalFiles());
        const entryFile = misplacedEntry.deployment.assets[0]?.version.files.find((file) => file.file.role === "entry");
        const resourceFile = misplacedEntry.deployment.assets[0]?.version.files.find(
            (file) => file.file.logicalPath === "agents/openai.yaml",
        );
        if (entryFile === undefined || resourceFile === undefined) throw new Error("graph role fixtures missing");
        entryFile.file.role = "resource";
        resourceFile.file.role = "entry";
        expect(supports.CODEX_CLI.project.analyze(misplacedEntry).status).toBe("failed");
    });
});
