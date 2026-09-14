/** Authority-focused split from the original oversized Deployment test suite. */

import * as path from "node:path";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
    finalizeTargetFileRenderProvenance,
    parseDeploymentFileBaselineState,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
} from "../../src/render/deployment-render-authority";
import {
    beginDeploymentProbeTx,
    findActivePathOccupiers,
    loadDeploymentBaseline,
} from "../../src/deployment/deployment-state-ops";
import { computeAppliedRenderSnapshotFingerprint } from "../../src/foundation/fingerprint";
import {
    getDeployment,
    getDeploymentFile,
    insertDeployment,
    insertDeploymentRenderSnapshot,
    insertDeploymentResidualAuthority,
    softDeleteDeploymentFile,
    updateDeployment,
    upsertDeploymentFile,
} from "../../src/persistence/state-db";
import {
    D1,
    D2,
    freshDb,
    makeDeploymentRow,
    seedActiveFile,
    successInput,
    residualFromCurrent,
} from "./fixtures/deployment-state-ops-test-fixtures";

describe("loadDeploymentBaseline", () => {
    let db: Database.Database;
    beforeEach(() => {
        db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
    });

    it("returns only strict active authorities", () => {
        seedActiveFile(db, D1, "a.md");
        seedActiveFile(db, D1, "b.md", "# b");
        expect(
            loadDeploymentBaseline(db, D1)
                .map((row) => row.relativePath)
                .sort(),
        ).toEqual(["a.md", "b.md"]);
    });

    it("excludes a soft-deleted row and accepts an empty baseline", () => {
        expect(loadDeploymentBaseline(db, D1)).toEqual([]);
        seedActiveFile(db, D1, "gone.md");
        softDeleteDeploymentFile(db, D1, "gone.md", 5_000);
        expect(loadDeploymentBaseline(db, D1)).toEqual([]);
    });

    it("fails closed on unresolved snapshot or corrupt physical observation", () => {
        updateDeployment(
            db,
            D1,
            {
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint: `sha256:${"f".repeat(64)}`,
                }),
            },
            2_000,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/unresolved/);

        const neverSnapshot = { schemaVersion: 1 as const, snapshotState: "never" as const };
        const neverFingerprint = computeAppliedRenderSnapshotFingerprint(neverSnapshot);
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: neverFingerprint,
            deploymentId: D1,
            snapshotJson: serializeAppliedRenderSnapshot(neverSnapshot),
            deleted: 0,
            createdAt: 2_500,
            updatedAt: 2_500,
        });
        updateDeployment(
            db,
            D1,
            {
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint: neverFingerprint,
                }),
            },
            2_500,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/does not resolve to an applied/);

        updateDeployment(db, D1, { appliedRenderSnapshotRef: '{"snapshotState":"never"}' }, 3_000);
        seedActiveFile(db, D1, "a.md");
        updateDeployment(db, D1, { appliedRenderSnapshotRef: '{"snapshotState":"never"}' }, 3_500);
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/never-deployed/);
        seedActiveFile(db, D1, "a.md");
        db.prepare("UPDATE deployment_files SET observed_content_hash = '' WHERE deployment_id = ?").run(D1);
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/no content hash/);
        db.prepare(
            "UPDATE deployment_files SET observed_state='missing', observed_content_hash=?, observed_executable=1 WHERE deployment_id=?",
        ).run(`sha256:${"a".repeat(64)}`, D1);
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/hidden physical values/);
    });

    it("fails closed for missing/deleted owners, unresolved provenance and invalid observations", () => {
        expect(() => loadDeploymentBaseline(db, D2)).toThrow(/active Deployment/);
        db.prepare("UPDATE deployments SET deleted=1 WHERE deployment_id=?").run(D1);
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/active Deployment/);
        db.prepare("UPDATE deployments SET deleted=0 WHERE deployment_id=?").run(D1);

        seedActiveFile(db, D1, "a.md");
        const row = getDeploymentFile(db, D1, "a.md")!;
        const baseline = parseDeploymentFileBaselineState(row.baselineState);
        if (baseline.rowState !== "active") throw new Error("bad fixture");
        const { provenanceFingerprint: _stored, ...preimage } = baseline.provenance;
        const unresolved = finalizeTargetFileRenderProvenance({
            ...preimage,
            appliedRenderSnapshotFingerprint: `sha256:${"e".repeat(64)}`,
        });
        db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?").run(
            serializeDeploymentFileBaselineState({ ...baseline, provenance: unresolved }),
            D1,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/unresolved snapshot/);

        db.pragma("ignore_check_constraints = ON");
        db.prepare("UPDATE deployment_files SET observed_state='bogus' WHERE deployment_id=?").run(D1);
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/observed_state is invalid/);
        db.pragma("ignore_check_constraints = OFF");
    });

    it("validates removed-row residual resolution and permits active/missing observation", () => {
        seedActiveFile(db, D1, "a.md");
        db.prepare(
            "UPDATE deployment_files SET observed_state='missing', observed_content_hash='', observed_executable=0 WHERE deployment_id=?",
        ).run(D1);
        expect(loadDeploymentBaseline(db, D1)[0]?.relativePath).toBe("a.md");

        upsertDeploymentFile(
            db,
            D1,
            "gone.md",
            serializeDeploymentFileBaselineState({
                rowState: "removed",
                latestResidualAuthorityId: `sha256:${"f".repeat(64)}`,
            }),
            "missing",
            "",
            0,
            5_000,
            5_000,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/missing residual/);

        softDeleteDeploymentFile(db, D1, "gone.md", 5_100);
        insertDeployment(db, makeDeploymentRow(D2));
        seedActiveFile(db, D2, "other.md");
        const otherInput = successInput(D2, { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] });
        const foreign = residualFromCurrent(db, D2, "other.md", otherInput.appliedRenderSnapshot.compilationFingerprint);
        insertDeploymentResidualAuthority(db, {
            residualAuthorityId: foreign.residualAuthorityId,
            deploymentId: D2,
            relativePath: "other.md",
            authorityBody: JSON.stringify({
                schemaVersion: foreign.schemaVersion,
                appliedPayload: foreign.appliedPayload,
                appliedExecutable: foreign.appliedExecutable,
                previousProvenance: foreign.previousProvenance,
                removalIntentFingerprint: foreign.removalIntentFingerprint,
            }),
            residualAuthorityFingerprint: foreign.residualAuthorityFingerprint,
            deleted: 0,
            createdAt: 5_200,
            updatedAt: 5_200,
        });
        upsertDeploymentFile(
            db,
            D1,
            "wrong-owner.md",
            serializeDeploymentFileBaselineState({
                rowState: "removed",
                latestResidualAuthorityId: foreign.residualAuthorityId,
            }),
            "missing",
            "",
            0,
            5_300,
            5_300,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/another owner\/path/);
    });
});

