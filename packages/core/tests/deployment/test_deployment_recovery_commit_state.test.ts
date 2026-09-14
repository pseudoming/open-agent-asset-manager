/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import { createTargetIoForTest } from "../../src/deployment/deployment-target-io";
import {
    TXN_YES,
    TXN_NO,
    sha,
    EMPTY_SHA,
    type Harness,
    recoverDeployment,
    harness,
    b64,
    deployEntry,
    removalEntry,
    publish,
    writeFile,
    read,
    exists,
} from "./fixtures/deployment-recovery-test-fixtures";

describe("recoverDeployment — commit=yes (converge-to-new)", () => {
    let h: Harness;
    beforeEach(() => {
        h = harness(TXN_YES);
    });
    afterEach(() => h.cleanup());

    it("all targets already at new → recovered_to_new (no-op)", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# new"); // already converged
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("recovered_to_new");
        expect(r.journalResolved).toBe(true);
        expect(read(h.root, "a.md")).toBe("# new");
    });

    it("target at old → written to new", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# old");
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("recovered_to_new");
        expect(read(h.root, "a.md")).toBe("# new");
    });

    it("commit=yes restores the committed executable bit from journal authority", () => {
        const entry = deployEntry("run.sh", "old", "new");
        entry.newExecutable = true;
        publish(h, TXN_YES, [entry]);
        writeFile(h.root, "run.sh", "old");
        const result = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(result.outcome).toBe("recovered_to_new");
        expect((fs.statSync(path.join(h.root, "run.sh")).mode & 0o111) !== 0).toBe(true);
    });

    it("a fixed-false backend blocks commit=yes executable=true before mutation", () => {
        const entry = deployEntry("run.sh", "old", "new");
        entry.newExecutable = true;
        publish(h, TXN_YES, [entry]);
        writeFile(h.root, "run.sh", "old");
        const winCtx = createTargetIoForTest(h.root, {
            readFile: (filePath) => fs.readFileSync(filePath),
            writeFile: (filePath, data) => fs.writeFileSync(filePath, data),
            deleteFile: (filePath) => fs.unlinkSync(filePath),
            fileExists: (filePath) => fs.existsSync(filePath),
        });

        const result = recoverDeployment(h.db, winCtx, h.txnRoot, TXN_YES);
        expect(result.outcome).toBe("blocked");
        expect(result.reasonCode).toBe("blocked_by_recovery_target_unavailable");
        expect(read(h.root, "run.sh")).toBe("old");
        expect((fs.statSync(path.join(h.root, "run.sh")).mode & 0o111) !== 0).toBe(false);
    });

    it("removal target at old → deleted", () => {
        const e = removalEntry("old.md", "# old-content");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "old.md", "# old-content");
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("recovered_to_new");
        expect(exists(h.root, "old.md")).toBe(false);
    });

    it("removal target already absent → no-op (recovered)", () => {
        const e = removalEntry("old.md", "# old-content");
        publish(h, TXN_YES, [e]);
        // file absent = already at new (removal) state
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("recovered_to_new");
        expect(exists(h.root, "old.md")).toBe(false);
    });

    it("third value (neither old nor new) → blocked, runtime untouched", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# surprise"); // third value
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_changed");
        expect(r.journalResolved).toBe(false);
        expect(read(h.root, "a.md")).toBe("# surprise"); // untouched
    });

    it("io failure on write → blocked_by_recovery_target_unavailable", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# old");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: () => {
                throw new Error("EIO");
            },
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("write-back verify catches a write that didn't take → blocked", () => {
        // writeFile succeeds (no throw) but writes wrong bytes, so write-back
        // hash != newHash → io_failed → blocked.
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# old");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p) => {
                fs.writeFileSync(p, "# wrong");
            }, // writes wrong content
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("io failure on read → blocked_by_recovery_target_unavailable", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# old");
        const faulting = createTargetIoForTest(h.root, {
            readFile: () => {
                throw new Error("EIO");
            },
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => true,
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("io failure on existence probe → blocked_by_recovery_target_unavailable", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => {
                throw new Error("stat EIO");
            },
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("removal converge: delete failure → blocked", () => {
        const e = removalEntry("old.md", "# old-content");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "old.md", "# old-content");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                throw new Error("EACCES");
            },
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("removal converge: file vanished between read + ioExists → no-op delete", () => {
        // current hash read says == oldHash (file present), but ioExists in the
        // delete branch returns false (file vanished between read + delete).
        // ioDelete is skipped; outcome still recovered_to_new.
        const e = removalEntry("old.md", "# old-content");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "old.md", "# old-content");
        let existsCount = 0;
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                throw new Error("should not be called");
            },
            fileExists: () => {
                existsCount++;
                // first call (readCurrentHash) → true; delete branch ioExists → false
                return existsCount === 1;
            },
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("recovered_to_new");
    });

    it("removal converge: delete no-op (file still present) → blocked (audit 必修1 delete verify)", () => {
        // deleteFile does not throw but leaves the file present → verify-absent
        // catches it → io_failed → blocked.
        const e = removalEntry("old.md", "# old-content");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "old.md", "# old-content");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                /* silent no-op: file stays */
            },
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
        expect(r.journalResolved).toBe(false);
        // file still present (delete was a no-op)
        expect(exists(h.root, "old.md")).toBe(true);
    });

    it("removal converge: post-delete existence probe failure → blocked", () => {
        const e = removalEntry("old.md", "# old-content");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "old.md", "# old-content");
        let existsCount = 0;
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => {
                existsCount++;
                if (existsCount === 3) throw new Error("post-delete stat EIO");
                return fs.existsSync(p);
            },
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
        expect(r.journalResolved).toBe(false);
    });
});

