import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeInvocations } from "./workspace-commands.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-workspace-command-"));
    roots.push(root);
    const toolDirectory = path.join(root, "tool with spaces");
    fs.mkdirSync(toolDirectory);
    const cli = path.join(toolDirectory, "npm-cli.js");
    fs.writeFileSync(
        cli,
        'require("node:fs").writeFileSync(process.env.OAAM_TEST_RECEIPT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
    );
    const receipt = path.join(root, "receipt.json");
    const invocation = {
        label: "Windows npm invocation",
        command: "npm.cmd",
        args: ["run", "build", "--workspace", "packages/tool with spaces & literal"],
        cwd: root,
    };
    return { root, cli, receipt, invocation, env: { ...process.env, npm_execpath: cli, OAAM_TEST_RECEIPT: receipt } };
}

describe("workspace command execution", () => {
    it.each([
        { name: "top-level Actions", reportProgress: true, actions: "true", expectedProgress: true },
        { name: "nested Actions", reportProgress: false, actions: "true", expectedProgress: false },
        { name: "local", reportProgress: true, actions: undefined, expectedProgress: false },
    ])("preserves real Windows npm CLI arguments and scopes progress for $name execution", (settings) => {
        const f = fixture();
        const lines: string[] = [];
        executeInvocations([f.invocation], {
            env: { ...f.env, GITHUB_ACTIONS: settings.actions, VITEST_MAX_FORKS: "2", VITEST_MIN_FORKS: "1" },
            stdio: "pipe",
            reportProgress: settings.reportProgress,
            log: (line: string) => lines.push(line),
        });
        expect(JSON.parse(fs.readFileSync(f.receipt, "utf8"))).toEqual({ args: f.invocation.args, cwd: f.root });
        if (settings.expectedProgress) {
            expect(JSON.parse(lines[0].replace("[verification] host ", ""))).toMatchObject({
                availableParallelism: expect.any(Number),
                vitestMaxForks: "2",
                vitestMinForks: "1",
            });
            expect(lines.slice(1)).toEqual([
                "::group::Windows npm invocation",
                expect.stringMatching(/^\[verification\] Windows npm invocation: passed \(\d+\.\d{3}s\)$/u),
                "::endgroup::",
            ]);
        } else {
            expect(lines).toEqual([]);
        }
    });

    it("rejects missing, relative, foreign and non-file npm CLI paths before starting a process", () => {
        const f = fixture();
        const directory = path.join(f.root, "npm-cli.js");
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(f.root, "yarn.js"), "process.exit(0);");
        for (const npmCli of [
            undefined,
            "npm-cli.js",
            path.join(f.root, "yarn.js"),
            path.join(f.root, "absent", "npm-cli.js"),
            directory,
        ]) {
            const spawn = vi.fn();
            expect(() => executeInvocations([f.invocation], { spawn, env: { ...f.env, npm_execpath: npmCli } })).toThrow(
                "Windows workspace commands require npm run",
            );
            expect(spawn).not.toHaveBeenCalled();
        }
    });

    it("propagates the actual CLI failure and does not run later workspace commands", () => {
        const f = fixture();
        fs.writeFileSync(f.cli, "process.exit(7);");
        const lines: string[] = [];
        expect(() =>
            executeInvocations(
                [
                    f.invocation,
                    {
                        ...f.invocation,
                        command: process.execPath,
                        args: ["-e", 'require("node:fs").writeFileSync(process.env.OAAM_TEST_RECEIPT, "unexpected");'],
                    },
                ],
                {
                    env: { ...f.env, GITHUB_ACTIONS: "true" },
                    stdio: "pipe",
                    reportProgress: true,
                    log: (line: string) => lines.push(line),
                },
            ),
        ).toThrow("command failed with 7");
        expect(fs.existsSync(f.receipt)).toBe(false);
        expect(lines.slice(1)).toEqual([
            "::group::Windows npm invocation",
            expect.stringMatching(/^\[verification\] Windows npm invocation: failed \(\d+\.\d{3}s\)$/u),
            "::endgroup::",
        ]);
    });
});
