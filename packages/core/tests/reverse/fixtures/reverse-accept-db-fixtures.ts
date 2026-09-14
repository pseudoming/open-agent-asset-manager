import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
    finalizeDeploymentResidualAuthority,
    makeRemovalIntentFingerprint,
    parseDeploymentFileBaselineState,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
} from "../../../src/render/deployment-render-authority";
import type { DeploymentSuccessCommitInputV1 } from "../../../src/deployment/deployment-state-ops";
import { computeAppliedRenderSnapshotFingerprint } from "../../../src/foundation/fingerprint";
import {
    getDeploymentFile,
    insertDeployment,
    insertDeploymentRenderSnapshot,
    updateDeployment,
    upsertDeploymentFile,
    type DeploymentRow,
} from "../../../src/persistence/state-db";
import type { TargetPlan } from "../../../src/deployment/deployment-target-plan";
import { makeExecutionAuthority, shaBytes, targetBytes } from "../../deployment/fixtures/deployment-authority-fixtures";

const SCHEMA_PATH = path.resolve(__dirname, "../../../schema/schema.sql");

export const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000001";
export const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";

export function initializeStateDatabase(databasePath: string): void {
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    db.close();
}

export function seedDeployment(databasePath: string, overrides: Partial<DeploymentRow> = {}): void {
    const db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    insertDeployment(db, makeDeploymentRow(overrides));
    db.close();
}

export function makeDeploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
    return {
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: "/root",
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${DEPLOYMENT_ID}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: emptyBlockingEvidenceJson(),
        deleted: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides,
    };
}

export function emptyBlockingEvidenceJson(): string {
    return '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}';
}

export function textPlan(relativePath: string, text = "# rendered", executable = false): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: [],
        targetFiles: [
            {
                relativePath,
                content: { contentKind: "text", text },
                executable,
                renderedSectionIds: [],
            },
        ],
    };
}

export function makeSuccessInput(
    plan: TargetPlan = { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] },
    transactionId = TRANSACTION_ID,
): DeploymentSuccessCommitInputV1 {
    const authority = makeExecutionAuthority(plan);
    return {
        deploymentId: DEPLOYMENT_ID,
        transactionId,
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [],
        },
        appliedRenderSnapshot: authority.appliedRenderSnapshot,
        verifiedActiveFiles: plan.targetFiles.map((file) => {
            const bytes = targetBytes(plan, file.relativePath);
            const contentHash = shaBytes(bytes);
            const provenance = authority.targetFileProvenance.find(
                (candidate) => candidate.relativePath === file.relativePath,
            )?.provenance;
            if (provenance === undefined) throw new Error("fixture provenance missing");
            return {
                verified: {
                    relativePath: file.relativePath,
                    appliedContentHash: contentHash,
                    appliedExecutable: file.executable,
                    observedState: "present" as const,
                    observedContentHash: contentHash,
                    observedExecutable: file.executable,
                },
                appliedPayload: {
                    contentKind: file.content.contentKind,
                    contentHash,
                    byteSize: bytes.byteLength,
                },
                provenance,
            };
        }),
        newlyRemoved: [],
        now: 9_000,
    };
}

export function seedActiveFile(databasePath: string, relativePath: string, text = "# baseline"): void {
    const db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    const plan = textPlan(relativePath, text);
    const authority = makeExecutionAuthority(plan);
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(authority.appliedRenderSnapshot);
    insertDeploymentRenderSnapshot(db, {
        snapshotFingerprint,
        deploymentId: DEPLOYMENT_ID,
        snapshotJson: serializeAppliedRenderSnapshot(authority.appliedRenderSnapshot),
        deleted: 0,
        createdAt: 4_000,
        updatedAt: 4_000,
    });
    updateDeployment(
        db,
        DEPLOYMENT_ID,
        {
            appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                snapshotState: "applied",
                snapshotFingerprint,
            }),
        },
        4_000,
    );
    const bytes = targetBytes(plan, relativePath);
    const contentHash = shaBytes(bytes);
    const provenance = authority.targetFileProvenance[0]?.provenance;
    if (provenance === undefined) throw new Error("fixture provenance missing");
    upsertDeploymentFile(
        db,
        DEPLOYMENT_ID,
        relativePath,
        serializeDeploymentFileBaselineState({
            rowState: "active",
            appliedPayload: { contentKind: "text", contentHash, byteSize: bytes.length },
            appliedExecutable: false,
            provenance,
        }),
        "present",
        contentHash,
        0,
        4_000,
        4_000,
    );
    db.close();
}

export function makeRemovalSuccessInput(
    databasePath: string,
    relativePath: string,
    transactionId = TRANSACTION_ID,
): DeploymentSuccessCommitInputV1 {
    const input = makeSuccessInput({ schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [] }, transactionId);
    const db = new Database(databasePath);
    const row = getDeploymentFile(db, DEPLOYMENT_ID, relativePath);
    db.close();
    if (row === null) throw new Error("removal fixture baseline missing");
    const baseline = parseDeploymentFileBaselineState(row.baselineState);
    if (baseline.rowState !== "active") throw new Error("removal fixture baseline not active");
    input.newlyRemoved = [
        finalizeDeploymentResidualAuthority({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            relativePath,
            appliedPayload: baseline.appliedPayload,
            appliedExecutable: baseline.appliedExecutable,
            previousProvenance: baseline.provenance,
            removalIntentFingerprint: makeRemovalIntentFingerprint({
                deploymentId: DEPLOYMENT_ID,
                relativePath,
                previousProvenanceFingerprint: baseline.provenance.provenanceFingerprint,
                nextCompilationFingerprint: input.appliedRenderSnapshot.compilationFingerprint,
                reason: "absent_from_new_desired_set",
            }),
        }),
    ];
    return input;
}
