/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type Database from "better-sqlite3";
import { getDeployment } from "../../src/persistence/state-db";
import { publishJournal, scanJournals } from "../../src/deployment/deployment-journal";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import {
    D1,
    type H,
    harness,
    executeDeployment,
    seedRealBaseline,
    textPlan,
    writeFile,
    exists,
} from "./fixtures/deployment-executor-test-fixtures";

describe("executeDeployment — probe tx error safety", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    it("findActivePathOccupiers throws → error propagates, no journal, no runtime write", () => {
        // Inject a faulting db that makes the occupancy query throw.
        // We can't easily count prepare calls across all DB users, so instead
        // we wrap prepare to throw on any SQL containing "deployment_files"
        // (the occupancy query JOIN table).
        const realPrepare = h.db.prepare.bind(h.db);
        const faultingDb = {
            exec: h.db.exec.bind(h.db),
            prepare: (sql: string) => {
                // Only throw on the occupancy JOIN query (contains both
                // deployment_files + JOIN deployments), not on baseline queries
                // (listDeploymentFiles also queries deployment_files but without JOIN).
                if (sql.includes("deployment_files") && sql.includes("JOIN deployments")) {
                    throw new Error("occupancy query EIO");
                }
                return realPrepare(sql);
            },
            transaction: h.db.transaction.bind(h.db),
            pragma: h.db.pragma.bind(h.db),
        } as unknown as Database.Database;
        const opts = { ...h.opts, db: faultingDb };
        expect(() => executeDeployment(opts, textPlan("a.md", "# x"))).toThrow(/query EIO/);
        // No runtime file written.
        expect(exists(h.root, "a.md")).toBe(false);
        // DB is usable after (no dangling tx blocking further operations).
        const r2 = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r2.outcome).toBe("committed");
    });

    it("probe tx COMMIT throws → no journal / no runtime write / no baseline commit; DB usable after", () => {
        // The executor wraps probeTx.commit() in try/catch: on COMMIT throw it
        // best-effort rolls back and re-throws, never proceeding to publishJournal
        // / casWriteAll / commit. This test drives that path deterministically by
        // wrapping db.exec to throw on "COMMIT" specifically (BEGIN IMMEDIATE and
        // ROLLBACK pass through to realExec).
        const realExec = h.db.exec.bind(h.db);
        const faultingDb = {
            exec: (sql: string) => {
                if (sql === "COMMIT") throw new Error("simulated COMMIT failure");
                return realExec(sql);
            },
            prepare: h.db.prepare.bind(h.db),
            transaction: h.db.transaction.bind(h.db),
            pragma: h.db.pragma.bind(h.db),
        } as unknown as Database.Database;
        const opts = { ...h.opts, db: faultingDb };
        expect(() => executeDeployment(opts, textPlan("a.md", "# x"))).toThrow(/simulated COMMIT failure/);
        // COMMIT happens before publishJournal (executor step 8 < step 9), so:
        expect(exists(h.root, "a.md")).toBe(false); // no runtime write
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(0); // no journal
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(""); // no baseline commit
        // DB usable after (rollback succeeded or no dangling tx): a normal deploy works.
        const r2 = executeDeployment(h.opts, textPlan("a.md", "# x"));
        expect(r2.outcome).toBe("committed");
    });

    it("probe tx COMMIT throws AND rollback throws → original COMMIT error still propagates", () => {
        // The catch block best-effort rolls back but must NOT swallow the original
        // error if rollback also fails. Wrap exec to throw on both COMMIT and
        // ROLLBACK; the original COMMIT error must surface.
        const realExec = h.db.exec.bind(h.db);
        const faultingDb = {
            exec: (sql: string) => {
                if (sql === "COMMIT") throw new Error("simulated COMMIT failure");
                if (sql === "ROLLBACK") throw new Error("simulated ROLLBACK failure");
                return realExec(sql);
            },
            prepare: h.db.prepare.bind(h.db),
            transaction: h.db.transaction.bind(h.db),
            pragma: h.db.pragma.bind(h.db),
        } as unknown as Database.Database;
        const opts = { ...h.opts, db: faultingDb };
        expect(() => executeDeployment(opts, textPlan("a.md", "# x"))).toThrow(/simulated COMMIT failure/);
        expect(exists(h.root, "a.md")).toBe(false);
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(0);
    });
});

