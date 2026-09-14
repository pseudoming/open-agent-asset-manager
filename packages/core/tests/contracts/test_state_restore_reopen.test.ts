import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockFile, SafeFilesystemError } from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_VERSION_DIALECT_REGISTRY, publishInitialAssetVersion } from "../../src/catalog/version-authority";
import { writeProjectManifest } from "../../src/catalog/project-authority";
import { reindexProjects } from "../../src/catalog/reindex-projects";
import { publishJournal, type ActiveJournal } from "../../src/deployment/deployment-journal";
import { captureRestoredProfileSource } from "../../src/orchestration/state-backup-source";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import {
    buildRestoreMarker,
    RESTORE_MARKER_NAME,
    serializeRestoreMarker,
    type StateRestoreError,
} from "../../src/orchestration/state-restore-model";
import { reconcileStateRestoreBeforeStartupForTest } from "../../src/orchestration/state-restore-reconciliation";
import {
    scanStateRestoreOrphanEvidence,
    stateRestoreOrphanInternalsForTest,
} from "../../src/orchestration/state-restore-orphans";
import {
    buildStateRestoreReopenReport,
    stateRestoreReopenReportInternalsForTest,
    validateStateRestoreReopenReportDocument,
} from "../../src/orchestration/state-restore-reopen-report";
import { finalizeStateRestoreReopen, stateRestoreReopenInternalsForTest } from "../../src/orchestration/state-restore-reopen";
import { readStateRestoreMarker, scanStateRestoreTransactions } from "../../src/orchestration/state-restore-transactions";
import { closeDb, getDb } from "../../src/persistence/db";
import {
    type DeploymentRow,
    insertDeployment,
    insertAssetsFts,
    listCurrentAssetIndex,
    listDeployments,
    listProjectIndex,
    upsertCurrentAssetIndex,
    upsertProjectIndex,
} from "../../src/persistence/state-db";
import type { ProjectManifestV1, Sha256Digest, UuidV4 } from "../../src/types";
import { ASSET_ID, makeAsset, makeTextFile, makeVersionClosure, VERSION_ID } from "../catalog/fixtures/version-v2";

const RESTORE_ID = "00000000-0000-4000-8000-000000000347" as UuidV4;
const BACKUP_ID = "00000000-0000-4000-8000-000000000147" as UuidV4;
const PROJECT_ID = "00000000-0000-4000-8000-000000000447" as UuidV4;
const STALE_ASSET_ID = "00000000-0000-4000-8000-000000000547" as UuidV4;
const STALE_PROJECT_ID = "00000000-0000-4000-8000-000000000647" as UuidV4;
const JOURNAL_ID = "00000000-0000-4000-8000-000000000747" as UuidV4;
const CORRUPT_JOURNAL_ID = "00000000-0000-4000-8000-000000000748" as UuidV4;
const ORPHAN_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000847" as UuidV4;
const OWNED_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000848" as UuidV4;
const OWNED_JOURNAL_ID = "00000000-0000-4000-8000-000000000749" as UuidV4;
const HASH = `sha256:${"a".repeat(64)}` as Sha256Digest;

