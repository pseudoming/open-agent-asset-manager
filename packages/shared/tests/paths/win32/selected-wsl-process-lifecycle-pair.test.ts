import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { observeSelectedWslProcessLifecyclePairBounded as unixObserve } from "../../../src/paths/unix-like/selected-wsl-process";
import { createWin32SelectedWslProcessLifecyclePairMechanics } from "../../../src/paths/win32/selected-wsl-process-lifecycle-pair";

const IDS = [42, 41] as const;
function stat(pid: number, token = String(pid * 100), comm = "node", state = "S"): string {
    return `${pid} (${comm}) ${state} ${new Array(18).fill("0").join(" ")} ${token} 0 -1\n`;
}
const valid = () => IDS.flatMap((pid) => [stat(pid), stat(pid)]).join("");
function fixture(output: Buffer | string | Error = Buffer.from(valid()), now = () => 100) {
    const executeFileSync = vi.fn(() => {
        if (output instanceof Error) throw output;
        return output;
    });
    const mechanics = createWin32SelectedWslProcessLifecyclePairMechanics({ executeFileSync, now });
    return {
        executeFileSync,
        mechanics,
        read: () => mechanics.observeSelectedWslProcessLifecyclePairBounded("Ubuntu", IDS, 2_000),
    };
}

