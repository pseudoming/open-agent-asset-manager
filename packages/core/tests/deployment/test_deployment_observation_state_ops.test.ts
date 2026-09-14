/** Authority-focused split from the original oversized Deployment test suite. */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAppliedRenderSnapshotRef } from "../../src/render/deployment-render-authority";
import {
    captureDeploymentObservationAttemptAnchor,
    commitDeploymentObservation,
    commitIncompleteDeploymentObservationAttempt,
} from "../../src/deployment/deployment-observation-state-ops";
import { commitDeploymentSuccess } from "../../src/deployment/deployment-state-ops";
import {
    getDeployment,
    getDeploymentFile,
    insertDeployment,
    listDeploymentFiles,
    updateDeployment,
} from "../../src/persistence/state-db";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import {
    D1,
    TXN1,
    TXN2,
    freshDb,
    makeDeploymentRow,
    textPlan,
    seedActiveFile,
    successInput,
} from "./fixtures/deployment-state-ops-test-fixtures";

describe("commitDeploymentObservation", () => {
    function observationFixture() {
        const db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
        seedActiveFile(db, D1, "a.md");
        updateDeployment(db, D1, { committedTransactionId: TXN1 }, 4_000);
        const deployment = getDeployment(db, D1);
        if (deployment === null) throw new Error("missing Deployment fixture");
        const ref = parseAppliedRenderSnapshotRef(deployment.appliedRenderSnapshotRef);
        if (ref.snapshotState !== "applied") throw new Error("missing snapshot fixture");
        return { db, deployment, snapshotFingerprint: ref.snapshotFingerprint };
    }

    it("atomically commits present and missing observations over the exact active closure", () => {
        const present = observationFixture();
        commitDeploymentObservation({
            db: present.db,
            deploymentId: D1,
            expectedCommittedTransactionId: present.deployment.committedTransactionId,
            expectedSnapshotFingerprint: present.snapshotFingerprint,
            files: [
                {
                    relativePath: "a.md",
                    observedState: "present",
                    observedContentHash: `sha256:${"a".repeat(64)}`,
                    observedExecutable: true,
                },
            ],
            observedAt: 5_000,
        });
        expect(getDeploymentFile(present.db, D1, "a.md")).toMatchObject({
            observedState: "present",
            observedContentHash: `sha256:${"a".repeat(64)}`,
            observedExecutable: 1,
        });

        const missing = observationFixture();
        commitDeploymentObservation({
            db: missing.db,
            deploymentId: D1,
            expectedCommittedTransactionId: missing.deployment.committedTransactionId,
            expectedSnapshotFingerprint: missing.snapshotFingerprint,
            files: [{ relativePath: "a.md", observedState: "missing" }],
            observedAt: 5_001,
        });
        expect(getDeploymentFile(missing.db, D1, "a.md")).toMatchObject({
            observedState: "missing",
            observedContentHash: "",
            observedExecutable: 0,
        });
    });

    it("rejects a missing or soft-deleted Deployment", () => {
        const missing = freshDb();
        expect(() =>
            commitDeploymentObservation({
                db: missing,
                deploymentId: D1,
                expectedCommittedTransactionId: TXN1,
                expectedSnapshotFingerprint: `sha256:${"a".repeat(64)}`,
                files: [],
                observedAt: 1,
            }),
        ).toThrow(/active Deployment/);

        const deleted = observationFixture();
        deleted.db.prepare("UPDATE deployments SET deleted=1 WHERE deployment_id=?").run(D1);
        expect(() =>
            commitDeploymentObservation({
                db: deleted.db,
                deploymentId: D1,
                expectedCommittedTransactionId: deleted.deployment.committedTransactionId,
                expectedSnapshotFingerprint: deleted.snapshotFingerprint,
                files: [{ relativePath: "a.md", observedState: "missing" }],
                observedAt: 1,
            }),
        ).toThrow(/active Deployment/);
    });

    it.each([
        ["transaction", { transaction: "stale", snapshotState: "applied", fingerprint: "current" }],
        ["snapshot state", { transaction: "current", snapshotState: "never", fingerprint: "current" }],
        ["snapshot fingerprint", { transaction: "current", snapshotState: "applied", fingerprint: "stale" }],
    ])("rejects stale %s authority", (_label, variant) => {
        const fixture = observationFixture();
        if (variant.snapshotState === "never") {
            updateDeployment(fixture.db, D1, { appliedRenderSnapshotRef: '{"snapshotState":"never"}' }, 4_500);
        }
        expect(() =>
            commitDeploymentObservation({
                db: fixture.db,
                deploymentId: D1,
                expectedCommittedTransactionId:
                    variant.transaction === "current" ? fixture.deployment.committedTransactionId : TXN2,
                expectedSnapshotFingerprint:
                    variant.fingerprint === "current" ? fixture.snapshotFingerprint : `sha256:${"b".repeat(64)}`,
                files: [{ relativePath: "a.md", observedState: "missing" }],
                observedAt: 5_000,
            }),
        ).toThrow(/success authority changed/);
    });

    it("rejects duplicate and incomplete observation path closures", () => {
        const fixture = observationFixture();
        const input = {
            db: fixture.db,
            deploymentId: D1,
            expectedCommittedTransactionId: fixture.deployment.committedTransactionId,
            expectedSnapshotFingerprint: fixture.snapshotFingerprint,
            observedAt: 5_000,
        };
        expect(() =>
            commitDeploymentObservation({
                ...input,
                files: [
                    { relativePath: "a.md", observedState: "missing" },
                    { relativePath: "a.md", observedState: "missing" },
                ],
            }),
        ).toThrow(/exact active baseline/);
        expect(() => commitDeploymentObservation({ ...input, files: [] })).toThrow(/exact active baseline/);
    });

    it("rolls back the entire observation when a later file update fails", () => {
        const db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
        const plan: TargetPlan = {
            schemaVersion: 1,
            targetFiles: [textPlan("a.md").targetFiles[0]!, textPlan("b.md").targetFiles[0]!],
        };
        commitDeploymentSuccess(db, successInput(D1, plan));
        const deployment = getDeployment(db, D1);
        if (deployment === null) throw new Error("missing Deployment fixture");
        const ref = parseAppliedRenderSnapshotRef(deployment.appliedRenderSnapshotRef);
        if (ref.snapshotState !== "applied") throw new Error("missing snapshot fixture");
        const beforeFiles = listDeploymentFiles(db, D1, false);
        const beforeDeployment = getDeployment(db, D1);
        db.exec(`CREATE TRIGGER fail_second_observation
            BEFORE UPDATE ON deployment_files
            WHEN NEW.relative_path = 'b.md'
            BEGIN SELECT RAISE(ABORT, 'fixture observation failure'); END`);

        expect(() =>
            commitDeploymentObservation({
                db,
                deploymentId: D1,
                expectedCommittedTransactionId: deployment.committedTransactionId,
                expectedSnapshotFingerprint: ref.snapshotFingerprint,
                files: [
                    {
                        relativePath: "a.md",
                        observedState: "present",
                        observedContentHash: `sha256:${"a".repeat(64)}`,
                        observedExecutable: false,
                    },
                    { relativePath: "b.md", observedState: "missing" },
                ],
                observedAt: 10_000,
            }),
        ).toThrow(/fixture observation failure/);
        expect(listDeploymentFiles(db, D1, false)).toEqual(beforeFiles);
        expect(getDeployment(db, D1)).toEqual(beforeDeployment);
    });

    it("rejects noncanonical paths and malformed present hashes before mutation", () => {
        const fixture = observationFixture();
        const input = {
            db: fixture.db,
            deploymentId: D1,
            expectedCommittedTransactionId: fixture.deployment.committedTransactionId,
            expectedSnapshotFingerprint: fixture.snapshotFingerprint,
            observedAt: 5_000,
        };
        expect(() =>
            commitDeploymentObservation({
                ...input,
                files: [{ relativePath: "a//b.md", observedState: "missing" }],
            }),
        ).toThrow(/relativePath must be canonical/);
        expect(() =>
            commitDeploymentObservation({
                ...input,
                files: [
                    {
                        relativePath: "a.md",
                        observedState: "present",
                        observedContentHash: "not-a-hash",
                        observedExecutable: false,
                    },
                ],
            }),
        ).toThrow(/content hash must be SHA-256/);
        expect(getDeploymentFile(fixture.db, D1, "a.md")?.observedAt).toBe(4_000);
    });

    it.each([
        ["deployment ID", { deploymentId: "bad" }, /deploymentId must be UUID v4/],
        ["committed transaction ID", { expectedCommittedTransactionId: "bad" }, /committed transaction ID must be UUID v4/],
        ["snapshot fingerprint", { expectedSnapshotFingerprint: "bad" }, /snapshot fingerprint must be SHA-256/],
        ["negative time", { observedAt: -1 }, /non-negative safe integer/],
        ["fractional time", { observedAt: 1.5 }, /non-negative safe integer/],
        ["regressed clock", { observedAt: 3_999 }, /predates current Deployment authority/],
    ])("rejects malformed observation authority input: %s", (_label, override, expected) => {
        const fixture = observationFixture();
        const input = {
            db: fixture.db,
            deploymentId: D1,
            expectedCommittedTransactionId: fixture.deployment.committedTransactionId,
            expectedSnapshotFingerprint: fixture.snapshotFingerprint,
            files: [{ relativePath: "a.md", observedState: "missing" as const }],
            observedAt: 5_000,
            ...override,
        };
        expect(() => commitDeploymentObservation(input)).toThrow(expected);
        expect(getDeploymentFile(fixture.db, D1, "a.md")?.observedAt).toBe(4_000);
    });

    it("rejects malformed observation union values before mutation", () => {
        const fixture = observationFixture();
        const input = {
            db: fixture.db,
            deploymentId: D1,
            expectedCommittedTransactionId: fixture.deployment.committedTransactionId,
            expectedSnapshotFingerprint: fixture.snapshotFingerprint,
            observedAt: 5_000,
        };
        expect(() =>
            commitDeploymentObservation({
                ...input,
                files: [{ relativePath: "a.md", observedState: "gone" } as never],
            }),
        ).toThrow(/state must be present or missing/);
        expect(() =>
            commitDeploymentObservation({
                ...input,
                files: [
                    {
                        relativePath: "a.md",
                        observedState: "present",
                        observedContentHash: `sha256:${"a".repeat(64)}`,
                        observedExecutable: 1,
                    } as never,
                ],
            }),
        ).toThrow(/executable flag must be boolean/);
        expect(getDeploymentFile(fixture.db, D1, "a.md")?.observedAt).toBe(4_000);
    });
});

