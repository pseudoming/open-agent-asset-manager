import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthorityRow,
} from "../../src/render/deployment-render-authority";
import { executeDeploymentForTest, type DeployExecutorOptions } from "../../src/deployment/deployment-executor";
import { readDeploymentPayload } from "../../src/deployment/deployment-payload-store";
import { loadDeploymentBaseline } from "../../src/deployment/deployment-state-ops";
import {
    getDeploymentFile,
    getDeploymentRenderSnapshot,
    getDeploymentResidualAuthority,
    insertDeployment,
    listDeploymentResidualAuthorities,
    upsertDeploymentAsset,
    type DeploymentRow,
} from "../../src/persistence/state-db";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");
const D1 = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const V1 = "33333333-3333-4333-8333-333333333333";

function plan(...files: Array<[string, string]>): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: [],
        targetFiles: files.map(([relativePath, text]) => ({
            relativePath,
            content: { contentKind: "text" as const, text },
            executable: false,
            renderedSectionIds: [],
        })),
    };
}

describe("Deployment authority close/reopen lifecycle", () => {
    let cleanupRoot = "";
    afterEach(() => {
        if (cleanupRoot !== "") fs.rmSync(cleanupRoot, { recursive: true, force: true });
    });

    it("preserves S0→removed r1→unrelated→reactivated B→removed r2 history", () => {
        cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-deployment-reopen-"));
        const dbPath = path.join(cleanupRoot, "state.db");
        const targetRoot = path.join(cleanupRoot, "target");
        const transactionsRoot = path.join(cleanupRoot, "transactions");
        const deploymentsRoot = path.join(cleanupRoot, "deployments");
        fs.mkdirSync(targetRoot);
        fs.mkdirSync(transactionsRoot);
        fs.mkdirSync(deploymentsRoot);
        let db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
        const row: DeploymentRow = {
            deploymentId: D1,
            consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: targetRoot,
            projectId: "",
            committedTransactionId: "",
            appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${D1}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
            appliedRenderSnapshotRef: '{"snapshotState":"never"}',
            observationState: "never",
            observationAttemptedAt: 0,
            lastCompleteObservationAt: 0,
            blockingEvidence:
                '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}',
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
        };
        insertDeployment(db, row);
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, 2);
        let now = 10;
        const opts = (): DeployExecutorOptions => ({
            targetExecution: localTargetTransactions,
            db,
            deploymentId: D1,
            transactionsRoot,
            deploymentsRoot,
            now: () => ++now,
        });
        const run = (targetPlan: TargetPlan) =>
            executeDeploymentForTest(
                opts(),
                targetPlan,
                makeExecutionAuthority(targetPlan, {
                    deploymentId: D1,
                    assets: [{ assetId: A1, versionId: V1, allowIncomplete: false }],
                }),
                {},
            );

        expect(run(plan(["a.md", "A"])).outcome).toBe("committed");
        const activeA = parseDeploymentFileBaselineState(getDeploymentFile(db, D1, "a.md")!.baselineState);
        if (activeA.rowState !== "active") throw new Error("expected active A");

        expect(run(plan()).outcome).toBe("committed");
        const removed1 = parseDeploymentFileBaselineState(getDeploymentFile(db, D1, "a.md")!.baselineState);
        if (removed1.rowState !== "removed") throw new Error("expected removed r1");
        const r1 = removed1.latestResidualAuthorityId;

        expect(run(plan(["b.md", "unrelated"])).outcome).toBe("committed");
        expect(getDeploymentResidualAuthority(db, r1)).not.toBeNull();

        expect(run(plan(["a.md", "B"], ["b.md", "unrelated"])).outcome).toBe("committed");
        const activeB = parseDeploymentFileBaselineState(getDeploymentFile(db, D1, "a.md")!.baselineState);
        if (activeB.rowState !== "active") throw new Error("expected active B");
        expect(getDeploymentResidualAuthority(db, r1)).not.toBeNull();

        expect(run(plan(["b.md", "unrelated"])).outcome).toBe("committed");
        const removed2 = parseDeploymentFileBaselineState(getDeploymentFile(db, D1, "a.md")!.baselineState);
        if (removed2.rowState !== "removed") throw new Error("expected removed r2");
        const r2 = removed2.latestResidualAuthorityId;
        expect(r2).not.toBe(r1);
        expect(
            listDeploymentResidualAuthorities(db, D1)
                .map((item) => item.residualAuthorityId)
                .sort(),
        ).toEqual([r1, r2].sort());
        db.close();

        db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        expect(loadDeploymentBaseline(db, D1).map((item) => item.relativePath)).toEqual(["b.md"]);
        for (const residualId of [r1, r2]) {
            const stored = getDeploymentResidualAuthority(db, residualId)!;
            const residual = parseDeploymentResidualAuthorityRow({
                residualAuthorityId: stored.residualAuthorityId,
                residualAuthorityFingerprint: stored.residualAuthorityFingerprint as `sha256:${string}`,
                deploymentId: D1,
                relativePath: stored.relativePath,
                authorityBody: stored.authorityBody,
            });
            expect(
                getDeploymentRenderSnapshot(db, D1, residual.previousProvenance.appliedRenderSnapshotFingerprint),
            ).not.toBeNull();
            expect(
                Buffer.from(
                    readDeploymentPayload({
                        deploymentsRoot,
                        deploymentId: D1,
                        contentHash: residual.appliedPayload.contentHash,
                        expectedByteSize: residual.appliedPayload.byteSize,
                    }),
                ).toString(),
            ).toBe(residualId === r1 ? "A" : "B");
        }
        expect(activeA.appliedPayload.contentHash).not.toBe(activeB.appliedPayload.contentHash);
        db.close();
    });
});
