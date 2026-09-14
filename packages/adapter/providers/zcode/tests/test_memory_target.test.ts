import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AssetKindTypeDataV2,
    AssetVersionFileContentV2,
    PosixRelativePath,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { zcodeProvider } from "../src/zcode-provider";
import { ZCODE_NATIVE_DIALECTS } from "../src/zcode-source-read-model";
import { analyzeZcodeMemoryTargets, createZcodeMemoryTargetSupports } from "../src/zcode-target-memory";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const UNIT_ASSET_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const UNIT_CHILD_VERSION_ID = "22222222-2222-4222-8222-222222222223";
const CATALOG_ASSET_ID = "33333333-3333-4333-8333-333333333333";
const CATALOG_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CATALOG_CHILD_VERSION_ID = "44444444-4444-4444-8444-444444444445";
const SECOND_UNIT_ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SECOND_UNIT_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const FILE_ID = "66666666-6666-4666-8666-666666666666";
const UNIT_BODY = "Keep the exact ZCode Memory target boundary.";
const CHANGED_UNIT_BODY = "Keep the reviewed ZCode Memory target boundary.";
const UNIT_NATIVE = [
    "---",
    "# preserve ZCode private Memory fields",
    "name: OAAM Memory fixture",
    "description: Isolated ZCode Memory topic",
    "type: project",
    "updatedAt: 2026-08-08T00:00:00.000Z",
    "source: explicit_user_request",
    "sessionId: oaam-phase56-session",
    "---",
    "",
    UNIT_BODY,
    "",
].join("\n");
const REBASED_UNIT_NATIVE = UNIT_NATIVE.replace("name: OAAM Memory fixture", 'name: "OAAM rebased Memory fixture"')
    .replace("description: Isolated ZCode Memory topic", 'description: "Rebased ZCode Memory topic"')
    .replace(UNIT_BODY, CHANGED_UNIT_BODY);
const RESTORATION = Buffer.from(
    JSON.stringify({
        schemaVersion: 1,
        dialectId: ZCODE_NATIVE_DIALECTS.memoryTopic,
        classification: "project",
        sessionId: "oaam-phase56-session",
        source: "explicit_user_request",
        updatedAt: "2026-08-08T00:00:00.000Z",
    }),
);
const CATALOG_NATIVE = [
    "# ZCode Project Memory",
    "",
    "<!-- preserve Catalog layout -->",
    "- [OAAM Memory fixture](topics/oaam-phase56-memory.md) — original hint (type: project)",
    "",
].join("\n");
const REBASED_CATALOG_NATIVE = CATALOG_NATIVE.replace("OAAM Memory fixture", "OAAM rebased Memory fixture").replace(
    "original hint",
    "revised hint",
);

const supports = createZcodeMemoryTargetSupports({
    adapterVersion: zcodeProvider.version,
    agentRuntimes: zcodeProvider.agentRuntimes,
    targetContextSchemaId: "ZCODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
});

