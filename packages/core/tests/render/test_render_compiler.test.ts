import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppliedInputsSnapshotV1 } from "../../src/types";
import {
    compileRenderDeployment,
    openValidatedCompiledDeploymentPlan,
    type ValidatedCompiledDeploymentPlan,
} from "../../src/render/render-compiler";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-dialect-registry";
import { computeMaterializationFingerprint, computeRenderSelectionFingerprint } from "../../src/foundation/fingerprint";
import { makeLifecycleFixture, materializeFixtureResult } from "./fixtures/render-lifecycle-fixtures";

let root = "";
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-render-compiler-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function compilerFixture(options: Parameters<typeof makeLifecycleFixture>[1] = {}) {
    const fixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "fixture-")), options);
    const materialization = await materializeRenderDeployment(
        {
            deployment: fixture.deployment,
            analysis: fixture.analysis,
            selection: fixture.selection,
        },
        {
            registry: fixture.registry,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            resolveDialectInputs: () => [],
            dispatch: async (_adapterId, input) => ({
                status: "complete",
                value: materializeFixtureResult(input),
                diagnostics: [],
            }),
        },
    );
    if (materialization.status !== "complete") throw new Error("fixture materialization failed");
    const appliedInputsSnapshot: AppliedInputsSnapshotV1 = {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        consumerAgentRuntimeIds: [...fixture.deployment.consumerAgentRuntimeIds],
        assets: fixture.deployment.assets.map((asset) => ({
            assetId: asset.version.ref.assetId,
            versionId: asset.version.ref.versionId,
            allowIncomplete: asset.allowIncomplete,
        })),
    };
    return { ...fixture, materialization: materialization.value, appliedInputsSnapshot };
}

function compile(fixture: Awaited<ReturnType<typeof compilerFixture>>) {
    return compileRenderDeployment({
        deployment: fixture.deployment,
        analysis: fixture.analysis,
        selection: fixture.selection,
        materialization: fixture.materialization,
        appliedInputsSnapshot: fixture.appliedInputsSnapshot,
    });
}

function refreshSelection(fixture: Awaited<ReturnType<typeof compilerFixture>>): void {
    const { selectionFingerprint: _stored, schemaVersion: _schemaVersion, ...preimage } = fixture.selection;
    fixture.selection.selectionFingerprint = computeRenderSelectionFingerprint(preimage);
    fixture.materialization.selectionFingerprint = fixture.selection.selectionFingerprint;
}

