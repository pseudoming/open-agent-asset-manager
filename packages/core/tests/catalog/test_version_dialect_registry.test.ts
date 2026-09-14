import { describe, expect, it } from "vitest";
import {
    computeNativeDialectContractFingerprint,
    computeRestorationDialectContractFingerprint,
} from "../../src/foundation/fingerprint";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    assertAdapterDialectContracts,
    createVersionDialectRegistry,
    snapshotAdapterDialectContracts,
} from "../../src/catalog/version-dialect-registry";
import type {
    AdapterDialectContractSetV1,
    AdapterNativeDialectContractV1,
    AdapterRestorationDialectContractV1,
    Sha256Digest,
} from "../../src/types";
import { makeNativeDialectContract, makeRestorationDialectContract } from "../source-import/fixtures/dialect-contracts";

const SHA = `sha256:${"b".repeat(64)}` as Sha256Digest;

describe("Version dialect registry", () => {
    it("computes contract identities and freezes validator identity", () => {
        let nativeCalls = 0;
        let restorationCalls = 0;
        const nativeZ = makeNativeDialectContract("Skill", "zeta-skill-v1", () => {
            nativeCalls++;
            return true;
        });
        const nativeA = makeNativeDialectContract("Guidance", "alpha-guidance-v1");
        nativeZ.definition.targetApplicabilityPredicate = {
            componentId: "zeta-skill-v1.target",
            componentVersion: 1,
            configFingerprint: SHA,
        };
        nativeA.definition.rebaseMaterializer = {
            componentId: "alpha-guidance-v1.rebase",
            componentVersion: 1,
            configFingerprint: SHA,
        };
        const restoration = makeRestorationDialectContract("Memory", "memory-state-v1", () => {
            restorationCalls++;
            return true;
        });
        const contracts: AdapterDialectContractSetV1 = {
            native: [nativeZ, nativeA],
            restoration: [restoration],
            portableEntries: [],
            portableSelectors: [],
        };
        const snapshot = snapshotAdapterDialectContracts(contracts);
        const registry = createVersionDialectRegistry(
            snapshot.native,
            snapshot.restoration,
            snapshot.portableEntries,
            snapshot.portableSelectors,
        );
        const resolvedNative = registry.getNative("Skill", "zeta-skill-v1");
        const resolvedRestoration = registry.getRestoration("Memory", "memory-state-v1");

        expect(resolvedNative?.contractFingerprint).toBe(computeNativeDialectContractFingerprint(nativeZ.definition));
        expect(resolvedRestoration?.contractFingerprint).toBe(
            computeRestorationDialectContractFingerprint(restoration.definition),
        );
        expect(
            resolvedNative?.validateSameContent({
                canonical: {} as never,
                canonicalFiles: [],
                representation: {
                    schemaVersion: 1,
                    dialectId: "zeta-skill-v1",
                    dialectContractFingerprint: resolvedNative.contractFingerprint,
                    canonicalContentFingerprint: SHA,
                    files: [],
                    representationFingerprint: SHA,
                },
                nativeFiles: [],
            }),
        ).toBe(true);
        expect(resolvedRestoration?.validatePayload(new Uint8Array([1]))).toBe(true);
        expect(nativeCalls).toBe(1);
        expect(restorationCalls).toBe(1);

        nativeZ.definition.dialectId = "caller-mutated-v2";
        nativeZ.validateSameContent = () => false;
        expect(snapshot.native[0]?.definition.dialectId).toBe("zeta-skill-v1");
        expect(Object.isFrozen(snapshot.native)).toBe(true);
        expect(Object.isFrozen(snapshot.native[0]?.definition)).toBe(true);

        expect(registry.getNative("Guidance", "alpha-guidance-v1")).not.toBeNull();
    });

    it("keeps empty and unknown dialects fail closed", () => {
        assertAdapterDialectContracts({
            native: [],
            restoration: [],
            portableEntries: [],
            portableSelectors: [],
        });
        expect(EMPTY_VERSION_DIALECT_REGISTRY.getNative("Guidance", "missing-v1")).toBeNull();
        expect(EMPTY_VERSION_DIALECT_REGISTRY.getRestoration("Guidance", "missing-v1")).toBeNull();
    });

    it("isolates validator mutation and turns throws or non-boolean success into rejection", () => {
        const nativeBytes = new Uint8Array([1, 2]);
        const canonical = { kind: "Guidance", typeData: { loadingLevel: "high" } } as never;
        const representation = {
            schemaVersion: 1,
            dialectId: "mutating-guidance-v1",
            dialectContractFingerprint: SHA,
            canonicalContentFingerprint: SHA,
            files: [],
            representationFingerprint: SHA,
        } as const;
        const mutatingNative = makeNativeDialectContract("Guidance", "mutating-guidance-v1", (input) => {
            input.nativeFiles[0]!.bytes[0] = 9;
            (input.canonical.typeData as { loadingLevel: string }).loadingLevel = "low";
            return true;
        });
        const mutatingRestoration = makeRestorationDialectContract("Memory", "mutating-memory-v1", (bytes) => {
            bytes[0] = 9;
            return true;
        });
        const registry = createVersionDialectRegistry([mutatingNative], [mutatingRestoration], [], []);

        expect(
            registry.getNative("Guidance", "mutating-guidance-v1")?.validateSameContent({
                canonical,
                canonicalFiles: [],
                representation,
                nativeFiles: [{ relativePath: "CLAUDE.md", bytes: nativeBytes }],
            }),
        ).toBe(true);
        expect(nativeBytes).toEqual(new Uint8Array([1, 2]));
        expect((canonical as { typeData: { loadingLevel: string } }).typeData.loadingLevel).toBe("high");
        const restorationBytes = new Uint8Array([3, 4]);
        expect(registry.getRestoration("Memory", "mutating-memory-v1")?.validatePayload(restorationBytes)).toBe(true);
        expect(restorationBytes).toEqual(new Uint8Array([3, 4]));

        const rejected = createVersionDialectRegistry(
            [
                makeNativeDialectContract("Guidance", "throwing-guidance-v1", () => {
                    throw new Error("validator fault");
                }),
                makeNativeDialectContract("Guidance", "nonboolean-guidance-v1", (() => "yes") as never),
            ],
            [
                makeRestorationDialectContract("Memory", "throwing-memory-v1", () => {
                    throw new Error("validator fault");
                }),
                makeRestorationDialectContract("Memory", "nonboolean-memory-v1", (() => "yes") as never),
            ],
            [],
            [],
        );
        expect(
            rejected.getNative("Guidance", "throwing-guidance-v1")?.validateSameContent({
                canonical,
                canonicalFiles: [],
                representation: {
                    ...representation,
                    dialectId: "throwing-guidance-v1",
                },
                nativeFiles: [],
            }),
        ).toBe(false);
        expect(
            rejected.getNative("Guidance", "nonboolean-guidance-v1")?.validateSameContent({
                canonical,
                canonicalFiles: [],
                representation: {
                    ...representation,
                    dialectId: "nonboolean-guidance-v1",
                },
                nativeFiles: [],
            }),
        ).toBe(false);
        expect(rejected.getRestoration("Memory", "throwing-memory-v1")?.validatePayload(new Uint8Array())).toBe(false);
        expect(rejected.getRestoration("Memory", "nonboolean-memory-v1")?.validatePayload(new Uint8Array())).toBe(false);
    });

    it("rejects duplicate identities and unversioned or malformed contracts", () => {
        const native = makeNativeDialectContract("Guidance", "duplicate-v1");
        const restoration = makeRestorationDialectContract("Guidance", "duplicate-v1");
        expect(() => createVersionDialectRegistry([native, native], [], [], [])).toThrow(/duplicate native/);
        expect(() => createVersionDialectRegistry([], [restoration, restoration], [], [])).toThrow(/duplicate restoration/);

        for (const malformed of malformedContractSets()) {
            expect(() => assertAdapterDialectContracts(malformed)).toThrow();
        }
    });
});

