import { describe, expect, it } from "vitest";
import { defineAssetReaderRegistry, sourceReader, sourceUnavailable, type AssetReaderDisposition } from "../src";
import type { AssetKind } from "@oaam/core";

type Builder = () => string;

const builder: Builder = () => "candidate";

function completeRegistry(): Record<AssetKind, AssetReaderDisposition<Builder>> {
    return {
        Guidance: sourceReader(builder),
        Rule: sourceUnavailable("deferred", "test.rule.deferred", "Rule is deferred"),
        Workflow: sourceReader(builder),
        Skill: sourceReader(builder),
        Subagent: sourceReader(builder),
        Memory: sourceUnavailable("unsupported", "test.memory.unsupported", "Memory is unsupported"),
    };
}

describe("adapter-framework exhaustive source-reader registry", () => {
    it("freezes one explicit answer for every AssetKind without changing the reader", () => {
        const registry = defineAssetReaderRegistry(completeRegistry());

        expect(Object.keys(registry).sort()).toEqual(["Guidance", "Memory", "Rule", "Skill", "Subagent", "Workflow"]);
        expect(Object.isFrozen(registry)).toBe(true);
        expect(Object.values(registry).every(Object.isFrozen)).toBe(true);
        const guidance = registry.Guidance;
        expect(guidance.disposition).toBe("reader");
        if (guidance.disposition !== "reader") throw new Error("fixture reader missing");
        expect(guidance.buildCandidates).toBe(builder);
        expect(guidance.buildCandidates()).toBe("candidate");
        expect(registry.Rule).toEqual({
            disposition: "deferred",
            diagnosticCode: "test.rule.deferred",
            message: "Rule is deferred",
        });
    });

    it("rejects a non-callable reader before registry construction", () => {
        expect(() => sourceReader("not-callable" as never)).toThrow("source reader must be a callable candidate builder");
    });

    it.each([
        ["blank code", "", "message"],
        ["non-string code", 7, "message"],
        ["blank message", "test.code", " "],
        ["non-string message", "test.code", null],
    ])("rejects unavailable rows with %s", (_name, code, message) => {
        expect(() => sourceUnavailable("unsupported", code as string, message as string)).toThrow(
            "unavailable source disposition requires diagnosticCode and message",
        );
    });

    it.each([
        ["null", null],
        ["array", []],
    ])("rejects a %s registry container", (_name, value) => {
        expect(() => defineAssetReaderRegistry(value as never)).toThrow("asset reader registry must be an object");
    });

    it("rejects missing and foreign AssetKind keys", () => {
        const missing = completeRegistry() as Record<string, unknown>;
        delete missing.Memory;
        expect(() => defineAssetReaderRegistry(missing as never)).toThrow(
            "asset reader registry must answer every AssetKind exactly once",
        );

        const foreign = { ...completeRegistry(), Foreign: sourceReader(builder) };
        expect(() => defineAssetReaderRegistry(foreign as never)).toThrow(
            "asset reader registry must answer every AssetKind exactly once",
        );
    });

    it.each([
        ["non-record row", null, "asset reader disposition is invalid: Guidance"],
        ["non-callable reader", { disposition: "reader", buildCandidates: "no" }, "asset reader is not callable: Guidance"],
        [
            "blank unavailable code",
            { disposition: "deferred", diagnosticCode: "", message: "message" },
            "asset reader unavailable disposition is incomplete: Guidance",
        ],
        [
            "blank unavailable message",
            { disposition: "unsupported", diagnosticCode: "test.code", message: "" },
            "asset reader unavailable disposition is incomplete: Guidance",
        ],
        [
            "unknown disposition",
            { disposition: "empty", diagnosticCode: "test.code", message: "message" },
            "asset reader disposition is unknown: Guidance",
        ],
    ])("rejects a %s injected after helper validation", (_name, row, error) => {
        const input = completeRegistry() as Record<string, unknown>;
        input.Guidance = row;
        expect(() => defineAssetReaderRegistry(input as never)).toThrow(error);
    });
});
