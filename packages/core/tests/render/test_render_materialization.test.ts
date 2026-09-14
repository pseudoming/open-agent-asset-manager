import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textPayloadStats } from "../../src/catalog/payload-store";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-dialect-registry";
import type {
    MaterializedRenderFile,
    ProviderRenderDialectInputsForAsset,
    RenderMaterializationInput,
    RenderMaterializationResult,
} from "../../src/contracts/render";
import {
    computeRenderInputFingerprint,
    computeRenderObservationSelectionFingerprint,
    computeRenderSelectionFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../src/foundation/fingerprint";
import {
    clearRegistry,
    dispatchMaterializeRender,
    enableAdapter,
    registerAdapterProvider,
} from "../../src/orchestration/adapter-registry";
import { materializeRenderDeployment, materializeRenderObservation } from "../../src/render/render-materialization";
import { resolveAssetUsageObservationSelection } from "../../src/render/render-selection";
import { makeBinaryFile, makeTextFile, makeVersionClosure } from "../catalog/fixtures/version-v2";
import {
    makeFixture as makeNativeProjectGuidanceFixture,
    materializationInput as makeNativeProjectGuidanceMaterializationInput,
} from "./fixtures/native-project-guidance-test-fixtures";
import {
    makeLifecycleAdapterProvider,
    makeLifecycleFixture,
    materializeFixtureResult,
} from "./fixtures/render-lifecycle-fixtures";

let root = "";
beforeEach(() => {
    clearRegistry();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-render-materialization-"));
});
afterEach(() => {
    clearRegistry();
    fs.rmSync(root, { recursive: true, force: true });
});

async function run(
    fixture: Awaited<ReturnType<typeof makeLifecycleFixture>>,
    options: {
        registry?: Awaited<ReturnType<typeof makeLifecycleFixture>>["registry"];
        resolveDialectInputs?: () => ProviderRenderDialectInputsForAsset[];
        dispatch?: (input: RenderMaterializationInput) => Promise<{
            status: "complete" | "partial" | "failed";
            value: RenderMaterializationResult;
            diagnostics: [];
        }>;
    } = {},
) {
    return materializeRenderDeployment(
        {
            deployment: fixture.deployment,
            analysis: fixture.analysis,
            selection: fixture.selection,
        },
        {
            registry: options.registry ?? fixture.registry,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            resolveDialectInputs: options.resolveDialectInputs ?? (() => []),
            dispatch: async (adapterId, input) => {
                if (options.dispatch !== undefined) return options.dispatch(input);
                expect(adapterId).toBe(fixture.provider.adapterId);
                return {
                    status: "complete",
                    value: materializeFixtureResult(input),
                    diagnostics: [],
                };
            },
        },
    );
}

function refreshSelection(fixture: Awaited<ReturnType<typeof makeLifecycleFixture>>): void {
    const { selectionFingerprint: _stored, schemaVersion: _schemaVersion, ...preimage } = fixture.selection;
    fixture.selection.selectionFingerprint = computeRenderSelectionFingerprint(preimage);
}

function materializedWith(
    input: RenderMaterializationInput,
    mutate: (result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>) => void,
): RenderMaterializationResult {
    const result = materializeFixtureResult(input);
    if (result.materializationState !== "materialized") throw new Error("fixture mismatch");
    mutate(result);
    return result;
}

describe("Core render materialization", () => {
    it("materializes a fingerprint-bound read-only observation without approval or compiler authority", async () => {
        const fixture = await makeLifecycleFixture(root);
        const consumer = fixture.deployment.consumerAgentRuntimeIds[0];
        if (consumer === undefined) throw new Error("fixture consumer is missing");
        const selected = resolveAssetUsageObservationSelection(
            { deployment: fixture.deployment, analysis: fixture.analysis },
            fixture.registry,
            [consumer],
        );
        expect(selected.status, JSON.stringify(selected.diagnostics)).toBe("complete");
        let captured: RenderMaterializationInput | undefined;
        const configuration = {
            registry: fixture.registry,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            resolveDialectInputs: () => [],
            dispatch: async (_adapterId: string, input: RenderMaterializationInput) => {
                captured = structuredClone(input);
                return { status: "complete" as const, value: materializeFixtureResult(input), diagnostics: [] };
            },
        };
        const result = await materializeRenderObservation(
            {
                deployment: fixture.deployment,
                analysis: fixture.analysis,
                observationSelection: selected.value,
            },
            configuration,
        );
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(captured?.selection.semanticOptions[0]).not.toHaveProperty("approval");
        expect(captured?.selection).not.toHaveProperty("promotionAuthorizations");
        expect(captured).not.toHaveProperty("deploymentId");

        const foreign = structuredClone(selected.value);
        foreign.selection.semanticOptions[0]!.optionFingerprint = `sha256:${"8".repeat(64)}`;
        foreign.selectionFingerprint = computeRenderObservationSelectionFingerprint({
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            selection: foreign.selection,
        });
        const rejected = await materializeRenderObservation(
            {
                deployment: fixture.deployment,
                analysis: fixture.analysis,
                observationSelection: foreign,
            },
            configuration,
        );
        expect(rejected.status).toBe("failed");
        expect(rejected.diagnostics[0]?.code).toBe("asset_usage.observation_option_stale");

        const rejectChangedAuthority = async (
            mutate: (authority: typeof selected.value) => void,
            code: string,
            registry = fixture.registry,
        ) => {
            const changed = structuredClone(selected.value);
            mutate(changed);
            changed.selectionFingerprint = computeRenderObservationSelectionFingerprint({
                renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                selection: changed.selection,
            });
            const outcome = await materializeRenderObservation(
                {
                    deployment: fixture.deployment,
                    analysis: fixture.analysis,
                    observationSelection: changed,
                },
                { ...configuration, registry },
            );
            expect(outcome.status).toBe("failed");
            expect(outcome.diagnostics[0]?.code).toBe(code);
        };
        await rejectChangedAuthority(() => undefined, "asset_usage.observation_selection_stale", {
            ...fixture.registry,
            fingerprint: `sha256:${"9".repeat(64)}`,
        });
        await rejectChangedAuthority((authority) => {
            authority.selection.semanticOptions = [];
        }, "asset_usage.observation_semantic_closure_invalid");
        await rejectChangedAuthority((authority) => {
            authority.selection.semanticOptions.push(structuredClone(authority.selection.semanticOptions[0]!));
        }, "asset_usage.observation_semantic_closure_invalid");
        await rejectChangedAuthority((authority) => {
            authority.selection.semanticOptions[0]!.semanticRefFingerprint = `sha256:${"7".repeat(64)}`;
        }, "asset_usage.observation_semantic_closure_invalid");
        await rejectChangedAuthority((authority) => {
            authority.selection.outputUnits[0]!.claims[0]!.executable =
                !authority.selection.outputUnits[0]!.claims[0]!.executable;
        }, "asset_usage.observation_output_stale");
        await rejectChangedAuthority((authority) => {
            authority.selection.outputUnitRenderers = [];
        }, "render.materialization_closure_mismatch");
    });

    it("uses the live registry dispatch only for the selected renderer and rejects malformed results", async () => {
        const fixture = makeNativeProjectGuidanceFixture("claude");
        const providerInput = makeNativeProjectGuidanceMaterializationInput(fixture);
        const provider = makeLifecycleAdapterProvider(fixture.provider);
        let calls = 0;
        let mode: "valid" | "throw" | "invalid_state" | "invalid_units" | "invalid_diagnostics" | "partial" | "failed" = "valid";
        provider.materializeRender = async (input) => {
            calls += 1;
            if (mode === "throw") throw new Error("materializer fault");
            if (mode === "invalid_state") {
                return {
                    status: "complete",
                    materializationState: "invalid",
                    diagnostics: [],
                } as never;
            }
            if (mode === "invalid_units") {
                return {
                    status: "complete",
                    materializationState: "materialized",
                    materializedUnits: null,
                    diagnostics: [],
                } as never;
            }
            if (mode === "invalid_diagnostics") {
                return {
                    status: "complete",
                    materializationState: "blocked",
                    reasonCode: "fixture",
                    diagnostics: null,
                } as never;
            }
            if (mode === "partial" || mode === "failed") {
                return {
                    status: mode,
                    materializationState: "blocked",
                    reasonCode: `fixture_${mode}`,
                    diagnostics: [],
                };
            }
            const value = materializeFixtureResult(input);
            input.selection.outputUnits.length = 0;
            return value;
        };
        const registration = registerAdapterProvider(provider);
        expect(registration, JSON.stringify(registration.diagnostics)).toMatchObject({
            status: "complete",
        });
        expect(enableAdapter(provider.adapterId).status).toBe("complete");
        const live = await dispatchMaterializeRender(provider.adapterId, providerInput);
        expect(live.status).toBe("complete");
        expect(live.value.materializationState).toBe("materialized");
        expect(calls).toBe(1);
        expect(providerInput.selection.outputUnits).toHaveLength(1);

        const invalidInputs: Array<(input: RenderMaterializationInput) => void> = [
            (input) => {
                input.schemaVersion = 2 as never;
            },
            (input) => {
                input.selection.schemaVersion = 2 as never;
            },
            (input) => {
                input.selection.outputUnits = [];
            },
            (input) => {
                input.selection.outputUnitRenderers = [];
            },
            (input) => {
                const secondUnit = structuredClone(input.selection.outputUnits[0]!);
                secondUnit.outputUnitFingerprint = `sha256:${"f".repeat(64)}`;
                input.selection.outputUnits.push(secondUnit);
                input.selection.outputUnitRenderers.push(structuredClone(input.selection.outputUnitRenderers[0]!));
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializerCapabilityKey = "missing";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializationProfileId = "missing";
            },
            (input) => {
                input.selection.outputUnits[0]!.outputContractId = "FOREIGN_CONTRACT";
            },
            (input) => {
                input.selection.outputUnits[0]!.outputContractFingerprint = `sha256:${"e".repeat(64)}`;
            },
        ];
        for (const mutate of invalidInputs) {
            const invalid = structuredClone(providerInput);
            mutate(invalid);
            expect((await dispatchMaterializeRender(provider.adapterId, invalid)).diagnostics[0]?.code).toBe(
                "render_materialization_error",
            );
        }
        expect(calls).toBe(1);

        mode = "throw";
        expect((await dispatchMaterializeRender(provider.adapterId, providerInput)).diagnostics[0]?.code).toBe(
            "render_materialization_error",
        );
        mode = "invalid_state";
        expect((await dispatchMaterializeRender(provider.adapterId, providerInput)).diagnostics[0]?.code).toBe(
            "render_materialization_result_invalid",
        );
        mode = "invalid_units";
        expect((await dispatchMaterializeRender(provider.adapterId, providerInput)).diagnostics[0]?.code).toBe(
            "render_materialization_result_invalid",
        );
        mode = "invalid_diagnostics";
        expect((await dispatchMaterializeRender(provider.adapterId, providerInput)).diagnostics[0]?.code).toBe(
            "render_materialization_result_invalid",
        );
        mode = "partial";
        expect((await dispatchMaterializeRender(provider.adapterId, providerInput)).status).toBe("partial");
        mode = "failed";
        expect((await dispatchMaterializeRender(provider.adapterId, providerInput)).status).toBe("failed");
    });

    it("projects only renderer-safe facts and returns Core-stamped unit receipts", async () => {
        const fixture = await makeLifecycleFixture(root);
        let captured: RenderMaterializationInput | undefined;
        const result = await run(fixture, {
            dispatch: async (input) => {
                captured = structuredClone(input);
                const value = materializeFixtureResult(input);
                input.selection.outputUnits.length = 0;
                input.requiredSemantics.length = 0;
                return {
                    status: "complete",
                    value,
                    diagnostics: [],
                };
            },
        });
        expect(result.status).toBe("complete");
        expect(fixture.selection.outputUnits).toHaveLength(1);
        expect(result.value.units).toHaveLength(1);
        expect(result.value.units[0]).toEqual(
            expect.objectContaining({
                materializationFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                semanticCoverageProof: expect.objectContaining({
                    coverageFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                }),
            }),
        );
        expect(captured).not.toHaveProperty("deploymentId");
        expect(captured?.deployment).not.toHaveProperty("targetRootPath");
        expect(captured?.selection).not.toHaveProperty("promotionAuthorizations");
        expect(captured?.selection.semanticOptions[0]).not.toHaveProperty("approval");
    });

    it("canonicalizes multiple units, multiple claims, and valid binary output", async () => {
        const binarySource = makeBinaryFile();
        binarySource.file.fileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const fixture = await makeLifecycleFixture(root, {
            versionClosure: makeVersionClosure({ files: [makeTextFile(), binarySource] }),
            analysisResultOptions: {
                relativePath: "z.bin",
                additionalClaimPaths: ["a.bin"],
                additionalOutputUnitPaths: ["m.bin"],
                contentKind: "binary",
            },
        });
        const result = await run(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.units).toHaveLength(2);
        expect(result.value.units.flatMap((unit) => unit.files.map((file) => file.relativePath)).sort()).toEqual([
            "a.bin",
            "m.bin",
            "z.bin",
        ]);
        expect(result.value.units.flatMap((unit) => unit.files).every((file) => file.content.contentKind === "binary")).toBe(
            true,
        );
        const invalidBinary = await run(fixture, {
            dispatch: async (input) => ({
                status: "complete",
                value: materializeFixtureResult(input, (file) => {
                    file.content = { contentKind: "binary", bytes: "invalid" as never };
                }),
                diagnostics: [],
            }),
        });
        expect(invalidBinary.diagnostics[0]?.code).toBe("render.materialization_content_invalid");
    });

    it("rejects unavailable renderers and stale materializer capabilities after selection", async () => {
        const mutations: Array<(fixture: Awaited<ReturnType<typeof makeLifecycleFixture>>) => void> = [
            (fixture) => {
                fixture.selection.outputUnitRenderers[0]!.rendererAdapterId = "MISSING";
            },
            (fixture) => {
                fixture.selection.outputUnitRenderers[0]!.rendererAdapterVersion = "stale";
            },
            (fixture) => {
                fixture.selection.outputUnitRenderers[0]!.materializerCapabilityKey = "missing";
            },
            (fixture) => {
                fixture.selection.outputUnitRenderers[0]!.materializationProfileId = "missing";
            },
        ];
        for (const mutate of mutations) {
            const fixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "stale-")));
            mutate(fixture);
            refreshSelection(fixture);
            const result = await run(fixture);
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toMatch(/render\.(materializer_stale|materialization_capability_stale)/);
        }
    });

    it("compiles an exact empty desired set without calling a provider", async () => {
        const fixture = await makeLifecycleFixture(root);
        fixture.deployment.assets = [];
        const { renderInputFingerprint: _oldInputFingerprint, ...deploymentPreimage } = fixture.deployment;
        fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(deploymentPreimage);
        fixture.analysis.renderInputFingerprint = fixture.deployment.renderInputFingerprint;
        fixture.analysis.requiredSemantics = [];
        fixture.analysis.analyses = [];
        fixture.selection.renderInputFingerprint = fixture.deployment.renderInputFingerprint;
        fixture.selection.semanticOptions = [];
        fixture.selection.outputUnits = [];
        fixture.selection.outputUnitRenderers = [];
        fixture.selection.promotionAuthorizations = [];
        refreshSelection(fixture);
        let calls = 0;
        const result = await run(fixture, {
            dispatch: async () => {
                calls += 1;
                throw new Error("must not dispatch");
            },
        });
        expect(result.status).toBe("complete");
        expect(result.value.units).toEqual([]);
        expect(calls).toBe(0);
    });

    it("rejects stale render, registry, selection, semantic, and renderer closure", async () => {
        const cases: Array<[string, (fixture: Awaited<ReturnType<typeof makeLifecycleFixture>>) => void]> = [
            [
                "render.materialization_input_stale",
                (fixture) => {
                    fixture.analysis.renderInputFingerprint = `sha256:${"a".repeat(64)}`;
                },
            ],
            [
                "render.materialization_input_stale",
                (fixture) => {
                    fixture.selection.schemaVersion = 2 as never;
                },
            ],
            [
                "render.materialization_input_stale",
                (fixture) => {
                    fixture.selection.compilerPolicyVersion = "future" as never;
                },
            ],
            [
                "render.materialization_selection_fingerprint_mismatch",
                (fixture) => {
                    fixture.selection.selectionFingerprint = `sha256:${"b".repeat(64)}`;
                },
            ],
            [
                "render.materialization_closure_mismatch",
                (fixture) => {
                    fixture.selection.semanticOptions.pop();
                    refreshSelection(fixture);
                },
            ],
            [
                "render.materialization_closure_mismatch",
                (fixture) => {
                    fixture.selection.outputUnitRenderers = [];
                    refreshSelection(fixture);
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const fixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "case-")));
            mutate(fixture);
            const result = await run(fixture);
            expect(result.status, code).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe(code);
        }
    });

    it("rejects a foreign, duplicate, or empty dialect group before provider dispatch", async () => {
        const fixture = await makeLifecycleFixture(root);
        const validGroup: ProviderRenderDialectInputsForAsset = {
            consumerAgentRuntimeIds: [fixture.analysis.requiredSemantics[0]!.consumerAgentRuntimeId],
            targetVersion: fixture.deployment.assets[0]!.version.ref,
            inputs: [{}] as never,
        };
        const cases: ProviderRenderDialectInputsForAsset[][] = [
            [{ ...validGroup, targetVersion: { assetId: "foreign", versionId: "foreign" } }],
            [validGroup, structuredClone(validGroup)],
            [{ ...validGroup, inputs: [] }],
        ];
        for (const dialectInputs of cases) {
            let calls = 0;
            const result = await run(fixture, {
                resolveDialectInputs: () => dialectInputs,
                dispatch: async (input) => {
                    calls += 1;
                    return { status: "complete", value: materializeFixtureResult(input), diagnostics: [] };
                },
            });
            expect(result.diagnostics[0]?.code).toBe("render.materialization_dialect_projection_invalid");
            expect(calls).toBe(0);
        }
    });

    it("revalidates native and restoration bytes at materialization time", async () => {
        const fixture = await makeLifecycleFixture(root);
        const version = fixture.deployment.assets[0]!.version;
        const nativeText = "# native seed\n";
        const nativeStats = textPayloadStats(nativeText);
        const nativeFiles = [
            {
                relativePath: "native.md",
                contentKind: "text" as const,
                mediaType: "text/markdown",
                contentHash: nativeStats.contentHash,
                byteSize: nativeStats.byteSize,
                executable: false,
                text: nativeText,
            },
        ];
        const nativeBase = {
            schemaVersion: 1 as const,
            dialectId: "fixture-native",
            dialectContractFingerprint: `sha256:${"1".repeat(64)}` as const,
            canonicalContentFingerprint: version.versionCanonicalContentFingerprint,
        };
        const native = {
            inputKind: "native_representation" as const,
            inputRole: "current_exact" as const,
            representation: {
                ...nativeBase,
                representationFingerprint: computeVersionNativeRepresentationFingerprint({
                    ...nativeBase,
                    files: nativeFiles.map(({ text: _text, ...file }) => file),
                }),
            },
            files: nativeFiles,
        };
        const restorationText = "restoration seed";
        const restoration = {
            inputKind: "dialect_restoration" as const,
            restoration: {
                dialectId: "fixture-restoration",
                restorationContractFingerprint: `sha256:${"2".repeat(64)}` as const,
                contentHash: textPayloadStats(restorationText).contentHash,
            },
            content: { contentKind: "text" as const, text: restorationText },
        };
        const valid: ProviderRenderDialectInputsForAsset[] = [
            {
                targetVersion: version.ref,
                consumerAgentRuntimeIds: [fixture.analysis.requiredSemantics[0]!.consumerAgentRuntimeId],
                inputs: [native, restoration],
            },
        ];
        expect((await run(fixture, { resolveDialectInputs: () => valid })).status).toBe("complete");
        const invalidCases = [
            (inputs: typeof valid) => {
                const item = inputs[0]!.inputs[0]!;
                if (item.inputKind === "native_representation") {
                    item.representation.representationFingerprint = `sha256:${"f".repeat(64)}`;
                }
            },
            (inputs: typeof valid) => {
                const item = inputs[0]!.inputs[1]!;
                if (item.inputKind === "dialect_restoration") item.content.text = "changed";
            },
        ];
        for (const mutate of invalidCases) {
            const inputs = structuredClone(valid);
            mutate(inputs);
            const result = await run(fixture, { resolveDialectInputs: () => inputs });
            expect(result.diagnostics[0]?.code).toBe("render.materialization_dialect_projection_invalid");
        }
    });

    it("blocks partial, failed, provider-blocked, and throwing materializers", async () => {
        const fixture = await makeLifecycleFixture(root);
        const blocked: RenderMaterializationResult = {
            status: "failed",
            materializationState: "blocked",
            reasonCode: "fixture_blocked",
            diagnostics: [],
        };
        const cases = [
            async (_input: RenderMaterializationInput) => ({ status: "failed" as const, value: blocked, diagnostics: [] as [] }),
            async (input: RenderMaterializationInput) => ({
                status: "partial" as const,
                value: materializeFixtureResult(input),
                diagnostics: [] as [],
            }),
            async (_input: RenderMaterializationInput) => ({
                status: "complete" as const,
                value: blocked,
                diagnostics: [] as [],
            }),
            async (_input: RenderMaterializationInput): Promise<never> => {
                throw "renderer exploded";
            },
        ];
        for (const dispatch of cases) {
            const result = await run(fixture, { dispatch });
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toMatch(/render\.materialization_(blocked|internal_error)/);
        }
    });

    it("rejects missing, extra, and duplicate output-unit receipts", async () => {
        const fixture = await makeLifecycleFixture(root);
        const cases = [
            (result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>) => {
                result.materializedUnits = [];
            },
            (result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>) => {
                result.materializedUnits.push({
                    outputUnitFingerprint: `sha256:${"f".repeat(64)}`,
                    files: [],
                });
            },
            (result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>) => {
                result.materializedUnits.push(structuredClone(result.materializedUnits[0]!));
            },
        ];
        for (const mutate of cases) {
            const result = await run(fixture, {
                dispatch: async (input) => ({
                    status: "complete",
                    value: materializedWith(input, mutate),
                    diagnostics: [],
                }),
            });
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toMatch(/render\.materialization_(closure_mismatch|receipt_duplicate)/);
        }
    });

    it("rejects a non-array or duplicate materialized file set", async () => {
        const fixture = await makeLifecycleFixture(root);
        const cases = [
            (result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>) => {
                result.materializedUnits[0]!.files = null as never;
            },
            (result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>) => {
                result.materializedUnits[0]!.files.push(structuredClone(result.materializedUnits[0]!.files[0]!));
            },
        ];
        for (const mutate of cases) {
            const result = await run(fixture, {
                dispatch: async (input) => ({
                    status: "complete",
                    value: materializedWith(input, mutate),
                    diagnostics: [],
                }),
            });
            expect(result.status).toBe("failed");
        }
    });

    it("rejects file claim, semantic, content, and section-binding lies", async () => {
        const fixture = await makeLifecycleFixture(root);
        const foreignRef = `sha256:${"e".repeat(64)}`;
        const cases: Array<(file: MaterializedRenderFile) => void> = [
            (file) => {
                file.relativePath = "other.md";
            },
            (file) => {
                file.relativePath = "../escape.md";
            },
            (file) => {
                file.executable = !file.executable;
            },
            (file) => {
                file.content = { contentKind: "binary", bytes: new Uint8Array() };
            },
            (file) => {
                file.semanticRefFingerprints = [];
            },
            (file) => {
                file.semanticRefFingerprints = [foreignRef];
            },
            (file) => {
                file.semanticRefFingerprints = ["bad" as never];
            },
            (file) => {
                file.semanticRefFingerprints.reverse();
            },
            (file) => {
                file.semanticRefFingerprints.push(file.semanticRefFingerprints[0]!);
            },
            (file) => {
                file.content = { contentKind: "text", text: "bad\r\n" };
            },
            (file) => {
                file.content = { contentKind: "text", text: 42 as never };
            },
            (file) => {
                file.content = { contentKind: "binary", bytes: "bad" as never };
            },
            (file) => {
                file.sectionBindings = [{ sectionHandle: "", semanticRefFingerprints: [file.semanticRefFingerprints[0]!] }];
            },
            (file) => {
                file.sectionBindings = [
                    { sectionHandle: "foreign", semanticRefFingerprints: [file.semanticRefFingerprints[0]!] },
                ];
            },
            (file) => {
                file.sectionBindings = [{ sectionHandle: "fixture-section", semanticRefFingerprints: [] }];
            },
            (file) => {
                file.sectionBindings = [{ sectionHandle: "fixture-section", semanticRefFingerprints: [foreignRef] }];
            },
            (file) => {
                file.sectionBindings = [{ sectionHandle: "fixture-section", semanticRefFingerprints: ["bad" as never] }];
            },
        ];
        for (const mutate of cases) {
            const result = await run(fixture, {
                dispatch: async (input) => ({
                    status: "complete",
                    value: materializeFixtureResult(input, mutate),
                    diagnostics: [],
                }),
            });
            expect(result.status).toBe("failed");
        }
    });

    it("rejects every stale Core-owned materialization coverage proof", async () => {
        const mutations: Array<
            (proof: import("../../src/contracts/deployment-authority").MaterializationSemanticCoverageProof) => void
        > = [
            (proof) => {
                proof.outputUnitFingerprint = `sha256:${"e".repeat(64)}`;
            },
            (proof) => {
                proof.coverageFingerprint = "bad" as never;
            },
            (proof) => {
                proof.coverageFingerprint = `sha256:${"e".repeat(64)}`;
            },
            (proof) => {
                proof.coveredSemanticRefFingerprints = [];
            },
            (proof) => {
                proof.coveredSemanticRefFingerprints.reverse();
            },
            (proof) => {
                proof.coveredSemanticRefFingerprints.push(proof.coveredSemanticRefFingerprints[0]!);
            },
        ];
        for (const mutateMaterializationProof of mutations) {
            const fixture = await makeLifecycleFixture(fs.mkdtempSync(path.join(root, "proof-")), { mutateMaterializationProof });
            const result = await run(fixture);
            expect(result.status).toBe("failed");
        }
    });

    it("accepts an exact section binding and rejects duplicate handles", async () => {
        const fixture = await makeLifecycleFixture(root);
        const validBinding = (file: MaterializedRenderFile) => {
            file.sectionBindings = [
                {
                    sectionHandle: "fixture-section",
                    semanticRefFingerprints: [file.semanticRefFingerprints[0]!],
                },
            ];
        };
        expect(
            (
                await run(fixture, {
                    dispatch: async (input) => ({
                        status: "complete",
                        value: materializeFixtureResult(input, validBinding),
                        diagnostics: [],
                    }),
                })
            ).status,
        ).toBe("complete");
        const duplicate = await run(fixture, {
            dispatch: async (input) => ({
                status: "complete",
                value: materializeFixtureResult(input, (file) => {
                    validBinding(file);
                    file.sectionBindings.push(structuredClone(file.sectionBindings[0]!));
                }),
                diagnostics: [],
            }),
        });
        expect(duplicate.diagnostics[0]?.code).toBe("render.materialization_section_invalid");
    });
});
