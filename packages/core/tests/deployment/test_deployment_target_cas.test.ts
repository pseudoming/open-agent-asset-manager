/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    createTargetIo,
    createTargetIoForTest,
    ioWrite,
    rollbackToOld,
    type TargetIoContext,
} from "../../src/deployment/deployment-target-io";
import { buildDeployEntries } from "../../src/deployment/deployment-target-entries";
import { casWriteAll } from "../../src/deployment/deployment-target-cas";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import { DurableFilesystemMutationError } from "@oaam/shared/filesystem";
import {
    SHA_OLD,
    sha,
    b64,
    tmpRoot,
    baselineRow,
    multiPlan,
    writeFile,
    readFile,
    exists,
} from "./fixtures/deployment-target-io-test-fixtures";

describe("casWriteAll — deploy CAS", () => {
    let root: string;
    let ctx: TargetIoContext;
    beforeEach(() => {
        root = tmpRoot();
        ctx = createTargetIo(root);
    });
    afterEach(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("forwards an explicit executable state through the target I/O port after writing bytes", () => {
        const modes: boolean[] = [];
        const hooked = createTargetIoForTest(root, {
            readFile: (file) => fs.readFileSync(file),
            writeFile: (file, bytes) => fs.writeFileSync(file, bytes),
            deleteFile: (file) => fs.unlinkSync(file),
            fileExists: (file) => fs.existsSync(file),
            chmodIfDifferent: (file, executable) => {
                modes.push(executable);
                fs.chmodSync(file, executable ? 0o755 : 0o644);
                return true;
            },
        });
        const target = path.join(root, "mode.sh");
        ioWrite(hooked, target, Buffer.from("echo owned"), "overwrite", true);
        expect(fs.readFileSync(target, "utf8")).toBe("echo owned");
        expect(fs.statSync(target).mode & 0o100).toBe(0o100);
        expect(modes).toEqual([true]);
    });

    it("first deploy: absent runtime + oldHash='' → write new", () => {
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
        expect(r.written).toEqual(["a.md"]);
        expect(r.mutated).toEqual(["a.md"]);
        expect(readFile(root, "a.md")).toBe("# new");
    });

    it("redeploy: runtime == oldHash → overwrite with new", () => {
        writeFile(root, "a.md", "# old");
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# old"),
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

    it("third value: runtime != oldHash (hand-edited) → stop, no overwrite", () => {
        writeFile(root, "a.md", "# hand-edited");
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop).toEqual({ kind: "third_value", relativePath: "a.md" });
        expect(readFile(root, "a.md")).toBe("# hand-edited");
    });

    it("third value: content matches but executable bit changed → stop, no overwrite", () => {
        writeFile(root, "a.md", "# baseline");
        fs.chmodSync(path.join(root, "a.md"), 0o700);
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop).toEqual({ kind: "third_value", relativePath: "a.md" });
        expect(readFile(root, "a.md")).toBe("# baseline");
    });

    it("executable-bit read failure on a matching file → write_failed", () => {
        writeFile(root, "a.md", "# baseline");
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => true,
            fileExecutable: () => {
                throw new Error("EIO");
            },
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# baseline"),
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
        expect(r.stop).toEqual({ kind: "write_failed", relativePath: "a.md" });
        expect(readFile(root, "a.md")).toBe("# baseline");
    });

    it("first deploy with pre-existing runtime content → third value", () => {
        writeFile(root, "a.md", "# surprise");
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
        expect(r.ok).toBe(false);
        expect(r.stop?.kind).toBe("third_value");
    });

    it("write failure (hook throws on write) → write_failed", () => {
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: () => {
                throw new Error("ENOSPC");
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
        expect(r.stop).toEqual({ kind: "write_failed", relativePath: "a.md" });
    });

    it.each([
        "not_applied",
        "may_have_applied",
    ] as const)("selected-WSL helper %s certainty stays a write_failed recovery boundary", (mutationState) => {
        const target = path.join(root, "a.md");
        const desired = Buffer.from("# new");
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, data) => {
                if (mutationState === "may_have_applied") fs.writeFileSync(p, data);
                throw new DurableFilesystemMutationError({
                    operation: "durable_replace_file",
                    failureKind: "io_error",
                    targetPath: p,
                    systemCode: "SELECTED_WSL_HELPER_FAULT",
                    mutationState,
                    message: "selected-WSL helper fault fixture",
                });
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
                newBytesBase64: desired.toString("base64"),
                newExecutable: false,
                isRemoval: false,
            },
        ];

        expect(casWriteAll(entries, faulting)).toEqual({
            ok: false,
            written: [],
            mutated: [],
            stop: { kind: "write_failed", relativePath: "a.md" },
        });
        expect(fs.existsSync(target)).toBe(mutationState === "may_have_applied");
        if (mutationState === "may_have_applied") expect(fs.readFileSync(target)).toEqual(desired);
    });

    it("deploy CAS read failure (runtime present but unreadable) → write_failed", () => {
        writeFile(root, "a.md", "# old");
        const faulting = createTargetIoForTest(root, {
            readFile: () => {
                throw new Error("EIO");
            },
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => true,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# old"),
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
        expect(r.stop).toEqual({ kind: "write_failed", relativePath: "a.md" });
    });

    it("fsHooks write passthrough (non-throwing) exercises ioWrite hook branch", () => {
        // A non-throwing fsHooks write so ioWrite's hook branch
        // is reached without aborting.
        const passthrough = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
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
        const r = casWriteAll(entries, passthrough);
        expect(r.ok).toBe(true);
        expect(readFile(root, "a.md")).toBe("# new");
    });

    it("batch stops at first third_value; earlier entries counted as written", () => {
        writeFile(root, "a.md", "# old-a");
        writeFile(root, "b.md", "# hand-b"); // diverged → third value
        const baseline = new Map([
            ["a.md", baselineRow("a.md", sha("# old-a"))],
            ["b.md", baselineRow("b.md", sha("# baseline-b"))],
        ]);
        const plan = multiPlan({ rel: "a.md", text: "# new-a" }, { rel: "b.md", text: "# new-b" });
        const entries = buildDeployEntries(plan, baseline);
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop?.kind).toBe("third_value");
        expect(r.written).toContain("a.md");
        // b.md untouched (CAS refused)
        expect(readFile(root, "b.md")).toBe("# hand-b");
    });

    it("documents the bounded per-file visibility window and restores the old graph after interruption", () => {
        writeFile(root, "skill/SKILL.md", "old-entry");
        writeFile(root, "skill/reference.md", "old-reference");
        const mixedObservations: string[][] = [];
        const interrupted = createTargetIoForTest(root, {
            readFile: (filePath) => fs.readFileSync(filePath),
            writeFile: (filePath, data) => {
                if (filePath.endsWith("reference.md")) throw new Error("injected interruption");
                fs.writeFileSync(filePath, data);
                mixedObservations.push([
                    fs.readFileSync(path.join(root, "skill/SKILL.md"), "utf8"),
                    fs.readFileSync(path.join(root, "skill/reference.md"), "utf8"),
                ]);
            },
            deleteFile: (filePath) => fs.unlinkSync(filePath),
            fileExists: (filePath) => fs.existsSync(filePath),
            fileExecutable: () => false,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "skill/SKILL.md",
                oldHash: sha("old-entry"),
                oldBytesBase64: b64("old-entry"),
                oldExecutable: false,
                newHash: sha("new-entry"),
                newBytesBase64: b64("new-entry"),
                newExecutable: false,
                isRemoval: false,
            },
            {
                relativePath: "skill/reference.md",
                oldHash: sha("old-reference"),
                oldBytesBase64: b64("old-reference"),
                oldExecutable: false,
                newHash: sha("new-reference"),
                newBytesBase64: b64("new-reference"),
                newExecutable: false,
                isRemoval: false,
            },
        ];

        const result = casWriteAll(entries, interrupted);
        expect(result).toMatchObject({
            ok: false,
            mutated: ["skill/SKILL.md"],
            stop: { kind: "write_failed", relativePath: "skill/reference.md" },
        });
        // A runtime that ignores OAAM's locks can observe a mixed graph during
        // the bounded per-file publication window. "Atomic output unit" binds
        // selection/final transaction authority; it is not a consumer-visible
        // directory-exchange guarantee.
        expect(mixedObservations).toEqual([["new-entry", "old-reference"]]);

        expect(rollbackToOld(entries.slice(0, 1), interrupted)).toEqual({ ok: true, failedRelativePaths: [] });
        expect(readFile(root, "skill/SKILL.md")).toBe("old-entry");
        expect(readFile(root, "skill/reference.md")).toBe("old-reference");
    });
});

describe("casWriteAll — removal CAS (H8)", () => {
    let root: string;
    let ctx: TargetIoContext;
    beforeEach(() => {
        root = tmpRoot();
        ctx = createTargetIo(root);
    });
    afterEach(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("missing runtime → written (already removed, no-op)", () => {
        const entries: JournalEntry[] = [
            {
                relativePath: "gone.md",
                oldHash: SHA_OLD,
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(true);
        expect(r.written).toEqual(["gone.md"]);
        expect(r.mutated).toEqual([]);
        expect(exists(root, "gone.md")).toBe(false);
    });

    it("present == baseline → deleted", () => {
        writeFile(root, "old.md", "# baseline");
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(true);
        expect(exists(root, "old.md")).toBe(false);
    });

    it("present != baseline (hand-edited) → third value, NOT deleted", () => {
        writeFile(root, "old.md", "# hand");
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop).toEqual({ kind: "third_value", relativePath: "old.md" });
        expect(readFile(root, "old.md")).toBe("# hand");
    });

    it("content matches but executable bit changed → third value, NOT deleted", () => {
        writeFile(root, "old.md", "# baseline");
        fs.chmodSync(path.join(root, "old.md"), 0o700);
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop).toEqual({ kind: "third_value", relativePath: "old.md" });
        expect(readFile(root, "old.md")).toBe("# baseline");
    });

    it("a fixed-false backend rejects rollback executable=true before a removal", () => {
        let exists = true;
        let deleteCalls = 0;
        const win32 = createTargetIoForTest("C:\\project", {
            readFile: () => Buffer.from("# baseline"),
            writeFile: () => undefined,
            deleteFile: () => {
                deleteCalls += 1;
                exists = false;
            },
            fileExists: () => exists,
            fileExecutable: () => false,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: true,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        expect(casWriteAll(entries, win32)).toEqual({
            ok: false,
            written: [],
            mutated: [],
            stop: { kind: "write_failed", relativePath: "old.md" },
        });
        expect(deleteCalls).toBe(0);
        expect(exists).toBe(true);
    });

    it("whole-batch preflight prevents earlier writes when a later executable state is unsupported", () => {
        const writes: string[] = [];
        const win32 = createTargetIoForTest("C:\\project", {
            readFile: () => Buffer.from(""),
            writeFile: (filePath) => {
                writes.push(filePath);
            },
            deleteFile: () => undefined,
            fileExists: () => false,
            fileExecutable: () => false,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "first.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# first"),
                newBytesBase64: b64("# first"),
                newExecutable: false,
                isRemoval: false,
            },
            {
                relativePath: "run.sh",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# desired"),
                newBytesBase64: b64("# desired"),
                newExecutable: true,
                isRemoval: false,
            },
        ];
        expect(casWriteAll(entries, win32)).toEqual({
            ok: false,
            written: [],
            mutated: [],
            stop: { kind: "write_failed", relativePath: "run.sh" },
        });
        expect(writes).toEqual([]);
    });

    it("backend capability, not target-root grammar, decides executable=true support", () => {
        let windowsPathBytes = "";
        let windowsPathExecutable = false;
        const capableWindowsPath = createTargetIoForTest("C:\\project", {
            readFile: () => Buffer.from(windowsPathBytes),
            writeFile: (_filePath, data) => {
                windowsPathBytes = Buffer.from(data).toString("utf8");
            },
            deleteFile: () => undefined,
            fileExists: () => windowsPathBytes !== "",
            fileExecutable: () => windowsPathExecutable,
            assertExecutableStateSupported: () => undefined,
            chmodIfDifferent: (_filePath, executable) => {
                const changed = windowsPathExecutable !== executable;
                windowsPathExecutable = executable;
                return changed;
            },
        });
        const executableEntry: JournalEntry = {
            relativePath: "run.sh",
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            newHash: sha("# desired"),
            newBytesBase64: b64("# desired"),
            newExecutable: true,
            isRemoval: false,
        };
        expect(casWriteAll([executableEntry], capableWindowsPath)).toMatchObject({ ok: true });
        expect(windowsPathBytes).toBe("# desired");
        expect(windowsPathExecutable).toBe(true);

        const fixedFalseBackend = createTargetIoForTest(root, {
            readFile: () => Buffer.from(""),
            writeFile: () => {
                throw new Error("must not write");
            },
            deleteFile: () => undefined,
            fileExists: () => false,
            fileExecutable: () => false,
        });
        expect(casWriteAll([executableEntry], fixedFalseBackend)).toMatchObject({
            ok: false,
            written: [],
            stop: { kind: "write_failed", relativePath: "run.sh" },
        });
    });

    it("delete failure (hook throws) → write_failed", () => {
        writeFile(root, "old.md", "# baseline");
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                throw new Error("EACCES");
            },
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, faulting);
        expect(r.ok).toBe(false);
        expect(r.stop).toEqual({ kind: "write_failed", relativePath: "old.md" });
    });

    it("removal executable-bit read failure → write_failed before delete", () => {
        writeFile(root, "old.md", "# baseline");
        let deleteCalls = 0;
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                deleteCalls += 1;
                throw new Error("delete must not run");
            },
            fileExists: () => true,
            fileExecutable: () => {
                throw new Error("stat EIO");
            },
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        expect(casWriteAll(entries, faulting).stop).toEqual({
            kind: "write_failed",
            relativePath: "old.md",
        });
        expect(deleteCalls).toBe(0);
        expect(readFile(root, "old.md")).toBe("# baseline");
    });

    it("removal CAS read failure (present but unreadable) → write_failed", () => {
        writeFile(root, "old.md", "# baseline");
        const faulting = createTargetIoForTest(root, {
            readFile: () => {
                throw new Error("EIO");
            },
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => true,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, faulting);
        expect(r.ok).toBe(false);
        expect(r.stop).toEqual({ kind: "write_failed", relativePath: "old.md" });
    });

    it("fsHooks delete passthrough (non-throwing) exercises ioDelete hook branch", () => {
        writeFile(root, "old.md", "# baseline");
        const passthrough = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = casWriteAll(entries, passthrough);
        expect(r.ok).toBe(true);
        expect(exists(root, "old.md")).toBe(false);
    });
});
