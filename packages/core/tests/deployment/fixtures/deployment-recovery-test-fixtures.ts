/** Shared deterministic fixtures for the split Deployment tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { recoverDeploymentForTest } from "../../../src/deployment/deployment-recovery";
import { deleteJournal, publishJournal, type ActiveJournal, type JournalEntry } from "../../../src/deployment/deployment-journal";
import { computePhysicalClosureKeys } from "../../../src/foundation/physical-path-locks";
import { createTargetIo, type TargetIoContext } from "../../../src/deployment/deployment-target-io";
import { getDeployment, insertDeployment, type DeploymentRow } from "../../../src/persistence/state-db";
import {
    insertDeploymentRenderSnapshot,
    insertDeploymentResidualAuthority,
    updateDeployment,
    upsertDeploymentFile,
} from "../../../src/persistence/state-db";
import type { TargetPlan } from "../../../src/deployment/deployment-target-plan";
import { makeExecutionAuthority, makeTestTargetPlan } from "./deployment-authority-fixtures";
import {
    finalizeDeploymentResidualAuthority,
    makeRemovalIntentFingerprint,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
    serializeDeploymentResidualAuthorityBody,
} from "../../../src/render/deployment-render-authority";
import { computeAppliedRenderSnapshotFingerprint } from "../../../src/foundation/fingerprint";
import { bytesToBase64, sha256Bytes } from "../../../src/foundation/crypto-bytes";

export const SCHEMA_PATH = path.resolve(__dirname, "../../../schema/schema.sql");

export const D1 = "00000000-0000-4000-8000-000000000001";

export const D2 = "00000000-0000-4000-8000-000000000002";

export const TXN_YES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const TXN_NO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function sha(s: string | Uint8Array): string {
    const buf = typeof s === "string" ? Buffer.from(s, "utf-8") : Buffer.from(s);
    return sha256Bytes(buf);
}

export const EMPTY_SHA = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function freshDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    return db;
}

export interface Harness {
    db: Database.Database;
    root: string;
    txnRoot: string;
    ctx: TargetIoContext;
    cleanup: () => void;
}

export function recoverDeployment(db: Database.Database, ctx: TargetIoContext, transactionsRoot: string, txnId: string) {
    return recoverDeploymentForTest(db, ctx, transactionsRoot, txnId, deleteJournal);
}

export function harness(committedTransactionId: string): Harness {
    const db = freshDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-rec-target-"));
    const txnRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-rec-txn-"));
    const row: DeploymentRow = {
        deploymentId: D1,
        consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: root,
        projectId: "",
        committedTransactionId,
        appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${D1}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "complete",
        observationAttemptedAt: 1_000,
        lastCompleteObservationAt: 1_000,
        blockingEvidence:
            '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}',
        deleted: 0,
        createdAt: 1000,
        updatedAt: 1000,
    };
    insertDeployment(db, row);
    return {
        db,
        root,
        txnRoot,
        ctx: createTargetIo(root),
        cleanup: () => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
            try {
                fs.rmSync(txnRoot, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        },
    };
}

export function b64(s: string): string {
    return bytesToBase64(Buffer.from(s, "utf-8"));
}

export function deployEntry(rel: string, oldContent: string, newContent: string): JournalEntry {
    return {
        relativePath: rel,
        oldHash: oldContent ? sha(oldContent) : "",
        oldBytesBase64: oldContent ? b64(oldContent) : "",
        oldExecutable: false,
        oldProvenanceFingerprint: "",
        oldMaterializationFingerprint: "",
        newHash: sha(newContent),
        newBytesBase64: b64(newContent),
        newExecutable: false,
        newProvenanceFingerprint: "",
        newMaterializationFingerprint: "",
        isRemoval: false,
    };
}

export function removalEntry(rel: string, oldContent: string): JournalEntry {
    return {
        relativePath: rel,
        oldHash: sha(oldContent),
        oldBytesBase64: b64(oldContent),
        oldExecutable: false,
        oldProvenanceFingerprint: "",
        oldMaterializationFingerprint: "",
        newHash: "",
        newBytesBase64: "",
        newExecutable: false,
        newProvenanceFingerprint: "",
        newMaterializationFingerprint: "",
        isRemoval: true,
    };
}

export function publish(h: Harness, txnId: string, entries: JournalEntry[]): void {
    const newPlan = planForJournalSide(entries, "new");
    const oldPlan = planForJournalSide(entries, "old");
    const newAuthority = makeExecutionAuthority(newPlan);
    const oldAuthority = makeExecutionAuthority(oldPlan);
    const commitYes = txnId === getDeployment(h.db, D1)?.committedTransactionId;
    const newSnapshotFingerprint = commitYes
        ? persistSnapshot(h.db, newAuthority.appliedRenderSnapshot)
        : computeAppliedRenderSnapshotFingerprint(newAuthority.appliedRenderSnapshot);
    const oldSnapshotFingerprint =
        oldPlan.targetFiles.length > 0 ? persistSnapshot(h.db, oldAuthority.appliedRenderSnapshot) : "";
    const enriched = entries.map((entry): JournalEntry => {
        const oldProvenance = oldAuthority.targetFileProvenance.find(
            (item) => item.relativePath === entry.relativePath,
        )?.provenance;
        const newProvenance = newAuthority.targetFileProvenance.find(
            (item) => item.relativePath === entry.relativePath,
        )?.provenance;
        return {
            ...entry,
            oldProvenanceFingerprint: oldProvenance?.provenanceFingerprint ?? "",
            oldMaterializationFingerprint: oldProvenance?.materializationFingerprint ?? "",
            newProvenanceFingerprint: newProvenance?.provenanceFingerprint ?? "",
            newMaterializationFingerprint: newProvenance?.materializationFingerprint ?? "",
        };
    });

    if (commitYes) {
        updateDeployment(
            h.db,
            D1,
            {
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint: newSnapshotFingerprint,
                }),
            },
            5_000,
        );
        for (const entry of enriched) {
            const newProvenance = newAuthority.targetFileProvenance.find(
                (item) => item.relativePath === entry.relativePath,
            )?.provenance;
            if (!entry.isRemoval && newProvenance !== undefined) {
                upsertDeploymentFile(
                    h.db,
                    D1,
                    entry.relativePath,
                    serializeDeploymentFileBaselineState({
                        rowState: "active",
                        appliedPayload: {
                            contentKind: "binary",
                            contentHash: entry.newHash as `sha256:${string}`,
                            byteSize: Buffer.from(entry.newBytesBase64, "base64").length,
                        },
                        appliedExecutable: entry.newExecutable,
                        provenance: newProvenance,
                    }),
                    "present",
                    entry.newHash,
                    entry.newExecutable ? 1 : 0,
                    5_000,
                    5_000,
                );
                continue;
            }
            const oldProvenance = oldAuthority.targetFileProvenance.find(
                (item) => item.relativePath === entry.relativePath,
            )?.provenance;
            if (oldProvenance === undefined) throw new Error("removal fixture requires old provenance");
            const residual = finalizeDeploymentResidualAuthority({
                schemaVersion: 1,
                deploymentId: D1,
                relativePath: entry.relativePath,
                appliedPayload: {
                    contentKind: "binary",
                    contentHash: entry.oldHash as `sha256:${string}`,
                    byteSize: Buffer.from(entry.oldBytesBase64, "base64").length,
                },
                appliedExecutable: entry.oldExecutable,
                previousProvenance: oldProvenance,
                removalIntentFingerprint: makeRemovalIntentFingerprint({
                    deploymentId: D1,
                    relativePath: entry.relativePath,
                    previousProvenanceFingerprint: oldProvenance.provenanceFingerprint,
                    nextCompilationFingerprint: newAuthority.appliedRenderSnapshot.compilationFingerprint,
                    reason: "absent_from_new_desired_set",
                }),
            });
            insertDeploymentResidualAuthority(h.db, {
                residualAuthorityId: residual.residualAuthorityId,
                deploymentId: D1,
                relativePath: entry.relativePath,
                authorityBody: serializeDeploymentResidualAuthorityBody(residual),
                residualAuthorityFingerprint: residual.residualAuthorityFingerprint,
                deleted: 0,
                createdAt: 5_000,
                updatedAt: 5_000,
            });
            upsertDeploymentFile(
                h.db,
                D1,
                entry.relativePath,
                serializeDeploymentFileBaselineState({
                    rowState: "removed",
                    latestResidualAuthorityId: residual.residualAuthorityId,
                }),
                "missing",
                "",
                0,
                5_000,
                5_000,
            );
        }
    } else if (oldSnapshotFingerprint !== "") {
        updateDeployment(
            h.db,
            D1,
            {
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint: oldSnapshotFingerprint as `sha256:${string}`,
                }),
            },
            5_000,
        );
        for (const entry of enriched) {
            if (entry.oldHash === "") continue;
            const provenance = oldAuthority.targetFileProvenance.find(
                (item) => item.relativePath === entry.relativePath,
            )?.provenance;
            if (provenance === undefined) throw new Error("old fixture provenance missing");
            upsertDeploymentFile(
                h.db,
                D1,
                entry.relativePath,
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
                "present",
                entry.oldHash,
                entry.oldExecutable ? 1 : 0,
                5_000,
                5_000,
            );
        }
    }
    publishJournal(h.txnRoot, {
        schemaVersion: 1,
        transactionId: txnId,
        deploymentId: D1,
        createdAt: 5000,
        compilationFingerprint: newAuthority.appliedRenderSnapshot.compilationFingerprint,
        reservedPhysicalKeys: computePhysicalClosureKeys(
            "linux",
            h.root,
            enriched.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
            })),
        ),
        entries: enriched,
    } as ActiveJournal);
}

export function writeFile(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

export function read(root: string, rel: string): string {
    return fs.readFileSync(path.join(root, rel), "utf-8");
}

export function exists(root: string, rel: string): boolean {
    return fs.existsSync(path.join(root, rel));
}

export function planForJournalSide(entries: JournalEntry[], side: "old" | "new"): TargetPlan {
    return makeTestTargetPlan(
        entries
            .filter((entry) => (side === "old" ? entry.oldHash !== "" : !entry.isRemoval))
            .map((entry) => ({
                relativePath: entry.relativePath,
                content: {
                    contentKind: "binary" as const,
                    bytes: new Uint8Array(Buffer.from(side === "old" ? entry.oldBytesBase64 : entry.newBytesBase64, "base64")),
                },
                executable: side === "old" ? entry.oldExecutable : entry.newExecutable,
            })),
    );
}

export function persistSnapshot(
    db: Database.Database,
    snapshot: ReturnType<typeof makeExecutionAuthority>["appliedRenderSnapshot"],
): `sha256:${string}` {
    const fingerprint = computeAppliedRenderSnapshotFingerprint(snapshot);
    insertDeploymentRenderSnapshot(db, {
        snapshotFingerprint: fingerprint,
        deploymentId: D1,
        snapshotJson: serializeAppliedRenderSnapshot(snapshot),
        deleted: 0,
        createdAt: 5_000,
        updatedAt: 5_000,
    });
    return fingerprint;
}
