import { validateDialectInputProjection } from "../../src/render/render-analysis-validator";
import { resolveProviderExactFileDialectInputs } from "../../src/render/render-dialect-authority";
import { describe, expect, it } from "vitest";
import {
    projectCanonicalDirectoryAuthority,
    projectCanonicalOutputDirectories,
} from "../../src/render/canonical-materialization-directories";
import {
    computeProviderRenderDialectInputFingerprint,
    computeRenderOutputUnitFingerprint,
} from "../../src/foundation/fingerprint";
import {
    GRAPH_BOUNDARY,
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    graphCanonicalMaterializer,
    makeExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";

function savedGraph() {
    const fixture = makeExactGraphFixture({
        nativeDirectories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`],
    });
    const asset = structuredClone(fixture.deployment.assets[0]!);
    const available = structuredClone(fixture.analysisInput.dialectInputs[0]!);
    const native = available.inputs[0]!;
    if (native.inputKind !== "native_representation" || native.representation.schemaVersion !== 2)
        throw new Error("schema-2 graph fixture is missing");
    return { asset, available, native };
}

describe("immutable canonical directory authority", () => {
    it("binds absent, known-empty and changed directory inventories into the operation fingerprint", () => {
        const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const request = exactGraphMaterializationInput(fixture);
        const fingerprints = [undefined, [], ["empty"], ["empty", "resources"]].map((directories) => {
            const inputs = structuredClone(request.dialectInputs);
            const canonical = inputs[0]!.inputs[0]!;
            if (canonical.inputKind !== "canonical_materialization") throw new Error("canonical token is missing");
            if (directories !== undefined) canonical.logicalDirectoryPaths = directories;
            return computeProviderRenderDialectInputFingerprint({
                adapterId: fixture.provider.adapterId,
                adapterVersion: fixture.provider.version,
                dialectInputs: inputs,
            });
        });
        expect(new Set(fingerprints).size).toBe(4);
    });

    it("rejects malformed directory tokens before analysis and preserves the exact valid graph", () => {
        const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const token = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
        if (token.inputKind !== "canonical_materialization") throw new Error("canonical token is missing");
        token.logicalDirectoryPaths = ["empty", "resources"];
        validateDialectInputProjection(fixture.analysisInput.dialectInputs, fixture.deployment.assets, fixture.requiredSemantics);
        const request = exactGraphMaterializationInput(fixture);
        expect(fixture.support.materialize(request).materializationState).toBe("materialized");
        for (const invalid of ["not-an-array", ["../outside"], ["empty", "empty"], ["resources", "empty"]]) {
            const groups = structuredClone(request.dialectInputs);
            Object.assign(groups[0]!.inputs[0]!, { logicalDirectoryPaths: invalid });
            expect(() => validateDialectInputProjection(groups, fixture.deployment.assets, fixture.requiredSemantics)).toThrow(
                /immutable reviewed migration/,
            );
        }
        token.logicalDirectoryPaths = ["empty"];
        expect(fixture.support.analyze(fixture.analysisInput)).toMatchObject({ status: "failed", outputUnits: [] });
        const materialized = fixture.support.materialize(request);
        if (materialized.materializationState !== "materialized") throw new Error("complete output is missing");
        const invalidGroups = structuredClone(request.dialectInputs);
        Object.assign(invalidGroups[0]!.inputs[0]!, { logicalDirectoryPaths: ["empty"] });
        expect(() =>
            fixture.registry.validateOutputContractMaterialization({
                contract: fixture.components.outputContracts[0]!,
                profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: request.selection.outputUnits[0]!,
                selectedSemantics: fixture.requiredSemantics,
                canonicalValues: exactGraphCanonicalValues(fixture),
                selectedOptions: request.selection.semanticOptions,
                dialectInputs: invalidGroups,
                files: materialized.materializedUnits[0]!.files,
            }),
        ).toThrow(/materialization violates/);
    });

    it("does not offer conversion when the immutable source directory inventory escapes its owned graph", () => {
        const source = savedGraph();
        source.native.representation.directories.push("outside-source-root");
        source.native.representation.directories.sort();
        const target = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const provider = structuredClone(target.provider);
        const declaration = provider.renderContractDeclarations[0]!;
        if (declaration.declarationKind !== "native_project_exact_graph_v1") throw new Error("graph declaration is missing");
        declaration.nativeDialectId = "foreign-target-graph-v1";
        expect(
            resolveProviderExactFileDialectInputs({
                provider,
                deployment: target.deployment,
                semantics: target.requiredSemantics,
                available: [source.available],
            }),
        ).toEqual([]);
    });

    it("projects the saved complete graph into a different owned root without reading live paths", () => {
        const input = savedGraph();
        const before = structuredClone(input);
        expect(projectCanonicalDirectoryAuthority(input.asset, input.available)).toEqual({
            logicalDirectoryPaths: ["empty", "resources"],
        });
        const root = "targets/copied-skill";
        const projection = {
            managedDirectoryBoundaries: [root],
            files: input.asset.version.files.map((file) => ({
                canonicalLogicalPath: file.file.logicalPath,
                nativeRelativePath: `${root}/${file.file.logicalPath}`,
            })),
        };
        expect(projectCanonicalOutputDirectories(["empty", "resources"], projection)).toEqual([
            root,
            `${root}/empty`,
            `${root}/resources`,
        ]);
        expect(input).toEqual(before);
    });

    it("does not infer empty directories from a saved schema-1 representation or parent-only graph", () => {
        const historical = makeExactGraphFixture();
        expect(
            projectCanonicalDirectoryAuthority(historical.deployment.assets[0]!, historical.analysisInput.dialectInputs[0]!),
        ).toEqual({});
        const input = savedGraph();
        input.available.inputs = [
            {
                ...input.native,
                inputRole: "parent_rebase_seed",
                sourceVersion: { ...input.asset.version.ref, versionId: "55555555-5555-4555-8555-555555555555" },
            },
        ];
        expect(projectCanonicalDirectoryAuthority(input.asset, input.available)).toEqual({});
        expect(projectCanonicalOutputDirectories(undefined, { managedDirectoryBoundaries: [], files: [] })).toBeNull();
    });

    it("accepts equivalent immutable graphs but never combines inconsistent directory inventories", () => {
        const input = savedGraph();
        const second = structuredClone(input.native);
        second.representation.dialectId = "another-verified-native-graph";
        input.available.inputs.push(second);
        expect(projectCanonicalDirectoryAuthority(input.asset, input.available)).toEqual({
            logicalDirectoryPaths: ["empty", "resources"],
        });
        second.representation.directories = [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/other-empty`, `${GRAPH_BOUNDARY}/resources`];
        expect(projectCanonicalDirectoryAuthority(input.asset, input.available)).toBeNull();
    });

    it("rejects wrong Version ownership, incomplete mappings and directories outside the saved owned root", () => {
        const mutations: Array<(input: ReturnType<typeof savedGraph>) => void> = [
            (input) => {
                input.available.targetVersion.versionId = "55555555-5555-4555-8555-555555555555";
            },
            (input) => {
                input.asset.version.files[0]!.file.logicalPath = "../outside";
            },
            (input) => {
                input.asset.version.files[1]!.file.logicalPath = input.asset.version.files[0]!.file.logicalPath;
            },
            (input) => {
                input.native.files.pop();
            },
            (input) => {
                input.native.files[1]!.relativePath = input.native.files[0]!.relativePath;
            },
            (input) => {
                input.native.files[0]!.relativePath = "different-root/renamed-entry.md";
            },
            (input) => {
                input.native.representation.directories.push("other-owned-root");
                input.native.representation.directories.sort();
            },
            (input) => {
                input.native.representation.directories = [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`];
            },
            (input) => {
                input.asset.version.files = [];
                input.native.files = [];
            },
        ];
        for (const mutate of mutations) {
            const input = savedGraph();
            mutate(input);
            expect(projectCanonicalDirectoryAuthority(input.asset, input.available)).toBeNull();
        }
    });

    it("rejects target remapping, multiple roots, malformed directory paths and missing resource parents", () => {
        const source = savedGraph();
        const root = "targets/copied-skill";
        const projection = {
            managedDirectoryBoundaries: [root],
            files: source.asset.version.files.map((file) => ({
                canonicalLogicalPath: file.file.logicalPath,
                nativeRelativePath: `${root}/${file.file.logicalPath}`,
            })),
        };
        for (const directories of [["../outside"], ["empty", "empty", "resources"], ["resources", "empty"], ["empty"]]) {
            expect(projectCanonicalOutputDirectories(directories, projection)).toBeNull();
        }
        expect(
            projectCanonicalOutputDirectories(["empty", "resources"], { ...projection, managedDirectoryBoundaries: [] }),
        ).toBeNull();
        expect(
            projectCanonicalOutputDirectories(["empty", "resources"], {
                ...projection,
                managedDirectoryBoundaries: [root, "other"],
            }),
        ).toBeNull();
        projection.files[0]!.nativeRelativePath += ".renamed";
        expect(projectCanonicalOutputDirectories(["empty", "resources"], projection)).toBeNull();
    });

    it("rejects resource renaming or path exchange even when historical conversion has no directory facts", () => {
        for (const mutation of ["rename", "exchange"] as const) {
            const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
            const request = exactGraphMaterializationInput(fixture);
            const result = fixture.support.materialize(request);
            if (result.materializationState !== "materialized") throw new Error("canonical graph fixture failed");
            const files = result.materializedUnits[0]!.files;
            const unit = request.selection.outputUnits[0]!;
            const resources = files.filter((file) => !file.relativePath.endsWith("/SKILL.md"));
            const [first, second] = resources;
            if (first === undefined || second === undefined) throw new Error("two resources are required");
            const firstPath = first.relativePath;
            const secondPath = second.relativePath;
            first.relativePath = mutation === "rename" ? `${firstPath}.renamed` : secondPath;
            unit.claims.find((claim) => claim.relativePath === firstPath)!.relativePath = first.relativePath;
            if (mutation === "exchange") {
                second.relativePath = firstPath;
                unit.claims.find(
                    (claim) => claim.relativePath === secondPath && claim.contentKind === second.content.contentKind,
                )!.relativePath = firstPath;
            }
            unit.outputUnitFingerprint = computeRenderOutputUnitFingerprint(unit);
            for (const option of request.selection.semanticOptions)
                option.requiredOutputUnitFingerprints = [unit.outputUnitFingerprint];
            expect(() =>
                fixture.registry.validateOutputContractMaterialization({
                    contract: fixture.components.outputContracts[0]!,
                    profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                    outputUnit: unit,
                    selectedSemantics: fixture.requiredSemantics,
                    canonicalValues: exactGraphCanonicalValues(fixture),
                    selectedOptions: request.selection.semanticOptions,
                    dialectInputs: request.dialectInputs,
                    files,
                }),
            ).toThrow(/materialization violates/u);
        }
    });
});
