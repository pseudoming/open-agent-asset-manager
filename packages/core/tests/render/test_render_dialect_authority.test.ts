/** Operation-local Version dialect projection and Provider routing tests. */

import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "../../src/types";
import { computeVersionNativeRepresentationFingerprint } from "../../src/foundation/fingerprint";
import { binaryPayloadStats, textPayloadStats } from "../../src/catalog/payload-store";
import { projectVersionDialectInputs, resolveProviderExactFileDialectInputs } from "../../src/render/render-dialect-authority";
import { ASSET_ID, VERSION_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import { makeExactFileFixture } from "./fixtures/native-project-exact-file-test-fixtures";
import {
    CATALOG_ASSET_ID,
    MEMORY_TOPIC_DIALECT_ID,
    SECOND_UNIT_VERSION_ID,
    UNIT_VERSION_ID,
    makeMemoryCatalogExactFileFixture,
} from "./fixtures/native-project-memory-catalog-test-fixtures";

const HASH = `sha256:${"6".repeat(64)}` as Sha256Digest;

describe("render dialect authority", () => {
    it("projects text, binary and restoration payloads in deterministic operation-local order", () => {
        const text = nativeRepresentation("z-text-v1", "entry.md", Buffer.from("# Entry\n"), "text");
        const binary = nativeRepresentation("a-binary-v1", "resource.bin", Uint8Array.of(1, 2, 3), "binary");
        const restorationBytes = Uint8Array.of(9, 8, 7);
        const restorationStats = binaryPayloadStats(restorationBytes);
        const restoration = {
            dialectId: "middle-restoration-v1",
            restorationContractFingerprint: HASH,
            contentHash: restorationStats.contentHash,
        };
        const result = projectVersionDialectInputs(
            { assetId: ASSET_ID, versionId: VERSION_ID },
            {
                nativeRepresentations: [text.representation, binary.representation],
                dialectRestorationPayloads: [restoration],
                nativePayloads: [text.payload, binary.payload],
                restorationPayloads: [{ dialectId: "middle-restoration-v1", bytes: restorationBytes }],
            },
        );
        expect(result).toMatchObject({
            targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
            inputs: [
                { inputKind: "native_representation", representation: { dialectId: "a-binary-v1" } },
                { inputKind: "native_representation", representation: { dialectId: "z-text-v1" } },
                { inputKind: "dialect_restoration", restoration: { dialectId: "middle-restoration-v1" } },
            ],
        });
        const native = result?.inputs[1];
        expect(native?.inputKind === "native_representation" && native.files[0]).toMatchObject({
            contentKind: "text",
            text: "# Entry\n",
        });
        const projectedBinary = result?.inputs[0];
        expect(projectedBinary?.inputKind === "native_representation" && projectedBinary.files[0]).toMatchObject({
            contentKind: "binary",
            bytes: Uint8Array.of(1, 2, 3),
        });
        expect(projectVersionDialectInputs({ assetId: ASSET_ID, versionId: VERSION_ID }, emptyClosure())).toBeNull();
    });

    it("fails closed for incomplete, mismatched or noncanonical payload closures", () => {
        const text = nativeRepresentation("fixture-text-v1", "entry.md", Buffer.from("# Entry\n"), "text");
        const cases: Array<() => Parameters<typeof projectVersionDialectInputs>[1]> = [
            () => ({ ...emptyClosure(), nativeRepresentations: [text.representation] }),
            () => ({
                ...emptyClosure(),
                nativeRepresentations: [text.representation],
                nativePayloads: [{ dialectId: "fixture-text-v1", files: [] }],
            }),
            () => ({
                ...emptyClosure(),
                nativeRepresentations: [text.representation],
                nativePayloads: [
                    { dialectId: "fixture-text-v1", files: [{ relativePath: "wrong.md", bytes: Buffer.from("# Entry\n") }] },
                ],
            }),
            () => ({
                ...emptyClosure(),
                nativeRepresentations: [text.representation],
                nativePayloads: [
                    { dialectId: "fixture-text-v1", files: [{ relativePath: "entry.md", bytes: Uint8Array.of(0xff) }] },
                ],
            }),
            () => ({
                ...emptyClosure(),
                nativeRepresentations: [text.representation],
                nativePayloads: [
                    { dialectId: "fixture-text-v1", files: [{ relativePath: "entry.md", bytes: Buffer.from("x\r\n") }] },
                ],
            }),
            () => ({
                ...emptyClosure(),
                dialectRestorationPayloads: [
                    { dialectId: "restore-v1", restorationContractFingerprint: HASH, contentHash: HASH },
                ],
            }),
        ];
        for (const makeClosure of cases) {
            expect(() => projectVersionDialectInputs({ assetId: ASSET_ID, versionId: VERSION_ID }, makeClosure())).toThrow(
                /payload|normalized|utf-8/,
            );
        }
    });

    it("projects one explicitly identified immediate-parent seed without promoting it to current authority", () => {
        const parent = nativeRepresentation("fixture-parent-v1", "entry.md", Buffer.from("# Parent\n"), "text");
        const result = projectVersionDialectInputs({ assetId: ASSET_ID, versionId: VERSION_ID_2 }, emptyClosure(), {
            sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
            closure: { nativeRepresentations: [parent.representation], nativePayloads: [parent.payload] },
        });
        expect(result).toMatchObject({
            targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
            inputs: [
                {
                    inputKind: "native_representation",
                    inputRole: "parent_rebase_seed",
                    sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                    representation: { dialectId: "fixture-parent-v1" },
                },
            ],
        });
        for (const sourceVersion of [
            { assetId: ASSET_ID, versionId: VERSION_ID_2 },
            { assetId: "ffffffff-ffff-4fff-8fff-ffffffffffff", versionId: VERSION_ID },
        ]) {
            expect(() =>
                projectVersionDialectInputs({ assetId: ASSET_ID, versionId: VERSION_ID_2 }, emptyClosure(), {
                    sourceVersion,
                    closure: { nativeRepresentations: [parent.representation], nativePayloads: [parent.payload] },
                }),
            ).toThrow(/immediate same-Asset predecessor/);
        }
    });

    it("routes exact native authority only to the matching Provider cell and Version", () => {
        const fixture = makeExactFileFixture();
        const available = structuredClone(fixture.analysisInput.dialectInputs);
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available,
            }),
        ).toEqual(available);

        const parentOnly = structuredClone(available);
        const parent = requireNativeInput(parentOnly[0]!.inputs[0]!);
        parentOnly[0]!.inputs = [
            {
                ...parent,
                inputRole: "parent_rebase_seed",
                sourceVersion: { assetId: ASSET_ID, versionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
            },
        ];
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: parentOnly,
            }),
        ).toEqual(parentOnly);

        const multiVariantProvider = structuredClone(fixture.provider);
        const primaryDeclaration = multiVariantProvider.renderContractDeclarations[0];
        if (primaryDeclaration?.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        multiVariantProvider.renderContractDeclarations = [
            primaryDeclaration,
            { ...structuredClone(primaryDeclaration), nativeDialectId: "fixture-sibling-variant-v1" },
        ];
        expect(
            resolveProviderExactFileDialectInputs({
                provider: multiVariantProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available,
            }),
        ).toEqual(available);

        const currentExactOnlyProvider = structuredClone(fixture.provider);
        const currentExactOnlyDeclaration = currentExactOnlyProvider.renderContractDeclarations[0];
        if (currentExactOnlyDeclaration?.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        currentExactOnlyDeclaration.rebaseMaterializer = null;
        expect(
            resolveProviderExactFileDialectInputs({
                provider: currentExactOnlyProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: parentOnly,
            }),
        ).toEqual([]);

        const canonicalMigrationProvider = structuredClone(fixture.provider);
        const canonicalMigrationDeclaration = canonicalMigrationProvider.renderContractDeclarations[0];
        if (canonicalMigrationDeclaration?.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        canonicalMigrationDeclaration.canonicalMaterialization = {
            materializer: {
                componentId: "fixture.canonical-materializer-v1",
                componentVersion: 1,
                configFingerprint: HASH,
            },
            degradationKinds: ["target_runtime_missing_asset_kind"],
            reasonCode: "fixture_reviewed_migration",
        };
        expect(
            resolveProviderExactFileDialectInputs({
                provider: canonicalMigrationProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: [],
            }),
        ).toEqual([
            {
                targetVersion: fixture.deployment.assets[0]?.version.ref,
                consumerAgentRuntimeIds: [fixture.descriptor.agentRuntimeId],
                inputs: [
                    {
                        inputKind: "canonical_materialization",
                        nativeDialectId: canonicalMigrationDeclaration.nativeDialectId,
                        materializer: canonicalMigrationDeclaration.canonicalMaterialization.materializer,
                        degradationKinds: ["target_runtime_missing_asset_kind"],
                        reasonCode: "fixture_reviewed_migration",
                    },
                ],
            },
        ]);

        canonicalMigrationDeclaration.canonicalMaterialization.substituteAssetKind = "Skill";
        expect(
            resolveProviderExactFileDialectInputs({
                provider: canonicalMigrationProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: [],
            }),
        ).toEqual([
            {
                targetVersion: fixture.deployment.assets[0]?.version.ref,
                consumerAgentRuntimeIds: [fixture.descriptor.agentRuntimeId],
                inputs: [
                    {
                        inputKind: "canonical_materialization",
                        nativeDialectId: canonicalMigrationDeclaration.nativeDialectId,
                        materializer: canonicalMigrationDeclaration.canonicalMaterialization.materializer,
                        degradationKinds: ["target_runtime_missing_asset_kind"],
                        substituteAssetKind: "Skill",
                        reasonCode: "fixture_reviewed_migration",
                    },
                ],
            },
        ]);
        delete canonicalMigrationDeclaration.canonicalMaterialization.substituteAssetKind;

        const contextRoutedProvider = structuredClone(canonicalMigrationProvider);
        const contextRoutedDeclaration = contextRoutedProvider.renderContractDeclarations[0];
        if (
            contextRoutedDeclaration?.declarationKind !== "native_project_exact_file_v1" ||
            contextRoutedDeclaration.canonicalMaterialization === undefined
        ) {
            throw new Error("context-routed canonical declaration fixture is missing");
        }
        const siblingDeclaration = structuredClone(contextRoutedDeclaration);
        siblingDeclaration.target.targetContextSchemaId = "FIXTURE_SIBLING_TARGET_CONTEXT_V1";
        siblingDeclaration.canonicalMaterialization.materializer = {
            componentId: "fixture.sibling-canonical-materializer-v1",
            componentVersion: 1,
            configFingerprint: HASH,
        };
        contextRoutedProvider.renderContractDeclarations.push(siblingDeclaration);
        expect(
            resolveProviderExactFileDialectInputs({
                provider: contextRoutedProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: [],
            }),
        ).toEqual([
            {
                targetVersion: fixture.deployment.assets[0]?.version.ref,
                consumerAgentRuntimeIds: [fixture.descriptor.agentRuntimeId],
                inputs: [
                    expect.objectContaining({
                        inputKind: "canonical_materialization",
                        materializer: contextRoutedDeclaration.canonicalMaterialization.materializer,
                    }),
                ],
            },
        ]);

        const ambiguousContextProvider = structuredClone(contextRoutedProvider);
        const ambiguousSibling = ambiguousContextProvider.renderContractDeclarations[1];
        if (
            ambiguousSibling?.declarationKind !== "native_project_exact_file_v1" ||
            ambiguousContextProvider.renderContractDeclarations[0]?.declarationKind !== "native_project_exact_file_v1"
        ) {
            throw new Error("ambiguous context declaration fixture is missing");
        }
        ambiguousSibling.target.targetContextSchemaId =
            ambiguousContextProvider.renderContractDeclarations[0].target.targetContextSchemaId;
        expect(
            resolveProviderExactFileDialectInputs({
                provider: ambiguousContextProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: [],
            }),
        ).toEqual([]);

        const canonicalWithRestorationProvider = structuredClone(canonicalMigrationProvider);
        const canonicalWithRestorationDeclaration = canonicalWithRestorationProvider.renderContractDeclarations[0];
        if (canonicalWithRestorationDeclaration?.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        canonicalWithRestorationDeclaration.restorationDialectIds = ["fixture-restore"];
        const restorationText = "fixture restoration";
        const restorationOnly = [
            {
                targetVersion: structuredClone(fixture.deployment.assets[0]!.version.ref),
                inputs: [
                    {
                        inputKind: "dialect_restoration" as const,
                        restoration: {
                            dialectId: "fixture-restore",
                            restorationContractFingerprint: HASH,
                            contentHash: textPayloadStats(restorationText).contentHash,
                        },
                        content: { contentKind: "text" as const, text: restorationText },
                    },
                ],
            },
        ];
        const resolvedCanonicalWithRestoration = resolveProviderExactFileDialectInputs({
            provider: canonicalWithRestorationProvider,
            deployment: fixture.deployment,
            semantics: fixture.requiredSemantics,
            available: restorationOnly,
        });
        expect(resolvedCanonicalWithRestoration[0]?.inputs.map((input) => input.inputKind)).toEqual([
            "canonical_materialization",
            "dialect_restoration",
        ]);

        const explicitUndefinedProvider = structuredClone(fixture.provider);
        const explicitUndefinedDeclaration = explicitUndefinedProvider.renderContractDeclarations[0];
        if (explicitUndefinedDeclaration?.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        explicitUndefinedDeclaration.canonicalMaterialization = undefined;
        expect(
            resolveProviderExactFileDialectInputs({
                provider: explicitUndefinedProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: [],
            }),
        ).toEqual([]);

        const undeclaredMigrationProvider = structuredClone(fixture.provider);
        expect(
            resolveProviderExactFileDialectInputs({
                provider: undeclaredMigrationProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: [],
            }),
        ).toEqual([]);

        const currentAndParent = structuredClone(available);
        currentAndParent[0]!.inputs.push(structuredClone(parentOnly[0]!.inputs[0]!));
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: currentAndParent,
            }),
        ).toEqual(available);

        const routed = resolveProviderExactFileDialectInputs({
            provider: fixture.provider,
            deployment: fixture.deployment,
            semantics: fixture.requiredSemantics,
            available,
        });
        routed[0]!.targetVersion.versionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        expect(available[0]!.targetVersion.versionId).toBe(VERSION_ID);

        const withForeignInputs = structuredClone(available);
        withForeignInputs[0]!.inputs.push(
            nativeInputWithDialect(requireNativeInput(withForeignInputs[0]!.inputs[0]!), "foreign-dialect-v1"),
            {
                inputKind: "dialect_restoration",
                restoration: {
                    dialectId: "foreign-restoration-v1",
                    restorationContractFingerprint: HASH,
                    contentHash: binaryPayloadStats(Uint8Array.of(1)).contentHash,
                },
                content: { contentKind: "binary", bytes: Uint8Array.of(1) },
            },
        );
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: withForeignInputs,
            }),
        ).toEqual(available);
        const onlyForeignInputs = structuredClone(withForeignInputs);
        onlyForeignInputs[0]!.inputs = onlyForeignInputs[0]!.inputs.slice(1);
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: onlyForeignInputs,
            }),
        ).toEqual([]);

        const restorationAwareProvider = structuredClone(fixture.provider);
        const declaration = restorationAwareProvider.renderContractDeclarations[0];
        if (declaration?.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        declaration.restorationDialectIds = ["owned-restoration-v1"];
        const withRestorations = structuredClone(available);
        for (const dialectId of ["foreign-restoration-v1", "owned-restoration-v1"]) {
            const bytes = Uint8Array.of(dialectId.length);
            withRestorations[0]!.inputs.push({
                inputKind: "dialect_restoration",
                restoration: {
                    dialectId,
                    restorationContractFingerprint: HASH,
                    contentHash: binaryPayloadStats(bytes).contentHash,
                },
                content: { contentKind: "binary", bytes },
            });
        }
        expect(
            resolveProviderExactFileDialectInputs({
                provider: restorationAwareProvider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: withRestorations,
            }),
        ).toMatchObject([
            {
                inputs: [
                    { inputKind: "native_representation", inputRole: "current_exact" },
                    { inputKind: "dialect_restoration", restoration: { dialectId: "owned-restoration-v1" } },
                ],
            },
        ]);

        expect(
            resolveProviderExactFileDialectInputs({
                provider: { ...fixture.provider, renderContractDeclarations: [] },
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available,
            }),
        ).toEqual([]);
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics.map((semantic) => ({ ...semantic, consumerAgentRuntimeId: "FOREIGN" })),
                available,
            }),
        ).toEqual([]);
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics.map((semantic) => ({
                    ...semantic,
                    subject: { ...semantic.subject, assetId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
                })),
                available,
            }),
        ).toEqual([]);
        const foreignAvailable = structuredClone(available);
        foreignAvailable[0]!.targetVersion.versionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        expect(
            resolveProviderExactFileDialectInputs({
                provider: fixture.provider,
                deployment: fixture.deployment,
                semantics: fixture.requiredSemantics,
                available: foreignAvailable,
            }),
        ).toEqual([]);
    });

    it("projects a Memory Catalog native input together with only its referenced Unit inputs", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const provider = structuredClone(fixture.provider);
        const routed = resolveProviderExactFileDialectInputs({
            provider,
            deployment: fixture.deployment,
            semantics: fixture.catalogSemantics,
            available: fixture.analysisInput.dialectInputs,
        });
        expect(routed.map((group) => group.targetVersion)).toEqual([
            { assetId: CATALOG_ASSET_ID, versionId: fixture.catalogClosure.manifest.versionId },
            { assetId: fixture.firstUnitAsset.version.ref.assetId, versionId: UNIT_VERSION_ID },
        ]);
        expect(routed.some((group) => group.targetVersion.versionId === SECOND_UNIT_VERSION_ID)).toBe(false);

        const withoutMember = structuredClone(fixture.analysisInput.dialectInputs);
        withoutMember.splice(1, 1);
        expect(
            resolveProviderExactFileDialectInputs({
                provider,
                deployment: fixture.deployment,
                semantics: fixture.catalogSemantics,
                available: withoutMember,
            }),
        ).toEqual([expect.objectContaining({ targetVersion: expect.objectContaining({ assetId: CATALOG_ASSET_ID }) })]);

        const invalidMember = makeMemoryCatalogExactFileFixture();
        if (
            invalidMember.catalogAsset.version.canonical.kind !== "Memory" ||
            invalidMember.catalogAsset.version.canonical.typeData.entityRole !== "catalog"
        ) {
            throw new Error("Memory Catalog fixture missing");
        }
        invalidMember.catalogAsset.version.canonical.typeData.members[0]!.targetAssetVersionId =
            "ffffffff-ffff-4fff-8fff-ffffffffffff";
        expect(
            resolveProviderExactFileDialectInputs({
                provider,
                deployment: invalidMember.deployment,
                semantics: invalidMember.catalogSemantics,
                available: invalidMember.analysisInput.dialectInputs,
            }),
        ).toEqual([expect.objectContaining({ targetVersion: expect.objectContaining({ assetId: CATALOG_ASSET_ID }) })]);
    });
});

