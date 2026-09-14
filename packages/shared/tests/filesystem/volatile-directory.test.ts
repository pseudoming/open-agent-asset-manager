import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVolatileDirectoryEntriesBounded } from "../../src/paths/unix-like/filesystem-target-entry";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-volatile-directory-"));
    temporaryRoots.push(root);
    return root;
}

describe("bounded volatile directory observation", () => {
    it("returns a deterministic one-level observation without requiring stable directory metadata", () => {
        const root = createRoot();
        fs.mkdirSync(path.join(root, "b"));
        fs.writeFileSync(path.join(root, "a"), "value");

        expect(readVolatileDirectoryEntriesBounded(root, 2)).toEqual([
            { name: "a", entryKind: "file" },
            { name: "b", entryKind: "directory" },
        ]);
    });

    it("rejects an over-limit directory before returning a truncated observation", () => {
        const root = createRoot();
        fs.writeFileSync(path.join(root, "a"), "a");
        fs.writeFileSync(path.join(root, "b"), "b");

        expect(() => readVolatileDirectoryEntriesBounded(root, 1)).toThrow(/bounded-inventory entry limit/u);
        expect(() => readVolatileDirectoryEntriesBounded(root, 0)).toThrow(/bounded-inventory entry limit/u);
    });

    it("rejects symlink roots, non-directories and invalid limits", () => {
        const root = createRoot();
        const file = path.join(root, "file");
        const link = path.join(root, "link");
        fs.writeFileSync(file, "value");
        fs.symlinkSync(root, link);

        expect(() => readVolatileDirectoryEntriesBounded(link, 1)).toThrow(/symbolic-link/u);
        expect(() => readVolatileDirectoryEntriesBounded(file, 1)).toThrow(/expected a regular directory/u);
        expect(() => readVolatileDirectoryEntriesBounded(root, -1)).toThrow(RangeError);
    });
});
