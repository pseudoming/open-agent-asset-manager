import { describe, expect, it } from "vitest";
import { parseZcodeScriptWorkflowMeta } from "../src/zcode-source-read-javascript";

describe("ZCode script Workflow metadata parser", () => {
    it("accepts only a static leading meta literal without executing the source", () => {
        expect(
            parseZcodeScriptWorkflowMeta(
                "\ufeff  export const meta = {\n" +
                    '  "name": "release\\nflow",\n' +
                    "  description: 'Release\\tflow',\n" +
                    '  whenToUse: "during release",\n' +
                    '  phases: [{ title: "plan", detail: "inspect", model: "fast", }, { title: "ship" }],\n' +
                    "  // the executable body is deliberately not parsed\n" +
                    "}; await dangerousButNeverExecuted();",
            ),
        ).toEqual({ name: "release\nflow", description: "Release\tflow", issues: [] });
    });

    it("rejects dynamic declarations and malformed literal framing", () => {
        const invalid = [
            ["const meta = {};", "script must begin"],
            ["export const meta {}", "requires ="],
            ["export const meta = factory();", "pure object literal"],
            ["export const meta = [];", "pure object literal"],
            ["export const meta = /* never closes", "pure object literal"],
            ['export const meta = { name: "x", name: "y", description: "z" };', "pure object literal"],
            ['export const meta = { __proto__: { polluted: true }, name: "x", description: "z" };', "pure object literal"],
            ['export const meta = { constructor: null, name: "x", description: "z" };', "pure object literal"],
            ['export const meta = { name "x", description: "z" };', "pure object literal"],
            ['export const meta = { name: "x" description: "z" };', "pure object literal"],
            ['export const meta = { name: "bad\\u1234", description: "z" };', "pure object literal"],
            ['export const meta = { name: -., description: "z" };', "pure object literal"],
        ] as const;
        for (const [source, message] of invalid) {
            expect(parseZcodeScriptWorkflowMeta(source).issues[0], source).toContain(message);
        }
    });

    it("reports every unsupported meta and phase semantic without hiding valid identity", () => {
        expect(
            parseZcodeScriptWorkflowMeta(
                "export const meta = {" +
                    ' name: "demo", description: "Demo", whenToUse: false, unknown: null,' +
                    ' phases: [{ title: "same" }, { title: "same", detail: 7, model: false, extra: true }, null]' +
                    "};",
            ),
        ).toEqual({
            name: "demo",
            description: "Demo",
            issues: [
                "unknown meta fields: unknown",
                "meta.whenToUse must be a non-empty static string",
                "meta.phases[1] has unknown fields: extra",
                "meta.phases has duplicate title: same",
                "meta.phases[1].detail must be a non-empty static string",
                "meta.phases[1].model must be a non-empty static string",
                "meta.phases[2] must be an object literal",
            ],
        });
    });

    it("reports missing identity and invalid phase containers", () => {
        expect(parseZcodeScriptWorkflowMeta("export const meta = { phases: true };").issues).toEqual([
            "meta.name must be a non-empty static string",
            "meta.description must be a non-empty static string",
            "meta.phases must be a pure array literal",
        ]);
        expect(parseZcodeScriptWorkflowMeta('export const meta = { name: " ", description: "" };').issues).toEqual([
            "meta.name must be a non-empty static string",
            "meta.description must be a non-empty static string",
        ]);
        expect(
            parseZcodeScriptWorkflowMeta('export const meta = { name: "demo", description: "Demo", phases: [{ detail: "x" }] };')
                .issues,
        ).toEqual(["meta.phases[0].title must be a non-empty static string"]);
    });

    it("accepts pure scalar/array/object syntax while rejecting identifiers and unterminated strings", () => {
        expect(
            parseZcodeScriptWorkflowMeta(
                'export const meta = { name: "demo", description: "Demo", phases: [], whenToUse: "manual" };',
            ).issues,
        ).toEqual([]);
        for (const source of [
            'export const meta = { name: identifier, description: "Demo" };',
            'export const meta = { name: "unterminated, description: "Demo" };',
            'export const meta = { name: "demo", description: "Demo", phases: [true] };',
        ]) {
            expect(parseZcodeScriptWorkflowMeta(source).issues.length, source).toBeGreaterThan(0);
        }
    });
});
