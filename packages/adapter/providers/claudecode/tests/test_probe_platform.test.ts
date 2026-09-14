import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CLAUDECODE_PROBE_FOR_TEST, probeClaudeCode } from "../src/claudecode-probe";
import { resolveClaudeRuntimeProjectBase } from "../src/claudecode-probe-project-base";
import { claudecodeProvider } from "../src/claudecode-provider";

describe("Claude Code platform probe", () => {
    it("keeps a disappearing or changed Git marker from becoming worktree read authority", async () => {
        const project = "/owned/project";
        const context = { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: "/owned" };
        const fileMarker = { isFile: () => true, isDirectory: () => false } as fs.Stats;
        const readControl = vi.fn(async () => "must not be read");
        for (const terminal of ["missing", "wrong_type"] as const) {
            const inspectMarker = vi
                .fn()
                .mockReturnValueOnce(fileMarker)
                .mockImplementationOnce(() => {
                    if (terminal === "missing") throw Object.assign(new Error("removed after discovery"), { code: "ENOENT" });
                    return { isFile: () => false, isDirectory: () => false };
                });
            const result = await resolveClaudeRuntimeProjectBase(project, context, readControl, {
                inspectMarker,
                canonicalize: (value) => value,
            });
            expect(result.path).toBe(project);
            expect(result.diagnostics).toEqual(
                terminal === "missing" ? [] : [expect.objectContaining({ code: "claudecode_git_worktree_identity_untrusted" })],
            );
        }
        expect(readControl).not.toHaveBeenCalled();
    });

    it("rejects an invalid project path and a Git common-directory chain outside worktrees", async () => {
        const context = { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: "/owned" };
        const readControl = vi.fn(async (filePath: string) =>
            filePath.endsWith("/.git") ? "gitdir: /owned/main/.git/not-worktrees/linked" : "../..",
        );
        const filesystem = {
            inspectMarker: () => ({ isFile: () => true, isDirectory: () => false }) as fs.Stats,
            canonicalize: (value: string) => value,
        };
        await expect(resolveClaudeRuntimeProjectBase("relative", context, readControl, filesystem)).resolves.toEqual({
            path: "relative",
            diagnostics: [],
        });
        expect(readControl).not.toHaveBeenCalled();
        await expect(resolveClaudeRuntimeProjectBase("/owned/project", context, readControl, filesystem)).resolves.toMatchObject({
            path: "/owned/project",
            diagnostics: [{ code: "claudecode_git_worktree_identity_untrusted" }],
        });
        expect(readControl).toHaveBeenCalledTimes(2);
    });

    it("starts the independent CLI and App observations before awaiting either result", async () => {
        let resolveCli: ((value: "cli") => void) | undefined;
        let resolveApp: ((value: "app") => void) | undefined;
        const observeCli = vi.fn(
            () =>
                new Promise<"cli">((resolve) => {
                    resolveCli = resolve;
                }),
        );
        const observeApp = vi.fn(
            () =>
                new Promise<"app">((resolve) => {
                    resolveApp = resolve;
                }),
        );

        const pending = CLAUDECODE_PROBE_FOR_TEST.observeClaudeInstallations(observeCli, observeApp);
        expect(observeCli).toHaveBeenCalledOnce();
        expect(observeApp).toHaveBeenCalledOnce();
        resolveApp?.("app");
        resolveCli?.("cli");
        await expect(pending).resolves.toEqual(["cli", "app"]);
    });

    it("rejects a local executable symlink that escapes the exact environment and a non-file sibling", async () => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-probe-boundary-"));
        const firstBin = path.join(fixture, "first-bin");
        const secondBin = path.join(fixture, "second-bin");
        const outsideExecutable = path.join(os.tmpdir(), `oaam-claude-outside-${path.basename(fixture)}`);
        try {
            fs.mkdirSync(firstBin);
            fs.mkdirSync(secondBin);
            fs.writeFileSync(outsideExecutable, "#!/bin/sh\n", { mode: 0o755 });
            fs.symlinkSync(outsideExecutable, path.join(firstBin, "claude"));
            fs.mkdirSync(path.join(secondBin, "claude"));

            const result = await CLAUDECODE_PROBE_FOR_TEST.findClaudeExecutable(
                { PATH: `relative:${firstBin}:${secondBin}` },
                fixture,
                { platform: "linux", platformInstanceId: "fixture", accessRootPath: fixture },
            );

            expect(result).toMatchObject({
                status: "unknown",
                executable: null,
                diagnostics: [expect.objectContaining({ code: "claudecode_install_discovery_incomplete" })],
            });
        } finally {
            fs.rmSync(fixture, { recursive: true, force: true });
            fs.rmSync(outsideExecutable, { force: true });
        }
    });

    it("returns unknown observations when the requested platform filesystem is unreachable", async () => {
        const unreachable = process.platform === "darwin" ? "linux" : "darwin";
        const result = await claudecodeProvider.probe({
            authorizationScope: "global",
            platformContext: {
                platform: unreachable,
                platformInstanceId: "foreign",
                accessRootPath: "/",
            },
        });
        expect(result.observation.sourceRoots).toEqual([]);
        expect(
            result.observation.observedAgentRuntimes.map((entry) => ({
                agentRuntimeId: entry.agentRuntimeId,
                installationStatus: entry.installationStatus,
            })),
        ).toEqual([
            { agentRuntimeId: "CLAUDE_CODE_CLI", installationStatus: "unknown" },
            { agentRuntimeId: "CLAUDE_CODE_APP", installationStatus: "unknown" },
        ]);
        expect(result.diagnostics[0]?.code).toBe("claudecode_probe_platform_unreachable");
    });

    it("requires Linux execution before probing a Windows-hosted WSL Environment", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const result = await probeClaudeCode(
            {
                authorizationScope: "global",
                platformContext: { platform: "wsl", platformInstanceId: "wsl:Ubuntu", accessRootPath: wslHome },
            },
            { PATH: "C:\\poison-bin", CLAUDE_CONFIG_DIR: "C:\\poison-config" },
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "claudecode_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });

    it("requires Linux execution before probing a Windows-hosted WSL project", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const project = `${wslHome}\\project`;
        const result = await probeClaudeCode(
            {
                authorizationScope: "project",
                platformContext: { platform: "wsl", platformInstanceId: "wsl:Ubuntu", accessRootPath: wslHome },
                projectRootPath: project,
            },
            {},
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "claudecode_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });
});
