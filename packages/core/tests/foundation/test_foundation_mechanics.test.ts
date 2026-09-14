import { describe, expect, it } from "vitest";
import { completeResult } from "../../src/foundation/core-result";
import { deepFreezeChildrenFirst, deepFreezeParentFirst } from "../../src/foundation/deep-freeze";
import {
    schemaArrayWithOptions,
    schemaArrayWithUniqueKey,
    schemaLiteral,
    schemaObject,
    schemaStringEnum,
    schemaUnion,
    validateStrict,
    type StrictSchema,
} from "../../src/foundation/strict-schema";

describe("Core foundation mechanics", () => {
    it("constructs the exact complete CoreResult envelope", () => {
        const value = { id: "value" };
        const result = completeResult(value);
        expect(result).toEqual({
            status: "complete",
            value,
            diagnostics: [],
        });
        expect(result.value).toBe(value);
    });

    it("keeps parent-first and children-first freeze traversal observably distinct", () => {
        const parentFirst = observedParentState(deepFreezeParentFirst);
        const childrenFirst = observedParentState(deepFreezeChildrenFirst);

        expect(parentFirst.observedFrozenState).toBe(true);
        expect(childrenFirst.observedFrozenState).toBe(false);
        expect(Object.isFrozen(parentFirst.parent)).toBe(true);
        expect(Object.isFrozen(parentFirst.child)).toBe(true);
        expect(Object.isFrozen(childrenFirst.parent)).toBe(true);
        expect(Object.isFrozen(childrenFirst.child)).toBe(true);
    });

    it("preserves parent-first cycle termination and both no-op input branches", () => {
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        expect(deepFreezeParentFirst(cyclic)).toBe(cyclic);
        expect(Object.isFrozen(cyclic)).toBe(true);
        expect(deepFreezeParentFirst(null)).toBeNull();
        expect(deepFreezeParentFirst("text")).toBe("text");
        const parentFrozen = Object.freeze({ value: 1 });
        expect(deepFreezeParentFirst(parentFrozen)).toBe(parentFrozen);

        expect(deepFreezeChildrenFirst(null)).toBeNull();
        expect(deepFreezeChildrenFirst("text")).toBe("text");
        const childrenFrozen = Object.freeze({ value: 1 });
        expect(deepFreezeChildrenFirst(childrenFrozen)).toBe(childrenFrozen);
    });

    it("builds strict schema nodes without erasing the two array construction shapes", () => {
        const text: StrictSchema = { kind: "string", nonBlank: true };
        const optionsArray = schemaArrayWithOptions(text, { minLength: 1 });
        const uniqueKeyArray = schemaArrayWithUniqueKey(text);
        const schema = schemaObject({
            schemaVersion: schemaLiteral(1),
            mode: schemaStringEnum("one", "two"),
            values: optionsArray,
            optionalShape: schemaUnion(schemaLiteral("none"), uniqueKeyArray),
        });

        expect(
            validateStrict(schema, {
                schemaVersion: 1,
                mode: "two",
                values: ["value"],
                optionalShape: "none",
            }),
        ).toBe(true);
        expect(
            validateStrict(schema, {
                schemaVersion: 1,
                mode: "three",
                values: [],
                optionalShape: "none",
            }),
        ).toBe(false);
        expect(Object.hasOwn(optionsArray, "uniqueBy")).toBe(false);
        expect(Object.hasOwn(uniqueKeyArray, "uniqueBy")).toBe(true);
        expect(uniqueKeyArray).toHaveProperty("uniqueBy", undefined);
    });
});

function observedParentState(freeze: <T>(value: T) => T): {
    parent: Record<string, unknown>;
    child: Record<string, unknown>;
    observedFrozenState: boolean;
} {
    const child: Record<string, unknown> = {};
    const parent: Record<string, unknown> = {};
    let observedFrozenState = false;
    Object.defineProperty(parent, "child", {
        enumerable: true,
        get: () => {
            observedFrozenState = Object.isFrozen(parent);
            return child;
        },
    });
    freeze(parent);
    return { parent, child, observedFrozenState };
}
