/** Bounded App project metadata projection: owned fixtures and explicit foreign-environment controls. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformContext, SourceRoot } from "@oaam/core";
import { inspectDirectoryNoFollow, inventoryDirectoryNoFollow, readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectClaudeAppLocation } from "../src/claudecode-app-project-projection";
import { probeClaudeCode } from "../src/claudecode-probe";
import { claudeAppProfileRoots, discoverClaudeAppProjects } from "../src/claudecode-probe-app-projects";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const stableId = (kind: string, value: string): string => `${kind}-${crypto.createHash("sha256").update(value).digest("hex")}`;
const makeRoot = vi.fn(
    (
        filePath: string,
        rootRole: SourceRoot["rootRole"],
        sourceDomain: SourceRoot["sourceDomain"],
        locatorEvidence: SourceRoot["locatorEvidence"],
    ): SourceRoot => ({
        sourceRootId: stableId("root", filePath),
        path: filePath,
        rootRole,
        sourceDomain,
        locatorEvidence,
        accessStatus: "available",
        diagnostics: [],
    }),
);
const readText = async (filePath: string, limit: number): Promise<string> =>
    Buffer.from(readRegularFileNoFollow(filePath, limit).bytes).toString("utf8");
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-app-index-"));
    roots.push(root);
    const profile = path.join(root, ".config", "Claude"),
        base = path.join(profile, "claude-code-sessions");
    const org = path.join(base, "aabbccdd", "retained-org");
    fs.mkdirSync(org, { recursive: true });
    const context: PlatformContext = { platform: "linux", platformInstanceId: "local", accessRootPath: root };
    const write = (name: string, value: unknown): string => {
        const target = path.join(org, `local_${name}.json`);
        fs.writeFileSync(target, JSON.stringify(value));
        return target;
    };
    const discover = (reader = readText, overrides: Parameters<typeof discoverClaudeAppProjects>[7] = {}) =>
        discoverClaudeAppProjects({}, root, context, true, reader, makeRoot, stableId, overrides);
    return { root, profile, base, org, context, write, discover };
}

describe("Claude App project-only projection", () => {
    it("decodes project paths and backend ownership without decoding unrelated private values", () => {
        const text = JSON.stringify({
            originCwd: "/owned/中文",
            cwd: "/owned/worktree",
            sshConfig: null,
            wslConfig: { distro: "Ubuntu-24.04", private: "SYNTHETIC_PRIVATE_VALUE" },
            messages: [{ content: "SYNTHETIC_PRIVATE_VALUE" }],
            credential: "SYNTHETIC_PRIVATE_VALUE",
            nested: { originCwd: "/wrong" },
        });
        const parse = vi.spyOn(JSON, "parse");
        try {
            expect(projectClaudeAppLocation(text)).toEqual({
                originCwd: "/owned/中文",
                cwd: "/owned/worktree",
                ssh: false,
                wslDistro: "Ubuntu-24.04",
            });
            expect(
                parse.mock.calls.every(
                    ([value]) => typeof value === "string" && value.startsWith('"') && !value.includes("SYNTHETIC_PRIVATE_VALUE"),
                ),
            ).toBe(true);
        } finally {
            parse.mockRestore();
        }
    });
    it("records SSH presence without decoding its host, key or configuration values", () => {
        expect(
            projectClaudeAppLocation(
                '{"originCwd":"/owned/p","sshConfig":{"key":"SYNTHETIC_PRIVATE_VALUE"},"wslConfig":{"distro":"Ubuntu"}}',
            ),
        ).toEqual({ originCwd: "/owned/p", cwd: "", ssh: true, wslDistro: "Ubuntu" });
        expect(
            projectClaudeAppLocation('{"sshConfig":null,"wslConfig":null,"private":[1.2,-2e3,true,false,null,[],{}]}'),
        ).toEqual({ originCwd: "", cwd: "", ssh: false, wslDistro: null });
    });
    it.each([
        "[]",
        '{"wslConfig":{}}',
        '{"wslConfig":{"distro":""}}',
        '{"wslConfig":{"distro":"../other"}}',
        '{"wslConfig":{"distro":"Ubuntu","distro":"Other"}}',
        '{"wslConfig":false}',
        '{"sshConfig":false}',
        '{"originCwd":"/a","originCwd":"/b"}',
        '{"originCwd":null}',
        '{"cwd":12}',
        '{"sshConfig":{},"sshConfig":null}',
        '{"originCwd":"/bad\\u0000"}',
        '{"private":"bad\\x"}',
        '{"private":"bad\\uXX00"}',
        '{"private":"bad\n"}',
        '{"private":[1,]}',
        '{"private":01}',
        '{"private":1e}',
        '{"private":undefined}',
        '{"private":{,}}',
        "{} trailing",
        '{"private":"unterminated}',
    ])("rejects invalid/ambiguous locator or JSON without exposing the input: %s", (input) => {
        expect(() => projectClaudeAppLocation(input)).toThrow("Claude App project locator is invalid or exceeds its bound");
    });
    it("enforces the byte, projected-string and nesting ceilings", () => {
        expect(() => projectClaudeAppLocation(JSON.stringify({ private: "x".repeat(2 * 1024 * 1024) }))).toThrow();
        expect(() => projectClaudeAppLocation(JSON.stringify({ originCwd: "/" + "x".repeat(4096) }))).toThrow();
        expect(() => projectClaudeAppLocation('{"private":' + "[".repeat(65) + "0" + "]".repeat(65) + "}")).toThrow();
    });
});

describe("Claude App retained project discovery", () => {
    it("uses historical account/org locations with traceable evidence and deduplicates project paths", async () => {
        const f = fixture(),
            primary = path.join(f.root, "my-project");
        fs.mkdirSync(primary);
        f.write("one", { originCwd: primary, cwd: "/unrelated-worktree", private: "SYNTHETIC_PRIVATE_VALUE" });
        const oldOrg = path.join(f.base, "deadbeef", "historical-org");
        fs.mkdirSync(oldOrg, { recursive: true });
        fs.writeFileSync(path.join(oldOrg, "local_two.json"), JSON.stringify({ originCwd: primary }));
        fs.writeFileSync(path.join(f.profile, "config.json"), "SYNTHETIC_PRIVATE_VALUE");
        fs.writeFileSync(path.join(f.org, "transcript.jsonl"), "SYNTHETIC_PRIVATE_VALUE");
        const read = vi.fn(readText),
            result = await f.discover(read);
        expect(result.status).toBe("complete");
        expect(result.sourceRoots).toHaveLength(1);
        expect(result.observedProjects).toHaveLength(1);
        expect(result.observedProjects[0]).toMatchObject({
            runtimeProjectKey: primary,
            displayName: "",
            evidence: [{ evidenceKind: "agent_runtime_resource" }, { evidenceKind: "agent_runtime_resource" }],
        });
        expect(read).toHaveBeenCalledTimes(2);
        expect(read.mock.calls.every(([filePath]) => path.basename(filePath).startsWith("local_"))).toBe(true);
        expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
        expect(JSON.stringify(result)).not.toContain("transcript");
    });
    it("does not promote scratch or cwd-only sessions and retains a genuine origin project", async () => {
        const f = fixture();
        f.write("scratch", { originCwd: path.join(f.profile, "scratch-workspaces", "a", "o", "scratch-name") });
        f.write("missing-origin", { cwd: path.join(f.root, "temporary-worktree") });
        f.write("origin", {
            originCwd: path.join(f.root, "real-project"),
            cwd: path.join(f.profile, "scratch-workspaces", "worktree"),
        });
        const result = await f.discover();
        expect(result.observedProjects.map((project) => project.runtimeProjectKey)).toEqual([path.join(f.root, "real-project")]);
    });
    it("does not follow metadata symlinks or read through an outside ancestor", async () => {
        const f = fixture();
        f.write("normal", { originCwd: f.root });
        fs.symlinkSync(path.join(f.profile, "config.json"), path.join(f.org, "local_link.json"));
        const read = vi.fn(readText),
            result = await f.discover(read);
        expect(result.status).toBe("partial");
        expect(result.observedProjects).toEqual([]);
        expect(read).not.toHaveBeenCalled();
    });
    it("discards profile anchors if an account directory is replaced while files are read", async () => {
        const f = fixture();
        f.write("one", { originCwd: f.root });
        const read = async (filePath: string, limit: number) => {
            const text = await readText(filePath, limit),
                account = path.dirname(f.org);
            fs.renameSync(account, account + "-old");
            fs.mkdirSync(path.join(account, path.basename(f.org)), { recursive: true });
            return text;
        };
        const result = await f.discover(read);
        expect(result.status).toBe("partial");
        expect(result.observedProjects).toEqual([]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "claudecode_app_project_index_incomplete" })]),
        );
    });
    it("keeps invalid, oversized and denied locators partial while preserving independently valid ones", async () => {
        const f = fixture();
        f.write("valid", { originCwd: f.root });
        f.write("invalid", { wslConfig: {} });
        f.write("oversized", { private: "x".repeat(2 * 1024 * 1024) });
        f.write("denied", {});
        const result = await f.discover(async (filePath, limit) => {
            if (filePath.endsWith("local_denied.json"))
                throw Object.assign(new Error("SYNTHETIC_PRIVATE_VALUE"), { code: "EACCES" });
            return readText(filePath, limit);
        });
        expect(result.status).toBe("partial");
        expect(result.observedProjects).toHaveLength(1);
        expect(result.diagnostics).toHaveLength(3);
        expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    });
    it("bounds metadata directory count and the deadline before reading further files", async () => {
        const f = fixture();
        f.write("one", { originCwd: f.root });
        const read = vi.fn(readText);
        let clock = 0;
        const result = await f.discover(read, { now: () => (clock++ === 0 ? 0 : 10_001) });
        expect(result.status).toBe("partial");
        expect(read).not.toHaveBeenCalled();
        const many = path.join(f.base, "aabbccdd");
        for (let index = 0; index < 256; index++) fs.mkdirSync(path.join(many, `org-${index}`));
        expect((await f.discover(read)).status).toBe("partial");
        expect(read).not.toHaveBeenCalled();
    });
    it.each([
        "account",
        "organization",
        "final-inspection",
    ])("preserves permission denial from %s metadata without exposing its raw error", async (stage) => {
        const f = fixture();
        f.write("one", { originCwd: f.root });
        const denied = (): never => {
            throw Object.assign(new Error("SYNTHETIC_PRIVATE_VALUE"), { code: "EACCES" });
        };
        const result = await f.discover(readText, {
            inventory: (name, limit) =>
                (stage === "account" && name === path.dirname(f.org)) || (stage === "organization" && name === f.org)
                    ? denied()
                    : inventoryDirectoryNoFollow(name, limit),
            inspectDirectory: (name) => (stage === "final-inspection" ? denied() : inspectDirectoryNoFollow(name)),
        });
        expect(result.status).toBe("needs_permission");
        expect(result.observedProjects).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ code: "claudecode_app_project_index_incomplete", causeKind: "permission_denied" }),
        ]);
        expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    });
    it("does not read known profile candidates outside the selected physical access root", async () => {
        const f = fixture(),
            read = vi.fn(readText);
        const result = await discoverClaudeAppProjects(
            { XDG_CONFIG_HOME: "/outside" },
            f.root,
            f.context,
            true,
            read,
            makeRoot,
            stableId,
        );
        expect(result.status).toBe("partial");
        expect(read).not.toHaveBeenCalled();
    });
    it("ignores a packaged CLAUDE_USER_DATA_DIR override and finds standard and retained 3p profiles", () => {
        expect(
            claudeAppProfileRoots({ CLAUDE_USER_DATA_DIR: "/foreign", XDG_CONFIG_HOME: "/owned/config" }, "/owned", {
                platform: "linux",
                platformInstanceId: "l",
                accessRootPath: "/owned",
            }),
        ).toEqual(["/owned/config/Claude", "/owned/config/Claude-3p"]);
        expect(
            claudeAppProfileRoots({}, "C:\\owned", { platform: "win32", platformInstanceId: "l", accessRootPath: "C:\\" }),
        ).toEqual([
            "C:\\owned\\AppData\\Roaming\\Claude",
            "C:\\owned\\AppData\\Local\\Claude-3p",
            "C:\\owned\\AppData\\Roaming\\Claude-3p",
        ]);
    });
    it("exposes only a not-checked WSL reference on Windows and gives SSH precedence without touching either path", async () => {
        const f = fixture();
        f.write("wsl", { originCwd: "/home/project", wslConfig: { distro: "Ubuntu" } });
        f.write("ssh", { originCwd: "/home/ssh-project", sshConfig: {}, wslConfig: { distro: "Other" } });
        f.write("local", { originCwd: "C:/owned/project" });
        f.write("same-root-distinct-key", { originCwd: "C:\\owned\\project" });
        const convert = (filePath: string): string =>
            filePath.replace("C:\\owned\\AppData\\Roaming\\Claude", f.profile).replaceAll("\\", "/");
        const context: PlatformContext = { platform: "win32", platformInstanceId: "desktop", accessRootPath: "C:\\owned" };
        const run = (available: boolean) =>
            discoverClaudeAppProjects(
                {},
                "C:\\owned",
                context,
                available,
                (name, limit) => readText(convert(name), limit),
                makeRoot,
                stableId,
                {
                    inventory: (name, limit) => inventoryDirectoryNoFollow(convert(name), limit),
                    inspectDirectory: (name) => inspectDirectoryNoFollow(convert(name)),
                },
            );
        makeRoot.mockClear();
        const result = await run(true);
        expect(result.status).toBe("partial");
        expect(result.environmentReferences).toHaveLength(1);
        expect(result.environmentReferences[0]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_APP",
            referencedEnvironment: { platform: "wsl", platformInstanceId: "Ubuntu" },
            validationState: "not_checked",
        });
        expect(result.sourceRoots.map((root) => root.path)).toEqual(["C:\\owned\\project"]);
        expect(result.observedProjects.map((project) => project.runtimeProjectKey).sort()).toEqual([
            "C:/owned/project",
            "C:\\owned\\project",
        ]);
        expect(JSON.stringify(result)).not.toContain("/home/project");
        expect(JSON.stringify(result)).not.toContain("/home/ssh-project");
        expect((await run(false)).environmentReferences).toEqual([]);
    });
    it("binds a matching WSL distro and rejects a different distro without local fallback", async () => {
        const f = fixture();
        f.write("matching", { originCwd: path.join(f.root, "project"), wslConfig: { distro: "ubuntu" } });
        f.write("foreign", { originCwd: "/foreign-project", wslConfig: { distro: "Other" } });
        const result = await discoverClaudeAppProjects(
            {},
            f.root,
            { ...f.context, platform: "wsl", platformInstanceId: "Ubuntu" },
            true,
            readText,
            makeRoot,
            stableId,
        );
        expect(result.sourceRoots.map((root) => root.path)).toEqual([path.join(f.root, "project")]);
        expect(result.environmentReferences).toEqual([]);
        expect(result.status).toBe("partial");
    });
    it("keeps CLI keys and App anchors attached to their exact runtime in a real isolated probe", async () => {
        const f = fixture(),
            appProject = path.join(f.root, "app-project"),
            cliProject = path.join(f.root, "cli-project");
        fs.mkdirSync(appProject);
        fs.mkdirSync(cliProject);
        fs.mkdirSync(path.join(f.root, ".claude"));
        f.write("app", { originCwd: appProject });
        fs.writeFileSync(path.join(f.root, ".claude.json"), JSON.stringify({ projects: { [cliProject]: {} } }));
        const result = await probeClaudeCode(
            { platformContext: f.context, authorizationScope: "global", installationRootPath: path.join(f.root, "no-install") },
            { HOME: f.root, PATH: "" },
            f.root,
            "linux",
        );
        for (const [id, projectPath] of [
            ["CLAUDE_CODE_APP", appProject],
            ["CLAUDE_CODE_CLI", cliProject],
        ]) {
            const runtime = result.observation.observedAgentRuntimes.find((item) => item.agentRuntimeId === id)!;
            const project = result.observation.observedProjects.find((item) =>
                runtime.observedProjectIds.includes(item.observedProjectId),
            )!;
            expect(runtime.observedProjectIds).toHaveLength(1);
            expect(runtime.projectDiscoveryStatus).toBe("complete");
            expect(project.runtimeProjectKey).toBe(projectPath);
            expect(runtime.agentRuntimeResourceIds).toHaveLength(1);
            expect(project.evidence[0]).toMatchObject({ agentRuntimeResourceId: runtime.agentRuntimeResourceIds[0] });
        }
    });
});
