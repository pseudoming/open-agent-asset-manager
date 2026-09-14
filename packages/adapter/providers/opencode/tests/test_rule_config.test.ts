import type { RenderNativeRepresentationFileInput, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    canonicalRuleLogicalPath,
    opencodeRuleGraph,
    parseOpencodeInstructionFragment,
    readOpencodeInstructionFragment,
} from "../src/opencode-rule-config";

const HASH = `sha256:${"0".repeat(64)}` as Sha256Digest;

describe("OpenCode instructions Rule bounded config projection", () => {
    it("distinguishes absent, malformed, empty, and non-string instruction values", () => {
        expect(readOpencodeInstructionFragment(new TextEncoder().encode('{"theme":"warm"}'))).toMatchObject({
            status: "absent",
            reasonCode: "opencode.rule_instructions_absent",
        });
        expect(parseOpencodeInstructionFragment(Uint8Array.of(0xff))).toMatchObject({
            status: "invalid",
            reasonCode: "opencode.rule_instructions_invalid",
        });
        expect(parseOpencodeInstructionFragment(new TextEncoder().encode("[]"))).toMatchObject({
            status: "invalid",
            reasonCode: "opencode.rule_instructions_shape_invalid",
        });
        expect(parseOpencodeInstructionFragment(new TextEncoder().encode("[1]"))).toMatchObject({
            status: "invalid",
            reasonCode: "opencode.rule_instruction_path_invalid",
        });
    });

    it("rejects an invalid canonical index and every incomplete native graph shape", () => {
        expect(() => canonicalRuleLogicalPath(-1)).toThrow("non-negative");
        const fragment = binary("opencode.jsonc", '["docs/rule.md"]');
        const rule = text("docs/rule.md", "Rule body.\n");
        expect(opencodeRuleGraph([rule])).toBeNull();
        expect(opencodeRuleGraph([{ ...fragment, executable: true }, rule])).toBeNull();
        expect(opencodeRuleGraph([fragment, rule, { ...rule }])).toBeNull();
        expect(opencodeRuleGraph([fragment, { ...rule, text: "" }])).toBeNull();
        expect(opencodeRuleGraph([fragment, rule])).toMatchObject({
            graphIdentityRelativePath: "opencode.jsonc",
            files: [
                { nativeRelativePath: "docs/rule.md", canonicalLogicalPath: "RULE.md" },
                {
                    nativeRelativePath: "opencode.jsonc",
                    canonicalLogicalPath: "resources/opencode-instructions.fragment.jsonc",
                },
            ],
        });
    });
});

function text(relativePath: string, value: string): RenderNativeRepresentationFileInput {
    return {
        relativePath,
        contentKind: "text",
        mediaType: "text/markdown",
        contentHash: HASH,
        byteSize: Buffer.byteLength(value),
        executable: false,
        text: value,
    } as RenderNativeRepresentationFileInput;
}

function binary(relativePath: string, value: string): RenderNativeRepresentationFileInput {
    const bytes = new TextEncoder().encode(value);
    return {
        relativePath,
        contentKind: "binary",
        mediaType: "application/jsonc",
        contentHash: HASH,
        byteSize: bytes.byteLength,
        executable: false,
        bytes,
    } as RenderNativeRepresentationFileInput;
}
