/** Authority-focused split from the original oversized Deployment test suite. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { recoverDeploymentForTest } from "../../src/deployment/deployment-recovery";
import { deleteJournal, publishJournal, type ActiveJournal, type JournalEntry } from "../../src/deployment/deployment-journal";
import { getDeployment, getDeploymentFile, insertDeployment } from "../../src/persistence/state-db";
import {
    insertDeploymentRenderSnapshot,
    insertDeploymentResidualAuthority,
    getDeploymentRenderSnapshot,
    updateDeployment,
    upsertDeploymentFile,
} from "../../src/persistence/state-db";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";
import {
    finalizeDeploymentResidualAuthority,
    makeRemovalIntentFingerprint,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
    serializeDeploymentResidualAuthorityBody,
} from "../../src/render/deployment-render-authority";
import { computeAppliedRenderSnapshotFingerprint } from "../../src/foundation/fingerprint";
import {
    D1,
    TXN_YES,
    TXN_NO,
    sha,
    type Harness,
    recoverDeployment,
    harness,
    deployEntry,
    removalEntry,
    publish,
    planForJournalSide,
    writeFile,
} from "./fixtures/deployment-recovery-test-fixtures";

describe("recoverDeployment — commit=unknown / journal corrupt", () => {
    let h: Harness;
    beforeEach(() => {
        h = harness(TXN_YES);
    });
    afterEach(() => h.cleanup());

    it("journal missing/corrupt → blocked_by_recovery_journal_corrupt", () => {
        // No journal published for this txnId.
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_journal_corrupt");
        expect(r.journalResolved).toBe(false);
    });

    it("journal with invalid JSON → blocked_by_recovery_journal_corrupt", () => {
        const txnId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        fs.mkdirSync(path.join(h.txnRoot, txnId), { recursive: true });
        fs.writeFileSync(path.join(h.txnRoot, txnId, "journal.json"), "{bad json");
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, txnId);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_journal_corrupt");
    });

    it("deployment row missing → blocked_by_recovery_state_unavailable", () => {
        // Publish a journal for a deployment that has no row.
        const missingDep = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const txnId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        fs.mkdirSync(path.join(h.txnRoot, txnId), { recursive: true });
        fs.writeFileSync(
            path.join(h.txnRoot, txnId, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txnId,
                deploymentId: missingDep,
                createdAt: 1,
                compilationFingerprint: sha("missing-deployment-fixture"),
                reservedPhysicalKeys: [],
                entries: [],
            }),
        );
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, txnId);
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");

        const deletedTxn = "abababab-abab-4bab-8bab-abababababab";
        h.db.prepare("UPDATE deployments SET deleted=1 WHERE deployment_id=?").run(D1);
        publishJournal(h.txnRoot, {
            schemaVersion: 1,
            transactionId: deletedTxn,
            deploymentId: D1,
            createdAt: 1,
            compilationFingerprint: sha("deleted-deployment-fixture"),
            reservedPhysicalKeys: [],
            entries: [],
        });
        expect(recoverDeployment(h.db, h.ctx, h.txnRoot, deletedTxn).reasonCode).toBe("blocked_by_recovery_state_unavailable");
    });
});

describe("recoverDeployment — journal resolution", () => {
    let h: Harness;
    beforeEach(() => {
        h = harness(TXN_YES);
    });
    afterEach(() => h.cleanup());

    it("success → journal deleted (resolved)", () => {
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# new"); // already converged
        const r = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
        expect(r.outcome).toBe("recovered_to_new");
        expect(r.journalResolved).toBe(true);
        // journal.json gone
        expect(fs.existsSync(path.join(h.txnRoot, TXN_YES, "journal.json"))).toBe(false);
    });

    it("deleteJournal failure (marker stuck) → blocked, journal unresolved (deterministic seam)", () => {
        // Use recoverDeploymentForTest to inject a throwing deleteJournal,
        // deterministically driving the "marker stuck → blocked" path without
        // relying on chmod-based FS injection (which may be silently unavailable).
        const e = deployEntry("a.md", "# old", "# new");
        publish(h, TXN_YES, [e]);
        writeFile(h.root, "a.md", "# new"); // already converged

        const r = recoverDeploymentForTest(h.db, h.ctx, h.txnRoot, TXN_YES, () => {
            throw new Error("marker stuck (injected)");
        });
        expect(r.outcome).toBe("blocked");
        expect(r.reasonCode).toBe("blocked_by_recovery_state_unavailable");
        expect(r.journalResolved).toBe(false);
        // journal marker still present (reservation persists)
        expect(fs.existsSync(path.join(h.txnRoot, TXN_YES, "journal.json"))).toBe(true);
    });
});

describe("recoverDeployment — journal/DB authority binding", () => {
    function mutateJournal(h: Harness, txnId: string, mutate: (journal: ActiveJournal) => void): void {
        const journalPath = path.join(h.txnRoot, txnId, "journal.json");
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as ActiveJournal;
        mutate(journal);
        fs.writeFileSync(journalPath, JSON.stringify(journal));
    }

    it("blocks commit=yes when current snapshot/file authority is missing, foreign, stale or corrupt", () => {
        const cases: Array<(h: Harness) => void> = [
            (h) => updateDeployment(h.db, D1, { appliedRenderSnapshotRef: '{"snapshotState":"never"}' }, 6_000),
            (h) =>
                updateDeployment(
                    h.db,
                    D1,
                    {
                        appliedRenderSnapshotRef: `{"snapshotState":"applied","snapshotFingerprint":"sha256:${"f".repeat(64)}"}`,
                    },
                    6_000,
                ),
            (h) => {
                const ref = JSON.parse(getDeployment(h.db, D1)!.appliedRenderSnapshotRef);
                h.db
                    .prepare("UPDATE deployment_render_snapshots SET deleted=1 WHERE snapshot_fingerprint=?")
                    .run(ref.snapshotFingerprint);
            },
            (h) => {
                const ref = JSON.parse(getDeployment(h.db, D1)!.appliedRenderSnapshotRef);
                insertDeployment(h.db, {
                    ...getDeployment(h.db, D1)!,
                    deploymentId: "99999999-9999-4999-8999-999999999999",
                    committedTransactionId: "",
                    appliedRenderSnapshotRef: '{"snapshotState":"never"}',
                });
                h.db
                    .prepare("UPDATE deployment_render_snapshots SET deployment_id=? WHERE snapshot_fingerprint=?")
                    .run("99999999-9999-4999-8999-999999999999", ref.snapshotFingerprint);
            },
            (h) => {
                const never = { schemaVersion: 1 as const, snapshotState: "never" as const };
                const fingerprint = computeAppliedRenderSnapshotFingerprint(never);
                insertDeploymentRenderSnapshot(h.db, {
                    snapshotFingerprint: fingerprint,
                    deploymentId: D1,
                    snapshotJson: serializeAppliedRenderSnapshot(never),
                    deleted: 0,
                    createdAt: 6_000,
                    updatedAt: 6_000,
                });
                updateDeployment(
                    h.db,
                    D1,
                    {
                        appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                            snapshotState: "applied",
                            snapshotFingerprint: fingerprint,
                        }),
                    },
                    6_000,
                );
            },
            (h) =>
                mutateJournal(h, TXN_YES, (journal) => {
                    journal.compilationFingerprint = `sha256:${"e".repeat(64)}`;
                }),
            (h) => h.db.prepare("DELETE FROM deployment_files WHERE deployment_id=?").run(D1),
            (h) => h.db.prepare("UPDATE deployment_files SET deleted=1 WHERE deployment_id=?").run(D1),
            (h) => h.db.prepare("UPDATE deployment_files SET baseline_state='{}' WHERE deployment_id=?").run(D1),
        ];
        for (const mutate of cases) {
            const h = harness(TXN_YES);
            try {
                const entry = deployEntry("a.md", "old", "new");
                writeFile(h.root, "a.md", "new");
                publish(h, TXN_YES, [entry]);
                mutate(h);
                const result = recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES);
                expect(result).toEqual({
                    outcome: "blocked",
                    reasonCode: "blocked_by_recovery_state_unavailable",
                    journalResolved: false,
                });
                expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("new");
            } finally {
                h.cleanup();
            }
        }
    });

    it("blocks commit=no when the old DB baseline is absent, removed, or disagrees with the journal", () => {
        const cases: Array<(h: Harness) => void> = [
            (h) => h.db.prepare("DELETE FROM deployment_files WHERE deployment_id=?").run(D1),
            (h) => h.db.prepare("UPDATE deployment_files SET deleted=1 WHERE deployment_id=?").run(D1),
            (h) =>
                h.db
                    .prepare(
                        `UPDATE deployment_files
                 SET baseline_state='{"rowState":"removed","latestResidualAuthorityId":"sha256:${"a".repeat(64)}"}',
                     observed_state='missing', observed_content_hash='', observed_executable=0
                 WHERE deployment_id=?`,
                    )
                    .run(D1),
            (h) => {
                const row = h.db.prepare("SELECT baseline_state FROM deployment_files WHERE deployment_id=?").get(D1) as {
                    baseline_state: string;
                };
                const baseline = JSON.parse(row.baseline_state);
                baseline.appliedPayload.contentHash = `sha256:${"f".repeat(64)}`;
                h.db
                    .prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?")
                    .run(JSON.stringify(baseline), D1);
            },
        ];
        for (const mutate of cases) {
            const h = harness("");
            try {
                const entry = deployEntry("a.md", "old", "new");
                writeFile(h.root, "a.md", "new");
                publish(h, TXN_NO, [entry]);
                mutate(h);
                expect(recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO).reasonCode).toBe(
                    "blocked_by_recovery_state_unavailable",
                );
                expect(fs.readFileSync(path.join(h.root, "a.md"), "utf-8")).toBe("new");
            } finally {
                h.cleanup();
            }
        }
    });

    it("blocks a first-deploy commit=no journal when DB unexpectedly has an active old authority", () => {
        const h = harness("");
        try {
            const entry = deployEntry("a.md", "", "new");
            writeFile(h.root, "a.md", "new");
            publish(h, TXN_NO, [entry]);
            const unexpected = makeExecutionAuthority(planForJournalSide([deployEntry("a.md", "unexpected", "new")], "old"));
            const provenance = unexpected.targetFileProvenance[0]!.provenance;
            upsertDeploymentFile(
                h.db,
                D1,
                "a.md",
                serializeDeploymentFileBaselineState({
                    rowState: "active",
                    appliedPayload: {
                        contentKind: "binary",
                        contentHash: sha("unexpected") as `sha256:${string}`,
                        byteSize: Buffer.byteLength("unexpected"),
                    },
                    appliedExecutable: false,
                    provenance,
                }),
                "present",
                sha("unexpected"),
                0,
                6_000,
                6_000,
            );
            expect(recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO).reasonCode).toBe("blocked_by_recovery_state_unavailable");
        } finally {
            h.cleanup();
        }
    });

    it("allows commit=no reactivation when the pre-deploy current row was already removed", () => {
        const h = harness("");
        try {
            const entry = deployEntry("a.md", "", "new");
            writeFile(h.root, "a.md", "new");
            publish(h, TXN_NO, [entry]);
            upsertDeploymentFile(
                h.db,
                D1,
                "a.md",
                serializeDeploymentFileBaselineState({
                    rowState: "removed",
                    latestResidualAuthorityId: `sha256:${"a".repeat(64)}`,
                }),
                "missing",
                "",
                0,
                6_000,
                6_000,
            );
            expect(recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_NO).outcome).toBe("recovered_to_old");
            expect(fs.existsSync(path.join(h.root, "a.md"))).toBe(false);
        } finally {
            h.cleanup();
        }
    });

    it("blocks a committed removal whose residual binding no longer matches", () => {
        const mutations: Array<(h: Harness) => void> = [
            (h) => h.db.prepare("DELETE FROM deployment_residual_authorities WHERE deployment_id=?").run(D1),
            (h) => h.db.prepare("UPDATE deployment_residual_authorities SET deleted=1 WHERE deployment_id=?").run(D1),
            (h) =>
                mutateJournal(h, TXN_YES, (journal) => {
                    journal.entries[0]!.oldExecutable = !journal.entries[0]!.oldExecutable;
                }),
            (h) =>
                mutateJournal(h, TXN_YES, (journal) => {
                    journal.entries[0]!.oldProvenanceFingerprint = `sha256:${"e".repeat(64)}`;
                }),
            (h) =>
                mutateJournal(h, TXN_YES, (journal) => {
                    journal.entries[0]!.oldMaterializationFingerprint = `sha256:${"e".repeat(64)}`;
                }),
            (h) => {
                const current = getDeploymentFile(h.db, D1, "a.md")!;
                const baseline = JSON.parse(current.baselineState) as {
                    latestResidualAuthorityId: string;
                };
                const row = h.db
                    .prepare("SELECT * FROM deployment_residual_authorities WHERE residual_authority_id=?")
                    .get(baseline.latestResidualAuthorityId) as {
                    residual_authority_id: string;
                    residual_authority_fingerprint: string;
                    deployment_id: string;
                    relative_path: string;
                    authority_body: string;
                };
                const body = JSON.parse(row.authority_body) as {
                    schemaVersion: 1;
                    appliedPayload: {
                        contentKind: "binary";
                        contentHash: `sha256:${string}`;
                        byteSize: number;
                    };
                    appliedExecutable: boolean;
                    previousProvenance: Parameters<typeof finalizeDeploymentResidualAuthority>[0]["previousProvenance"];
                };
                const alternate = finalizeDeploymentResidualAuthority({
                    ...body,
                    deploymentId: D1,
                    relativePath: "a.md",
                    // The alternate residual is internally valid and matches
                    // the old payload/provenance, but proves removal under a
                    // different compilation. Recovery must still reject it.
                    removalIntentFingerprint: makeRemovalIntentFingerprint({
                        deploymentId: D1,
                        relativePath: "a.md",
                        previousProvenanceFingerprint: body.previousProvenance.provenanceFingerprint,
                        nextCompilationFingerprint: sha("another compilation") as `sha256:${string}`,
                        reason: "absent_from_new_desired_set",
                    }),
                });
                insertDeploymentResidualAuthority(h.db, {
                    residualAuthorityId: alternate.residualAuthorityId,
                    deploymentId: D1,
                    relativePath: "a.md",
                    authorityBody: serializeDeploymentResidualAuthorityBody(alternate),
                    residualAuthorityFingerprint: alternate.residualAuthorityFingerprint,
                    deleted: 0,
                    createdAt: 6_000,
                    updatedAt: 6_000,
                });
                h.db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?").run(
                    serializeDeploymentFileBaselineState({
                        rowState: "removed",
                        latestResidualAuthorityId: alternate.residualAuthorityId,
                    }),
                    D1,
                );
            },
        ];
        for (const mutate of mutations) {
            const h = harness(TXN_YES);
            try {
                const entry = removalEntry("a.md", "old");
                publish(h, TXN_YES, [entry]);
                mutate(h);
                expect(recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES).reasonCode).toBe(
                    "blocked_by_recovery_state_unavailable",
                );
            } finally {
                h.cleanup();
            }
        }
    });

    it("blocks committed rows whose active/removed branch or current snapshot link disagrees", () => {
        const cases: Array<(h: Harness, entry: JournalEntry) => void> = [
            (h) =>
                h.db
                    .prepare(
                        `UPDATE deployment_files
                 SET baseline_state='{"rowState":"removed","latestResidualAuthorityId":"sha256:${"a".repeat(64)}"}',
                     observed_state='missing', observed_content_hash='', observed_executable=0
                 WHERE deployment_id=?`,
                    )
                    .run(D1),
            (h) =>
                h.db
                    .prepare(
                        "UPDATE deployment_files SET observed_state='missing', observed_content_hash='', observed_executable=0 WHERE deployment_id=?",
                    )
                    .run(D1),
            (h) =>
                h.db
                    .prepare("UPDATE deployment_files SET observed_content_hash=? WHERE deployment_id=?")
                    .run(sha("different observed content"), D1),
            (h) => h.db.prepare("UPDATE deployment_files SET observed_executable=1 WHERE deployment_id=?").run(D1),
            (h) => {
                const raw = h.db.prepare("SELECT baseline_state FROM deployment_files WHERE deployment_id=?").get(D1) as {
                    baseline_state: string;
                };
                const baseline = JSON.parse(raw.baseline_state);
                baseline.appliedPayload.contentHash = `sha256:${"f".repeat(64)}`;
                h.db
                    .prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?")
                    .run(JSON.stringify(baseline), D1);
            },
            (h) => {
                const ref = JSON.parse(getDeployment(h.db, D1)!.appliedRenderSnapshotRef);
                const current = getDeploymentRenderSnapshot(h.db, D1, ref.snapshotFingerprint)!;
                const alternate = JSON.parse(current.snapshotJson);
                alternate.selectionFingerprint = `sha256:${"f".repeat(64)}`;
                const fingerprint = computeAppliedRenderSnapshotFingerprint(alternate);
                insertDeploymentRenderSnapshot(h.db, {
                    snapshotFingerprint: fingerprint,
                    deploymentId: D1,
                    snapshotJson: serializeAppliedRenderSnapshot(alternate),
                    deleted: 0,
                    createdAt: 6_000,
                    updatedAt: 6_000,
                });
                updateDeployment(
                    h.db,
                    D1,
                    {
                        appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                            snapshotState: "applied",
                            snapshotFingerprint: fingerprint,
                        }),
                    },
                    6_000,
                );
            },
        ];
        for (const mutate of cases) {
            const h = harness(TXN_YES);
            try {
                const entry = deployEntry("a.md", "old", "new");
                writeFile(h.root, "a.md", "new");
                publish(h, TXN_YES, [entry]);
                mutate(h, entry);
                expect(recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES).reasonCode).toBe(
                    "blocked_by_recovery_state_unavailable",
                );
            } finally {
                h.cleanup();
            }
        }

        for (const observedPresent of [false, true]) {
            const h = harness(TXN_YES);
            try {
                const entry = removalEntry("a.md", "old");
                publish(h, TXN_YES, [entry]);
                if (observedPresent) {
                    h.db
                        .prepare(
                            "UPDATE deployment_files SET observed_state='present', observed_content_hash=?, observed_executable=0 WHERE deployment_id=?",
                        )
                        .run(entry.oldHash, D1);
                } else {
                    const oldAuthority = makeExecutionAuthority(planForJournalSide([entry], "old"));
                    const provenance = oldAuthority.targetFileProvenance[0]!.provenance;
                    h.db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?").run(
                        serializeDeploymentFileBaselineState({
                            rowState: "active",
                            appliedPayload: {
                                contentKind: "binary",
                                contentHash: entry.oldHash as `sha256:${string}`,
                                byteSize: Buffer.from(entry.oldBytesBase64, "base64").length,
                            },
                            appliedExecutable: entry.oldExecutable,
                            provenance,
                        }),
                        D1,
                    );
                }
                expect(recoverDeployment(h.db, h.ctx, h.txnRoot, TXN_YES).reasonCode).toBe(
                    "blocked_by_recovery_state_unavailable",
                );
            } finally {
                h.cleanup();
            }
        }
    });
});
