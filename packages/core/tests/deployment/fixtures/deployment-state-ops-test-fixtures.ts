/** Shared deterministic fixtures for the split Deployment tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { DeploymentResidualRenderAuthorityV1 } from "../../../src/contracts/deployment-authority";
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
    insertDeploymentRenderSnapshot,
    updateDeployment,
    upsertDeploymentFile,
    type DeploymentRow,
} from "../../../src/persistence/state-db";
import type { TargetPlan } from "../../../src/deployment/deployment-target-plan";
import { makeExecutionAuthority, shaBytes, targetBytes } from "./deployment-authority-fixtures";

export const SCHEMA_PATH = path.resolve(__dirname, "../../../schema/schema.sql");

export const D1 = "00000000-0000-4000-8000-000000000001";

export const D2 = "00000000-0000-4000-8000-000000000002";

export const TXN1 = "11111111-1111-4111-8111-111111111111";

export const TXN2 = "22222222-2222-4222-8222-222222222222";

export function freshDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    return db;
}

export function makeDeploymentRow(deploymentId: string, overrides: Partial<DeploymentRow> = {}): DeploymentRow {
    return {
        deploymentId,
        consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: "/root",
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${deploymentId}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: emptyBlockingEvidence(),
        deleted: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides,
    };
}

export function emptyBlockingEvidence(): string {
    return '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}';
}

export function textPlan(relativePath: string, text = "# baseline", executable = false): TargetPlan {
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

export function seedActiveFile(
    db: Database.Database,
    deploymentId: string,
    relativePath: string,
    text = "# baseline",
    executable = false,
): void {
    const plan = textPlan(relativePath, text, executable);
    const authority = makeExecutionAuthority(plan);
    const fingerprint = computeAppliedRenderSnapshotFingerprint(authority.appliedRenderSnapshot);
    insertDeploymentRenderSnapshot(db, {
        snapshotFingerprint: fingerprint,
        deploymentId,
        snapshotJson: serializeAppliedRenderSnapshot(authority.appliedRenderSnapshot),
        deleted: 0,
        createdAt: 4_000,
        updatedAt: 4_000,
    });
    updateDeployment(
        db,
        deploymentId,
        {
            appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                snapshotState: "applied",
                snapshotFingerprint: fingerprint,
            }),
        },
        4_000,
    );
    const bytes = targetBytes(plan, relativePath);
    const contentHash = shaBytes(bytes);
    const provenance = authority.targetFileProvenance[0]?.provenance;
    if (provenance === undefined) throw new Error("missing fixture provenance");
    upsertDeploymentFile(
        db,
        deploymentId,
        relativePath,
        serializeDeploymentFileBaselineState({
            rowState: "active",
            appliedPayload: { contentKind: "text", contentHash, byteSize: bytes.length },
            appliedExecutable: executable,
            provenance,
        }),
        "present",
        contentHash,
        executable ? 1 : 0,
        4_000,
        4_000,
    );
}

export function successInput(deploymentId: string, plan: TargetPlan, transactionId = TXN1): DeploymentSuccessCommitInputV1 {
    const authority = makeExecutionAuthority(plan);
    return {
        deploymentId,
        transactionId,
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [],
        },
        appliedRenderSnapshot: authority.appliedRenderSnapshot,
        verifiedActiveFiles: plan.targetFiles.map((file) => {
            const bytes = targetBytes(plan, file.relativePath);
            const contentHash = shaBytes(bytes);
            const provenance = authority.targetFileProvenance.find((item) => item.relativePath === file.relativePath)?.provenance;
            if (provenance === undefined) throw new Error("missing fixture provenance");
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
                    byteSize: bytes.length,
                },
                provenance,
            };
        }),
        newlyRemoved: [],
        now: 9_000,
    };
}

export function residualFromCurrent(
    db: Database.Database,
    deploymentId: string,
    relativePath: string,
    nextCompilationFingerprint: `sha256:${string}`,
): DeploymentResidualRenderAuthorityV1 {
    const row = getDeploymentFile(db, deploymentId, relativePath);
    if (row === null) throw new Error("missing baseline fixture");
    const baseline = parseDeploymentFileBaselineState(row.baselineState);
    if (baseline.rowState !== "active") throw new Error("fixture baseline is not active");
    return finalizeDeploymentResidualAuthority({
        schemaVersion: 1,
        deploymentId,
        relativePath,
        appliedPayload: baseline.appliedPayload,
        appliedExecutable: baseline.appliedExecutable,
        previousProvenance: baseline.provenance,
        removalIntentFingerprint: makeRemovalIntentFingerprint({
            deploymentId,
            relativePath,
            previousProvenanceFingerprint: baseline.provenance.provenanceFingerprint,
            nextCompilationFingerprint,
            reason: "absent_from_new_desired_set",
        }),
    });
}
