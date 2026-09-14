import { adapterRenderRegistryComponents } from "../../src/render/adapter-render-contract-registration";
import { describe, expect, it } from "vitest";
import type { AdapterCanonicalMaterializationValidatorV1 } from "../../src/contracts/render";
import {
    canonicalMaterializationValidatorsForProviders,
    findCanonicalMaterializationValidator,
    snapshotCanonicalMaterializationValidators,
    validateCanonicalMaterializationContributions,
} from "../../src/render/canonical-materialization-validation";
import {
    asExactGraphProvider,
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    graphCanonicalMaterializer,
    makeExactGraphFixture,
    makeGlobalExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";
import { nativeProjectExactGraphRegistryComponents } from "../../src/render/native-project-exact-graph";
import { createRenderRegistry } from "../../src/render/render-registry";

const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
const contribution = (): AdapterCanonicalMaterializationValidatorV1 => ({
    outputContractId: fixture.support.renderContractDeclaration.outputContractId,
    materializationProfileId: fixture.support.renderContractDeclaration.materializationProfileId,
    materializer: structuredClone(graphCanonicalMaterializer.ref),
    validateEntry: (input) => input.canonicalEntry.contentKind === "text",
});
const bindings = (values: readonly AdapterCanonicalMaterializationValidatorV1[]) =>
    new Map([[fixture.provider.adapterId, values]]);

describe("canonical materialization validator ownership", () => {
    it("selects separate callable implementations for two actual profiles sharing one materializer component", () => {
        const calls: string[] = [];
        const project = makeExactGraphFixture({
            canonicalMaterializer: {
                ...graphCanonicalMaterializer,
                validateEntry(input) {
                    calls.push("project");
                    return graphCanonicalMaterializer.validateEntry(input);
                },
            },
        });
        const global = makeGlobalExactGraphFixture({
            canonicalMaterializer: {
                ...graphCanonicalMaterializer,
                validateEntry() {
                    calls.push("global");
                    return false;
                },
            },
        });
        const provider = {
            ...project.provider,
            targetContextSchemas: [...project.provider.targetContextSchemas, ...global.provider.targetContextSchemas],
            assetTargetCapabilities: [...project.provider.assetTargetCapabilities, ...global.provider.assetTargetCapabilities],
            materializerCapabilities: [...project.provider.materializerCapabilities, ...global.provider.materializerCapabilities],
            renderContractDeclarations: [
                ...project.provider.renderContractDeclarations,
                ...global.provider.renderContractDeclarations,
            ],
        };
        const contributions = [
            ...global.support.canonicalMaterializationValidators,
            ...project.support.canonicalMaterializationValidators,
        ];
        const registry = createRenderRegistry({
            providers: [provider],
            ...nativeProjectExactGraphRegistryComponents([provider], bindings(contributions)),
        });
        const check = (value: typeof project | typeof global) => {
            const request = exactGraphMaterializationInput(value);
            const result = value.support.materialize(request);
            if (result.materializationState !== "materialized") throw new Error("profile fixture did not materialize");
            return registry.validateOutputContractMaterialization({
                contract: value.components.outputContracts[0]!,
                profile: value.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: request.selection.outputUnits[0]!,
                selectedSemantics: value.requiredSemantics,
                canonicalValues: exactGraphCanonicalValues(value),
                selectedOptions: request.selection.semanticOptions,
                dialectInputs: request.dialectInputs,
                files: result.materializedUnits[0]!.files,
            });
        };
        expect(() => check(project)).not.toThrow();
        expect(() => check(global)).toThrow(/materialization violates/u);
        expect(calls).toEqual(["project", "global"]);
        expect(() =>
            validateCanonicalMaterializationContributions(
                [provider],
                bindings([
                    ...project.support.canonicalMaterializationValidators,
                    ...project.support.canonicalMaterializationValidators,
                ]),
            ),
        ).toThrow(/duplicated/u);
    });
    it("requires a declared conversion checker while allowing a native-only registry without contributions", () => {
        expect(() => adapterRenderRegistryComponents([makeExactGraphFixture().provider])).not.toThrow();
        expect(() => adapterRenderRegistryComponents([fixture.provider])).toThrow(/no content validator/);
    });

    it("binds one contribution to its declared component and does not invent another owner", () => {
        const validator = contribution();
        const providers = [{ ...asExactGraphProvider(fixture), canonicalMaterializationValidators: [validator] }];
        const registered = canonicalMaterializationValidatorsForProviders(providers);
        expect(() => validateCanonicalMaterializationContributions([fixture.provider], registered)).not.toThrow();
        expect(findCanonicalMaterializationValidator(registered, fixture.provider.adapterId, validator)).toBe(validator);
        expect(findCanonicalMaterializationValidator(registered, "OTHER", validator)).toBeUndefined();
        expect(
            findCanonicalMaterializationValidator(registered, fixture.provider.adapterId, {
                ...validator,
                materializer: { ...validator.materializer, componentId: "other" },
            }),
        ).toBeUndefined();
        expect(() => canonicalMaterializationValidatorsForProviders([...providers, ...providers])).toThrow(/duplicated/u);
    });

    it("captures declaration data and callable identity before caller mutation", () => {
        const original = contribution();
        const mutable = { ...original, materializer: structuredClone(original.materializer) };
        const callerArray = [mutable];
        const captured = snapshotCanonicalMaterializationValidators(callerArray);
        mutable.materializer.componentId = "changed-after-registration";
        mutable.validateEntry = () => false;
        callerArray.length = 0;
        expect(captured).toHaveLength(1);
        expect(captured[0]?.materializer).toEqual(original.materializer);
        expect(captured[0]?.validateEntry).toBe(original.validateEntry);
        expect(Object.isFrozen(captured)).toBe(true);
        expect(Object.isFrozen(captured[0])).toBe(true);
        expect(Object.isFrozen(captured[0]?.materializer)).toBe(true);
    });

    it.each(["missing", "duplicate", "undeclared"] as const)("rejects a %s contribution", (mode) => {
        const values =
            mode === "missing"
                ? []
                : mode === "duplicate"
                  ? [contribution(), contribution()]
                  : [{ ...contribution(), materializer: { ...graphCanonicalMaterializer.ref, componentId: "not-declared" } }];
        expect(() => validateCanonicalMaterializationContributions([fixture.provider], bindings(values))).toThrow(/validator/u);
    });

    it("rejects foreign owners and contributions on a Provider without conversion declarations", () => {
        expect(() =>
            validateCanonicalMaterializationContributions([fixture.provider], new Map([["OTHER", [contribution()]]])),
        ).toThrow(/owner/u);
        const native = makeExactGraphFixture();
        expect(() => validateCanonicalMaterializationContributions([native.provider], bindings([contribution()]))).toThrow(
            /undeclared/u,
        );
        const registered = canonicalMaterializationValidatorsForProviders([asExactGraphProvider(native)]);
        expect(() => validateCanonicalMaterializationContributions([native.provider], registered)).not.toThrow();
    });

    it("rejects malformed callable records while allowing the absent native-only list", () => {
        expect(snapshotCanonicalMaterializationValidators(undefined)).toEqual([]);
        expect(() => snapshotCanonicalMaterializationValidators({} as never)).toThrow(/array/u);
        const invalid = { ...contribution(), validateEntry: undefined } as unknown as AdapterCanonicalMaterializationValidatorV1;
        expect(() => snapshotCanonicalMaterializationValidators([invalid])).toThrow(/checker/u);
        expect(() => validateCanonicalMaterializationContributions([fixture.provider], bindings([invalid]))).toThrow(/invalid/u);
    });
});
