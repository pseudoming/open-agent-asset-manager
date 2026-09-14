import type { SafeFilesystemError } from "@oaam/shared/filesystem";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    inspectProviderDirectoryNoFollow,
    inspectProviderRegularFileNoFollow,
    inventoryProviderDirectoryNoFollow,
    observeProviderDirectoryMembersBounded,
    readProviderRegularFileNoFollow,
    readProviderRegularFileRangeNoFollow,
    sameProviderPathIdentity,
    sameProviderRegularFileIdentity,
    snapshotProviderRegularFileNoFollow,
} from "../src/provider-probe-filesystem";
let sandbox = "";
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-provider-file-sample-"));
});
afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});
describe("Provider probe physical sampling", () => {
    it("observes shallow members through Shared without following child links", () => {
        const directory = path.join(sandbox, "observed");
        fs.mkdirSync(directory);
        fs.symlinkSync(sandbox, path.join(directory, "linked"));
        expect(observeProviderDirectoryMembersBounded(directory, 1)).toEqual([{ name: "linked", entryKind: "other" }]);
        expect(() => observeProviderDirectoryMembersBounded(directory, 0)).toThrow(/bounded-inventory entry limit/);
    });

    it("reads complete bounded bytes with stable identity and refuses an oversized or linked file", () => {
        const filePath = path.join(sandbox, "metadata");
        const bytes = Buffer.from([0, 255, 41, 99]);
        fs.writeFileSync(filePath, bytes);
        const read = readProviderRegularFileNoFollow(filePath, bytes.length);
        expect(Buffer.from(read.bytes)).toEqual(bytes);
        expect(read.identity).toEqual(inspectProviderRegularFileNoFollow(filePath));
        expect(read.executable).toBe(false);
        expect(() => readProviderRegularFileNoFollow(filePath, bytes.length - 1)).toThrow(/bounded-read byte limit/u);
        const link = path.join(sandbox, "metadata-link");
        fs.symlinkSync(filePath, link);
        expect(() => readProviderRegularFileNoFollow(link, bytes.length)).toThrowError(
            expect.objectContaining({ failureKind: "symlink_or_reparse" }),
        );
    });

    it("inventories a bounded directory and detects replacement while preserving file and directory identities", () => {
        const directory = path.join(sandbox, "account");
        fs.mkdirSync(path.join(directory, "org"), { recursive: true });
        fs.writeFileSync(path.join(directory, "metadata"), "metadata");
        const inventory = inventoryProviderDirectoryNoFollow(directory, 2);
        expect(inventory.identity.entryKind).toBe("directory");
        expect(inventory.entries.map((entry) => [entry.relativeName, entry.identity.entryKind])).toEqual([
            ["metadata", "file"],
            ["org", "directory"],
        ]);
        expect(sameProviderPathIdentity(inventory.identity, inspectProviderDirectoryNoFollow(directory))).toBe(true);
        expect(() => inventoryProviderDirectoryNoFollow(directory, 1)).toThrow();
        fs.renameSync(directory, directory + "-old");
        fs.mkdirSync(directory);
        expect(sameProviderPathIdentity(inventory.identity, inspectProviderDirectoryNoFollow(directory))).toBe(false);
        expect(inventoryProviderDirectoryNoFollow(directory, 1).entries).toEqual([]);
    });

    it("refuses directory links and linked children without traversing them", () => {
        const directory = path.join(sandbox, "account");
        fs.mkdirSync(directory);
        const link = path.join(sandbox, "account-link");
        fs.symlinkSync(directory, link);
        expect(() => inspectProviderDirectoryNoFollow(link)).toThrowError(
            expect.objectContaining({ failureKind: "symlink_or_reparse" }),
        );
        expect(() => inventoryProviderDirectoryNoFollow(link, 4)).toThrowError(
            expect.objectContaining({ failureKind: "symlink_or_reparse" }),
        );
        fs.symlinkSync(sandbox, path.join(directory, "outside"));
        expect(() => inventoryProviderDirectoryNoFollow(directory, 4)).toThrowError(
            expect.objectContaining({ failureKind: "symlink_or_reparse" }),
        );
    });

    it("forwards the Shared no-follow identity without owning a second identity algorithm", () => {
        const firstPath = path.join(sandbox, "first");
        const secondPath = path.join(sandbox, "second");
        fs.writeFileSync(firstPath, "first");
        fs.writeFileSync(secondPath, "second");

        const first = inspectProviderRegularFileNoFollow(firstPath);
        const repeated = inspectProviderRegularFileNoFollow(firstPath);
        const second = inspectProviderRegularFileNoFollow(secondPath);

        expect(first).toMatchObject({ entryKind: "file" });
        expect(sameProviderRegularFileIdentity(first, repeated)).toBe(true);
        expect(sameProviderRegularFileIdentity(first, second)).toBe(false);
    });

    it("preserves Shared fail-closed rejection for a linked regular-file candidate", () => {
        const target = path.join(sandbox, "target");
        const link = path.join(sandbox, "link");
        fs.writeFileSync(target, "target");
        fs.symlinkSync(target, link);

        expect(() => inspectProviderRegularFileNoFollow(link)).toThrowError(
            expect.objectContaining<Partial<SafeFilesystemError>>({
                failureKind: "symlink_or_reparse",
                operation: "inspect_regular_file",
            }),
        );
    });

    it("projects a stable physical identity and SHA-256 executable snapshot", () => {
        const filePath = path.join(sandbox, "executable");
        fs.writeFileSync(filePath, "exact build");

        expect(snapshotProviderRegularFileNoFollow(filePath, 64)).toEqual({
            identity: inspectProviderRegularFileNoFollow(filePath),
            sha256: "sha256:dd5a9fb52a1f9bda048623588df74f749aa98efc51c3fb699a505e4f729dd058",
        });
        expect(() => snapshotProviderRegularFileNoFollow(filePath, 4)).toThrow(/bounded-read byte limit/u);
    });

    it("projects one bounded range with the Shared physical identity", () => {
        const filePath = path.join(sandbox, "archive");
        fs.writeFileSync(filePath, "0123456789");

        const range = readProviderRegularFileRangeNoFollow(filePath, 3, 4);
        expect(Buffer.from(range.bytes).toString("utf8")).toBe("3456");
        expect(range).toMatchObject({
            byteOffset: 3,
            totalBytes: 10,
            executable: false,
            identity: inspectProviderRegularFileNoFollow(filePath),
        });
    });
});
