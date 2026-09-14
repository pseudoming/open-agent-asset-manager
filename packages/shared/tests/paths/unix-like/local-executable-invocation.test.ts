import * as crypto from "node:crypto";
import fsDefault from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { inspectRegularFileNoFollow } from "../../../src/paths/unix-like/filesystem-target-entry";
import { invokeLocalExecutableTreeBounded } from "../../../src/paths/unix-like/path-environment";

describe("Unix-like OAAM-owned executable invocation", () => {
    it("binds the exact root identity and accepts only a naturally empty process tree", async () => {
        const result = await invoke("/bin/sh", ["-c", "printf complete; sleep 0.05"]);

        expect(result.status).toBe("complete");
        expect(new TextDecoder().decode(result.stdout)).toBe("complete");
        expect(result.rootProcess?.lifecycleToken).toMatch(/^[0-9]+$/u);
        expect(result.observedProcesses.length).toBeGreaterThanOrEqual(1);
        expect(result.cleanupComplete).toBe(true);
        expect(result.invocationTokenAbsent).toBe(true);
    });

    it("does not stat transient proc entries while taking the process-name inventory", async () => {
        const originalReadDirectory = fsDefault.readdirSync;
        const processDirectoryCalls: unknown[] = [];
        const readDirectory = vi.spyOn(fsDefault, "readdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
            if (String(path) === "/proc") {
                processDirectoryCalls.push(options);
                if (options !== undefined) {
                    const error = new Error("transient process disappeared") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
            }
            return originalReadDirectory(path);
        }) as typeof fsDefault.readdirSync);
        try {
            const result = await invoke("/bin/sh", ["-c", "printf complete; sleep 0.05"]);

            expect(result.status).toBe("complete");
            expect(processDirectoryCalls.length).toBeGreaterThan(0);
            expect(processDirectoryCalls).toEqual(processDirectoryCalls.map(() => undefined));
        } finally {
            readDirectory.mockRestore();
        }
    });

    it("rejects a successful root that leaves a child and cleans only the token-bound tree", async () => {
        const result = await invoke("/bin/sh", ["-c", "/bin/sleep 5 </dev/null >/dev/null 2>&1 & sleep 0.05; exit 0"]);

        expect(result.status).toBe("failed");
        expect(["process_observation_failed", "residual_process"]).toContain(result.failureCode);
        expect(result.observedProcesses.length).toBeGreaterThanOrEqual(2);
        expect(result.cleanupComplete).toBe(true);
        expect(result.invocationTokenAbsent).toBe(true);
    });

    it("times out, discards output and leaves no invocation process", async () => {
        const result = await invoke("/bin/sleep", ["5"], 100);

        expect(result.status).toBe("timed_out");
        expect(result.failureCode).toBe("timeout");
        expect(result.stdout).toHaveLength(0);
        expect(result.cleanupComplete).toBe(true);
        expect(result.invocationTokenAbsent).toBe(true);
    });

    it("retains only stderr from a naturally reaped non-zero exit", async () => {
        const result = await invoke("/bin/sh", ["-c", "printf hidden; printf unsupported-command >&2; sleep 0.05; exit 7"]);

        expect(result).toMatchObject({
            status: "failed",
            exitCode: 7,
            signal: null,
            failureCode: "exit",
            cleanupComplete: true,
            invocationTokenAbsent: true,
        });
        expect(result.stdout).toHaveLength(0);
        expect(new TextDecoder().decode(result.stderr)).toBe("unsupported-command");
    });

    it("fails closed for output overflow and invalid caller-controlled inputs", async () => {
        const result = await invoke("/bin/sh", ["-c", `printf %s ${"x".repeat(2_048)}; sleep 0.05`], 2_000, 64);
        expect(result.status).toBe("failed");
        expect(result.failureCode).toBe("output_limit");
        expect(result.stdout).toHaveLength(0);

        const root = fs.mkdtempSync(`${os.tmpdir()}/oaam-owned-invocation-invalid-`);
        await expect(
            invokeLocalExecutableTreeBounded(
                fs.realpathSync("/bin/echo"),
                inspectRegularFileNoFollow(fs.realpathSync("/bin/echo")),
                [""],
                root,
                [{ name: "OAAM_INVOCATION_TOKEN", value: "caller-controlled" }],
                crypto.randomBytes(32).toString("hex"),
                100,
                64,
            ),
        ).rejects.toThrow(TypeError);
        await expect(
            invokeLocalExecutableTreeBounded(
                fs.realpathSync("/bin/echo"),
                inspectRegularFileNoFollow(fs.realpathSync("/bin/echo")),
                [""],
                root,
                [{ name: "oaam_invocation_token", value: "caller-controlled" }],
                crypto.randomBytes(32).toString("hex"),
                100,
                64,
            ),
        ).rejects.toThrow(TypeError);
        await expect(
            invokeLocalExecutableTreeBounded(
                fs.realpathSync("/bin/echo"),
                inspectRegularFileNoFollow(fs.realpathSync("/bin/echo")),
                [""],
                root,
                [
                    { name: "PATH", value: "/usr/bin" },
                    { name: "Path", value: "/foreign" },
                ],
                crypto.randomBytes(32).toString("hex"),
                100,
                64,
            ),
        ).rejects.toThrow(TypeError);
        fs.rmSync(root, { recursive: true, force: true });
    });
});

async function invoke(
    executablePath: string,
    arguments_: readonly string[],
    timeoutMilliseconds = 2_000,
    maximumOutputBytes = 4_096,
) {
    const root = fs.mkdtempSync(`${os.tmpdir()}/oaam-owned-invocation-`);
    try {
        const physicalExecutablePath = fs.realpathSync(executablePath);
        return await invokeLocalExecutableTreeBounded(
            physicalExecutablePath,
            inspectRegularFileNoFollow(physicalExecutablePath),
            arguments_,
            root,
            [{ name: "PATH", value: process.env.PATH ?? "/usr/bin:/bin" }],
            crypto.randomBytes(32).toString("hex"),
            timeoutMilliseconds,
            maximumOutputBytes,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
