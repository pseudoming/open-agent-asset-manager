/** Foreign canonical reverse preserves source authority through publication and fresh projection. */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { publishAssetVersion, readVersionAuthority, validateVersionMaterialClosure } from "../../src/catalog/version-authority";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import {
    computeVersionOriginAuthorityFingerprint,
    computeRenderInputFingerprint,
    computeNativeDialectContractFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../src/foundation/fingerprint";
import { deploymentLifecycleInternalsForTest as lifecycle } from "../../src/orchestration/deployment-lifecycle-service";
import {
    isAppliedCanonicalGraphCurrent,
    rebuildSourceNativeGraphs,
} from "../../src/orchestration/deployment-lifecycle-applied-canonical-graph";
import { resolveProviderExactFileDialectInputs } from "../../src/render/render-dialect-authority";
import { deriveRequiredRenderSemanticsV1 } from "../../src/render/render-semantics";
import type { PosixRelativePath, UuidV4 } from "../../src/types";
import { VERSION_ID, VERSION_ID_2, ASSET_ID } from "../catalog/fixtures/version-v2";
import {
    GRAPH_BOUNDARY,
    GRAPH_HASH,
    GRAPH_ENTRY_PATH,
    GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
    GRAPH_CHANGED_ENTRY_TEXT,
    GRAPH_CHANGED_BINARY_RESOURCE,
    GRAPH_CHANGED_TEXT_RESOURCE,
    GRAPH_DIALECT_ID,
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
} from "../render/fixtures/native-project-exact-graph-test-fixtures";
import {
    foreignSourceContract,
    makeForeignCanonicalGraphReverseFixture,
    SOURCE_DIALECT,
    SOURCE_DIRECTORIES,
    SOURCE_ENTRY_DIALECT,
} from "./fixtures/foreign-canonical-graph-reverse-test-fixtures";

type Fixture = ReturnType<typeof makeForeignCanonicalGraphReverseFixture>;
function stage(value: Fixture) {
    const { configuration, inspected, base } = value.invocation;
    return lifecycle.buildStagedReverseVersionContent(configuration, inspected, base, VERSION_ID_2 as UuidV4);
}
function candidate(value: Fixture) {
    return {
        inspected: value.invocation.inspected,
        parent: value.published.closure,
        outputUnitFingerprint: value.materialization.selection.outputUnits[0]!.outputUnitFingerprint,
        dialectInput: value.materialization.dialectInputs[0]!,
        appliedRegistry: value.invocation.inspected.operation.registry,
    };
}
function withFixture(run: (value: Fixture) => void) {
    const value = makeForeignCanonicalGraphReverseFixture();
    try {
        run(value);
    } finally {
        fs.rmSync(value.published.assetsRoot, { recursive: true, force: true });
    }
}
function sourceCandidate(value: Fixture) {
    const staged = stage(value);
    return {
        parent: value.published.closure,
        canonical: staged.canonical as Extract<typeof staged.canonical, { kind: "Skill" }>,
        files: staged.files,
        versionCanonicalContentFingerprint: staged.versionCanonicalContentFingerprint,
        registry: value.published.versionRegistry,
    };
}

describe("foreign canonical graph reverse", () => {
    it("publishes a canonical-only reverse without inventing native authority or changing the saved parent", () => {
        const value = makeForeignCanonicalGraphReverseFixture({}, "canonical_only");
        try {
            const { published } = value;
            const parent = readVersionAuthority(published.assetsRoot, ASSET_ID, VERSION_ID, published.versionRegistry);
            expect(parent?.manifest.nativeRepresentations).toEqual([]);
            expect(parent?.nativePayloads).toEqual([]);
            expect(isAppliedCanonicalGraphCurrent(candidate(value))).toBe(true);
            const staged = stage(value);
            expect(staged.nativeRepresentations).toEqual([]);
            expect(staged.nativePayloads).toEqual([]);
            expect(staged.canonical).toEqual({ kind: "Skill", typeData: published.closure.manifest.typeData });
            expect(staged.files.find((file) => file.file.logicalPath === "SKILL.md")).toMatchObject({
                text: GRAPH_CHANGED_ENTRY_TEXT,
            });
            expect(staged.files.find((file) => file.file.logicalPath === "resources/marker.txt")).toMatchObject({
                text: GRAPH_CHANGED_TEXT_RESOURCE,
                file: { executable: true },
            });
            expect(staged.files.find((file) => file.file.logicalPath === "resources/tool.bin")).toMatchObject({
                bytes: GRAPH_CHANGED_BINARY_RESOURCE,
            });
            const origin = {
                schemaVersion: 1 as const,
                assetId: staged.assetId,
                versionId: staged.versionId,
                originKind: "reverse_accept" as const,
                previousVersionId: staged.parentVersionId,
                previousVersionOriginAuthorityFingerprint: staged.parentOriginAuthorityFingerprint,
                reversePreparationIdentityFingerprint: GRAPH_HASH,
                userActionEvidenceId: "canonical-only-reverse",
                promotionRequirement: staged.promotionRequirement,
                createdAt: published.closure.manifest.createdAt + 1,
            };
            const closure = lifecycle.buildStagedVersionClosure(
                staged,
                { ...origin, authorityFingerprint: computeVersionOriginAuthorityFingerprint(origin) },
                published.fixture.deployment.deploymentId as UuidV4,
            );
            publishAssetVersion({
                assetsRoot: published.assetsRoot,
                transactionId: "txn-canonical-only-reverse",
                version: closure,
                dialectRegistry: published.versionRegistry,
            });
            expect(readVersionAuthority(published.assetsRoot, ASSET_ID, VERSION_ID_2, published.versionRegistry)).toEqual(
                closure,
            );
            expect(readVersionAuthority(published.assetsRoot, ASSET_ID, VERSION_ID, published.versionRegistry)).toEqual(parent);
            expect(lifecycle.projectStagedRenderBase(value.invocation.base, staged).dialectInputs).toEqual([]);
            value.invocation.configuration.render.dialectRegistry = createVersionDialectRegistry(
                [value.sourceNative],
                [published.foreignRestoration],
                [published.portableEntry],
                [],
            );
            expect(() => stage(value)).toThrow(/source-native graph cannot be rebuilt completely/);
        } finally {
            fs.rmSync(value.published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("uses retained Applied graph rules and current rules for the new Version after a renderer upgrade", () =>
        withFixture((value) => {
            const upgraded = makeForeignCanonicalGraphReverseFixture({
                adapterVersion: "0.2.0",
                outputContractId: "FIXTURE_SKILL_CURRENT_GRAPH_V1",
                materializationProfileId: "fixture-skill-current-graph-v1",
            });
            try {
                const old = value.published.fixture,
                    current = upgraded.published.fixture;
                const { configuration, inspected, base } = value.invocation;
                const before = JSON.stringify(inspected.appliedRenderSnapshot);
                inspected.operation.registry = current.registry;
                expect(current.registry.getOutputContract(old.components.outputContracts[0]!.outputContractId)).toBeNull();
                const staged = lifecycle.buildStagedReverseVersionContent(
                    configuration,
                    inspected,
                    base,
                    VERSION_ID_2 as UuidV4,
                    (adapterId, version) =>
                        adapterId === old.provider.adapterId && version === old.provider.version ? old.registry : null,
                );
                expect(inspected.operation.registry).toBe(current.registry);
                expect(JSON.stringify(inspected.appliedRenderSnapshot)).toBe(before);
                expect(staged.nativeRepresentations).toEqual([
                    expect.objectContaining({
                        dialectId: SOURCE_DIALECT,
                        schemaVersion: 2,
                        directories: SOURCE_DIRECTORIES,
                    }),
                ]);
                expect(staged.files.find((file) => file.file.logicalPath === "SKILL.md")).toMatchObject({
                    text: GRAPH_CHANGED_ENTRY_TEXT,
                });
                const projected = lifecycle.projectStagedRenderBase(base, staged);
                const { renderInputFingerprint: _prior, ...preimage } = current.deployment;
                current.deployment = {
                    ...preimage,
                    assets: projected.assets,
                    renderInputFingerprint: computeRenderInputFingerprint({ ...preimage, assets: projected.assets }),
                };
                current.requiredSemantics = deriveRequiredRenderSemanticsV1(current.deployment);
                current.analysisInput = {
                    ...current.analysisInput,
                    requiredSemantics: current.requiredSemantics,
                    deployment: {
                        ...current.analysisInput.deployment,
                        assets: projected.assets,
                        renderInputFingerprint: current.deployment.renderInputFingerprint,
                    },
                    dialectInputs: resolveProviderExactFileDialectInputs({
                        provider: current.provider,
                        deployment: current.deployment,
                        semantics: current.requiredSemantics,
                        available: projected.dialectInputs,
                        renderRegistry: current.registry,
                        dialectRegistry: value.published.versionRegistry,
                    }),
                };
                const input = exactGraphMaterializationInput(current);
                expect(input.selection.outputUnitRenderers[0]!.rendererAdapterVersion).toBe("0.2.0");
                expect(input.selection.outputUnits[0]!.outputContractId).toBe("FIXTURE_SKILL_CURRENT_GRAPH_V1");
                const result = current.support.materialize(input);
                if (result.materializationState !== "materialized")
                    throw new Error("current renderer did not materialize the new Version");
                expect(
                    result.materializedUnits[0]!.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH)?.content,
                ).toEqual({
                    contentKind: "text",
                    text: GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
                });
                expect(
                    current.registry.validateOutputContractMaterialization({
                        contract: current.components.outputContracts[0]!,
                        profile: current.components.outputContracts[0]!.materializationProfiles[0]!,
                        outputUnit: input.selection.outputUnits[0]!,
                        selectedSemantics: current.requiredSemantics,
                        canonicalValues: exactGraphCanonicalValues(current),
                        selectedOptions: input.selection.semanticOptions,
                        dialectInputs: input.dialectInputs,
                        files: result.materializedUnits[0]!.files,
                    }),
                ).toMatchObject({ outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint });
            } finally {
                fs.rmSync(upgraded.published.assetsRoot, { recursive: true, force: true });
            }
        }));

    it("publishes all source bytes, attributes and empty directories, then freshly converts the new Version", () =>
        withFixture((value) => {
            expect(isAppliedCanonicalGraphCurrent(candidate(value))).toBe(true);
            expect(value.invocation.inspected.result.changes).toHaveLength(4);
            const parentBefore = readVersionAuthority(
                value.published.assetsRoot,
                ASSET_ID,
                VERSION_ID,
                value.published.versionRegistry,
            );
            const staged = stage(value);
            expect(staged.allowFirstNativeDialectProjection).toBeUndefined();
            expect(staged.canonical).toEqual({ kind: "Skill", typeData: value.published.closure.manifest.typeData });
            expect(staged.canonical.typeData.entryDialectId).toBe(SOURCE_ENTRY_DIALECT);
            expect(staged.nativeRepresentations).toHaveLength(1);
            expect(staged.nativeRepresentations[0]).toMatchObject({
                dialectId: SOURCE_DIALECT,
                schemaVersion: 2,
                directories: SOURCE_DIRECTORIES,
            });
            expect(staged.nativeRepresentations.some((rep) => rep.dialectId === GRAPH_DIALECT_ID)).toBe(false);
            const entry = staged.nativePayloads[0]!.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH)!;
            expect(Buffer.from(entry.bytes).toString("utf8")).toBe(GRAPH_CHANGED_NATIVE_ENTRY_TEXT);
            expect(staged.files.find((file) => file.file.logicalPath === "SKILL.md")).toMatchObject({
                text: GRAPH_CHANGED_ENTRY_TEXT,
            });
            expect(staged.files.find((file) => file.file.logicalPath === "resources/marker.txt")).toMatchObject({
                text: GRAPH_CHANGED_TEXT_RESOURCE,
                file: { executable: true },
            });
            expect(staged.files.find((file) => file.file.logicalPath === "resources/tool.bin")).toMatchObject({
                bytes: GRAPH_CHANGED_BINARY_RESOURCE,
            });
            const origin = {
                schemaVersion: 1 as const,
                assetId: staged.assetId,
                versionId: staged.versionId,
                originKind: "reverse_accept" as const,
                previousVersionId: staged.parentVersionId,
                previousVersionOriginAuthorityFingerprint: staged.parentOriginAuthorityFingerprint,
                reversePreparationIdentityFingerprint: GRAPH_HASH,
                userActionEvidenceId: "foreign-graph-reverse",
                promotionRequirement: staged.promotionRequirement,
                createdAt: value.published.closure.manifest.createdAt + 1,
            };
            const closure = lifecycle.buildStagedVersionClosure(
                staged,
                { ...origin, authorityFingerprint: computeVersionOriginAuthorityFingerprint(origin) },
                value.published.fixture.deployment.deploymentId as UuidV4,
            );
            validateVersionMaterialClosure(closure, value.published.versionRegistry);
            publishAssetVersion({
                assetsRoot: value.published.assetsRoot,
                transactionId: "txn-foreign-reverse",
                version: closure,
                dialectRegistry: value.published.versionRegistry,
            });
            expect(
                readVersionAuthority(value.published.assetsRoot, ASSET_ID, VERSION_ID_2, value.published.versionRegistry),
            ).toEqual(closure);
            expect(
                readVersionAuthority(value.published.assetsRoot, ASSET_ID, VERSION_ID, value.published.versionRegistry),
            ).toEqual(parentBefore);
            const projected = lifecycle.projectStagedRenderBase(value.invocation.base, staged);
            expect(projected.dialectInputs[0]!.inputs[0]).toMatchObject({
                inputKind: "native_representation",
                representation: { dialectId: SOURCE_DIALECT },
            });
            const fixture = value.published.fixture;
            const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
            fixture.deployment = {
                ...preimage,
                assets: projected.assets,
                renderInputFingerprint: computeRenderInputFingerprint({ ...preimage, assets: projected.assets }),
            };
            fixture.requiredSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
            fixture.analysisInput = {
                ...fixture.analysisInput,
                requiredSemantics: fixture.requiredSemantics,
                deployment: {
                    ...fixture.analysisInput.deployment,
                    assets: projected.assets,
                    renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                },
                dialectInputs: resolveProviderExactFileDialectInputs({
                    provider: fixture.provider,
                    deployment: fixture.deployment,
                    semantics: fixture.requiredSemantics,
                    available: projected.dialectInputs,
                }),
            };
            expect(fixture.analysisInput.dialectInputs[0]!.inputs[0]).toMatchObject({
                inputKind: "canonical_materialization",
                logicalDirectoryPaths: ["empty", "resources"],
            });
            const input = exactGraphMaterializationInput(fixture);
            const result = fixture.support.materialize(input);
            if (result.materializationState !== "materialized") throw new Error("fresh conversion did not materialize");
            expect(result.materializedUnits[0]!.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH)?.content).toEqual({
                contentKind: "text",
                text: GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
            });
            expect(input.selection.outputUnits[0]!.managedDirectoryBoundaries[0]).toMatchObject({
                desiredDirectoryPaths: SOURCE_DIRECTORIES,
            });
            expect(
                fixture.registry.validateOutputContractMaterialization({
                    contract: fixture.components.outputContracts[0]!,
                    profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                    outputUnit: input.selection.outputUnits[0]!,
                    selectedSemantics: fixture.requiredSemantics,
                    canonicalValues: exactGraphCanonicalValues(fixture),
                    selectedOptions: input.selection.semanticOptions,
                    dialectInputs: input.dialectInputs,
                    files: result.materializedUnits[0]!.files,
                }),
            ).toMatchObject({ outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint });
        }));

    it.each([
        "unit_missing",
        "unit_duplicate",
        "renderer_missing",
        "renderer_duplicate",
        "proof_missing",
        "proof_duplicate",
        "proof_changed",
        "contract_missing",
        "contract_changed",
        "profile_missing",
        "profile_changed",
        "source_path",
        "source_ambiguous",
        "source_empty",
        "directory_changed",
        "dialect_changed",
        "version_changed",
        "semantic_changed",
        "invalid_utf8",
        "validator_throw",
    ])("rejects the changed applied authority: %s", (variant) =>
        withFixture((value) => {
            const input = candidate(value),
                snapshot = input.inspected.appliedRenderSnapshot;
            if (variant === "unit_missing") snapshot.outputUnits = [];
            if (variant === "unit_duplicate") snapshot.outputUnits.push(snapshot.outputUnits[0]!);
            if (variant === "renderer_missing") snapshot.outputUnitRenderers = [];
            if (variant === "renderer_duplicate") snapshot.outputUnitRenderers.push(snapshot.outputUnitRenderers[0]!);
            if (variant === "proof_missing") snapshot.semanticCoverageProofs = [];
            if (variant === "proof_duplicate") snapshot.semanticCoverageProofs.push(snapshot.semanticCoverageProofs[0]!);
            if (variant === "proof_changed") snapshot.semanticCoverageProofs[0]!.coverageFingerprint = GRAPH_HASH;
            if (variant === "contract_missing") snapshot.outputUnits[0]!.outputContractId = "missing";
            if (variant === "contract_changed") snapshot.outputUnits[0]!.outputContractFingerprint = GRAPH_HASH;
            if (variant === "profile_missing") snapshot.outputUnitRenderers[0]!.materializationProfileId = "missing";
            if (variant === "profile_changed") snapshot.outputUnitRenderers[0]!.profileConstraintFingerprint = GRAPH_HASH;
            if (variant === "source_path") input.parent.files[0]!.file.logicalPath = "missing" as PosixRelativePath;
            if (variant === "source_ambiguous") input.parent.files.push(structuredClone(input.parent.files[0]!));
            if (variant === "source_empty") input.parent.files = [];
            if (variant === "directory_changed")
                snapshot.outputUnits[0]!.managedDirectoryBoundaries[0]!.desiredDirectoryPaths!.pop();
            if (variant === "dialect_changed")
                input.dialectInput.inputs[0] = {
                    ...input.dialectInput.inputs[0]!,
                    materializer: { componentId: "other", componentVersion: 1, configFingerprint: GRAPH_HASH },
                } as never;
            if (variant === "version_changed") snapshot.decisions[0]!.semanticRef.subject.versionId = VERSION_ID_2;
            if (variant === "semantic_changed") snapshot.decisions.pop();
            if (variant === "invalid_utf8") {
                const state = input.inspected.input.inspectionScope.fileStates.find(
                    (item) => item.relativePath === GRAPH_ENTRY_PATH,
                )!;
                state.state = "unchanged";
                state.appliedContentHash = binaryPayloadStats(Uint8Array.of(255)).contentHash;
                input.inspected.input.files = input.inspected.input.files.filter(
                    (item) => item.relativePath !== GRAPH_ENTRY_PATH,
                );
                const authority = input.inspected.runtimeReplacementAuthority.files.find(
                    (item) => item.relativePath === GRAPH_ENTRY_PATH,
                )!;
                if (authority.expectedState !== "present") throw new Error("expected present authority");
                authority.expectedBytes = Uint8Array.of(255);
            }
            if (variant === "validator_throw")
                input.appliedRegistry = {
                    ...input.appliedRegistry,
                    validateOutputContractMaterialization: () => {
                        throw new Error("validator fault");
                    },
                };
            expect(isAppliedCanonicalGraphCurrent(input)).toBe(false);
        }));

    it("does not let a graph narrowed to one file borrow the complete applied proof", () =>
        withFixture((value) => {
            const input = candidate(value);
            input.parent.files = input.parent.files.filter((file) => file.file.logicalPath === "SKILL.md");
            expect(isAppliedCanonicalGraphCurrent(input)).toBe(false);
            input.inspected.appliedRenderSnapshot.outputUnits[0]!.claims =
                input.inspected.appliedRenderSnapshot.outputUnits[0]!.claims.filter(
                    (file) => file.relativePath === GRAPH_ENTRY_PATH,
                );
            input.inspected.input.inspectionScope.fileStates = input.inspected.input.inspectionScope.fileStates.filter(
                (file) => file.relativePath === GRAPH_ENTRY_PATH,
            );
            expect(isAppliedCanonicalGraphCurrent(input)).toBe(false);
        }));

    it("binds a recomputed proof even when a validator repeats the retained proof", () =>
        withFixture((value) => {
            const input = candidate(value),
                retained = input.inspected.appliedRenderSnapshot.semanticCoverageProofs[0]!;
            input.inspected.appliedRenderSnapshot.decisions.pop();
            input.inspected.operation.registry = {
                ...input.inspected.operation.registry,
                validateOutputContractMaterialization: () => retained,
            };
            expect(isAppliedCanonicalGraphCurrent(input)).toBe(false);
        }));

    it.each([
        "missing_contract",
        "wrong_contract",
        "missing_callback",
        "null_result",
        "incomplete",
        "duplicate",
        "path_changed",
        "malformed",
        "same_content_failed",
        "source_empty",
        "missing_payload",
        "source_absent",
        "source_restoration_only",
    ])("rejects incomplete source rebuilding without publishing: %s", (variant) =>
        withFixture((value) => {
            const input = sourceCandidate(value),
                source = foreignSourceContract();
            if (variant === "wrong_contract")
                source.definition.canonicalConsistencyValidator = {
                    ...source.definition.canonicalConsistencyValidator,
                    configFingerprint: `sha256:${"7".repeat(64)}` as typeof GRAPH_HASH,
                };
            if (variant === "missing_callback") delete source.rebase;
            if (variant === "null_result") source.rebase!.materialize = () => null;
            if (["incomplete", "duplicate", "path_changed", "malformed"].includes(variant)) {
                const original = source.rebase!.materialize;
                source.rebase!.materialize = (arg) => {
                    const result = original(arg)!;
                    if (variant === "incomplete") result.nativeFiles.pop();
                    if (variant === "duplicate") result.nativeFiles.push(result.nativeFiles[0]!);
                    if (variant === "path_changed") result.nativeFiles[0]!.relativePath = `${GRAPH_BOUNDARY}/moved`;
                    if (variant === "malformed") return { nativeFiles: [null] } as never;
                    return result;
                };
            }
            if (variant === "same_content_failed") source.validateSameContent = () => false;
            if (variant === "source_empty") input.parent.manifest.nativeRepresentations = [];
            if (variant === "missing_payload") input.parent.nativePayloads = [];
            if (variant === "source_absent" || variant === "source_restoration_only") {
                input.parent.manifest.nativeRepresentations = [];
                input.parent.nativePayloads = [];
            }
            if (variant === "source_restoration_only") {
                const bytes = Uint8Array.of(9, 8, 7);
                input.parent.manifest.dialectRestorationPayloads = [
                    {
                        dialectId: "foreign-restoration-only-v1",
                        restorationContractFingerprint: GRAPH_HASH,
                        contentHash: binaryPayloadStats(bytes).contentHash,
                    },
                ];
                input.parent.restorationPayloads = [{ dialectId: "foreign-restoration-only-v1", bytes }];
            }
            input.registry = createVersionDialectRegistry(variant === "missing_contract" ? [] : [source], [], [], []);
            expect(() => rebuildSourceNativeGraphs(input)).toThrow(/source-native graph cannot be rebuilt completely/);
            expect(
                readVersionAuthority(value.published.assetsRoot, ASSET_ID, VERSION_ID_2, value.published.versionRegistry),
            ).toBeNull();
        }));

    it("requires every saved source representation to rebase successfully", () =>
        withFixture((value) => {
            const input = sourceCandidate(value),
                before = structuredClone(input.parent),
                original = foreignSourceContract();
            const secondId = "second-skill-folder-v1";
            const second = {
                ...original,
                definition: { ...structuredClone(original.definition), dialectId: secondId },
                validateSameContent: (arg: Parameters<typeof original.validateSameContent>[0]) =>
                    original.validateSameContent({
                        ...arg,
                        representation: { ...arg.representation, dialectId: SOURCE_DIALECT },
                    }),
            };
            const { representationFingerprint: _old, ...base } = input.parent.manifest.nativeRepresentations[0]!;
            const preimage = {
                ...base,
                dialectId: secondId,
                dialectContractFingerprint: computeNativeDialectContractFingerprint(second.definition),
            };
            input.parent.manifest.nativeRepresentations.push({
                ...preimage,
                representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
            });
            input.parent.nativePayloads.push({ ...structuredClone(input.parent.nativePayloads[0]!), dialectId: secondId });
            input.registry = createVersionDialectRegistry([original, second], [], [], []);
            const result = rebuildSourceNativeGraphs(input);
            expect(result.nativeRepresentations.map((rep) => rep.dialectId).sort()).toEqual([SOURCE_DIALECT, secondId].sort());
            expect(
                result.nativeRepresentations.every(
                    (rep) => rep.schemaVersion === 2 && JSON.stringify(rep.directories) === JSON.stringify(SOURCE_DIRECTORIES),
                ),
            ).toBe(true);
            expect(result.nativePayloads.map((payload) => payload.files)).toEqual([
                result.nativePayloads[0]!.files,
                result.nativePayloads[0]!.files,
            ]);
            delete second.rebase;
            input.registry = createVersionDialectRegistry([original, second], [], [], []);
            expect(() => rebuildSourceNativeGraphs(input)).toThrow(/source-native graph cannot be rebuilt completely/);
            expect(input.parent.nativePayloads[0]).toEqual(before.nativePayloads[0]);
        }));

    it("blocks inventory drift and a stale applied proof before staging a new Version", () =>
        withFixture((value) => {
            const snapshot = value.invocation.inspected.appliedRenderSnapshot;
            snapshot.semanticCoverageProofs[0]!.coverageFingerprint = GRAPH_HASH;
            expect(() => stage(value)).toThrow(/no unique applied target-dialect input/);
            value.invocation.inspected.input.inventoryDeltas.push({} as never);
            expect(() => stage(value)).toThrow(/uniquely attributable existing-file/);
            expect(
                readVersionAuthority(value.published.assetsRoot, ASSET_ID, VERSION_ID_2, value.published.versionRegistry),
            ).toBeNull();
        }));

    it("keeps schema 1 source graphs at schema 1", () =>
        withFixture((value) => {
            const input = sourceCandidate(value),
                rep = input.parent.manifest.nativeRepresentations[0]!;
            const { directories: _directories, ...schema1 } = rep as Extract<typeof rep, { schemaVersion: 2 }>;
            input.parent.manifest.nativeRepresentations[0] = { ...schema1, schemaVersion: 1 };
            expect(rebuildSourceNativeGraphs(input).nativeRepresentations[0]).toMatchObject({
                schemaVersion: 1,
                dialectId: SOURCE_DIALECT,
            });
            expect(rebuildSourceNativeGraphs(input).nativeRepresentations[0]).not.toHaveProperty("directories");
        }));
});
