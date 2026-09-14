/**
 * State DB DAO tests (Step 6 / Phase 13).
 *
 * Covers UPSERT semantics (preserve id/createdAt, restore deleted),
 * FK RESTRICT, partial UNIQUE sortOrder, soft-delete/recovery,
 * current_asset_index projection, FTS rebuild, deterministic ID stability,
 * and all exported DAO functions.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
    insertDeployment,
    getDeployment,
    listDeployments,
    updateDeployment,
    softDeleteDeployment,
    upsertDeploymentAsset,
    getDeploymentAsset,
    softDeleteDeploymentAsset,
    reassignSortOrders,
    listDeploymentAssets,
    upsertDeploymentFile,
    getDeploymentFile,
    listDeploymentFiles,
    softDeleteDeploymentFile,
    upsertCurrentAssetIndex,
    getCurrentAssetIndex,
    listCurrentAssetIndex,
    deleteCurrentAssetIndex,
    deleteAssetsFts,
    upsertProjectIndex,
    listProjectIndex,
    deleteProjectIndex,
    clearAssetsFts,
    insertAssetsFts,
    queryAssetsFts,
    insertDeploymentRenderSnapshot,
    getDeploymentRenderSnapshot,
    listDeploymentRenderSnapshots,
    insertDeploymentResidualAuthority,
    getDeploymentResidualAuthority,
    listDeploymentResidualAuthorities,
} from "../../src/persistence/state-db";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");

function freshDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    return db;
}

const NOW = 1000;
const D1 = "00000000-0000-4000-8000-000000000001";
const D2 = "00000000-0000-4000-8000-000000000002";
const A1 = "00000000-0000-4000-8000-000000000010";
const A2 = "00000000-0000-4000-8000-000000000011";
const A3 = "00000000-0000-4000-8000-000000000012";
const V1 = "00000000-0000-4000-8000-000000000020";
const SHA = `sha256:${"a".repeat(64)}`;
const ACTIVE_BASELINE = JSON.stringify({
    rowState: "active",
    appliedPayload: { contentKind: "text", contentHash: SHA, byteSize: 1 },
    appliedExecutable: false,
    provenance: { testOnly: true },
});

function baseDeploymentRow(id = D1, overrides: Record<string, unknown> = {}) {
    return {
        deploymentId: id,
        consumerAgentRuntimeIds: '["ANTIGRAVITY_CLI"]',
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: "/tmp",
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: JSON.stringify({
            schemaVersion: 1,
            deploymentId: id,
            consumerAgentRuntimeIds: [],
            assets: [],
        }),
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: "{}",
        deleted: 0,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

// ============================================================
// deployments DAO
// ============================================================

describe("deployments DAO", () => {
    it("insertDeployment + getDeployment", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        const row = getDeployment(db, D1);
        expect(row).not.toBeNull();
        expect(row!.consumerAgentRuntimeIds).toBe('["ANTIGRAVITY_CLI"]');
        db.close();
    });

    it("getDeployment returns null for missing", () => {
        const db = freshDb();
        expect(getDeployment(db, D1)).toBeNull();
        db.close();
    });

    it("listDeployments excludes deleted by default", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow(D1));
        insertDeployment(db, baseDeploymentRow(D2));
        softDeleteDeployment(db, D1, NOW + 1);
        const active = listDeployments(db);
        expect(active).toHaveLength(1);
        expect(active[0].deploymentId).toBe(D2);
        const all = listDeployments(db, true);
        expect(all).toHaveLength(2);
        db.close();
    });

    it("updateDeployment updates only specified fields + bumps updatedAt", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        updateDeployment(
            db,
            D1,
            { observationState: "complete", observationAttemptedAt: NOW + 100, lastCompleteObservationAt: NOW + 100 },
            NOW + 100,
        );
        const row = getDeployment(db, D1);
        expect(row!.observationState).toBe("complete");
        expect(row!.updatedAt).toBe(NOW + 100);
        expect(row!.consumerAgentRuntimeIds).toBe('["ANTIGRAVITY_CLI"]');
        db.close();
    });

    it("updateDeployment is no-op when no fields to update", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        updateDeployment(db, D1, {}, NOW + 100);
        const row = getDeployment(db, D1);
        expect(row!.updatedAt).toBe(NOW); // not bumped
        db.close();
    });

    it("softDeleteDeployment sets deleted=1 + bumps updatedAt", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        softDeleteDeployment(db, D1, NOW + 50);
        const row = getDeployment(db, D1);
        expect(row!.deleted).toBe(1);
        expect(row!.updatedAt).toBe(NOW + 50);
        db.close();
    });
});

// ============================================================
// deployment_assets: UPSERT + query + soft-delete
// ============================================================

describe("deployment_assets DAO", () => {
    it("upsert preserves deployment_asset_id and created_at on re-upsert", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW);
        const first = db.prepare("SELECT * FROM deployment_assets WHERE deployment_id = ? AND asset_id = ?").get(D1, A1) as {
            deployment_asset_id: string;
            created_at: number;
            version_id: string;
        };
        upsertDeploymentAsset(db, D1, A1, "new-version", 2, 1, NOW + 100);
        const second = db.prepare("SELECT * FROM deployment_assets WHERE deployment_id = ? AND asset_id = ?").get(D1, A1) as {
            deployment_asset_id: string;
            created_at: number;
            version_id: string;
            sort_order: number;
            allow_incomplete: number;
            deleted: number;
        };
        expect(second.deployment_asset_id).toBe(first.deployment_asset_id);
        expect(second.created_at).toBe(first.created_at);
        expect(second.version_id).toBe("new-version");
        expect(second.sort_order).toBe(2);
        expect(second.allow_incomplete).toBe(1);
        expect(second.deleted).toBe(0);
        db.close();
    });

    it("upsert restores deleted=0 on re-upsert", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW);
        softDeleteDeploymentAsset(db, D1, A1, NOW + 50);
        expect(getDeploymentAsset(db, D1, A1)!.deleted).toBe(1);
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW + 100);
        expect(getDeploymentAsset(db, D1, A1)!.deleted).toBe(0);
        db.close();
    });

    it("getDeploymentAsset returns null for missing", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        expect(getDeploymentAsset(db, D1, A1)).toBeNull();
        db.close();
    });

    it("listDeploymentAssets ordered by sort_order, excludes deleted", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 5, 0, NOW);
        upsertDeploymentAsset(db, D1, A2, V1, 3, 0, NOW + 1);
        softDeleteDeploymentAsset(db, D1, A2, NOW + 2);
        const active = listDeploymentAssets(db, D1);
        expect(active).toHaveLength(1);
        expect(active[0].assetId).toBe(A1);
        const all = listDeploymentAssets(db, D1, true);
        expect(all).toHaveLength(2);
        // ordered by sort_order asc: A2(3) before A1(5)
        expect(all[0].assetId).toBe(A2);
        expect(all[1].assetId).toBe(A1);
        db.close();
    });

    it("FK RESTRICT: cannot delete parent with active child", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW);
        expect(() => db.prepare("DELETE FROM deployments WHERE deployment_id = ?").run(D1)).toThrow();
        db.close();
    });

    it("partial UNIQUE: active sortOrder collision rejected, soft-deleted exempt", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 5, 0, NOW);
        expect(() => upsertDeploymentAsset(db, D1, A2, V1, 5, 0, NOW)).toThrow();
        // soft-delete A1 then A2 at same sortOrder is OK (partial unique only active rows)
        softDeleteDeploymentAsset(db, D1, A1, NOW + 1);
        expect(() => upsertDeploymentAsset(db, D1, A2, V1, 5, 0, NOW + 2)).not.toThrow();
        db.close();
    });
});

// ============================================================
// reassignSortOrders
// ============================================================

describe("reassignSortOrders", () => {
    it("assigns oldMax+1...oldMax+n in desired order", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW);
        upsertDeploymentAsset(db, D1, A2, V1, 3, 0, NOW + 1);
        upsertDeploymentAsset(db, D1, A3, V1, 5, 0, NOW + 2);
        const versionMap = new Map([
            [A1, { versionId: V1, allowIncomplete: 0 }],
            [A2, { versionId: V1, allowIncomplete: 0 }],
            [A3, { versionId: V1, allowIncomplete: 0 }],
        ]);
        reassignSortOrders(db, D1, [A3, A1, A2], versionMap, NOW + 100);
        const rows = listDeploymentAssets(db, D1);
        expect(rows[0].assetId).toBe(A3);
        expect(rows[0].sortOrder).toBe(6);
        expect(rows[1].assetId).toBe(A1);
        expect(rows[1].sortOrder).toBe(7);
        expect(rows[2].assetId).toBe(A2);
        expect(rows[2].sortOrder).toBe(8);
        db.close();
    });

    it("throws if versionMap missing an asset", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW);
        const incompleteMap = new Map([[A2, { versionId: V1, allowIncomplete: 0 }]]);
        expect(() => reassignSortOrders(db, D1, [A1], incompleteMap, NOW + 100)).toThrow(/missing versionId/);
        db.close();
    });
});

// ============================================================
// deployment_files DAO
// ============================================================

describe("deployment_files DAO", () => {
    it("upsert preserves id + createdAt, updates fields", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentFile(db, D1, "AGENTS.md", ACTIVE_BASELINE, "present", SHA, 0, NOW, NOW);
        const first = db
            .prepare("SELECT * FROM deployment_files WHERE deployment_id = ? AND relative_path = ?")
            .get(D1, "AGENTS.md") as {
            deployment_file_id: string;
            created_at: number;
        };
        const updatedBaseline = JSON.stringify({ ...JSON.parse(ACTIVE_BASELINE), appliedExecutable: true });
        upsertDeploymentFile(db, D1, "AGENTS.md", updatedBaseline, "present", SHA, 1, NOW + 100, NOW + 100);
        const second = db
            .prepare("SELECT * FROM deployment_files WHERE deployment_id = ? AND relative_path = ?")
            .get(D1, "AGENTS.md") as {
            deployment_file_id: string;
            created_at: number;
            baseline_state: string;
            deleted: number;
        };
        expect(second.deployment_file_id).toBe(first.deployment_file_id);
        expect(second.created_at).toBe(first.created_at);
        expect(JSON.parse(second.baseline_state).appliedExecutable).toBe(true);
        expect(second.deleted).toBe(0);
        db.close();
    });

    it("getDeploymentFile returns null for missing", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        expect(getDeploymentFile(db, D1, "nope.md")).toBeNull();
        db.close();
    });

    it("listDeploymentFiles ordered by relative_path, excludes deleted", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentFile(db, D1, "z.md", ACTIVE_BASELINE, "present", SHA, 0, NOW, NOW);
        upsertDeploymentFile(db, D1, "a.md", ACTIVE_BASELINE, "present", SHA, 0, NOW, NOW);
        softDeleteDeploymentFile(db, D1, "a.md", NOW + 1);
        const active = listDeploymentFiles(db, D1);
        expect(active).toHaveLength(1);
        expect(active[0].relativePath).toBe("z.md");
        const all = listDeploymentFiles(db, D1, true);
        expect(all).toHaveLength(2);
        expect(all[0].relativePath).toBe("a.md");
        db.close();
    });

    it("FK RESTRICT: cannot delete parent with active file", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentFile(db, D1, "AGENTS.md", ACTIVE_BASELINE, "missing", "", 0, NOW, NOW);
        expect(() => db.prepare("DELETE FROM deployments WHERE deployment_id = ?").run(D1)).toThrow();
        db.close();
    });
});

describe("immutable Deployment snapshot/residual DAO", () => {
    it("inserts, reopens, lists, and leaves same-key conflict classification to the authority facade", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: SHA,
            deploymentId: D1,
            snapshotJson: '{"schemaVersion":1,"snapshotState":"applied"}',
            deleted: 0,
            createdAt: NOW,
            updatedAt: NOW,
        });
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: SHA,
            deploymentId: D1,
            snapshotJson: '{"different":true}',
            deleted: 0,
            createdAt: NOW + 1,
            updatedAt: NOW + 1,
        });
        expect(getDeploymentRenderSnapshot(db, D1, SHA)?.snapshotJson).toContain("snapshotState");
        expect(listDeploymentRenderSnapshots(db, D1)).toHaveLength(1);

        insertDeployment(db, { ...baseDeploymentRow(), deploymentId: D2 });
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint: SHA,
            deploymentId: D2,
            snapshotJson: '{"schemaVersion":1,"snapshotState":"applied"}',
            deleted: 0,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(getDeploymentRenderSnapshot(db, D2, SHA)).not.toBeNull();

        insertDeploymentResidualAuthority(db, {
            residualAuthorityId: SHA,
            deploymentId: D1,
            relativePath: "old.md",
            authorityBody: '{"schemaVersion":1}',
            residualAuthorityFingerprint: SHA,
            deleted: 0,
            createdAt: NOW,
            updatedAt: NOW,
        });
        expect(getDeploymentResidualAuthority(db, SHA)?.relativePath).toBe("old.md");
        expect(listDeploymentResidualAuthorities(db, D1)).toHaveLength(1);
        expect(getDeploymentResidualAuthority(db, `sha256:${"b".repeat(64)}`)).toBeNull();
        db.close();
    });
});

// ============================================================
// current_asset_index DAO
// ============================================================

describe("current_asset_index DAO", () => {
    it("upsert + get + list", () => {
        const db = freshDb();
        const row = {
            assetId: A1,
            kind: "Skill",
            scope: "project",
            projectId: D1,
            scopePath: "pkg",
            displayName: "my-skill",
            displayDescription: "",
            currentVersionId: V1,
            currentRevision: 1,
            currentFingerprint: SHA,
            currentVersionStatus: "complete",
            createdAt: NOW,
            updatedAt: NOW,
            deleted: 0,
        };
        upsertCurrentAssetIndex(db, row);
        const got = getCurrentAssetIndex(db, A1);
        expect(got!.displayName).toBe("my-skill");
        expect(listCurrentAssetIndex(db)).toHaveLength(1);
        db.close();
    });

    it("delete removes row", () => {
        const db = freshDb();
        const row = {
            assetId: A1,
            kind: "Skill",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "g",
            displayDescription: "",
            currentVersionId: V1,
            currentRevision: 1,
            currentFingerprint: SHA,
            currentVersionStatus: "complete",
            createdAt: NOW,
            updatedAt: NOW,
            deleted: 0,
        };
        upsertCurrentAssetIndex(db, row);
        deleteCurrentAssetIndex(db, A1);
        expect(getCurrentAssetIndex(db, A1)).toBeNull();
        db.close();
    });

    it("listCurrentAssetIndex excludes deleted by default", () => {
        const db = freshDb();
        const row = {
            assetId: A1,
            kind: "Skill",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "g",
            displayDescription: "",
            currentVersionId: V1,
            currentRevision: 1,
            currentFingerprint: SHA,
            currentVersionStatus: "complete",
            createdAt: NOW,
            updatedAt: NOW,
            deleted: 1,
        };
        upsertCurrentAssetIndex(db, row);
        expect(listCurrentAssetIndex(db)).toHaveLength(0);
        expect(listCurrentAssetIndex(db, true)).toHaveLength(1);
        db.close();
    });
});

// ============================================================
// project_index DAO
// ============================================================

describe("project_index DAO", () => {
    it("upsert + list + delete", () => {
        const db = freshDb();
        const row = { projectId: D1, rootPath: "/tmp/proj", displayName: "Proj", deleted: 0, createdAt: NOW, updatedAt: NOW };
        upsertProjectIndex(db, row);
        expect(listProjectIndex(db)).toHaveLength(1);
        deleteProjectIndex(db, D1);
        expect(listProjectIndex(db)).toHaveLength(0);
        db.close();
    });

    it("list excludes deleted", () => {
        const db = freshDb();
        const row = { projectId: D1, rootPath: "/p", displayName: "P", deleted: 1, createdAt: NOW, updatedAt: NOW };
        upsertProjectIndex(db, row);
        expect(listProjectIndex(db)).toHaveLength(0);
        expect(listProjectIndex(db, true)).toHaveLength(1);
        db.close();
    });
});

// ============================================================
// assets_fts DAO
// ============================================================

describe("assets_fts DAO", () => {
    it("clear + insert + query", () => {
        const db = freshDb();
        insertAssetsFts(db, A1, "my-skill", "A useful skill", "scripts/check.ts");
        insertAssetsFts(db, A2, "other", "desc", "other.md");
        const results = queryAssetsFts(db, "skill");
        expect(results.length).toBe(1);
        expect(results[0].assetId).toBe(A1);
        clearAssetsFts(db);
        expect(queryAssetsFts(db, "skill")).toHaveLength(0);
        db.close();
    });

    it("query with limit", () => {
        const db = freshDb();
        insertAssetsFts(db, A1, "skill one", "", "");
        insertAssetsFts(db, A2, "skill two", "", "");
        insertAssetsFts(db, A3, "skill three", "", "");
        const results = queryAssetsFts(db, "skill", 2);
        expect(results.length).toBe(2);
        db.close();
    });
});

describe("reassignSortOrders: empty deployment (no existing assets)", () => {
    it("assigns from 1 when no existing assets (oldMax = 0)", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        // No existing assets — oldMax query returns null → 0
        const versionMap = new Map([[A1, { versionId: V1, allowIncomplete: 0 }]]);
        reassignSortOrders(db, D1, [A1], versionMap, NOW + 100);
        const rows = listDeploymentAssets(db, D1);
        expect(rows[0].sortOrder).toBe(1); // oldMax(0) + 1
        db.close();
    });
});

// ============================================================
// Additional tests from subagent redteam/auditor findings
// ============================================================

describe("reassignSortOrders: restores soft-deleted row in same pass", () => {
    it("soft-deleted asset is restored and assigned new sortOrder", () => {
        const db = freshDb();
        insertDeployment(db, baseDeploymentRow());
        upsertDeploymentAsset(db, D1, A1, V1, 1, 0, NOW);
        upsertDeploymentAsset(db, D1, A2, V1, 3, 0, NOW + 1);
        // Soft-delete A1
        softDeleteDeploymentAsset(db, D1, A1, NOW + 2);
        // Reassign including A1 (restore) — oldMax includes deleted rows
        const versionMap = new Map([
            [A1, { versionId: V1, allowIncomplete: 0 }],
            [A2, { versionId: V1, allowIncomplete: 0 }],
        ]);
        reassignSortOrders(db, D1, [A1, A2], versionMap, NOW + 100);
        const rows = listDeploymentAssets(db, D1);
        // oldMax was 3 → new orders 4, 5; A1 restored (deleted=0)
        expect(rows).toHaveLength(2);
        expect(rows[0].assetId).toBe(A1);
        expect(rows[0].sortOrder).toBe(4);
        expect(rows[0].deleted).toBe(0);
        expect(rows[1].assetId).toBe(A2);
        expect(rows[1].sortOrder).toBe(5);
        db.close();
    });
});

describe("upsertCurrentAssetIndex: ON CONFLICT UPDATE path", () => {
    it("re-upsert overwrites all fields including created_at", () => {
        const db = freshDb();
        const row1 = {
            assetId: A1,
            kind: "Skill",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "old-name",
            displayDescription: "old-desc",
            currentVersionId: V1,
            currentRevision: 1,
            currentFingerprint: SHA,
            currentVersionStatus: "complete",
            createdAt: NOW,
            updatedAt: NOW,
            deleted: 0,
        };
        upsertCurrentAssetIndex(db, row1);
        // Re-upsert with different values
        const row2 = {
            assetId: A1,
            kind: "Rule",
            scope: "project",
            projectId: D1,
            scopePath: "pkg",
            displayName: "new-name",
            displayDescription: "new-desc",
            currentVersionId: V1,
            currentRevision: 2,
            currentFingerprint: SHA,
            currentVersionStatus: "incomplete",
            createdAt: NOW + 500,
            updatedAt: NOW + 500,
            deleted: 1,
        };
        upsertCurrentAssetIndex(db, row2);
        const got = getCurrentAssetIndex(db, A1)!;
        expect(got.displayName).toBe("new-name");
        expect(got.kind).toBe("Rule");
        expect(got.createdAt).toBe(NOW + 500); // derived: createdAt overwritten (not preserved)
        expect(got.deleted).toBe(1); // derived: deleted is manifest projection
        db.close();
    });
});

describe("upsertProjectIndex: ON CONFLICT UPDATE path", () => {
    it("re-upsert overwrites all fields", () => {
        const db = freshDb();
        const row1 = { projectId: D1, rootPath: "/old", displayName: "Old", deleted: 0, createdAt: NOW, updatedAt: NOW };
        upsertProjectIndex(db, row1);
        const row2 = {
            projectId: D1,
            rootPath: "/new",
            displayName: "New",
            deleted: 1,
            createdAt: NOW + 500,
            updatedAt: NOW + 500,
        };
        upsertProjectIndex(db, row2);
        const all = listProjectIndex(db, true);
        expect(all).toHaveLength(1);
        expect(all[0].rootPath).toBe("/new");
        expect(all[0].displayName).toBe("New");
        expect(all[0].createdAt).toBe(NOW + 500); // overwritten
        db.close();
    });
});

describe("deleteAssetsFts", () => {
    it("removes only the specified asset's FTS rows", () => {
        const db = freshDb();
        insertAssetsFts(db, A1, "skill-one", "", "");
        insertAssetsFts(db, A2, "skill-two", "", "");
        deleteAssetsFts(db, A1);
        const results = queryAssetsFts(db, "skill");
        expect(results).toHaveLength(1);
        expect(results[0].assetId).toBe(A2);
        db.close();
    });
});
