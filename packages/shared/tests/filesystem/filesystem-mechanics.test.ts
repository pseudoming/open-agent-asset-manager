import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockFile } from "@oaam/shared/filesystem";
import {
    assertExecutableStateSupported,
    atomicWriteFile,
    chmodIfDifferent,
} from "../../src/paths/unix-like/filesystem-target-entry";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function createTempDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-shared-mechanics-"));
    temporaryRoots.push(root);
    return root;
}

describe("selected Unix-like filesystem mechanics", () => {
    it("preflights both executable states without touching the path", () => {
        const missing = path.join(createTempDir(), "missing");
        expect(() => assertExecutableStateSupported(missing, false)).not.toThrow();
        expect(() => assertExecutableStateSupported(missing, true)).not.toThrow();
        expect(fs.existsSync(missing)).toBe(false);
    });

    it("atomically writes text and bytes, creates parents, and replaces an existing file", () => {
        const root = createTempDir();
        const textPath = path.join(root, "nested", "value.txt");
        atomicWriteFile(textPath, "first");
        atomicWriteFile(textPath, "second");
        expect(fs.readFileSync(textPath, "utf8")).toBe("second");

        const bytesPath = path.join(root, "value.bin");
        atomicWriteFile(bytesPath, new Uint8Array([0, 1, 255]));
        expect([...fs.readFileSync(bytesPath)]).toEqual([0, 1, 255]);
        expect(fs.readdirSync(path.dirname(textPath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("preserves the rename failure and removes its private temporary file", () => {
        const root = createTempDir();
        const destination = path.join(root, "value.txt");
        fs.mkdirSync(destination);

        expect(() => atomicWriteFile(destination, "content")).toThrow();
        expect(fs.readdirSync(root)).toEqual(["value.txt"]);
    });

    it.skipIf(process.platform !== "linux")(
        "acquires one kernel lock, reports contention, and retains its neutral file after release",
        () => {
            const root = createTempDir();
            const lockPath = path.join(root, "operation.lock");
            const release = lockFile(lockPath);
            expect(release).toBeTypeOf("function");
            expect(fs.readFileSync(lockPath, "utf8")).toBe("");
            expect(lockFile(lockPath)).toBeNull();

            release?.();
            expect(fs.readFileSync(lockPath, "utf8")).toBe("");
            expect(() => release?.()).not.toThrow();
            const reacquired = lockFile(lockPath);
            expect(reacquired).toBeTypeOf("function");
            reacquired?.();
        },
    );

    it("propagates an unexpected lock acquisition failure", () => {
        const root = createTempDir();
        const missingParentLock = path.join(root, "missing", "operation.lock");
        expect(() => lockFile(missingParentLock)).toThrow();
    });

    it("sets, preserves, and clears only the Unix owner execute bit", () => {
        const root = createTempDir();
        const filePath = path.join(root, "script.sh");
        fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o610 });

        expect(chmodIfDifferent(filePath, true)).toBe(true);
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o710);
        expect(chmodIfDifferent(filePath, true)).toBe(false);
        expect(chmodIfDifferent(filePath, false)).toBe(true);
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o610);
    });

    it("returns false when the selected Unix-like chmod operation cannot inspect the path", () => {
        expect(chmodIfDifferent(path.join(createTempDir(), "missing"), true)).toBe(false);
    });
});
