/** Exact-key JSON projection and selected-Environment project discovery, using owned fixtures only. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeClaudeCode } from "../src/claudecode-probe";
import { readClaudeProjectRegistry } from "../src/claudecode-probe-project-registry";
import { projectClaudeRegistryKeys } from "../src/claudecode-project-key-projection";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const context = { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: "/owned" };
const missing = (): never => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

describe("Claude project key projection", () => {
    it("returns only direct project keys while validating and skipping all private values", () => {
        const privateSentinel = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_PROJECT";
        const text = JSON.stringify({
            auth: privateSentinel,
            nested: { projects: { "/wrong": {} } },
            projects: {
                "/owned/a-with-dash": { history: [privateSentinel], trust: true },
                "/owned/中文": { nested: [1.5, -2e4, false, null, { value: 'quote"\\\n' }] },
            },
        });
        const parse = vi.spyOn(JSON, "parse");
        try {
            const result = projectClaudeRegistryKeys(text);
            expect(result).toEqual(["/owned/a-with-dash", "/owned/中文"]);
            expect(JSON.stringify(result)).not.toContain(privateSentinel);
            expect(
                parse.mock.calls.every(
                    ([input]) => typeof input === "string" && input.startsWith('"') && !input.includes(privateSentinel),
                ),
            ).toBe(true);
        } finally {
            parse.mockRestore();
        }
    });

    it.each([
        "[]",
        '{"projects":null}',
        '{"projects":{"/owned/a":{}} ,"projects":{}}',
        '{"projects":{"/owned/a":{},"/owned/a":{}}}',
        '{"projects":{"":{}}}',
        '{"projects":{"/owned/\\u0000":{}}}',
        '{"projects":{"/owned/a":{}}} trailing',
        '{"private":"bad\\x"}',
        '{"private":"bad\\uXYZ1"}',
        '{"private":"bad\n"}',
        '{"private":[1,]}',
        '{"private":01}',
        '{"private":1.}',
        '{"private":1e}',
        '{"private":undefined}',
        '{"private":"unterminated}',
        '{"private": {"a":true,}}',
    ])("rejects malformed or ambiguous structure without leaking its input: %s", (text) => {
        expect(() => projectClaudeRegistryKeys(text)).toThrow("Claude project locator projection is invalid");
    });

    it("enforces byte, nesting, key-length and key-count limits", () => {
        expect(() => projectClaudeRegistryKeys(JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }))).toThrow();
        expect(() => projectClaudeRegistryKeys('{"nested":' + "[".repeat(65) + "0" + "]".repeat(65) + "}")).toThrow();
        expect(() => projectClaudeRegistryKeys(JSON.stringify({ projects: { ["/" + "x".repeat(4096)]: {} } }))).toThrow();
        const projects = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`/owned/${index}`, {}]));
        expect(projectClaudeRegistryKeys(JSON.stringify({ projects }))).toHaveLength(1024);
        expect(() => projectClaudeRegistryKeys(JSON.stringify({ projects: { ...projects, "/owned/extra": {} } }))).toThrow();
        expect(projectClaudeRegistryKeys('{"projects":{},"private": []}')).toEqual([]);
        expect(projectClaudeRegistryKeys("{}")).toEqual([]);
    });
});

describe("Claude global CLI project index", () => {
    it("honors legacy precedence and never reads a lower-priority config after an invalid or denied legacy file", async () => {
        for (const mode of ["valid", "invalid", "denied"] as const) {
            const read = vi.fn(async () => {
                if (mode === "denied") throw Object.assign(new Error("SYNTHETIC_PRIVATE_VALUE"), { code: "EACCES" });
                return mode === "valid" ? '{"projects":{"/owned/project":{}}}' : "SYNTHETIC_PRIVATE_VALUE";
            });
            const result = await readClaudeProjectRegistry("/owned/.claude", "/owned", {}, context, read);
            expect(result.status).toBe(mode === "valid" ? "complete" : mode === "denied" ? "needs_permission" : "partial");
            expect(read).toHaveBeenCalledTimes(1);
            expect(read).toHaveBeenCalledWith("/owned/.claude/.config.json", 2 * 1024 * 1024);
            expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
        }
    });

    it.each([
        [{}, "/owned/.claude.json"],
        [{ CLAUDE_CONFIG_DIR: "/owned/config" }, "/owned/config/.claude.json"],
        [{ CLAUDE_CODE_CUSTOM_OAUTH_URL: "SYNTHETIC_PRIVATE_VALUE" }, "/owned/.claude-custom-oauth.json"],
        [{ USER_TYPE: "ant", USE_LOCAL_OAUTH: " true " }, "/owned/.claude-local-oauth.json"],
        [{ USER_TYPE: "ant", USE_STAGING_OAUTH: "1" }, "/owned/.claude-staging-oauth.json"],
    ])("selects only the source-declared profile filename for %j", async (environment, filename) => {
        const read = vi.fn(async (name: string) => (name === filename ? '{"projects":{"/owned/a":{}}}' : missing()));
        const result = await readClaudeProjectRegistry(
            environment.CLAUDE_CONFIG_DIR ?? "/owned/.claude",
            "/owned",
            environment,
            context,
            read,
        );
        expect(result).toMatchObject({ status: "complete", projects: [{ runtimePath: "/owned/a", hostPath: "/owned/a" }] });
        expect(read).toHaveBeenLastCalledWith(filename, 2 * 1024 * 1024);
    });

    it("does not materialize a locator outside the selected Environment and does not read outside config", async () => {
        const read = vi.fn(async () => '{"projects":{"/owned/a":{},"/foreign/a":{},"relative":{}}}');
        expect(await readClaudeProjectRegistry("/owned/.claude", "/owned", {}, context, read)).toMatchObject({
            status: "partial",
            projects: [{ runtimePath: "/owned/a", hostPath: "/owned/a" }],
            diagnostics: [
                { code: "claudecode_project_registry_path_unreachable" },
                { code: "claudecode_project_registry_path_unreachable" },
            ],
        });
        read.mockClear();
        expect((await readClaudeProjectRegistry("/outside", "/owned", {}, context, read)).status).toBe("partial");
        expect(read).not.toHaveBeenCalled();
    });

    it("projects the selected WSL runtime path through its exact Host access root", async () => {
        const accessRootPath = "\\\\wsl.localhost\\Ubuntu\\";
        const read = vi.fn(async () => '{"projects":{"/home/example/project":{}}}');
        const result = await readClaudeProjectRegistry(
            `${accessRootPath}home\\example\\.claude`,
            `${accessRootPath}home\\example`,
            {},
            { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath },
            read,
        );
        expect(result.projects).toEqual([
            { runtimePath: "/home/example/project", hostPath: `${accessRootPath}home\\example\\project` },
        ]);
    });

    it("accepts source-normalized Windows forward slashes and escaped Unicode without splitting dashes", async () => {
        const read = vi.fn(async () => '{"projects":{"C:/owned/a-with-dash/\\u4e2d\\u6587":{}}}');
        const result = await readClaudeProjectRegistry(
            "C:\\owned\\.claude",
            "C:\\owned",
            {},
            { platform: "win32", platformInstanceId: "desktop-local", accessRootPath: "C:\\owned" },
            read,
        );
        expect(result).toMatchObject({
            status: "complete",
            projects: [
                {
                    runtimePath: "C:/owned/a-with-dash/中文",
                    hostPath: "C:\\owned\\a-with-dash\\中文",
                },
            ],
        });
    });

    it("keeps missing storage distinct from a bounded-read failure", async () => {
        const read = vi.fn(async () => missing());
        expect(await readClaudeProjectRegistry("/owned/.claude", "/owned", {}, context, read)).toEqual({
            status: "not_found",
            projects: [],
            diagnostics: [],
        });
        expect(read).toHaveBeenCalledTimes(2);
        read.mockImplementation(async () => {
            throw Object.assign(new Error("bounded read failed"), { code: "EIO" });
        });
        expect(await readClaudeProjectRegistry("/owned/.claude", "/owned", {}, context, read)).toMatchObject({
            status: "partial",
            diagnostics: [{ code: "claudecode_project_registry_unreadable" }],
        });
    });

    it("binds actual isolated registry keys to CLI projects and resources without borrowing App ownership", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-project-index-"));
        roots.push(root);
        const home = path.join(root, "home"),
            project = path.join(root, "a-with-dash");
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.mkdirSync(project);
        const registry = path.join(home, ".claude.json");
        const bytes = JSON.stringify({ projects: { [project]: { history: ["SYNTHETIC_PRIVATE_VALUE"] } } });
        fs.writeFileSync(registry, bytes);
        const result = await probeClaudeCode(
            {
                platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: root },
                authorizationScope: "global",
            },
            { PATH: "" },
            home,
        );
        const cli = result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "CLAUDE_CODE_CLI")!;
        const app = result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "CLAUDE_CODE_APP")!;
        expect(cli.projectDiscoveryStatus).toBe("complete");
        expect(cli.observedProjectIds).toEqual(result.observation.observedProjects.map((entry) => entry.observedProjectId));
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({ runtimeProjectKey: project, displayName: "" }),
        ]);
        expect(result.observation.agentRuntimeResources).toEqual([
            expect.objectContaining({ path: registry, roles: ["project_registry"] }),
        ]);
        expect(app.observedProjectIds).toEqual([]);
        expect(app.agentRuntimeResourceIds).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
        expect(fs.readFileSync(registry, "utf8")).toBe(bytes);
        expect(fs.readdirSync(project)).toEqual([]);
    });
});
