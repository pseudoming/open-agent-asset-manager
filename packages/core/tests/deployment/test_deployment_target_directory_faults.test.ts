import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    inspections: [] as Array<unknown | Error>,
    ensures: [] as Array<unknown | Error>,
    removals: [] as Array<boolean | Error>,
}));

vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        inspectDirectoryNoFollow: () => {
            const next = shared.inspections.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("missing inspection fixture");
            return next;
        },
        durableEnsureDirectory: () => {
            const next = shared.ensures.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("missing ensure fixture");
            return next;
        },
        durableRemoveDirectoryTree: () => {
            const next = shared.removals.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("missing removal fixture");
            return next;
        },
    };
});

import { SafeFilesystemError, type PhysicalPathIdentity } from "@oaam/shared/filesystem";
import type { JournalDirectoryEntry } from "../../src/deployment/deployment-journal";
import {
    cleanupTargetDirectories,
    createTargetIo,
    removeTargetDirectories,
    restoreTargetDirectory,
} from "../../src/deployment/deployment-target-io";

const identity = (fileId: string): PhysicalPathIdentity => ({ deviceId: "device", fileId, entryKind: "directory" });
const present = (relativePath: string, fileId = relativePath): JournalDirectoryEntry => ({
    relativePath,
    oldState: "present",
    desiredState: "missing",
    oldIdentity: identity(fileId),
    createdIdentity: null,
});
const created = (relativePath: string, fileId = relativePath): JournalDirectoryEntry => ({
    relativePath,
    oldState: "missing",
    desiredState: "present",
    oldIdentity: null,
    createdIdentity: identity(fileId),
});
const notFound = () =>
    new SafeFilesystemError({
        failureKind: "not_found",
        operation: "inspect_directory",
        targetPath: "/root/missing",
        systemCode: "ENOENT",
        message: "missing",
    });

describe("target directory fault certainty", () => {
    const ctx = createTargetIo("/root");

    beforeEach(() => {
        shared.inspections = [];
        shared.ensures = [];
        shared.removals = [];
    });

    it("rejects a directory that appears while recovery is recreating it", () => {
        shared.inspections = [notFound()];
        shared.ensures = [{ created: false, identity: identity("appeared") }];
        expect(() => restoreTargetDirectory(ctx, present("leaf"))).toThrow(/appeared while recovery/);
    });

    it("preserves cleanup failures for inspect, remove, and read-back uncertainty", () => {
        shared.inspections = [new Error("inspect EIO")];
        expect(cleanupTargetDirectories(ctx, [created("inspect")])).toEqual({
            ok: false,
            failedRelativePaths: ["inspect"],
        });

        shared.inspections = [identity("remove-false")];
        shared.removals = [false];
        expect(cleanupTargetDirectories(ctx, [created("remove-false")])).toEqual({
            ok: false,
            failedRelativePaths: ["remove-false"],
        });

        shared.inspections = [identity("still-present"), identity("still-present")];
        shared.removals = [true];
        expect(cleanupTargetDirectories(ctx, [created("still-present")])).toEqual({
            ok: false,
            failedRelativePaths: ["still-present"],
        });

        shared.inspections = [identity("readback-eio"), new Error("readback EIO")];
        shared.removals = [true];
        expect(cleanupTargetDirectories(ctx, [created("readback-eio")])).toEqual({
            ok: false,
            failedRelativePaths: ["readback-eio"],
        });

        shared.inspections = [identity("remove-throws")];
        shared.removals = [new Error("remove EIO")];
        expect(cleanupTargetDirectories(ctx, [created("remove-throws")])).toEqual({
            ok: false,
            failedRelativePaths: ["remove-throws"],
        });
    });

    it("orders removals deepest-first and by UTF-8 while retaining exact failures", () => {
        const entries = [present("z", "z"), present("a", "a"), present("a/deep", "deep")];
        shared.inspections = [identity("deep"), identity("z"), identity("a")];
        shared.removals = [true, true, true];
        expect(removeTargetDirectories(ctx, entries)).toEqual({ ok: true, failedRelativePaths: [] });

        shared.inspections = [identity("false")];
        shared.removals = [false];
        expect(removeTargetDirectories(ctx, [present("false")])).toEqual({ ok: false, failedRelativePaths: ["false"] });

        shared.inspections = [new Error("inspect EIO")];
        expect(removeTargetDirectories(ctx, [present("inspect")])).toEqual({ ok: false, failedRelativePaths: ["inspect"] });
    });
});
