import type { Database } from "better-sqlite3";
import { computeDeploymentAssetId, computeDeploymentFileId } from "../foundation/fingerprint";

/**
 * State DB DAOs for the 5 business-state and 3 projection tables
 * (GLOBAL_DBA_REVIEW §4 + Phase 16 Stage P overlay).
 * Stage-R deployment_commit_receipts is intentionally owned by
 * deployment-commit-receipts.ts and is not exposed through this general DAO.
 *
 * Key contracts enforced:
 *  - UPSERT via INSERT ... ON CONFLICT(...) DO UPDATE (never INSERT OR REPLACE)
 *  - Mutable authoritative state tables (deployments / deployment_assets / deployment_files):
 *    UPSERT preserves id + created_at; restores deleted=0; refreshes updated_at
 *    Soft-delete preserves row data; restore via UPSERT (deleted → 0)
 *  - Immutable snapshot/residual tables use insert-if-absent; the deployment
 *    authority facade reopens and compares the exact body in the same tx.
 *  - Derived index tables (current_asset_index / project_index):
 *    Fully rebuildable projections; UPSERT overwrites all fields including
 *    created_at/deleted (they are manifest projections, not row lifecycle).
 *    Physical DELETE is used to remove stale projections (not soft-delete).
 *  - FTS (assets_fts): reindex-only (no triggers); clear + insert
 *  - Deterministic row IDs via MD5 domain-separated hash (computeDeploymentAssetId/FileId)
 *  - FK RESTRICT on deployment_assets/files → deployments
 *  - sortOrder reassignment: oldMax+1...oldMax+n (single transaction)
 *  - All time fields are epoch-ms integers
 */

// ============================================================
// deployments table (§4.1)
// ============================================================

export interface DeploymentRow {
    deploymentId: string;
    consumerAgentRuntimeIds: string;
    platform: string;
    platformInstanceId: string;
    targetRootPath: string;
    projectId: string;
    committedTransactionId: string;
    appliedInputsSnapshot: string;
    appliedRenderSnapshotRef: string;
    observationState: string;
    observationAttemptedAt: number;
    lastCompleteObservationAt: number;
    blockingEvidence: string;
    deleted: number;
    createdAt: number;
    updatedAt: number;
}

export function insertDeployment(db: Database, row: DeploymentRow): void {
    db.prepare(
        `INSERT INTO deployments (
            deployment_id, consumer_agent_runtime_ids, platform, platform_instance_id,
            target_root_path, project_id, committed_transaction_id,
            applied_inputs_snapshot, applied_render_snapshot_ref,
            observation_state, observation_attempted_at, last_complete_observation_at, blocking_evidence,
            deleted, created_at, updated_at
        ) VALUES (
            @deploymentId, @consumerAgentRuntimeIds, @platform, @platformInstanceId,
            @targetRootPath, @projectId, @committedTransactionId,
            @appliedInputsSnapshot, @appliedRenderSnapshotRef,
            @observationState, @observationAttemptedAt, @lastCompleteObservationAt, @blockingEvidence,
            @deleted, @createdAt, @updatedAt
        )`,
    ).run(row);
}

export function getDeployment(db: Database, deploymentId: string): DeploymentRow | null {
    const row = db.prepare("SELECT * FROM deployments WHERE deployment_id = ?").get(deploymentId) as
        | Record<string, unknown>
        | undefined;
    return mapRow<DeploymentRow>(row);
}

export function listDeployments(db: Database, includeDeleted = false): DeploymentRow[] {
    const sql = includeDeleted ? "SELECT * FROM deployments" : "SELECT * FROM deployments WHERE deleted = 0";
    return mapRows<DeploymentRow>(db.prepare(sql).all() as Record<string, unknown>[]);
}