function malformedContractSets(): AdapterDialectContractSetV1[] {
    const native = () => makeNativeDialectContract("Guidance", "fixture-guidance-v1");
    const restoration = () => makeRestorationDialectContract("Guidance", "fixture-restoration-v1");
    const cases: AdapterDialectContractSetV1[] = [];
    const set = (
        nativeContracts: AdapterNativeDialectContractV1[] = [],
        restorationContracts: AdapterRestorationDialectContractV1[] = [],
    ): AdapterDialectContractSetV1 => ({
        native: nativeContracts,
        restoration: restorationContracts,
        portableEntries: [],
        portableSelectors: [],
    });
    cases.push(null as unknown as AdapterDialectContractSetV1);
    cases.push({ ...set(), extra: true } as unknown as AdapterDialectContractSetV1);
    cases.push({ ...set(), native: null } as unknown as AdapterDialectContractSetV1);
    cases.push(set([null as unknown as AdapterNativeDialectContractV1]));
    cases.push(set([{ definition: native().definition }] as AdapterNativeDialectContractV1[]));
    cases.push(set([{ ...native(), extra: true } as unknown as AdapterNativeDialectContractV1]));
    cases.push(set([{ ...native(), validateSameContent: 1 as never }]));

    for (const mutate of [
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition = null as never;
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.kind = "Plugin" as never;
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.dialectId = "unversioned";
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.dialectId = " spaced-v1 ";
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.nativeFileGraphSchema = null as never;
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.contentNormalization.componentId = "";
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.nativeToCanonicalParser.componentVersion = 0;
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.canonicalConsistencyValidator.configFingerprint = "bad" as never;
        },
        (contract: AdapterNativeDialectContractV1) => {
            contract.definition.rebaseMaterializer = {
                componentId: "rebase",
                componentVersion: 1,
                configFingerprint: SHA,
                extra: true,
            } as never;
        },
        (contract: AdapterNativeDialectContractV1) => {
            (contract.definition as unknown as { extra: boolean }).extra = true;
        },
    ]) {
        const contract = native();
        mutate(contract);
        cases.push(set([contract]));
    }

    cases.push(set([], [null as unknown as AdapterRestorationDialectContractV1]));
    cases.push(
        set(
            [],
            [
                {
                    definition: restoration().definition,
                } as AdapterRestorationDialectContractV1,
            ],
        ),
    );
    cases.push(
        set(
            [],
            [
                {
                    ...restoration(),
                    extra: true,
                } as unknown as AdapterRestorationDialectContractV1,
            ],
        ),
    );
    cases.push(set([], [{ ...restoration(), validatePayload: 1 as never }]));
    for (const mutate of [
        (contract: AdapterRestorationDialectContractV1) => {
            contract.definition = null as never;
        },
        (contract: AdapterRestorationDialectContractV1) => {
            contract.definition.dialectId = "bad";
        },
        (contract: AdapterRestorationDialectContractV1) => {
            contract.definition.payloadCodecValidator = null as never;
        },
        (contract: AdapterRestorationDialectContractV1) => {
            contract.definition.transitionValidator.componentVersion = 1.5;
        },
        (contract: AdapterRestorationDialectContractV1) => {
            (contract.definition as unknown as { extra: boolean }).extra = true;
        },
    ]) {
        const contract = restoration();
        mutate(contract);
        cases.push(set([], [contract]));
    }
    return cases;
}
