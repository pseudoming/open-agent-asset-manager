import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeDirectoryMembersBounded } from "../../src/paths/directory-member-observation";
import { createWin32PhysicalFilesystemBackend } from "../../src/paths/win32/filesystem-backend";

const hooks = vi.hoisted(() => ({ beforeOpen: null as (() => void) | null }));
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        opendirSync: (input: fs.PathLike) => {
            hooks.beforeOpen?.();
            return actual.opendirSync(input);
        },
    };
});
const roots: string[] = [];
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-directory-members-"));
    roots.push(root);
    return root;
}
afterEach(() => {
    vi.restoreAllMocks();
    hooks.beforeOpen = null;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded directory member observation", () => {
    it("observes only one level, includes a child link as other, and keeps the Windows native reader separate", () => {
        const root = fixture();
        const observed = path.join(root, "observed");
        const outside = path.join(root, "outside");
        fs.mkdirSync(observed);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "private-body"), "not observed");
        fs.symlinkSync(outside, path.join(observed, "linked"), "junction");
        fs.mkdirSync(path.join(observed, "directory"));
        fs.writeFileSync(path.join(observed, "file"), "body");
        const loadNative = vi.fn(() => {
            throw new Error("native strict inventory invoked");
        });
        const backend = createWin32PhysicalFilesystemBackend(loadNative);
        expect(backend.observeDirectoryMembersBounded(observed, 3).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            { name: "directory", entryKind: "directory" },
            { name: "file", entryKind: "file" },
            { name: "linked", entryKind: "other" },
        ]);
        expect(loadNative).not.toHaveBeenCalled();
        expect(() => backend.readDirectoryEntriesBounded(observed, 3)).toThrow("native strict inventory invoked");
    });

    it("stops at the first overflow entry and closes once without returning partial members", () => {
        const root = fixture();
        for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, name), name);
        const read = vi.spyOn(fs.Dir.prototype, "readSync");
        const close = vi.spyOn(fs.Dir.prototype, "closeSync");
        expect(() => observeDirectoryMembersBounded(root, 1)).toThrow(expect.objectContaining({ failureKind: "resource_limit" }));
        expect(read).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledOnce();
    });

    it("accepts an empty directory at zero capacity and rejects a nonempty one", () => {
        const root = fixture();
        expect(observeDirectoryMembersBounded(root, 0)).toEqual([]);
        fs.writeFileSync(path.join(root, "a"), "a");
        expect(() => observeDirectoryMembersBounded(root, 0)).toThrow(/bounded-inventory entry limit/);
        expect(() => observeDirectoryMembersBounded(root, -1)).toThrow(RangeError);
    });

    it("rejects a link root, a regular file, and a missing path", () => {
        const root = fixture();
        const link = path.join(root, "link");
        fs.symlinkSync(root, link, "junction");
        fs.writeFileSync(path.join(root, "file"), "body");
        expect(() => observeDirectoryMembersBounded(link, 2)).toThrow(
            expect.objectContaining({ failureKind: "symlink_or_reparse" }),
        );
        expect(() => observeDirectoryMembersBounded(path.join(root, "file"), 2)).toThrow(
            expect.objectContaining({ failureKind: "wrong_entry_type" }),
        );
        expect(() => observeDirectoryMembersBounded(path.join(root, "absent"), 2)).toThrow(
            expect.objectContaining({ failureKind: "not_found" }),
        );
    });

    it("rejects a real root replacement while its directory handle is open", () => {
        const parent = fixture();
        const root = path.join(parent, "observed");
        fs.mkdirSync(root);
        const originalRead = fs.Dir.prototype.readSync;
        vi.spyOn(fs.Dir.prototype, "readSync").mockImplementationOnce(function () {
            fs.renameSync(root, path.join(parent, "previous"));
            fs.mkdirSync(root);
            return originalRead.call(this);
        });
        const close = vi.spyOn(fs.Dir.prototype, "closeSync");
        expect(() => observeDirectoryMembersBounded(root, 2)).toThrow(expect.objectContaining({ failureKind: "stale" }));
        expect(close).toHaveBeenCalledOnce();
    });

    it("reports close failure on success and preserves a primary read failure after attempting close", () => {
        const root = fixture();
        const originalClose = fs.Dir.prototype.closeSync;
        const close = vi.spyOn(fs.Dir.prototype, "closeSync").mockImplementation(function () {
            originalClose.call(this);
            throw Object.assign(new Error("injected close failure"), { code: "EIO" });
        });
        expect(() => observeDirectoryMembersBounded(root, 0)).toThrow(
            expect.objectContaining({ failureKind: "io_error", systemCode: "EIO" }),
        );
        vi.spyOn(fs.Dir.prototype, "readSync").mockImplementationOnce(() => {
            throw Object.assign(new Error("injected read failure"), { code: "EACCES" });
        });
        expect(() => observeDirectoryMembersBounded(root, 0)).toThrow(
            expect.objectContaining({ failureKind: "permission_denied" }),
        );
        expect(close).toHaveBeenCalledTimes(2);
    });

    it("reports an open failure after the root disappears between lstat and opendir", () => {
        const root = fixture();
        hooks.beforeOpen = () => {
            fs.renameSync(root, root + "-retained");
            roots.push(root + "-retained");
        };
        expect(() => observeDirectoryMembersBounded(root, 1)).toThrow(expect.objectContaining({ failureKind: "not_found" }));
    });
});
