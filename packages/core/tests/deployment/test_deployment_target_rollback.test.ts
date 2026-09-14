/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    rollbackToOld,
    createTargetIo,
    createTargetIoForTest,
    type TargetIoContext,
} from "../../src/deployment/deployment-target-io";
import { buildDeployEntries, buildRemovalEntries, populateOldBytes } from "../../src/deployment/deployment-target-entries";
import { casWriteAll } from "../../src/deployment/deployment-target-cas";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import {
    sha,
    b64,
    tmpRoot,
    baselineRow,
    multiPlan,
    writeFile,
    readFile,
    exists,
} from "./fixtures/deployment-target-io-test-fixtures";

describe("rollbackToOld", () => {
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

    it("entry with oldBytes restores old content", () => {
        writeFile(root, "a.md", "# new");
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# old"),
                oldBytesBase64: b64("# old"),
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        rollbackToOld(entries, ctx);
        expect(readFile(root, "a.md")).toBe("# old");
    });

    it("entry with empty oldBytes (first deploy) deletes the file we wrote", () => {
        writeFile(root, "a.md", "# new");
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
        rollbackToOld(entries, ctx);
        expect(exists(root, "a.md")).toBe(false);
    });

    it("removal with both journal sides absent preserves an unexpected present file", () => {
        // Neither journal side authorizes this independently created file.
        writeFile(root, "stray.md", "# stray");
        const entries: JournalEntry[] = [
            {
                relativePath: "stray.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        expect(rollbackToOld(entries, ctx)).toEqual({ ok: false, failedRelativePaths: ["stray.md"] });
        expect(readFile(root, "stray.md")).toBe("# stray");
    });

    it("write failure during rollback is swallowed (best-effort)", () => {
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: () => {
                throw new Error("EIO");
            },
            deleteFile: () => {
                throw new Error("EIO");
            },
            fileExists: (p) => fs.existsSync(p),
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# old"),
                oldBytesBase64: b64("# old"),
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        // The mutation failure is contained but reported so the caller keeps
        // the journal for recovery rather than claiming a clean rollback.
        expect(rollbackToOld(entries, faulting)).toEqual({
            ok: false,
            failedRelativePaths: ["a.md"],
        });
    });

    it("read-back existence failure is reported as an incomplete rollback", () => {
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => {
                throw new Error("stat EIO");
            },
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
        expect(rollbackToOld(entries, faulting)).toEqual({
            ok: false,
            failedRelativePaths: ["a.md"],
        });
    });

    it("entry with empty oldBytes + file already absent → no-op", () => {
        // first-deploy rollback where the file was never written (CAS refused
        // before write) — ioExists returns false, nothing to delete.
        const entries: JournalEntry[] = [
            {
                relativePath: "never.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(() => rollbackToOld(entries, ctx)).not.toThrow();
        expect(exists(root, "never.md")).toBe(false);
    });

    it("a fixed-false backend refuses an executable=true rollback before mutation", () => {
        writeFile(root, "a.md", "# partial");
        const winCtx = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# old"),
                oldBytesBase64: b64("# old"),
                oldExecutable: true,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(rollbackToOld(entries, winCtx)).toEqual({ ok: false, failedRelativePaths: ["a.md"] });
        expect(readFile(root, "a.md")).toBe("# partial");
    });

    it("removal entry with oldBytes → restore the deleted file (audit fix 必修3)", () => {
        // Simulate the half-deploy pollution scenario:
        //   1. removal CAS deleted old.md (== baseline)
        //   2. a later deploy hit third_value
        //   3. executor rolls back the written entries
        // rollbackToOld must RESTORE the removed file from its oldBytes so the
        // aborted deploy leaves no half-pollution.
        // (old.md was deleted by the CAS; it is not present now.)
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: sha("# old-content"),
                oldBytesBase64: b64("# old-content"),
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        expect(exists(root, "old.md")).toBe(false);
        rollbackToOld(entries, ctx);
        expect(exists(root, "old.md")).toBe(true);
        expect(readFile(root, "old.md")).toBe("# old-content");
    });

    it("mixed batch: removal succeeds, later deploy third_value, rollback restores removal file", () => {
        // Full scenario from audit 必修3: build entries, run CAS until third_value
        // stop, then rollback the written set (incl. the removal) — removed file
        // must come back.
        writeFile(root, "old.md", "# old-base");
        writeFile(root, "deploy.md", "# deploy-base");
        writeFile(root, "stuck.md", "# hand"); // diverged → deploy third_value
        const baseline = new Map([
            ["old.md", baselineRow("old.md", sha("# old-base"))],
            ["deploy.md", baselineRow("deploy.md", sha("# deploy-base"))],
            ["stuck.md", baselineRow("stuck.md", sha("# stuck-base"))],
        ]);
        // plan: redeploy deploy.md, deploy stuck.md (will third_value), and old.md
        // is a removal candidate.
        const plan = multiPlan({ rel: "deploy.md", text: "# deploy-new" }, { rel: "stuck.md", text: "# stuck-new" });
        const deployEntries = buildDeployEntries(plan, baseline);
        const removalEntries = buildRemovalEntries(new Set(["deploy.md", "stuck.md"]), [...baseline.values()]);
        // Order: deploy.md, stuck.md (deploy), old.md (removal). To trigger the
        // scenario (removal succeeds THEN deploy third_value) we put removal first.
        const all = [...removalEntries, ...deployEntries];
        // Executor normally reopens these bytes from durable payload authority.
        const durableOld = new Map([
            ["old.md", "# old-base"],
            ["deploy.md", "# deploy-base"],
            ["stuck.md", "# stuck-base"],
        ]);
        for (const entry of all) entry.oldBytesBase64 = b64(durableOld.get(entry.relativePath)!);
        // Validate recovery material and current readability before CAS.
        const pop = populateOldBytes(all, ctx);
        expect(pop).toEqual({ kind: "ok" });
        // old.md removal should succeed (== baseline). deploy.md redeploy succeeds.
        // stuck.md deploy → third_value → stop.
        const r = casWriteAll(all, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop?.kind).toBe("third_value");
        // old.md was deleted by the removal CAS.
        expect(exists(root, "old.md")).toBe(false);
        // Now rollback the written set — old.md must be restored.
        const writtenEntries = all.filter((e) => r.mutated.includes(e.relativePath));
        rollbackToOld(writtenEntries, ctx);
        expect(exists(root, "old.md")).toBe(true);
        expect(readFile(root, "old.md")).toBe("# old-base");
        // deploy.md restored to its old base too.
        expect(readFile(root, "deploy.md")).toBe("# deploy-base");
    });

    it("deploy rollback restores a ZERO-BYTE old file (audit fix: oldHash判absence, 非 oldBytesBase64)", () => {
        // Pre-existing zero-byte file. oldHash = sha256 of empty (non-empty),
        // oldBytesBase64 = "" (base64 of empty bytes). The bug was using
        // oldBytesBase64 === "" to mean absence → this zero-byte file would be
        // deleted on rollback. Fixed: oldHash !== "" → write back empty bytes.
        writeFile(root, "empty.md", "");
        const EMPTY_SHA = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        const entries: JournalEntry[] = [
            {
                relativePath: "empty.md",
                oldHash: EMPTY_SHA,
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        // Simulate: deploy overwrote the zero-byte file with new content.
        writeFile(root, "empty.md", "# new");
        rollbackToOld(entries, ctx);
        // File must exist and be zero-byte (restored), NOT deleted.
        expect(exists(root, "empty.md")).toBe(true);
        expect(fs.readFileSync(path.join(root, "empty.md")).length).toBe(0);
    });

    it("removal rollback restores a ZERO-BYTE old file that was deleted", () => {
        // Removal CAS deleted a zero-byte old managed file. Rollback must
        // restore it as an empty file, not treat oldBytesBase64 === "" as
        // absence and leave it deleted.
        const EMPTY_SHA = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        const entries: JournalEntry[] = [
            {
                relativePath: "empty.md",
                oldHash: EMPTY_SHA,
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        // (File was deleted by the removal CAS; not present now.)
        expect(exists(root, "empty.md")).toBe(false);
        rollbackToOld(entries, ctx);
        expect(exists(root, "empty.md")).toBe(true);
        expect(fs.readFileSync(path.join(root, "empty.md")).length).toBe(0);
    });

    it("first-deploy rollback preserves content different from its exact new state", () => {
        writeFile(root, "newfile.md", "# stray-from-aborted-write");
        const entries: JournalEntry[] = [
            {
                relativePath: "newfile.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(rollbackToOld(entries, ctx)).toEqual({ ok: false, failedRelativePaths: ["newfile.md"] });
        expect(readFile(root, "newfile.md")).toBe("# stray-from-aborted-write");
    });

    it("runtime replacement rollback restores the exact user bytes instead of the managed baseline", () => {
        writeFile(root, "a.md", "# desired");
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# managed baseline"),
                oldBytesBase64: b64("# managed baseline"),
                oldExecutable: false,
                newHash: sha("# desired"),
                newBytesBase64: b64("# desired"),
                newExecutable: false,
                isRemoval: false,
                runtimeRollbackOverride: {
                    state: "present",
                    contentHash: sha("# user edit"),
                    bytesBase64: b64("# user edit"),
                    executable: false,
                },
            },
        ];

        expect(rollbackToOld(entries, ctx)).toEqual({ ok: true, failedRelativePaths: [] });
        expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("# user edit");
    });

    it("runtime replacement rollback restores an exact user absence", () => {
        writeFile(root, "a.md", "# desired");
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# managed baseline"),
                oldBytesBase64: b64("# managed baseline"),
                oldExecutable: false,
                newHash: sha("# desired"),
                newBytesBase64: b64("# desired"),
                newExecutable: false,
                isRemoval: false,
                runtimeRollbackOverride: { state: "missing" },
            },
        ];

        expect(rollbackToOld(entries, ctx)).toEqual({ ok: true, failedRelativePaths: [] });
        expect(exists(root, "a.md")).toBe(false);
    });
});
