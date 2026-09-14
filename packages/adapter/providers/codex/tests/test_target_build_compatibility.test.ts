import type { AdapterRenderAnalysisResult, RenderAnalysisInput } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    appendCodexBuildCompatibilityWarning,
    CODEX_APP_TARGET_BUILD_COMPATIBILITY,
    CODEX_CLI_TARGET_BUILD_COMPATIBILITY,
    codexTargetBuildCompatibilityFor,
} from "../src/codex-target-build-compatibility";

const COMPLETE: AdapterRenderAnalysisResult = {
    status: "complete",
    outputUnits: [],
    semanticOptions: [],
    blockedSemanticRefs: [],
    diagnostics: [],
};
const CLI_ANCHOR = {
    agentRuntimeId: "CODEX_CLI",
    versionText: "0.142.5",
    buildIdentity: `sha256:${"1".repeat(64)}` as const,
    platform: "wsl" as const,
};

describe("Codex target-build compatibility", () => {
    it("owns independent CLI and App policies", () => {
        expect(codexTargetBuildCompatibilityFor("CODEX_CLI")).toBe(CODEX_CLI_TARGET_BUILD_COMPATIBILITY);
        expect(codexTargetBuildCompatibilityFor("CODEX_APP")).toBe(CODEX_APP_TARGET_BUILD_COMPATIBILITY);
    });

    it("warns for a newer CLI build while leaving an exact build unchanged", () => {
        const declaration = {
            agentRuntimeId: "CODEX_CLI",
            buildCompatibility: CODEX_CLI_TARGET_BUILD_COMPATIBILITY,
            verifiedBuilds: [CLI_ANCHOR],
        };
        expect(
            appendCodexBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CODEX_CLI", "0.142.5", CLI_ANCHOR.buildIdentity, "wsl"),
                declaration,
            ),
        ).toBe(COMPLETE);
        expect(
            appendCodexBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CODEX_CLI", "0.143.0", `sha256:${"2".repeat(64)}`, "wsl"),
                declaration,
            ).diagnostics,
        ).toEqual([
            expect.objectContaining({
                code: "codex_target_build_compatibility_inferred",
                severity: "warning",
                message: expect.stringContaining("Codex CLI 0.143.0"),
            }),
        ]);
    });

    it("warns for an unverified App channel and ignores malformed or ambiguous contexts", () => {
        const declaration = {
            agentRuntimeId: "CODEX_APP",
            buildCompatibility: CODEX_APP_TARGET_BUILD_COMPATIBILITY,
            verifiedBuilds: [
                {
                    agentRuntimeId: "CODEX_APP",
                    versionText: "0.147.0-alpha.1.2",
                    buildIdentity: `sha256:${"3".repeat(64)}` as const,
                    platform: "win32" as const,
                },
            ],
        };
        const warned = appendCodexBuildCompatibilityWarning(
            COMPLETE,
            inputFor("CODEX_APP", "preview-channel", `sha256:${"4".repeat(64)}`, "win32"),
            declaration,
        );
        expect(warned.diagnostics[0]?.message).toContain("Codex App preview-channel");
        expect(
            appendCodexBuildCompatibilityWarning(COMPLETE, inputFor("CODEX_APP", "0.148.0", "bad-hash", "win32"), declaration),
        ).toBe(COMPLETE);
        expect(
            appendCodexBuildCompatibilityWarning(
                COMPLETE,
                inputFor("CODEX_APP", "0.148.0", `sha256:${"4".repeat(64)}`, "invalid"),
                declaration,
            ),
        ).toBe(COMPLETE);
        const duplicate = inputFor("CODEX_APP", "0.148.0", `sha256:${"4".repeat(64)}`, "win32");
        const [firstContext] = duplicate.deployment.targetContexts;
        if (firstContext === undefined) throw new Error("fixture target context missing");
        duplicate.deployment.targetContexts.push(structuredClone(firstContext));
        expect(appendCodexBuildCompatibilityWarning(COMPLETE, duplicate, declaration)).toBe(COMPLETE);
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