export function updateDeployment(db: Database, deploymentId: string, fields: Partial<DeploymentRow>, now: number): void {
    const allowed = [
        "consumerAgentRuntimeIds",
        "platform",
        "platformInstanceId",
        "targetRootPath",
        "projectId",
        "committedTransactionId",
        "appliedInputsSnapshot",
        "appliedRenderSnapshotRef",
        "observationState",
        "observationAttemptedAt",
        "lastCompleteObservationAt",
        "blockingEvidence",
        "deleted",
    ];
    const sets: string[] = [];
    const values: Record<string, unknown> = { deploymentId, updated_at: now };
    for (const k of allowed) {
        if (k in fields && fields[k as keyof DeploymentRow] !== undefined) {
            sets.push(`${toSnake(k)} = @${k}`);
            values[k] = fields[k as keyof DeploymentRow];
        }
    }
    if (sets.length === 0) return;
    sets.push("updated_at = @updated_at");
    db.prepare(`UPDATE deployments SET ${sets.join(", ")} WHERE deployment_id = @deploymentId`).run(values);
}

export function softDeleteDeployment(db: Database, deploymentId: string, now: number): void {
    db.prepare("UPDATE deployments SET deleted = 1, updated_at = ? WHERE deployment_id = ?").run(now, deploymentId);
}

// ============================================================
// deployment_assets table (§4.2)
// ============================================================

export interface DeploymentAssetRow {
    deploymentAssetId: string;
    deploymentId: string;
    assetId: string;
    versionId: string;
    sortOrder: number;
    allowIncomplete: number;
    deleted: number;
    createdAt: number;
    updatedAt: number;
}

/** Upsert a deployment-asset relationship. Preserves id + createdAt; restores deleted=0. */
export function upsertDeploymentAsset(
    db: Database,
    deploymentId: string,
    assetId: string,
    versionId: string,
    sortOrder: number,
    allowIncomplete: number,
    now: number,
): void {
    const deploymentAssetId = computeDeploymentAssetId(deploymentId, assetId);
    db.prepare(
        `INSERT INTO deployment_assets (
            deployment_asset_id, deployment_id, asset_id, version_id,
            sort_order, allow_incomplete, deleted, created_at, updated_at
        ) VALUES (
            @deploymentAssetId, @deploymentId, @assetId, @versionId,
            @sortOrder, @allowIncomplete, 0, @now, @now
        )
        ON CONFLICT(deployment_id, asset_id) DO UPDATE SET
            version_id = excluded.version_id,
            sort_order = excluded.sort_order,
            allow_incomplete = excluded.allow_incomplete,
            deleted = 0,
            updated_at = excluded.updated_at
        -- deployment_asset_id and created_at are preserved (not in SET clause)
        `,
    ).run({
        deploymentAssetId,
        deploymentId,
        assetId,
        versionId,
        sortOrder,
        allowIncomplete,
        now,
    });
}

export function getDeploymentAsset(db: Database, deploymentId: string, assetId: string): DeploymentAssetRow | null {
    const row = db
        .prepare("SELECT * FROM deployment_assets WHERE deployment_id = ? AND asset_id = ?")
        .get(deploymentId, assetId) as Record<string, unknown> | undefined;
    return mapRow<DeploymentAssetRow>(row);
}

export function listDeploymentAssets(db: Database, deploymentId: string, includeDeleted = false): DeploymentAssetRow[] {
    const sql = includeDeleted
        ? "SELECT * FROM deployment_assets WHERE deployment_id = ? ORDER BY sort_order ASC"
        : "SELECT * FROM deployment_assets WHERE deployment_id = ? AND deleted = 0 ORDER BY sort_order ASC";
    return mapRows<DeploymentAssetRow>(db.prepare(sql).all(deploymentId) as Record<string, unknown>[]);
}

export function softDeleteDeploymentAsset(db: Database, deploymentId: string, assetId: string, now: number): void {
    db.prepare("UPDATE deployment_assets SET deleted = 1, updated_at = ? WHERE deployment_id = ? AND asset_id = ?").run(
        now,
        deploymentId,
        assetId,
    );
}

/**
 * Reassign sortOrder for all active deployment_assets in a single transaction.
 * Algorithm: read old max sortOrder → assign oldMax+1, oldMax+2, ..., oldMax+n
 * in the desired order. New values never collide with old values.
 * Soft-deleted rows that are being restored MUST be included in the same pass.
 */
