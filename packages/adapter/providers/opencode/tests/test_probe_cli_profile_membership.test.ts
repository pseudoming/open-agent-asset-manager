import type { BigIntStats } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeOpenCodeCliVersionForTest } from "../src/opencode-probe-cli-version";

const frozenMetadata = vi.hoisted(() => new Map<string, BigIntStats>());
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        lstatSync: (file: fs.PathLike, options?: { bigint?: boolean }) =>
            (options?.bigint && frozenMetadata.get(String(file))) || actual.lstatSync(file, options),
    };
});
const roots: string[] = [];
afterEach(() => {
    frozenMetadata.clear();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-profile-membership-"));
    roots.push(root);
    const home = path.join(root, "home");
    const directories = [
        home,
        path.join(home, ".config/opencode"),
        path.join(home, ".local/share/opencode"),
        path.join(home, ".local/share/opencode/log"),
        path.join(home, ".local/share/opencode/repos"),
        path.join(home, ".cache/opencode"),
        path.join(home, ".cache/opencode/bin"),
        path.join(home, ".local/state/opencode"),
    ];
    for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
    return { root, home, directories, cache: path.join(home, ".cache/opencode") };
}
function observation(f: ReturnType<typeof fixture>, during: () => void) {
    const identity = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
    const build = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const invokeLocal = vi.fn(async () => {
        during();
        return {
            status: "complete" as const,
            exitCode: 0,
            signal: null,
            stdout: Buffer.from("1.18.11"),
            stderr: new Uint8Array(),
            rootProcess: { processId: 42, lifecycleToken: "fixture" },
            observedProcesses: [{ processId: 42, lifecycleToken: "fixture" }],
            cleanupComplete: true,
            invocationTokenAbsent: true,
            executableSha256: build,
            failureCode: "",
        };
    });
    return {
        invokeLocal,
        result: observeOpenCodeCliVersionForTest(
            { status: "available", evidence: [], diagnostics: [], executable: { path: path.join(f.root, "opencode"), identity } },
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: f.root },
            "linux",
            {},
            f.home,
            { snapshotExecutable: () => ({ identity, sha256: build }), invokeLocal },
        ),
    };
}
describe("OpenCode version profile directory membership", () => {
    it.each([
        "added",
        "removed",
        "kind_changed",
    ] as const)("rejects a real %s member when every directory metadata field remains equal", async (change) => {
        const f = fixture();
        const target = path.join(f.cache, "probe-residue");
        if (change !== "added") fs.writeFileSync(target, "initial");
        for (const directory of f.directories) frozenMetadata.set(directory, fs.lstatSync(directory, { bigint: true }));
        const before = fs.readdirSync(f.cache, { withFileTypes: true }).map((entry) => [entry.name, entry.isDirectory()]);
        const { result, invokeLocal } = observation(f, () => {
            if (change === "added") fs.writeFileSync(target, "unexpected", { flag: "wx" });
            else {
                fs.unlinkSync(target);
                if (change === "kind_changed") fs.mkdirSync(target);
            }
            expect(
                fs.readdirSync(f.cache, { withFileTypes: true }).map((entry) => [entry.name, entry.isDirectory()]),
            ).not.toEqual(before);
            for (const directory of f.directories)
                expect(fs.lstatSync(directory, { bigint: true })).toBe(frozenMetadata.get(directory));
        });
        const observed = await result;
        expect(invokeLocal).toHaveBeenCalledOnce();
        expect(observed).toMatchObject({ versionText: "", buildIdentity: "sha256:" + "a".repeat(64) });
        expect(observed.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_profile_changed", causeKind: "version_incompatible" }),
        );
    });
    it("accepts an unchanged profile containing a child link without following its target", async () => {
        const f = fixture();
        const outside = path.join(f.root, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "private-body"), "never read");
        fs.symlinkSync(outside, path.join(f.home, "linked"), "junction");
        const { result, invokeLocal } = observation(f, () => {});
        expect((await result).versionText).toBe("1.18.11");
        expect(invokeLocal).toHaveBeenCalledOnce();
    });
    it("does not invoke the executable when a profile directory exceeds the 4096-member budget", async () => {
        const f = fixture();
        for (let index = 0; index < 4096; index++) fs.writeFileSync(path.join(f.cache, "member-" + index), "");
        expect(fs.readdirSync(f.cache)).toHaveLength(4097); // Includes the existing bin directory.
        const { result, invokeLocal } = observation(f, () => {});
        const observed = await result;
        expect(invokeLocal).not.toHaveBeenCalled();
        expect(observed.versionText).toBe("");
        expect(observed.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_profile_unavailable" }),
        );
    });
});
