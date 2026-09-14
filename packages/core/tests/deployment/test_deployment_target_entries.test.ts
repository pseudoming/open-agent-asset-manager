/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { createTargetIo, createTargetIoForTest, type TargetIoContext } from "../../src/deployment/deployment-target-io";
import { buildDeployEntries, buildRemovalEntries, populateOldBytes } from "../../src/deployment/deployment-target-entries";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import {
    SHA_OLD,
    SHA_NEW,
    sha,
    b64,
    sha256OfBytes,
    tmpRoot,
    baselineRow,
    textPlan,
    writeFile,
    readFile,
} from "./fixtures/deployment-target-io-test-fixtures";

describe("buildDeployEntries", () => {
    it("first deploy (no baseline): oldHash='', oldBytesBase64='', newHash from plan content", () => {
        const plan = textPlan("a.md", "# new");
        const entries = buildDeployEntries(plan, new Map());
        expect(entries).toHaveLength(1);
        const e = entries[0];
        expect(e.relativePath).toBe("a.md");
        expect(e.oldHash).toBe("");
        expect(e.oldBytesBase64).toBe("");
        expect(e.oldExecutable).toBe(false);
        expect(e.newHash).toBe(sha("# new"));
        expect(e.isRemoval).toBe(false);
        // newBytesBase64 round-trips to plan content
        expect(Buffer.from(e.newBytesBase64, "base64").toString("utf-8")).toBe("# new");
    });

    it("redeploy (has baseline): oldHash from baseline appliedContentHash", () => {
        const plan = textPlan("a.md", "# new");
        const baseline = new Map([["a.md", baselineRow("a.md", SHA_OLD, true)]]);
        const entries = buildDeployEntries(plan, baseline);
        expect(entries[0].oldHash).toBe(SHA_OLD);
        expect(entries[0].oldExecutable).toBe(true);
    });

    it("binary content: newBytes from bytes, newHash = sha256(bytes)", () => {
        const bytes = new Uint8Array([0, 255, 128]);
        const plan: TargetPlan = {
            schemaVersion: 1,
            targetFiles: [
                {
                    relativePath: "b.bin",
                    content: { contentKind: "binary", bytes },
                    executable: false,
                    renderedSectionIds: [],
                },
            ],
        };
        const entries = buildDeployEntries(plan, new Map());
        expect(entries[0].newHash).toBe(sha256OfBytes(bytes));
    });
});

describe("buildRemovalEntries", () => {
    it("returns baseline paths not in plan, with isRemoval=true + empty newBytes", () => {
        const baseline = [baselineRow("old.md", SHA_OLD), baselineRow("keep.md", SHA_OLD)];
        const planRels = new Set(["keep.md", "new.md"]);
        const entries = buildRemovalEntries(planRels, baseline);
        expect(entries).toHaveLength(1);
        expect(entries[0].relativePath).toBe("old.md");
        expect(entries[0].isRemoval).toBe(true);
        expect(entries[0].oldHash).toBe(SHA_OLD);
        expect(entries[0].newHash).toBe("");
        expect(entries[0].newBytesBase64).toBe("");
    });

    it("returns [] when all baseline paths are in plan", () => {
        const baseline = [baselineRow("keep.md", SHA_OLD)];
        expect(buildRemovalEntries(new Set(["keep.md"]), baseline)).toEqual([]);
    });
});

describe("populateOldBytes", () => {
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

    it("keeps durable old bytes instead of adopting different live runtime bytes", () => {
        writeFile(root, "a.md", "# hand-edited third value");
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("# baseline"),
                oldBytesBase64: b64("# baseline"),
                oldExecutable: false,
                newHash: SHA_NEW,
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: false,
            },
        ];
        const r = populateOldBytes(entries, ctx);
        expect(r).toEqual({ kind: "ok" });
        expect(Buffer.from(entries[0].oldBytesBase64, "base64").toString("utf-8")).toBe("# baseline");
    });

    it("absent runtime file is ok (oldBytes stays empty)", () => {
        const entries: JournalEntry[] = [
            {
                relativePath: "absent.md",
                oldHash: "",
                oldBytesBase64: "",
                oldExecutable: false,
                newHash: SHA_NEW,
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(populateOldBytes(entries, ctx)).toEqual({ kind: "ok" });
        expect(entries[0].oldBytesBase64).toBe("");
    });

    it("unreadable-but-present file → read_failed", () => {
        writeFile(root, "a.md", "# x");
        const faulting = createTargetIoForTest(root, {
            readFile: () => {
                throw new Error("EACCES");
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
                newHash: SHA_NEW,
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(populateOldBytes(entries, faulting)).toEqual({
            kind: "read_failed",
            relativePath: "a.md",
        });
    });

    it("rejects non-empty recovery bytes when oldHash says the target was absent", () => {
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: "",
                oldBytesBase64: b64("invented"),
                oldExecutable: false,
                newHash: SHA_NEW,
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(populateOldBytes(entries, ctx)).toEqual({
            kind: "read_failed",
            relativePath: "a.md",
        });
    });

    it("rejects durable recovery bytes whose hash disagrees with oldHash", () => {
        const entries: JournalEntry[] = [
            {
                relativePath: "a.md",
                oldHash: sha("expected"),
                oldBytesBase64: b64("different"),
                oldExecutable: false,
                newHash: SHA_NEW,
                newBytesBase64: "",
                newExecutable: false,
                isRemoval: false,
            },
        ];
        expect(populateOldBytes(entries, ctx)).toEqual({
            kind: "read_failed",
            relativePath: "a.md",
        });
    });
});