describe("ZCode project Memory targets", () => {
    it("registers the Unit and Catalog contracts under the new Provider version", () => {
        expect(zcodeProvider.version).toBe("0.10.0");
        expect(zcodeProvider.assetTargetCapabilities.filter((row) => row.assetKind === "Memory")).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_PROJECT_MEMORY_TOPIC_V1",
                entrySupportStatus: "supported",
            }),
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                outputContractId: "ZCODE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
                entrySupportStatus: "supported",
            }),
        ]);
    });

    it("restores one current-exact Unit and rebases canonical fields without losing private Memory state", async () => {
        const current = unitFixture("current_exact");
        expect(await zcodeProvider.analyzeRender(current)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(await zcodeProvider.materializeRender(materializationInput(current, supports.unit))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: "topics/oaam-phase56-memory.md",
                            content: { contentKind: "text", text: UNIT_NATIVE },
                        },
                    ],
                },
            ],
        });

        const rebased = unitFixture("parent_rebase_seed");
        expect(supports.unit.analyze(rebased)).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(supports.unit.materialize(materializationInput(rebased, supports.unit))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: "topics/oaam-phase56-memory.md",
                            content: { contentKind: "text", text: REBASED_UNIT_NATIVE },
                        },
                    ],
                },
            ],
        });
        expect(REBASED_UNIT_NATIVE).toContain("# preserve ZCode private Memory fields");
        expect(REBASED_UNIT_NATIVE).toContain("sessionId: oaam-phase56-session");
        expect(REBASED_UNIT_NATIVE).toContain("source: explicit_user_request");

        const inlineComment = unitFixture("parent_rebase_seed");
        firstNative(inlineComment).files[0] = nativeFile(
            "topics/oaam-phase56-memory.md",
            UNIT_NATIVE.replace("name: OAAM Memory fixture", "name: OAAM Memory fixture # private ZCode comment"),
        );
        expect(supports.unit.analyze(inlineComment)).toMatchObject({ status: "failed" });
    });

    it("composes the 3.1.8 exact consumer floor with Unit/Catalog target and reverse", async () => {
        const fixture = catalogFixture("current_exact");
        bindExactBuild(fixture, "3.1.8");
        const analysis = await zcodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialization = providerMaterializationInput(fixture, analysis);
        await expect(zcodeProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: expect.arrayContaining([
                expect.objectContaining({ files: [expect.objectContaining({ relativePath: "MEMORY.md" })] }),
                expect.objectContaining({
                    files: [expect.objectContaining({ relativePath: "topics/oaam-phase56-memory.md" })],
                }),
            ]),
        });
        await expect(
            zcodeProvider.inspectRenderedTarget(
                inspectionInput(
                    materialization,
                    "topics/oaam-phase56-memory.md",
                    UNIT_NATIVE,
                    UNIT_NATIVE.replace(UNIT_BODY, "Reverse the historical ZCode Memory body."),
                ),
            ),
        ).resolves.toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [{ replacementContent: { text: "Reverse the historical ZCode Memory body." } }],
        });
        await expect(
            zcodeProvider.inspectRenderedTarget(
                inspectionInput(
                    materialization,
                    "MEMORY.md",
                    CATALOG_NATIVE,
                    CATALOG_NATIVE.replace("original hint", "historical reverse hint"),
                ),
            ),
        ).resolves.toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
            changes: [expect.objectContaining({ changeKind: "asset_type_data_replacement" })],
        });
    });

    it("blocks a foreign-canonical Unit when its restoration no longer matches the parent native dialect", () => {
        const fixture = unitFixture("parent_rebase_seed");
        const restoration = fixture.dialectInputs[0]?.inputs.find((input) => input.inputKind === "dialect_restoration");
        if (restoration?.content.contentKind !== "binary") throw new Error("Memory restoration fixture is missing");
        const changed = JSON.parse(Buffer.from(restoration.content.bytes).toString("utf8")) as Record<string, unknown>;
        changed.classification = "reference";
        restoration.content.bytes = Buffer.from(JSON.stringify(changed));
        expect(supports.unit.analyze(fixture)).toMatchObject({ status: "failed" });
    });

    it("materializes and rebases an ordered Catalog while retaining the existing ZCode type suffix", async () => {
        const current = catalogFixture("current_exact");
        const currentAnalysis = await zcodeProvider.analyzeRender(current);
        expect(currentAnalysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(currentAnalysis.outputUnits).toHaveLength(2);
        expect(await zcodeProvider.materializeRender(providerMaterializationInput(current, currentAnalysis))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: expect.arrayContaining([
                expect.objectContaining({
                    files: [
                        expect.objectContaining({
                            relativePath: "MEMORY.md",
                            content: expect.objectContaining({ text: CATALOG_NATIVE }),
                        }),
                    ],
                }),
                expect.objectContaining({
                    files: [expect.objectContaining({ relativePath: "topics/oaam-phase56-memory.md" })],
                }),
            ]),
        });

        const rebased = catalogFixture("parent_rebase_seed");
        const catalogOnly = catalogOnlyInput(rebased);
        const analysis = supports.catalog.analyze(catalogOnly);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(supports.catalog.materialize(materializationInput(catalogOnly, supports.catalog))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                { files: [{ relativePath: "MEMORY.md", content: { contentKind: "text", text: REBASED_CATALOG_NATIVE } }] },
            ],
        });
        expect(REBASED_CATALOG_NATIVE).toContain("(type: project)");
    });

    it("attributes Unit body and Catalog routing changes without accepting private-state drift", async () => {
        const unit = unitFixture("current_exact");
        const unitMaterialization = materializationInput(unit, supports.unit);
        const changedUnit = UNIT_NATIVE.replace(UNIT_BODY, "Reverse the reviewed ZCode Memory body.");
        expect(
            await zcodeProvider.inspectRenderedTarget(
                inspectionInput(unitMaterialization, "topics/oaam-phase56-memory.md", UNIT_NATIVE, changedUnit),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: "Reverse the reviewed ZCode Memory body." },
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            await zcodeProvider.inspectRenderedTarget(
                inspectionInput(
                    unitMaterialization,
                    "topics/oaam-phase56-memory.md",
                    UNIT_NATIVE,
                    changedUnit.replace("type: project", "type: reference"),
                ),
            ),
        ).toMatchObject({ status: "complete", changes: [], files: [{ attributionState: "conflict" }] });

        const catalog = catalogFixture("current_exact");
        const catalogAnalysis = await zcodeProvider.analyzeRender(catalog);
        const catalogMaterialization = providerMaterializationInput(catalog, catalogAnalysis);
        const changedCatalog = CATALOG_NATIVE.replace("OAAM Memory fixture", "OAAM reverse Memory fixture").replace(
            "original hint",
            "reverse hint",
        );
        expect(
            await zcodeProvider.inspectRenderedTarget(
                inspectionInput(catalogMaterialization, "MEMORY.md", CATALOG_NATIVE, changedCatalog),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "asset_type_data_replacement",
                    replacement: {
                        kind: "Memory",
                        typeData: {
                            entityRole: "catalog",
                            members: [
                                {
                                    targetAssetVersionId: UNIT_VERSION_ID,
                                    routingTitle: "OAAM reverse Memory fixture",
                                    routingHint: "reverse hint",
                                },
                            ],
                        },
                    },
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });

    it("rejects canonical-only, unsafe-path, duplicate-member, and generated-state target claims", async () => {
        const canonicalOnly = unitFixture("current_exact");
        canonicalOnly.dialectInputs = [];
        expect(await zcodeProvider.analyzeRender(canonicalOnly)).toMatchObject({
            status: "failed",
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: "zcode_project_memory_exact_file_blocked" })]),
        });

        const unsafe = unitFixture("current_exact");
        firstNative(unsafe).files[0] = nativeFile("topics/../escape.md", UNIT_NATIVE);
        expect(supports.unit.analyze(unsafe).status).toBe("failed");

        for (const relativePath of ["memory_summary.md", "rollout_summaries/session.md", "extensions/note.md"] as const) {
            const derived = unitFixture("current_exact");
            firstNative(derived).files[0] = nativeFile(relativePath, UNIT_NATIVE);
            expect(supports.unit.analyze(derived).status, relativePath).toBe("failed");
        }

        const duplicate = catalogFixture("current_exact");
        replaceCatalogNative(
            duplicate,
            `${CATALOG_NATIVE.trimEnd()}\n- [Duplicate](topics/oaam-phase56-memory.md) — duplicate\n`,
        );
        expect(supports.catalog.analyze(catalogOnlyInput(duplicate)).status).toBe("failed");
    });

    it("classifies an unrelated Memory semantic without hiding the valid Unit closure", async () => {
        const mixed = unitFixture("current_exact");
        mixed.requiredSemantics.push(
            semantic("99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "memory.support", 9),
        );

        const analysis = await analyzeZcodeMemoryTargets(mixed, supports);
        expect(analysis).toMatchObject({
            status: "partial",
            blockedSemanticRefs: [expect.objectContaining({ reasonCode: "zcode_memory_native_variant_unavailable" })],
        });
        expect(analysis.semanticOptions.length).toBeGreaterThan(0);
    });

    it("fails closed when duplicate semantic fingerprints prevent one exact variant closure", async () => {
        const duplicateClosure = unitFixture("current_exact");
        const duplicate = duplicateClosure.requiredSemantics[0];
        if (duplicate === undefined) throw new Error("Memory semantic fixture is missing");
        duplicateClosure.requiredSemantics.push(structuredClone(duplicate));

        expect(await analyzeZcodeMemoryTargets(duplicateClosure, supports)).toMatchObject({
            status: "failed",
            semanticOptions: [],
            diagnostics: [expect.objectContaining({ code: "zcode_memory_variant_closure_invalid" })],
        });
    });

    it("rebases an empty parent Catalog and rejects unsafe routing text", () => {
        const emptyParent = catalogFixture("parent_rebase_seed");
        replaceCatalogNative(emptyParent, "# ZCode Project Memory\n\n<!-- empty parent -->\n");
        const emptyParentOnly = catalogOnlyInput(emptyParent);
        expect(supports.catalog.analyze(emptyParentOnly)).toMatchObject({ status: "complete", diagnostics: [] });
        expect(supports.catalog.materialize(materializationInput(emptyParentOnly, supports.catalog))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            content: {
                                contentKind: "text",
                                text: expect.stringContaining(
                                    "- [OAAM rebased Memory fixture](topics/oaam-phase56-memory.md) — revised hint",
                                ),
                            },
                        },
                    ],
                },
            ],
        });

        for (const unsafeText of ["unsafe ] title", "unsafe\ntext", "unsafe\rtext", "unsafe\0text"]) {
            const unsafeRouting = catalogFixture("parent_rebase_seed");
            const canonical = unsafeRouting.deployment.assets[0]?.version.canonical;
            if (canonical?.kind !== "Memory" || canonical.typeData.entityRole !== "catalog") {
                throw new Error("Memory Catalog fixture is missing");
            }
            canonical.typeData.members[0] = {
                ...(canonical.typeData.members[0] as (typeof canonical.typeData.members)[number]),
                routingTitle: unsafeText,
            };
            expect(supports.catalog.analyze(catalogOnlyInput(unsafeRouting)).status, JSON.stringify(unsafeText)).toBe("failed");
        }
    });

    it("appends a second Catalog member after the final existing native row", () => {
        const fixture = catalogFixture("parent_rebase_seed");
        const canonical = fixture.deployment.assets[0]?.version.canonical;
        if (canonical?.kind !== "Memory" || canonical.typeData.entityRole !== "catalog") {
            throw new Error("Memory Catalog fixture is missing");
        }
        canonical.typeData.members.push({
            targetAssetVersionId: SECOND_UNIT_VERSION_ID,
            routingTitle: "Second Memory topic",
            routingHint: "second hint",
        });
        fixture.deployment.assets.push(
            memoryUnitAsset(
                SECOND_UNIT_ASSET_ID,
                SECOND_UNIT_VERSION_ID,
                memoryUnitCanonical("Second Memory topic", "Second isolated topic"),
                "Second Memory body.",
            ),
        );
        fixture.dialectInputs.push(
            nativeGroup(
                SECOND_UNIT_ASSET_ID,
                SECOND_UNIT_VERSION_ID,
                ZCODE_NATIVE_DIALECTS.memoryTopic,
                nativeFile("topics/oaam-phase56-memory-two.md", UNIT_NATIVE),
                "current_exact",
                SECOND_UNIT_VERSION_ID,
                true,
            ),
        );
        const catalogOnly = catalogOnlyInput(fixture);
        const analysis = supports.catalog.analyze(catalogOnly);
        expect(analysis).toMatchObject({ status: "complete", diagnostics: [] });
        expect(supports.catalog.materialize(materializationInput(catalogOnly, supports.catalog))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            content: {
                                contentKind: "text",
                                text: expect.stringContaining(
                                    "- [Second Memory topic](topics/oaam-phase56-memory-two.md) — second hint",
                                ),
                            },
                        },
                    ],
                },
            ],
        });
    });
});