describe("executeDeployment — baseline path safety (pre-write validation)", () => {
    let h: H;
    beforeEach(() => {
        h = harness();
    });
    afterEach(() => h.cleanup());

    /** Seed one active baseline DeploymentFile row with a raw (possibly bad) path. */
    function seedBaseline(rel: string): void {
        seedRealBaseline(h, D1, "safe-fixture.md", "# base");
        h.db
            .prepare("UPDATE deployment_files SET relative_path = ? WHERE deployment_id = ? AND relative_path = ?")
            .run(rel, D1, "safe-fixture.md");
    }

    it("baseline ../escape.md + empty plan → blocked; sibling escape.md NOT deleted (audit Addition 20: unique parent fixture)", () => {
        // Place a sentinel file as a SIBLING of targetRoot whose hash matches the
        // bad baseline row. A removal CAS that trusted the traversal path would
        // resolve absPath = path.join(root, ../escape.md) = <parent>/escape.md
        // and delete it. Canonical validation must block before that.
        //
        // audit Addition 20: do NOT write to a fixed /tmp/escape.md — h.root's
        // parent is os.tmpdir() itself. Use a unique per-test parent dir so the
        // sentinel never lands on a shared public path.
        const escapeParent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-escape-parent-"));
        const nestedRoot = path.join(escapeParent, "target");
        fs.mkdirSync(nestedRoot, { recursive: true });
        const escapeAbs = path.join(escapeParent, "escape.md");
        fs.writeFileSync(escapeAbs, "# base"); // hash matches baseline below
        // Point the deployment at the nested root so ../escape.md resolves
        // inside escapeParent, not /tmp.
        h.db.prepare("UPDATE deployments SET target_root_path = ? WHERE deployment_id = ?").run(nestedRoot, D1);
        h.root = nestedRoot; // so exists()/harness cleanup use the nested root
        seedBaseline("../escape.md");
        const emptyPlan: TargetPlan = { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] };
        const r = executeDeployment(h.opts, emptyPlan);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
        // The sibling file must still exist (removal CAS never ran).
        expect(fs.existsSync(escapeAbs)).toBe(true);
        // No journal, no baseline advance.
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(0);
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe("");
        // cleanup the unique parent (harness cleanup only knows h.root).
        try {
            fs.rmSync(escapeParent, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("baseline /abs.md → blocked", () => {
        seedBaseline("/abs.md");
        const r = executeDeployment(h.opts, { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });

    it("baseline a\\b.md (backslash) → blocked", () => {
        seedBaseline("a\\b.md");
        const r = executeDeployment(h.opts, { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });

    it("baseline a.md/ (trailing slash) → blocked", () => {
        seedBaseline("a.md/");
        const r = executeDeployment(h.opts, { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });

    it("baseline a//b.md (non-canonical alias) → blocked", () => {
        // a//b.md normalizes to a/b.md; isPosixRelativePath accepts it but
        // isCanonicalRelativePath rejects. Without canonical validation the
        // raw string would bypass single-writer raw-string matching. The
        // strict baseline projector rejects it before target I/O is created.
        seedBaseline("a//b.md");
        const r = executeDeployment(h.opts, { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });

    it("plan a/b.md + baseline a//b.md (non-canonical baseline) → blocked", () => {
        // The threat: a non-canonical baseline alias (a//b.md) coexisting with a
        // canonical plan path (a/b.md) would feed two journal entries that
        // raw-string occupancy/lock queries treat as distinct. The strict
        // baseline projector rejects a//b.md before any lock/journal/write, so this combination is
        // blocked regardless of the plan path.
        seedBaseline("a//b.md");
        const r = executeDeployment(h.opts, textPlan("a/b.md", "# x"));
        // baseline a//b.md fails strict projection; blocked before any side effect.
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
        expect(exists(h.root, "a/b.md")).toBe(false); // no runtime write
        expect(scanJournals(h.txnRoot, D1).matchingTxnIds.length).toBe(0); // no journal
        expect(getDeployment(h.db, D1)!.committedTransactionId).toBe(""); // no baseline commit
    });

    it("valid baseline + valid plan → committed (baseline validation does not break happy path)", () => {
        seedRealBaseline(h, D1, "old.md", "# base");
        writeFile(h.root, "old.md", "# base");
        // Plan no longer contains old.md → old.md becomes a removal candidate.
        // Both paths canonical → deploy proceeds; old.md becomes a current
        // removed baseline backed by an immutable residual authority.
        const r = executeDeployment(h.opts, textPlan("new.md", "# x"));
        expect(r.outcome).toBe("committed");
    });
});
