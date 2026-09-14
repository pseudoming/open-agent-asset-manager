import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import {
    recoverDeployment as recoverDeploymentProduction,
    recoverDeploymentWithLocksForTest,
} from "../../src/deployment/deployment-recovery";
import { deleteJournal, publishJournal, readJournal, type ActiveJournal } from "../../src/deployment/deployment-journal";
import { acquireAllLocks, computeDeploymentOperationKey, computePhysicalKeys } from "../../src/foundation/physical-path-locks";
import { getDeployment, getDeploymentFile, insertDeployment } from "../../src/persistence/state-db";
import {
    insertDeploymentRenderSnapshot,
    getDeploymentRenderSnapshot,
    upsertDeploymentFile,
} from "../../src/persistence/state-db";
import {
    D1,
    D2,
    TXN_YES,
    TXN_NO,
    sha,
    type Harness,
    recoverDeployment,
    harness,
    deployEntry,
    publish,
    writeFile,
} from "./fixtures/deployment-recovery-test-fixtures";

describe("recoverDeployment production authority boundary", () => {
    it.each([
        1, 2, 4,
    ] as const)("retains a legacy Windows-to-WSL schema %i journal before locks or target I/O", (schemaVersion) => {
        const h = harness("");
        try {
            const old = deployEntry("a.md", "old", "new");
            publish(h, TXN_NO, [old]);
            const original = readJournal(h.txnRoot, TXN_NO)!;
            deleteJournal(h.txnRoot, TXN_NO);
            const journal: ActiveJournal =
                schemaVersion === 1
                    ? original
                    : schemaVersion === 2
                      ? {
                            ...original,
                            schemaVersion: 2,
                            managedDirectoryBoundaries: [],
                            entries: original.entries.map((entry) => ({ ...entry, entryAuthority: "managed_baseline" as const })),
                            directoryEntries: [],
                        }
                      : {
                            ...original,
                            schemaVersion: 4,
                            managedDirectoryBoundaries: [],
                            entries: original.entries.map((entry) => ({ ...entry, entryAuthority: "managed_baseline" as const })),
                            directoryEntries: [],
                            targetExecution: { kind: "host" },
                            staging: { rootPath: "/tmp/oaam-deployment-" + TXN_NO, identity: null },
                            publicationPhase: "preparing",
                            publications: [{ relativePath: "a.md", kind: "file", completeReplacement: false, recovery: null }],
                        };
            publishJournal(h.txnRoot, journal);
            h.db
                .prepare(
                    "UPDATE deployments SET platform='wsl', platform_instance_id='Ubuntu', target_root_path=? WHERE deployment_id=?",
                )
                .run("\\\\wsl.localhost\\Ubuntu\\home\\oaam\\project", D1);
            const lock = vi.fn(acquireAllLocks),
                afterLock = vi.fn();
            expect(recoverDeploymentWithLocksForTest(h.db, h.txnRoot, TXN_NO, afterLock, lock)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_target_unavailable",
                journalResolved: false,
            });
            expect(lock).not.toHaveBeenCalled();
            expect(afterLock).not.toHaveBeenCalled();
            expect(readJournal(h.txnRoot, TXN_NO)).toEqual(journal);
        } finally {
            h.cleanup();
        }
    });

    it("fails closed before locking for a missing journal or missing/deleted Deployment", () => {
        const h = harness("");
        try {
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_NO, localTargetTransactions).reasonCode).toBe(
                "blocked_by_recovery_journal_corrupt",
            );
            publishJournal(h.txnRoot, {
                schemaVersion: 1,
                transactionId: TXN_NO,
                deploymentId: D2,
                createdAt: 1,
                compilationFingerprint: sha("missing owner"),
                reservedPhysicalKeys: [],
                entries: [],
            });
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_NO, localTargetTransactions).reasonCode).toBe(
                "blocked_by_recovery_state_unavailable",
            );
            deleteJournal(h.txnRoot, TXN_NO);
            h.db.prepare("UPDATE deployments SET deleted=1 WHERE deployment_id=?").run(D1);
            publishJournal(h.txnRoot, {
                schemaVersion: 1,
                transactionId: TXN_NO,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: sha("deleted owner"),
                reservedPhysicalKeys: [],
                entries: [],
            });
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_NO, localTargetTransactions).reasonCode).toBe(
                "blocked_by_recovery_state_unavailable",
            );
        } finally {
            h.cleanup();
        }
    });

    it("rejects a non-absolute DB target root before locks or runtime I/O", () => {
        const h = harness("");
        try {
            publishJournal(h.txnRoot, {
                schemaVersion: 1,
                transactionId: TXN_NO,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: sha("relative-root"),
                reservedPhysicalKeys: [],
                entries: [],
            });
            h.db.prepare("UPDATE deployments SET target_root_path='relative/root' WHERE deployment_id=?").run(D1);
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_NO, localTargetTransactions)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_state_unavailable",
                journalResolved: false,
            });
        } finally {
            h.cleanup();
        }
    });

    it("derives target context from DB, probes occupancy, and releases path locks", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("a.md", "old", "new");
            writeFile(h.root, "a.md", "old");
            publish(h, TXN_YES, [entry]);
            const result = recoverDeploymentProduction(h.db, h.txnRoot, TXN_YES, localTargetTransactions);
            expect(result.outcome).toBe("recovered_to_new");
            expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("new");
            const keys = computePhysicalKeys("linux", h.root, ["a.md"]);
            const reopened = acquireAllLocks(h.txnRoot, keys);
            expect(reopened).not.toBeNull();
            reopened?.release();
        } finally {
            h.cleanup();
        }
    });

    it("blocks before runtime when a path lock is held", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("a.md", "old", "new");
            writeFile(h.root, "a.md", "old");
            publish(h, TXN_YES, [entry]);
            const held = acquireAllLocks(h.txnRoot, computePhysicalKeys("linux", h.root, ["a.md"]));
            expect(held).not.toBeNull();
            try {
                expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_YES, localTargetTransactions)).toEqual({
                    outcome: "blocked",
                    reasonCode: "blocked_by_recovery_target_unavailable",
                    journalResolved: false,
                });
                expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
                expect(fs.existsSync(path.join(h.txnRoot, TXN_YES, "journal.json"))).toBe(true);
            } finally {
                held?.release();
            }
        } finally {
            h.cleanup();
        }
    });

    it("blocks before runtime when the Deployment operation lock is held", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("a.md", "old", "new");
            writeFile(h.root, "a.md", "old");
            publish(h, TXN_YES, [entry]);
            const held = acquireAllLocks(h.txnRoot, [computeDeploymentOperationKey(D1)]);
            if (held === null) throw new Error("fixture operation lock unavailable");
            try {
                expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_YES, localTargetTransactions)).toEqual({
                    outcome: "blocked",
                    reasonCode: "blocked_by_recovery_target_unavailable",
                    journalResolved: false,
                });
                expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
            } finally {
                held.release();
            }
        } finally {
            h.cleanup();
        }
    });

    it("rejects a journal reservation that omits the immediate parent key", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("nested/a.md", "old", "new");
            writeFile(h.root, "nested/a.md", "old");
            publish(h, TXN_YES, [entry]);
            const journalPath = path.join(h.txnRoot, TXN_YES, "journal.json");
            const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as ActiveJournal;
            journal.reservedPhysicalKeys = computePhysicalKeys("linux", h.root, ["nested/a.md"]);
            fs.writeFileSync(journalPath, JSON.stringify(journal));
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_YES, localTargetTransactions)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_journal_corrupt",
                journalResolved: false,
            });
            expect(fs.readFileSync(path.join(h.root, "nested/a.md"), "utf-8")).toBe("old");
        } finally {
            h.cleanup();
        }
    });

    it("maps an unexpected lock-directory failure to target unavailable", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("a.md", "old", "new");
            writeFile(h.root, "a.md", "old");
            publish(h, TXN_YES, [entry]);
            fs.writeFileSync(path.join(h.txnRoot, "locks"), "not a directory");
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_YES, localTargetTransactions)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_target_unavailable",
                journalResolved: false,
            });
            expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
        } finally {
            h.cleanup();
        }
    });

    it("maps an unexpected physical-lock acquisition failure and releases the operation lock", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("a.md", "old", "new");
            writeFile(h.root, "a.md", "old");
            publish(h, TXN_YES, [entry]);
            let calls = 0;
            let operationReleased = false;
            const result = recoverDeploymentWithLocksForTest(
                h.db,
                h.txnRoot,
                TXN_YES,
                () => undefined,
                () => {
                    calls += 1;
                    if (calls === 1) {
                        return {
                            release: () => {
                                operationReleased = true;
                            },
                        };
                    }
                    throw new Error("physical lock EIO");
                },
            );
            expect(result.reasonCode).toBe("blocked_by_recovery_target_unavailable");
            expect(operationReleased).toBe(true);
            expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
        } finally {
            h.cleanup();
        }
    });

    it("blocks when another active Deployment owns a journal target path", () => {
        const h = harness(TXN_YES);
        try {
            const entry = deployEntry("a.md", "old", "new");
            writeFile(h.root, "a.md", "old");
            publish(h, TXN_YES, [entry]);
            const d1 = getDeployment(h.db, D1)!;
            const ref = JSON.parse(d1.appliedRenderSnapshotRef) as {
                snapshotFingerprint: `sha256:${string}`;
            };
            const snapshot = getDeploymentRenderSnapshot(h.db, D1, ref.snapshotFingerprint)!;
            insertDeployment(h.db, {
                ...d1,
                deploymentId: D2,
                committedTransactionId: "",
                appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${D2}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
                createdAt: 6_000,
                updatedAt: 6_000,
            });
            insertDeploymentRenderSnapshot(h.db, {
                ...snapshot,
                deploymentId: D2,
                createdAt: 6_000,
                updatedAt: 6_000,
            });
            const file = getDeploymentFile(h.db, D1, "a.md")!;
            upsertDeploymentFile(
                h.db,
                D2,
                "a.md",
                file.baselineState,
                file.observedState,
                file.observedContentHash,
                file.observedExecutable,
                6_000,
                6_000,
            );
            expect(recoverDeploymentProduction(h.db, h.txnRoot, TXN_YES, localTargetTransactions)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_evidence_conflict",
                journalResolved: false,
            });
            expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
        } finally {
            h.cleanup();
        }
    });

    it("rechecks marker bytes and DB target authority after acquiring locks", () => {
        const mutations: Array<{
            mutate: (h: Harness) => void;
            reasonCode: string;
        }> = [
            {
                mutate: (h) => fs.unlinkSync(path.join(h.txnRoot, TXN_YES, "journal.json")),
                reasonCode: "blocked_by_recovery_journal_corrupt",
            },
            {
                mutate: (h) => {
                    const journalPath = path.join(h.txnRoot, TXN_YES, "journal.json");
                    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
                    journal.createdAt += 1;
                    fs.writeFileSync(journalPath, JSON.stringify(journal));
                },
                reasonCode: "blocked_by_recovery_evidence_conflict",
            },
            {
                mutate: (h) =>
                    h.db
                        .prepare("UPDATE deployments SET target_root_path=? WHERE deployment_id=?")
                        .run(path.join(h.root, "moved"), D1),
                reasonCode: "blocked_by_recovery_state_unavailable",
            },
        ];
        for (const testCase of mutations) {
            const h = harness(TXN_YES);
            try {
                const entry = deployEntry("a.md", "old", "new");
                writeFile(h.root, "a.md", "old");
                publish(h, TXN_YES, [entry]);
                const result = recoverDeploymentWithLocksForTest(h.db, h.txnRoot, TXN_YES, () => testCase.mutate(h));
                expect(result.reasonCode).toBe(testCase.reasonCode);
                expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
            } finally {
                h.cleanup();
            }
        }
    });

    it("fails closed when occupancy BEGIN, query, or rollback fails", () => {
        for (const failure of ["begin", "query", "query_and_rollback"] as const) {
            const h = harness(TXN_YES);
            try {
                const entry = deployEntry("a.md", "old", "new");
                writeFile(h.root, "a.md", "old");
                publish(h, TXN_YES, [entry]);
                const faultingDb = {
                    exec: (sql: string) => {
                        if (failure === "begin" && sql === "BEGIN IMMEDIATE") throw new Error("BEGIN EIO");
                        if (failure === "query_and_rollback" && sql === "ROLLBACK") {
                            throw new Error("ROLLBACK EIO");
                        }
                        return h.db.exec(sql);
                    },
                    prepare: (sql: string) => {
                        if (failure !== "begin" && sql.includes("FROM deployment_files df")) {
                            throw new Error("occupancy query EIO");
                        }
                        return h.db.prepare(sql);
                    },
                    transaction: h.db.transaction.bind(h.db),
                    pragma: h.db.pragma.bind(h.db),
                } as unknown as Database.Database;
                expect(recoverDeploymentProduction(faultingDb, h.txnRoot, TXN_YES, localTargetTransactions).reasonCode).toBe(
                    "blocked_by_recovery_state_unavailable",
                );
                expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("old");
            } finally {
                h.cleanup();
            }
        }
    });
});
