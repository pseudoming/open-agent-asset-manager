import { describe, expect, it } from "vitest";
import {
    jsoncDiffIsOneTopLevelPropertyValue,
    readJsoncTopLevelPropertyValue,
    replaceJsoncTopLevelPropertyValue,
} from "../../src/foundation/jsonc-top-level-property";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("bounded top-level JSONC property mechanics", () => {
    it("extracts and byte-preservingly replaces one commented trailing-comma value", () => {
        const source = encode(
            [
                "\ufeff{",
                '  "secret": "keep ,} and // text",',
                "  // preserve this line",
                '  "instructions": ["docs/a.md", /* ordered */ "docs/b.md",],',
                '  "nested": { "value": true, },',
                "}",
            ].join("\r\n"),
        );
        const fragment = readJsoncTopLevelPropertyValue(source, "instructions");
        expect(decode(fragment?.valueBytes ?? new Uint8Array())).toBe('["docs/a.md", /* ordered */ "docs/b.md",]');
        const replacement = encode('["docs/next.md"]');
        const output = replaceJsoncTopLevelPropertyValue(source, "instructions", replacement);
        expect(decode(output)).toBe(decode(source).replace('["docs/a.md", /* ordered */ "docs/b.md",]', '["docs/next.md"]'));
        expect(decode(readJsoncTopLevelPropertyValue(output, "instructions")?.valueBytes ?? new Uint8Array())).toBe(
            '["docs/next.md"]',
        );
    });

    it("creates a new bounded object only when the container is absent", () => {
        expect(decode(replaceJsoncTopLevelPropertyValue(null, "instructions", encode('["RULE.md"]')))).toBe(
            '{\n  "instructions": ["RULE.md"]\n}\n',
        );
        expect(() => replaceJsoncTopLevelPropertyValue(encode("{}"), "instructions", encode("[]"))).toThrow(
            "top-level JSONC property is missing",
        );
        expect(readJsoncTopLevelPropertyValue(encode("{}"), "instructions")).toBeNull();
        expect(() =>
            replaceJsoncTopLevelPropertyValue(
                encode('{"instructions":[],"instructions":["other.md"]}'),
                "instructions",
                encode("[]"),
            ),
        ).toThrow("duplicate top-level JSONC property");
    });

    it("accepts only a change to the selected value and returns both raw fragments", () => {
        const applied = encode('{"instructions":["a.md"],"other":{"x":1}}');
        const current = encode('{"instructions":["b.md"],"other":{"x":1}}');
        expect(jsoncDiffIsOneTopLevelPropertyValue(applied, current, "instructions")).toEqual({
            appliedValueBytes: encode('["a.md"]'),
            currentValueBytes: encode('["b.md"]'),
        });
        expect(
            jsoncDiffIsOneTopLevelPropertyValue(applied, encode('{"instructions":["b.md"],"other":{"x":2}}'), "instructions"),
        ).toBeNull();
        expect(jsoncDiffIsOneTopLevelPropertyValue(encode("{}"), current, "instructions")).toBeNull();
        expect(jsoncDiffIsOneTopLevelPropertyValue(encode("{"), current, "instructions")).toBeNull();
    });

    it.each([
        ["duplicate", '{"instructions":[],"instructions":[]}'],
        ["trailing data", '{"instructions":[]} false'],
        ["empty root trailing data", "{} false"],
        ["trailing-comma root trailing data", '{"instructions":[],} false'],
        ["root array", "[]"],
        ["unterminated comment", '{/* no end "instructions":[]}'],
        ["unterminated object", '{"instructions":[]'],
        ["unterminated nested value", '{"instructions":['],
        ["value absent at eof", '{"instructions":'],
        ["mismatched value", '{"instructions":[}'],
        ["mismatched nested value", '{"instructions":{"nested":[]}'],
        ["invalid string", '{"instructions":"\\q"}'],
        ["unterminated string", '{"instructions":"never'],
        ["unquoted key", "{instructions:[]}"],
        ["missing colon", '{"instructions" []}'],
        ["missing separator", '{"instructions":[] "other":1}'],
        ["missing value", '{"instructions":}'],
    ])("rejects %s JSONC", (_name, source) => {
        expect(() => readJsoncTopLevelPropertyValue(encode(source), "instructions")).toThrow();
    });

    it("rejects invalid property names, replacement values, and UTF-8", () => {
        for (const propertyName of ["", " instructions", "instructions ", "instructions\0"]) {
            expect(() => readJsoncTopLevelPropertyValue(encode("{}"), propertyName)).toThrow();
        }
        expect(() =>
            replaceJsoncTopLevelPropertyValue(encode('{"instructions":[]}'), "instructions", encode("undefined")),
        ).toThrow();
        expect(() => readJsoncTopLevelPropertyValue(Uint8Array.of(0xff), "instructions")).toThrow();
        expect(() =>
            readJsoncTopLevelPropertyValue(encode(`{"instr${String.fromCharCode(1)}uctions":[]}`), "instructions"),
        ).toThrow();
    });

    it("parses primitive values, escaped strings, nested containers, and terminal comments", () => {
        expect(readJsoncTopLevelPropertyValue(encode("\ufeff{}"), "instructions")).toBeNull();
        for (const [source, expected] of [
            ['{"instructions":true}', "true"],
            ['{"instructions":null}', "null"],
            ['{"instructions":-12.5e2}', "-12.5e2"],
            ['{"instructions":"escaped \\" value"}', '"escaped \\" value"'],
            ['{"instructions":{"nested":[1,{"ok":false}]}}', '{"nested":[1,{"ok":false}]}'],
            ['{"instructions":[]}// terminal comment', "[]"],
        ] as const) {
            expect(decode(readJsoncTopLevelPropertyValue(encode(source), "instructions")?.valueBytes ?? new Uint8Array())).toBe(
                expected,
            );
        }
        expect(
            decode(
                replaceJsoncTopLevelPropertyValue(
                    encode('{"instructions":["comma, brace } and slash //",],/* keep */}'),
                    "instructions",
                    encode('["next"]'),
                ),
            ),
        ).toBe('{"instructions":["next"],/* keep */}');
    });
});
