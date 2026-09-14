/** The source-native callback is a frozen implementation of an existing contract ref. */
import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry, snapshotAdapterDialectContracts } from "../../src/catalog/version-dialect-registry";
import type { AdapterNativeDialectContractV1, NativeDialectGraphRebaseInputV1 } from "../../src/contracts/dialect";
import { computeNativeDialectContractFingerprint } from "../../src/foundation/fingerprint";
import {
    GRAPH_DIALECT_ID,
    GRAPH_HASH,
    graphRebaseMaterializer,
    graphSkillCanonical,
    makeGraphDialectInput,
    makeGraphNativeDialectContract,
} from "../render/fixtures/native-project-exact-graph-native-test-fixtures";
import { makeGraphFiles } from "../render/fixtures/native-project-exact-graph-test-fixtures";
import { ASSET_ID, VERSION_ID } from "./fixtures/version-v2";

function rebaseInput(): NativeDialectGraphRebaseInputV1 {
    const native = makeGraphDialectInput(GRAPH_HASH, makeGraphNativeDialectContract()).inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native graph fixture missing");
    return {
        assetKind: "Skill",
        nativeDialectId: GRAPH_DIALECT_ID,
        targetCanonical: graphSkillCanonical(),
        targetFiles: makeGraphFiles(),
        parent: {
            sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
            representation: native.representation,
            files: native.files,
        },
        restorationInputs: [],
    };
}
function contract(): AdapterNativeDialectContractV1 {
    return {
        ...makeGraphNativeDialectContract(),
        rebase: { ...graphRebaseMaterializer, ref: { ...graphRebaseMaterializer.ref } },
    };
}
function resolve(value: AdapterNativeDialectContractV1) {
    return createVersionDialectRegistry([value], [], [], []).getNative("Skill", GRAPH_DIALECT_ID)!;
}

describe("native dialect source rebase registry", () => {
    it("keeps the declared fingerprint and callback stable through both freezes", () => {
        const source = contract(),
            expected = computeNativeDialectContractFingerprint(source.definition);
        const snapshot = snapshotAdapterDialectContracts({
            native: [source],
            restoration: [],
            portableEntries: [],
            portableSelectors: [],
        });
        const resolved = resolve(snapshot.native[0]!);
        source.rebase!.materialize = () => null;
        source.rebase!.ref.componentId = "mutated";
        expect(resolved.contractFingerprint).toBe(expected);
        expect(Object.isFrozen(snapshot.native[0]!.rebase)).toBe(true);
        expect(Object.isFrozen(snapshot.native[0]!.rebase!.ref)).toBe(true);
        expect(resolved.rebaseNativeGraph!(rebaseInput())?.nativeFiles).toHaveLength(3);
    });

    it("isolates mutations to the input and returned graph", () => {
        const source = contract(),
            input = rebaseInput(),
            original = structuredClone(input);
        const retained = graphRebaseMaterializer.materialize(input)!;
        source.rebase!.materialize = (value) => {
            value.parent.files[0]!.executable = true;
            value.targetCanonical.typeData.description = "mutated";
            return retained;
        };
        const result = resolve(source).rebaseNativeGraph!(input)!;
        result.nativeFiles[0]!.executable = true;
        expect(input).toEqual(original);
        expect(retained.nativeFiles[0]!.executable).toBe(false);
    });

    it("rejects a wrong kind, wrong dialect, throwing callback and uncloneable input/result", () => {
        const source = contract();
        let calls = 0;
        source.rebase!.materialize = () => {
            calls++;
            throw new Error("source decoder fault");
        };
        const run = resolve(source).rebaseNativeGraph!;
        expect(run({ ...rebaseInput(), assetKind: "Workflow" })).toBeNull();
        expect(run({ ...rebaseInput(), nativeDialectId: "other-skill-v1" })).toBeNull();
        expect(calls).toBe(0);
        expect(run(rebaseInput())).toBeNull();
        expect(calls).toBe(1);
        const hostile = rebaseInput();
        Object.defineProperty(hostile, "assetKind", {
            get() {
                throw new Error("input fault");
            },
        });
        expect(run(hostile)).toBeNull();
        const uncloneable = { ...rebaseInput(), unexpected: () => undefined };
        expect(run(uncloneable)).toBeNull();
        source.rebase!.materialize = (() => ({ nativeFiles: [], unexpected: () => undefined })) as never;
        expect(resolve(source).rebaseNativeGraph!(rebaseInput())).toBeNull();
        source.rebase!.materialize = () => null;
        expect(resolve(source).rebaseNativeGraph!(rebaseInput())).toBeNull();
    });

    it("ignores inherited callbacks and leaves a declaration without an implementation unavailable", () => {
        const source = makeGraphNativeDialectContract();
        Object.setPrototypeOf(source, { rebase: graphRebaseMaterializer });
        expect(resolve(source).rebaseNativeGraph).toBeUndefined();
        expect(resolve(makeGraphNativeDialectContract()).rebaseNativeGraph).toBeUndefined();
    });

    it.each([
        "undefined",
        "null",
        "missing_ref",
        "non_callable",
        "undeclared",
        "wrong_ref",
    ])("rejects an own malformed callback: %s", (variant) => {
        const source = contract();
        if (variant === "undefined") source.rebase = undefined as never;
        if (variant === "null") source.rebase = null as never;
        if (variant === "missing_ref") source.rebase = { materialize: graphRebaseMaterializer.materialize } as never;
        if (variant === "non_callable") source.rebase!.materialize = 1 as never;
        if (variant === "undeclared") source.definition.rebaseMaterializer = null;
        if (variant === "wrong_ref") source.rebase!.ref.componentVersion++;
        expect(() => resolve(source)).toThrow(/must match the declared component/);
    });
});