function unitFixture(inputRole: "current_exact" | "parent_rebase_seed"): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? UNIT_VERSION_ID : UNIT_CHILD_VERSION_ID;
    const canonical = memoryUnitCanonical(
        inputRole === "current_exact" ? "OAAM Memory fixture" : "OAAM rebased Memory fixture",
        inputRole === "current_exact" ? "Isolated ZCode Memory topic" : "Rebased ZCode Memory topic",
    );
    const body = inputRole === "current_exact" ? UNIT_BODY : CHANGED_UNIT_BODY;
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetContexts: [targetContext()],
            assets: [memoryUnitAsset(UNIT_ASSET_ID, versionId, canonical, body)],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: memorySemantics(UNIT_ASSET_ID, versionId, 1, FILE_ID),
        dialectInputs: [
            nativeGroup(
                UNIT_ASSET_ID,
                versionId,
                ZCODE_NATIVE_DIALECTS.memoryTopic,
                nativeFile("topics/oaam-phase56-memory.md", UNIT_NATIVE),
                inputRole,
                UNIT_VERSION_ID,
                true,
            ),
        ],
    };
}

function catalogFixture(inputRole: "current_exact" | "parent_rebase_seed"): RenderAnalysisInput {
    const catalogVersionId = inputRole === "current_exact" ? CATALOG_VERSION_ID : CATALOG_CHILD_VERSION_ID;
    const unitVersionId = UNIT_VERSION_ID;
    const title = inputRole === "current_exact" ? "OAAM Memory fixture" : "OAAM rebased Memory fixture";
    const hint = inputRole === "current_exact" ? "original hint" : "revised hint";
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
                        ref: { assetId: CATALOG_ASSET_ID, versionId: catalogVersionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: memoryCatalogCanonical(unitVersionId, title, hint),
                        files: [],
                    },
                    sectionHandles: {},
                },
                memoryUnitAsset(
                    UNIT_ASSET_ID,
                    unitVersionId,
                    memoryUnitCanonical("OAAM Memory fixture", "Isolated ZCode Memory topic"),
                    UNIT_BODY,
                ),
            ],
            targetFileSnapshots: [
                {
                    relativePath: "MEMORY.md",
                    snapshotState: "present",
                    contentHash: sha256Text(CATALOG_NATIVE),
                    byteSize: Buffer.byteLength(CATALOG_NATIVE),
                    executable: false,
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            ...memorySemantics(CATALOG_ASSET_ID, catalogVersionId, 1),
            ...memorySemantics(UNIT_ASSET_ID, unitVersionId, 4, FILE_ID),
        ],
        dialectInputs: [
            nativeGroup(
                CATALOG_ASSET_ID,
                catalogVersionId,
                ZCODE_NATIVE_DIALECTS.memoryCatalog,
                nativeFile("MEMORY.md", CATALOG_NATIVE),
                inputRole,
                CATALOG_VERSION_ID,
                false,
            ),
            nativeGroup(
                UNIT_ASSET_ID,
                unitVersionId,
                ZCODE_NATIVE_DIALECTS.memoryTopic,
                nativeFile("topics/oaam-phase56-memory.md", UNIT_NATIVE),
                "current_exact",
                UNIT_VERSION_ID,
                true,
            ),
        ],
    };
}

