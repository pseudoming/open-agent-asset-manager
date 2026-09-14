import { describe, expect, it, vi } from "vitest";
import type { LocalExecutableTreeInvocationResult } from "@oaam/shared/paths";
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { resolveInstalledRestrictedCode, resolveInstalledRestrictedCodeForTest } from "../src/restricted-package-location";

const root = "C:\\Program Files\\OAAM\\resources\\app.asar.unpacked\\node_modules\\@oaam\\app-server-host\\dist\\restricted-wsl";
const identity: PhysicalPathIdentity = { deviceId: "1", fileId: "2", entryKind: "file" };
function fixture() {
    const manifest = {
        schemaVersion: 1,
        platform: "linux",
        architecture: "x64",
        nodeVersion: "22.14.0",
        nodeModulesVersion: "127",
        files: ["node", "restricted-wsl.cjs"].map((relativePath) => ({
            relativePath,
            bytes: 1,
            sha256: "a".repeat(64),
            executable: relativePath === "node",
        })),
    };
    const result: LocalExecutableTreeInvocationResult = {
        status: "complete",
        exitCode: 0,
        signal: null,
        stdout: Buffer.from("/custom-drives/c/Program Files/OAAM/code\n"),
        stderr: Buffer.alloc(0),
        rootProcess: { processId: 1, lifecycleToken: "1" },
        observedProcesses: [{ processId: 1, lifecycleToken: "1" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
    };
    const dependencies = {
        packageRootPath: root,
        environment: { SystemRoot: "C:\\WINDOWS" },
        readManifest: vi.fn(() => ({ bytes: Buffer.from(JSON.stringify(manifest)), identity, executable: false })),
        inspectExecutable: vi.fn(() => identity),
        invoke: vi.fn(async () => result),
    };
    return { manifest, result, dependencies };
}

describe("installed restricted code location", () => {
    it("rejects the production Windows entry from a nonphysical installation before filesystem or process access", async () => {
        const runtime = Object.create(process) as NodeJS.Process;
        Object.defineProperty(runtime, "platform", { value: "win32" });
        vi.stubGlobal("process", runtime);
        try {
            await expect(resolveInstalledRestrictedCode("Ubuntu")).rejects.toThrow("physical Windows installation directory");
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it("resolves the selected distro's actual mount with a fixed owned command and preserves the full manifest", async () => {
        const f = fixture();
        const actual = await resolveInstalledRestrictedCodeForTest("Ubuntu", f.dependencies);
        expect(actual.code.rootPath).toBe("/custom-drives/c/Program Files/OAAM/code");
        expect(actual.code.manifest).toEqual(f.manifest);
        expect(Object.isFrozen(actual.code.manifest.files[0])).toBe(true);
        expect(f.dependencies.readManifest).toHaveBeenCalledWith(root + "\\manifest.json", 64 * 1024);
        expect(f.dependencies.inspectExecutable).toHaveBeenCalledWith("C:\\WINDOWS\\System32\\wsl.exe");
        expect(f.dependencies.invoke).toHaveBeenCalledWith(
            "C:\\WINDOWS\\System32\\wsl.exe",
            identity,
            ["-d", "Ubuntu", "--exec", "/usr/bin/env", "-i", "LC_ALL=C", "/usr/bin/wslpath", "-a", "-u", "--", root + "\\code"],
            "C:\\WINDOWS\\System32",
            [
                { name: "SystemRoot", value: "C:\\WINDOWS" },
                { name: "WINDIR", value: "C:\\WINDOWS" },
            ],
            expect.stringMatching(/^[a-f0-9]{64}$/u),
            10_000,
            32_768,
        );
    });

    it.each([
        "../foreign",
        "Ubuntu\nother",
        "",
    ])("rejects invalid distribution %j before package read or launch", async (distro) => {
        const f = fixture();
        await expect(resolveInstalledRestrictedCodeForTest(distro, f.dependencies)).rejects.toMatchObject({
            cleanupConfirmed: true,
        });
        expect(f.dependencies.readManifest).not.toHaveBeenCalled();
        expect(f.dependencies.invoke).not.toHaveBeenCalled();
    });

    it.each([
        "C:relative",
        "\\\\server\\share\\code",
        root.replace("app.asar.unpacked", "app.asar"),
        root + "\\..",
        root + "\0",
    ])("rejects nonphysical or ambiguous package location %j without launching", async (packageRootPath) => {
        const f = fixture();
        await expect(
            resolveInstalledRestrictedCodeForTest("Ubuntu", { ...f.dependencies, packageRootPath }),
        ).rejects.toMatchObject({ cleanupConfirmed: true });
        expect(f.dependencies.invoke).not.toHaveBeenCalled();
    });

    it.each([
        "missing_manifest",
        "bad_json",
        "foreign_arch",
        "missing_node",
        "bad_system_root",
        "nonfile_executable",
    ])("rejects %s before any mapping process", async (scenario) => {
        const f = fixture();
        if (scenario === "missing_manifest")
            f.dependencies.readManifest.mockImplementation(() => {
                throw new Error("missing");
            });
        if (scenario === "bad_json")
            f.dependencies.readManifest.mockReturnValue({ bytes: Buffer.from("{"), identity, executable: false });
        if (scenario === "foreign_arch") f.manifest.architecture = "other";
        if (scenario === "missing_node") f.manifest.files.shift();
        if (scenario === "bad_system_root") f.dependencies.environment.SystemRoot = "C:\\foreign";
        if (scenario === "nonfile_executable")
            f.dependencies.inspectExecutable.mockReturnValue({ ...identity, entryKind: "directory" });
        await expect(resolveInstalledRestrictedCodeForTest("Ubuntu", f.dependencies)).rejects.toMatchObject({
            cleanupConfirmed: true,
        });
        expect(f.dependencies.invoke).not.toHaveBeenCalled();
    });

    it.each([
        "failed",
        "timed_out",
        "exit",
        "signal",
        "failure_code",
        "stderr",
        "cleanup",
        "token",
    ])("does not accept %s as a usable mapping", async (scenario) => {
        const f = fixture();
        const result = { ...f.result };
        if (scenario === "failed" || scenario === "timed_out") result.status = scenario;
        if (scenario === "exit") result.exitCode = 1;
        if (scenario === "signal") result.signal = "SIGTERM";
        if (scenario === "failure_code") result.failureCode = "runtime_root_not_observed";
        if (scenario === "stderr") result.stderr = Buffer.from("warning");
        if (scenario === "cleanup") result.cleanupComplete = false;
        if (scenario === "token") result.invocationTokenAbsent = false;
        f.dependencies.invoke.mockResolvedValue(result);
        await expect(resolveInstalledRestrictedCodeForTest("Ubuntu", f.dependencies)).rejects.toMatchObject({
            cleanupConfirmed: scenario !== "cleanup" && scenario !== "token",
        });
        expect(f.dependencies.invoke).toHaveBeenCalledTimes(1);
    });

    it.each([
        "",
        "/code",
        "/code\n/foreign\n",
        "/code\r\n",
        "relative\n",
        "/code/../foreign\n",
        "/\n",
        "/code\0\n",
    ])("rejects malformed returned path %j after confirmed cleanup", async (output) => {
        const f = fixture();
        f.dependencies.invoke.mockResolvedValue({ ...f.result, stdout: Buffer.from(output) });
        await expect(resolveInstalledRestrictedCodeForTest("Ubuntu", f.dependencies)).rejects.toMatchObject({
            cleanupConfirmed: true,
        });
    });

    it("keeps unexpected invocation rejection cleanup-uncertain", async () => {
        const f = fixture();
        f.dependencies.invoke.mockRejectedValue(new Error("lost invocation owner"));
        await expect(resolveInstalledRestrictedCodeForTest("Ubuntu", f.dependencies)).rejects.toMatchObject({
            cleanupConfirmed: false,
        });
    });

    it.skipIf(process.platform === "win32")("does not start the Windows package resolver on a native Unix host", async () => {
        await expect(resolveInstalledRestrictedCode("Ubuntu")).rejects.toThrow("owned by the Windows Host");
    });
});
