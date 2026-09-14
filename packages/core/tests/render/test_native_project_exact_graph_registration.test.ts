/** Registration, profile identity and applicability guards for exact native graphs. */

import { describe, expect, it } from "vitest";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import {
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeProjectExactGraphBuild,
    makeNativeProjectExactGraphContractParts,
    nativeProjectExactGraphRegistryComponents,
} from "../../src/render/native-project-exact-graph";
import type { Sha256Digest } from "../../src/types";
import { makeRestorationDialectContract } from "../source-import/fixtures/dialect-contracts";
import { graphRebaseMaterializer, projectFixtureGraph } from "./fixtures/native-project-exact-graph-native-test-fixtures";
import {
    asExactGraphProvider,
    GRAPH_BOUNDARY,
    GRAPH_DIALECT_ID,
    GRAPH_ENTRY_PATH,
    GRAPH_OUTPUT_CONTRACT_ID,
    GRAPH_PARSER_REF,
    GRAPH_PROFILE_ID,
    GRAPH_REBASE_REF,
    GRAPH_VALIDATOR_REF,
    makeExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";

type GraphProvider = ReturnType<typeof asExactGraphProvider>;

describe("native project exact-graph registration", () => {
    it("rejects native dialect, rebase and restoration ownership drift", () => {
        const missingNative = asExactGraphProvider(makeExactGraphFixture());
        missingNative.dialectContracts.native = [];
        expect(validateAdapterRenderContractRegistration([missingNative])[0]?.message).toMatch(/no unique provider dialect/);

        const parserMismatch = asExactGraphProvider(makeExactGraphFixture());
        parserMismatch.dialectContracts.native[0]!.definition.nativeToCanonicalParser = GRAPH_VALIDATOR_REF;
        expect(validateAdapterRenderContractRegistration([parserMismatch])[0]?.message).toMatch(/dialect parser/);

        const rebaseMismatch = asExactGraphProvider(makeExactGraphFixture());
        rebaseMismatch.dialectContracts.native[0]!.definition.rebaseMaterializer = GRAPH_VALIDATOR_REF;
        expect(validateAdapterRenderContractRegistration([rebaseMismatch])[0]?.message).toMatch(/rebase materializer/);

        for (const count of [0, 2]) {
            const provider = asExactGraphProvider(makeExactGraphFixture());
            const declaration = graphDeclaration(provider);
            declaration.restorationDialectIds = ["fixture-restoration-v1"];
            provider.dialectContracts.restoration = Array.from({ length: count }, () =>
                makeRestorationDialectContract("Skill", "fixture-restoration-v1"),
            );
            expect(validateAdapterRenderContractRegistration([provider])[0]?.message).toMatch(/restoration dialect/);
        }
        const complete = asExactGraphProvider(makeExactGraphFixture());
        const completeSupport = makeSupport({
            rebaseMaterializer: graphRebaseMaterializer,
            restorationDialectIds: ["fixture-restoration-v1"],
        });
        complete.assetTargetCapabilities = [completeSupport.targetCapability];
        complete.materializerCapabilities = [completeSupport.materializerCapability];
        complete.renderContractDeclarations = [completeSupport.renderContractDeclaration];
        complete.dialectContracts.restoration = [makeRestorationDialectContract("Skill", "fixture-restoration-v1")];
        expect(validateAdapterRenderContractRegistration([complete])).toEqual([]);
    });

    it("rejects malformed component, dialect, restoration and build identities", () => {
        const fixture = makeExactGraphFixture();
        const base = fixture.support.renderContractDeclaration;
        for (const mutate of [
            (declaration: typeof base) => {
                declaration.projectGraphValidator.componentId = "";
            },
            (declaration: typeof base) => {
                declaration.reverseParser.componentVersion = 0;
            },
            (declaration: typeof base) => {
                declaration.rebaseMaterializer = { ...GRAPH_REBASE_REF, configFingerprint: "bad" as Sha256Digest };
            },
        ]) {
            const declaration = structuredClone(base);
            mutate(declaration);
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(/component is invalid/);
        }

        const currentOnly = structuredClone(base);
        currentOnly.rebaseMaterializer = null;
        expect(makeNativeProjectExactGraphContractParts(currentOnly).profile.rebaseMaterializer).toBeNull();

        for (const assetKind of ["Rule", "Workflow", "Skill", "Subagent"] as const) {
            const declaration = structuredClone(base);
            declaration.assetKind = assetKind;
            expect(makeNativeProjectExactGraphContractParts(declaration).profile.assetKind).toBe(assetKind);
        }
        for (const assetKind of ["Guidance", "Memory"] as const) {
            const declaration = structuredClone(base);
            declaration.assetKind = assetKind as never;
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(/unsupported AssetKind/);
        }

        for (const nativeDialectId of ["", "bad\0dialect"]) {
            const declaration = structuredClone(base);
            declaration.nativeDialectId = nativeDialectId;
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(/invalid dialect/);
        }
        for (const restorationDialectIds of [
            undefined,
            [1],
            [""],
            [" padded "],
            ["bad\0dialect"],
            ["z-v1", "a-v1"],
            ["same-v1", "same-v1"],
        ]) {
            const declaration = structuredClone(base);
            declaration.restorationDialectIds = restorationDialectIds as never;
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(/sorted unique non-blank/);
        }

        for (const degradationKinds of [undefined, ["workflow_variable_lost", "target_runtime_missing_asset_kind"]]) {
            const declaration = structuredClone(base);
            declaration.canonicalMaterialization = {
                materializer: GRAPH_REBASE_REF,
                degradationKinds: degradationKinds as never,
                reasonCode: "fixture_reviewed_migration",
            };
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(
                /canonical materialization declaration is invalid/,
            );
        }
        for (const canonicalMaterialization of [
            {
                materializer: GRAPH_REBASE_REF,
                degradationKinds: ["runtime_specific_metadata_lost"],
                substituteAssetKind: "Skill",
                reasonCode: "fixture_reviewed_migration",
            },
            {
                materializer: GRAPH_REBASE_REF,
                degradationKinds: ["target_runtime_missing_asset_kind"],
                substituteAssetKind: "Unknown",
                reasonCode: "fixture_reviewed_migration",
            },
        ]) {
            const declaration = structuredClone(base);
            declaration.canonicalMaterialization = canonicalMaterialization as never;
            expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(
                /canonical materialization declaration is invalid/,
            );
        }

        const currentOnlyBuild = createVerifiedNativeProjectExactGraphBuild({
            ...fixture.build,
            fixtureId: "fixture-current-only-graph",
            assetKind: "Skill",
            nativeDialectId: GRAPH_DIALECT_ID,
            projectGraphValidator: GRAPH_VALIDATOR_REF,
            reverseParser: GRAPH_PARSER_REF,
            rebaseMaterializer: null,
            restorationDialectIds: [],
            parentRebaseFixtureId: "",
            targetGraphIdentity: GRAPH_ENTRY_PATH,
            targetRelativePaths: [GRAPH_ENTRY_PATH],
            exactLoadMarker: "current-only",
            reverseFixtureId: "current-only-reverse",
        });
        expect(currentOnlyBuild.fixtureSetFingerprint).toMatch(/^sha256:/u);

        for (const restorationDialectIds of [["bad\0id"], ["z-v1", "a-v1"]]) {
            expect(() =>
                createVerifiedNativeProjectExactGraphBuild({
                    ...fixture.build,
                    fixtureId: "fixture-invalid-restoration",
                    assetKind: "Skill",
                    nativeDialectId: GRAPH_DIALECT_ID,
                    projectGraphValidator: GRAPH_VALIDATOR_REF,
                    reverseParser: GRAPH_PARSER_REF,
                    rebaseMaterializer: GRAPH_REBASE_REF,
                    restorationDialectIds,
                    parentRebaseFixtureId: "parent",
                    targetGraphIdentity: GRAPH_ENTRY_PATH,
                    targetRelativePaths: [GRAPH_ENTRY_PATH],
                    exactLoadMarker: "marker",
                    reverseFixtureId: "reverse",
                }),
            ).toThrow(/sorted unique non-blank/);
        }
    });

    it("rejects missing Provider implementations, runtime ownership and materializer identities", () => {
        const fixture = makeExactGraphFixture();
        for (const [project, parse] of [
            [undefined, fixture.support.inspect],
            [projectFixtureGraph, undefined],
        ] as const) {
            expect(() =>
                createNativeProjectExactGraphProviderSupport({
                    adapterId: "FIXTURE",
                    adapterVersion: "0.1.0",
                    agentRuntimes: [fixture.descriptor],
                    agentRuntimeId: fixture.descriptor.agentRuntimeId,
                    assetKind: "Skill",
                    outputContractId: GRAPH_OUTPUT_CONTRACT_ID,
                    materializationProfileId: GRAPH_PROFILE_ID,
                    nativeDialectId: GRAPH_DIALECT_ID,
                    projectGraphValidator: { ref: GRAPH_VALIDATOR_REF, project: project as never },
                    reverseParser: { ref: GRAPH_PARSER_REF, parse: parse as never },
                    rebaseMaterializer: null,
                    restorationDialectIds: [],
                    target: fixture.support.renderContractDeclaration.target,
                    verifiedBuilds: [fixture.build],
                }),
            ).toThrow(/Provider-owned graph and parser/);
        }

        expect(() => makeSupport({ agentRuntimes: [] })).toThrow(/unknown agent runtime/);
        expect(() => makeSupport({ verifiedBuilds: [] })).toThrow(/verified builds/);
        expect(() => makeSupport({ verifiedBuilds: [{ ...fixture.build, materializationProfileId: "foreign" }] })).toThrow(
            /verified builds/,
        );
        for (const materializerCapabilityKey of ["", " padded ", "bad\0key"]) {
            expect(() => makeSupport({ materializerCapabilityKey })).toThrow(/canonical non-blank text/);
        }
    });

    it("requires complete Provider summary ownership and exact applicability facts", () => {
        const fixture = makeExactGraphFixture();
        const missingDescriptor = { ...fixture.provider, agentRuntimes: [] };
        expect(() => nativeProjectExactGraphRegistryComponents([missingDescriptor])).toThrow(/conformance is incomplete/);
        const missingSchema = { ...fixture.provider, targetContextSchemas: [] };
        expect(() => nativeProjectExactGraphRegistryComponents([missingSchema])).toThrow(/conformance is incomplete/);

        const predicate = fixture.components.targetApplicabilityPredicates[0]!;
        expect(predicate.evaluate(fixture.targetContext)).toBe(true);
        const mutations: Array<(context: typeof fixture.targetContext) => void> = [
            (context) => {
                context.agentRuntimeId = "FOREIGN";
            },
            (context) => {
                context.versionText = "9.9.9";
            },
            (context) => {
                context.buildIdentity = `sha256:${"9".repeat(64)}`;
            },
            (context) => {
                context.renderFacts.find((fact) => fact.key === "oaam.platform")!.value = "linux";
            },
            (context) => {
                context.renderFacts.find((fact) => fact.key === "oaam.platform")!.evidenceLevel = "local_artifact";
            },
            (context) => {
                context.renderFacts.find((fact) => fact.key === "oaam.project-binding")!.value = "foreign";
            },
            (context) => {
                context.renderFacts.find((fact) => fact.key === "oaam.project-binding")!.evidenceLevel = "heuristic";
            },
            (context) => {
                context.renderFacts.find((fact) => fact.key === "fixture.mode")!.value = "foreign";
            },
            (context) => {
                context.renderFacts.find((fact) => fact.key === "fixture.mode")!.evidenceLevel = "local_artifact";
            },
        ];
        for (const mutate of mutations) {
            const context = structuredClone(fixture.targetContext);
            mutate(context);
            expect(predicate.evaluate(context)).toBe(false);
        }
    });

    it("routes a newer exact-graph build to the nearest per-cell evidence anchor", () => {
        const fixture = makeExactGraphFixture({
            buildCompatibility: {
                schemaVersion: 1,
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
        });
        const predicate = fixture.components.targetApplicabilityPredicates[0]!;
        expect(predicate.allowsBuildIdentityMismatch).toBe(true);
        const newer = structuredClone(fixture.targetContext);
        newer.versionText = "1.2.4";
        newer.buildIdentity = `sha256:${"4".repeat(64)}`;
        expect(predicate.evaluate(newer)).toBe(true);

        const older = structuredClone(fixture.targetContext);
        older.versionText = "1.2.2";
        older.buildIdentity = `sha256:${"2".repeat(64)}`;
        expect(predicate.evaluate(older)).toBe(false);
    });
});

function graphDeclaration(provider: GraphProvider) {
    const declaration = provider.renderContractDeclarations[0];
    if (declaration?.declarationKind !== "native_project_exact_graph_v1") {
        throw new Error("exact graph declaration fixture is missing");
    }
    return declaration;
}

function makeSupport(
    overrides: Partial<{
        agentRuntimes: ReturnType<typeof makeExactGraphFixture>["provider"]["agentRuntimes"];
        verifiedBuilds: ReturnType<typeof makeExactGraphFixture>["support"]["renderContractDeclaration"]["verifiedBuilds"];
        materializerCapabilityKey: string;
        rebaseMaterializer: typeof graphRebaseMaterializer | null;
        restorationDialectIds: string[];
    }>,
) {
    const fixture = makeExactGraphFixture();
    return createNativeProjectExactGraphProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: overrides.agentRuntimes ?? fixture.provider.agentRuntimes,
        agentRuntimeId: fixture.descriptor.agentRuntimeId,
        assetKind: "Skill",
        outputContractId: GRAPH_OUTPUT_CONTRACT_ID,
        materializationProfileId: GRAPH_PROFILE_ID,
        materializerCapabilityKey: overrides.materializerCapabilityKey,
        nativeDialectId: GRAPH_DIALECT_ID,
        projectGraphValidator: { ref: GRAPH_VALIDATOR_REF, project: projectFixtureGraph },
        reverseParser: {
            ref: GRAPH_PARSER_REF,
            parse: (input) => ({ canonicalContent: structuredClone(input.currentContent) }),
        },
        rebaseMaterializer: overrides.rebaseMaterializer ?? null,
        restorationDialectIds: overrides.restorationDialectIds ?? [],
        target: fixture.support.renderContractDeclaration.target,
        verifiedBuilds: overrides.verifiedBuilds ?? fixture.support.renderContractDeclaration.verifiedBuilds,
    });
}
