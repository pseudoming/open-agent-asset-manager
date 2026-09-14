/** Journal deletion, idempotent cleanup, recovery scan, and freeze-evidence tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    type ActiveJournal,
    deleteJournal,
    findRecoverableJournals,
    hasRecoverableJournal,
    publishJournal,
    readJournal,
    scanActiveJournalReservations,
    scanJournals,
} from "../../src/deployment/deployment-journal";
import { computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";

const D1 = "00000000-0000-4000-8000-000000000001";
const D2 = "00000000-0000-4000-8000-000000000002";
const FP = `sha256:${"a".repeat(64)}`;

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeJournal(txnId: string, deploymentId: string, entries: ActiveJournal["entries"] = []): ActiveJournal {
    return {
        schemaVersion: 1,
        transactionId: txnId,
        deploymentId,
        createdAt: 5000,
        compilationFingerprint: FP,
        reservedPhysicalKeys: computePhysicalClosureKeys(
            "linux",
            "/root",
            entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
            })),
        ),
        entries,
    };
}

describe("deleteJournal", () => {
    let root: string;
    beforeEach(() => {
        root = tmpDir("oaam-journal-del-");
    });
    afterEach(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("rejects a path-like transaction id instead of unlinking outside the transaction root", () => {
        expect(() => deleteJournal(root, "../outside")).toThrow(/UUID v4/);
    });

    it("removes journal.json + txn dir after publish; returns true (audit fix)", () => {
        const txn = "44444444-4444-4444-8444-444444444444";
        publishJournal(root, makeJournal(txn, D1));
        expect(fs.existsSync(path.join(root, txn, "journal.json"))).toBe(true);
        const ok = deleteJournal(root, txn);
        expect(ok).toBe(true);
        expect(fs.existsSync(path.join(root, txn, "journal.json"))).toBe(false);
        expect(fs.existsSync(path.join(root, txn))).toBe(false);
    });

    it("returns true (idempotent) when journal marker never existed", () => {
        const ok = deleteJournal(root, "55555555-5555-4555-8555-555555555555");
        expect(ok).toBe(true);
    });

    it("cleans up residual txn dir even when marker already absent (audit C1)", () => {
        // Simulate a crashed cleanup: txn dir present, journal.json missing.
        // It is not a reservation without the marker, but an idempotent cleanup
        // still removes the debris.
        const txn = "56565656-5656-4565-8565-565656565656";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        expect(fs.existsSync(path.join(root, txn))).toBe(true);
        const ok = deleteJournal(root, txn);
        expect(ok).toBe(true);
        expect(fs.existsSync(path.join(root, txn))).toBe(false);
    });

    it("returns true when called twice (second is idempotent ENOENT)", () => {
        const txn = "66666666-6666-4666-8666-666666666666";
        publishJournal(root, makeJournal(txn, D1));
        expect(deleteJournal(root, txn)).toBe(true);
        expect(deleteJournal(root, txn)).toBe(true);
    });

    it("rejects a symlinked txn directory without deleting outside marker data", () => {
        const txn = "57575757-5757-4575-8575-575757575757";
        const outside = tmpDir("oaam-journal-delete-outside-");
        const outsideMarker = path.join(outside, "journal.json");
        try {
            fs.writeFileSync(outsideMarker, "keep");
            fs.symlinkSync(outside, path.join(root, txn));
            expect(() => deleteJournal(root, txn)).toThrow(/reconciled/);
            expect(fs.readFileSync(outsideMarker, "utf-8")).toBe("keep");
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    // Detect whether chmod-based permission injection is supported on this FS.
    // Uses its own temp dir (not the test's beforeEach `root`) because
    // it.skipIf evaluates at module load time, before beforeEach runs.
    function canChmodRestrict(): boolean {
        const probeDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "oaam-chmod-probe-"));
        const probe = path.join(probeDir, "probe.txt");
        try {
            fs.writeFileSync(probe, "x");
            fs.chmodSync(probe, 0o000);
            // If we can still read the file, chmod is not enforced.
            fs.accessSync(probe, fs.constants.R_OK);
            return false; // chmod not enforced
        } catch {
            return true; // chmod IS enforced
        } finally {
            try {
                fs.chmodSync(probe, 0o644);
            } catch {
                /* ignore */
            }
            try {
                fs.rmSync(probeDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }
    }

    it.skipIf(!canChmodRestrict())("THROWS when marker unlink fails and marker still present", () => {
        const txn = "67676767-6767-4676-8767-676767676767";
        publishJournal(root, makeJournal(txn, D1));
        const jp = path.join(root, txn, "journal.json");
        const dir = path.join(root, txn);
        fs.chmodSync(jp, 0o444);
        fs.chmodSync(dir, 0o555);
        try {
            expect(() => deleteJournal(root, txn)).toThrow();
            expect(fs.existsSync(jp)).toBe(true);
        } finally {
            try {
                fs.chmodSync(dir, 0o755);
            } catch {
                /* ignore */
            }
            try {
                fs.chmodSync(jp, 0o644);
            } catch {
                /* ignore */
            }
        }
    });
});