function targetContext() {
    const schema = supports.unit.targetContextSchema;
    return {
        schemaVersion: 1 as const,
        agentRuntimeId: "ZCODE_APP" as const,
        versionText: "3.5.3",
        buildIdentity: "sha256:420a571ebd2c7fca9cdaad49bd0f3ad6dd930f13e9ae4abd35dab411793afb1a" as Sha256Digest,
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" as const },
            { key: "oaam.target-kind", value: "directory", evidenceLevel: "local_artifact" as const },
        ],
        targetApplicabilityFingerprint: HASH,
    };
}

function bindExactBuild(input: RenderAnalysisInput, versionText: string): void {
    const build = supports.unit.renderContractDeclaration.verifiedBuilds.find(
        (candidate) => candidate.platform === "wsl" && candidate.versionText === versionText,
    );
    const context = input.deployment.targetContexts[0];
    if (build === undefined || context === undefined) throw new Error(`Memory ${versionText} verified build is missing`);
    context.versionText = build.versionText;
    context.buildIdentity = build.buildIdentity;
}

function memoryUnitAsset(
    assetId: string,
    versionId: string,
    canonical: Extract<AssetKindTypeDataV2, { kind: "Memory" }>,
    body: string,
) {
    return {
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical,
            files: [textFile("memory.md", body)],
        },
        sectionHandles: { [FILE_ID]: "memory-entry" },
    };
}

