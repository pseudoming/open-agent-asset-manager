import { describe, expect, it } from "vitest";
import { projectDisplayName } from "../src/renderer/presentation/project-label";
import {
    activeProjects,
    ASSET_KIND_HELP_MESSAGE_IDS,
    ASSET_KIND_ORDER,
    ASSET_KIND_MESSAGE_IDS,
    buildAssetTargetSupport,
    chooseInitialProjectId,
    retainedProjects,
    type ProjectView,
} from "../src/renderer/features/project-library";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";

function project(projectId: string, displayName: string, deleted = false): ProjectView {
    return { projectId, displayName, rootPath: `/work/${displayName}`, deleted, createdAt: 1, updatedAt: 2 };
}

describe("Project-first library model", () => {
    it("presents unnamed Windows and WSL Projects without changing stored or explicitly chosen names", () => {
        const unnamed = { ...project(PROJECT_A, ""), rootPath: "\\\\wsl.localhost\\Ubuntu\\work\\文档" };
        expect(projectDisplayName(unnamed)).toBe("文档");
        expect(unnamed.displayName).toBe("");
        expect(projectDisplayName({ ...unnamed, rootPath: "C:\\Projects\\Docs\\" })).toBe("Docs");
        expect(projectDisplayName({ ...unnamed, rootPath: "/" })).toBe("/");
        expect(projectDisplayName({ ...unnamed, displayName: "My docs" })).toBe("My docs");
        expect(projectDisplayName(undefined)).toBeUndefined();
        expect(activeProjects([project(PROJECT_B, "Zulu"), unnamed]).map(projectDisplayName)).toEqual(["Zulu", "文档"]);
    });

    it("restores only an active preferred Project and otherwise uses stable visible-name order", () => {
        const projects = [
            project(PROJECT_B, "zeta"),
            project(PROJECT_A, "Alpha"),
            project("33333333-3333-4333-8333-333333333333", "Gone", true),
        ];
        expect(activeProjects(projects).map((value) => value.projectId)).toEqual([PROJECT_A, PROJECT_B]);
        expect(chooseInitialProjectId(projects, PROJECT_B)).toBe(PROJECT_B);
        expect(chooseInitialProjectId(projects, "33333333-3333-4333-8333-333333333333")).toBe(PROJECT_A);
        expect(chooseInitialProjectId([], PROJECT_A)).toBeUndefined();
        const tied = [project(PROJECT_B, "Same"), project(PROJECT_A, "Same")];
        expect(activeProjects(tied).map((value) => value.projectId)).toEqual([PROJECT_A, PROJECT_B]);
        expect(
            activeProjects([project(PROJECT_B, "alpha"), project(PROJECT_A, "Alpha")]).map((value) => value.displayName),
        ).toEqual(["Alpha", "alpha"]);
        expect(
            activeProjects([project(PROJECT_A, "Alpha"), project(PROJECT_B, "alpha")]).map((value) => value.displayName),
        ).toEqual(["Alpha", "alpha"]);
        expect(
            retainedProjects([
                project(PROJECT_B, "zeta", true),
                project(PROJECT_A, "Alpha", true),
                project("33333333-3333-4333-8333-333333333333", "Active"),
            ]).map((value) => value.projectId),
        ).toEqual([PROJECT_A, PROJECT_B]);
    });

    it("keeps the six public Asset kinds in the one stable library order", () => {
        expect(ASSET_KIND_ORDER).toEqual(["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"]);
        expect(new Set(ASSET_KIND_ORDER).size).toBe(ASSET_KIND_ORDER.length);
        expect(Object.keys(ASSET_KIND_MESSAGE_IDS)).toEqual(ASSET_KIND_ORDER);
        expect(Object.keys(ASSET_KIND_HELP_MESSAGE_IDS)).toEqual(ASSET_KIND_ORDER);
    });

    it("aggregates complete family support while keeping partial family support runtime-exact", () => {
        const providers: Parameters<typeof buildAssetTargetSupport>[0] = [
            {
                adapterId: "ZCODE",
                displayName: "ZCode",
                version: "1.0.0",
                enabled: true,
                agentRuntimes: [{ agentRuntimeId: "ZCODE_APP", displayName: "ZCode App", entryClass: "app" }],
                sourceCapabilities: [],
                targetCapabilities: [
                    {
                        agentRuntimeId: "ZCODE_APP",
                        assetKind: "Guidance",
                        entrySupportStatus: "supported",
                        renderStrategy: "native_file",
                        reverseExtractPolicy: "can_reconcile",
                        diagnostics: [],
                    },
                ],
            },
            {
                adapterId: "CLAUDECODE",
                displayName: "Claude Code",
                version: "1.0.0",
                enabled: true,
                agentRuntimes: [
                    { agentRuntimeId: "CLAUDE_CODE_CLI", displayName: "Claude Code CLI", entryClass: "cli" },
                    { agentRuntimeId: "CLAUDE_CODE_APP", displayName: "Claude Code App", entryClass: "app" },
                ],
                sourceCapabilities: [],
                targetCapabilities: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        assetKind: "Guidance",
                        entrySupportStatus: "supported",
                        renderStrategy: "native_file",
                        reverseExtractPolicy: "can_reconcile",
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: "CLAUDE_CODE_APP",
                        assetKind: "Guidance",
                        entrySupportStatus: "supported",
                        renderStrategy: "native_file",
                        reverseExtractPolicy: "can_reconcile",
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        assetKind: "Workflow",
                        entrySupportStatus: "supported",
                        renderStrategy: "native_file",
                        reverseExtractPolicy: "can_reconcile",
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: "CLAUDE_CODE_APP",
                        assetKind: "Workflow",
                        entrySupportStatus: "deferred",
                        diagnostics: [],
                    },
                ],
            },
            {
                adapterId: "OPENCODE",
                displayName: "OpenCode",
                version: "1.0.0",
                enabled: true,
                agentRuntimes: [{ agentRuntimeId: "OPENCODE_CLI", displayName: "OpenCode CLI", entryClass: "cli" }],
                sourceCapabilities: [],
                targetCapabilities: [
                    {
                        agentRuntimeId: "OPENCODE_CLI",
                        assetKind: "Guidance",
                        entrySupportStatus: "deferred",
                        diagnostics: [],
                    },
                ],
            },
        ];

        const targets = buildAssetTargetSupport(providers);
        expect(targets.get("Guidance")).toEqual([
            {
                key: "provider:CLAUDECODE",
                displayName: "Claude Code",
                agentRuntimeIds: ["CLAUDE_CODE_APP", "CLAUDE_CODE_CLI"],
            },
            { key: "provider:ZCODE", displayName: "ZCode", agentRuntimeIds: ["ZCODE_APP"] },
        ]);
        expect(targets.get("Workflow")).toEqual([
            {
                key: "runtime:CLAUDE_CODE_CLI",
                displayName: "Claude Code CLI",
                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
            },
        ]);
        expect(targets.size).toBe(ASSET_KIND_ORDER.length);
    });
});
