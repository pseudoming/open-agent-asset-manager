import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as filesystem from "@oaam/shared/filesystem";
import * as paths from "@oaam/shared/paths";
import {
    runRestrictedServiceProcess,
    runRestrictedServiceProcessForTest,
    type RestrictedServiceComposition,
} from "../src/restricted-service-process";
import type { RestrictedCodePackage } from "../src/restricted-code-package";
import { restrictedCodeLaunchBinding, verifyRestrictedLoadedEntry } from "../src/restricted-code-admission";

vi.mock("@oaam/shared/filesystem", async (original) => ({ ...(await original<object>()) }));
vi.mock("@oaam/shared/paths", async (original) => ({ ...(await original<object>()) }));

const actualProcess = process;
const roots: string[] = [];
const streams: PassThrough[] = [];
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const stream of streams.splice(0)) stream.destroy();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-service-entry-control-"));
    roots.push(rootPath);
    const files = ["node", "restricted-wsl.cjs"].map((relativePath) => {
        const bytes = Buffer.from(`owned ${relativePath}`);
        fs.writeFileSync(path.join(rootPath, relativePath), bytes, { mode: relativePath === "node" ? 0o700 : 0o600 });
        return {
            relativePath,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            executable: relativePath === "node",
        };
    });
    const code: RestrictedCodePackage = {
        rootPath,
        manifest: {
            schemaVersion: 1,
            platform: "linux",
            architecture: "x64",
            nodeVersion: actualProcess.versions.node,
            nodeModulesVersion: actualProcess.versions.modules,
            files,
        },
    };
    const session = { protocol: "test.service.v1", hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const operation = { kind: "component-control" };
    const stdin = new PassThrough(),
        stdout = new PassThrough();
    streams.push(stdin, stdout);
    const lines: Record<string, unknown>[] = [];
    stdout.on("data", (bytes: Buffer) => {
        for (const line of bytes.toString("utf8").trim().split("\n")) lines.push(JSON.parse(line));
    });
    // Only process metadata/identity observation is substituted. Package inventory,
    // bytes, manifest validation and inherited-stream entry execute their original owners.
    const runtime = Object.create(actualProcess) as NodeJS.Process;
    Object.defineProperties(runtime, {
        platform: { value: "linux", configurable: true },
        arch: { value: "x64", configurable: true },
        execPath: { value: path.join(rootPath, "node"), writable: true },
        argv: { value: [path.join(rootPath, "node"), path.join(rootPath, "restricted-wsl.cjs"), ""], writable: true },
        stdin: { value: stdin },
        stdout: { value: stdout },
        exitCode: { value: undefined, writable: true },
    });
    vi.stubGlobal("process", runtime);
    const identity = vi
        .spyOn(paths, "observeLocalProcessExecutableBounded")
        .mockImplementation((pid, _executable, executableIdentity) => ({
            processId: pid,
            lifecycleToken: String(pid),
            executableIdentity,
            commandLineBytes: new Uint8Array(),
        }));
    const encode = (value: unknown) => {
        runtime.argv[2] = Buffer.from(JSON.stringify(value)).toString("base64");
    };
    encode({ code, session, operation });
    const service = { handle: vi.fn((value: unknown) => ({ accepted: value })), close: vi.fn() };
    const composition: RestrictedServiceComposition = {
        service,
        session,
        deadlineAt: Date.now() + 60_000,
        maximumFrameBytes: 4096,
        maximumConcurrentRequests: 1,
    };
    const compose = vi.fn(() => composition);
    return { code, session, operation, runtime, stdin, lines, service, composition, compose, identity, encode };
}