export function reassignSortOrders(
    db: Database,
    deploymentId: string,
    orderedAssetIds: string[],
    versionIdMap: Map<string, { versionId: string; allowIncomplete: number }>,
    now: number,
): void {
    const tx = db.transaction(() => {
        const maxRow = db
            .prepare("SELECT MAX(sort_order) AS maxSort FROM deployment_assets WHERE deployment_id = ?")
            .get(deploymentId) as { maxSort: number | null };
        const oldMax = maxRow.maxSort ?? 0;
        orderedAssetIds.forEach((assetId, i) => {
            const info = versionIdMap.get(assetId);
            if (!info) throw new Error(`reassignSortOrders: missing versionId for asset ${assetId}`);
            upsertDeploymentAsset(db, deploymentId, assetId, info.versionId, oldMax + 1 + i, info.allowIncomplete, now);
        });
    });
    tx();
}

// ============================================================
// deployment_files table (§4.3)
// ============================================================

export interface DeploymentFileRow {
    deploymentFileId: string;
    deploymentId: string;
    relativePath: string;
    baselineState: string;
    observedState: string;
    observedContentHash: string;
    observedExecutable: number;
    observedAt: number;
    deleted: number;
    createdAt: number;
    updatedAt: number;
}

/** Upsert a deployment-file. Preserves id + createdAt; restores deleted=0. */
export function upsertDeploymentFile(
    db: Database,
    deploymentId: string,
    relativePath: string,
    baselineState: string,
    observedState: string,
    observedContentHash: string,
    observedExecutable: number,
    observedAt: number,
    now: number,
): void {
    const deploymentFileId = computeDeploymentFileId(deploymentId, relativePath);
    db.prepare(
        `INSERT INTO deployment_files (
            deployment_file_id, deployment_id, relative_path,
            baseline_state, observed_state,
            observed_content_hash, observed_executable, observed_at,
            deleted, created_at, updated_at
        ) VALUES (
            @deploymentFileId, @deploymentId, @relativePath,
            @baselineState, @observedState,
            @observedContentHash, @observedExecutable, @observedAt,
            0, @now, @now
        )
        ON CONFLICT(deployment_id, relative_path) DO UPDATE SET
            baseline_state = excluded.baseline_state,
            observed_state = excluded.observed_state,
            observed_content_hash = excluded.observed_content_hash,
            observed_executable = excluded.observed_executable,
            observed_at = excluded.observed_at,
            deleted = 0,
            updated_at = excluded.updated_at
        -- deployment_file_id and created_at are preserved
        `,
    ).run({
        deploymentFileId,
        deploymentId,
        relativePath,
        baselineState,
        observedState,
        observedContentHash,
        observedExecutable,
        observedAt,
        now,
    });
}

// ============================================================
// deployment_render_snapshots / deployment_residual_authorities
// ============================================================

export interface DeploymentRenderSnapshotRow {
    snapshotFingerprint: string;
    deploymentId: string;
    snapshotJson: string;
    deleted: number;
    createdAt: number;
    updatedAt: number;
}

export function insertDeploymentRenderSnapshot(db: Database, row: DeploymentRenderSnapshotRow): void {
    db.prepare(
        `INSERT INTO deployment_render_snapshots (
            snapshot_fingerprint, deployment_id, snapshot_json,
            deleted, created_at, updated_at
        ) VALUES (
            @snapshotFingerprint, @deploymentId, @snapshotJson,
            @deleted, @createdAt, @updatedAt
        ) ON CONFLICT(deployment_id, snapshot_fingerprint) DO NOTHING`,
    ).run(row);
}

export function getDeploymentRenderSnapshot(
    db: Database,
    deploymentId: string,
    snapshotFingerprint: string,
): DeploymentRenderSnapshotRow | null {
    return mapRow<DeploymentRenderSnapshotRow>(
        db
            .prepare("SELECT * FROM deployment_render_snapshots WHERE deployment_id = ? AND snapshot_fingerprint = ?")
            .get(deploymentId, snapshotFingerprint) as Record<string, unknown> | undefined,
    );
}

export function listDeploymentRenderSnapshots(db: Database, deploymentId: string): DeploymentRenderSnapshotRow[] {
    return mapRows<DeploymentRenderSnapshotRow>(
        db
            .prepare("SELECT * FROM deployment_render_snapshots WHERE deployment_id = ? ORDER BY snapshot_fingerprint ASC")
            .all(deploymentId) as Record<string, unknown>[],
    );
}

