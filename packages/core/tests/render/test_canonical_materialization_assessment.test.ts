import { describe, expect, it, vi } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import type { RenderDegradationKind } from "../../src/contracts/deployment-authority";
import type {
    AdapterCanonicalMaterializationValidatorV1,
    CanonicalMaterializationAssessmentInput,
    ProviderRenderDialectInputsForAsset,
} from "../../src/contracts/render";
import { computeProviderRenderDialectInputFingerprint } from "../../src/foundation/fingerprint";
import {
    assessCanonicalMaterializationLosses,
    canonicalMaterializationAssessmentInput,
} from "../../src/render/canonical-materialization-assessment";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import { nativeProjectExactGraphRegistryComponents } from "../../src/render/native-project-exact-graph";
import { isExactGraphNativeConsistencySatisfied } from "../../src/render/native-project-exact-graph-consistency";
import { resolveProviderExactFileDialectInputs } from "../../src/render/render-dialect-authority";
import { createRenderRegistry, type RenderRegistrySnapshot } from "../../src/render/render-registry";
import {
    GRAPH_BOUNDARY,
    makeGraphDialectInput,
    makeGraphNativeDialectContract,
} from "./fixtures/native-project-exact-graph-native-test-fixtures";
import {
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    graphCanonicalMaterializer,
    graphSkillCanonical,
    makeExactGraphFixture,
    makeGlobalExactGraphFixture,
    asExactGraphProvider,
} from "./fixtures/native-project-exact-graph-test-fixtures";

const TRIGGER = "trigger_or_loading_level_lost",
    METADATA = "runtime_specific_metadata_lost";
const SOURCE = "fixture-skill-historical-v1";
type Assessor = NonNullable<AdapterCanonicalMaterializationValidatorV1["assessLoss"]>;
const assessInvocation: Assessor = (input) =>
    input.canonical.kind !== "Skill"
        ? null
        : input.canonical.typeData.invocation.user.mode === "not_directly_invocable"
          ? [TRIGGER]
          : [];

