import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    inventories: [] as Array<unknown | Error>,
    reads: [] as Array<unknown | Error>,
}));

vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        inventoryDirectoryNoFollow: () => {
            const next = shared.inventories.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("missing inventory fixture");
            return next;
        },
        readRegularFileNoFollow: () => {
            const next = shared.reads.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("missing read fixture");
            return next;
        },
    };
});

import { captureManagedDirectoryGraph } from "../../src/deployment/deployment-managed-directory-graph";
import { SafeFilesystemError } from "@oaam/shared/filesystem";

const directory = (fileId: string) => ({ deviceId: "device", fileId, entryKind: "directory" as const });
const file = (fileId: string) => ({ deviceId: "device", fileId, entryKind: "file" as const });
const inventory = (
    fileId: string,
    entries: Array<{ relativeName: string; identity: ReturnType<typeof directory> | ReturnType<typeof file> }> = [],
) => ({
    identity: directory(fileId),
    entries,
});
const read = (fileId: string, text = "x") => ({
    bytes: Buffer.from(text),
    executable: false,
    identity: file(fileId),
});

describe("managed directory graph concurrent-change faults", () => {
    beforeEach(() => {
        shared.inventories = [];
        shared.reads = [];
    });

    it("rejects an exhausted entry budget before inventory", () => {
        expect(() => captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }], { maximumEntries: 0 })).toThrow(
            /entry limit/,
        );
    });

    it("rejects a child directory whose no-follow identity changes", () => {
        shared.inventories = [
            inventory("root", [{ relativeName: "child", identity: directory("child-before") }]),
            inventory("child-after"),
            inventory("child-after"),
        ];
        expect(() => captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }])).toThrow(/directory identity changed/);
    });

    it("rejects a file whose no-follow identity changes", () => {
        shared.inventories = [inventory("root", [{ relativeName: "file", identity: file("before") }])];
        shared.reads = [read("after")];
        expect(() => captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }])).toThrow(/file identity changed/);
    });

    it("rejects a file before reading it when the shared byte budget is exhausted", () => {
        shared.inventories = [inventory("root", [{ relativeName: "file", identity: file("file") }])];
        expect(() =>
            captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }], { maximumEntries: 2, maximumBytes: 0 }),
        ).toThrow(/bounded preview limit/);
        expect(shared.reads).toEqual([]);
    });

    it("rejects a repeated descendant path from a malformed or changing inventory", () => {
        shared.inventories = [
            inventory("root", [
                { relativeName: "file", identity: file("same") },
                { relativeName: "file", identity: file("same") },
            ]),
        ];
        shared.reads = [read("same"), read("same")];
        expect(() => captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }])).toThrow(/repeats one descendant/);
    });

    it("rejects a directory inventory that changes before read-back", () => {
        shared.inventories = [inventory("before"), inventory("after")];
        expect(() => captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }])).toThrow(/changed during capture/);
    });

    it("does not treat a missing nested directory as an allowed missing boundary", () => {
        const error = new SafeFilesystemError({
            failureKind: "not_found",
            operation: "inventory_directory",
            targetPath: "/root/leaf/child",
            systemCode: "ENOENT",
            message: "nested unavailable",
        });
        shared.inventories = [inventory("root", [{ relativeName: "child", identity: directory("child") }]), error];
        expect(() => captureManagedDirectoryGraph("/root", [{ relativePath: "leaf" }])).toThrow(/nested unavailable/);
    });
});
