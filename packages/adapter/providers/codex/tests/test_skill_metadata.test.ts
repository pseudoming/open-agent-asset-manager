import { describe, expect, it } from "vitest";
import { parseCodexSkillMetadata } from "../src/codex-skill-metadata";

describe("Codex Skill agents/openai.yaml", () => {
    it("maps the exact invocation policy while accepting inert interface metadata", () => {
        expect(
            parseCodexSkillMetadata(
                `interface:\n  display_name: Demo\n  short_description: Short\n  icon_small: ./assets/icon.svg\n  icon_large: ./assets/icon.png\n  brand_color: "#000000"\npolicy:\n  allow_implicit_invocation: false\n`,
            ),
        ).toEqual({ allowImplicitInvocation: false, diagnostics: [], nativeOnlyDiagnostics: [] });
        expect(parseCodexSkillMetadata("interface:\n  display_name: Demo\n")).toEqual({
            allowImplicitInvocation: true,
            diagnostics: [],
            nativeOnlyDiagnostics: [],
        });
        expect(parseCodexSkillMetadata("dependencies: {}\npolicy: {}\n")).toEqual({
            allowImplicitInvocation: true,
            diagnostics: [],
            nativeOnlyDiagnostics: [],
        });
        expect(parseCodexSkillMetadata("dependencies: []\n")).toEqual({
            allowImplicitInvocation: true,
            diagnostics: [],
            nativeOnlyDiagnostics: [],
        });
        expect(
            parseCodexSkillMetadata(
                "interface:\n  default_prompt: Use this context\ndependencies:\n  tools:\n    - type: mcp\n      value: docs\n",
            ),
        ).toEqual({
            allowImplicitInvocation: true,
            diagnostics: [],
            nativeOnlyDiagnostics: [
                "agents/openai.yaml interface default_prompt is preserved as Codex-native Skill state",
                "agents/openai.yaml dependencies are preserved as Codex-native Skill state",
            ],
        });
    });

    it("rejects unsupported behavior, unknown keys, type errors, aliases, and malformed YAML", () => {
        const cases = [
            "future_behavior: true\n",
            "interface: display\n",
            "interface:\n  future: value\n",
            "interface:\n  display_name: 7\n",
            "policy: false\n",
            "policy:\n  future: true\n",
            "policy:\n  allow_implicit_invocation: no\n",
            "name: first\nname: second\n",
            "value: &shared [one]\ncopy: *shared\n",
            "- not\n- a\n- mapping\n",
            "policy: [\n",
        ];
        for (const source of cases) {
            expect(parseCodexSkillMetadata(source).diagnostics.length, source).toBeGreaterThan(0);
        }
    });
});
