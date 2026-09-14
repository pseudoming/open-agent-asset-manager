/** Canonical database projection against corrupt stored authority and real SQLite rows. */

import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
    commitReverseAcceptSuccessCrashDurable,
    prepareDeploymentSuccessAuthority,
    readCanonicalDeploymentPreCommitDatabaseState,
} from "../../src/deployment/deployment-state-authority";
import { computeAppliedRenderSnapshotFingerprint, computeDeploymentAssetId } from "../../src/foundation/fingerprint";
import {
    parseDeploymentFileBaselineState,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
} from "../../src/render/deployment-render-authority";
import {
    getDeploymentFile,
    insertDeploymentRenderSnapshot,
    updateDeployment,
    upsertDeploymentAsset,
} from "../../src/persistence/state-db";
import {
    DEPLOYMENT_ID,
    makeRemovalSuccessInput,
    makeSuccessInput,
    seedActiveFile,
} from "../reverse/fixtures/reverse-accept-db-fixtures";
import {
    ASSET_ID,
    VERSION_ID,
    root,
    databasePath,
    freshDatabase,
    freshRemovedDatabase,
    rewriteFileProvenance,
} from "./fixtures/deployment-state-authority-test-fixtures";

describe("canonical database projection rejects corrupted stored authority", () => {
    it("requires the current render-snapshot row to exist and remain applied", () => {
        seedActiveFile(databasePath, "active.md");
        const deleted = new Database(databasePath);
        deleted.prepare("UPDATE deployment_render_snapshots SET deleted=1").run();
        deleted.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID)).toThrow(
            /current render snapshot is unresolved/,
        );

        const missingPath = freshDatabase("missing-snapshot");
        seedActiveFile(missingPath, "active.md");
        const missing = new Database(missingPath);
        missing.prepare("DELETE FROM deployment_render_snapshots").run();
        missing.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(missingPath, DEPLOYMENT_ID)).toThrow(
            /current render snapshot is unresolved/,
        );

        const neverPath = freshDatabase("never-snapshot");
        const neverSnapshot = { schemaVersion: 1 as const, snapshotState: "never" as const };
        const fingerprint = computeAppliedRenderSnapshotFingerprint(neverSnapshot);
        const never = new Database(neverPath);
        insertDeploymentRenderSnapshot(never, {
            snapshotFingerprint: fingerprint,
            deploymentId: DEPLOYMENT_ID,
            snapshotJson: serializeAppliedRenderSnapshot(neverSnapshot),
            deleted: 0,
            createdAt: 2_000,
            updatedAt: 2_000,
        });
        updateDeployment(
            never,
            DEPLOYMENT_ID,
            {
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint: fingerprint,
                }),
            },
            2_000,
        );
        never.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(neverPath, DEPLOYMENT_ID)).toThrow(
            /current render snapshot is not applied/,
        );
    });

    it("projects valid DeploymentAsset rows and rejects every corrupted physical field", () => {
        const valid = new Database(databasePath);
        upsertDeploymentAsset(valid, DEPLOYMENT_ID, ASSET_ID, VERSION_ID, 0, 0, 2_000);
        upsertDeploymentAsset(valid, DEPLOYMENT_ID, VERSION_ID, ASSET_ID, 1, 1, 2_001);
        valid.close();
        expect(readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID).deploymentAssets).toHaveLength(2);

        const cases: Array<{
            name: string;
            sql: string;
            params: unknown[];
            expected: RegExp;
        }> = [
            {
                name: "deterministic ID",
                sql: "UPDATE deployment_assets SET deployment_asset_id='bad'",
                params: [],
                expected: /DeploymentAsset is invalid/,
            },
            {
                name: "asset UUID",
                sql: "UPDATE deployment_assets SET deployment_asset_id=?, asset_id='bad'",
                params: [computeDeploymentAssetId(DEPLOYMENT_ID, "bad")],
                expected: /DeploymentAsset is invalid/,
            },
            {
                name: "version UUID",
                sql: "UPDATE deployment_assets SET version_id='bad'",
                params: [],
                expected: /DeploymentAsset is invalid/,
            },
            {
                name: "sort order",
                sql: "UPDATE deployment_assets SET sort_order=-1",
                params: [],
                expected: /DeploymentAsset is invalid/,
            },
            {
                name: "allow flag",
                sql: "UPDATE deployment_assets SET allow_incomplete=2",
                params: [],
                expected: /allowIncomplete/,
            },
            {
                name: "deleted flag",
                sql: "UPDATE deployment_assets SET deleted=2",
                params: [],
                expected: /deleted/,
            },
            {
                name: "timestamp",
                sql: "UPDATE deployment_assets SET updated_at=0",
                params: [],
                expected: /timestamps/,
            },
        ];
        for (const testCase of cases) {
            const casePath = freshDatabase(`asset-${testCase.name.replace(" ", "-")}`);
            const db = new Database(casePath);
            upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, VERSION_ID, 0, 0, 2_000);
            db.pragma("ignore_check_constraints = ON");
            db.prepare(testCase.sql).run(...testCase.params);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID), testCase.name).toThrow(
                testCase.expected,
            );
        }
    });

    it("rejects corrupt DeploymentFile identity, time, observation and provenance joins", () => {
        const cases: Array<{
            name: string;
            sql: string;
            expected: RegExp;
        }> = [
            {
                name: "identity",
                sql: "UPDATE deployment_files SET relative_path='renamed.md'",
                expected: /identity\/lifecycle/,
            },
            {
                name: "executable flag",
                sql: "UPDATE deployment_files SET observed_executable=2",
                expected: /observedExecutable/,
            },
            {
                name: "timestamp",
                sql: "UPDATE deployment_files SET updated_at=0",
                expected: /timestamps/,
            },
            {
                name: "observed time",
                sql: "UPDATE deployment_files SET observed_at=-1",
                expected: /observedAt/,
            },
            {
                name: "observation state",
                sql: "UPDATE deployment_files SET observed_state='bogus'",
                expected: /observed_state/,
            },
            {
                name: "missing provenance snapshot",
                sql: "DELETE FROM deployment_render_snapshots WHERE snapshot_fingerprint <> json_extract((SELECT applied_render_snapshot_ref FROM deployments), '$.snapshotFingerprint')",
                expected: /provenance snapshot is unresolved/,
            },
            {
                name: "deleted provenance snapshot",
                sql: "UPDATE deployment_render_snapshots SET deleted=1 WHERE snapshot_fingerprint <> json_extract((SELECT applied_render_snapshot_ref FROM deployments), '$.snapshotFingerprint')",
                expected: /provenance snapshot is unresolved/,
            },
        ];
        for (const testCase of cases) {
            const casePath = freshDatabase(`file-${testCase.name.replaceAll(" ", "-")}`);
            seedActiveFile(casePath, "active.md");
            if (testCase.name.includes("provenance snapshot")) {
                seedActiveFile(casePath, "current.md");
            }
            const db = new Database(casePath);
            db.pragma("foreign_keys = OFF");
            db.pragma("ignore_check_constraints = ON");
            db.exec(testCase.sql);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID), testCase.name).toThrow(
                testCase.expected,
            );
        }
    });

    it("rejects non-applied and path-foreign render provenance snapshots", () => {
        const neverPath = freshDatabase("file-provenance-never");
        seedActiveFile(neverPath, "active.md");
        const neverSnapshot = { schemaVersion: 1 as const, snapshotState: "never" as const };
        const neverFingerprint = computeAppliedRenderSnapshotFingerprint(neverSnapshot);
        const neverDb = new Database(neverPath);
        insertDeploymentRenderSnapshot(neverDb, {
            snapshotFingerprint: neverFingerprint,
            deploymentId: DEPLOYMENT_ID,
            snapshotJson: serializeAppliedRenderSnapshot(neverSnapshot),
            deleted: 0,
            createdAt: 5_000,
            updatedAt: 5_000,
        });
        rewriteFileProvenance(neverDb, "active.md", (provenance) => ({
            ...provenance,
            appliedRenderSnapshotFingerprint: neverFingerprint,
        }));
        neverDb.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(neverPath, DEPLOYMENT_ID)).toThrow(
            /provenance snapshot is not applied/,
        );

        for (const useForeignUnit of [false, true]) {
            const casePath = freshDatabase(`file-provenance-${useForeignUnit ? "claim" : "unit"}`);
            seedActiveFile(casePath, "active.md");
            seedActiveFile(casePath, "other.md");
            const db = new Database(casePath);
            const other = getDeploymentFile(db, DEPLOYMENT_ID, "other.md");
            if (other === null) throw new Error("fixture other file missing");
            const otherBaseline = parseDeploymentFileBaselineState(other.baselineState);
            if (otherBaseline.rowState !== "active") throw new Error("fixture other file removed");
            rewriteFileProvenance(db, "active.md", (provenance) => ({
                ...provenance,
                appliedRenderSnapshotFingerprint: otherBaseline.provenance.appliedRenderSnapshotFingerprint,
                outputUnitFingerprint: useForeignUnit
                    ? otherBaseline.provenance.outputUnitFingerprint
                    : provenance.outputUnitFingerprint,
            }));
            db.close();
            expect(
                () => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID),
                useForeignUnit ? "foreign claim" : "missing unit",
            ).toThrow(/provenance does not own its path/);
        }
    });

    it("rejects malformed consumer JSON values before they become canonical runtime IDs", () => {
        const values = ['"not-an-array"', "[1]", '[""]', '["lowercase"]'];
        for (const [index, consumerJson] of values.entries()) {
            const casePath = freshDatabase(`consumer-${index}`);
            const db = new Database(casePath);
            db.prepare("UPDATE deployments SET consumer_agent_runtime_ids=?").run(consumerJson);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID)).toThrow(
                /consumerAgentRuntimeIds is invalid/,
            );
        }
    });

    it("rejects every incoherent persisted Deployment observation clock", () => {
        const cases = [
            {
                name: "negative attempt",
                sql: "UPDATE deployments SET observation_attempted_at=-1",
                expected: /observation times are invalid/,
            },
            {
                name: "never with attempt",
                sql: "UPDATE deployments SET observation_attempted_at=1",
                expected: /never observation must use zero times/,
            },
            {
                name: "terminal without attempt",
                sql: "UPDATE deployments SET observation_state='failed'",
                expected: /terminal observation must have an attempt time/,
            },
            {
                name: "complete mismatch",
                sql: "UPDATE deployments SET observation_state='complete', observation_attempted_at=2, last_complete_observation_at=1",
                expected: /complete observation times must match/,
            },
        ];
        for (const testCase of cases) {
            const casePath = freshDatabase(`observation-clock-${testCase.name.replaceAll(" ", "-")}`);
            const db = new Database(casePath);
            db.pragma("ignore_check_constraints = ON");
            db.exec(testCase.sql);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID), testCase.name).toThrow(
                testCase.expected,
            );
        }
    });

    it("rejects removed pointers and residual rows that no longer form exact authority", () => {
        seedActiveFile(databasePath, "removed.md");
        const removal = makeRemovalSuccessInput(databasePath, "removed.md");
        commitReverseAcceptSuccessCrashDurable({
            databasePath,
            successCommit: removal,
            preparedAuthority: prepareDeploymentSuccessAuthority(databasePath, removal),
        });
        const baseline = readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID);
        expect(baseline.deploymentFiles[0]?.rowState).toBe("removed");

        const missingPath = freshRemovedDatabase("missing-residual");
        const missing = new Database(missingPath);
        missing.prepare("DELETE FROM deployment_residual_authorities").run();
        missing.close();
        expect(() => readCanonicalDeploymentPreCommitDatabaseState(missingPath, DEPLOYMENT_ID)).toThrow(
            /invalid residual authority/,
        );

        for (const [name, sql] of [
            ["deleted", "UPDATE deployment_residual_authorities SET deleted=1"],
            ["timestamp", "UPDATE deployment_residual_authorities SET updated_at=updated_at+1"],
        ] as const) {
            const casePath = freshRemovedDatabase(`residual-${name}`);
            const db = new Database(casePath);
            db.pragma("ignore_check_constraints = ON");
            db.exec(sql);
            db.close();
            expect(() => readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID), name).toThrow(
                /row lifecycle is invalid/,
            );
        }
    });

    it("sorts a multi-file, multi-residual closure deterministically", () => {
        const casePath = freshDatabase("multi-residual");
        seedActiveFile(casePath, "z.md");
        seedActiveFile(casePath, "a.md");
        const z = makeRemovalSuccessInput(casePath, "z.md").newlyRemoved[0]!;
        const a = makeRemovalSuccessInput(casePath, "a.md").newlyRemoved[0]!;
        const removal = makeSuccessInput();
        removal.newlyRemoved = [z, a];
        const prepared = prepareDeploymentSuccessAuthority(casePath, removal);
        commitReverseAcceptSuccessCrashDurable({
            databasePath: casePath,
            successCommit: removal,
            preparedAuthority: prepared,
        });
        const reopened = readCanonicalDeploymentPreCommitDatabaseState(casePath, DEPLOYMENT_ID);
        expect(reopened.deploymentFiles.map((file) => file.deploymentFileId)).toEqual(
            [...reopened.deploymentFiles]
                .map((file) => file.deploymentFileId)
                .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
        );
        expect(reopened.residualAuthorities.map((item) => item.residualAuthorityId)).toEqual(
            [...reopened.residualAuthorities]
                .map((item) => item.residualAuthorityId)
                .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
        );
        expect(reopened.deploymentFiles).toHaveLength(2);
        expect(reopened.residualAuthorities).toHaveLength(2);
    });
});
