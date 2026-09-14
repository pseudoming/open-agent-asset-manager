/** Result matching, projection, rebase and inspection guards for exact native graphs. */

import { describe, expect, it } from "vitest";
import type { PosixRelativePath, UuidV4 } from "../../src/types";
import type { RenderNativeRepresentationFileInput } from "../../src/contracts/render";
import { computeRenderInputFingerprint } from "../../src/foundation/fingerprint";
import { deriveRequiredRenderSemanticsV1 } from "../../src/render/render-semantics";
import {
    canonicalPathForNativeGraphFile,
    findExactGraphAssets,
    graphSemanticRefs,
    hasExactGraphBoundaryClosure,
    hasExactNativeDirectoryGraph,
    safeGraphProjection,
    safeGraphReverseParse,
    type NativeProjectExactGraphProviderBehavior,
} from "../../src/render/native-project-exact-graph-results";
import { makeNativeProjectExactGraphContractParts } from "../../src/render/native-project-exact-graph";
import {
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_ENTRY_PATH,
    GRAPH_HASH,
    GRAPH_NATIVE_ENTRY_TEXT,
    changedExactGraphInspection,
    exactGraphMaterializationInput,
    makeExactGraphFixture,
    makeParentGraphRebaseFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";
import {
    graphCanonicalMaterializer,
    graphRebaseMaterializer,
    parseChangedGraphFile,
    projectFixtureGraph,
} from "./fixtures/native-project-exact-graph-native-test-fixtures";

const OTHER_ASSET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as UuidV4;
const OTHER_VERSION = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" as UuidV4;

describe("native project exact-graph result guards", () => {
    it("accepts only a complete uniquely-owned native directory graph", () => {
        const boundary = GRAPH_BOUNDARY;
        const resource = `${boundary}/resources` as PosixRelativePath;
        const file = `${resource}/marker.txt` as PosixRelativePath;
        expect(hasExactNativeDirectoryGraph([boundary, resource], [file], [boundary])).toBe(true);
        for (const [directories, files, boundaries] of [
            [[], [file], [boundary]],
            [[boundary, boundary], [file], [boundary]],
            [[resource, boundary], [file], [boundary]],
            [[boundary, "../unsafe"], [file], [boundary]],
            [[boundary, file], [file], [boundary]],
            [[boundary, resource], [file], ["other"]],
            [[boundary, resource], ["other/file"], [boundary]],
            [[boundary, resource], [file], [boundary, resource]],
            [[boundary, `${boundary}/missing/leaf`], [file], [boundary]],
        ] as const) {
            expect(
                hasExactNativeDirectoryGraph(
                    directories as readonly PosixRelativePath[],
                    files as readonly PosixRelativePath[],
                    boundaries as readonly PosixRelativePath[],
                ),
            ).toBe(false);
        }
    });

    it("rejects duplicate, mismatched and wrong-kind Asset/dialect closures", () => {
        const cases: Array<(fixture: ReturnType<typeof makeExactGraphFixture>) => void> = [
            (fixture) => {
                fixture.analysisInput.deployment.assets.push(structuredClone(fixture.analysisInput.deployment.assets[0]!));
                fixture.analysisInput.dialectInputs.push(structuredClone(fixture.analysisInput.dialectInputs[0]!));
            },
            (fixture) => {
                const second = makeSecondGraph(fixture, ".fixture/skills/other", false);
                fixture.analysisInput.deployment.assets.push(second.asset);
                fixture.analysisInput.dialectInputs.push(structuredClone(fixture.analysisInput.dialectInputs[0]!));
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.targetVersion.versionId = OTHER_VERSION;
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.canonical = {
                    kind: "Workflow",
                    typeData: { schemaVersion: 1, invocation: { mode: "manual" } },
                } as never;
            },
        ];
        for (const mutate of cases) {
            const fixture = makeExactGraphFixture();
            mutate(fixture);
            expect(findExactGraphAssets(fixture.analysisInput, graphBehavior(fixture))).toBeNull();
        }

        const invalidDirectoryGraph = makeExactGraphFixture({
            nativeDirectories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/missing/leaf`],
        });
        expect(findExactGraphAssets(invalidDirectoryGraph.analysisInput, graphBehavior(invalidDirectoryGraph))).toBeNull();
    });

    it("sorts distinct graph boundaries and rejects two Assets projected onto one physical directory", () => {
        const fixture = makeExactGraphFixture();
        const other = makeSecondGraph(fixture, ".fixture/skills/alpha", false);
        fixture.analysisInput.deployment.assets.unshift(other.asset);
        fixture.analysisInput.dialectInputs.unshift(other.group);
        const resolved = findExactGraphAssets(fixture.analysisInput, graphBehavior(fixture));
        expect(resolved?.map((item) => item.projection.graphIdentityRelativePath)).toEqual([
            ".fixture/skills/alpha/SKILL.md",
            GRAPH_ENTRY_PATH,
        ]);

        const duplicate = makeExactGraphFixture();
        const same = makeSecondGraph(duplicate, GRAPH_BOUNDARY, true);
        duplicate.analysisInput.deployment.assets.push(same.asset);
        duplicate.analysisInput.dialectInputs.push(same.group);
        expect(findExactGraphAssets(duplicate.analysisInput, graphBehavior(duplicate))).toBeNull();
    });

    it("orders two complete analyzed graph units and their semantic options deterministically", () => {
        const fixture = makeExactGraphFixture();
        const other = makeSecondGraph(fixture, ".fixture/skills/alpha", false);
        const deployment = structuredClone(fixture.deployment);
        deployment.assets.unshift(other.asset);
        const { renderInputFingerprint: _old, ...preimage } = deployment;
        deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
        const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
        const result = fixture.support.analyze({
            schemaVersion: 1,
            deployment: {
                schemaVersion: 1,
                platform: deployment.platform,
                platformInstanceId: deployment.platformInstanceId,
                targetContexts: deployment.targetContexts,
                assets: deployment.assets,
                renderInputFingerprint: deployment.renderInputFingerprint,
            },
            requiredSemantics,
            dialectInputs: [other.group, ...fixture.analysisInput.dialectInputs],
        });
        expect(result.status).toBe("complete");
        expect(result.outputUnits).toHaveLength(2);
        expect(result.semanticOptions.length).toBeGreaterThan(fixture.requiredSemantics.length);
    });

    it("requires exact restoration identity and a safe parent graph rebase", () => {
        const restorationMismatch = makeExactGraphFixture();
        restorationMismatch.analysisInput.dialectInputs[0]!.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-restoration-v1",
                restorationContractFingerprint: GRAPH_HASH,
                contentHash: GRAPH_HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(findExactGraphAssets(restorationMismatch.analysisInput, graphBehavior(restorationMismatch))).toBeNull();

        for (const materialize of [
            () => null,
            () => ({ nativeFiles: "bad" as never }),
            () => ({ nativeFiles: [], extra: true }) as never,
            () => {
                throw new Error("fixture rebase failure");
            },
        ]) {
            const fixture = makeParentGraphRebaseFixture();
            const behavior = graphBehavior(fixture);
            behavior.rebaseMaterializer = { ...graphRebaseMaterializer, materialize };
            expect(findExactGraphAssets(fixture.analysisInput, behavior)).toBeNull();
        }
    });

    it("rejects malformed, unsafe and throwing canonical graph materializers", () => {
        const missingMaterializer = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const missingMaterializerBehavior = graphBehavior(missingMaterializer);
        missingMaterializerBehavior.canonicalMaterializer = null;
        expect(findExactGraphAssets(missingMaterializer.analysisInput, missingMaterializerBehavior)).toBeNull();

        const missingAuthority = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const missingAuthorityGroup = missingAuthority.analysisInput.dialectInputs[0];
        if (missingAuthorityGroup === undefined) throw new Error("canonical graph fixture group is missing");
        missingAuthorityGroup.inputs = [];
        expect(findExactGraphAssets(missingAuthority.analysisInput, graphBehavior(missingAuthority))).toBeNull();

        for (const materialize of [
            () => null,
            () => ({ nativeFiles: "bad" as never }),
            () => ({ nativeFiles: [] }),
            () => {
                throw new Error("fixture canonical materialization failure");
            },
        ]) {
            const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
            const behavior = graphBehavior(fixture);
            behavior.canonicalMaterializer = { ...graphCanonicalMaterializer, materialize };
            expect(findExactGraphAssets(fixture.analysisInput, behavior)).toBeNull();
        }
    });

    it("fails graph projection on invalid boundaries, duplicate paths, mismatched inventory and Provider exceptions", () => {
        const fixture = makeExactGraphFixture();
        const behavior = graphBehavior(fixture);
        const native = nativeFiles(fixture);
        const projected = projectFixtureGraph(native);
        expect(projected).not.toBeNull();
        expect(safeGraphProjection(behavior, native)).toEqual(projected);

        const standaloneNative = native.filter((file) => file.relativePath === GRAPH_ENTRY_PATH);
        const standaloneCanonical = fixture.closure.files.filter((file) => file.file.logicalPath === "SKILL.md");
        const standaloneProjection = {
            graphIdentityRelativePath: GRAPH_ENTRY_PATH,
            files: [{ nativeRelativePath: GRAPH_ENTRY_PATH, canonicalLogicalPath: "SKILL.md" as PosixRelativePath }],
            managedDirectoryBoundaries: [],
        };
        expect(
            safeGraphProjection(
                { ...behavior, projectNativeGraph: () => standaloneProjection },
                standaloneNative,
                standaloneCanonical,
            ),
        ).toEqual(standaloneProjection);
        expect(() => canonicalPathForNativeGraphFile(standaloneProjection, "missing.js" as PosixRelativePath)).toThrow(
            "no unique canonical mapping",
        );

        const cases: Array<{
            files?: RenderNativeRepresentationFileInput[];
            canonical?: typeof fixture.closure.files;
            project?: NativeProjectExactGraphProviderBehavior["projectNativeGraph"];
        }> = [
            { project: () => null },
            {
                project: () => ({
                    ...structuredClone(projected!),
                    graphIdentityRelativePath: "../bad" as PosixRelativePath,
                }),
            },
            {
                project: () => ({
                    ...structuredClone(projected!),
                    graphIdentityRelativePath: `${GRAPH_BOUNDARY}/assets/marker.bin` as PosixRelativePath,
                }),
            },
            { files: [...native, structuredClone(native[0]!)] },
            { canonical: fixture.closure.files.slice(0, 2) },
            { project: () => ({ ...structuredClone(projected!), managedDirectoryBoundaries: [] }) },
            {
                project: () => ({
                    ...structuredClone(projected!),
                    managedDirectoryBoundaries: [`${GRAPH_BOUNDARY}/resources` as PosixRelativePath],
                }),
            },
            {
                project: () => {
                    throw new Error("projection failure");
                },
            },
        ];
        for (const value of cases) {
            const candidate = { ...behavior, projectNativeGraph: value.project ?? behavior.projectNativeGraph };
            expect(safeGraphProjection(candidate, value.files ?? native, value.canonical ?? fixture.closure.files)).toBeNull();
        }

        expect(hasExactGraphBoundaryClosure([], [])).toBe(false);
        expect(hasExactGraphBoundaryClosure([GRAPH_ENTRY_PATH], [GRAPH_BOUNDARY, GRAPH_BOUNDARY])).toBe(false);
        expect(hasExactGraphBoundaryClosure([GRAPH_ENTRY_PATH], ["../bad" as PosixRelativePath])).toBe(false);
        expect(
            hasExactGraphBoundaryClosure([GRAPH_ENTRY_PATH], [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/assets` as PosixRelativePath]),
        ).toBe(false);
    });

    it("accepts only one declared binary JSONC graph identity and rejects every identity drift", () => {
        const fixture = makeExactGraphFixture({
            jsoncTopLevelPropertyPatch: {
                propertyName: "instructions",
                allowedContainerRelativePaths: [GRAPH_BINARY_RESOURCE_PATH],
            },
        });
        const behavior = graphBehavior(fixture);
        const native = nativeFiles(fixture);
        expect(safeGraphProjection(behavior, native, fixture.closure.files)).toMatchObject({
            graphIdentityRelativePath: GRAPH_BINARY_RESOURCE_PATH,
            managedDirectoryBoundaries: [],
        });

        const missing = native.filter((file) => file.relativePath !== GRAPH_BINARY_RESOURCE_PATH);
        expect(safeGraphProjection(behavior, missing, fixture.closure.files)).toBeNull();

        for (const mutate of [
            (files: typeof native) => {
                const identity = files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH)!;
                identity.contentKind = "text" as never;
            },
            (files: typeof native) => {
                files.find((file) => file.relativePath === GRAPH_BINARY_RESOURCE_PATH)!.executable = true;
            },
        ]) {
            const changed = structuredClone(native);
            mutate(changed);
            expect(safeGraphProjection(behavior, changed, fixture.closure.files)).toBeNull();
        }

        for (const mutate of [
            (files: typeof fixture.closure.files) => {
                files.find((file) => file.file.logicalPath === "resources/tool.bin")!.file.role = "entry";
            },
            (files: typeof fixture.closure.files) => {
                files.find((file) => file.file.logicalPath === "resources/tool.bin")!.contentKind = "text" as never;
            },
            (files: typeof fixture.closure.files) => {
                files.find((file) => file.file.logicalPath === "resources/tool.bin")!.file.executable = true;
            },
        ]) {
            const changed = structuredClone(fixture.closure.files);
            mutate(changed);
            expect(safeGraphProjection(behavior, native, changed)).toBeNull();
        }

        expect(
            safeGraphProjection(
                {
                    ...behavior,
                    projectNativeGraph: (files) => {
                        const projected = fixture.graphProjector(files);
                        return projected === null ? null : { ...projected, graphIdentityRelativePath: GRAPH_ENTRY_PATH };
                    },
                },
                native,
                fixture.closure.files,
            ),
        ).toBeNull();
    });

    it("keeps reverse parsing bounded to one valid canonical content result", () => {
        const fixture = makeExactGraphFixture();
        const behavior = graphBehavior(fixture);
        const applied = { contentKind: "text" as const, text: GRAPH_NATIVE_ENTRY_TEXT };
        const current = { contentKind: "text" as const, text: GRAPH_NATIVE_ENTRY_TEXT };
        expect(safeGraphReverseParse(behavior, GRAPH_ENTRY_PATH, applied, current)?.canonicalContent.contentKind).toBe("text");

        for (const parse of [
            () => null,
            () => ({ canonicalContent: current, extra: true }) as never,
            () => ({ canonicalContent: { contentKind: "missing" } }) as never,
            () => {
                throw new Error("parser failure");
            },
        ]) {
            expect(
                safeGraphReverseParse({ ...behavior, parseChangedNativeFile: parse }, GRAPH_ENTRY_PATH, applied, current),
            ).toBeNull();
        }
    });

    it("returns no semantic refs for an unknown canonical member", () => {
        const fixture = makeExactGraphFixture();
        const asset = fixture.analysisInput.deployment.assets[0]! as never;
        expect(graphSemanticRefs(fixture.requiredSemantics, asset, "missing.txt")).toEqual([]);
    });

    it("blocks malformed inspection structure, stale render ownership and non-reconcilable existing files", () => {
        const fixture = makeExactGraphFixture();
        expect(fixture.support.inspect({} as never)).toMatchObject({ status: "failed", files: [] });
        const materialization = exactGraphMaterializationInput(fixture);
        const base = changedExactGraphInspection(fixture, materialization);
        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.appliedRenderSnapshot.outputUnits[0]!.claims[0]!.relativePath = "outside.txt";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.rendererAdapterVersion = "9.9.9";
            },
            (input) => {
                input.inspectionScope.fileStates[0]!.outputUnitFingerprint = GRAPH_HASH;
            },
            (input) => {
                input.inspectionScope.fileStates.pop();
            },
            (input) => {
                const file = input.files[0]!;
                if (file.fileState === "baseline_changed") file.provenance.sectionBindings.push({} as never);
            },
            (input) => {
                const file = input.files[0]!;
                if (file.fileState === "baseline_changed") file.provenance.semanticRefFingerprints = [];
            },
            (input) => {
                input.appliedRenderSnapshot.decisions = input.appliedRenderSnapshot.decisions.filter(
                    (decision) => decision.semanticRef.semanticKind !== "asset.file_inventory",
                );
            },
            (input) => {
                const file = input.files[0]!;
                if (file.fileState === "baseline_changed") {
                    file.diffHunks = [];
                    file.attributeChanges = [];
                }
                input.files = [file];
            },
            (input) => {
                input.appliedRenderSnapshot.decisions.push(
                    structuredClone(
                        input.appliedRenderSnapshot.decisions.find(
                            (decision) => decision.semanticRef.subject.subjectKind === "file",
                        )!,
                    ),
                );
            },
            (input) => {
                input.appliedRenderSnapshot.decisions.push(
                    structuredClone(
                        input.appliedRenderSnapshot.decisions.find(
                            (decision) => decision.semanticRef.semanticKind === "asset.file_inventory",
                        )!,
                    ),
                );
            },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const input = structuredClone(base);
            mutate(input);
            const result = fixture.support.inspect(input);
            expect(
                result.status === "failed" || result.files.some((file) => file.attributionState === "conflict"),
                `inspection guard mutation ${index}`,
            ).toBe(true);
        }
    });
});

