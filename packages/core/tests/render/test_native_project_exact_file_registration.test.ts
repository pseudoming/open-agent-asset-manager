/** Registration and profile identity guards for exact-file targets. */

import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "../../src/types";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import {
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
    makeNativeProjectExactFileContractParts,
    nativeProjectExactFileRegistryComponents,
} from "../../src/render/native-project-exact-file";
import {
    EXACT_DIALECT_ID,
    EXACT_ENTRY_TEXT,
    EXACT_OUTPUT_CONTRACT_ID,
    EXACT_PARSER_REF,
    EXACT_PATH_REF,
    EXACT_PROFILE_ID,
    EXACT_TARGET_PATH,
    asExactFileProvider,
    makeExactFileFixture,
} from "./fixtures/native-project-exact-file-test-fixtures";

type ExactProvider = ReturnType<typeof asExactFileProvider>;

function firstNativeContract(provider: ExactProvider) {
    const contract = provider.dialectContracts.native[0];
    if (contract === undefined) throw new Error("exact native dialect fixture is missing");
    return contract;
}

function firstRenderDeclaration(provider: ExactProvider) {
    const declaration = provider.renderContractDeclarations[0];
    if (declaration === undefined) throw new Error("exact render declaration fixture is missing");
    return declaration;
}

describe("native project exact-file registration", () => {
    it("uses one exact conformance anchor for an explicitly compatible newer current build", () => {
        const fixture = makeExactFileFixture({
            buildCompatibility: {
                schemaVersion: 1,
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
            currentVersionText: "1.2.4",
            currentBuildIdentity: `sha256:${"4".repeat(64)}`,
        });
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis.status).toBe("complete");
        if (analysis.status !== "complete") throw new Error("compatible exact-file fixture did not analyze");
        expect(
            fixture.registry.findMaterializerCandidates(analysis.outputUnits[0]!, [
                { context: fixture.targetContext, assetKind: "Skill", renderStrategy: "native_file" },
            ]),
        ).toHaveLength(1);

        const exactOnly = makeExactFileFixture({
            currentVersionText: "1.2.4",
            currentBuildIdentity: `sha256:${"4".repeat(64)}`,
        });
        const exactAnalysis = exactOnly.support.analyze(exactOnly.analysisInput);
        if (exactAnalysis.status !== "complete") throw new Error("exact-only fixture did not analyze");
        expect(
            exactOnly.registry.findMaterializerCandidates(exactAnalysis.outputUnits[0]!, [
                { context: exactOnly.targetContext, assetKind: "Skill", renderStrategy: "native_file" },
            ]),
        ).toEqual([]);
    });

    it("supports distinct materializer identities for sibling runtime entries without changing the legacy default", () => {
        const fixture = makeExactFileFixture({ materializerCapabilityKey: "fixture.cli-project-skill-exact-file-v1" });
        const appDescriptor = { agentRuntimeId: "FIXTURE_APP", displayName: "Fixture App", entryClass: "app" as const };
        const appProfileId = "fixture-app-project-skill-v1";
        const appBuild = createVerifiedNativeProjectExactFileBuild({
            ...fixture.build,
            agentRuntimeId: appDescriptor.agentRuntimeId,
            platform: "win32",
            versionText: "2.3.4",
            buildIdentity: `sha256:${"8".repeat(64)}`,
            materializationProfileId: appProfileId,
            fixtureId: "fixture-app-2.3.4-project-skill-2026-08-02",
            assetKind: "Skill",
            nativeDialectId: EXACT_DIALECT_ID,
            projectPathValidator: EXACT_PATH_REF,
            reverseParser: EXACT_PARSER_REF,
            rebaseMaterializer: fixture.rebaseMaterializer.ref,
            restorationDialectIds: [],
            parentRebaseFixtureId: "fixture-app-2.3.4-project-skill-parent-rebase-v1",
            targetRelativePath: EXACT_TARGET_PATH,
            exactLoadMarker: "OAAM_FIXTURE_APP_SKILL_MARKER",
            reverseFixtureId: "fixture-app-project-skill-whole-file-reverse-v1",
        });
        const appSupport = createNativeProjectExactFileProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor, appDescriptor],
            agentRuntimeId: appDescriptor.agentRuntimeId,
            assetKind: "Skill",
            outputContractId: "FIXTURE_APP_NATIVE_PROJECT_SKILL_V1",
            materializationProfileId: appProfileId,
            materializerCapabilityKey: "fixture.app-project-skill-exact-file-v1",
            nativeDialectId: EXACT_DIALECT_ID,
            projectPathValidator: { ref: EXACT_PATH_REF, validate: (path) => path === EXACT_TARGET_PATH },
            reverseParser: { ref: EXACT_PARSER_REF, parse: () => ({ canonicalEntryText: EXACT_ENTRY_TEXT }) },
            rebaseMaterializer: fixture.rebaseMaterializer,
            restorationDialectIds: [],
            target: {
                targetContextSchemaId: "FIXTURE_APP_PROJECT_TARGET_V1",
                requiredFacts: { "oaam.project-binding": "registered", "fixture.mode": "exact" },
            },
            verifiedBuilds: [appBuild],
        });
        const provider = asExactFileProvider(fixture);
        provider.agentRuntimes.push(appDescriptor);
        provider.targetContextSchemas.push(appSupport.targetContextSchema);
        provider.assetTargetCapabilities.push(appSupport.targetCapability);
        provider.materializerCapabilities.push(appSupport.materializerCapability);
        provider.renderContractDeclarations.push(appSupport.renderContractDeclaration);

        expect(validateAdapterRenderContractRegistration([provider])).toEqual([]);
        expect(provider.materializerCapabilities.map((row) => row.materializerCapabilityKey)).toEqual([
            "fixture.cli-project-skill-exact-file-v1",
            "fixture.app-project-skill-exact-file-v1",
        ]);
        expect(makeExactFileFixture().support.materializerCapability.materializerCapabilityKey).toBe(
            "fixture.project-skill-exact-file-v1",
        );

        provider.materializerCapabilities[1]!.materializerCapabilityKey =
            provider.materializerCapabilities[0]!.materializerCapabilityKey;
        expect(validateAdapterRenderContractRegistration([provider])[0]?.message).toMatch(/duplicate materializer/);
    });

    it("allows one runtime and AssetKind to own distinct exact output contracts while rejecting an exact duplicate", () => {
        const fixture = makeExactFileFixture({ materializerCapabilityKey: "fixture.project-skill-primary-v1" });
        const siblingProfileId = "fixture-project-skill-sibling-v1";
        const siblingBuild = createVerifiedNativeProjectExactFileBuild({
            ...fixture.build,
            materializationProfileId: siblingProfileId,
            fixtureId: "fixture-cli-1.2.3-project-skill-sibling-2026-08-03",
            assetKind: "Skill",
            nativeDialectId: EXACT_DIALECT_ID,
            projectPathValidator: EXACT_PATH_REF,
            reverseParser: EXACT_PARSER_REF,
            rebaseMaterializer: fixture.rebaseMaterializer.ref,
            restorationDialectIds: [],
            parentRebaseFixtureId: "fixture-cli-1.2.3-project-skill-sibling-parent-rebase-v1",
            targetRelativePath: EXACT_TARGET_PATH,
            exactLoadMarker: "OAAM_FIXTURE_CLI_SKILL_SIBLING_MARKER",
            reverseFixtureId: "fixture-cli-project-skill-sibling-reverse-v1",
        });
        const siblingSupport = createNativeProjectExactFileProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor],
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            assetKind: "Skill",
            outputContractId: "FIXTURE_NATIVE_PROJECT_SKILL_SIBLING_V1",
            materializationProfileId: siblingProfileId,
            materializerCapabilityKey: "fixture.project-skill-sibling-v1",
            nativeDialectId: EXACT_DIALECT_ID,
            projectPathValidator: { ref: EXACT_PATH_REF, validate: (path) => path === EXACT_TARGET_PATH },
            reverseParser: { ref: EXACT_PARSER_REF, parse: () => ({ canonicalEntryText: EXACT_ENTRY_TEXT }) },
            rebaseMaterializer: fixture.rebaseMaterializer,
            restorationDialectIds: [],
            target: {
                targetContextSchemaId: fixture.support.targetContextSchema.targetContextSchemaId,
                requiredFacts: { "oaam.project-binding": "registered", "fixture.mode": "exact" },
            },
            verifiedBuilds: [siblingBuild],
        });
        const provider = asExactFileProvider(fixture);
        provider.assetTargetCapabilities.push(siblingSupport.targetCapability);
        provider.materializerCapabilities.push(siblingSupport.materializerCapability);
        provider.renderContractDeclarations.push(siblingSupport.renderContractDeclaration);

        expect(validateAdapterRenderContractRegistration([provider])).toEqual([]);

        const duplicate = structuredClone(siblingSupport.renderContractDeclaration);
        duplicate.outputContractId = fixture.support.renderContractDeclaration.outputContractId;
        provider.renderContractDeclarations.push(duplicate);
        expect(validateAdapterRenderContractRegistration([provider])[0]?.message).toMatch(/duplicate native render declarations/);
    });
    it("rejects malformed explicit materializer identities at exact-file construction", () => {
        for (const materializerCapabilityKey of ["", " padded ", "bad\0key"]) {
            expect(() => makeExactFileFixture({ materializerCapabilityKey })).toThrow(/canonical non-blank text/);
        }
    });

    it("fails registration when declaration, dialect, schema or materializer ownership diverges", () => {
        const fixture = makeExactFileFixture();
        const mutations = [
            (provider: ExactProvider) => {
                provider.dialectContracts.native = [];
            },
            (provider: ExactProvider) => {
                firstNativeContract(provider).definition.nativeToCanonicalParser = EXACT_PATH_REF;
            },
            (provider: ExactProvider) => {
                firstNativeContract(provider).definition.rebaseMaterializer = EXACT_PATH_REF;
            },
            (provider: ExactProvider) => {
                const declaration = firstRenderDeclaration(provider);
                if (declaration.declarationKind === "native_project_exact_file_v1") {
                    declaration.restorationDialectIds = ["missing-restoration-v1"];
                }
            },
            (provider: ExactProvider) => {
                provider.targetContextSchemas = [];
            },
            (provider: ExactProvider) => {
                provider.assetTargetCapabilities = [];
            },
            (provider: ExactProvider) => {
                provider.materializerCapabilities = [];
            },
            (provider: ExactProvider) => {
                provider.renderContractDeclarations.push(structuredClone(firstRenderDeclaration(provider)));
            },
        ];
        for (const mutate of mutations) {
            const provider = asExactFileProvider(makeExactFileFixture());
            mutate(provider);
            expect(validateAdapterRenderContractRegistration([provider])).toMatchObject([
                { code: "adapter.render_contract_invalid" },
            ]);
        }

        const rebaseMismatch = asExactFileProvider(makeExactFileFixture());
        firstNativeContract(rebaseMismatch).definition.rebaseMaterializer = EXACT_PATH_REF;
        expect(validateAdapterRenderContractRegistration([rebaseMismatch])[0]?.message).toMatch(/rebase materializer/);
        const missingRestoration = asExactFileProvider(makeExactFileFixture());
        const restorationDeclaration = firstRenderDeclaration(missingRestoration);
        if (restorationDeclaration.declarationKind !== "native_project_exact_file_v1") {
            throw new Error("exact declaration fixture is missing");
        }
        restorationDeclaration.restorationDialectIds = ["missing-restoration-v1"];
        expect(validateAdapterRenderContractRegistration([missingRestoration])[0]?.message).toMatch(/restoration dialect/);

        expect(() =>
            createNativeProjectExactFileProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                assetKind: "Skill",
                outputContractId: EXACT_OUTPUT_CONTRACT_ID,
                materializationProfileId: EXACT_PROFILE_ID,
                nativeDialectId: EXACT_DIALECT_ID,
                projectPathValidator: { ref: EXACT_PATH_REF, validate: undefined as never },
                reverseParser: { ref: EXACT_PARSER_REF, parse: undefined as never },
                rebaseMaterializer: fixture.rebaseMaterializer,
                restorationDialectIds: [],
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [fixture.build],
            }),
        ).toThrow(/Provider-owned path and parser/);
        expect(() =>
            createNativeProjectExactFileProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                assetKind: "Skill",
                outputContractId: EXACT_OUTPUT_CONTRACT_ID,
                materializationProfileId: EXACT_PROFILE_ID,
                nativeDialectId: EXACT_DIALECT_ID,
                projectPathValidator: { ref: EXACT_PATH_REF, validate: () => true },
                reverseParser: { ref: EXACT_PARSER_REF, parse: () => ({ canonicalEntryText: EXACT_ENTRY_TEXT }) },
                rebaseMaterializer: fixture.rebaseMaterializer,
                restorationDialectIds: [],
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [fixture.build],
            }),
        ).toThrow(/unknown agent runtime/);
        expect(() => nativeProjectExactFileRegistryComponents([{ ...fixture.provider, targetContextSchemas: [] }])).toThrow(
            /no provider schema/,
        );

        const invalidCompatibility = asExactFileProvider(
            makeExactFileFixture({
                buildCompatibility: {
                    schemaVersion: 1,
                    versionOrdering: "numeric_dotted_core_v1",
                    unknownVersionPolicy: "allow_with_warning",
                    deniedBuilds: [],
                },
            }),
        );
        const declaration = firstRenderDeclaration(invalidCompatibility);
        if (declaration.declarationKind !== "native_project_exact_file_v1") throw new Error("fixture kind changed");
        declaration.buildCompatibility!.versionOrdering = "invalid" as never;
        expect(validateAdapterRenderContractRegistration([invalidCompatibility])[0]?.message).toMatch(/compatibility policy/);
    });

    it("rejects invalid component identities, dialect names, kinds and build ownership", () => {
        const fixture = makeExactFileFixture();
        const invalidKind = structuredClone(fixture.support.renderContractDeclaration);
        invalidKind.assetKind = "Guidance" as never;
        expect(() => makeNativeProjectExactFileContractParts(invalidKind)).toThrow(/unsupported AssetKind/);
        for (const assetKind of ["Guidance"] as const) {
            expect(() =>
                createVerifiedNativeProjectExactFileBuild({
                    ...fixture.build,
                    fixtureId: "invalid-kind",
                    assetKind: assetKind as never,
                    nativeDialectId: EXACT_DIALECT_ID,
                    projectPathValidator: EXACT_PATH_REF,
                    reverseParser: EXACT_PARSER_REF,
                    rebaseMaterializer: fixture.support.renderContractDeclaration.rebaseMaterializer,
                    restorationDialectIds: [],
                    parentRebaseFixtureId: "invalid-kind-parent-rebase",
                    targetRelativePath: EXACT_TARGET_PATH,
                    exactLoadMarker: "marker",
                    reverseFixtureId: "reverse",
                }),
            ).toThrow(/unsupported/);
        }
        for (const invalid of ["", "bad\0dialect"]) {
            const declaration = structuredClone(fixture.support.renderContractDeclaration);
            declaration.nativeDialectId = invalid;
            expect(() => makeNativeProjectExactFileContractParts(declaration)).toThrow(/invalid dialect/);
        }
        for (const restorationDialectIds of [[""], ["z-restoration-v1", "a-restoration-v1"]]) {
            const declaration = structuredClone(fixture.support.renderContractDeclaration);
            declaration.restorationDialectIds = restorationDialectIds;
            expect(() => makeNativeProjectExactFileContractParts(declaration)).toThrow(/sorted unique non-blank/);
        }
        for (const mutate of [
            (declaration: typeof fixture.support.renderContractDeclaration) => {
                declaration.projectPathValidator.componentId = "";
            },
            (declaration: typeof fixture.support.renderContractDeclaration) => {
                declaration.reverseParser.componentVersion = 0;
            },
            (declaration: typeof fixture.support.renderContractDeclaration) => {
                declaration.reverseParser.configFingerprint = "bad" as Sha256Digest;
            },
        ]) {
            const declaration = structuredClone(fixture.support.renderContractDeclaration);
            mutate(declaration);
            expect(() => makeNativeProjectExactFileContractParts(declaration)).toThrow(/component is invalid/);
        }
        expect(() =>
            createNativeProjectExactFileProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                assetKind: "Skill",
                outputContractId: EXACT_OUTPUT_CONTRACT_ID,
                materializationProfileId: EXACT_PROFILE_ID,
                nativeDialectId: EXACT_DIALECT_ID,
                projectPathValidator: { ref: EXACT_PATH_REF, validate: () => true },
                reverseParser: { ref: EXACT_PARSER_REF, parse: () => ({ canonicalEntryText: EXACT_ENTRY_TEXT }) },
                rebaseMaterializer: fixture.rebaseMaterializer,
                restorationDialectIds: [],
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [{ ...fixture.build, materializationProfileId: "foreign" }],
            }),
        ).toThrow(/verified builds/);
        for (const [rebaseMaterializer, parentRebaseFixtureId] of [
            [null, "unexpected-parent-fixture"],
            [fixture.support.renderContractDeclaration.rebaseMaterializer, ""],
        ] as const) {
            expect(() =>
                createVerifiedNativeProjectExactFileBuild({
                    ...fixture.build,
                    fixtureId: "invalid-parent-rebase",
                    assetKind: "Skill",
                    nativeDialectId: EXACT_DIALECT_ID,
                    projectPathValidator: EXACT_PATH_REF,
                    reverseParser: EXACT_PARSER_REF,
                    rebaseMaterializer,
                    restorationDialectIds: [],
                    parentRebaseFixtureId,
                    targetRelativePath: EXACT_TARGET_PATH,
                    exactLoadMarker: "marker",
                    reverseFixtureId: "reverse",
                }),
            ).toThrow(/parent rebase fixture identity/);
        }
        expect(() =>
            createVerifiedNativeProjectExactFileBuild({
                ...fixture.build,
                fixtureId: "invalid-restoration-order",
                assetKind: "Skill",
                nativeDialectId: EXACT_DIALECT_ID,
                projectPathValidator: EXACT_PATH_REF,
                reverseParser: EXACT_PARSER_REF,
                rebaseMaterializer: fixture.support.renderContractDeclaration.rebaseMaterializer,
                restorationDialectIds: ["duplicate-v1", "duplicate-v1"],
                parentRebaseFixtureId: "invalid-restoration-parent-rebase",
                targetRelativePath: EXACT_TARGET_PATH,
                exactLoadMarker: "marker",
                reverseFixtureId: "reverse",
            }),
        ).toThrow(/sorted unique non-blank/);
    });
});
