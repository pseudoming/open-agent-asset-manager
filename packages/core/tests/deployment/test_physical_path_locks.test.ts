/**
 * Physical-path lock tests (originally Phase 15 / Step 8 module 1 of 6).
 *
 * Covers physical-key computation + deterministic sort, lockFilePath
 * stability, acquireAllLocks success/all-or-nothing-on-second-lock-held, and
 * release idempotency.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    acquireAllLocks,
    acquireAllLocksForTest,
    computePhysicalAccessClosureKeys,
    computePhysicalClosureKeys,
    computePhysicalKeys,
    lockFilePath,
} from "../../src/foundation/physical-path-locks";

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashKey(key: string): string {
    return crypto.createHash("sha256").update(key, "utf-8").digest("hex");
}

describe("computePhysicalKeys", () => {
    it("builds platform\\0canonical-absolute-path keys", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md", "b.md"]);
        expect(keys).toEqual(["linux\0/root/a.md", "linux\0/root/b.md"]);
    });

    it("sorts deterministically by JS default string order (UTF-16 code unit order)", () => {
        const keys = computePhysicalKeys("linux", "/root", ["z.md", "a.md", "m.md"]);
        expect(keys).toEqual(["linux\0/root/a.md", "linux\0/root/m.md", "linux\0/root/z.md"]);
    });

    it("returns empty array for no paths", () => {
        expect(computePhysicalKeys("linux", "/root", [])).toEqual([]);
    });

    it("different platforms produce different keys for same path", () => {
        const win = computePhysicalKeys("win32", "/root", ["a.md"])[0];
        const lin = computePhysicalKeys("linux", "/root", ["a.md"])[0];
        expect(win).not.toBe(lin);
    });

    it("makes overlapping root descriptions contend on one physical key", () => {
        expect(computePhysicalKeys("linux", "/root", ["nested/a.md"])).toEqual(
            computePhysicalKeys("linux", "/root/nested", ["a.md"]),
        );
    });

    it("builds sorted file + immediate parent + containing-boundary closure", () => {
        expect(
            computePhysicalClosureKeys("linux", "/root", [
                {
                    relativePath: "skills/demo/SKILL.md",
                    entryKind: "file",
                    containingDirectoryBoundaries: ["skills", "skills/demo"],
                },
            ]),
        ).toEqual(["linux\0/root/skills", "linux\0/root/skills/demo", "linux\0/root/skills/demo/SKILL.md"]);
    });

    it("locks an enumerated directory itself without inventing its parent", () => {
        expect(
            computePhysicalClosureKeys("linux", "/root", [
                {
                    relativePath: "skills/demo",
                    entryKind: "directory",
                },
            ]),
        ).toEqual(["linux\0/root/skills/demo"]);
    });

    it("keeps the logical ownership namespace while deriving joins from the physical root grammar", () => {
        const target = [{ relativePath: "skills/demo/SKILL.md", entryKind: "file" as const }];
        expect(computePhysicalAccessClosureKeys("wsl", "/home/example", target)).toEqual([
            "wsl\0/home/example/skills/demo",
            "wsl\0/home/example/skills/demo/SKILL.md",
        ]);
        expect(computePhysicalAccessClosureKeys("wsl", "\\\\wsl.localhost\\Ubuntu\\home\\example", target)).toEqual([
            "wsl\0\\\\wsl.localhost\\Ubuntu\\home\\example\\skills\\demo",
            "wsl\0\\\\wsl.localhost\\Ubuntu\\home\\example\\skills\\demo\\SKILL.md",
        ]);
        expect(computePhysicalAccessClosureKeys("win32", "/mnt/c/Users/person", target)[0]).toMatch(/^win32\0/);
        expect(() => computePhysicalAccessClosureKeys("wsl", "relative", target)).toThrow(TypeError);
    });
});

describe("lockFilePath", () => {
    it("produces <transactionsRoot>/locks/<sha256>.lock", () => {
        const lp = lockFilePath("/txn", "linux\0/root/a.md");
        expect(lp).toBe(path.join("/txn", "locks", `${hashKey("linux\0/root/a.md")}.lock`));
    });

    it("is deterministic: same key → same path", () => {
        const key = "win32\0C:\\root\0a.md";
        expect(lockFilePath("/txn", key)).toBe(lockFilePath("/txn", key));
    });

    it("different keys → different paths", () => {
        expect(lockFilePath("/txn", "k1")).not.toBe(lockFilePath("/txn", "k2"));
    });
});

describe("acquireAllLocks", () => {
    let transactionsRoot: string;
    beforeEach(() => {
        transactionsRoot = tmpDir("oaam-locks-");
    });
    afterEach(() => {
        try {
            fs.rmSync(transactionsRoot, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it("acquires all locks when none held; release drops them", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md", "b.md"]);
        const handle = acquireAllLocks(transactionsRoot, keys);
        expect(handle).not.toBeNull();
        // Both lockfiles exist.
        for (const k of keys) {
            expect(fs.existsSync(lockFilePath(transactionsRoot, k))).toBe(true);
        }
        handle!.release();
        for (const k of keys) {
            const acquired = acquireAllLocks(transactionsRoot, [k]);
            expect(acquired).not.toBeNull();
            acquired?.release();
        }
    });

    it("returns null and releases acquired locks when a later lock is already held", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md", "b.md"]);
        const second = acquireAllLocks(transactionsRoot, [keys[1]]);
        expect(second).not.toBeNull();
        try {
            expect(acquireAllLocks(transactionsRoot, keys)).toBeNull();
            const first = acquireAllLocks(transactionsRoot, [keys[0]]);
            expect(first).not.toBeNull();
            first?.release();
            expect(acquireAllLocks(transactionsRoot, [keys[1]])).toBeNull();
        } finally {
            second?.release();
        }
    });

    it("returns null immediately when first lock is already held", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md"]);
        const first = acquireAllLocks(transactionsRoot, keys);
        expect(first).not.toBeNull();
        try {
            expect(acquireAllLocks(transactionsRoot, keys)).toBeNull();
        } finally {
            first?.release();
        }
    });

    it("acquires empty key set (returns handle, release is no-op)", () => {
        const handle = acquireAllLocks(transactionsRoot, []);
        expect(handle).not.toBeNull();
        expect(() => handle!.release()).not.toThrow();
    });

    it("release is idempotent", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md"]);
        const handle = acquireAllLocks(transactionsRoot, keys);
        expect(handle).not.toBeNull();
        handle!.release();
        // Second release does not throw.
        expect(() => handle!.release()).not.toThrow();
    });

    it("re-acquire succeeds after release", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md"]);
        const h1 = acquireAllLocks(transactionsRoot, keys);
        expect(h1).not.toBeNull();
        h1!.release();
        const h2 = acquireAllLocks(transactionsRoot, keys);
        expect(h2).not.toBeNull();
        h2!.release();
    });

    it("creates the locks/ dir if missing", () => {
        const keys = computePhysicalKeys("linux", "/root", ["a.md"]);
        const locksDir = path.join(transactionsRoot, "locks");
        expect(fs.existsSync(locksDir)).toBe(false);
        const handle = acquireAllLocks(transactionsRoot, keys);
        expect(handle).not.toBeNull();
        expect(fs.existsSync(locksDir)).toBe(true);
        handle!.release();
    });

    it("unexpected throw mid-acquisition → previously held locks released (deterministic fault injection)", () => {
        // Two physical keys. The injected lockFn succeeds on the first (returns a
        // release callback) and throws an unexpected error on the second — this
        // is the path the prior chmod-based test could not reliably drive (chmod
        // is not enforced on every sandbox FS, and the fallback path did
        // expect(true).toBe(true) without asserting anything).
        //
        // Deterministic proof: acquireAllLocksForTest must (a) re-throw the
        // unexpected error, and (b) call the first lock's release so no lockfile
        // leaks. The `firstReleased` flag is set inside the first release
        // callback and asserted after the throw.
        const keys = computePhysicalKeys("linux", "/root", ["a.md", "b.md"]);
        const firstLp = lockFilePath(transactionsRoot, keys[0]);
        const secondLp = lockFilePath(transactionsRoot, keys[1]);
        let firstReleased = false;
        const lockFn = (lp: string): (() => void) | null => {
            if (lp === firstLp) {
                return () => {
                    firstReleased = true;
                };
            }
            if (lp === secondLp) {
                throw new Error("unexpected EIO on second lockFile");
            }
            throw new Error(`unexpected lockfilePath: ${lp}`);
        };
        expect(() => acquireAllLocksForTest(transactionsRoot, keys, lockFn)).toThrow(/unexpected EIO on second lockFile/);
        expect(firstReleased).toBe(true);
    });

    it("lockFn returning null (already held) → returns null without throwing (distinct from unexpected throw)", () => {
        // EEXIST-style (lock already held) returns null and the caller branches
        // to "target locked". This must NOT throw — it is a normal busy-path,
        // distinct from the unexpected-throw cleanup above. Also verifies the
        // first lock is released on the all-or-nothing null return.
        const keys = computePhysicalKeys("linux", "/root", ["a.md", "b.md"]);
        const firstLp = lockFilePath(transactionsRoot, keys[0]);
        const secondLp = lockFilePath(transactionsRoot, keys[1]);
        let firstReleased = false;
        const lockFn = (lp: string): (() => void) | null => {
            if (lp === firstLp) {
                return () => {
                    firstReleased = true;
                };
            }
            if (lp === secondLp) {
                return null; // already held
            }
            throw new Error(`unexpected lockfilePath: ${lp}`);
        };
        const handle = acquireAllLocksForTest(transactionsRoot, keys, lockFn);
        expect(handle).toBeNull();
        expect(firstReleased).toBe(true);
    });
});