describe("present selected-WSL lifecycle pair", () => {
    it("observes both PIDs twice in one fixed, selected-distribution command", () => {
        const f = fixture();
        expect(f.read()).toEqual(IDS.map((processId) => ({ processId, lifecycleToken: String(processId * 100) })));
        expect(f.executeFileSync).toHaveBeenCalledOnce();
        expect(f.executeFileSync).toHaveBeenCalledWith(
            "wsl.exe",
            [
                "-d",
                "Ubuntu",
                "--exec",
                "/usr/bin/env",
                "-i",
                "LC_ALL=C",
                "LANG=C",
                "/bin/cat",
                "--",
                "/proc/42/stat",
                "/proc/42/stat",
                "/proc/41/stat",
                "/proc/41/stat",
            ],
            { timeout: 2_000, maxBuffer: 65_537, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
    });

    it("validates text command results through the same record parser", () => {
        expect(fixture(valid()).read()).toEqual(fixture().read());
    });

    it("passes a valid distribution spelling as one literal argument without a shell", () => {
        const f = fixture();
        f.mechanics.observeSelectedWslProcessLifecyclePairBounded("Ubuntu;false", IDS, 2_000);
        expect(f.executeFileSync).toHaveBeenCalledWith("wsl.exe", expect.arrayContaining(["Ubuntu;false"]), expect.any(Object));
    });

    it.each(["R", "Z", "X", "t"])("retains the present %s state across a same-lifecycle name change", (state) => {
        const text = IDS.flatMap((pid) => [
            stat(pid, undefined, "old ) name"),
            stat(pid, undefined, "new executable", state),
        ]).join("");
        expect(fixture(Buffer.from(text)).read()).toEqual(
            IDS.map((processId) => ({ processId, lifecycleToken: String(processId * 100) })),
        );
    });

    it.each([
        "line\nbreak",
        "x) S 0\n42 (",
        "a) R 1 2) S 3",
        "任务名",
        "123456789012345",
    ])("preserves a bounded comm containing %j", (comm) => {
        const text = IDS.flatMap((pid) => [stat(pid, undefined, comm), stat(pid)]).join("");
        expect(fixture(Buffer.from(text)).read()).toHaveLength(2);
    });

    it.each([0, 1])("rejects a before/after birth change for requested PID index %i", (index) => {
        const records = IDS.flatMap((pid) => [stat(pid), stat(pid)]);
        records[index * 2 + 1] = stat(IDS[index]!, "9999");
        expect(fixture(Buffer.from(records.join(""))).read).toThrow(
            expect.objectContaining({ failureKind: "stale", systemCode: "WSL_PROCESS_TRANSITION" }),
        );
    });

    it.each([
        ["truncated tail", valid().slice(0, -2)],
        ["missing record", stat(42) + stat(42) + stat(41)],
        ["extra record", valid() + stat(41)],
        ["extra whitespace", valid() + "\n"],
        ["foreign PID", stat(43) + stat(42) + stat(41) + stat(41)],
        ["reordered PID", stat(41) + stat(41) + stat(42) + stat(42)],
        ["duplicate PID set", stat(42).repeat(4)],
        ["incomplete fields", "42 (node) S 0\n" + stat(42) + stat(41).repeat(2)],
        ["signed birth", stat(42, "+4200").repeat(2) + stat(41).repeat(2)],
        ["non-numeric field", valid().replace("S 0", "S word")],
        ["overlong comm", stat(42, undefined, "a".repeat(16)).repeat(2) + stat(41).repeat(2)],
        ["overlong UTF-8 comm", stat(42, undefined, "任务名重复字").repeat(2) + stat(41).repeat(2)],
        ["forged complete record inside comm", stat(42, undefined, stat(41)).repeat(2) + stat(41).repeat(2)],
        ["NUL", valid().replace("node", "no\0de")],
        ["byte-order mark", "\uFEFF" + valid()],
    ])("fails closed on %s", (_name, text) => {
        expect(fixture(Buffer.from(text!)).read).toThrow(expect.objectContaining({ failureKind: "io_error" }));
    });

    it("rejects invalid UTF-8 rather than replacing bytes", () => {
        expect(fixture(Buffer.from([0xff])).read).toThrow(expect.objectContaining({ systemCode: "INVALID_UTF8" }));
    });

    it.each([
        ["whole output", Buffer.alloc(65_537)],
        ["individual record", Buffer.from(stat(42, "1".repeat(16_384)) + stat(42) + stat(41).repeat(2))],
    ])("bounds %s bytes", (_name, bytes) => {
        expect(fixture(bytes as Buffer).read).toThrow(expect.objectContaining({ failureKind: "resource_limit" }));
    });

    it.each([
        [
            "missing child",
            Object.assign(new Error("cat failed"), {
                status: 1,
                signal: null,
                stdout: Buffer.from(stat(41).repeat(2)),
                stderr: Buffer.from("/bin/cat: /proc/42/stat: No such file or directory\n"),
            }),
            "io_error",
        ],
        [
            "missing parent",
            Object.assign(new Error("cat failed"), {
                status: 1,
                signal: null,
                stdout: Buffer.from(stat(42).repeat(2)),
                stderr: Buffer.from("/bin/cat: /proc/41/stat: No such file or directory\n"),
            }),
            "io_error",
        ],
        ["unknown exit", Object.assign(new Error("cat failed"), { status: 2 }), "io_error"],
        ["unavailable command", Object.assign(new Error("missing"), { code: "ENOENT" }), "unsupported_platform"],
        ["denied", Object.assign(new Error("denied"), { code: "EACCES" }), "permission_denied"],
        ["timeout", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), "stale"],
        ["killed", Object.assign(new Error("killed"), { killed: true }), "stale"],
        ["signal", Object.assign(new Error("signal"), { signal: "SIGTERM" }), "io_error"],
        ["output cap", Object.assign(new Error("full"), { code: "ENOBUFS" }), "resource_limit"],
    ])("never accepts partial output or absence after %s", (_name, error, failureKind) => {
        const f = fixture(error as Error);
        expect(f.read).toThrow(expect.objectContaining({ failureKind }));
        expect(f.executeFileSync).toHaveBeenCalledOnce();
    });

    it("uses the remaining shared deadline and checks settlement", () => {
        const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125).mockReturnValueOnce(200);
        const f = fixture(Buffer.from(valid()), clock);
        expect(f.read()).toHaveLength(2);
        expect(f.executeFileSync).toHaveBeenCalledWith("wsl.exe", expect.any(Array), expect.objectContaining({ timeout: 1_975 }));
    });

    it.each(["before", "after"])("rejects a deadline exceeded %s the command", (when) => {
        const clock = vi
            .fn()
            .mockReturnValueOnce(100)
            .mockReturnValueOnce(when === "before" ? 2_100 : 100)
            .mockReturnValueOnce(2_100);
        const f = fixture(Buffer.from(valid()), clock);
        expect(f.read).toThrow(expect.objectContaining({ failureKind: "stale", systemCode: "ETIMEDOUT" }));
        expect(f.executeFileSync).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    });

    it.each([
        [" Ubuntu", IDS, 2_000],
        ["Ubuntu/other", IDS, 2_000],
        ["Ubuntu\\other", IDS, 2_000],
        ["Ubuntu", [], 2_000],
        ["Ubuntu", [42], 2_000],
        ["Ubuntu", [42, 41, 40], 2_000],
        ["Ubuntu", null, 2_000],
        ["Ubuntu", [42, 42], 2_000],
        ["Ubuntu", [0, 41], 2_000],
        ["Ubuntu", [42, 1.5], 2_000],
        ["Ubuntu", IDS, 0],
        ["Ubuntu", IDS, Number.MAX_SAFE_INTEGER],
    ])("validates %j %j %j before invoking a command", (distro, ids, timeout) => {
        const f = fixture();
        expect(() =>
            f.mechanics.observeSelectedWslProcessLifecyclePairBounded(
                distro as string,
                ids as readonly [number, number],
                timeout as number,
            ),
        ).toThrow();
        expect(f.executeFileSync).not.toHaveBeenCalled();
    });

    it("does not add cross-WSL behavior to the Unix-like build", () => {
        expect(() => unixObserve("Ubuntu", IDS, 2_000)).toThrow(expect.objectContaining({ failureKind: "unsupported_platform" }));
        expect(() => unixObserve("Ubuntu", [42, 42], 2_000)).toThrow(RangeError);
    });

    it.skipIf(process.platform !== "linux")(
        "parses actual current-process and parent stat bytes through the fixed cat arguments",
        () => {
            const mechanics = createWin32SelectedWslProcessLifecyclePairMechanics({
                executeFileSync(command, args, options) {
                    expect(command).toBe("wsl.exe");
                    expect(args.slice(0, 9)).toEqual([
                        "-d",
                        "Ubuntu",
                        "--exec",
                        "/usr/bin/env",
                        "-i",
                        "LC_ALL=C",
                        "LANG=C",
                        "/bin/cat",
                        "--",
                    ]);
                    return execFileSync("/bin/cat", ["--", ...args.slice(9)], {
                        timeout: options.timeout,
                        maxBuffer: options.maxBuffer,
                    });
                },
            });
            expect(mechanics.observeSelectedWslProcessLifecyclePairBounded("Ubuntu", [process.pid, process.ppid], 2_000)).toEqual(
                [
                    { processId: process.pid, lifecycleToken: expect.stringMatching(/^[0-9]+$/u) },
                    { processId: process.ppid, lifecycleToken: expect.stringMatching(/^[0-9]+$/u) },
                ],
            );
        },
    );
});