export interface DeploymentResidualAuthorityRow {
    residualAuthorityId: string;
    deploymentId: string;
    relativePath: string;
    authorityBody: string;
    residualAuthorityFingerprint: string;
    deleted: number;
    createdAt: number;
    updatedAt: number;
}

export function insertDeploymentResidualAuthority(db: Database, row: DeploymentResidualAuthorityRow): void {
    db.prepare(
        `INSERT INTO deployment_residual_authorities (
            residual_authority_id, deployment_id, relative_path, authority_body,
            residual_authority_fingerprint, deleted, created_at, updated_at
        ) VALUES (
            @residualAuthorityId, @deploymentId, @relativePath, @authorityBody,
            @residualAuthorityFingerprint, @deleted, @createdAt, @updatedAt
        ) ON CONFLICT(residual_authority_id) DO NOTHING`,
    ).run(row);
}

export function getDeploymentResidualAuthority(db: Database, residualAuthorityId: string): DeploymentResidualAuthorityRow | null {
    return mapRow<DeploymentResidualAuthorityRow>(
        db.prepare("SELECT * FROM deployment_residual_authorities WHERE residual_authority_id = ?").get(residualAuthorityId) as
            | Record<string, unknown>
            | undefined,
    );
}

export function listDeploymentResidualAuthorities(db: Database, deploymentId: string): DeploymentResidualAuthorityRow[] {
    return mapRows<DeploymentResidualAuthorityRow>(
        db
            .prepare("SELECT * FROM deployment_residual_authorities WHERE deployment_id = ? ORDER BY residual_authority_id ASC")
            .all(deploymentId) as Record<string, unknown>[],
    );
}

export function getDeploymentFile(db: Database, deploymentId: string, relativePath: string): DeploymentFileRow | null {
    const row = db
        .prepare("SELECT * FROM deployment_files WHERE deployment_id = ? AND relative_path = ?")
        .get(deploymentId, relativePath) as Record<string, unknown> | undefined;
    return mapRow<DeploymentFileRow>(row);
}

export function listDeploymentFiles(db: Database, deploymentId: string, includeDeleted = false): DeploymentFileRow[] {
    const sql = includeDeleted
        ? "SELECT * FROM deployment_files WHERE deployment_id = ? ORDER BY relative_path ASC"
        : "SELECT * FROM deployment_files WHERE deployment_id = ? AND deleted = 0 ORDER BY relative_path ASC";
    return mapRows<DeploymentFileRow>(db.prepare(sql).all(deploymentId) as Record<string, unknown>[]);
}

/** Administrative lifecycle tombstone only. A normal managed-file removal is
 * represented by baselineState.rowState="removed" plus a residual authority;
 * it must never call this function. */
export function softDeleteDeploymentFile(db: Database, deploymentId: string, relativePath: string, now: number): void {
    db.prepare("UPDATE deployment_files SET deleted = 1, updated_at = ? WHERE deployment_id = ? AND relative_path = ?").run(
        now,
        deploymentId,
        relativePath,
    );
}

// ============================================================
// current_asset_index table (§4.4 — derived projection)
// ============================================================

export interface CurrentAssetIndexRow {
    assetId: string;
    kind: string;
    scope: string;
    projectId: string;
    scopePath: string;
    displayName: string;
    displayDescription: string;
    currentVersionId: string;
    currentRevision: number;
    currentFingerprint: string;
    currentVersionStatus: string;
    createdAt: number;
    updatedAt: number;
    deleted: number;
}

export function upsertCurrentAssetIndex(db: Database, row: CurrentAssetIndexRow): void {
    db.prepare(
        `INSERT INTO current_asset_index (
            asset_id, kind, scope, project_id, scope_path,
            display_name, display_description, current_version_id,
            current_revision, current_fingerprint, current_version_status,
            created_at, updated_at, deleted
        ) VALUES (
            @assetId, @kind, @scope, @projectId, @scopePath,
            @displayName, @displayDescription, @currentVersionId,
            @currentRevision, @currentFingerprint, @currentVersionStatus,
            @createdAt, @updatedAt, @deleted
        )
        ON CONFLICT(asset_id) DO UPDATE SET
            kind = excluded.kind,
            scope = excluded.scope,
            project_id = excluded.project_id,
            scope_path = excluded.scope_path,
            display_name = excluded.display_name,
            display_description = excluded.display_description,
            current_version_id = excluded.current_version_id,
            current_revision = excluded.current_revision,
            current_fingerprint = excluded.current_fingerprint,
            current_version_status = excluded.current_version_status,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            deleted = excluded.deleted`,
    ).run(row);
}

