import { localTargetTransactions } from "../../../packages/core/src/deployment/local-target-transaction";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../../packages/core/src/catalog/version-authority";
import { executeDeployment, type DeployExecutorOptions } from "../../../packages/core/src/deployment/deployment-executor";
import { scanJournals } from "../../../packages/core/src/deployment/deployment-journal";
import { loadDeploymentBaseline } from "../../../packages/core/src/deployment/deployment-state-ops";
import { sha256Bytes } from "../../../packages/core/src/foundation/crypto-bytes";
import { getDeployment, insertDeployment, upsertDeploymentAsset } from "../../../packages/core/src/persistence/state-db";
import { compileRenderDeployment, type ValidatedCompiledDeploymentPlan } from "../../../packages/core/src/render/render-compiler";
import { materializeRenderDeployment } from "../../../packages/core/src/render/render-materialization";
import type { Platform } from "../../../packages/core/src/types";
import {
    makeLifecycleFixture,
    materializeFixtureResult,
} from "../../../packages/core/tests/render/fixtures/render-lifecycle-fixtures";

/**
 * Local and restricted execution fixture. The fixture Provider supplies materialization; Core still
 * analyzes, resolves selection, validates, compiles and executes an opaque plan.
 * This proves executor behavior, not an AgentRuntime's loading capability or a
 * complete Desktop/prepare/action-guard journey.
 */
export async function createExecutorComparisonFixture(input: {
    stateRoot: string;
    targetRoot: string;
    schemaPath: string;
    platform: Platform;
    platformInstanceId: string;
}) {
    // These must be new, exact roots allocated by the owning test host. Keeping
    // all files after close makes failed and successful samples inspectable.
    fs.mkdirSync(input.stateRoot, { recursive: false });
    fs.mkdirSync(input.targetRoot, { recursive: false, mode: 0o700 });
    const databasePath = path.join(input.stateRoot, "index.db");
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(input.schemaPath, "utf8"));
    const deploymentId = crypto.randomUUID();
    const renderRoot = path.join(input.stateRoot, "render");
    fs.mkdirSync(renderRoot);
    const fixture = await makeLifecycleFixture(renderRoot, {
        deploymentOverrides: {
            deploymentId,
            platform: input.platform,
            platformInstanceId: input.platformInstanceId,
            targetRootPath: input.targetRoot,
        },
    }).catch((error: unknown) => {
        db.close();
        throw error;
    });
    const appliedInputsSnapshot = {
        schemaVersion: 1 as const,
        deploymentId,
        consumerAgentRuntimeIds: [...fixture.deployment.consumerAgentRuntimeIds],
        assets: fixture.deployment.assets.map((asset) => ({
            assetId: asset.version.ref.assetId,
            versionId: asset.version.ref.versionId,
            allowIncomplete: asset.allowIncomplete,
        })),
    };
    insertDeployment(db, {
        deploymentId,
        platform: input.platform,
        platformInstanceId: input.platformInstanceId,
        targetRootPath: input.targetRoot,
        projectId: "",
        committedTransactionId: "",
        consumerAgentRuntimeIds: JSON.stringify(appliedInputsSnapshot.consumerAgentRuntimeIds),
        appliedInputsSnapshot: JSON.stringify({ ...appliedInputsSnapshot, assets: [] }),
        appliedRenderSnapshotRef: JSON.stringify({ snapshotState: "never" }),
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: JSON.stringify({
            schemaVersion: 1,
            reasonCode: "",
            operation: "",
            contextFingerprint: "",
            occurredAt: 0,
            diagnostics: [],
            suggestedActions: [],
            retryable: false,
        }),
        deleted: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    for (const [index, asset] of appliedInputsSnapshot.assets.entries()) {
        upsertDeploymentAsset(db, deploymentId, asset.assetId, asset.versionId, index, asset.allowIncomplete ? 1 : 0, Date.now());
    }
    const transactionsRoot = path.join(input.stateRoot, "transactions");
    const deploymentsRoot = path.join(input.stateRoot, "deployments");
    fs.mkdirSync(transactionsRoot);
    fs.mkdirSync(deploymentsRoot);
    const opts: DeployExecutorOptions = {
        targetExecution: localTargetTransactions,
        db,
        transactionsRoot,
        deploymentsRoot,
        deploymentId,
        now: Date.now,
    };

    async function compile(text: string): Promise<ValidatedCompiledDeploymentPlan> {
        const materialized = await materializeRenderDeployment(
            { deployment: fixture.deployment, analysis: fixture.analysis, selection: fixture.selection },
            {
                registry: fixture.registry,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                resolveDialectInputs: () => [],
                dispatch: async (_adapterId, request) => ({
                    status: "complete",
                    value: materializeFixtureResult(request, (file) => {
                        file.content = { contentKind: "text", text };
                    }),
                    diagnostics: [],
                }),
            },
        );
        assert.equal(materialized.status, "complete", JSON.stringify(materialized.diagnostics));
        if (materialized.status !== "complete") throw new Error("comparison materialization failed");
        const compiled = compileRenderDeployment({
            deployment: fixture.deployment,
            analysis: fixture.analysis,
            selection: fixture.selection,
            materialization: materialized.value,
            appliedInputsSnapshot,
        });
        assert.equal(compiled.status, "complete", JSON.stringify(compiled.diagnostics));
        if (compiled.status !== "complete") throw new Error("comparison compilation failed");
        return compiled.value;
    }

    function execute(plan: ValidatedCompiledDeploymentPlan, expectedText: string) {
        const expectedHash = sha256Bytes(Buffer.from(expectedText, "utf8"));
        const beforeTransactionId = getDeployment(db, deploymentId)!.committedTransactionId;
        const started = performance.now();
        const result = executeDeployment(opts, plan);
        assert.equal(result.outcome, "committed", JSON.stringify(result));
        const deployment = getDeployment(db, deploymentId)!;
        const baseline = loadDeploymentBaseline(db, deploymentId);
        const target = readRegularFileNoFollow(path.join(input.targetRoot, "AGENTS.md"));
        const targetBytes = target.bytes;
        const journals = scanJournals(transactionsRoot, deploymentId);
        assert.equal(deployment.committedTransactionId, result.transactionId);
        assert.notEqual(deployment.committedTransactionId, beforeTransactionId);
        assert.equal(baseline.length, 1);
        assert.equal(baseline[0]!.baselineState.appliedExecutable, false);
        assert.equal(baseline[0]!.observedContentHash, expectedHash);
        assert.equal(baseline[0]!.observedExecutable, 0);
        assert.equal(sha256Bytes(targetBytes), expectedHash);
        assert.equal(target.executable, false);
        assert.deepEqual(journals, { matchingTxnIds: [], corruptTxnIds: [] });
        const elapsedMilliseconds = performance.now() - started;
        return {
            endpoint: "executeDeployment-through-durable-commit-and-readback" as const,
            elapsedMilliseconds,
            beforeTransactionId,
            transactionId: result.transactionId,
            targetHash: expectedHash,
            targetBytes: targetBytes.byteLength,
            targetExecutable: target.executable,
            baseline,
            diagnostics: result.diagnostics,
        };
    }

    return {
        db,
        databasePath,
        opts,
        deploymentId,
        compile,
        execute,
        close() {
            db.pragma("wal_checkpoint(FULL)");
            db.close();
        },
    };
}