describe("terminal incomplete Deployment observation attempts", () => {
    it("preserves the last complete observation and rejects a stale attempt anchor", () => {
        const db = freshDb();
        insertDeployment(
            db,
            makeDeploymentRow(D1, {
                observationState: "complete",
                observationAttemptedAt: 4_000,
                lastCompleteObservationAt: 4_000,
            }),
        );
        const first = captureDeploymentObservationAttemptAnchor(db, D1);
        if (first === null) throw new Error("missing observation attempt anchor");
        expect(commitIncompleteDeploymentObservationAttempt({ db, anchor: first, state: "failed", attemptedAt: 5_000 })).toBe(
            true,
        );
        expect(getDeployment(db, D1)).toMatchObject({
            observationState: "failed",
            observationAttemptedAt: 5_000,
            lastCompleteObservationAt: 4_000,
            updatedAt: 5_000,
        });

        const stale = captureDeploymentObservationAttemptAnchor(db, D1);
        if (stale === null) throw new Error("missing stale observation attempt anchor");
        updateDeployment(db, D1, { blockingEvidence: '{"newer":true}' }, 5_100);
        expect(commitIncompleteDeploymentObservationAttempt({ db, anchor: stale, state: "partial", attemptedAt: 5_200 })).toBe(
            false,
        );
        expect(getDeployment(db, D1)).toMatchObject({
            observationState: "failed",
            observationAttemptedAt: 5_000,
            lastCompleteObservationAt: 4_000,
            updatedAt: 5_100,
        });
    });

    it("returns no anchor for missing/deleted rows and rejects malformed terminal-attempt authority", () => {
        const db = freshDb();
        expect(captureDeploymentObservationAttemptAnchor(db, D1)).toBeNull();
        insertDeployment(db, makeDeploymentRow(D1, { deleted: 1 }));
        expect(captureDeploymentObservationAttemptAnchor(db, D1)).toBeNull();

        expect(() =>
            commitIncompleteDeploymentObservationAttempt({
                db,
                anchor: { deploymentId: "bad", rowBody: "{}" },
                state: "failed",
                attemptedAt: 1,
            }),
        ).toThrow(/deploymentId must be UUID v4/);
        expect(() =>
            commitIncompleteDeploymentObservationAttempt({
                db,
                anchor: { deploymentId: D1, rowBody: "{}" },
                state: "failed",
                attemptedAt: 0,
            }),
        ).toThrow(/positive epoch millisecond/);
        expect(() =>
            commitIncompleteDeploymentObservationAttempt({
                db,
                anchor: { deploymentId: D1, rowBody: "{}" },
                state: "complete" as never,
                attemptedAt: 1,
            }),
        ).toThrow(/partial or failed/);
    });

    it("rejects clocks that move behind the captured Deployment authority", () => {
        const db = freshDb();
        insertDeployment(
            db,
            makeDeploymentRow(D1, { observationState: "failed", observationAttemptedAt: 4_000, updatedAt: 4_100 }),
        );
        const anchor = captureDeploymentObservationAttemptAnchor(db, D1);
        if (anchor === null) throw new Error("missing observation attempt anchor");
        expect(() => commitIncompleteDeploymentObservationAttempt({ db, anchor, state: "failed", attemptedAt: 4_050 })).toThrow(
            /predates current Deployment authority/,
        );
    });
});
