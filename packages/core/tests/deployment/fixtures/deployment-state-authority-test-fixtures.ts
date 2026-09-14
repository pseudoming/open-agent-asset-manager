/** Shared deterministic fixtures for the split Deployment tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach } from "vitest";
import {
    commitReverseAcceptSuccessCrashDurable,
    prepareDeploymentSuccessAuthority,
    readCanonicalDeploymentPreCommitDatabaseState,
} from "../../../src/deployment/deployment-state-authority";
import { computeDeploymentAssetId } from "../../../src/foundation/fingerprint";
import { getDeploymentFile } from "../../../src/persistence/state-db";
import {
    finalizeDeploymentResidualAuthority,
    finalizeTargetFileRenderProvenance,
    parseDeploymentFileBaselineState,
    serializeDeploymentFileBaselineState,
} from "../../../src/render/deployment-render-authority";
import {
    DEPLOYMENT_ID,
    initializeStateDatabase,
    makeRemovalSuccessInput,
    makeSuccessInput,
    seedActiveFile,
    seedDeployment,
} from "../../reverse/fixtures/reverse-accept-db-fixtures";

export const ASSET_ID = "22222222-2222-4222-8222-222222222222";

export const VERSION_ID = "33333333-3333-4333-8333-333333333333";

export interface MutablePreState {
    schemaVersion: unknown;
    deployment: Record<string, unknown>;
    deploymentAssets: Array<Record<string, unknown>>;
    deploymentFiles: Array<Record<string, unknown>>;
    residualAuthorities: Array<Record<string, unknown>>;
}

export interface MutablePostcondition {
    schemaVersion: unknown;
    deploymentId: unknown;
    commitTransactionId: unknown;
    deploymentObservationState: unknown;
    deploymentObservationAttemptedAt: unknown;
    deploymentLastCompleteObservationAt: unknown;
    deploymentBlockingEvidence: Record<string, unknown>;
    files: Array<Record<string, unknown>>;
    residualAuthorities: Array<Record<string, unknown>>;
}

export let root: string;

export let databasePath: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-validator-"));
    databasePath = path.join(root, "state.db");
    initializeStateDatabase(databasePath);
    seedDeployment(databasePath);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

export function mutablePreState(): MutablePreState {
    return readCanonicalDeploymentPreCommitDatabaseState(databasePath, DEPLOYMENT_ID) as unknown as MutablePreState;
}

export function mutablePostcondition(plan = { schemaVersion: 1 as const, managedDirectoryBoundaries: [], targetFiles: [] }) {
    const success = makeSuccessInput(plan);
    return prepareDeploymentSuccessAuthority(databasePath, success)
        .expectedSuccessPostcondition as unknown as MutablePostcondition;
}

export function validAsset(): Record<string, unknown> {
    return {
        deploymentAssetId: computeDeploymentAssetId(DEPLOYMENT_ID, ASSET_ID),
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        sortOrder: 0,
        allowIncomplete: false,
        deleted: false,
        createdAt: 1_000,
        updatedAt: 1_000,
    };
}

export function freshDatabase(name: string): string {
    const casePath = path.join(root, `${name}.db`);
    initializeStateDatabase(casePath);
    seedDeployment(casePath);
    return casePath;
}

export function freshRemovedDatabase(name: string): string {
    const casePath = freshDatabase(name);
    seedActiveFile(casePath, "removed.md");
    const removal = makeRemovalSuccessInput(casePath, "removed.md");
    commitReverseAcceptSuccessCrashDurable({
        databasePath: casePath,
        successCommit: removal,
        preparedAuthority: prepareDeploymentSuccessAuthority(casePath, removal),
    });
    return casePath;
}

export function rewriteFileProvenance(
    db: Database.Database,
    relativePath: string,
    mutate: (
        value: Omit<
            Extract<ReturnType<typeof parseDeploymentFileBaselineState>, { rowState: "active" }>["provenance"],
            "provenanceFingerprint"
        >,
    ) => Omit<
        Extract<ReturnType<typeof parseDeploymentFileBaselineState>, { rowState: "active" }>["provenance"],
        "provenanceFingerprint"
    >,
): void {
    const row = getDeploymentFile(db, DEPLOYMENT_ID, relativePath);
    if (row === null) throw new Error("fixture DeploymentFile missing");
    const baseline = parseDeploymentFileBaselineState(row.baselineState);
    if (baseline.rowState !== "active") throw new Error("fixture DeploymentFile removed");
    const { provenanceFingerprint: _provenanceFingerprint, ...preimage } = baseline.provenance;
    const provenance = finalizeTargetFileRenderProvenance(mutate(preimage));
    db.prepare("UPDATE deployment_files SET baseline_state=? WHERE deployment_id=? AND relative_path=?").run(
        serializeDeploymentFileBaselineState({
            ...baseline,
            provenance,
        }),
        DEPLOYMENT_ID,
        relativePath,
    );
}

export function makeForeignResidual(value: Record<string, unknown>): Record<string, unknown> {
    const {
        residualAuthorityId: _residualAuthorityId,
        residualAuthorityFingerprint: _residualAuthorityFingerprint,
        deploymentId: _deploymentId,
        ...preimage
    } = value;
    return finalizeDeploymentResidualAuthority({
        ...preimage,
        deploymentId: VERSION_ID,
    } as Parameters<typeof finalizeDeploymentResidualAuthority>[0]) as unknown as Record<string, unknown>;
}
