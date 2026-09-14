/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { inspectDirectoryNoFollow, readRegularFileNoFollow } from "@oaam/shared/filesystem";
import {
    createTargetIo,
    createTargetIoForTest,
    ioDelete,
    ioChmodIfDifferent,
    ioExecutable,
    ioExists,
    ioRead,
    ioWrite,
    type TargetIoContext,
} from "../../src/deployment/deployment-target-io";
import { casWriteAll } from "../../src/deployment/deployment-target-cas";
import {
    applyRuntimeReplacementAuthority as applyRuntimeReplacementAuthorityStrict,
    type DeploymentRuntimeReplacementAuthorityV1,
} from "../../src/deployment/deployment-target-replacement";
import { desiredDirectoryPathsForBoundaries } from "../../src/deployment/deployment-managed-directory-graph";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import { b64, sha, tmpRoot, writeFile, readFile } from "./fixtures/deployment-target-io-test-fixtures";

describe("applyRuntimeReplacementAuthority", () => {
    let root: string;
    beforeEach(() => {
        root = tmpRoot();
    });
    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function entry(relativePath: string): JournalEntry {
        return {
            relativePath,
            oldHash: sha("# baseline"),
            oldBytesBase64: b64("# baseline"),
            oldExecutable: false,
            newHash: sha("# desired"),
            newBytesBase64: b64("# desired"),
            newExecutable: false,
            isRemoval: false,
        };
    }

    function applyRuntimeReplacementAuthority(
        entries: JournalEntry[],
        ctx: TargetIoContext,
        authority: DeploymentRuntimeReplacementAuthorityV1,
        exactDesiredDirectoryPaths = desiredDirectoryPathsForBoundaries(
            (authority.desiredManagedDirectoryBoundaryPaths ?? []).map((relativePath) => ({ relativePath })),
            entries.filter((entry) => !entry.isRemoval).map((entry) => entry.relativePath),
        ),
    ) {
        return applyRuntimeReplacementAuthorityStrict(entries, ctx, authority, exactDesiredDirectoryPaths);
    }

    it("adopts the exact inspected bytes and executable bit as the journal old side", () => {
        writeFile(root, "a.md", "# user edit");
        fs.chmodSync(path.join(root, "a.md"), 0o700);
        const entries = [entry("a.md")];
        const result = applyRuntimeReplacementAuthority(entries, createTargetIo(root), {
            files: [
                {
                    relativePath: "a.md",
                    expectedState: "present",
                    expectedBytes: Buffer.from("# user edit"),
                    expectedExecutable: true,
                },
            ],
        });
        expect(result).toEqual({ status: "applied" });
        expect(entries[0]).toMatchObject({
            oldHash: sha("# baseline"),
            runtimeRollbackOverride: {
                state: "present",
                contentHash: sha("# user edit"),
                bytesBase64: b64("# user edit"),
                executable: true,
            },
        });
    });

    it("adopts an exact inspected absence as the journal old side", () => {
        const entries = [entry("a.md")];
        const result = applyRuntimeReplacementAuthority(entries, createTargetIo(root), {
            files: [{ relativePath: "a.md", expectedState: "missing" }],
        });
        expect(result).toEqual({ status: "applied" });
        expect(entries[0]).toMatchObject({
            oldHash: sha("# baseline"),
            runtimeRollbackOverride: { state: "missing" },
        });
    });

    it("rejects missing, extra, or duplicate authority paths", () => {
        const ctx = createTargetIo(root);
        expect(applyRuntimeReplacementAuthority([entry("a.md")], ctx, { files: [] })).toMatchObject({
            status: "conflict",
        });
        expect(
            applyRuntimeReplacementAuthority([entry("a.md")], ctx, {
                files: [
                    { relativePath: "a.md", expectedState: "missing" },
                    { relativePath: "a.md", expectedState: "missing" },
                ],
            }),
        ).toMatchObject({ status: "conflict" });
    });

    it("rejects presence/absence changes after inspection", () => {
        const ctx = createTargetIo(root);
        writeFile(root, "a.md", "# now present");
        expect(
            applyRuntimeReplacementAuthority([entry("a.md")], ctx, {
                files: [{ relativePath: "a.md", expectedState: "missing" }],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("changed") });
        fs.unlinkSync(path.join(root, "a.md"));
        expect(
            applyRuntimeReplacementAuthority([entry("a.md")], ctx, {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# was present"),
                        expectedExecutable: false,
                    },
                ],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("changed") });
    });

    it("rejects content or executable changes after inspection", () => {
        writeFile(root, "a.md", "# current");
        const ctx = createTargetIo(root);
        expect(
            applyRuntimeReplacementAuthority([entry("a.md")], ctx, {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# inspected"),
                        expectedExecutable: false,
                    },
                ],
            }),
        ).toMatchObject({ status: "conflict" });
        fs.chmodSync(path.join(root, "a.md"), 0o700);
        expect(
            applyRuntimeReplacementAuthority([entry("a.md")], ctx, {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# current"),
                        expectedExecutable: false,
                    },
                ],
            }),
        ).toMatchObject({ status: "conflict" });
    });

    it("turns existence, read, and executable-port failures into conflicts", () => {
        const base = {
            writeFile: (p: string, d: Uint8Array | string) => fs.writeFileSync(p, d),
            deleteFile: (p: string) => fs.unlinkSync(p),
        };
        const authority = {
            files: [
                {
                    relativePath: "a.md",
                    expectedState: "present" as const,
                    expectedBytes: Buffer.from("# current"),
                    expectedExecutable: false,
                },
            ],
        };
        const existenceFailure = createTargetIoForTest(root, {
            ...base,
            readFile: (p) => fs.readFileSync(p),
            fileExists: () => {
                throw new Error("EIO");
            },
            fileExecutable: () => false,
        });
        expect(applyRuntimeReplacementAuthority([entry("a.md")], existenceFailure, authority)).toMatchObject({
            status: "conflict",
        });

        const readFailure = createTargetIoForTest(root, {
            ...base,
            readFile: () => {
                throw new Error("EIO");
            },
            fileExists: () => true,
            fileExecutable: () => false,
        });
        expect(applyRuntimeReplacementAuthority([entry("a.md")], readFailure, authority)).toMatchObject({ status: "conflict" });

        const executableFailure = createTargetIoForTest(root, {
            ...base,
            readFile: () => Buffer.from("# current"),
            fileExists: () => true,
            fileExecutable: () => {
                throw new Error("EIO");
            },
        });
        expect(applyRuntimeReplacementAuthority([entry("a.md")], executableFailure, authority)).toMatchObject({
            status: "conflict",
        });
    });

    it("uses the selected backend executable observation for replacement authority", () => {
        const ctx = createTargetIoForTest(root, {
            readFile: () => Buffer.from("# current"),
            writeFile: () => undefined,
            deleteFile: () => undefined,
            fileExists: () => true,
            fileExecutable: () => false,
        });
        expect(
            applyRuntimeReplacementAuthority([entry("a.md")], ctx, {
                files: [
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# current"),
                        expectedExecutable: false,
                    },
                ],
            }),
        ).toEqual({ status: "applied" });
        expect(ioExecutable(ctx, path.join(root, "a.md"))).toBe(false);
    });

    it("canonicalizes an unsorted multi-file replacement authority before applying it", () => {
        writeFile(root, "a.md", "# a");
        writeFile(root, "b.md", "# b");
        const entries = [entry("a.md"), entry("b.md")];
        expect(
            applyRuntimeReplacementAuthority(entries, createTargetIo(root), {
                files: [
                    {
                        relativePath: "b.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# b"),
                        expectedExecutable: false,
                    },
                    {
                        relativePath: "a.md",
                        expectedState: "present",
                        expectedBytes: Buffer.from("# a"),
                        expectedExecutable: false,
                    },
                ],
            }),
        ).toEqual({ status: "applied" });
    });

    it("requires the exact managed leaf directory and removal closure before applying authority", () => {
        writeFile(root, "skills/demo/SKILL.md", "# current");
        writeFile(root, "skills/demo/obsolete.txt", "remove");
        fs.mkdirSync(path.join(root, "skills/demo/empty"));
        const desired = entry("skills/demo/SKILL.md");
        const obsolete = {
            ...entry("skills/demo/obsolete.txt"),
            isRemoval: true,
            entryAuthority: "explicit_unmanaged_replacement" as const,
        };
        const files = [desired, obsolete];
        const authority = {
            files: [
                {
                    relativePath: "skills/demo/SKILL.md",
                    expectedState: "present" as const,
                    expectedBytes: Buffer.from("# current"),
                    expectedExecutable: false,
                    expectedIdentity: readRegularFileNoFollow(path.join(root, "skills/demo/SKILL.md")).identity,
                },
                {
                    relativePath: "skills/demo/obsolete.txt",
                    expectedState: "present" as const,
                    expectedBytes: Buffer.from("remove"),
                    expectedExecutable: false,
                    expectedIdentity: readRegularFileNoFollow(path.join(root, "skills/demo/obsolete.txt")).identity,
                },
            ],
            directories: [
                {
                    relativePath: "skills/demo",
                    expectedState: "present" as const,
                    expectedIdentity: inspectDirectoryNoFollow(path.join(root, "skills/demo")),
                },
                {
                    relativePath: "skills/demo/empty",
                    expectedState: "present" as const,
                    expectedIdentity: inspectDirectoryNoFollow(path.join(root, "skills/demo/empty")),
                },
            ],
            managedDirectoryBoundaryPaths: ["skills/demo"],
            desiredManagedDirectoryBoundaryPaths: ["skills/demo"],
            unmanagedRemovalPaths: ["skills/demo/obsolete.txt"],
            directoryRemovalPaths: ["skills/demo/empty"],
        };

        expect(applyRuntimeReplacementAuthority(files, createTargetIo(root), authority)).toEqual({ status: "applied" });
        expect(
            applyRuntimeReplacementAuthority([desired, obsolete], createTargetIo(root), {
                ...authority,
                unmanagedRemovalPaths: [],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("unmanaged-file removal") });
        expect(
            applyRuntimeReplacementAuthority([desired, obsolete], createTargetIo(root), {
                ...authority,
                directories: authority.directories.slice(0, 1),
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("directory closure") });
    });

    it("uses the exact V2 desired directory graph instead of rebuilding it from files", () => {
        writeFile(root, "skills/demo/SKILL.md", "# current");
        const desired = entry("skills/demo/SKILL.md");
        const authority = {
            files: [
                {
                    relativePath: "skills/demo/SKILL.md",
                    expectedState: "present" as const,
                    expectedBytes: Buffer.from("# current"),
                    expectedExecutable: false,
                    expectedIdentity: readRegularFileNoFollow(path.join(root, "skills/demo/SKILL.md")).identity,
                },
            ],
            directories: [
                {
                    relativePath: "skills/demo",
                    expectedState: "present" as const,
                    expectedIdentity: inspectDirectoryNoFollow(path.join(root, "skills/demo")),
                },
                { relativePath: "skills/demo/empty", expectedState: "missing" as const },
            ],
            managedDirectoryBoundaryPaths: ["skills/demo"],
            desiredManagedDirectoryBoundaryPaths: ["skills/demo"],
            unmanagedRemovalPaths: [],
            directoryRemovalPaths: [],
        };

        expect(applyRuntimeReplacementAuthority([desired], createTargetIo(root), authority, ["skills/demo"])).toMatchObject({
            status: "conflict",
            reason: expect.stringContaining("directory closure"),
        });
        for (const invalidDesiredDirectories of [[], ["skills/demo", "skills/demo"], ["skills/demo", "foreign"]]) {
            expect(
                applyRuntimeReplacementAuthority([desired], createTargetIo(root), authority, invalidDesiredDirectories),
            ).toMatchObject({ status: "conflict", reason: expect.stringContaining("desired directory authority") });
        }
        expect(
            applyRuntimeReplacementAuthority([desired], createTargetIo(root), authority, ["skills/demo", "skills/demo/empty"]),
        ).toEqual({ status: "applied" });
    });

    it("rejects non-canonical directory authority before graph access", () => {
        const managed = {
            files: [] as const,
            directories: [] as const,
            managedDirectoryBoundaryPaths: ["z", "a"],
            desiredManagedDirectoryBoundaryPaths: [],
            unmanagedRemovalPaths: [],
            directoryRemovalPaths: [],
        };
        expect(applyRuntimeReplacementAuthority([], createTargetIo(root), managed)).toMatchObject({
            status: "conflict",
            reason: expect.stringContaining("not canonical"),
        });
        expect(
            applyRuntimeReplacementAuthority([], createTargetIo(root), {
                ...managed,
                managedDirectoryBoundaryPaths: ["leaf", "leaf"],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("not canonical") });
    });

    it("maps an unreadable managed-directory graph to an exact conflict", () => {
        fs.mkdirSync(path.join(root, "skills"));
        fs.writeFileSync(path.join(root, "skills/demo"), "not a directory");
        expect(
            applyRuntimeReplacementAuthority([], createTargetIo(root), {
                files: [],
                directories: [],
                managedDirectoryBoundaryPaths: ["skills/demo"],
                desiredManagedDirectoryBoundaryPaths: [],
                unmanagedRemovalPaths: [],
                directoryRemovalPaths: [],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("could not be rechecked") });
    });

    it("rejects changed directory state, removal closure, file inventory, file identity, and directory identity", () => {
        writeFile(root, "skills/demo/SKILL.md", "skill");
        fs.mkdirSync(path.join(root, "skills/demo/empty"));
        const desired = entry("skills/demo/SKILL.md");
        const fileIdentity = readRegularFileNoFollow(path.join(root, "skills/demo/SKILL.md")).identity;
        const rootIdentity = inspectDirectoryNoFollow(path.join(root, "skills/demo"));
        const emptyIdentity = inspectDirectoryNoFollow(path.join(root, "skills/demo/empty"));
        const base = {
            files: [
                {
                    relativePath: "skills/demo/SKILL.md",
                    expectedState: "present" as const,
                    expectedBytes: Buffer.from("skill"),
                    expectedExecutable: false,
                    expectedIdentity: fileIdentity,
                },
            ],
            directories: [
                { relativePath: "skills/demo", expectedState: "present" as const, expectedIdentity: rootIdentity },
                { relativePath: "skills/demo/empty", expectedState: "present" as const, expectedIdentity: emptyIdentity },
            ],
            managedDirectoryBoundaryPaths: ["skills/demo"],
            desiredManagedDirectoryBoundaryPaths: ["skills/demo"],
            unmanagedRemovalPaths: [],
            directoryRemovalPaths: ["skills/demo/empty"],
        };

        expect(
            applyRuntimeReplacementAuthority([desired], createTargetIo(root), {
                ...base,
                directories: [{ relativePath: "skills/demo", expectedState: "missing" as const }, base.directories[1]!],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("changed after inspection") });
        expect(
            applyRuntimeReplacementAuthority([desired], createTargetIo(root), { ...base, directoryRemovalPaths: [] }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("directory removal set") });

        writeFile(root, "skills/demo/extra.txt", "extra");
        expect(applyRuntimeReplacementAuthority([desired], createTargetIo(root), base)).toMatchObject({
            status: "conflict",
            reason: expect.stringContaining("file inventory changed"),
        });
        fs.unlinkSync(path.join(root, "skills/demo/extra.txt"));

        expect(
            applyRuntimeReplacementAuthority([desired], createTargetIo(root), {
                ...base,
                files: [{ ...base.files[0]!, expectedIdentity: { ...fileIdentity, fileId: "wrong" } }],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("changed after inspection") });
        expect(
            applyRuntimeReplacementAuthority([desired], createTargetIo(root), {
                ...base,
                directories: [
                    { ...base.directories[0]!, expectedIdentity: { ...rootIdentity, fileId: "wrong" } },
                    base.directories[1]!,
                ],
            }),
        ).toMatchObject({ status: "conflict", reason: expect.stringContaining("changed after inspection") });
    });
});

describe("createTargetIo / createTargetIoForTest boundary (audit 必修2: fsHooks hidden)", () => {
    let root: string;
    beforeEach(() => {
        root = tmpRoot();
    });
    afterEach(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("production context rejects a non-canonical or relative target root", () => {
        expect(() => createTargetIo("relative/root")).toThrow(/canonical absolute/);
        expect(() => createTargetIo(`${root}/../alias`)).toThrow(/canonical absolute/);
    });

    it("TargetIoContext type has NO fsHooks field (not even accessible via cast)", () => {
        // The production context type must not carry fsHooks. The fault-injection
        // port lives in a module-private WeakMap, not on the context object.
        const ctx = createTargetIo(root);
        expect((ctx as Record<string, unknown>).fsHooks).toBeUndefined();
        expect(Object.keys(ctx).sort()).toEqual(["targetRootPath"]);
    });

    it("action-time executable=true remains fail-closed when a test backend exposes no chmod action", () => {
        const ctx = createTargetIoForTest(root, {
            readFile: () => Buffer.from(""),
            writeFile: () => undefined,
            deleteFile: () => undefined,
            fileExists: () => false,
        });
        expect(ioExecutable(ctx, path.join(root, "run.sh"))).toBe(false);
        expect(() => ioChmodIfDifferent(ctx, path.join(root, "run.sh"), true)).toThrow(/models only executable=false/);
    });

    it("production context writes through real fs (no port registered)", () => {
        const ctx = createTargetIo(root);
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(true);
        expect(readFile(root, "a.md")).toBe("# new");
    });

    it("production target I/O uses Shared no-follow reads, durable replacement, and durable removal", () => {
        const ctx = createTargetIo(root);
        const target = path.join(root, "AGENTS.md");
        const actual = path.join(root, "actual.md");
        const alias = path.join(root, "alias.md");

        expect(ioExists(ctx, target)).toBe(false);
        expect(() => ioDelete(ctx, target)).toThrowError(
            expect.objectContaining({
                name: "SafeFilesystemError",
                failureKind: "not_found",
                operation: "durable_remove_file",
            }),
        );

        ioWrite(ctx, target, "# managed");
        expect(Buffer.from(ioRead(ctx, target)).toString("utf8")).toBe("# managed");
        expect(ioExists(ctx, target)).toBe(true);
        expect(() => ioWrite(ctx, path.join(root, "..", "escaped", "AGENTS.md"), "blocked")).toThrowError(
            expect.objectContaining({ failureKind: "invalid_path", systemCode: "TARGET_PATH_OUTSIDE_ROOT" }),
        );

        fs.writeFileSync(actual, "outside");
        fs.symlinkSync(actual, alias);
        for (const action of [() => ioExists(ctx, alias), () => ioRead(ctx, alias), () => ioWrite(ctx, alias, "blocked")]) {
            expect(action).toThrowError(expect.objectContaining({ failureKind: "symlink_or_reparse" }));
        }
        expect(fs.readFileSync(actual, "utf8")).toBe("outside");

        ioDelete(ctx, target);
        expect(ioExists(ctx, target)).toBe(false);
    });

    it("test context routes I/O through the injected port (observable behavior)", () => {
        // Even though fsHooks is not on the context type, the test context's I/O
        // must route through the injected port. Observe by injecting a port that
        // throws on write → casWriteAll returns write_failed.
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: () => {
                throw new Error("injected");
            },
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = casWriteAll(entries, faulting);
        expect(r.ok).toBe(false);
        expect(r.stop?.kind).toBe("write_failed");
    });
});
