import { describe, expect, it } from "vitest";
import {
    ProtocolValidationError,
    optionalProtocolField,
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolJsonValue,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolSha256Schema,
    protocolString,
    protocolUnion,
    protocolUuidV4Schema,
} from "../src";
import { SHA_A, UUID_A } from "./fixtures/protocol-fixtures";

describe("strict Protocol schema primitives", () => {
    it("validates strings, booleans, integers, literals and enums", () => {
        expect(protocolString.parse("value")).toBe("value");
        expect(() => protocolString.parse(1)).toThrow(/expected string/u);
        expect(protocolNonBlankString.parse("value")).toBe("value");
        for (const invalid of ["", " value", "value "]) {
            expect(() => protocolNonBlankString.parse(invalid), JSON.stringify(invalid)).toThrow(/non-blank/u);
        }
        expect(protocolBoolean.parse(true)).toBe(true);
        expect(() => protocolBoolean.parse("true")).toThrow(/boolean/u);
        expect(protocolNonNegativeInteger.parse(0)).toBe(0);
        for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
            expect(() => protocolNonNegativeInteger.parse(invalid), String(invalid)).toThrow(/non-negative/u);
        }
        expect(protocolPositiveInteger.parse(1)).toBe(1);
        expect(() => protocolPositiveInteger.parse(0)).toThrow(/positive/u);
        expect(protocolLiteral("x").parse("x")).toBe("x");
        expect(() => protocolLiteral("x").parse("y")).toThrow(/expected "x"/u);
        const enumSchema = protocolEnum(["a", "b"] as const);
        expect(enumSchema.parse("b")).toBe("b");
        expect(() => enumSchema.parse("c")).toThrow(/expected one of/u);
    });

    it("validates arrays, non-empty arrays and strict optional object fields", () => {
        expect(protocolArray(protocolString).parse(["a", "b"])).toEqual(["a", "b"]);
        expect(() => protocolArray(protocolString).parse("a")).toThrow(/expected array/u);
        expect(() => protocolArray(protocolString).parse(["a", 1])).toThrow(/\$\[1\]/u);
        expect(protocolNonEmptyArray(protocolString).parse(["a"])).toEqual(["a"]);
        expect(() => protocolNonEmptyArray(protocolString).parse([])).toThrow(/non-empty/u);

        const objectSchema = protocolObject({
            required: protocolString,
            optional: optionalProtocolField(protocolBoolean),
        });
        expect(objectSchema.parse({ required: "value" })).toEqual({ required: "value" });
        expect(objectSchema.parse({ required: "value", optional: false })).toEqual({
            required: "value",
            optional: false,
        });
        expect(() => objectSchema.parse(null)).toThrow(/expected object/u);
        expect(() => objectSchema.parse({ required: "value", extra: true })).toThrow(/unknown field/u);
        expect(() => objectSchema.parse({})).toThrow(/missing required/u);
        const invalidShape = protocolObject({ broken: undefined as never });
        expect(() => invalidShape.parse({ broken: "x" })).toThrow(/schema is missing field/u);
    });

    it("selects one strict union branch and preserves unexpected validator errors", () => {
        const union = protocolUnion([
            protocolObject({ kind: protocolLiteral("a") }),
            protocolObject({ kind: protocolLiteral("b"), value: protocolString }),
        ]);
        expect(union.parse({ kind: "a" })).toEqual({ kind: "a" });
        expect(union.parse({ kind: "b", value: "x" })).toEqual({ kind: "b", value: "x" });
        expect(() => union.parse({ kind: "c" })).toThrow(/did not match any branch/u);

        const unexpected = protocolUnion([
            Object.freeze({
                description: "unexpected",
                parse(): never {
                    throw new Error("unexpected");
                },
            }),
        ]);
        expect(() => unexpected.parse("x")).toThrow("unexpected");
    });

    it("accepts only lossless finite JSON values", () => {
        for (const value of [null, true, "text", 1]) expect(protocolJsonValue.parse(value)).toEqual(value);
        expect(protocolJsonValue.parse([1, "x", null])).toEqual([1, "x", null]);
        expect(protocolJsonValue.parse({ nested: [false] })).toEqual({ nested: [false] });
        for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n]) {
            expect(() => protocolJsonValue.parse(invalid), String(invalid)).toThrow(/JSON|finite/u);
        }
    });

    it("validates lowercase UUID v4 and sha256 identities without a permissive regex", () => {
        expect(protocolUuidV4Schema.parse(UUID_A)).toBe(UUID_A);
        for (const invalid of [
            1,
            "",
            "00000000",
            "00000000-0000-4000-8000",
            "00000000-0000-3000-8000-000000000001",
            "00000000-0000-4000-7000-000000000001",
            "00000000-0000-4000-8000-00000000000G",
            "000000000000-4000-8000-000000000001",
            "00000000-000000-4000-8000-000000000001",
            "00000000-0000-400000-8000-000000000001",
            "00000000-0000-4000-800000-000000000001",
            "00000000-0000-4000-8000-00000000000100",
        ]) {
            expect(() => protocolUuidV4Schema.parse(invalid), String(invalid)).toThrow();
        }
        expect(protocolSha256Schema.parse(SHA_A)).toBe(SHA_A);
        expect(() => protocolSha256Schema.parse("a".repeat(63))).toThrow(/sha256/u);
        expect(() => protocolSha256Schema.parse(`${"a".repeat(63)}G`)).toThrow(/sha256/u);
    });

    it("preserves the first validation path on errors", () => {
        const error = new ProtocolValidationError("$.field", "bad value");
        expect(error.name).toBe("ProtocolValidationError");
        expect(error.path).toBe("$.field");
        expect(error.message).toBe("$.field: bad value");
    });
});
