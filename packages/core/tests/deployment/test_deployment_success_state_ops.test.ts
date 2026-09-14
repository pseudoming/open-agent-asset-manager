/** Authority-focused split from the original oversized Deployment test suite. */

import * as path from "node:path";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
    finalizeDeploymentResidualAuthority,
    finalizeTargetFileRenderProvenance,
    makeRemovalIntentFingerprint,
    parseAppliedRenderSnapshotRef,
    parseDeploymentFileBaselineState,
    serializeAppliedRenderSnapshot,
    serializeDeploymentFileBaselineState,
} from "../../src/render/deployment-render-authority";
import {
    beginDeploymentProbeTx,
    commitDeploymentSuccess,
    findActivePathOccupiers,
    loadDeploymentBaseline,
} from "../../src/deployment/deployment-state-ops";
import { computeAppliedRenderSnapshotFingerprint } from "../../src/foundation/fingerprint";
import {
    getDeployment,
    getDeploymentFile,
    getDeploymentRenderSnapshot,
    getDeploymentResidualAuthority,
    insertDeployment,
    insertDeploymentRenderSnapshot,
    insertDeploymentResidualAuthority,
    listDeploymentFiles,
    upsertDeploymentAsset,
} from "../../src/persistence/state-db";
import { makeExecutionAuthority, shaBytes } from "./fixtures/deployment-authority-fixtures";
import {
    D1,
    D2,
    TXN1,
    TXN2,
    freshDb,
    makeDeploymentRow,
    emptyBlockingEvidence,
    textPlan,
    seedActiveFile,
    successInput,
    residualFromCurrent,
} from "./fixtures/deployment-state-ops-test-fixtures";