describe("beginDeploymentProbeTx", () => {
    let db: Database.Database;
    beforeEach(() => {
        db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
    });

    it("commit and rollback terminate idempotently", () => {
        const committed = beginDeploymentProbeTx(db);
        committed.commit();
        expect(() => committed.commit()).not.toThrow();
        expect(() => committed.rollback()).not.toThrow();
        const rolledBack = beginDeploymentProbeTx(db);
        rolledBack.rollback();
        expect(() => rolledBack.commit()).not.toThrow();
    });

    it("runs statements inside the real IMMEDIATE transaction", () => {
        const handle = beginDeploymentProbeTx(db);
        db.prepare("UPDATE deployments SET updated_at = ? WHERE deployment_id = ?").run(7_777, D1);
        handle.commit();
        expect(getDeployment(db, D1)?.updatedAt).toBe(7_777);
    });

    it("propagates COMMIT and ROLLBACK failures and permits rollback after failed commit", () => {
        const realExec = db.exec.bind(db);
        let failCommit = true;
        const faultingDb = {
            exec: (sql: string) => {
                if (sql === "COMMIT" && failCommit) {
                    failCommit = false;
                    throw new Error("simulated COMMIT failure");
                }
                return realExec(sql);
            },
            prepare: db.prepare.bind(db),
            transaction: db.transaction.bind(db),
            pragma: db.pragma.bind(db),
        } as unknown as Database.Database;
        const handle = beginDeploymentProbeTx(faultingDb);
        expect(() => handle.commit()).toThrow(/COMMIT failure/);
        expect(() => handle.rollback()).not.toThrow();

        const rollbackDb = {
            ...faultingDb,
            exec: (sql: string) => {
                if (sql === "ROLLBACK") throw new Error("simulated ROLLBACK failure");
                return realExec(sql);
            },
        } as unknown as Database.Database;
        const second = beginDeploymentProbeTx(rollbackDb);
        expect(() => second.rollback()).toThrow(/ROLLBACK failure/);
        realExec("ROLLBACK");
    });
});