describe("State restore projection rebuild and orphan report", () => {
    let sandbox = "";
    let oaamRoot = "";
    let databasePath = "";
    let assetsRoot = "";
    let projectsRoot = "";
    let deploymentsRoot = "";
    let transactionsRoot = "";
    let workspaceRoot = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restore-reopen-"));
        oaamRoot = path.join(sandbox, "oaam");
        databasePath = path.join(oaamRoot, "index.db");
        assetsRoot = path.join(oaamRoot, "assets");
        projectsRoot = path.join(oaamRoot, "projects");
        deploymentsRoot = path.join(oaamRoot, "deployments");
        transactionsRoot = path.join(oaamRoot, "transactions");
        workspaceRoot = path.join(sandbox, "workspace");
        fs.mkdirSync(oaamRoot);
        fs.mkdirSync(workspaceRoot);
        closeDb();
        clearRegistry();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function writeProject(projectId = PROJECT_ID, overrides: Partial<ProjectManifestV1> = {}): void {
        writeProjectManifest(projectsRoot, {
            schemaVersion: 1,
            projectId,
            rootPath: workspaceRoot,
            displayName: "Restored Project",
            deleted: false,
            createdAt: 10,
            updatedAt: 20,
            ...overrides,
        });
    }

    function writeAsset(): void {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: `txn-${VERSION_ID}`,
            asset: makeAsset([VERSION_ID], {
                assetId: ASSET_ID,
                projectId: "",
                scope: "global",
                displayName: "Restored Guidance",
            }),
            version: makeVersionClosure({
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                files: [makeTextFile("# restored\n", "AGENTS.md")],
            }),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
    }

    function writeActivatedMarker(profileSnapshotFingerprint: Sha256Digest): string {
        const transactionPath = path.join(sandbox, `.oaam.restore-txn-${RESTORE_ID}`);
        fs.mkdirSync(transactionPath);
        const marker = buildRestoreMarker({
            restoreId: RESTORE_ID,
            backupId: BACKUP_ID,
            archiveContentHash: HASH,
            sourceSnapshotFingerprint: HASH,
            profileSnapshotFingerprint,
            oaamRoot,
            databasePath,
            transactionPath,
            stagedPath: path.join(transactionPath, "staged"),
            displacedPath: path.join(transactionPath, "displaced"),
            phase: "activated",
        });
        fs.writeFileSync(path.join(transactionPath, RESTORE_MARKER_NAME), serializeRestoreMarker(marker));
        return transactionPath;
    }

    function orphanJournal(): ActiveJournal {
        return {
            schemaVersion: 1,
            transactionId: JOURNAL_ID,
            deploymentId: ORPHAN_DEPLOYMENT_ID,
            createdAt: 100,
            compilationFingerprint: HASH,
            reservedPhysicalKeys: [],
            entries: [],
        };
    }

    function deploymentRow(deploymentId: UuidV4): DeploymentRow {
        return {
            deploymentId,
            consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: workspaceRoot,
            projectId: "",
            committedTransactionId: "",
            appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${deploymentId}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
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
    }

    it("rebuilds only file-backed projections and reports rather than adopting or deleting Deployment evidence", () => {
        const db = getDb(databasePath);
        writeProject();
        writeAsset();
        upsertCurrentAssetIndex(db, {
            assetId: STALE_ASSET_ID,
            kind: "Guidance",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "Stale",
            displayDescription: "",
            currentVersionId: VERSION_ID,
            currentRevision: 1,
            currentFingerprint: HASH,
            currentVersionStatus: "complete",
            createdAt: 1,
            updatedAt: 1,
            deleted: 0,
        });
        insertAssetsFts(db, STALE_ASSET_ID, "Stale", "", "stale");
        upsertProjectIndex(db, {
            projectId: STALE_PROJECT_ID,
            rootPath: path.join(sandbox, "stale-workspace"),
            displayName: "Stale",
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
        });
        fs.mkdirSync(path.join(deploymentsRoot, ORPHAN_DEPLOYMENT_ID), { recursive: true });
        fs.writeFileSync(path.join(deploymentsRoot, ORPHAN_DEPLOYMENT_ID, "payload.bin"), "preserve");
        fs.writeFileSync(path.join(deploymentsRoot, "loose.bin"), "preserve");
        insertDeployment(db, deploymentRow(OWNED_DEPLOYMENT_ID));
        fs.mkdirSync(path.join(deploymentsRoot, OWNED_DEPLOYMENT_ID));
        publishJournal(transactionsRoot, {
            ...orphanJournal(),
            transactionId: OWNED_JOURNAL_ID,
            deploymentId: OWNED_DEPLOYMENT_ID,
        });
        publishJournal(transactionsRoot, orphanJournal());
        fs.mkdirSync(path.join(transactionsRoot, CORRUPT_JOURNAL_ID));
        fs.writeFileSync(path.join(transactionsRoot, CORRUPT_JOURNAL_ID, "journal.json"), "{bad");
        closeDb();

        const profileFingerprint = captureRestoredProfileSource({ oaamRoot, databasePath }).sourceSnapshotFingerprint;
        const transactionPath = writeActivatedMarker(profileFingerprint);
        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toMatchObject({
            state: "projection_rebuild_required",
            transactionPath,
        });

        const core = createCoreServiceForTest(
            {
                providers: [],
                platformContexts: [],
                oaamRoot,
                databasePath,
                now: () => 1_721_800_003_000,
            },
            {},
        );

        expect(core.listAssets({}).value.map((asset) => asset.assetId)).toEqual([ASSET_ID]);
        expect(core.listProjects().value.map((project) => project.projectId)).toEqual([PROJECT_ID]);
        expect(listCurrentAssetIndex(getDb(databasePath), true).map((row) => row.assetId)).toEqual([ASSET_ID]);
        expect(listProjectIndex(getDb(databasePath), true).map((row) => row.projectId)).toEqual([PROJECT_ID]);
        expect(listDeployments(getDb(databasePath), true).map((row) => row.deploymentId)).toEqual([OWNED_DEPLOYMENT_ID]);
        expect(fs.readFileSync(path.join(deploymentsRoot, ORPHAN_DEPLOYMENT_ID, "payload.bin"), "utf8")).toBe("preserve");
        expect(fs.existsSync(path.join(transactionsRoot, JOURNAL_ID, "journal.json"))).toBe(true);
        expect(fs.existsSync(path.join(transactionsRoot, OWNED_JOURNAL_ID, "journal.json"))).toBe(true);
        expect(fs.existsSync(path.join(transactionsRoot, CORRUPT_JOURNAL_ID, "journal.json"))).toBe(true);

        const report = validateStateRestoreReopenReportDocument(
            JSON.parse(fs.readFileSync(path.join(transactionPath, "reopen-report.json"), "utf8")),
        );
        expect(report).toMatchObject({
            outcome: "restored",
            completedAt: 1_721_800_003_000,
            projection: {
                state: "complete",
                scannedAssets: 1,
                indexedAssets: 1,
                skippedAssets: 0,
                scannedProjects: 1,
                indexedProjects: 1,
                skippedProjects: 0,
            },
        });
        expect(report.orphanEvidence).toEqual([
            {
                evidenceKind: "deployment_payload",
                path: path.join(deploymentsRoot, ORPHAN_DEPLOYMENT_ID),
            },
            {
                evidenceKind: "deployment_payload",
                path: path.join(deploymentsRoot, "loose.bin"),
            },
            {
                evidenceKind: "deployment_journal",
                path: path.join(transactionsRoot, JOURNAL_ID, "journal.json"),
            },
            {
                evidenceKind: "corrupt_deployment_journal",
                path: path.join(transactionsRoot, CORRUPT_JOURNAL_ID, "journal.json"),
            },
        ]);
        expect(readStateRestoreMarker(path.join(transactionPath, RESTORE_MARKER_NAME)).phase).toBe("reconciled");
    });

    it("keeps the marker retryable when a projection root is not a directory", () => {
        getDb(databasePath);
        closeDb();
        fs.writeFileSync(assetsRoot, "not-a-directory");
        const profileFingerprint = captureRestoredProfileSource({ oaamRoot, databasePath }).sourceSnapshotFingerprint;
        const transactionPath = writeActivatedMarker(profileFingerprint);
        reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath });

        expect(() =>
            createCoreServiceForTest(
                {
                    providers: [],
                    platformContexts: [],
                    oaamRoot,
                    databasePath,
                    now: () => 1_721_800_003_100,
                },
                {},
            ),
        ).toThrow();
        expect(readStateRestoreMarker(path.join(transactionPath, RESTORE_MARKER_NAME)).phase).toBe("reprojecting");
        expect(fs.existsSync(path.join(transactionPath, "reopen-report.json"))).toBe(false);
    });

    it("reindexes valid Projects while reporting invalid, missing and corrupt authorities", () => {
        const db = getDb(databasePath);
        writeProject();
        fs.mkdirSync(path.join(projectsRoot, "not-a-uuid"));
        fs.mkdirSync(path.join(projectsRoot, "00000000-0000-4000-8000-000000000948"));
        const corruptId = "00000000-0000-4000-8000-000000000949";
        fs.mkdirSync(path.join(projectsRoot, corruptId));
        fs.writeFileSync(path.join(projectsRoot, corruptId, "project.json"), "{bad");

        const report = reindexProjects(projectsRoot, db);

        expect(report).toMatchObject({ scannedProjects: 4, indexedProjects: 1, skippedProjects: 3 });
        expect(report.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
            "reindex.project_error",
            "reindex.project_id_invalid",
            "reindex.project_missing",
        ]);
        expect(listProjectIndex(db, true).map((row) => row.projectId)).toEqual([PROJECT_ID]);
        expect(reindexProjects(path.join(sandbox, "missing-projects"), db)).toMatchObject({
            scannedProjects: 0,
            indexedProjects: 0,
            skippedProjects: 0,
        });

        fs.rmSync(projectsRoot, { recursive: true });
        fs.mkdirSync(projectsRoot);
        const deletedProjectId = "00000000-0000-4000-8000-000000000950" as UuidV4;
        writeProject(deletedProjectId, { deleted: true });
        expect(reindexProjects(projectsRoot, db)).toMatchObject({
            scannedProjects: 1,
            indexedProjects: 1,
            skippedProjects: 0,
        });
        expect(listProjectIndex(db, true)).toEqual([
            expect.objectContaining({
                projectId: deletedProjectId,
                deleted: 1,
            }),
        ]);

        fs.rmSync(projectsRoot, { recursive: true });
        fs.writeFileSync(projectsRoot, "not a directory");
        expect(() => reindexProjects(projectsRoot, db)).toThrow(SafeFilesystemError);
    });

    it("strictly validates report counts, ordering and body fingerprints", () => {
        const firstPath = path.join(sandbox, "a");
        const secondPath = path.join(sandbox, "b");
        const report = buildStateRestoreReopenReport({
            restoreId: RESTORE_ID,
            backupId: BACKUP_ID,
            outcome: "restored",
            completedAt: 1,
            projection: {
                state: "partial",
                scannedAssets: 2,
                indexedAssets: 1,
                skippedAssets: 1,
                scannedProjects: 0,
                indexedProjects: 0,
                skippedProjects: 0,
            },
            orphanEvidence: [
                { evidenceKind: "deployment_payload", path: firstPath },
                { evidenceKind: "deployment_journal", path: secondPath },
            ],
            issues: [{ code: "projection.partial", message: "one Asset was skipped", path: "asset" }],
        });
        expect(validateStateRestoreReopenReportDocument(report)).toEqual(report);
        expect(() => validateStateRestoreReopenReportDocument(null)).toThrow(/strict shape/u);
        expect(stateRestoreReopenReportInternalsForTest.isProjection({ state: "not_run" })).toBe(true);
        expect(stateRestoreReopenReportInternalsForTest.isProjection({ state: "future" })).toBe(false);
        expect(stateRestoreReopenReportInternalsForTest.isProjection({ state: "complete" })).toBe(false);
        expect(
            stateRestoreReopenReportInternalsForTest.isProjection({
                ...report.projection,
                scannedAssets: -1,
            }),
        ).toBe(false);
        expect(
            stateRestoreReopenReportInternalsForTest.isProjection({
                ...report.projection,
                scannedAssets: 3,
            }),
        ).toBe(false);
        expect(() =>
            validateStateRestoreReopenReportDocument({
                ...report,
                outcome: "retained_current",
            }),
        ).toThrow(/cannot claim/u);
        expect(() =>
            validateStateRestoreReopenReportDocument({
                ...report,
                projection: { state: "not_run" },
            }),
        ).toThrow(/must carry/u);
        expect(() =>
            validateStateRestoreReopenReportDocument({
                ...report,
                orphanEvidence: [report.orphanEvidence[0], report.orphanEvidence[0]],
            }),
        ).toThrow(/unique/u);
        expect(() =>
            validateStateRestoreReopenReportDocument({
                ...report,
                orphanEvidence: [...report.orphanEvidence].reverse(),
            }),
        ).toThrow(/sorted/u);
        expect(() =>
            validateStateRestoreReopenReportDocument({
                ...report,
                completedAt: 2,
            }),
        ).toThrow(/fingerprint/u);
    });

    it("keeps owned evidence out of orphan reports and preserves equal-path evidence deterministically", () => {
        const db = getDb(databasePath);
        insertDeployment(db, deploymentRow(OWNED_DEPLOYMENT_ID));
        fs.mkdirSync(path.join(deploymentsRoot, OWNED_DEPLOYMENT_ID), { recursive: true });
        publishJournal(transactionsRoot, {
            ...orphanJournal(),
            transactionId: OWNED_JOURNAL_ID,
            deploymentId: OWNED_DEPLOYMENT_ID,
        });
        expect(scanStateRestoreOrphanEvidence({ db, deploymentsRoot, transactionsRoot })).toEqual([]);

        expect(
            scanStateRestoreOrphanEvidence({
                db,
                deploymentsRoot: path.join(sandbox, "missing-deployments"),
                transactionsRoot: path.join(sandbox, "missing-transactions"),
            }),
        ).toEqual([]);
        const invalidRoot = path.join(sandbox, "invalid-deployments");
        fs.writeFileSync(invalidRoot, "file");
        expect(() => stateRestoreOrphanInternalsForTest.inventoryDeploymentPayloadEntries(invalidRoot)).toThrow(
            SafeFilesystemError,
        );

        const equalPathTransactions = path.join(sandbox, "equal-path-transactions");
        publishJournal(equalPathTransactions, orphanJournal());
        const equalPathEvidence = scanStateRestoreOrphanEvidence({
            db,
            deploymentsRoot: path.join(equalPathTransactions, JOURNAL_ID),
            transactionsRoot: equalPathTransactions,
        });
        expect(equalPathEvidence).toEqual([
            {
                evidenceKind: "deployment_journal",
                path: path.join(equalPathTransactions, JOURNAL_ID, "journal.json"),
            },
            {
                evidenceKind: "deployment_payload",
                path: path.join(equalPathTransactions, JOURNAL_ID, "journal.json"),
            },
        ]);
    });

    it("fails closed on reopen lock or transaction drift, then records a truthful partial projection", () => {
        getDb(databasePath);
        closeDb();
        fs.mkdirSync(path.join(projectsRoot, "not-a-uuid"), { recursive: true });
        const profileFingerprint = captureRestoredProfileSource({ oaamRoot, databasePath }).sourceSnapshotFingerprint;
        const transactionPath = writeActivatedMarker(profileFingerprint);
        reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath });
        const pending = scanStateRestoreTransactions({ oaamRoot, databasePath })[0];
        expect(pending).toBeDefined();

        const restoreLockPath = path.join(sandbox, ".oaam.restore.lock");
        const release = lockFile(restoreLockPath);
        expect(release).not.toBeNull();
        try {
            expect(() =>
                finalizeStateRestoreReopen({
                    db: getDb(databasePath),
                    oaamRoot,
                    databasePath,
                    assetsRoot,
                    projectsRoot,
                    deploymentsRoot,
                    transactionsRoot,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    pendingRestore: pending as NonNullable<typeof pending>,
                    now: () => 1,
                }),
            ).toThrow(expect.objectContaining<StateRestoreError>({ code: "restore.operation_locked" }));
        } finally {
            release?.();
        }

        expect(() =>
            finalizeStateRestoreReopen({
                db: getDb(databasePath),
                oaamRoot,
                databasePath,
                assetsRoot,
                projectsRoot,
                deploymentsRoot,
                transactionsRoot,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                pendingRestore: {
                    ...(pending as NonNullable<typeof pending>),
                    marker: {
                        ...(pending as NonNullable<typeof pending>).marker,
                        restoreId: "00000000-0000-4000-8000-000000000999" as UuidV4,
                    },
                },
                now: () => 1,
            }),
        ).toThrow(expect.objectContaining<StateRestoreError>({ code: "restore.transaction_changed" }));

        const report = finalizeStateRestoreReopen({
            db: getDb(databasePath),
            oaamRoot,
            databasePath,
            assetsRoot,
            projectsRoot,
            deploymentsRoot,
            transactionsRoot,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            pendingRestore: pending as NonNullable<typeof pending>,
            now: () => 1_721_800_003_200,
        });
        expect(report).toMatchObject({
            outcome: "restored",
            projection: {
                state: "partial",
                scannedProjects: 1,
                indexedProjects: 0,
                skippedProjects: 1,
            },
            issues: [{ code: "reindex.project_id_invalid", path: "not-a-uuid" }],
        });
        expect(readStateRestoreMarker(path.join(transactionPath, RESTORE_MARKER_NAME)).phase).toBe("reconciled");
        expect(() => stateRestoreReopenInternalsForTest.requireReopenTime(-1 as never)).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.clock_invalid" }),
        );
    });
});
