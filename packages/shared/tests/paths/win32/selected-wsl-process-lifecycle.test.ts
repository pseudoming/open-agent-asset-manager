import { describe, expect, it, vi } from "vitest";
import { SafeFilesystemError } from "../../../src/filesystem/filesystem-types";
import { observeSelectedWslProcessLifecycleBounded as unixObserve } from "../../../src/paths/unix-like/selected-wsl-process";
import { createWin32SelectedWslProcessLifecycleMechanics } from "../../../src/paths/win32/selected-wsl-process-lifecycle";

const DISTRO = "Ubuntu";
const PID = 42;
const MISSING = `/bin/cat: /proc/${PID}/stat: No such file or directory\n`;

function stat(token = "4200", state = "S", processId = PID, comm = "node") {
    return Buffer.from(`${processId} (${comm}) ${state} ${new Array(18).fill("0").join(" ")} ${token}\n`);
}

function failure(stderr = MISSING, overrides: Record<string, unknown> = {}): Error {
    return Object.assign(new Error("fixed WSL command failed"), {
        status: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(stderr),
        ...overrides,
    });
}

function fixture(outputs: readonly (Buffer | Error)[], now = () => 100) {
    let index = 0;
    const executeFileSync = vi.fn((_command: string, _args: readonly string[], _options: unknown) => {
        const output = outputs[index++];
        if (output === undefined) throw new Error("unexpected command");
        if (output instanceof Error) throw output;
        return output;
    });
    const mechanics = createWin32SelectedWslProcessLifecycleMechanics({ executeFileSync, now });
    return { executeFileSync, read: () => mechanics.observeSelectedWslProcessLifecycleBounded(DISTRO, PID, 2_000) };
}

describe("exact selected-WSL process lifecycle", () => {
    it.each(["S", "R", "Z", "X"])("retains a present %s process without requiring an executable link", (state) => {
        const { read, executeFileSync } = fixture([stat("4200", state), stat("4200", state)]);
        expect(read()).toEqual({ processId: PID, lifecycleToken: "4200" });
        expect(executeFileSync).toHaveBeenCalledTimes(2);
        for (const [command, args, options] of executeFileSync.mock.calls) {
            expect(command).toBe("wsl.exe");
            expect(args).toEqual([
                "-d",
                DISTRO,
                "--exec",
                "/usr/bin/env",
                "-i",
                "LC_ALL=C",
                "LANG=C",
                "/bin/cat",
                "--",
                "/proc/42/stat",
            ]);
            expect(options).toEqual({ timeout: 2_000, maxBuffer: 16_385, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        }
    });

    it("retains a same-lifecycle exec or command-name change", () => {
        const { read } = fixture([stat("4200", "S", PID, "old ) name"), stat("4200", "R", PID, "new executable")]);
        expect(read()).toEqual({ processId: PID, lifecycleToken: "4200" });
    });

    it("returns absence only after two exact missing-stat observations", () => {
        const { read, executeFileSync } = fixture([failure(), failure()]);
        expect(read()).toBeNull();
        expect(executeFileSync).toHaveBeenCalledTimes(2);
    });

    it.each([
        [stat(), stat("4201")],
        [stat(), failure()],
        [failure(), stat()],
    ])("rejects lifecycle or presence transitions", (first, second) => {
        expect(fixture([first, second]).read).toThrow(
            expect.objectContaining({ failureKind: "stale", systemCode: "WSL_PROCESS_TRANSITION" }),
        );
    });

    it.each([
        failure("/bin/cat: /proc/42/stat: Permission denied\n"),
        failure("/bin/cat: /proc/43/stat: No such file or directory\n"),
        failure(MISSING + "unrelated failure\n"),
        failure(MISSING, { stdout: Buffer.from("partial") }),
        failure(MISSING, { status: 2 }),
        failure(MISSING, { killed: true }),
        failure(MISSING, { signal: "SIGTERM" }),
        failure(MISSING, { code: "ETIMEDOUT" }),
        failure(MISSING, { code: "ENOENT" }),
        failure(MISSING, { code: "ENOBUFS" }),
    ])("keeps ambiguous failures distinct from absent processes", (error) => {
        const { read, executeFileSync } = fixture([error]);
        expect(read).toThrow(SafeFilesystemError);
        expect(executeFileSync).toHaveBeenCalledTimes(1);
    });

    it.each([
        stat("not-a-token"),
        stat("4200", "S", 43),
        Buffer.from("42 (node) S 0\n"),
        Buffer.from([0xff]),
    ])("rejects incomplete, foreign or malformed stat data", (output) => {
        expect(fixture([output]).read).toThrow(expect.objectContaining({ failureKind: "io_error" }));
    });

    it("does not accept oversized output", () => {
        expect(fixture([Buffer.alloc(16_385)]).read).toThrow(expect.objectContaining({ failureKind: "resource_limit" }));
    });

    it("consumes one deadline across both observations", () => {
        const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValueOnce(2_101);
        const { read, executeFileSync } = fixture([stat()], clock);
        expect(read).toThrow(expect.objectContaining({ failureKind: "stale", systemCode: "ETIMEDOUT" }));
        expect(executeFileSync).toHaveBeenCalledTimes(1);
    });

    it.each([
        [" Ubuntu", PID, 2_000],
        ["Ubuntu/other", PID, 2_000],
        [DISTRO, 0, 2_000],
        [DISTRO, 1.5, 2_000],
        [DISTRO, PID, 0],
        [DISTRO, PID, Number.MAX_SAFE_INTEGER],
    ])("validates exact distribution, PID and time bounds before execution", (distro, pid, timeout) => {
        const executeFileSync = vi.fn(() => stat());
        const mechanics = createWin32SelectedWslProcessLifecycleMechanics({ executeFileSync });
        expect(() => mechanics.observeSelectedWslProcessLifecycleBounded(String(distro), Number(pid), Number(timeout))).toThrow();
        expect(executeFileSync).not.toHaveBeenCalled();
    });

    it("keeps cross-WSL mechanics unavailable in the Unix-like build", () => {
        expect(() => unixObserve(DISTRO, PID, 2_000)).toThrow(expect.objectContaining({ failureKind: "unsupported_platform" }));
        expect(() => unixObserve(DISTRO, 0, 2_000)).toThrow(RangeError);
    });
});
