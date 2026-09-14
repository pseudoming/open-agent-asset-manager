import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as filesystem from "@oaam/shared/filesystem";
import { restrictedCodeLaunchBinding, requireWindowsRestrictedCodeVerification } from "../src/restricted-code-admission";
import { verifyWindowsRestrictedCodePackage } from "../src/restricted-windows-code-verification";
import type { RestrictedCodePackage } from "../src/restricted-code-package";

vi.mock("@oaam/shared/filesystem", async (original) => ({ ...(await original<object>()) }));
const actualProcess = process;
const original = {
    inspect: filesystem.inspectDirectoryNoFollow,
    inventory: filesystem.inventoryDirectoryNoFollow,
    read: filesystem.readRegularFileNoFollow,
};
const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-windows-code-control-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "code/lib"), { recursive: true });
    const files = ["node", "restricted-wsl.cjs", "lib/dependency.js"].map((relativePath) => {
        const bytes = Buffer.from(`owned ${relativePath}`);
        fs.writeFileSync(path.join(root, "code", relativePath), bytes, { mode: 0o600 });
        return {
            relativePath,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            executable: relativePath === "node",
        };
    });
    const code: RestrictedCodePackage = {
        rootPath: "/custom/c/OAAM/code",
        manifest: {
            schemaVersion: 1,
            platform: "linux",
            architecture: "x64",
            nodeVersion: "22.14.0",
            nodeModulesVersion: "127",
            files,
        },
    };
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(code.manifest));
    const windowsRoot = "C:\\OAAM\\code";
    const map = (file: string) => {
        if (!file.startsWith("C:\\OAAM\\")) throw new Error("outside owned path mapping");
        return path.join(root, ...file.slice("C:\\OAAM\\".length).split("\\"));
    };
    // Only the platform and physical coordinate are substituted. Real no-follow
    // inventory/stable reads exercise actual owned files; this is not native Win32 proof.
    const native = <T>(run: () => T): T => {
        vi.stubGlobal("process", actualProcess);
        try {
            return run();
        } finally {
            vi.stubGlobal("process", runtime);
        }
    };
    const inspect = vi
        .spyOn(filesystem, "inspectDirectoryNoFollow")
        .mockImplementation((file) => native(() => original.inspect(map(file))));
    const inventory = vi
        .spyOn(filesystem, "inventoryDirectoryNoFollow")
        .mockImplementation((file, maximum) => native(() => original.inventory(map(file), maximum)));
    const read = vi
        .spyOn(filesystem, "readRegularFileNoFollow")
        .mockImplementation((file, maximum) => native(() => original.read(map(file), maximum)));
    const runtime = Object.create(actualProcess);
    Object.defineProperty(runtime, "platform", { value: "win32", configurable: true });
    vi.stubGlobal("process", runtime);
    const session = { protocol: "test.windows-code.v1", hostInstanceId: randomUUID(), sessionId: randomUUID() };
    return {
        root,
        code,
        windowsRoot,
        session,
        map,
        inspect,
        inventory,
        read,
        runtime,
        native,
        verify: () => verifyWindowsRestrictedCodePackage(windowsRoot, code, session),
    };
}

describe("complete Windows-local restricted code admission", () => {
    it("freshly verifies every file and binds the current manifest, execution path and session", () => {
        const f = fixture();
        const result = f.verify();
        expect(result.verification.bindingHash).toBe(restrictedCodeLaunchBinding(f.code, f.session));
        expect(() => requireWindowsRestrictedCodeVerification(result.verification, f.code, f.session)).not.toThrow();
        expect(result.timing).toMatchObject({
            fileCount: 3,
            byteCount: f.code.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
        });
        for (const key of ["totalMilliseconds", "directoryMilliseconds", "stableReadMilliseconds", "hashMilliseconds"] as const)
            expect(result.timing[key]).toBeGreaterThanOrEqual(0);
        expect(f.read.mock.calls.map(([file]) => file)).toEqual(
            expect.arrayContaining([
                "C:\\OAAM\\manifest.json",
                "C:\\OAAM\\code\\node",
                "C:\\OAAM\\code\\restricted-wsl.cjs",
                "C:\\OAAM\\code\\lib\\dependency.js",
            ]),
        );
        f.verify();
        expect(f.read).toHaveBeenCalledTimes(8);
        fs.writeFileSync(path.join(f.root, "code/node"), "X".repeat(f.code.manifest.files[0]!.bytes));
        expect(f.verify).toThrow("digest_mismatch");
    });

    it.each([
        "digest",
        "short",
        "long",
        "missing",
        "extra",
        "symlink",
        "manifest",
        "identity",
        "root",
    ] as const)("rejects the real %s condition before issuing launch evidence", (failure) => {
        const f = fixture();
        const target = path.join(f.root, "code/lib/dependency.js");
        if (failure === "digest") fs.writeFileSync(target, "X".repeat(f.code.manifest.files[2]!.bytes));
        if (failure === "short") fs.writeFileSync(target, "x");
        if (failure === "long") fs.appendFileSync(target, "extra");
        if (failure === "missing" || failure === "symlink") fs.unlinkSync(target);
        if (failure === "symlink") fs.symlinkSync(path.join(f.root, "code/node"), target);
        if (failure === "extra") fs.writeFileSync(path.join(f.root, "code/extra"), "extra");
        if (failure === "manifest")
            fs.writeFileSync(path.join(f.root, "manifest.json"), JSON.stringify({ ...f.code.manifest, nodeVersion: "22.15.0" }));
        if (failure === "identity")
            f.read.mockImplementation((file, maximum) => {
                const observed = f.native(() => original.read(f.map(file), maximum));
                return file.endsWith("dependency.js")
                    ? { ...observed, identity: { ...observed.identity, fileId: "foreign" } }
                    : observed;
            });
        if (failure === "root")
            f.inspect.mockImplementationOnce((file) => ({ ...f.native(() => original.inspect(f.map(file))), fileId: "foreign" }));
        expect(f.verify).toThrow();
    });

    it.each([
        "/mnt/c/OAAM/code",
        "C:\\OAAM\\code\\",
        "C:\\OAAM\\..\\code",
        "C:\\OAAM\\foreign",
        "\\\\server\\OAAM\\code",
    ])("rejects noncanonical physical root %s before reads", (root) => {
        const f = fixture();
        expect(() => verifyWindowsRestrictedCodePackage(root, f.code, f.session)).toThrow();
        expect(f.read).not.toHaveBeenCalled();
    });

    it("does not use Windows admission for a Linux process", () => {
        const f = fixture();
        Object.defineProperty(f.runtime, "platform", { value: "linux" });
        expect(f.verify).toThrow();
        expect(f.read).not.toHaveBeenCalled();
    });
});
