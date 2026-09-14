import type { AdapterRenderAnalysisResult, RenderAnalysisInput } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    appendClaudeCodeBuildCompatibilityWarning,
    CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
    CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
    claudeCodeTargetBuildCompatibilityFor,
} from "../src/claudecode-target-build-compatibility";

const COMPLETE: AdapterRenderAnalysisResult = {
    status: "complete",
    outputUnits: [],
    semanticOptions: [],
    blockedSemanticRefs: [],
    diagnostics: [],
};
const CLI_ANCHOR = {
    agentRuntimeId: "CLAUDE_CODE_CLI",
    versionText: "2.1.220",
    buildIdentity: `sha256:${"1".repeat(64)}` as const,
    platform: "wsl" as const,
};

describe("Claude Code target-build compatibility", () => {
    it("owns independent CLI and App policies", () => {
        expect(claudeCodeTargetBuildCompatibilityFor("CLAUDE_CODE_CLI")).toBe(CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY);
        expect(claudeCodeTargetBuildCompatibilityFor("CLAUDE_CODE_APP")).toBe(CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY);
    });

    it("warns for a newer CLI build while leaving an exact build unchanged", () => {
        const declaration = {
            agentRuntimeId: "CLAUDE_CODE_CLI",
            buildCompatibility: CLAUDE_CODE_CLI_TARGET_BUILD_COMPATIBILITY,
            verifiedBuilds: [CLI_ANCHOR],
        };
        expect(
            appendClaudeCodeBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CLAUDE_CODE_CLI", "2.1.220", CLI_ANCHOR.buildIdentity, "wsl"),
                declaration,
            ),
        ).toBe(COMPLETE);
        expect(
            appendClaudeCodeBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CLAUDE_CODE_CLI", "2.1.221", `sha256:${"2".repeat(64)}`, "wsl"),
                declaration,
            ).diagnostics,
        ).toEqual([
            expect.objectContaining({
                code: "claudecode_target_build_compatibility_inferred",
                severity: "warning",
                message: expect.stringContaining("Claude Code CLI 2.1.221"),
            }),
        ]);
    });

    it("warns for an unverified App channel and ignores malformed or ambiguous contexts", () => {
        const declaration = {
            agentRuntimeId: "CLAUDE_CODE_APP",
            buildCompatibility: CLAUDE_CODE_APP_TARGET_BUILD_COMPATIBILITY,
            verifiedBuilds: [
                {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    versionText: "2.1.219",
                    buildIdentity: `sha256:${"3".repeat(64)}` as const,
                    platform: "win32" as const,
                },
            ],
        };
        const warned = appendClaudeCodeBuildCompatibilityWarning(
            COMPLETE,
            inputFor("CLAUDE_CODE_APP", "preview-channel", `sha256:${"4".repeat(64)}`, "win32"),
            declaration,
        );
        expect(warned.diagnostics[0]?.message).toContain("Claude Code App preview-channel");
        expect(
            appendClaudeCodeBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CLAUDE_CODE_APP", "2.1.220", "bad-hash", "win32"),
                declaration,
            ),
        ).toBe(COMPLETE);
        expect(
            appendClaudeCodeBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CLAUDE_CODE_APP", "2.1.220", `sha256:${"4".repeat(64)}`, "invalid"),
                declaration,
            ),
        ).toBe(COMPLETE);
        const duplicate = inputFor("CLAUDE_CODE_APP", "2.1.220", `sha256:${"4".repeat(64)}`, "win32");
        const [firstContext] = duplicate.deployment.targetContexts;
        if (firstContext === undefined) throw new Error("fixture target context missing");
        duplicate.deployment.targetContexts.push(structuredClone(firstContext));
        expect(appendClaudeCodeBuildCompatibilityWarning(COMPLETE, duplicate, declaration)).toBe(COMPLETE);
    });
});

function inputFor(agentRuntimeId: string, versionText: string, buildIdentity: string, platform: string): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: {
            assets: [],
            targetContexts: [
                {
                    agentRuntimeId,
                    versionText,
                    buildIdentity,
                    renderFacts: [{ key: "oaam.platform", value: platform, evidenceLevel: "agent_runtime_verified" }],
                },
            ],
        },
        requiredSemantics: [],
        dialectInputs: [],
    } as unknown as RenderAnalysisInput;
}
