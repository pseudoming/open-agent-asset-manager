import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
/** Canonical SQLite deployment authority decides the direction of a persisted local V4 journal. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executePublications } from "../../src/deployment/deployment-publication";
import { drivePublicationJournal, recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import { readJournal, isValidJournal, type ActiveJournalV4 } from "../../src/deployment/deployment-journal";
import { recoverDeployment } from "../../src/deployment/deployment-recovery";
import { deployEntry, harness, publish, TXN_NO, TXN_YES, type Harness } from "./fixtures/deployment-recovery-test-fixtures";

const roots: Harness[] = [];
afterEach(() => {
    for (const h of roots.splice(0)) h.cleanup();
});
function fixture(committed: boolean) {
    const h = harness(TXN_YES);
    roots.push(h);
    const transactionId = committed ? TXN_YES : TXN_NO;
    publish(h, transactionId, [deployEntry("guide.md", "original", "desired")]);
    const prior = readJournal(h.txnRoot, transactionId);
    if (prior === null) throw new Error("fixture journal missing");
    const journal: ActiveJournalV4 = {
        ...prior,
        schemaVersion: 4,
        targetExecution: { kind: "host" },
        publicationPhase: "preparing",
        staging: { rootPath: path.join(h.txnRoot, `oaam-deployment-${transactionId}`), identity: null },
        managedDirectoryBoundaries: [],
        directoryEntries: [],
        entries: prior.entries.map((entry) => ({
            ...entry,
            entryAuthority: "managed_baseline",
            runtimeRollbackOverride: {
                state: "present",
                contentHash: entry.oldHash,
                bytesBase64: entry.oldBytesBase64,
                executable: entry.oldExecutable,
            },
        })),
        publications: [{ kind: "file", relativePath: "guide.md", completeReplacement: true, recovery: null }],
    };
    expect(isValidJournal(journal)).toBe(true);
    fs.writeFileSync(path.join(h.txnRoot, transactionId, "journal.json"), JSON.stringify(journal));
    const target = path.join(h.root, "guide.md");
    fs.writeFileSync(target, "original");
    const executed = drivePublicationJournal(executePublications(h.ctx, journal), journal, (before, next) =>
        recordPublicationJournal(h.txnRoot, before, next, "execute"),
    );
    expect(executed.outcome).toBe("done");
    return { ...h, transactionId, journal: executed.journal, target };
}

describe("ordinary local V4 database recovery", () => {
    it.each([false, true])("recovers the exact database-selected side, committed=%s", (committed) => {
        const h = fixture(committed);
        if (committed) fs.writeFileSync(h.target, "original");
        const result = recoverDeployment(h.db, h.txnRoot, h.transactionId, localTargetTransactions);
        expect(result).toMatchObject({ outcome: committed ? "recovered_to_new" : "recovered_to_old" });
        expect(fs.readFileSync(h.target, "utf8")).toBe(committed ? "desired" : "original");
        expect(readJournal(h.txnRoot, h.transactionId)).toBeNull();
        expect(fs.existsSync(h.journal.staging.rootPath)).toBe(false);
    });
    it("preserves a wrong-kind target and all recovery authority when physical access cannot continue", () => {
        const h = fixture(false);
        const retained = path.join(h.root, "retained-target");
        fs.renameSync(h.target, retained);
        fs.mkdirSync(h.target);
        const result = recoverDeployment(h.db, h.txnRoot, h.transactionId, localTargetTransactions);
        expect(result).toMatchObject({ outcome: "blocked", reasonCode: "blocked_by_recovery_target_unavailable" });
        expect(fs.statSync(h.target).isDirectory()).toBe(true);
        expect(fs.readFileSync(retained, "utf8")).toBe("desired");
        expect(readJournal(h.txnRoot, h.transactionId)).toEqual(h.journal);
    });
});