describe("Core render compiler", () => {
    it("rejects an unresolved shared-container patch before producing an executable plan", async () => {
        const fixture = await compilerFixture();
        fixture.materialization.units[0]!.files[0]!.containerPatch = {
            patchKind: "jsonc_top_level_property_value",
            propertyName: "instructions",
        };
        const result = compile(fixture);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("render.compile_container_patch_unresolved");
    });

    it.each([
        null,
        `sha256:${"c".repeat(64)}`,
    ])("preserves the resolved shared-container preimage %s in the compiled file", async (hash) => {
        const fixture = await compilerFixture();
        fixture.materialization.units[0]!.files[0]!.containerPatchPreimageHash = hash;
        const result = compile(fixture);
        expect(result.status).toBe("complete");
        expect(openValidatedCompiledDeploymentPlan(result.value).targetPlan.targetFiles[0]!.containerPatchPreimageHash).toBe(
            hash,
        );
    });

    it("creates one opaque snapshot-isolated handoff with exact snapshot and provenance", async () => {
        const fixture = await compilerFixture();
        const result = compile(fixture);
        expect(result.status).toBe("complete");
        expect(JSON.stringify(result.value)).toBe("{}");
        const opened = openValidatedCompiledDeploymentPlan(result.value);
        expect(opened.compilationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(opened.targetPlan.targetFiles).toEqual([
            expect.objectContaining({
                relativePath: "AGENTS.md",
                outputUnitFingerprint: fixture.selection.outputUnits[0]!.outputUnitFingerprint,
                materializationFingerprint: fixture.materialization.units[0]!.materializationFingerprint,
                semanticRefFingerprints: expect.any(Array),
                sectionBindings: [],
            }),
        ]);
        expect(opened.executionAuthority.appliedRenderSnapshot).toEqual(
            expect.objectContaining({
                snapshotState: "applied",
                compilationFingerprint: opened.compilationFingerprint,
                selectionFingerprint: fixture.selection.selectionFingerprint,
            }),
        );
        expect(opened.executionAuthority.targetFileProvenance[0]?.provenance).toEqual(
            expect.objectContaining({
                outputUnitFingerprint: opened.targetPlan.targetFiles[0]?.outputUnitFingerprint,
                materializationFingerprint: opened.targetPlan.targetFiles[0]?.materializationFingerprint,
            }),
        );
        fixture.materialization.units[0]!.files[0]!.content = {
            contentKind: "text",
            text: "mutated after compile",
        };
        expect((opened.targetPlan.targetFiles[0]?.content as { text: string }).text).toBe("# materialized\n");
        opened.targetPlan.targetFiles[0]!.relativePath = "caller-mutated.md";
        expect(openValidatedCompiledDeploymentPlan(result.value).targetPlan.targetFiles[0]?.relativePath).toBe("AGENTS.md");
    });

    it("canonicalizes multiple output units and their coverage proofs", async () => {
        const fixture = await compilerFixture({
            analysisResultOptions: { additionalOutputUnitPaths: ["SECOND.md"] },
        });
        const result = compile(fixture);
        expect(result.status).toBe("complete");
        const opened = openValidatedCompiledDeploymentPlan(result.value);
        expect(opened.targetPlan.targetFiles).toHaveLength(2);
        expect(opened.executionAuthority.appliedRenderSnapshot.semanticCoverageProofs).toHaveLength(2);
    });

    it("canonicalizes multiple non-overlapping managed directory boundaries", async () => {
        const fixture = await compilerFixture({
            analysisResultOptions: {
                relativePath: "managed-z/SKILL.md",
                managedDirectoryBoundary: "managed-z",
                additionalClaimPaths: ["managed-a/SKILL.md"],
                additionalManagedDirectoryBoundaries: ["managed-a"],
            },
        });
        const result = compile(fixture);
        expect(result.status).toBe("complete");
        expect(openValidatedCompiledDeploymentPlan(result.value).targetPlan.managedDirectoryBoundaries).toEqual([
            expect.objectContaining({ relativePath: "managed-a" }),
            expect.objectContaining({ relativePath: "managed-z" }),
        ]);
    });

    it("compiles one exact V2 managed-directory graph into execution authority", async () => {
        const fixture = await compilerFixture({
            analysisResultOptions: {
                relativePath: "managed/SKILL.md",
                managedDirectoryBoundary: "managed",
                desiredDirectoryPaths: ["managed", "managed/empty"],
            },
        });
        const result = compile(fixture);
        expect(result.status).toBe("complete");
        expect(openValidatedCompiledDeploymentPlan(result.value).targetPlan.managedDirectoryBoundaries).toEqual([
            {
                relativePath: "managed",
                outputUnitFingerprint: fixture.selection.outputUnits[0]!.outputUnitFingerprint,
                desiredDirectoryPaths: ["managed", "managed/empty"],
            },
        ]);
    });

    it("rejects a forged process-local compiled token", () => {
        expect(() => openValidatedCompiledDeploymentPlan({} as ValidatedCompiledDeploymentPlan)).toThrow(
            /forged or belongs to another process/,
        );
    });

    it("rejects an invalid, foreign, or incomplete AppliedInputsSnapshot", async () => {
        const cases: Array<(fixture: Awaited<ReturnType<typeof compilerFixture>>) => void> = [
            (fixture) => {
                fixture.appliedInputsSnapshot.schemaVersion = 2 as never;
            },
            (fixture) => {
                fixture.appliedInputsSnapshot.deploymentId = "foreign";
            },
            (fixture) => {
                fixture.appliedInputsSnapshot.consumerAgentRuntimeIds = [];
            },
            (fixture) => {
                fixture.appliedInputsSnapshot.assets = [];
            },
        ];
        for (const mutate of cases) {
            const fixture = await compilerFixture();
            mutate(fixture);
            const result = compile(fixture);
            expect(result.status).toBe("failed");
        }
    });

    it("rejects stale render, selection, and materialization closures", async () => {
        const cases: Array<[string, (fixture: Awaited<ReturnType<typeof compilerFixture>>) => void]> = [
            [
                "render.compile_closure_stale",
                (fixture) => {
                    fixture.analysis.renderInputFingerprint = `sha256:${"a".repeat(64)}`;
                },
            ],
            [
                "render.compile_closure_stale",
                (fixture) => {
                    fixture.materialization.selectionFingerprint = `sha256:${"a".repeat(64)}`;
                },
            ],
            [
                "render.compile_selection_fingerprint_mismatch",
                (fixture) => {
                    fixture.selection.selectionFingerprint = `sha256:${"b".repeat(64)}`;
                    fixture.materialization.selectionFingerprint = fixture.selection.selectionFingerprint;
                },
            ],
            [
                "render.compile_closure_mismatch",
                (fixture) => {
                    fixture.materialization.units = [];
                },
            ],
            [
                "render.compile_closure_mismatch",
                (fixture) => {
                    fixture.materialization.units.push(structuredClone(fixture.materialization.units[0]!));
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const fixture = await compilerFixture();
            mutate(fixture);
            const result = compile(fixture);
            expect(result.diagnostics[0]?.code).toBe(code);
        }
    });

    it("rejects overlapping physical files even when forged materialization units are present", async () => {
        const fixture = await compilerFixture();
        const second = structuredClone(fixture.materialization.units[0]!);
        second.outputUnit.outputUnitFingerprint = `sha256:${"c".repeat(64)}`;
        second.renderer.outputUnitFingerprint = second.outputUnit.outputUnitFingerprint;
        second.semanticCoverageProof.outputUnitFingerprint = second.outputUnit.outputUnitFingerprint;
        second.materializationFingerprint = computeMaterializationFingerprint({
            rendererAdapterId: second.renderer.rendererAdapterId,
            rendererAdapterVersion: second.renderer.rendererAdapterVersion,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            selectionFingerprint: fixture.selection.selectionFingerprint,
            outputUnitFingerprint: second.outputUnit.outputUnitFingerprint,
            materializerCapabilityKey: second.renderer.materializerCapabilityKey,
            materializationProfileId: second.renderer.materializationProfileId,
            profileConstraintFingerprint: second.renderer.profileConstraintFingerprint,
            providerRenderDialectInputFingerprint: second.providerRenderDialectInputFingerprint,
            files: second.files,
        });
        fixture.materialization.units.push(second);
        fixture.selection.outputUnits.push(second.outputUnit);
        fixture.selection.outputUnitRenderers.push(second.renderer);
        refreshSelection(fixture);
        expect(compile(fixture).diagnostics[0]?.code).toBe("render.compile_target_path_overlap");
    });

    it("fails closed when a selected option no longer resolves in the analysis", async () => {
        const fixture = await compilerFixture();
        fixture.selection.semanticOptions[0]!.optionFingerprint = `sha256:${"d".repeat(64)}`;
        refreshSelection(fixture);
        const result = compile(fixture);
        expect(result.diagnostics[0]?.code).toBe("render.compile_option_closure_invalid");
    });

    it("preserves the exact approved degradation in the successful snapshot", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(root, "degraded-"));
        const base = await makeLifecycleFixture(fixtureRoot, {
            analysisResultOptions: {
                outcome: "degraded",
            },
            approveRequiredOption: true,
        });
        const materialization = await materializeRenderDeployment(
            {
                deployment: base.deployment,
                analysis: base.analysis,
                selection: base.selection,
            },
            {
                registry: base.registry,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                resolveDialectInputs: () => [],
                dispatch: async (_adapterId, input) => ({
                    status: "complete",
                    value: materializeFixtureResult(input),
                    diagnostics: [],
                }),
            },
        );
        if (materialization.status !== "complete") throw new Error("fixture failed");
        const result = compileRenderDeployment({
            deployment: base.deployment,
            analysis: base.analysis,
            selection: base.selection,
            materialization: materialization.value,
            appliedInputsSnapshot: {
                schemaVersion: 1,
                deploymentId: base.deployment.deploymentId,
                consumerAgentRuntimeIds: [...base.deployment.consumerAgentRuntimeIds],
                assets: base.deployment.assets.map((asset) => ({
                    assetId: asset.version.ref.assetId,
                    versionId: asset.version.ref.versionId,
                    allowIncomplete: asset.allowIncomplete,
                })),
            },
        });
        expect(result.status).toBe("complete");
        expect(openValidatedCompiledDeploymentPlan(result.value).executionAuthority.appliedRenderSnapshot.decisions[0]).toEqual(
            expect.objectContaining({
                outcome: "degraded",
                degradationKinds: ["runtime_specific_metadata_lost"],
                approval: expect.objectContaining({ approvalState: "approved" }),
            }),
        );
    });

    it("turns a non-Error compiler authority failure into a typed diagnostic", async () => {
        const fixture = await compilerFixture();
        fixture.appliedInputsSnapshot = new Proxy(fixture.appliedInputsSnapshot, {
            get() {
                throw "snapshot read exploded";
            },
        });
        const result = compile(fixture);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "render.compile_internal_error",
                message: "snapshot read exploded",
            }),
        );
    });
});