export function deleteCurrentAssetIndex(db: Database, assetId: string): void {
    db.prepare("DELETE FROM current_asset_index WHERE asset_id = ?").run(assetId);
}

export function clearCurrentAssetIndex(db: Database): void {
    db.prepare("DELETE FROM current_asset_index").run();
}

export function getCurrentAssetIndex(db: Database, assetId: string): CurrentAssetIndexRow | null {
    const row = db.prepare("SELECT * FROM current_asset_index WHERE asset_id = ?").get(assetId) as
        | Record<string, unknown>
        | undefined;
    return mapRow<CurrentAssetIndexRow>(row);
}

export function listCurrentAssetIndex(db: Database, includeDeleted = false): CurrentAssetIndexRow[] {
    const sql = includeDeleted ? "SELECT * FROM current_asset_index" : "SELECT * FROM current_asset_index WHERE deleted = 0";
    return mapRows<CurrentAssetIndexRow>(db.prepare(sql).all() as Record<string, unknown>[]);
}

// ============================================================
// project_index table (§4.6 — derived projection)
// ============================================================

export interface ProjectIndexRow {
    projectId: string;
    rootPath: string;
    displayName: string;
    deleted: number;
    createdAt: number;
    updatedAt: number;
}

export function upsertProjectIndex(db: Database, row: ProjectIndexRow): void {
    db.prepare(
        `INSERT INTO project_index (
            project_id, root_path, display_name, deleted, created_at, updated_at
        ) VALUES (
            @projectId, @rootPath, @displayName, @deleted, @createdAt, @updatedAt
        )
        ON CONFLICT(project_id) DO UPDATE SET
            root_path = excluded.root_path,
            display_name = excluded.display_name,
            deleted = excluded.deleted,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
    ).run(row);
}

export function deleteProjectIndex(db: Database, projectId: string): void {
    db.prepare("DELETE FROM project_index WHERE project_id = ?").run(projectId);
}

export function clearProjectIndex(db: Database): void {
    db.prepare("DELETE FROM project_index").run();
}

export function listProjectIndex(db: Database, includeDeleted = false): ProjectIndexRow[] {
    const sql = includeDeleted ? "SELECT * FROM project_index" : "SELECT * FROM project_index WHERE deleted = 0";
    return mapRows<ProjectIndexRow>(db.prepare(sql).all() as Record<string, unknown>[]);
}

// ============================================================
// assets_fts table (§4.5 — FTS5 virtual table, reindex-only)
// ============================================================

export function clearAssetsFts(db: Database): void {
    db.prepare("DELETE FROM assets_fts").run();
}

export function deleteAssetsFts(db: Database, assetId: string): void {
    db.prepare("DELETE FROM assets_fts WHERE asset_id = ?").run(assetId);
}

export function insertAssetsFts(
    db: Database,
    assetId: string,
    displayName: string,
    displayDescription: string,
    searchableText: string,
): void {
    db.prepare(
        `INSERT INTO assets_fts (asset_id, display_name, display_description, searchable_text)
         VALUES (?, ?, ?, ?)`,
    ).run(assetId, displayName, displayDescription, searchableText);
}

export function queryAssetsFts(db: Database, keywords: string, limit = 100): { assetId: string }[] {
    const rows = db
        .prepare(
            `SELECT asset_id FROM assets_fts
             WHERE assets_fts MATCH ?
             LIMIT ?`,
        )
        .all(keywords, limit) as Record<string, unknown>[];
    return mapRows<{ assetId: string }>(rows);
}

// ============================================================
// Utility
// ============================================================

function toSnake(camel: string): string {
    return camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// ============================================================
// Row mapper: snake_case DB columns → camelCase TS interface
// ============================================================

function mapRow<T>(row: Record<string, unknown> | null | undefined): T | null {
    if (row === null || row === undefined) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
        const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        out[camel] = v;
    }
    return out as T;
}

function mapRows<T>(rows: Record<string, unknown>[]): T[] {
    return rows.map((r) => mapRow<T>(r) as T);
}