describe("commitDeploymentSuccess", () => {
    let db: Database.Database;
    beforeEach(() => {
        db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
    });

    it("atomically commits snapshot, active baseline, transaction and clears blocking evidence", () => {
        const input = successInput(D1, textPlan("a.md", "# new", true));
        commitDeploymentSuccess(db, input);
        const dep = getDeployment(db, D1);
        expect(dep?.committedTransactionId).toBe(TXN1);
        expect(dep?.observationState).toBe("complete");
        expect(dep?.blockingEvidence).toBe(emptyBlockingEvidence());
        expect(JSON.parse(dep?.appliedInputsSnapshot ?? "").deploymentId).toBe(D1);
        const ref = parseAppliedRenderSnapshotRef(dep?.appliedRenderSnapshotRef ?? "");
        expect(ref.snapshotState).toBe("applied");
        if (ref.snapshotState === "applied") {
            expect(getDeploymentRenderSnapshot(db, D1, ref.snapshotFingerprint)?.deploymentId).toBe(D1);
        }
        const baseline = parseDeploymentFileBaselineState(getDeploymentFile(db, D1, "a.md")?.baselineState ?? "");
        expect(baseline).toMatchObject({ rowState: "active", appliedExecutable: true });
    });

    it("preserves DeploymentFile identity while advancing an active baseline", () => {
        seedActiveFile(db, D1, "a.md", "# old");
        const before = getDeploymentFile(db, D1, "a.md");
        commitDeploymentSuccess(db, successInput(D1, textPlan("a.md", "# new")));
        const after = getDeploymentFile(db, D1, "a.md");
        expect(after?.deploymentFileId).toBe(before?.deploymentFileId);
        expect(after?.createdAt).toBe(before?.createdAt);
        expect(parseDeploymentFileBaselineState(after?.baselineState ?? "")).toMatchObject({
            rowState: "active",
            appliedPayload: { contentHash: shaBytes(Buffer.from("# new")) },
        });
    });

    it("records removals as a missing row plus immutable cumulative residual", () => {
        seedActiveFile(db, D1, "old.md", "# old");
        const input = successInput(D1, { schemaVersion: 1, targetFiles: [] }, TXN2);
        const residual = residualFromCurrent(db, D1, "old.md", input.appliedRenderSnapshot.compilationFingerprint);
        input.newlyRemoved = [residual];
        commitDeploymentSuccess(db, input);
        const row = getDeploymentFile(db, D1, "old.md");
        expect(row?.deleted).toBe(0);
        expect(row?.observedState).toBe("missing");
        expect(parseDeploymentFileBaselineState(row?.baselineState ?? "")).toEqual({
            rowState: "removed",
            latestResidualAuthorityId: residual.residualAuthorityId,
        });
        expect(getDeploymentResidualAuthority(db, residual.residualAuthorityId)).not.toBeNull();
        expect(loadDeploymentBaseline(db, D1)).toEqual([]);
    });

    it("rolls back every authority write on a mid-transaction file failure", () => {
        const before = getDeployment(db, D1);
        const input = successInput(D1, textPlan("a.md"));
        input.verifiedActiveFiles[0] = {
            ...input.verifiedActiveFiles[0],
            verified: {
                ...input.verifiedActiveFiles[0]!.verified,
                observedState: "bogus" as "present",
            },
        };
        expect(() => commitDeploymentSuccess(db, input)).toThrow();
        expect(getDeployment(db, D1)).toEqual(before);
        expect(getDeploymentFile(db, D1, "a.md")).toBeNull();
        expect(listDeploymentFiles(db, D1, true)).toEqual([]);
        expect(
            getDeploymentRenderSnapshot(db, D1, computeAppliedRenderSnapshotFingerprint(input.appliedRenderSnapshot)),
        ).toBeNull();
    });

    it("rejects missing/deleted deployments without phantom state", () => {
        const missing = successInput(D2, { schemaVersion: 1, targetFiles: [] });
        expect(() => commitDeploymentSuccess(db, missing)).toThrow(/does not exist/);
        expect(getDeployment(db, D2)).toBeNull();
        db.prepare("UPDATE deployments SET deleted=1 WHERE deployment_id=?").run(D1);
        expect(() => commitDeploymentSuccess(db, successInput(D1, { schemaVersion: 1, targetFiles: [] }))).toThrow(
            /soft-deleted/,
        );
        expect(getDeployment(db, D1)?.committedTransactionId).toBe("");
    });

    it("rejects consumer/input drift and duplicate active/removal paths", () => {
        const drift = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        drift.appliedInputsSnapshot.consumerAgentRuntimeIds = ["OPENCODE_CLI"];
        expect(() => commitDeploymentSuccess(db, drift)).toThrow(/consumers/);

        const noConsumers = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        noConsumers.appliedInputsSnapshot.consumerAgentRuntimeIds = [];
        expect(() => commitDeploymentSuccess(db, noConsumers)).toThrow(/at least one consumer/);

        const assetDrift = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        upsertDeploymentAsset(
            db,
            D1,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            1,
            0,
            5_000,
        );
        expect(() => commitDeploymentSuccess(db, assetDrift)).toThrow(/assets/);
        db.prepare("DELETE FROM deployment_assets WHERE deployment_id=?").run(D1);

        seedActiveFile(db, D1, "a.md");
        const conflict = successInput(D1, textPlan("a.md"));
        conflict.newlyRemoved = [residualFromCurrent(db, D1, "a.md", conflict.appliedRenderSnapshot.compilationFingerprint)];
        expect(() => commitDeploymentSuccess(db, conflict)).toThrow(/active and removed/);

        const duplicate = successInput(D1, textPlan("dup.md"));
        duplicate.verifiedActiveFiles.push(duplicate.verifiedActiveFiles[0]!);
        expect(() => commitDeploymentSuccess(db, duplicate)).toThrow(/duplicate success/);

        expect(() =>
            commitDeploymentSuccess(db, {
                ...successInput(D1, { schemaVersion: 1, targetFiles: [] }),
                transactionId: "not-a-uuid",
            }),
        ).toThrow(/transactionId/);
        expect(() =>
            commitDeploymentSuccess(db, {
                ...successInput(D1, { schemaVersion: 1, targetFiles: [] }),
                now: -1,
            }),
        ).toThrow(/commit time/);
        db.prepare("UPDATE deployments SET updated_at=10000 WHERE deployment_id=?").run(D1);
        expect(() => commitDeploymentSuccess(db, successInput(D1, { schemaVersion: 1, targetFiles: [] }))).toThrow(
            /predates current Deployment authority/,
        );
    });

    it("requires exact coverage of every old active path and its removal authority", () => {
        seedActiveFile(db, D1, "old.md");
        const omitted = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        expect(() => commitDeploymentSuccess(db, omitted)).toThrow(/omitted a current active/);

        const ghost = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        const oldRow = getDeploymentFile(db, D1, "old.md")!;
        const oldBaseline = parseDeploymentFileBaselineState(oldRow.baselineState);
        if (oldBaseline.rowState !== "active") throw new Error("bad fixture");
        ghost.newlyRemoved = [
            finalizeDeploymentResidualAuthority({
                schemaVersion: 1,
                deploymentId: D1,
                relativePath: "ghost.md",
                appliedPayload: oldBaseline.appliedPayload,
                appliedExecutable: oldBaseline.appliedExecutable,
                previousProvenance: oldBaseline.provenance,
                removalIntentFingerprint: makeRemovalIntentFingerprint({
                    deploymentId: D1,
                    relativePath: "ghost.md",
                    previousProvenanceFingerprint: oldBaseline.provenance.provenanceFingerprint,
                    nextCompilationFingerprint: ghost.appliedRenderSnapshot.compilationFingerprint,
                    reason: "absent_from_new_desired_set",
                }),
            }),
        ];
        expect(() => commitDeploymentSuccess(db, ghost)).toThrow(/must come from the current active/);

        const wrong = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        const actual = residualFromCurrent(db, D1, "old.md", wrong.appliedRenderSnapshot.compilationFingerprint);
        wrong.newlyRemoved = [
            finalizeDeploymentResidualAuthority({
                schemaVersion: 1,
                deploymentId: D1,
                relativePath: "old.md",
                appliedPayload: {
                    ...actual.appliedPayload,
                    contentHash: `sha256:${"f".repeat(64)}`,
                },
                appliedExecutable: actual.appliedExecutable,
                previousProvenance: actual.previousProvenance,
                removalIntentFingerprint: actual.removalIntentFingerprint,
            }),
        ];
        expect(() => commitDeploymentSuccess(db, wrong)).toThrow(/does not prove this active baseline/);
    });

    it("rejects active provenance resolving to a structurally valid never snapshot", () => {
        seedActiveFile(db, D1, "a.md");
        const neverSnapshot = { schemaVersion: 1 as const, snapshotState: "never" as const };
        const neverFingerprint = computeAppliedRenderSnapshotFingerprint(neverSnapshot);
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: neverFingerprint,
            deploymentId: D1,
            snapshotJson: serializeAppliedRenderSnapshot(neverSnapshot),
            deleted: 0,
            createdAt: 5_000,
            updatedAt: 5_000,
        });
        const row = getDeploymentFile(db, D1, "a.md")!;
        const baseline = parseDeploymentFileBaselineState(row.baselineState);
        if (baseline.rowState !== "active") throw new Error("bad fixture");
        const { provenanceFingerprint: _stored, ...preimage } = baseline.provenance;
        const nonApplied = finalizeTargetFileRenderProvenance({
            ...preimage,
            appliedRenderSnapshotFingerprint: neverFingerprint,
        });
        db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?").run(
            serializeDeploymentFileBaselineState({ ...baseline, provenance: nonApplied }),
            D1,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/non-applied snapshot/);
    });

    it("rejects baseline provenance whose snapshot does not own its unit or path", () => {
        seedActiveFile(db, D1, "a.md");
        const row = getDeploymentFile(db, D1, "a.md")!;
        const baseline = parseDeploymentFileBaselineState(row.baselineState);
        if (baseline.rowState !== "active") throw new Error("bad fixture");
        const { provenanceFingerprint: _stored, ...preimage } = baseline.provenance;
        const unknownUnit = finalizeTargetFileRenderProvenance({
            ...preimage,
            outputUnitFingerprint: `sha256:${"c".repeat(64)}`,
        });
        db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?").run(
            serializeDeploymentFileBaselineState({ ...baseline, provenance: unknownUnit }),
            D1,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/exactly one output unit/);

        const otherAuthority = makeExecutionAuthority(textPlan("b.md"));
        const otherSnapshotFingerprint = computeAppliedRenderSnapshotFingerprint(otherAuthority.appliedRenderSnapshot);
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: otherSnapshotFingerprint,
            deploymentId: D1,
            snapshotJson: serializeAppliedRenderSnapshot(otherAuthority.appliedRenderSnapshot),
            deleted: 0,
            createdAt: 5_100,
            updatedAt: 5_100,
        });
        const otherProvenance = otherAuthority.targetFileProvenance[0]?.provenance;
        if (otherProvenance === undefined) throw new Error("missing other fixture provenance");
        db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=?").run(
            serializeDeploymentFileBaselineState({ ...baseline, provenance: otherProvenance }),
            D1,
        );
        expect(() => loadDeploymentBaseline(db, D1)).toThrow(/not claimed/);
    });

    it("rejects mismatched active provenance/payload and foreign residuals", () => {
        const provenanceMismatch = successInput(D1, textPlan("a.md"));
        const current = provenanceMismatch.verifiedActiveFiles[0]!.provenance;
        const { provenanceFingerprint: _stored, ...preimage } = current;
        provenanceMismatch.verifiedActiveFiles[0]!.provenance = finalizeTargetFileRenderProvenance({
            ...preimage,
            appliedRenderSnapshotFingerprint: `sha256:${"d".repeat(64)}`,
        });
        expect(() => commitDeploymentSuccess(db, provenanceMismatch)).toThrow(/does not reference/);

        const payloadMismatch = successInput(D1, textPlan("b.md"));
        payloadMismatch.verifiedActiveFiles[0]!.appliedPayload.contentHash = `sha256:${"c".repeat(64)}`;
        expect(() => commitDeploymentSuccess(db, payloadMismatch)).toThrow(/does not match/);

        seedActiveFile(db, D1, "old.md");
        const foreign = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        const localResidual = residualFromCurrent(db, D1, "old.md", foreign.appliedRenderSnapshot.compilationFingerprint);
        foreign.newlyRemoved = [
            finalizeDeploymentResidualAuthority({
                schemaVersion: 1,
                deploymentId: D2,
                relativePath: localResidual.relativePath,
                appliedPayload: localResidual.appliedPayload,
                appliedExecutable: localResidual.appliedExecutable,
                previousProvenance: localResidual.previousProvenance,
                removalIntentFingerprint: localResidual.removalIntentFingerprint,
            }),
        ];
        expect(() => commitDeploymentSuccess(db, foreign)).toThrow(/another Deployment/);
    });

    it("allows the same content fingerprint under two distinct Deployment owners", () => {
        const input = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        const fingerprint = computeAppliedRenderSnapshotFingerprint(input.appliedRenderSnapshot);
        insertDeployment(db, makeDeploymentRow(D2));
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: fingerprint,
            deploymentId: D2,
            snapshotJson: serializeAppliedRenderSnapshot(input.appliedRenderSnapshot),
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
        });
        expect(() => commitDeploymentSuccess(db, input)).not.toThrow();
        expect(getDeploymentRenderSnapshot(db, D1, fingerprint)).not.toBeNull();
        expect(getDeploymentRenderSnapshot(db, D2, fingerprint)).not.toBeNull();
    });

    it("rejects the same snapshot key reopening to another body within one owner", () => {
        const input = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        const fingerprint = computeAppliedRenderSnapshotFingerprint(input.appliedRenderSnapshot);
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: fingerprint,
            deploymentId: D1,
            snapshotJson: '{"schemaVersion":1,"snapshotState":"never"}',
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
        });
        expect(() => commitDeploymentSuccess(db, input)).toThrow(/different authority body/);
        expect(getDeployment(db, D1)?.committedTransactionId).toBe("");
    });

    it("rejects a residual ID that reopens to a different immutable body", () => {
        seedActiveFile(db, D1, "old.md");
        const input = successInput(D1, { schemaVersion: 1, targetFiles: [] });
        const residual = residualFromCurrent(db, D1, "old.md", input.appliedRenderSnapshot.compilationFingerprint);
        input.newlyRemoved = [residual];
        insertDeploymentResidualAuthority(db, {
            residualAuthorityId: residual.residualAuthorityId,
            deploymentId: D1,
            relativePath: "old.md",
            authorityBody: JSON.stringify({
                schemaVersion: 1,
                appliedPayload: {
                    ...residual.appliedPayload,
                    byteSize: residual.appliedPayload.byteSize + 1,
                },
                appliedExecutable: residual.appliedExecutable,
                previousProvenance: residual.previousProvenance,
                removalIntentFingerprint: residual.removalIntentFingerprint,
            }),
            residualAuthorityFingerprint: residual.residualAuthorityFingerprint,
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
        });
        expect(() => commitDeploymentSuccess(db, input)).toThrow(/different authority body/);
        expect(getDeployment(db, D1)?.committedTransactionId).toBe("");
    });
});

describe("state-ops sequence", () => {
    it("commits only after a free probe; a busy probe leaves the deployment untouched", () => {
        const db = freshDb();
        insertDeployment(db, makeDeploymentRow(D1));
        let handle = beginDeploymentProbeTx(db);
        expect(findActivePathOccupiers(db, "linux", "/root", ["a.md"], D1)).toBeNull();
        handle.commit();
        commitDeploymentSuccess(db, successInput(D1, textPlan("a.md")));
        expect(getDeployment(db, D1)?.committedTransactionId).toBe(TXN1);

        insertDeployment(db, makeDeploymentRow(D2));
        seedActiveFile(db, D2, "a.md");
        handle = beginDeploymentProbeTx(db);
        expect(findActivePathOccupiers(db, "linux", "/root", ["a.md"], D1)).not.toBeNull();
        handle.rollback();
        expect(getDeployment(db, D2)?.committedTransactionId).toBe("");
    });
});