describe("findActivePathOccupiers", () => {
    let db: Database.Database;
    beforeEach(() => {
        db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
    });

    function probe(paths: string[]): ReturnType<typeof findActivePathOccupiers> {
        const handle = beginDeploymentProbeTx(db);
        const result = findActivePathOccupiers(db, "linux", "/root", paths, D1);
        result === null ? handle.commit() : handle.rollback();
        return result;
    }

    it("returns null for free, empty, and self-owned paths", () => {
        expect(probe([])).toBeNull();
        expect(probe(["free.md"])).toBeNull();
        seedActiveFile(db, D1, "mine.md");
        expect(probe(["mine.md"])).toBeNull();
    });

    it("returns another active deployment owning the same physical key", () => {
        insertDeployment(db, makeDeploymentRow(D2));
        seedActiveFile(db, D2, "shared.md");
        expect(probe(["a.md", "shared.md"])).toEqual({
            deploymentId: D2,
            relativePath: "shared.md",
        });
    });

    it("detects the same canonical absolute path through overlapping roots", () => {
        insertDeployment(db, makeDeploymentRow(D2, { targetRootPath: "/root/nested" }));
        seedActiveFile(db, D2, "shared.md");
        expect(probe(["nested/shared.md"])).toEqual({
            deploymentId: D2,
            relativePath: "nested/shared.md",
        });
    });

    it("fails closed on non-canonical foreign occupancy authority", () => {
        insertDeployment(db, makeDeploymentRow(D2));
        seedActiveFile(db, D2, "shared.md");
        const expectProbeFailure = () => {
            const handle = beginDeploymentProbeTx(db);
            try {
                expect(() => findActivePathOccupiers(db, "linux", "/root", ["shared.md"], D1)).toThrow(/not canonical/);
            } finally {
                handle.rollback();
            }
        };
        db.prepare("UPDATE deployments SET target_root_path='relative' WHERE deployment_id=?").run(D2);
        expectProbeFailure();
        db.prepare("UPDATE deployments SET target_root_path='/root' WHERE deployment_id=?").run(D2);
        db.prepare("UPDATE deployment_files SET relative_path='../escape' WHERE deployment_id=?").run(D2);
        expectProbeFailure();
    });

    it("ignores a different platform/root and soft-deleted file/deployment", () => {
        insertDeployment(db, makeDeploymentRow(D2, { platform: "win32" }));
        seedActiveFile(db, D2, "shared.md");
        expect(probe(["shared.md"])).toBeNull();
        db.prepare("UPDATE deployments SET platform='linux', target_root_path='/other' WHERE deployment_id=?").run(D2);
        expect(probe(["shared.md"])).toBeNull();
        db.prepare("UPDATE deployments SET target_root_path='/root' WHERE deployment_id=?").run(D2);
        softDeleteDeploymentFile(db, D2, "shared.md", 5_000);
        expect(probe(["shared.md"])).toBeNull();
        seedActiveFile(db, D2, "shared.md");
        db.prepare("UPDATE deployments SET deleted=1 WHERE deployment_id=?").run(D2);
        expect(probe(["shared.md"])).toBeNull();
    });
});
