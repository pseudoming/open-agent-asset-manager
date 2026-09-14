import { describe, expect, it } from "vitest";
import { compareCodeUnitText, compareUtf8Bytes } from "../../src/foundation/text-order";

describe("deterministic text ordering authorities", () => {
    it("keeps UTF-8 byte order distinct from JavaScript code-unit order", () => {
        const supplementary = "😀";
        const privateUse = "\uE000";

        expect(compareCodeUnitText(supplementary, privateUse)).toBeLessThan(0);
        expect(compareUtf8Bytes(supplementary, privateUse)).toBeGreaterThan(0);
    });

    it("returns negative, zero, and positive results for UTF-8 byte order", () => {
        expect(compareUtf8Bytes("a", "b")).toBeLessThan(0);
        expect(compareUtf8Bytes("same", "same")).toBe(0);
        expect(compareUtf8Bytes("b", "a")).toBeGreaterThan(0);
    });

    it("returns negative, zero, and positive results for code-unit order", () => {
        expect(compareCodeUnitText("a", "b")).toBe(-1);
        expect(compareCodeUnitText("same", "same")).toBe(0);
        expect(compareCodeUnitText("b", "a")).toBe(1);
    });
});
