/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTargetIo, createTargetIoForTest, type TargetIoContext } from "../../src/deployment/deployment-target-io";
import { buildDeployEntries, buildRemovalEntries } from "../../src/deployment/deployment-target-entries";
import { casWriteAll } from "../../src/deployment/deployment-target-cas";
import { verifyAll } from "../../src/deployment/deployment-target-verify";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
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

describe("verifyAll", () => {
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

    it("hash + executable match → ok with verified record", () => {
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
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(true);
        expect(r.verified[0].appliedContentHash).toBe(sha("# new"));
        expect(r.verified[0].observedState).toBe("present");
    });

    it("hash mismatch → verification_failed", () => {
        writeFile(root, "a.md", "# wrong");
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
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.failures[0].message).toContain("hash mismatch");
    });

    it("missing after write → verification_failed", () => {
        const entries: JournalEntry[] = [
            {
                relativePath: "absent.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.failures[0].message).toContain("missing after write");
    });

    it("removal residual (file still exists) → verification_failed", () => {
        writeFile(root, "old.md", "# leftover");
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: SHA_OLD,
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.failures[0].message).toContain("removal target still exists");
    });

    it("removal success (file gone) → ok", () => {
        const entries: JournalEntry[] = [
            {
                relativePath: "old.md",
                oldHash: SHA_OLD,
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: "",
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: true,
            },
        ];
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(true);
        expect(r.verified).toEqual([]);
    });

    it("verify read failure (hook throws) → verification_failed", () => {
        writeFile(root, "a.md", "# new");
        const faulting = createTargetIoForTest(root, {
            readFile: () => {
                throw new Error("EIO");
            },
            writeFile: () => {
                throw new Error("no");
            },
            deleteFile: () => {
                throw new Error("no");
            },
            fileExists: () => true,
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
        const r = verifyAll(entries, faulting);
        expect(r.ok).toBe(false);
        expect(r.failures[0].message).toContain("verify stable observation failed");
    });

    it("executable failure inside the stable post-write observation → verification_failed", () => {
        writeFile(root, "a.md", "# new");
        const faulting = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: () => undefined,
            deleteFile: () => undefined,
            fileExists: () => true,
            fileExecutable: () => {
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

        const result = verifyAll(entries, faulting);
        expect(result.ok).toBe(false);
        expect(result.failures[0].message).toContain("verify stable observation failed");
    });

    it("verifies the executable fact returned by the selected backend", () => {
        writeFile(root, "run.sh", "# new");
        const fixedFalseContext = createTargetIoForTest(root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const entries: JournalEntry[] = [
            {
                relativePath: "run.sh",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: true,
                isRemoval: false,
            },
        ];
        const r = verifyAll(entries, fixedFalseContext);
        expect(r.ok).toBe(false);
        expect(r.verified).toEqual([]);
        expect(r.failures[0].message).toContain("expected true got false");
    });

    it("executable bit drift after write (unix) → verification_failed", () => {
        // Write the file with executable=true intent; the CAS path would have
        // chmod'd the owner-execute bit on. Simulate post-write drift by clearing
        // the bit between write and verify, then verify catches the mismatch.
        writeFile(root, "run.sh", "# new");
        fs.chmodSync(path.join(root, "run.sh"), (fs.statSync(path.join(root, "run.sh")).mode & 0o777) | 0o100);
        // simulate drift: clear owner-execute
        fs.chmodSync(path.join(root, "run.sh"), fs.statSync(path.join(root, "run.sh")).mode & 0o777 & ~0o100);
        const entries: JournalEntry[] = [
            {
                relativePath: "run.sh",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# new"),
                newBytesBase64: b64("# new"),
                newExecutable: true,
                isRemoval: false,
            },
        ];
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.failures[0].message).toContain("executable bit mismatch");
    });

    it("partial pass + fail: verified[] and failures[] both non-empty", () => {
        writeFile(root, "ok.md", "# good");
        writeFile(root, "bad.md", "# wrong");
        const entries: JournalEntry[] = [
            {
                relativePath: "ok.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# good"),
                newBytesBase64: b64("# good"),
                newExecutable: false,
                isRemoval: false,
            },
            {
                relativePath: "bad.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: sha("# expected"),
                newBytesBase64: b64("# expected"),
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = verifyAll(entries, ctx);
        expect(r.ok).toBe(false);
        expect(r.verified.map((v) => v.relativePath)).toEqual(["ok.md"]);
        expect(r.failures.map((f) => f.path)).toEqual(["bad.md"]);
    });
});

describe("casWriteAll — mixed deploy + removal batch", () => {
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

    it("processes deploy + removal in journal order; stops at first third_value", () => {
        // baseline: old.md (will be removed), mid.md (will be redeployed)
        writeFile(root, "old.md", "# old-base");
        writeFile(root, "mid.md", "# mid-base");
        // deploy mid.md (== baseline), then remove old.md (== baseline), then
        // deploy new.md (first deploy) — all should succeed.
        const baseline = new Map([
            ["old.md", baselineRow("old.md", sha("# old-base"))],
            ["mid.md", baselineRow("mid.md", sha("# mid-base"))],
        ]);
        const plan = multiPlan({ rel: "mid.md", text: "# mid-new" }, { rel: "new.md", text: "# brand-new" });
        const deployEntries = buildDeployEntries(plan, baseline);
        const removalEntries = buildRemovalEntries(new Set(["mid.md", "new.md"]), [...baseline.values()]);
        const all = [...deployEntries, ...removalEntries];
        const r = casWriteAll(all, ctx);
        expect(r.ok).toBe(true);
        expect(readFile(root, "mid.md")).toBe("# mid-new");
        expect(readFile(root, "new.md")).toBe("# brand-new");
        expect(exists(root, "old.md")).toBe(false);
    });

    it("mixed batch stops at a removal third_value; earlier deploy entries counted written", () => {
        writeFile(root, "deploy.md", "# deploy-base");
        writeFile(root, "stuck.md", "# hand-edited"); // diverged → removal third value
        const baseline = new Map([
            ["deploy.md", baselineRow("deploy.md", sha("# deploy-base"))],
            ["stuck.md", baselineRow("stuck.md", sha("# stuck-base"))],
        ]);
        const plan = multiPlan({ rel: "deploy.md", text: "# deploy-new" });
        const deployEntries = buildDeployEntries(plan, baseline);
        const removalEntries = buildRemovalEntries(new Set(["deploy.md"]), [...baseline.values()]);
        const all = [...deployEntries, ...removalEntries];
        const r = casWriteAll(all, ctx);
        expect(r.ok).toBe(false);
        expect(r.stop?.kind).toBe("third_value");
        expect(r.stop).toMatchObject({ relativePath: "stuck.md" });
        expect(r.written).toContain("deploy.md");
        // stuck.md NOT deleted (hand-edited preserved)
        expect(readFile(root, "stuck.md")).toBe("# hand-edited");
    });
});
