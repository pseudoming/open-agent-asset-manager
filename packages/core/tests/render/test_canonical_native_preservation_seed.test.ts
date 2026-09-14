import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import {
    computeNativeDialectContractFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../src/foundation/fingerprint";
import { validateDialectInputProjection } from "../../src/render/render-analysis-validator";
import { resolveProviderExactFileDialectInputs } from "../../src/render/render-dialect-authority";
import {
    canonicalNativePreservationSeedMatchesContract,
    projectCanonicalNativePreservationSeed,
} from "../../src/render/canonical-native-preservation-seed";
import { isExactGraphNativeConsistencySatisfied } from "../../src/render/native-project-exact-graph-consistency";
import type { CanonicalNativePreservationSeed, ProviderRenderDialectInputsForAsset } from "../../src/contracts/render";
import {
    GRAPH_BOUNDARY,
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    graphCanonicalMaterializer,
    makeExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";
import {
    makeGraphDialectInput,
    makeGraphNativeDialectContract,
} from "./fixtures/native-project-exact-graph-native-test-fixtures";

const SOURCE = "fixture-skill-historical-v1";
const OTHER = "fixture-skill-historical-v2";
const DIRECTORIES = [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`];
const FOREIGN_VERSION = "88888888-8888-4888-8888-888888888888";

function fixtureWithSeed() {
    const materializerSeeds: CanonicalNativePreservationSeed[] = [],
        validatorSeeds: CanonicalNativePreservationSeed[] = [];
    const fixture = makeExactGraphFixture({
        canonicalMaterializer: {
            ...graphCanonicalMaterializer,
            preservationDialectIds: [SOURCE, OTHER],
            materialize(input) {
                if (input.nativePreservationSeed === undefined || graphCanonicalMaterializer.materialize(input) === null)
                    return null;
                materializerSeeds.push(structuredClone(input.nativePreservationSeed));
                return { nativeFiles: structuredClone(input.nativePreservationSeed.files) };
            },
            validateEntry(input) {
                if (input.nativePreservationSeed === undefined) return false;
                validatorSeeds.push(structuredClone(input.nativePreservationSeed));
                return graphCanonicalMaterializer.validateEntry(input);
            },
        },
    });
    const contract = makeGraphNativeDialectContract(SOURCE),
        otherContract = makeGraphNativeDialectContract(OTHER);
    const dialectRegistry = createVersionDialectRegistry([contract, otherContract, fixture.nativeDialect], [], [], []);
    const asset = fixture.deployment.assets[0]!;
    const available = makeGraphDialectInput(asset.version.versionCanonicalContentFingerprint, contract, {
        directories: DIRECTORIES,
    });
    const route = (candidate = available, registry = dialectRegistry) =>
        resolveProviderExactFileDialectInputs({
            provider: fixture.provider,
            deployment: fixture.deployment,
            semantics: fixture.requiredSemantics,
            available: [candidate],
            dialectRegistry: registry,
        });
    return { fixture, asset, available, contract, otherContract, dialectRegistry, route, materializerSeeds, validatorSeeds };
}
function requireSeed(groups: ProviderRenderDialectInputsForAsset[]): CanonicalNativePreservationSeed {
    const token = groups[0]?.inputs[0];
    if (token?.inputKind !== "canonical_materialization" || token.nativePreservationSeed === undefined)
        throw new Error("expected preservation seed");
    return token.nativePreservationSeed;
}

describe("canonical current native preservation seed", () => {
    it.each(["assetId", "versionId"] as const)("rejects preservation bytes addressed to a foreign %s", (field) => {
        const value = fixtureWithSeed();
        const foreign = structuredClone(value.available);
        foreign.targetVersion[field] = FOREIGN_VERSION;
        expect(projectCanonicalNativePreservationSeed(value.asset, foreign, [SOURCE], value.dialectRegistry)).toBeNull();
        expect(
            projectCanonicalNativePreservationSeed(value.asset, value.available, [SOURCE], value.dialectRegistry)
                ?.nativePreservationSeed,
        ).toEqual(requireSeed(value.route()));
    });
    it("carries the same historical graph through materialization, entry validation and final consistency", () => {
        const value = fixtureWithSeed(),
            { fixture } = value,
            groups = value.route(),
            seed = requireSeed(groups);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.inputs).toHaveLength(1);
        expect(seed.representation.dialectId).toBe(SOURCE);
        expect(groups[0]!.inputs[0]).toMatchObject({ logicalDirectoryPaths: ["empty", "resources"] });
        expect(seed.files).toHaveLength(3);
        validateDialectInputProjection(groups, fixture.deployment.assets, fixture.requiredSemantics);
        fixture.analysisInput.dialectInputs = groups;
        const request = exactGraphMaterializationInput(fixture),
            result = fixture.support.materialize(request);
        if (result.materializationState !== "materialized") throw new Error("preserved graph did not materialize");
        const files = result.materializedUnits[0]!.files;
        const validation = {
            contract: fixture.components.outputContracts[0]!,
            profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
            outputUnit: request.selection.outputUnits[0]!,
            selectedSemantics: fixture.requiredSemantics,
            canonicalValues: exactGraphCanonicalValues(fixture),
            selectedOptions: request.selection.semanticOptions,
            dialectInputs: request.dialectInputs,
            files,
        };
        const proof = fixture.registry.validateOutputContractMaterialization(validation);
        expect(value.materializerSeeds.length).toBeGreaterThan(0);
        for (const actual of value.materializerSeeds) expect(actual).toEqual(seed);
        expect(value.validatorSeeds).toEqual([seed]);
        const consistency = (dialectInputs = groups) =>
            isExactGraphNativeConsistencySatisfied({
                deployment: fixture.deployment,
                provider: fixture.provider,
                semantics: fixture.requiredSemantics,
                dialectInputs,
                outputUnit: request.selection.outputUnits[0]!,
                renderer: request.selection.outputUnitRenderers[0]!,
                files,
                dialectRegistry: value.dialectRegistry,
                canonicalCoverageProof: proof,
            });
        expect(consistency()).toBe(true);
        const forged = structuredClone(groups);
        requireSeed(forged).representation.dialectContractFingerprint = `sha256:${"0".repeat(64)}`;
        expect(consistency(forged)).toBe(false);
        const outputUnit = structuredClone(validation.outputUnit),
            boundary = outputUnit.managedDirectoryBoundaries[0]!;
        if (!("desiredDirectoryPaths" in boundary)) throw new Error("expected complete directory authority");
        boundary.desiredDirectoryPaths = [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/resources`];
        expect(() => fixture.registry.validateOutputContractMaterialization({ ...validation, outputUnit })).toThrow();
    });

    it("rejects missing/mismatched contracts, changed payloads, wrong canonical authority and multiple seeds", () => {
        const value = fixtureWithSeed(),
            seed = requireSeed(value.route());
        const native = value.available.inputs[0]!;
        if (native.inputKind !== "native_representation") throw new Error("missing source native");
        expect(canonicalNativePreservationSeedMatchesContract(seed, value.asset, undefined)).toBe(false);
        expect(value.route(value.available, createVersionDialectRegistry([], [], [], []))).toEqual([]);
        const foreignVersion = structuredClone(value.available);
        foreignVersion.targetVersion.versionId = FOREIGN_VERSION;
        const unseeded = value.route(foreignVersion);
        expect(unseeded[0]!.inputs[0]).not.toHaveProperty("nativePreservationSeed");
        expect(value.fixture.support.analyze({ ...value.fixture.analysisInput, dialectInputs: unseeded }).status).toBe("failed");
        const mutations: ((candidate: typeof value.available) => void)[] = [
            (candidate) => {
                candidate.inputs.push(structuredClone(native));
            },
            (candidate) => {
                candidate.inputs.push(
                    ...makeGraphDialectInput(value.asset.version.versionCanonicalContentFingerprint, value.otherContract, {
                        directories: DIRECTORIES,
                    }).inputs,
                );
            },
            (candidate) => {
                const item = candidate.inputs[0]!;
                if (item.inputKind === "native_representation")
                    item.representation.canonicalContentFingerprint = `sha256:${"0".repeat(64)}`;
            },
            (candidate) => {
                const item = candidate.inputs[0]!;
                if (item.inputKind === "native_representation")
                    item.representation.dialectContractFingerprint = `sha256:${"0".repeat(64)}`;
            },
            (candidate) => {
                const item = candidate.inputs[0]!;
                if (item.inputKind === "native_representation") {
                    const file = item.files.find((file) => file.contentKind === "binary");
                    if (file?.contentKind === "binary") file.bytes[0] = 99;
                }
            },
            (candidate) => {
                const item = candidate.inputs[0]!;
                if (item.inputKind === "native_representation") item.files[0]!.relativePath = "../escape";
            },
        ];
        for (const mutate of mutations) {
            const candidate = structuredClone(value.available);
            mutate(candidate);
            expect(value.route(candidate)).toEqual([]);
        }
        const forged = structuredClone(seed);
        forged.representation.dialectContractFingerprint = computeNativeDialectContractFingerprint({
            ...value.contract.definition,
            nativeToCanonicalParser: { ...value.contract.definition.nativeToCanonicalParser, componentVersion: 99 },
        });
        forged.representation.representationFingerprint = computeVersionNativeRepresentationFingerprint({
            ...forged.representation,
            files: forged.files.map(({ relativePath, contentKind, mediaType, contentHash, byteSize, executable }) => ({
                relativePath,
                contentKind,
                mediaType,
                contentHash,
                byteSize,
                executable,
            })),
        });
        expect(canonicalNativePreservationSeedMatchesContract(forged, value.asset, value.dialectRegistry)).toBe(false);
    });

    it("excludes parent and unrelated representations from current-Version preservation", () => {
        const value = fixtureWithSeed(),
            native = value.available.inputs[0]!;
        if (native.inputKind !== "native_representation") throw new Error("missing native input");
        value.available.inputs = [
            {
                ...native,
                inputRole: "parent_rebase_seed",
                sourceVersion: { assetId: value.available.targetVersion.assetId, versionId: FOREIGN_VERSION },
            },
        ];
        expect(value.route()[0]!.inputs[0]).not.toHaveProperty("nativePreservationSeed");
        value.available.inputs = [{ ...native, representation: { ...native.representation, dialectId: "unrelated-v1" } }];
        expect(value.route()[0]!.inputs[0]).not.toHaveProperty("nativePreservationSeed");
    });

    it("fingerprints seed content, metadata, directories and exact Version/consumer/materializer bindings", () => {
        const value = fixtureWithSeed(),
            original = value.route();
        const fingerprint = (groups: typeof original) =>
            computeProviderRenderDialectInputFingerprint({
                adapterId: value.fixture.provider.adapterId,
                adapterVersion: value.fixture.provider.version,
                dialectInputs: groups,
            });
        const mutations: ((groups: typeof original) => void)[] = [
            (groups) => {
                groups[0]!.targetVersion.versionId = FOREIGN_VERSION;
            },
            (groups) => {
                groups[0]!.consumerAgentRuntimeIds = ["FOREIGN_CLI"];
            },
            (groups) => {
                const token = groups[0]!.inputs[0]!;
                if (token.inputKind === "canonical_materialization") token.materializer.componentVersion++;
            },
            (groups) => {
                requireSeed(groups).files[0]!.executable = true;
            },
            (groups) => {
                const seed = requireSeed(groups);
                if (seed.representation.schemaVersion === 2) seed.representation.directories.push(`${GRAPH_BOUNDARY}/extra`);
            },
            (groups) => {
                const file = requireSeed(groups).files.find((file) => file.contentKind === "binary");
                if (file?.contentKind === "binary") file.bytes[0] = 99;
            },
        ];
        for (const mutate of mutations) {
            const groups = structuredClone(original);
            mutate(groups);
            expect(fingerprint(groups)).not.toBe(fingerprint(original));
        }
        const extra = structuredClone(original);
        Object.assign(requireSeed(extra), { sourceVersion: extra[0]!.targetVersion });
        expect(() =>
            validateDialectInputProjection(extra, value.fixture.deployment.assets, value.fixture.requiredSemantics),
        ).toThrow(/only immutable/);
    });

    it.each(
        [[], [SOURCE, SOURCE], [OTHER, SOURCE], [" "], ["bad\0id"]].map((preservationDialectIds) => ({ preservationDialectIds })),
    )("rejects malformed preservation declarations $preservationDialectIds", ({ preservationDialectIds }) => {
        expect(() =>
            makeExactGraphFixture({ canonicalMaterializer: { ...graphCanonicalMaterializer, preservationDialectIds } }),
        ).toThrow();
    });
});
