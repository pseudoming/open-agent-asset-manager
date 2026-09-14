/** Registration and immutable profile guards for encoded Subagent files. */

import { describe, expect, it } from "vitest";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import {
    createNativeProjectEncodedFileProviderSupport,
    createVerifiedNativeProjectEncodedFileBuild,
} from "../../src/render/native-project-encoded-file";
import { nativeProjectEncodedFileRegistryComponents } from "../../src/render/native-project-encoded-file-behavior";
import { makeNativeProjectEncodedFileContractParts } from "../../src/render/native-project-encoded-file-profiles";
import type { Sha256Digest } from "../../src/types";
import {
    asEncodedFileProvider,
    decodeEncodedNativeFile,
    ENCODED_DIALECT_ID,
    ENCODED_ENTRY_LOGICAL_PATH,
    ENCODED_OUTPUT_CONTRACT_ID,
    ENCODED_PARSER_REF,
    ENCODED_PATH_REF,
    ENCODED_PROFILE_ID,
    ENCODED_REBASE_REF,
    ENCODED_TARGET_PATH,
    encodedRebaseMaterializer,
    makeEncodedFileFixture,
} from "./fixtures/native-project-encoded-file-test-fixtures";

describe("native project encoded-file registration", () => {
    it("rejects native dialect, parser, rebase and declaration duplication drift", () => {
        const missingNative = asEncodedFileProvider(makeEncodedFileFixture());
        missingNative.dialectContracts.native = [];
        expect(validateAdapterRenderContractRegistration([missingNative])[0]?.message).toMatch(/no unique provider dialect/);

        const parserMismatch = asEncodedFileProvider(makeEncodedFileFixture());
        parserMismatch.dialectContracts.native[0]!.definition.nativeToCanonicalParser = ENCODED_PATH_REF;
        expect(validateAdapterRenderContractRegistration([parserMismatch])[0]?.message).toMatch(/dialect parser/);

        const rebaseMismatch = asEncodedFileProvider(makeEncodedFileFixture());
        rebaseMismatch.dialectContracts.native[0]!.definition.rebaseMaterializer = ENCODED_PATH_REF;
        expect(validateAdapterRenderContractRegistration([rebaseMismatch])[0]?.message).toMatch(/rebase materializer/);

        const duplicate = asEncodedFileProvider(makeEncodedFileFixture());
        duplicate.renderContractDeclarations.push(structuredClone(duplicate.renderContractDeclarations[0]!));
        expect(validateAdapterRenderContractRegistration([duplicate])[0]?.message).toMatch(/duplicate native render/);
    });

    it("rejects malformed components, identities, restoration sets and fixture paths", () => {
        const fixture = makeEncodedFileFixture();
        const base = fixture.support.renderContractDeclaration;
        const wrongKind = structuredClone(base);
        wrongKind.assetKind = "Skill" as never;
        expect(() => makeNativeProjectEncodedFileContractParts(wrongKind)).toThrow(/accepts only Subagent/);
        for (const mutate of [
            (declaration: typeof base) => {
                declaration.projectPathValidator.componentId = "";
            },
            (declaration: typeof base) => {
                declaration.reverseParser.componentVersion = 0;
            },
            (declaration: typeof base) => {
                declaration.rebaseMaterializer.configFingerprint = "bad" as Sha256Digest;
            },
        ]) {
            const declaration = structuredClone(base);
            mutate(declaration);
            expect(() => makeNativeProjectEncodedFileContractParts(declaration)).toThrow(/component is invalid/);
        }

        for (const nativeDialectId of ["", "bad\0dialect"]) {
            const declaration = structuredClone(base);
            declaration.nativeDialectId = nativeDialectId;
            expect(() => makeNativeProjectEncodedFileContractParts(declaration)).toThrow(/invalid dialect/);
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
            expect(() => makeNativeProjectEncodedFileContractParts(declaration)).toThrow(/sorted unique non-blank/);
        }

        for (const canonicalLogicalPaths of [
            [],
            ["bad/../entry"],
            [ENCODED_ENTRY_LOGICAL_PATH, ENCODED_ENTRY_LOGICAL_PATH],
            [ENCODED_ENTRY_LOGICAL_PATH, "resource.md", "extra.md"],
        ]) {
            expect(() =>
                createVerifiedNativeProjectEncodedFileBuild({
                    ...fixture.build,
                    fixtureId: "invalid-encoded-paths",
                    nativeDialectId: ENCODED_DIALECT_ID,
                    projectPathValidator: ENCODED_PATH_REF,
                    reverseParser: ENCODED_PARSER_REF,
                    rebaseMaterializer: ENCODED_REBASE_REF,
                    restorationDialectIds: [],
                    parentRebaseFixtureId: "parent",
                    targetRelativePath: ENCODED_TARGET_PATH,
                    canonicalLogicalPaths: canonicalLogicalPaths as never,
                    exactLoadMarker: "marker",
                    reverseFixtureId: "reverse",
                }),
            ).toThrow(/fixture paths are invalid/);
        }
    });

    it("requires Provider-owned functions, exact runtime ownership, builds and materializer identity", () => {
        const fixture = makeEncodedFileFixture();
        for (const patch of [
            { projectPathValidator: { ref: ENCODED_PATH_REF, validate: undefined as never } },
            { reverseParser: { ref: ENCODED_PARSER_REF, decode: undefined as never } },
            { rebaseMaterializer: { ref: ENCODED_REBASE_REF, materialize: undefined as never } },
        ]) {
            expect(() => makeSupport(patch)).toThrow(/Provider-owned path, decoder and rebase/);
        }
        expect(() => makeSupport({ agentRuntimes: [] })).toThrow(/unknown agent runtime/);
        expect(() => makeSupport({ verifiedBuilds: [] })).toThrow(/verified builds/);
        expect(() =>
            makeSupport({ verifiedBuilds: [{ ...fixture.build, materializationProfileId: "foreign-profile" }] }),
        ).toThrow(/verified builds/);
        for (const materializerCapabilityKey of ["", " padded ", "bad\0key"]) {
            expect(() => makeSupport({ materializerCapabilityKey })).toThrow(/canonical non-blank text/);
        }
    });

    it("requires complete Provider summary ownership and exact applicability facts", () => {
        const fixture = makeEncodedFileFixture();
        expect(() => nativeProjectEncodedFileRegistryComponents([{ ...fixture.provider, agentRuntimes: [] }])).toThrow(
            /conformance is incomplete/,
        );
        expect(() => nativeProjectEncodedFileRegistryComponents([{ ...fixture.provider, targetContextSchemas: [] }])).toThrow(
            /conformance is incomplete/,
        );

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

    it("routes a newer encoded-file build through the Provider-owned nearest anchor and blocks older builds", () => {
        const fixture = makeEncodedFileFixture();
        const support = makeSupport({
            buildCompatibility: {
                schemaVersion: 1,
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
        });
        const provider = {
            ...fixture.provider,
            renderContractDeclarations: [support.renderContractDeclaration],
        };
        const [predicate] = nativeProjectEncodedFileRegistryComponents([provider]).targetApplicabilityPredicates;
        expect(predicate).toBeDefined();
        expect(support.renderContractDeclaration.buildCompatibility).toEqual({
            schemaVersion: 1,
            versionOrdering: "numeric_dotted_core_v1",
            unknownVersionPolicy: "allow_with_warning",
            deniedBuilds: [],
        });
        const newer = structuredClone(fixture.targetContext);
        newer.versionText = "1.2.4";
        newer.buildIdentity = `sha256:${"4".repeat(64)}`;
        expect(predicate!.evaluate(newer)).toBe(true);
        const older = structuredClone(fixture.targetContext);
        older.versionText = "1.2.2";
        older.buildIdentity = `sha256:${"2".repeat(64)}`;
        expect(predicate!.evaluate(older)).toBe(false);
    });
});

function makeSupport(overrides: Partial<Parameters<typeof createNativeProjectEncodedFileProviderSupport>[0]>) {
    const fixture = makeEncodedFileFixture();
    return createNativeProjectEncodedFileProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: fixture.provider.agentRuntimes,
        agentRuntimeId: fixture.descriptor.agentRuntimeId,
        outputContractId: ENCODED_OUTPUT_CONTRACT_ID,
        materializationProfileId: ENCODED_PROFILE_ID,
        nativeDialectId: ENCODED_DIALECT_ID,
        projectPathValidator: { ref: ENCODED_PATH_REF, validate: () => true },
        reverseParser: { ref: ENCODED_PARSER_REF, decode: decodeEncodedNativeFile },
        rebaseMaterializer: encodedRebaseMaterializer,
        restorationDialectIds: [],
        target: fixture.support.renderContractDeclaration.target,
        verifiedBuilds: [fixture.build],
        ...overrides,
    });
}
