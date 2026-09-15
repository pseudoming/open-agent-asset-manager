import type { Platform } from "@oaam/core";
import { resolveTargetBuildCompatibility } from "@oaam/core/adapter-spi";
import { describe, expect, it } from "vitest";
import { claudecodeProvider } from "../src/claudecode-provider";
import {
    createClaudeCodeAppSkillGraphTargetSupport,
    createClaudeCodeGlobalSkillGraphTargetSupport,
    createClaudeCodeSkillGraphTargetSupport,
} from "../src/claudecode-target-exact-graph";

const CLI_BUILD = {
    agentRuntimeId: "CLAUDE_CODE_CLI",
    versionText: "2.1.220",
    buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863" as const,
};
const common = {
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
};
const project = createClaudeCodeSkillGraphTargetSupport({
    ...common,
    targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
}).renderContractDeclaration;
const global = createClaudeCodeGlobalSkillGraphTargetSupport({
    ...common,
    targetContextSchemaId: "CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1",
}).renderContractDeclaration;
const app = createClaudeCodeAppSkillGraphTargetSupport({
    ...common,
    targetContextSchemaId: "CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1",
}).renderContractDeclaration;

function resolveProject(platform: Platform, versionText = CLI_BUILD.versionText) {
    return resolveTargetBuildCompatibility({
        anchors: project.verifiedBuilds,
        policy: project.buildCompatibility,
        current: { ...CLI_BUILD, platform, versionText },
    });
}

describe("Claude CLI Linux project Skill target boundary", () => {
    it("selects independent Linux and retained WSL evidence for the same exact executable", () => {
        const linux = resolveProject("linux");
        const wsl = resolveProject("wsl");
        expect(linux).toMatchObject({ status: "exact", reason: "exact_verified_build", anchor: { platform: "linux" } });
        expect(wsl).toMatchObject({ status: "exact", reason: "exact_verified_build", anchor: { platform: "wsl" } });
        if (linux.status !== "exact" || wsl.status !== "exact") throw new Error("exact project Skill anchors missing");
        expect(linux.anchor.fixtureSetFingerprint).not.toBe(wsl.anchor.fixtureSetFingerprint);
        expect(linux.anchor.buildIdentity).toBe(wsl.anchor.buildIdentity);
    });

    it("does not lend the project Linux anchor to user-global Skills or the App entry", () => {
        expect(
            resolveTargetBuildCompatibility({
                anchors: global.verifiedBuilds,
                policy: global.buildCompatibility,
                current: { ...CLI_BUILD, platform: "linux" },
            }),
        ).toEqual({ status: "blocked", reason: "no_platform_anchor" });
        expect(
            resolveTargetBuildCompatibility({
                anchors: app.verifiedBuilds,
                policy: app.buildCompatibility,
                current: {
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    versionText: "2.1.219",
                    buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
                    platform: "linux",
                },
            }),
        ).toEqual({ status: "blocked", reason: "no_platform_anchor" });
    });

    it("keeps other platforms and versions below the Linux evidence floor blocked", () => {
        expect(resolveProject("win32")).toEqual({ status: "blocked", reason: "no_platform_anchor" });
        expect(resolveProject("darwin")).toEqual({ status: "blocked", reason: "no_platform_anchor" });
        expect(resolveProject("linux", "2.1.219")).toEqual({ status: "blocked", reason: "older_than_earliest_anchor" });
    });
});