function requireNativeInput(
    input: ReturnType<typeof makeExactFileFixture>["analysisInput"]["dialectInputs"][number]["inputs"][number],
) {
    if (input.inputKind !== "native_representation") throw new Error("expected native input");
    return input;
}

function nativeInputWithDialect(
    input: ReturnType<typeof requireNativeInput>,
    dialectId: string,
): ReturnType<typeof requireNativeInput> {
    const files = structuredClone(input.files);
    const { representationFingerprint: _fingerprint, ...metadata } = structuredClone(input.representation);
    const preimage = {
        ...metadata,
        dialectId,
        files: files.map((file) => ({
            relativePath: file.relativePath,
            contentKind: file.contentKind,
            mediaType: file.mediaType,
            contentHash: file.contentHash,
            byteSize: file.byteSize,
            executable: file.executable,
        })),
    };
    return {
        inputKind: "native_representation",
        inputRole: "current_exact",
        representation: {
            ...metadata,
            dialectId,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
        },
        files,
    };
}

function emptyClosure(): Parameters<typeof projectVersionDialectInputs>[1] {
    return { nativeRepresentations: [], dialectRestorationPayloads: [], nativePayloads: [], restorationPayloads: [] };
}

function nativeRepresentation(dialectId: string, relativePath: string, bytes: Uint8Array, contentKind: "text" | "binary") {
    const stats = contentKind === "text" ? textPayloadStats(Buffer.from(bytes).toString("utf8")) : binaryPayloadStats(bytes);
    const preimage = {
        schemaVersion: 1 as const,
        dialectId,
        dialectContractFingerprint: HASH,
        canonicalContentFingerprint: HASH,
        files: [
            {
                relativePath: relativePath as never,
                contentKind,
                mediaType: contentKind === "text" ? "text/markdown" : "application/octet-stream",
                contentHash: stats.contentHash,
                byteSize: stats.byteSize,
                executable: false,
            },
        ],
    };
    return {
        representation: {
            ...preimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
        },
        payload: { dialectId, files: [{ relativePath: relativePath as never, bytes: new Uint8Array(bytes) }] },
    };
}