function nativeGroup(
    assetId: string,
    versionId: string,
    dialectId: string,
    file: ReturnType<typeof nativeFile>,
    inputRole: "current_exact" | "parent_rebase_seed",
    parentVersionId: string,
    withRestoration: boolean,
): RenderAnalysisInput["dialectInputs"][number] {
    const native = {
        inputKind: "native_representation" as const,
        inputRole,
        ...(inputRole === "parent_rebase_seed" ? { sourceVersion: { assetId, versionId: parentVersionId } } : {}),
        representation: {
            schemaVersion: 1 as const,
            dialectId,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [file],
    };
    return {
        targetVersion: { assetId, versionId },
        consumerAgentRuntimeIds: ["ZCODE_APP"],
        inputs: [
            native,
            ...(withRestoration
                ? [
                      {
                          inputKind: "dialect_restoration" as const,
                          restoration: {
                              dialectId: ZCODE_NATIVE_DIALECTS.memoryTopic,
                              restorationContractFingerprint: HASH,
                              contentHash: sha256Bytes(RESTORATION),
                          },
                          content: { contentKind: "binary" as const, bytes: new Uint8Array(RESTORATION) },
                      },
                  ]
                : []),
        ],
    };
}

function materializationInput(
    fixture: RenderAnalysisInput,
    support: (typeof supports)["unit"] | (typeof supports)["catalog"],
): RenderMaterializationInput {
    const analysis = support.analyze(fixture);
    if (analysis.status !== "complete") throw new Error(`Memory analysis failed: ${JSON.stringify(analysis.diagnostics)}`);
    const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Memory materialization profile is missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: structuredClone(analysis.outputUnits),
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "ZCODE",
                rendererAdapterVersion: zcodeProvider.version,
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

function providerMaterializationInput(
    fixture: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof zcodeProvider.analyzeRender>>,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Provider Memory analysis failed");
    const rendererFor = (unit: (typeof analysis.outputUnits)[number]) => {
        const support =
            unit.outputContractId === supports.catalog.renderContractDeclaration.outputContractId
                ? supports.catalog
                : supports.unit;
        const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
        const profile = contract.materializationProfiles[0];
        if (profile === undefined) throw new Error("Memory materialization profile is missing");
        return {
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: "ZCODE" as const,
            rendererAdapterVersion: zcodeProvider.version,
            materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: support.renderContractDeclaration.materializationProfileId,
            profileConstraintFingerprint: profile.profileConstraintFingerprint,
        };
    };
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: structuredClone(analysis.outputUnits),
            outputUnitRenderers: analysis.outputUnits.map(rendererFor),
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
    relativePath: PosixRelativePath,
    appliedText: string,
    currentText: string,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits.find((candidate) =>
        candidate.claims.some((claim) => claim.relativePath === relativePath),
    );
    if (unit === undefined) throw new Error(`Memory output unit is missing for ${relativePath}`);
    const decisions = materialization.requiredSemantics.map((semanticRef) => {
        const outputUnit = materialization.selection.outputUnits.find((candidate) => {
            const expectedPath = semanticRef.subject.assetId === CATALOG_ASSET_ID ? "MEMORY.md" : "topics/oaam-phase56-memory.md";
            return candidate.claims.some((claim) => claim.relativePath === expectedPath);
        });
        if (outputUnit === undefined) throw new Error("Memory semantic output unit is missing");
        return {
            semanticRef,
            consumerOwnerAdapterId: "ZCODE" as const,
            consumerOwnerAdapterVersion: zcodeProvider.version,
            optionFingerprint: HASH,
            renderStrategy: "native_graph" as const,
            actualReverseExtractPolicy: "can_reconcile" as const,
            outputUnitFingerprints: [outputUnit.outputUnitFingerprint],
            outcome: "preserved" as const,
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
            decisions,
            outputUnits: structuredClone(materialization.selection.outputUnits),
            outputUnitRenderers: structuredClone(materialization.selection.outputUnitRenderers),
            semanticCoverageProofs: [],
        },
        appliedAssets: structuredClone(materialization.deployment.assets),
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
                    semanticRefFingerprints: decisions
                        .filter((decision) => decision.outputUnitFingerprints.includes(unit.outputUnitFingerprint))
                        .map((decision) => decision.semanticRef.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function catalogOnlyInput(full: RenderAnalysisInput): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: structuredClone(full.deployment),
        requiredSemantics: structuredClone(
            full.requiredSemantics.filter((semantic) => semantic.subject.assetId === CATALOG_ASSET_ID),
        ),
        dialectInputs: structuredClone(full.dialectInputs),
    };
}

function replaceCatalogNative(input: RenderAnalysisInput, text: string): void {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Catalog native fixture is missing");
    native.files[0] = nativeFile("MEMORY.md", text);
    input.deployment.targetFileSnapshots = [
        {
            relativePath: "MEMORY.md",
            snapshotState: "present",
            contentHash: sha256Text(text),
            byteSize: Buffer.byteLength(text),
            executable: false,
        },
    ];
}

function firstNative(input: RenderAnalysisInput) {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Memory native fixture is missing");
    return native;
}

function memorySemantics(assetId: string, versionId: string, start: number, fileId?: string) {
    return [
        semantic(assetId, versionId, "asset.file_inventory", start),
        semantic(assetId, versionId, "memory.support", start + 1),
        ...(fileId === undefined ? [] : [semantic(assetId, versionId, "memory.content", start + 2, fileId)]),
    ];
}

function semantic(assetId: string, versionId: string, semanticKind: string, ordinal: number, fileId?: string) {
    return {
        semanticRefFingerprint: `sha256:${ordinal.toString(16).repeat(64)}` as Sha256Digest,
        consumerAgentRuntimeId: "ZCODE_APP" as const,
        subject:
            fileId === undefined
                ? { subjectKind: "asset" as const, assetId, versionId }
                : { subjectKind: "file" as const, assetId, versionId, fileId },
        semanticKind,
    };
}

function memoryUnitCanonical(name: string, description: string): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "unit",
            card: { name, description },
            loading: { card: "high", body: "low" },
            applicabilityRule: "",
        },
    };
}

function memoryCatalogCanonical(
    targetAssetVersionId: string,
    routingTitle: string,
    routingHint: string,
): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "catalog",
            members: [{ targetAssetVersionId, routingTitle, routingHint }],
        },
    };
}

function textFile(logicalPath: string, text: string): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId: FILE_ID,
            logicalPath,
            role: "entry",
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function nativeFile(relativePath: PosixRelativePath, text: string) {
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

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
