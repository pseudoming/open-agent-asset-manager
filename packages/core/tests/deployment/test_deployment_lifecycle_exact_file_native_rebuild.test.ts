/** Exact-file native-authority rebuild and rejection tests. */

import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { computeVersionCanonicalContentFingerprint } from "../../src/foundation/fingerprint";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import { VERSION_ID, makeTextFile } from "../catalog/fixtures/version-v2";
import { makePortableEntryDialectContract } from "../source-import/fixtures/dialect-contracts";
import {
    EXACT_CHANGED_ENTRY_TEXT,
    EXACT_CHANGED_NATIVE_TEXT,
    EXACT_DIALECT_ID,
    EXACT_TARGET_PATH,
    makeExactFileFixture,
} from "../render/fixtures/native-project-exact-file-test-fixtures";

describe("deployment lifecycle exact-file native rebuild", () => {
    it("rebuilds changed native bytes while preserving canonical metadata and portable contracts", () => {
        const base = makeNativeRebuildFixture();
        const files = [makeTextFile(EXACT_CHANGED_ENTRY_TEXT, "SKILL.md")];
        const canonical = { kind: "Skill" as const, typeData: base.fixture.closure.manifest.typeData };
        const canonicalFingerprint = computeVersionCanonicalContentFingerprint(
            canonical,
            files.map((file) => file.file),
        );
        const nativeInput = exactNativeInput(base.fixture);
        const rebuilt = deploymentLifecycleInternalsForTest.rebuildExactFileNativeDialectAuthority({
            nativeInput,
            canonical,
            files,
            nativeDialectId: EXACT_DIALECT_ID,
            targetRelativePath: EXACT_TARGET_PATH,
            nativeText: EXACT_CHANGED_NATIVE_TEXT,
            versionCanonicalContentFingerprint: canonicalFingerprint,
            registry: base.registry,
        });
        expect(rebuilt.nativeRepresentations).toMatchObject([
            {
                dialectId: EXACT_DIALECT_ID,
                canonicalContentFingerprint: canonicalFingerprint,
                files: [{ relativePath: EXACT_TARGET_PATH, executable: false }],
            },
        ]);
        expect(Buffer.from(rebuilt.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(EXACT_CHANGED_NATIVE_TEXT);
        expect(rebuilt.nativeRepresentations[0]!.representationFingerprint).not.toBe(
            nativeInput.representation.representationFingerprint,
        );
    });

    it("rejects restoration, graph, path, dialect, file and validator drift", () => {
        const base = makeNativeRebuildFixture();
        const valid = exactRebuildInput(base);
        const mutations: Array<(input: typeof valid) => void> = [
            (input) => {
                input.nativeInput.representation.dialectId = "foreign-v1";
            },
            (input) => {
                input.nativeInput.files.push(structuredClone(input.nativeInput.files[0]!));
            },
            (input) => {
                input.nativeInput.files = [];
            },
            (input) => {
                input.nativeInput.files[0]!.relativePath = "wrong/SKILL.md";
            },
            (input) => {
                input.nativeInput.files[0]!.contentKind = "binary";
            },
            (input) => {
                input.nativeInput.files[0]!.executable = true;
            },
            (input) => {
                input.files.push(structuredClone(input.files[0]!));
            },
            (input) => {
                input.files = [];
            },
            (input) => {
                input.files[0]!.file.role = "resource";
            },
            (input) => {
                input.files[0]!.file.executable = true;
            },
            (input) => {
                input.files[0]!.file.references = [{ referenceKind: "asset_version", targetAssetVersionId: VERSION_ID }];
            },
            (input) => {
                input.nativeInput.representation.dialectContractFingerprint = base.hash;
            },
            (input) => {
                input.registry = createVersionDialectRegistry([], [], [], []);
            },
        ];
        for (const mutate of mutations) {
            const { registry, ...cloneable } = valid;
            const input = { ...structuredClone(cloneable), registry };
            mutate(input);
            expect(() => deploymentLifecycleInternalsForTest.rebuildExactFileNativeDialectAuthority(input)).toThrow(/exact-file/);
        }

        const rejected = exactRebuildInput(base);
        rejected.registry = createVersionDialectRegistry(
            [{ ...base.fixture.nativeDialect, validateSameContent: () => false }],
            [],
            [base.portableEntry],
            [],
        );
        expect(() => deploymentLifecycleInternalsForTest.rebuildExactFileNativeDialectAuthority(rejected)).toThrow(
            /validator rejected/,
        );
    });
});

function makeNativeRebuildFixture() {
    const fixture = makeExactFileFixture();
    const portableEntry = makePortableEntryDialectContract(
        "Skill",
        "skill_entry",
        fixture.closure.manifest.typeData.entryDialectId,
        () => true,
    );
    return {
        fixture,
        portableEntry,
        registry: createVersionDialectRegistry([fixture.nativeDialect], [], [portableEntry], []),
        hash: `sha256:${"5".repeat(64)}` as const,
    };
}

function exactRebuildInput(base: ReturnType<typeof makeNativeRebuildFixture>) {
    const files = [makeTextFile(EXACT_CHANGED_ENTRY_TEXT, "SKILL.md")];
    const canonical = { kind: "Skill" as const, typeData: base.fixture.closure.manifest.typeData };
    return {
        nativeInput: exactNativeInput(base.fixture),
        canonical,
        files,
        nativeDialectId: EXACT_DIALECT_ID,
        targetRelativePath: EXACT_TARGET_PATH,
        nativeText: EXACT_CHANGED_NATIVE_TEXT,
        versionCanonicalContentFingerprint: computeVersionCanonicalContentFingerprint(
            canonical,
            files.map((file) => file.file),
        ),
        registry: base.registry,
    };
}

function exactNativeInput(fixture: ReturnType<typeof makeExactFileFixture>) {
    const input = structuredClone(fixture.analysisInput.dialectInputs[0]!.inputs[0]!);
    if (input.inputKind !== "native_representation") throw new Error("exact native fixture input is missing");
    return input;
}