function graphBehavior(fixture: ReturnType<typeof makeExactGraphFixture>): NativeProjectExactGraphProviderBehavior {
    const { profile, outputContract } = makeNativeProjectExactGraphContractParts(fixture.support.renderContractDeclaration);
    return {
        adapterId: fixture.provider.adapterId,
        adapterVersion: fixture.provider.version,
        profile,
        profileConstraintFingerprint: outputContract.materializationProfiles[0]!.profileConstraintFingerprint,
        targetContextSchema: fixture.support.targetContextSchema,
        materializerCapability: fixture.support.materializerCapability,
        outputContract,
        projectNativeGraph: fixture.graphProjector,
        parseChangedNativeFile: parseChangedGraphFile,
        rebaseMaterializer: graphRebaseMaterializer,
    };
}

function nativeFiles(fixture: ReturnType<typeof makeExactGraphFixture>) {
    const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (input.inputKind !== "native_representation") throw new Error("native graph fixture is missing");
    return structuredClone(input.files);
}

function makeSecondGraph(fixture: ReturnType<typeof makeExactGraphFixture>, boundary: string, preserveBoundary: boolean) {
    const asset = structuredClone(fixture.analysisInput.deployment.assets[0]!);
    asset.version.ref = { assetId: OTHER_ASSET, versionId: OTHER_VERSION };
    const group = structuredClone(fixture.analysisInput.dialectInputs[0]!);
    group.targetVersion = { assetId: OTHER_ASSET, versionId: OTHER_VERSION };
    const native = group.inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native graph fixture is missing");
    if (!preserveBoundary) {
        for (const file of native.files) {
            file.relativePath = file.relativePath.replace(GRAPH_BOUNDARY, boundary) as PosixRelativePath;
        }
    }
    return { asset, group };
}
