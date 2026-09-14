import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLinuxFileLockForTest } from "../../../src/paths/unix-like/file-lock";

type NativeLock = ReturnType<Parameters<typeof acquireLinuxFileLockForTest>[1]>;
let native: NativeLock;
const acquire = (lockPath: string, beforeAcquire?: () => void) =>
    acquireLinuxFileLockForTest(lockPath, () => native, beforeAcquire);
const descriptors = () => fs.readdirSync("/proc/self/fd").length;
let root = "";
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-linux-lock-unit-"));
    if (process.platform === "linux")
        native = createRequire(__filename)(path.resolve(__dirname, "../../../dist/paths/unix-like/native/oaam_file_lock.node"));
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("Linux kernel lock ownership", () => {
    it("contends on the same inode and closes every descriptor after repeated acquisition and release", () => {
        const file = path.join(root, "lease.lock"),
            count = descriptors();
        const first = acquire(file);
        expect(first).toBeTypeOf("function");
        const original = fs.statSync(file, { bigint: true });
        expect(acquire(file)).toBeNull();
        first?.();
        first?.();
        for (let index = 0; index < 1000; index++) {
            const release = acquire(file);
            expect(release).toBeTypeOf("function");
            release?.();
        }
        const current = fs.statSync(file, { bigint: true });
        expect([current.dev, current.ino, current.size]).toEqual([original.dev, original.ino, 0n]);
        expect(fs.readdirSync(root)).toEqual(["lease.lock"]);
        expect(descriptors()).toBe(count);
    });

    it.each([
        String(process.pid),
        "999999999",
        "foreign marker",
    ])("preserves an existing non-neutral marker without interpreting its PID: %s", (marker) => {
        const file = path.join(root, "lease.lock"),
            count = descriptors();
        fs.writeFileSync(file, marker);
        expect(() => acquire(file)).toThrow("owned regular empty file");
        expect(fs.readFileSync(file, "utf8")).toBe(marker);
        expect(descriptors()).toBe(count);
    });

    it("refuses linked files, linked ancestors and multiply linked neutral files without changing them", () => {
        const file = path.join(root, "original");
        fs.writeFileSync(file, "");
        fs.symlinkSync(file, path.join(root, "link"));
        expect(() => acquire(path.join(root, "link"))).toThrow();
        fs.symlinkSync(root, path.join(root, "parent-link"));
        expect(() => acquire(path.join(root, "parent-link", "lease"))).toThrow();
        fs.linkSync(file, path.join(root, "hardlink"));
        expect(() => acquire(file)).toThrow("owned regular empty file");
        expect(fs.readFileSync(file, "utf8")).toBe("");
        expect(fs.statSync(file).nlink).toBe(2);
    });

    it("refuses a foreign owner before requesting a kernel lock", () => {
        const file = path.join(root, "foreign.lock"),
            ownerUid = process.getuid!();
        const tryAcquire = vi.fn(native.tryAcquire);
        vi.spyOn(process, "getuid").mockReturnValue(ownerUid + 1);
        expect(() => acquireLinuxFileLockForTest(file, () => ({ ...native, tryAcquire }))).toThrow("owned regular empty file");
        expect(tryAcquire).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, "utf8")).toBe("");
    });

    it.each([
        "file",
        "parent",
    ])("closes the acquired descriptor when its %s path is replaced during acquisition", (replacement) => {
        const directory = path.join(root, "parent");
        fs.mkdirSync(directory);
        const file = path.join(directory, "lease"),
            count = descriptors();
        expect(() =>
            acquire(file, () => {
                if (replacement === "file") {
                    fs.renameSync(file, file + "-old");
                    fs.writeFileSync(file, "");
                } else {
                    fs.renameSync(directory, directory + "-old");
                    fs.mkdirSync(directory);
                    fs.writeFileSync(file, "");
                }
            }),
        ).toThrow("identity changed");
        expect(descriptors()).toBe(count);
        const old = replacement === "file" ? file + "-old" : path.join(directory + "-old", "lease");
        const oldRelease = acquire(old),
            currentRelease = acquire(file);
        expect(oldRelease).toBeTypeOf("function");
        expect(currentRelease).toBeTypeOf("function");
        oldRelease?.();
        currentRelease?.();
    });

    it("releases only its descriptor when a third party replaces the lock pathname", () => {
        const file = path.join(root, "lease"),
            release = acquire(file);
        fs.renameSync(file, file + "-old");
        fs.writeFileSync(file, "third party");
        release?.();
        release?.();
        expect(fs.readFileSync(file, "utf8")).toBe("third party");
        expect(fs.existsSync(file + "-old")).toBe(true);
    });

    it("fails closed on module loading and native failures without leaking or creating a fallback marker", () => {
        const file = path.join(root, "lease"),
            count = descriptors();
        expect(() =>
            acquireLinuxFileLockForTest(file, () => {
                throw new Error("controlled missing module");
            }),
        ).toThrow("module is unavailable");
        expect(fs.existsSync(file)).toBe(false);
        expect(() =>
            acquireLinuxFileLockForTest(file, () => ({
                ...native,
                tryAcquire() {
                    throw new Error("controlled native failure");
                },
            })),
        ).toThrow();
        expect(() => acquireLinuxFileLockForTest(file, () => ({ ...native, tryAcquire: () => undefined as never }))).toThrow(
            "invalid acquisition result",
        );
        expect(fs.readFileSync(file, "utf8")).toBe("");
        expect(descriptors()).toBe(count);
    });

    it("rejects invalid and closed descriptors in the private Node-API boundary", () => {
        for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 40])
            expect(() => native.tryAcquire(value)).toThrow("non-negative integer");
        const fd = fs.openSync(path.join(root, "closed"), "wx");
        fs.closeSync(fd);
        expect(() => native.tryAcquire(fd)).toThrow();
    });
});