describe("original restricted Linux service entry with owned files and streams", () => {
    it("refuses an entry that has no declared manifest file before reading its bytes", () => {
        const f = fixture();
        const read = vi.spyOn(filesystem, "readRegularFileNoFollow");
        const code = { ...f.code, manifest: { ...f.code.manifest, files: f.code.manifest.files.slice(0, 1) } };
        expect(() => verifyRestrictedLoadedEntry(code, f.runtime.argv[1]!)).toThrow("absent from its manifest");
        expect(read).not.toHaveBeenCalled();
    });

    it("checks the executing entry after Windows verification while retaining Linux compatibility and session checks", async () => {
        const f = fixture();
        f.encode({
            code: f.code,
            session: f.session,
            operation: f.operation,
            windowsCodeVerification: { bindingHash: restrictedCodeLaunchBinding(f.code, f.session) },
        });
        const read = vi.spyOn(filesystem, "readRegularFileNoFollow");
        const inventory = vi.spyOn(filesystem, "inventoryDirectoryNoFollow");
        const completion = runRestrictedServiceProcessForTest(f.compose, f.runtime.argv[1]!);
        await Promise.resolve();
        expect(f.lines.map((line) => line.kind)).toEqual(["owned", "ready"]);
        expect(read.mock.calls.map(([file]) => file)).toEqual([f.runtime.argv[1]]);
        expect(inventory).not.toHaveBeenCalled();
        expect(f.lines[1]).toMatchObject({
            startupTiming: {
                runtimeValidationMilliseconds: expect.any(Number),
                codeVerificationMilliseconds: expect.any(Number),
            },
        });
        f.stdin.end();
        await completion;
        expect(f.runtime.exitCode).toBeUndefined();
        expect(f.service.close).toHaveBeenCalledOnce();
    });

    it.each([
        "binding",
        "root",
        "manifest",
        "session",
        "shape",
        "entry_path",
        "old_entry",
        "entry_length",
        "architecture",
        "node",
        "abi",
    ] as const)("rejects %s despite a claimed Windows verification", async (failure) => {
        const f = fixture();
        let bindingHash = restrictedCodeLaunchBinding(f.code, f.session);
        let loadedEntryPath = f.runtime.argv[1]!;
        if (failure === "binding") bindingHash = "0".repeat(64);
        if (failure === "root") bindingHash = restrictedCodeLaunchBinding({ ...f.code, rootPath: "/foreign/code" }, f.session);
        if (failure === "manifest")
            bindingHash = restrictedCodeLaunchBinding(
                { ...f.code, manifest: { ...f.code.manifest, nodeModulesVersion: "999" } },
                f.session,
            );
        if (failure === "session") bindingHash = restrictedCodeLaunchBinding(f.code, { ...f.session, sessionId: randomUUID() });
        if (failure === "entry_path") loadedEntryPath = "/foreign/code/restricted-wsl.cjs";
        if (failure === "old_entry") fs.writeFileSync(loadedEntryPath, "X".repeat(f.code.manifest.files[1]!.bytes));
        if (failure === "entry_length") fs.writeFileSync(loadedEntryPath, "short");
        if (failure === "architecture") Object.defineProperty(f.runtime, "arch", { value: "arm64" });
        if (failure === "node" || failure === "abi")
            Object.defineProperty(f.runtime, "versions", {
                value: { ...actualProcess.versions, [failure === "node" ? "node" : "modules"]: "999" },
            });
        f.encode({
            code: f.code,
            session: f.session,
            operation: f.operation,
            windowsCodeVerification: failure === "shape" ? { bindingHash, extra: true } : { bindingHash },
        });
        await runRestrictedServiceProcessForTest(f.compose, loadedEntryPath);
        expect(f.runtime.exitCode).toBe(71);
        expect(f.lines.map((line) => line.kind)).toEqual(["owned", "startup-failure"]);
        expect(f.compose).not.toHaveBeenCalled();
        expect(f.stdin.destroyed).toBe(true);
        if (failure === "old_entry") expect(f.lines[1]).toMatchObject({ failureCode: "digest_mismatch" });
        if (failure === "entry_length") expect(f.lines[1]).toMatchObject({ failureCode: "metadata_changed" });
    });

    it.each(["shutdown", "eof", "idle"] as const)("publishes owned then ready and confirms %s", async (terminal) => {
        if (terminal === "idle") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const f = fixture();
        const completion = runRestrictedServiceProcess(f.compose);
        await Promise.resolve();
        expect(f.compose).toHaveBeenCalledWith(f.operation);
        expect(f.lines.map((line) => line.kind)).toEqual(["owned", "ready"]);
        expect(f.lines[1]).toMatchObject({
            processIdentity: { processId: actualProcess.pid, parentIdentity: { processId: actualProcess.ppid } },
            startupTiming: { processMaximumRssKiB: expect.any(Number) },
        });
        if (terminal === "shutdown") {
            f.stdin.write('{"value":"once"}\n');
            f.stdin.write(JSON.stringify({ kind: "shutdown", ...f.session }) + "\n");
            expect(f.service.handle).toHaveBeenCalledOnce();
            expect(f.service.handle).toHaveBeenCalledWith({ value: "once" });
        } else if (terminal === "eof") f.stdin.end();
        else await vi.advanceTimersByTimeAsync(30_000);
        await completion;
        expect(f.runtime.exitCode).toBeUndefined();
        expect(f.stdin.destroyed).toBe(true);
        expect(f.service.close).toHaveBeenCalledOnce();
    });

    it.each(["invalid", "deadline"] as const)("returns failure exit for %s after readiness", async (terminal) => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const f = fixture();
        f.composition.deadlineAt = Date.now() + 1000;
        const completion = runRestrictedServiceProcess(f.compose);
        await Promise.resolve();
        if (terminal === "invalid") f.stdin.end("broken\n");
        else await vi.advanceTimersByTimeAsync(1000);
        await completion;
        expect(f.runtime.exitCode).toBe(72);
        expect(f.lines.map((line) => line.kind)).toEqual(["owned", "ready"]);
        expect(f.service.handle).not.toHaveBeenCalled();
    });

    it.each([
        undefined,
        "",
        "A".repeat(24_001),
        "@",
        "e30",
        "//==",
        Buffer.from([255]).toString("base64"),
        Buffer.from("invalid-json").toString("base64"),
    ])("rejects configuration encoding %j before ownership", async (encoded) => {
        const f = fixture();
        f.runtime.argv = encoded === undefined ? f.runtime.argv.slice(0, 2) : [...f.runtime.argv.slice(0, 2), encoded];
        await runRestrictedServiceProcess(f.compose);
        expect(f.runtime.exitCode).toBe(71);
        expect(f.lines).toEqual([]);
        expect(f.compose).not.toHaveBeenCalled();
        expect(f.stdin.destroyed).toBe(true);
    });

    it.each([
        null,
        1,
        [],
        {},
        { code: {}, operation: {}, session: {}, extra: true },
    ])("rejects invalid launch shape %j", async (configuration) => {
        const f = fixture();
        f.encode(configuration);
        await runRestrictedServiceProcess(f.compose);
        expect(f.runtime.exitCode).toBe(71);
        expect(f.lines).toEqual([]);
        expect(f.identity).not.toHaveBeenCalled();
    });

    it.each([
        "platform",
        "entry",
        "executable",
        "directory",
        "identity",
    ] as const)("rejects %s identity before publishing ownership", async (failure) => {
        const f = fixture();
        if (failure === "platform") Object.defineProperty(f.runtime, "platform", { value: "darwin" });
        if (failure === "entry") f.runtime.argv[1] += ".foreign";
        if (failure === "executable") f.runtime.execPath += ".foreign";
        if (failure === "directory")
            vi.spyOn(filesystem, "inspectRegularFileNoFollow").mockReturnValue(
                filesystem.inspectDirectoryNoFollow(f.code.rootPath),
            );
        if (failure === "identity") f.identity.mockReturnValue(null);
        await runRestrictedServiceProcess(f.compose);
        expect(f.runtime.exitCode).toBe(71);
        expect(f.lines).toEqual([]);
        expect(f.compose).not.toHaveBeenCalled();
    });

    it.each([
        null,
        1,
        {},
        { protocol: 1 },
        { protocol: "x".repeat(129) },
        { hostInstanceId: "foreign" },
        { sessionId: "foreign" },
    ])("rejects malformed session %j before ownership", async (change) => {
        const f = fixture();
        const session =
            change !== null && typeof change === "object" && Object.keys(change).length > 0
                ? { ...f.session, ...change }
                : change;
        f.encode({ code: f.code, operation: f.operation, session });
        await runRestrictedServiceProcess(f.compose);
        expect(f.runtime.exitCode).toBe(71);
        expect(f.lines).toEqual([]);
        expect(f.compose).not.toHaveBeenCalled();
    });

    it.each([
        "digest",
        "mode",
        "compose",
        "protocol",
        "host",
        "session",
    ] as const)("preserves owned identity and typed %s startup failure", async (failure) => {
        const f = fixture();
        if (failure === "digest")
            fs.writeFileSync(path.join(f.code.rootPath, "restricted-wsl.cjs"), "X".repeat(f.code.manifest.files[1]!.bytes));
        if (failure === "mode") fs.chmodSync(path.join(f.code.rootPath, "node"), 0o600);
        if (failure === "compose")
            f.compose.mockImplementation(() => {
                throw new Error("compose rejected");
            });
        if (failure === "protocol") f.composition.session = { ...f.session, protocol: "foreign" };
        if (failure === "host") f.composition.session = { ...f.session, hostInstanceId: randomUUID() };
        if (failure === "session") f.composition.session = { ...f.session, sessionId: randomUUID() };
        await runRestrictedServiceProcess(f.compose);
        expect(f.runtime.exitCode).toBe(71);
        expect(f.lines.map((line) => line.kind)).toEqual(["owned", "startup-failure"]);
        expect(f.lines[1]).toMatchObject({
            ...f.session,
            failureCode: failure === "digest" ? "digest_mismatch" : failure === "mode" ? "metadata_changed" : "startup_failed",
        });
        if (failure === "digest" || failure === "mode") expect(f.compose).not.toHaveBeenCalled();
        expect(f.stdin.destroyed).toBe(true);
    });
});