describe("findRecoverableJournals / hasRecoverableJournal", () => {
    let root: string;
    beforeEach(() => {
        root = tmpDir("oaam-journal-scan-");
    });
    afterEach(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("returns [] when transactionsRoot does not exist", () => {
        expect(findRecoverableJournals(path.join(root, "nope"), D1)).toEqual([]);
        expect(hasRecoverableJournal(path.join(root, "nope"), D1)).toBe(false);
    });

    it("returns [] when transactionsRoot is empty", () => {
        expect(findRecoverableJournals(root, D1)).toEqual([]);
    });

    it("throws on a symlinked transactions root instead of bypassing the freeze gate", () => {
        const outside = tmpDir("oaam-journal-scan-outside-");
        const linkedRoot = path.join(root, "linked-transactions");
        try {
            fs.symlinkSync(outside, linkedRoot);
            expect(() => scanJournals(linkedRoot, D1)).toThrow(/symbolic|link/i);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it("returns txnIds whose journal deploymentId matches", () => {
        const txn = "77777777-7777-4777-8777-777777777777";
        publishJournal(root, makeJournal(txn, D1));
        expect(findRecoverableJournals(root, D1)).toEqual([txn]);
        expect(hasRecoverableJournal(root, D1)).toBe(true);
    });

    it("filters out journals of other deployments", () => {
        const t1 = "88888888-8888-4888-8888-888888888888";
        const t2 = "99999999-9999-4999-8999-999999999999";
        publishJournal(root, makeJournal(t1, D1));
        publishJournal(root, makeJournal(t2, D2));
        expect(findRecoverableJournals(root, D1)).toEqual([t1]);
        expect(findRecoverableJournals(root, D2)).toEqual([t2]);
        expect(scanActiveJournalReservations(root).journals.map((journal) => journal.transactionId)).toEqual([t1, t2]);
    });

    it("throws when the journal authority root is not a directory", () => {
        const fileNotDir = path.join(root, "notadir");
        fs.writeFileSync(fileNotDir, "x");
        expect(() => findRecoverableJournals(fileNotDir, D1)).toThrow(/directory/);
    });

    it("skips non-directory entries in transactionsRoot", () => {
        // A stray file at top level (not a journal dir).
        fs.writeFileSync(path.join(root, "stray.txt"), "x");
        // Plus a real journal dir for D1.
        const txn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        publishJournal(root, makeJournal(txn, D1));
        expect(findRecoverableJournals(root, D1)).toEqual([txn]);
    });

    it("scanJournals reports corrupt journal.json in corruptTxnIds (H5 fail-closed, audit fix)", () => {
        // A dir whose journal.json is corrupt. readJournal returns null; the
        // scan MUST surface it in corruptTxnIds (not silently skip) so the
        // executor freeze gate can fail-closed.
        const corruptTxn = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        fs.mkdirSync(path.join(root, corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(root, corruptTxn, "journal.json"), "garbage");
        const res = scanJournals(root, D1);
        expect(res.matchingTxnIds).toEqual([]);
        expect(res.corruptTxnIds).toEqual([corruptTxn]);
    });

    it("throws when a journal marker is a symlink instead of treating inspection failure as empty", () => {
        const txn = "11111111-2222-4333-8444-555555555555";
        const dir = path.join(root, txn);
        const outside = path.join(root, "outside-marker.json");
        fs.mkdirSync(dir);
        fs.writeFileSync(outside, "not a journal");
        fs.symlinkSync(outside, path.join(dir, "journal.json"));

        expect(() => scanJournals(root, D1)).toThrow(/symbolic|link/i);
        expect(fs.readFileSync(outside, "utf-8")).toBe("not a journal");
    });

    it("scanJournals ignores a marker-less txn dir because no reservation was published", () => {
        const residualTxn = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
        fs.mkdirSync(path.join(root, residualTxn), { recursive: true });
        // No marker means either pre-publish or post-delete debris. Runtime
        // writes cannot legally start in the former case; reservation ended in
        // the latter case.
        const res = scanJournals(root, D1);
        expect(res.corruptTxnIds).toEqual([]);
    });

    it("scanJournals reports corrupt for EVERY deploymentId (cannot attribute by content)", () => {
        const corruptTxn = "bdbdbdbd-bdbd-4bdb-8bdb-bdbdbdbdbdbd";
        fs.mkdirSync(path.join(root, corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(root, corruptTxn, "journal.json"), "garbage");
        // Corrupt journals have no readable deploymentId, so they are reported
        // for any scan — the caller freezes conservatively.
        expect(scanJournals(root, D1).corruptTxnIds).toEqual([corruptTxn]);
        expect(scanJournals(root, D2).corruptTxnIds).toEqual([corruptTxn]);
    });

    it("scanJournals separates matching + corrupt in one scan", () => {
        const matchTxn = "bebebebe-bebe-4ebe-8ebe-bebebebebebe";
        const corruptTxn = "bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfbf";
        publishJournal(root, makeJournal(matchTxn, D1));
        fs.mkdirSync(path.join(root, corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(root, corruptTxn, "journal.json"), "{bad");
        const res = scanJournals(root, D1);
        expect(res.matchingTxnIds).toEqual([matchTxn]);
        expect(res.corruptTxnIds).toEqual([corruptTxn]);
    });

    it("scanJournals skips non-UUID dirs (e.g. locks/ sibling) — not mis-reported as corrupt", () => {
        // The locks/ sibling dir is not a txn dir; it must not appear in
        // corruptTxnIds (would cause spurious freeze).
        fs.mkdirSync(path.join(root, "locks"), { recursive: true });
        fs.writeFileSync(path.join(root, "locks", "abc.lock"), "1");
        const res = scanJournals(root, D1);
        expect(res.matchingTxnIds).toEqual([]);
        expect(res.corruptTxnIds).toEqual([]);
    });

    it("findRecoverableJournals still returns only matching (resolvable) journals", () => {
        // findRecoverableJournals is the recovery-style helper; it intentionally
        // does NOT report corrupt (freeze gate must use scanJournals instead).
        const matchTxn = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
        const corruptTxn = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
        publishJournal(root, makeJournal(matchTxn, D1));
        fs.mkdirSync(path.join(root, corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(root, corruptTxn, "journal.json"), "garbage");
        expect(findRecoverableJournals(root, D1)).toEqual([matchTxn]);
        expect(hasRecoverableJournal(root, D1)).toBe(true);
    });
});