function assessedFixture(
    options: { direct?: boolean; seeded?: boolean; assessLoss?: Assessor; requiresSourceAssessment?: boolean } = {},
) {
    const canonical = graphSkillCanonical();
    if (options.direct === true) canonical.typeData.invocation.user = { mode: "direct", commandName: "review" };
    const assessments: CanonicalMaterializationAssessmentInput[] = [],
        entries: CanonicalMaterializationAssessmentInput[] = [];
    const fixture = makeExactGraphFixture({
        canonical,
        canonicalMaterializer: {
            ...graphCanonicalMaterializer,
            degradationKinds: [METADATA, TRIGGER],
            preservationDialectIds: [SOURCE],
            ...(options.requiresSourceAssessment === false ? {} : { requiresNativeSourceAssessment: true as const }),
            assessLoss(input) {
                assessments.push(structuredClone(input));
                return (options.assessLoss ?? assessInvocation)(input);
            },
            validateEntry(input) {
                const { nativeEntry: _entry, ...source } = input;
                entries.push(structuredClone(source));
                return graphCanonicalMaterializer.validateEntry(input);
            },
        },
    });
    const sourceContract = makeGraphNativeDialectContract(SOURCE);
    const dialectRegistry = createVersionDialectRegistry([fixture.nativeDialect, sourceContract], [], [], []);
    const available =
        options.seeded === true
            ? [
                  makeGraphDialectInput(
                      fixture.deployment.assets[0]!.version.versionCanonicalContentFingerprint,
                      sourceContract,
                      { directories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`] },
                  ),
              ]
            : [];
    const route = (registry: RenderRegistrySnapshot | null = fixture.registry) =>
        resolveProviderExactFileDialectInputs({
            provider: fixture.provider,
            deployment: fixture.deployment,
            semantics: fixture.requiredSemantics,
            available,
            dialectRegistry,
            ...(registry === null ? {} : { renderRegistry: registry }),
        });
    fixture.analysisInput.dialectInputs = route();
    return { fixture, dialectRegistry, route, assessments, entries };
}
function canonicalToken(groups: ProviderRenderDialectInputsForAsset[]) {
    const token = groups[0]?.inputs.find((input) => input.inputKind === "canonical_materialization");
    if (token === undefined) throw new Error("canonical token absent");
    return token;
}
function materialized(value: ReturnType<typeof assessedFixture>) {
    const { fixture } = value,
        request = exactGraphMaterializationInput(fixture);
    const result = fixture.support.materialize(request);
    if (result.materializationState !== "materialized") throw new Error("actual graph failed to materialize");
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
    const consistency = (groups = request.dialectInputs, registry: RenderRegistrySnapshot | null = fixture.registry) =>
        isExactGraphNativeConsistencySatisfied({
            deployment: fixture.deployment,
            provider: fixture.provider,
            semantics: fixture.requiredSemantics,
            dialectInputs: groups,
            outputUnit: request.selection.outputUnits[0]!,
            renderer: request.selection.outputUnitRenderers[0]!,
            files,
            dialectRegistry: value.dialectRegistry,
            canonicalCoverageProof: proof,
            ...(registry === null ? {} : { renderRegistry: registry }),
        });
    return { request, files, validation, consistency };
}

describe("registered exact canonical loss assessment", () => {
    it("rejects missing or ambiguous canonical entries and preserves binary input bytes for assessment", () => {
        const { fixture } = assessedFixture();
        const asset = structuredClone(fixture.deployment.assets[0]!);
        const entry = asset.version.files.find((file) => file.file.role === "entry")!;
        asset.version.files = [];
        expect(canonicalMaterializationAssessmentInput(asset, SOURCE, "project")).toBeNull();
        asset.version.files = [entry, structuredClone(entry)];
        expect(canonicalMaterializationAssessmentInput(asset, SOURCE, "project")).toBeNull();
        const bytes = Uint8Array.of(0, 255, 17);
        asset.version.files = [
            {
                file: { ...entry.file, contentKind: "binary", ...binaryPayloadStats(bytes) },
                contentKind: "binary",
                bytes,
            },
        ];
        const input = canonicalMaterializationAssessmentInput(asset, SOURCE, "global");
        expect(input?.canonicalEntry).toEqual({ contentKind: "binary", bytes });
        if (input?.canonicalEntry.contentKind !== "binary") throw new Error("Expected binary assessment input");
        input.canonicalEntry.bytes[0] = 77;
        expect(bytes).toEqual(Uint8Array.of(0, 255, 17));
        const declaration = fixture.support.renderContractDeclaration.canonicalMaterialization!;
        const assessor = vi.fn(() => [] as RenderDegradationKind[]);
        expect(assessCanonicalMaterializationLosses(declaration, { assessLoss: assessor }, null)).toBeNull();
        expect(assessor).not.toHaveBeenCalled();
        for (const implementation of [undefined, null, {}]) {
            expect(assessCanonicalMaterializationLosses(declaration, implementation, input)).toBeNull();
        }
    });

    it("assesses and materializes a real global graph using the global declaration", () => {
        const calls: CanonicalMaterializationAssessmentInput[] = [];
        const fixture = makeGlobalExactGraphFixture({
            canonicalMaterializer: {
                ...graphCanonicalMaterializer,
                assessLoss(input) {
                    calls.push(structuredClone(input));
                    return input.targetScope === "global" ? [] : [...graphCanonicalMaterializer.degradationKinds];
                },
            },
        });
        expect(validateAdapterRenderContractRegistration([asExactGraphProvider(fixture)])).toEqual([]);
        fixture.analysisInput.dialectInputs = resolveProviderExactFileDialectInputs({
            provider: fixture.provider,
            deployment: fixture.deployment,
            semantics: fixture.requiredSemantics,
            available: [],
            dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
            renderRegistry: fixture.registry,
        });
        expect(canonicalToken(fixture.analysisInput.dialectInputs).degradationKinds).toEqual([]);
        const request = exactGraphMaterializationInput(fixture);
        const result = fixture.support.materialize(request);
        expect(result).toMatchObject({ status: "complete", materializationState: "materialized" });
        expect(request.selection.semanticOptions.every((option) => option.outcome === "preserved")).toBe(true);
        expect(calls.filter((call) => call.targetScope === "global").length).toBeGreaterThan(0);
        expect(fixture.deployment.projectId).toBe("");
    });

    it.each([true, false])("applies native source coverage only when explicitly required: %s", (requiresSourceAssessment) => {
        const value = assessedFixture({ direct: true, requiresSourceAssessment });
        const foreign = makeGraphNativeDialectContract("unaccepted-private-skill-v1");
        const available = makeGraphDialectInput(
            value.fixture.deployment.assets[0]!.version.versionCanonicalContentFingerprint,
            foreign,
        );
        const route = (inputs: typeof available.inputs) =>
            resolveProviderExactFileDialectInputs({
                provider: value.fixture.provider,
                deployment: value.fixture.deployment,
                semantics: value.fixture.requiredSemantics,
                available: [{ ...available, inputs }],
                dialectRegistry: createVersionDialectRegistry([value.fixture.nativeDialect, foreign], [], [], []),
                renderRegistry: value.fixture.registry,
            });
        expect(canonicalToken(route([])).degradationKinds).toEqual([]);
        if (requiresSourceAssessment) expect(route(available.inputs)).toEqual([]);
        else {
            const selected = canonicalToken(route(available.inputs));
            expect(selected.degradationKinds).toEqual([]);
            expect(selected).not.toHaveProperty("nativePreservationSeed");
            expect(value.fixture.support.renderContractDeclaration.canonicalMaterialization).not.toHaveProperty(
                "requiresNativeSourceAssessment",
            );
        }
        const native = available.inputs[0]!;
        if (native.inputKind !== "native_representation") throw new Error("Expected actual native input");
        const parent = {
            ...native,
            inputRole: "parent_rebase_seed" as const,
            sourceVersion: { assetId: available.targetVersion.assetId, versionId: "88888888-8888-4888-8888-888888888888" },
        };
        expect(canonicalToken(route([parent])).degradationKinds).toEqual([]);
    });

    it.each([
        "false_flag",
        "missing_assessor",
        "missing_source_list",
    ] as const)("rejects an incomplete native source assessment declaration: %s", (fault) => {
        const { fixture } = assessedFixture();
        const provider = asExactGraphProvider(fixture);
        const declaration = provider.renderContractDeclarations[0]!;
        if (!("canonicalMaterialization" in declaration) || declaration.canonicalMaterialization === undefined)
            throw new Error("canonical declaration missing");
        const changed = declaration.canonicalMaterialization as unknown as Record<string, unknown>;
        if (fault === "false_flag") changed.requiresNativeSourceAssessment = false;
        else if (fault === "missing_assessor") delete changed.assessesLoss;
        else delete changed.preservationDialectIds;
        expect(validateAdapterRenderContractRegistration([provider])).toEqual([
            expect.objectContaining({ code: "adapter.render_contract_invalid" }),
        ]);
    });

    it("binds the explicit coverage requirement in the compiled registry fingerprint", () => {
        const legacy = assessedFixture({ requiresSourceAssessment: false });
        const current = assessedFixture();
        expect(legacy.fixture.registry.fingerprint).not.toBe(current.fixture.registry.fingerprint);
    });

    it("accepts a native-only graph declaration with an explicitly absent canonical materializer", () => {
        const provider = asExactGraphProvider(makeExactGraphFixture());
        provider.renderContractDeclarations[0] = {
            ...provider.renderContractDeclarations[0]!,
            canonicalMaterialization: undefined,
        } as (typeof provider.renderContractDeclarations)[number];
        expect(validateAdapterRenderContractRegistration([provider])).toEqual([]);
    });

    it("rejects loss assessment on an incompatible declaration before publishing the registry", () => {
        const { fixture } = assessedFixture();
        const provider = asExactGraphProvider(fixture);
        provider.renderContractDeclarations[0] = {
            ...provider.renderContractDeclarations[0]!,
            declarationKind: "native_project_exact_file_v1",
        } as (typeof provider.renderContractDeclarations)[number];
        const diagnostics = validateAdapterRenderContractRegistration([provider]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ code: "adapter.render_contract_invalid" });
        expect(diagnostics[0]!.message).toContain("canonical loss assessment requires an exact-graph declaration");
        expect(() =>
            createRenderRegistry({
                providers: [{ ...fixture.provider, renderContractDeclarations: provider.renderContractDeclarations }],
                ...fixture.components,
            }),
        ).toThrow("canonical loss assessment requires one registered exact-graph validator");
    });
    it.each([
        { direct: true, seeded: false, losses: [] },
        { direct: false, seeded: true, losses: [TRIGGER] },
    ])("materializes the complete graph with precisely $losses for direct=$direct", ({ direct, seeded, losses }) => {
        const value = assessedFixture({ direct, seeded }),
            { fixture } = value;
        const token = canonicalToken(fixture.analysisInput.dialectInputs);
        expect(token.degradationKinds).toEqual(losses);
        expect(token.nativePreservationSeed !== undefined).toBe(seeded);
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis.status).toBe("complete");
        expect(analysis.semanticOptions.length).toBe(fixture.requiredSemantics.length);
        for (const option of analysis.semanticOptions) {
            expect(option.outcome).toBe(direct ? "preserved" : "degraded");
            if (option.outcome === "preserved") {
                expect(option.approvalRequirement).toEqual({ approvalState: "not_required" });
                expect(option.diagnostics).toEqual([]);
            } else if (option.outcome === "degraded") {
                expect(option.degradationKinds).toEqual(losses);
                expect(option.diagnostics).not.toEqual([]);
            }
        }
        const output = materialized(value);
        expect(output.files).toHaveLength(3);
        expect(output.consistency()).toBe(true);
        expect(output.consistency(undefined, null)).toBe(false);
        expect(value.entries).toHaveLength(1);
        expect(value.assessments.length).toBeGreaterThanOrEqual(4);
        for (const assessment of value.assessments) expect(assessment).toEqual(value.entries[0]);
        if (seeded)
            expect(value.entries[0]!.nativePreservationSeed?.representation).toMatchObject({
                schemaVersion: 2,
                dialectId: SOURCE,
                directories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`],
            });
    });

    it.each([
        { losses: [] },
        { losses: [METADATA] },
        { losses: [METADATA, TRIGGER] },
    ])("rejects forged loss list $losses at analysis, materialization and final registered gates", ({ losses }) => {
        const value = assessedFixture({ seeded: true }),
            { fixture } = value,
            output = materialized(value);
        const forged = structuredClone(fixture.analysisInput.dialectInputs);
        canonicalToken(forged).degradationKinds = losses as RenderDegradationKind[];
        expect(fixture.support.analyze({ ...fixture.analysisInput, dialectInputs: forged }).status).toBe("failed");
        expect(fixture.support.materialize({ ...output.request, dialectInputs: forged }).materializationState).toBe("blocked");
        const selectedOptions =
            losses.length === 0
                ? output.validation.selectedOptions.map((option) => {
                      const { outcome: _outcome, ...rest } = option;
                      return { ...rest, outcome: "preserved" as const };
                  })
                : output.validation.selectedOptions;
        expect(() =>
            fixture.registry.validateOutputContractMaterialization({
                ...output.validation,
                dialectInputs: forged,
                selectedOptions,
            }),
        ).toThrow();
        expect(output.consistency(forged)).toBe(false);
        expect(
            computeProviderRenderDialectInputFingerprint({
                adapterId: fixture.provider.adapterId,
                adapterVersion: fixture.provider.version,
                dialectInputs: forged,
            }),
        ).not.toBe(
            computeProviderRenderDialectInputFingerprint({
                adapterId: fixture.provider.adapterId,
                adapterVersion: fixture.provider.version,
                dialectInputs: fixture.analysisInput.dialectInputs,
            }),
        );
    });

    it.each(["missing", "duplicate", "different_component"] as const)("rejects a %s registered assessor", (mode) => {
        const value = assessedFixture(),
            { fixture } = value;
        const original = fixture.support.canonicalMaterializationValidators[0]!;
        const { assessLoss: _assessLoss, ...withoutAssessor } = original;
        const validators =
            mode === "missing"
                ? [withoutAssessor]
                : mode === "duplicate"
                  ? [original, original]
                  : [{ ...original, materializer: { ...original.materializer, componentVersion: 99 } }];
        expect(() =>
            createRenderRegistry({
                providers: [fixture.provider],
                ...fixture.components,
                canonicalMaterializationValidators: new Map([[fixture.provider.adapterId, validators]]),
            }),
        ).toThrow("canonical loss assessment requires one registered exact-graph validator");
        expect(value.route(null)).toEqual([]);
    });

    it.each([
        "throw",
        "reject",
        "unknown",
        "duplicate",
        "unsorted",
        "not_array",
    ] as const)("rejects an assessor that returns $mode", (mode) => {
        const assessLoss: Assessor = () => {
            if (mode === "throw") throw new Error("fixture assessor fault");
            if (mode === "reject") return null;
            return (
                mode === "unknown"
                    ? ["unknown_loss"]
                    : mode === "duplicate"
                      ? [TRIGGER, TRIGGER]
                      : mode === "unsorted"
                        ? [TRIGGER, METADATA]
                        : "not_an_array"
            ) as RenderDegradationKind[];
        };
        const value = assessedFixture({ assessLoss });
        expect(value.route()).toEqual([]);
        expect(value.fixture.support.analyze(value.fixture.analysisInput).status).toBe("failed");
    });

    it("binds the assessment to the exact registered Provider version, output, profile and component", () => {
        const value = assessedFixture(),
            { fixture } = value,
            declaration = fixture.support.renderContractDeclaration;
        const request = {
            adapterId: fixture.provider.adapterId,
            adapterVersion: fixture.provider.version,
            outputContractId: declaration.outputContractId,
            materializationProfileId: declaration.materializationProfileId,
            materializer: declaration.canonicalMaterialization!.materializer,
            asset: fixture.deployment.assets[0]!,
        };
        expect(fixture.registry.assessCanonicalMaterialization(request)).toEqual([TRIGGER]);
        const wrongRequests = [
            { ...request, adapterId: "OTHER" },
            { ...request, adapterVersion: "99.0.0" },
            { ...request, outputContractId: "OTHER_V1" },
            { ...request, materializationProfileId: "other" },
            { ...request, materializer: { ...request.materializer, componentVersion: 99 } },
        ];
        for (const wrong of wrongRequests) expect(fixture.registry.assessCanonicalMaterialization(wrong)).toBeNull();
    });

    it("snapshots the selected callback and clones its immutable input before every invocation", () => {
        const value = assessedFixture(),
            { fixture } = value;
        const mutable = { ...fixture.support.canonicalMaterializationValidators[0]! };
        const original = mutable.assessLoss!,
            validators = [mutable];
        mutable.assessLoss = (input) => {
            const loss = original(input);
            if (input.canonical.kind === "Skill") input.canonical.typeData.name = "forged by callback";
            return loss;
        };
        const registry = createRenderRegistry({
            providers: [fixture.provider],
            ...fixture.components,
            canonicalMaterializationValidators: new Map([[fixture.provider.adapterId, validators]]),
        });
        const before = structuredClone(fixture.deployment);
        mutable.assessLoss = () => [];
        mutable.materializer = { ...mutable.materializer, componentVersion: 99 };
        validators.length = 0;
        expect(canonicalToken(value.route(registry)).degradationKinds).toEqual([TRIGGER]);
        expect(fixture.deployment).toEqual(before);
    });

    it("compiles entry validation and registry assessment from the same frozen contribution", () => {
        const value = assessedFixture({ seeded: true }),
            { fixture } = value;
        const mutable = { ...fixture.support.canonicalMaterializationValidators[0]! };
        const validators = [mutable],
            contributions = new Map([[fixture.provider.adapterId, validators]]);
        const components = nativeProjectExactGraphRegistryComponents([fixture.provider], contributions);
        mutable.assessLoss = () => [];
        mutable.validateEntry = () => false;
        mutable.materializer = { ...mutable.materializer, componentVersion: 99 };
        validators.length = 0;
        contributions.clear();
        fixture.registry = createRenderRegistry({ providers: [fixture.provider], ...components });
        fixture.components = components;
        fixture.analysisInput.dialectInputs = value.route();
        expect(canonicalToken(fixture.analysisInput.dialectInputs).degradationKinds).toEqual([TRIGGER]);
        expect(materialized(value).consistency()).toBe(true);
    });

    it("keeps the mandatory substitute-kind loss and the historical fixed-loss rule", () => {
        const value = assessedFixture(),
            declaration = value.fixture.support.renderContractDeclaration.canonicalMaterialization!;
        const substitute: typeof declaration = {
            ...declaration,
            degradationKinds: ["target_runtime_missing_asset_kind" as const, TRIGGER],
            substituteAssetKind: "Workflow" as const,
        };
        const input = value.assessments[0]!;
        expect(assessCanonicalMaterializationLosses(substitute, { assessLoss: () => [] }, input)).toBeNull();
        expect(assessCanonicalMaterializationLosses(substitute, { assessLoss: () => [TRIGGER] }, input)).toBeNull();
        expect(
            assessCanonicalMaterializationLosses(
                substitute,
                {
                    assessLoss: () => ["target_runtime_missing_asset_kind"],
                },
                input,
            ),
        ).toEqual(["target_runtime_missing_asset_kind"]);
        const fixed = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const historical = fixed.support.renderContractDeclaration.canonicalMaterialization!;
        expect(historical).not.toHaveProperty("assessesLoss");
        expect(assessCanonicalMaterializationLosses(historical, { assessLoss: () => [] }, input)).toEqual(
            graphCanonicalMaterializer.degradationKinds,
        );
        const unapproved = structuredClone(fixed.analysisInput);
        canonicalToken(unapproved.dialectInputs).degradationKinds = [];
        expect(fixed.support.analyze(unapproved).status).toBe("failed");
        expect(fixed.support.analyze(fixed.analysisInput).status).toBe("complete");
    });
});