describe("recoverDeployment — commit=no (restore-to-old)", () => {
    let h: Harness;
    beforeEach(() => {
        h = harness("");
    }); // committedTransactionId="" != TXN_NO → commit=no
    afterEach(() => h.cleanup());

    it("all targets already at old → recovered_to_old (no-op)", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# old");
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("recovered_to_old");
        expect(read(h.root, "a.md")).toBe("# old");
    });

    it("target at new → restored to old", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new"); // was written by the failed deploy
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("recovered_to_old");
        expect(read(h.root, "a.md")).toBe("# old");
    });

    it("target at new → restores the exact user bytes captured by replacement authority", () => {
        const e: JournalEntry = {
            ...deployEntry("a.md", "# managed baseline", "# new"),
            runtimeRollbackOverride: {
                state: "present",
                contentHash: sha("# user edit"),
                bytesBase64: b64("# user edit"),
                executable: false,
            },
        };
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new");

        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);

        expect(r.outcome).toBe("recovered_to_old");
        expect(read(h.root, "a.md")).toBe("# user edit");
    });

    it("target at new → restores the exact user absence captured by replacement authority", () => {
        const e: JournalEntry = {
            ...deployEntry("a.md", "# managed baseline", "# new"),
            runtimeRollbackOverride: { state: "missing" },
        };
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new");

        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);

        expect(r.outcome).toBe("recovered_to_old");
        expect(exists(h.root, "a.md")).toBe(false);
    });

    it("target at new, oldHash='' (did not exist) → deleted", () => {
        const e: JournalEntry = {
            relativePath: "created.md",
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            newHash: sha("# created"),
            newBytesBase64: b64("# created"),
            newExecutable: false,
            isRemoval: false,
        };
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "created.md", "# created");
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("recovered_to_old");
        expect(exists(h.root, "created.md")).toBe(false);
    });

    it("ZERO-BYTE old file (oldHash=sha256-empty, oldBytes='') → restored as empty file, NOT deleted", () => {
        const e: JournalEntry = {
            relativePath: "empty.md",
            oldHash: EMPTY_SHA,
            oldBytesBase64: "",
            oldExecutable: false,
            newHash: sha("# new"),
            newBytesBase64: b64("# new"),
            newExecutable: false,
            isRemoval: false,
        };
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "empty.md", "# new"); // was overwritten by failed deploy
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("recovered_to_old");
        expect(exists(h.root, "empty.md")).toBe(true);
        expect(fs.readFileSync(path.join(h.root, "empty.md")).length).toBe(0);
    });

    it("third value → blocked, runtime untouched", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# surprise"); // third value
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_changed");
        expect(read(h.root, "a.md")).toBe("# surprise");
    });

    it("io failure on write → blocked_by_recovery_target_unavailable", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: () => {
                throw new Error("EIO");
            },
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("io failure on read → blocked", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new");
        const faulting = createTargetIoForTest(h.root, {
            readFile: () => {
                throw new Error("EIO");
            },
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: () => true,
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("restore absent-target delete failure → blocked", () => {
        // oldHash="" (did not exist) + at new → restore = delete. delete throws.
        const e: JournalEntry = {
            relativePath: "created.md",
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            newHash: sha("# created"),
            newBytesBase64: b64("# created"),
            newExecutable: false,
            isRemoval: false,
        };
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "created.md", "# created");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                throw new Error("EACCES");
            },
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("a fixed-false backend restores executable=false without a chmod hook", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new");
        const fixedFalseContext = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, fixedFalseContext, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("recovered_to_old");
        expect(read(h.root, "a.md")).toBe("# old");
    });

    it("a fixed-false backend blocks commit=no executable=true before restore mutation", () => {
        const entry = deployEntry("run.sh", "old", "new");
        entry.oldExecutable = true;
        publish(h, TXN_NO, [entry]);
        writeFile(h.root, "run.sh", "new");
        const fixedFalse = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });

        const result = recoverDeployment(h.db, fixedFalse, h.txnRoot, TXN_NO);
        expect(result.outcome).toBe("blocked");
        expect(result.reasonCode).toBe("blocked_by_recovery_target_unavailable");
        expect(read(h.root, "run.sh")).toBe("new");
    });

    it("restore write-back read failure → blocked", () => {
        // write succeeds, but write-back read throws → io_failed.
        let readCount = 0;
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "a.md", "# new");
        const faulting = createTargetIoForTest(h.root, {
            readFile: () => {
                readCount++;
                if (readCount >= 2) throw new Error("EIO"); // first read = CAS; second = write-back
                return fs.readFileSync(path.join(h.root, "a.md"));
            },
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: (p) => fs.unlinkSync(p),
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
    });

    it("removal/absent-target ioExists=false on restore delete → no-op delete", () => {
        // oldHash="" + at new, but file already absent at restore time → ioExists
        // false → skip delete (no ioDelete call). Still recovered_to_old.
        const e: JournalEntry = {
            relativePath: "ghost.md",
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            newHash: sha("# x"),
            newBytesBase64: b64("# x"),
            newExecutable: false,
            isRemoval: false,
        };
        publish(h, TXN_NO, [e]);
        // Don't write the file — but then current hash = "" which != newHash
        // (newHash is sha of "# x") → would be third_value. To hit the delete
        // branch we need the file present at new. Use a faulting ctx that reports
        // fileExists=false on the SECOND call (after the initial read).
        writeFile(h.root, "ghost.md", "# x");
        let existsCount = 0;
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                throw new Error("should not be called");
            },
            fileExists: () => {
                existsCount++;
                // first call (readCurrentHash) → true; the delete branch's
                // ioExists → false (simulate file vanished between read + delete)
                return existsCount === 1;
            },
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("recovered_to_old");
    });

    it("restore absent-target delete no-op (file still present) → blocked (audit 必修1 delete verify)", () => {
        // oldHash="" + at new → restore = delete. deleteFile is a silent no-op
        // (file stays) → verify-absent catches it → io_failed → blocked.
        const e: JournalEntry = {
            relativePath: "created.md",
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            newHash: sha("# created"),
            newBytesBase64: b64("# created"),
            newExecutable: false,
            isRemoval: false,
        };
        publish(h, TXN_NO, [e]);
        writeFile(h.root, "created.md", "# created");
        const faulting = createTargetIoForTest(h.root, {
            readFile: (p) => fs.readFileSync(p),
            writeFile: (p, d) => fs.writeFileSync(p, d),
            deleteFile: () => {
                /* silent no-op */
            },
            fileExists: (p) => fs.existsSync(p),
            fileExecutable: () => false,
        });
        const r = recoverDeployment(h.db, faulting, h.txnRoot, TXN_NO);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_target_unavailable");
        expect(r.journalResolved).toBe(false);
        expect(exists(h.root, "created.md")).toBe(true);
    });
});
