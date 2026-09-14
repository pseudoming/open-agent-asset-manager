import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeClaudeCode } from "../src/claudecode-probe";
import { createProjectRoot, globalContext, projectContext } from "./claudecode-test-fixtures";

let sandbox = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-app-probe-"));
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Claude Code App probe", () => {
    it("binds an exact installed Windows App only to the user-authorized project", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const bin = path.join(sandbox, "bin");
        const memory = path.join(sandbox, "memory");
        const programFiles = path.join(sandbox, "Program Files");
        const localAppData = path.join(home, "AppData", "Local");
        createProjectRoot(project);
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.mkdirSync(memory, { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, "claude.exe"), "fixture CLI");
        createWindowsAppInstallation(programFiles, localAppData);

        const result = await probeClaudeCode(
            projectContext(project, "win32"),
            {
                PATH: bin,
                LOCALAPPDATA: localAppData,
                ProgramFiles: programFiles,
                CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memory,
            },
            home,
            "win32",
        );

        const app = result.observation.observedAgentRuntimes.find((runtime) => runtime.agentRuntimeId === "CLAUDE_CODE_APP");
        const projectRoot = result.observation.sourceRoots.find(
            (root) => root.rootRole === "project_actual" && root.path === project,
        );
        expect(app).toMatchObject({
            installationStatus: "available",
            versionText: "2.1.219",
            projectDiscoveryStatus: "complete",
            sourceRootIds: expect.arrayContaining([projectRoot?.sourceRootId]),
            observedProjectIds: [result.observation.observedProjects[0]?.observedProjectId],
        });
        expect(
            result.observation.targetCandidates
                .find((candidate) => candidate.targetKind === "project")
                ?.entryApplicabilities.find((entry) => entry.agentRuntimeId === "CLAUDE_CODE_APP"),
        ).toMatchObject({ status: "ready_for_plan", diagnostics: [] });
        expect(
            result.observation.targetCandidates
                .find((candidate) => candidate.targetKind === "directory" && candidate.targetRootPath === memory)
                ?.entryApplicabilities.find((entry) => entry.agentRuntimeId === "CLAUDE_CODE_APP"),
        ).toMatchObject({ status: "ready_for_plan", diagnostics: [] });
    });

    it("does not invent a Windows App project association from a global probe", async () => {
        const home = path.join(sandbox, "home");
        const bin = path.join(sandbox, "bin");
        const programFiles = path.join(sandbox, "Program Files");
        const localAppData = path.join(home, "AppData", "Local");
        fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, "claude.exe"), "fixture CLI");
        createWindowsAppInstallation(programFiles, localAppData);

        const result = await probeClaudeCode(
            globalContext("win32"),
            { PATH: bin, LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
            home,
            "win32",
        );

        const app = result.observation.observedAgentRuntimes.find((runtime) => runtime.agentRuntimeId === "CLAUDE_CODE_APP");
        expect(app).toMatchObject({
            installationStatus: "available",
            versionText: "2.1.219",
            projectDiscoveryStatus: "not_found",
            sourceRootIds: [expect.stringMatching(/^claudecode-source-root-/)],
            observedProjectIds: [],
        });
        expect(result.observation.observedProjects).toEqual([]);
        expect(
            result.observation.targetCandidates
                .flatMap((candidate) => candidate.entryApplicabilities)
                .filter((entry) => entry.agentRuntimeId === "CLAUDE_CODE_APP"),
        ).toEqual([expect.objectContaining({ status: "ready_for_plan" })]);
    });
});

function createWindowsAppInstallation(programFiles: string, localAppData: string): void {
    const publisher =
        "CN=&quot;Anthropic, PBC&quot;, O=&quot;Anthropic, PBC&quot;, L=San Francisco, S=California, C=US, SERIALNUMBER=4860621, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US";
    const packageRoot = path.join(programFiles, "WindowsApps", "Claude_1.24012.9.0_x64__pzs8sxrjxfjjc");
    const engineRoot = path.join(localAppData, "Claude-3p", "claude-code", "2.1.219");
    fs.mkdirSync(path.join(packageRoot, "app"), { recursive: true });
    fs.mkdirSync(engineRoot, { recursive: true });
    fs.writeFileSync(
        path.join(packageRoot, "AppxManifest.xml"),
        [
            "<Package>",
            `  <Identity Name="Claude" ProcessorArchitecture="x64" Publisher="${publisher}" Version="1.24012.9.0" />`,
            "</Package>",
            "",
        ].join("\n"),
    );
    fs.writeFileSync(path.join(packageRoot, "app", "Claude.exe"), Buffer.from([0x4d, 0x5a, 0, 0]));
    fs.writeFileSync(path.join(engineRoot, "claude.exe"), Buffer.from([0x4d, 0x5a, 0, 0]));
}
