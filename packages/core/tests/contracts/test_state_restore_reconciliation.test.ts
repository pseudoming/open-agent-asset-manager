import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockFile, SafeFilesystemError } from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureRestoredProfileSource } from "../../src/orchestration/state-backup-source";
import {
    buildRestoreMarker,
    RESTORE_DISPLACED_NAME,
    RESTORE_MARKER_NAME,
    RESTORE_STAGED_NAME,
    serializeRestoreMarker,
    type StateRestoreError,
    stateRestoreModelInternalsForTest,
    type StateRestoreMarkerPhase,
} from "../../src/orchestration/state-restore-model";
import {
    reconcileStateRestoreBeforeStartup,
    reconcileStateRestoreBeforeStartupForTest,
    stateRestoreReconciliationInternalsForTest,
} from "../../src/orchestration/state-restore-reconciliation";
import { validateStateRestoreReopenReportDocument } from "../../src/orchestration/state-restore-reopen-report";
import { stateRestoreServiceInternalsForTest } from "../../src/orchestration/state-restore-service";
import {
    readStateRestoreMarker,
    scanStateRestoreTransactions,
    stateRestoreTransactionInternalsForTest,
} from "../../src/orchestration/state-restore-transactions";
import { closeDb, getDb } from "../../src/persistence/db";
import type { StateProfileRecoveryRequiredError } from "../../src/persistence/state-profile";
import { assertStateProfileRestoreStartup } from "../../src/orchestration/state-profile-startup";
import type { Sha256Digest, UuidV4 } from "../../src/types";

const RESTORE_ID = "00000000-0000-4000-8000-000000000347" as UuidV4;
const OTHER_RESTORE_ID = "00000000-0000-4000-8000-000000000348" as UuidV4;
const BACKUP_ID = "00000000-0000-4000-8000-000000000147" as UuidV4;
const HASH = `sha256:${"a".repeat(64)}` as Sha256Digest;

describe("State restore startup reconciliation", () => {
    let sandbox = "";
    let oaamRoot = "";
    let databasePath = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restore-reconcile-"));
        oaamRoot = path.join(sandbox, "oaam");
        databasePath = path.join(oaamRoot, "index.db");
        closeDb();
    });

    afterEach(() => {
        closeDb();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function createProfile(rootPath: string, label: string): Sha256Digest {
        fs.mkdirSync(rootPath, { recursive: true });
        getDb(path.join(rootPath, "index.db"));
        closeDb();
        fs.writeFileSync(path.join(rootPath, "profile.txt"), label);
        return captureRestoredProfileSource({
            oaamRoot: rootPath,
            databasePath: path.join(rootPath, "index.db"),
        }).sourceSnapshotFingerprint;
    }

    function transactionPaths(restoreId = RESTORE_ID) {
        const transactionPath = path.join(sandbox, `.oaam.restore-txn-${restoreId}`);
        return {
            transactionPath,
            markerPath: path.join(transactionPath, RESTORE_MARKER_NAME),
            stagedPath: path.join(transactionPath, RESTORE_STAGED_NAME),
            displacedPath: path.join(transactionPath, RESTORE_DISPLACED_NAME),
        };
    }

    function writeMarker(phase: StateRestoreMarkerPhase, profileSnapshotFingerprint: Sha256Digest, restoreId = RESTORE_ID) {
        const paths = transactionPaths(restoreId);
        fs.mkdirSync(paths.transactionPath, { recursive: true });
        const marker = buildRestoreMarker({
            restoreId,
            backupId: BACKUP_ID,
            archiveContentHash: HASH,
            sourceSnapshotFingerprint: HASH,
            profileSnapshotFingerprint,
            oaamRoot,
            databasePath,
            transactionPath: paths.transactionPath,
            stagedPath: paths.stagedPath,
            displacedPath: paths.displacedPath,
            phase,
        });
        fs.writeFileSync(paths.markerPath, serializeRestoreMarker(marker));
        return paths;
    }

    it("retains one untouched live profile and terminally aborts a pre-displacement transaction", () => {
        const fingerprint = createProfile(oaamRoot, "live");
        const paths = writeMarker("staging", fingerprint);
        fs.mkdirSync(paths.stagedPath);
        fs.writeFileSync(path.join(paths.stagedPath, "partial.txt"), "evidence");

        expect(
            reconcileStateRestoreBeforeStartupForTest({
                oaamRoot,
                databasePath,
                now: () => 1_721_800_002_000,
            }),
        ).toEqual({ state: "retained_current", transactionPath: paths.transactionPath });

        expect(fs.readFileSync(path.join(oaamRoot, "profile.txt"), "utf8")).toBe("live");
        expect(fs.readFileSync(path.join(paths.stagedPath, "partial.txt"), "utf8")).toBe("evidence");
        expect(readStateRestoreMarker(paths.markerPath).phase).toBe("aborted");
        const report = validateStateRestoreReopenReportDocument(
            JSON.parse(fs.readFileSync(path.join(paths.transactionPath, "reopen-report.json"), "utf8")),
        );
        expect(report).toMatchObject({
            outcome: "retained_current",
            completedAt: 1_721_800_002_000,
            projection: { state: "not_run" },
        });
        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({ state: "none" });
    });

    it("completes a displaced candidate, carries existing backups, and stops at projection rebuild", () => {
        createProfile(oaamRoot, "old");
        fs.mkdirSync(path.join(oaamRoot, "backups"));
        fs.writeFileSync(path.join(oaamRoot, "backups", "keep.zip"), "backup");
        const paths = transactionPaths();
        fs.mkdirSync(paths.transactionPath);
        const stagedFingerprint = createProfile(paths.stagedPath, "restored");
        fs.renameSync(oaamRoot, paths.displacedPath);
        writeMarker("candidate_ready", stagedFingerprint);

        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({
            state: "projection_rebuild_required",
            transactionPath: paths.transactionPath,
        });

        expect(fs.readFileSync(path.join(oaamRoot, "profile.txt"), "utf8")).toBe("restored");
        expect(fs.readFileSync(path.join(oaamRoot, "backups", "keep.zip"), "utf8")).toBe("backup");
        expect(fs.readFileSync(path.join(paths.displacedPath, "profile.txt"), "utf8")).toBe("old");
        expect(fs.existsSync(paths.stagedPath)).toBe(false);
        expect(readStateRestoreMarker(paths.markerPath).phase).toBe("reprojecting");
        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({
            state: "projection_rebuild_required",
            transactionPath: paths.transactionPath,
        });
    });

    it("recognizes a candidate published into an initially absent profile before the activated marker write", () => {
        const fingerprint = createProfile(oaamRoot, "published");
        const paths = writeMarker("candidate_ready", fingerprint);

        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({
            state: "projection_rebuild_required",
            transactionPath: paths.transactionPath,
        });
        expect(fs.readFileSync(path.join(oaamRoot, "profile.txt"), "utf8")).toBe("published");
        expect(fs.existsSync(paths.stagedPath)).toBe(false);
        expect(fs.existsSync(paths.displacedPath)).toBe(false);
        expect(readStateRestoreMarker(paths.markerPath).phase).toBe("reprojecting");
    });

    it.each([
        "live_displaced",
        "activated",
    ] as const)("recognizes a published profile left at %s without replaying activation", (phase) => {
        const fingerprint = createProfile(oaamRoot, "published");
        const paths = writeMarker(phase, fingerprint);
        createProfile(paths.displacedPath, "old");

        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({
            state: "projection_rebuild_required",
            transactionPath: paths.transactionPath,
        });
        expect(fs.readFileSync(path.join(oaamRoot, "profile.txt"), "utf8")).toBe("published");
        expect(fs.readFileSync(path.join(paths.displacedPath, "profile.txt"), "utf8")).toBe("old");
        expect(readStateRestoreMarker(paths.markerPath).phase).toBe("reprojecting");
    });

    it("fails closed on an ambiguous physical tree and maps the public failure to startup recovery", () => {
        const fingerprint = createProfile(oaamRoot, "live");
        const paths = writeMarker("candidate_ready", fingerprint);
        createProfile(paths.stagedPath, "staged");
        createProfile(paths.displacedPath, "displaced");

        expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.physical_state_ambiguous" }),
        );
        expect(() => reconcileStateRestoreBeforeStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "restore_reconciliation",
                evidencePaths: [paths.transactionPath],
            }),
        );
        expect(fs.readFileSync(path.join(oaamRoot, "profile.txt"), "utf8")).toBe("live");
    });

    it("rejects multiple unresolved transactions and preserves both evidence roots", () => {
        const fingerprint = createProfile(oaamRoot, "live");
        const first = writeMarker("staging", fingerprint);
        const second = writeMarker("staging", fingerprint, OTHER_RESTORE_ID);

        expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.multiple_transactions" }),
        );
        expect(fs.existsSync(first.transactionPath)).toBe(true);
        expect(fs.existsSync(second.transactionPath)).toBe(true);
    });

    it("lets Core enter only the exact reprojecting phase", () => {
        const fingerprint = createProfile(oaamRoot, "live");
        const paths = writeMarker("activated", fingerprint);

        expect(() => assertStateProfileRestoreStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({ reason: "restore_reconciliation" }),
        );
        writeMarker("reprojecting", fingerprint);
        expect(assertStateProfileRestoreStartup({ oaamRoot, databasePath })).toMatchObject({
            state: "ready",
            pendingRestore: { transactionPath: paths.transactionPath, marker: { phase: "reprojecting" } },
        });
    });

    it("does not let unrelated symlink siblings poison restore transaction discovery", () => {
        createProfile(oaamRoot, "live");
        const outside = path.join(sandbox, "outside");
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(sandbox, "unrelated-link"));

        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({ state: "none" });
    });

    it("retries only transiently stale parent inventories and remains bounded", () => {
        const makeFailure = (failureKind: "stale" | "permission_denied") =>
            new SafeFilesystemError({
                failureKind,
                operation: "inventory_directory",
                targetPath: sandbox,
                message: `injected ${failureKind}`,
            });

        let transientAttempts = 0;
        expect(
            stateRestoreTransactionInternalsForTest.readRestoreParentEntries(sandbox, (targetPath, maximumEntries) => {
                expect(targetPath).toBe(sandbox);
                expect(maximumEntries).toBe(100_000);
                transientAttempts += 1;
                if (transientAttempts === 1) throw makeFailure("stale");
                return [];
            }),
        ).toEqual([]);
        expect(transientAttempts).toBe(2);

        let exhaustedAttempts = 0;
        expect(() =>
            stateRestoreTransactionInternalsForTest.readRestoreParentEntries(sandbox, () => {
                exhaustedAttempts += 1;
                throw makeFailure("stale");
            }),
        ).toThrow(expect.objectContaining<SafeFilesystemError>({ failureKind: "stale" }));
        expect(exhaustedAttempts).toBe(16);

        let permanentAttempts = 0;
        expect(() =>
            stateRestoreTransactionInternalsForTest.readRestoreParentEntries(sandbox, () => {
                permanentAttempts += 1;
                throw makeFailure("permission_denied");
            }),
        ).toThrow(expect.objectContaining<SafeFilesystemError>({ failureKind: "permission_denied" }));
        expect(permanentAttempts).toBe(1);
    });

    it("strictly validates restore markers and their body fingerprint", () => {
        const paths = transactionPaths();
        const marker = buildRestoreMarker({
            restoreId: RESTORE_ID,
            backupId: BACKUP_ID,
            archiveContentHash: HASH,
            sourceSnapshotFingerprint: HASH,
            profileSnapshotFingerprint: HASH,
            oaamRoot,
            databasePath,
            transactionPath: paths.transactionPath,
            stagedPath: paths.stagedPath,
            displacedPath: paths.displacedPath,
            phase: "staging",
        });

        expect(() => stateRestoreModelInternalsForTest.validateStateRestoreMarkerDocument(null)).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.marker_invalid" }),
        );
        expect(() =>
            stateRestoreModelInternalsForTest.validateStateRestoreMarkerDocument({
                ...marker,
                phase: "future",
            }),
        ).toThrow(expect.objectContaining<StateRestoreError>({ code: "restore.marker_invalid" }));
        expect(() =>
            stateRestoreModelInternalsForTest.validateStateRestoreMarkerDocument({
                ...marker,
                backupId: OTHER_RESTORE_ID,
            }),
        ).toThrow(expect.objectContaining<StateRestoreError>({ code: "restore.marker_fingerprint_mismatch" }));
    });

    it("rejects malformed transaction entries, unreadable markers, and mismatched marker locations", () => {
        const missingParentRoot = path.join(sandbox, "missing-parent", "oaam");
        expect(
            scanStateRestoreTransactions({
                oaamRoot: missingParentRoot,
                databasePath: path.join(missingParentRoot, "index.db"),
            }),
        ).toEqual([]);

        const blockedParent = path.join(sandbox, "blocked-parent");
        fs.writeFileSync(blockedParent, "file");
        expect(() =>
            scanStateRestoreTransactions({
                oaamRoot: path.join(blockedParent, "oaam"),
                databasePath: path.join(blockedParent, "oaam", "index.db"),
            }),
        ).toThrow(SafeFilesystemError);

        const entryPath = transactionPaths().transactionPath;
        fs.writeFileSync(entryPath, "not a directory");
        expect(() => scanStateRestoreTransactions({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.transaction_entry_invalid" }),
        );
        fs.rmSync(entryPath);

        const invalidName = path.join(sandbox, ".oaam.restore-txn-not-a-uuid");
        fs.mkdirSync(invalidName);
        expect(() => scanStateRestoreTransactions({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.transaction_name_invalid" }),
        );
        fs.rmSync(invalidName, { recursive: true });

        fs.mkdirSync(entryPath);
        fs.writeFileSync(path.join(entryPath, RESTORE_MARKER_NAME), "{bad");
        expect(() => scanStateRestoreTransactions({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.marker_unreadable" }),
        );
        fs.rmSync(entryPath, { recursive: true });

        writeMarker("staging", HASH);
        const markerPath = path.join(entryPath, RESTORE_MARKER_NAME);
        const marker = readStateRestoreMarker(markerPath);
        fs.writeFileSync(
            markerPath,
            serializeRestoreMarker(
                buildRestoreMarker({
                    restoreId: marker.restoreId,
                    backupId: marker.backupId,
                    archiveContentHash: marker.archiveContentHash,
                    sourceSnapshotFingerprint: marker.sourceSnapshotFingerprint,
                    profileSnapshotFingerprint: marker.profileSnapshotFingerprint,
                    oaamRoot: path.join(sandbox, "other-root"),
                    databasePath: marker.databasePath,
                    transactionPath: marker.transactionPath,
                    stagedPath: marker.stagedPath,
                    displacedPath: marker.displacedPath,
                    phase: marker.phase,
                }),
            ),
        );
        expect(() => scanStateRestoreTransactions({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.marker_location_mismatch" }),
        );
    });

    it("fails closed on lock contention and a transaction set that changes while locking", () => {
        const fingerprint = createProfile(oaamRoot, "live");
        writeMarker("staging", fingerprint);
        const observation = scanStateRestoreTransactions({ oaamRoot, databasePath })[0];
        expect(observation).toBeDefined();
        const stable = observation as NonNullable<typeof observation>;
        expect(stateRestoreReconciliationInternalsForTest.requireStableTransaction(stable, [stable], sandbox)).toBe(stable);
        expect(() => stateRestoreReconciliationInternalsForTest.requireStableTransaction(stable, [], sandbox)).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.transaction_changed" }),
        );
        expect(() =>
            stateRestoreReconciliationInternalsForTest.requireStableTransaction(
                stable,
                [{ ...stable, marker: { ...stable.marker, restoreId: OTHER_RESTORE_ID } }],
                sandbox,
            ),
        ).toThrow(expect.objectContaining<StateRestoreError>({ code: "restore.transaction_changed" }));
        const restoreConfiguration = stateRestoreServiceInternalsForTest.validateConfiguration({
            oaamRoot,
            databasePath,
            quiesceMutations: async () => undefined,
        });
        expect(() => stateRestoreServiceInternalsForTest.assertNoExistingRestoreTransaction(restoreConfiguration)).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.reconciliation_required" }),
        );

        const restoreLockPath = path.join(sandbox, ".oaam.restore.lock");
        const release = lockFile(restoreLockPath);
        expect(release).not.toBeNull();
        try {
            expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
                expect.objectContaining<StateRestoreError>({ code: "restore.operation_locked" }),
            );
        } finally {
            release?.();
        }
    });

    it("retains an untouched candidate-ready live profile and completes a live-displaced staged profile", () => {
        const fingerprint = createProfile(oaamRoot, "live");
        const retainedPaths = writeMarker("candidate_ready", fingerprint);
        createProfile(retainedPaths.stagedPath, "candidate");
        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({
            state: "retained_current",
            transactionPath: retainedPaths.transactionPath,
        });

        fs.rmSync(oaamRoot, { recursive: true });
        fs.rmSync(retainedPaths.transactionPath, { recursive: true });
        const paths = transactionPaths();
        fs.mkdirSync(paths.transactionPath);
        const stagedFingerprint = createProfile(paths.stagedPath, "restored");
        createProfile(paths.displacedPath, "old");
        writeMarker("live_displaced", stagedFingerprint);
        expect(reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toEqual({
            state: "projection_rebuild_required",
            transactionPath: paths.transactionPath,
        });
        expect(fs.readFileSync(path.join(oaamRoot, "profile.txt"), "utf8")).toBe("restored");
    });

    it.each([
        "live_displaced",
        "activated",
    ] as const)("rejects an ambiguous %s physical state rather than choosing a winner", (phase) => {
        const fingerprint = createProfile(oaamRoot, "live");
        const paths = writeMarker(phase, fingerprint);
        createProfile(paths.stagedPath, "staged");
        createProfile(paths.displacedPath, "old");

        expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.physical_state_ambiguous" }),
        );
    });

    it("rejects missing live authority, a changed restored closure, and a missing restored database", () => {
        const paths = writeMarker("staging", HASH);
        expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.current_state_ambiguous" }),
        );

        fs.rmSync(paths.transactionPath, { recursive: true });
        createProfile(oaamRoot, "live");
        writeMarker("activated", HASH);
        expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.profile_fingerprint_mismatch" }),
        );

        fs.rmSync(oaamRoot, { recursive: true });
        writeMarker("reprojecting", HASH);
        expect(() => reconcileStateRestoreBeforeStartupForTest({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.state_database_invalid" }),
        );
    });

    it("rejects unsupported configuration, unsafe directory entries, and invalid reconciliation clocks", () => {
        expect(() => stateRestoreReconciliationInternalsForTest.validateStartupConfiguration({ oaamRoot: "." })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.configuration_invalid" }),
        );
        expect(() => stateRestoreReconciliationInternalsForTest.validateStartupConfiguration({ oaamRoot: 42 as never })).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.configuration_invalid", targetPath: "" }),
        );
        for (const unsupportedDatabasePath of [
            ":memory:",
            oaamRoot,
            path.join(sandbox, "external.db"),
            path.join(oaamRoot, "backups", "index.db"),
        ]) {
            const configuration = stateRestoreReconciliationInternalsForTest.validateStartupConfiguration({
                oaamRoot,
                databasePath: unsupportedDatabasePath,
            });
            expect(() => stateRestoreReconciliationInternalsForTest.requireRestorableDatabasePath(configuration)).toThrow(
                expect.objectContaining<StateRestoreError>({ code: "restore.database_path_unsupported" }),
            );
        }
        const filePath = path.join(sandbox, "not-a-directory");
        fs.writeFileSync(filePath, "file");
        expect(() => stateRestoreReconciliationInternalsForTest.directoryState(filePath)).toThrow(SafeFilesystemError);
        expect(() => stateRestoreReconciliationInternalsForTest.requireRestoreTime(-1 as never)).toThrow(
            expect.objectContaining<StateRestoreError>({ code: "restore.clock_invalid" }),
        );

        const blockedParent = path.join(sandbox, "blocked-service-parent");
        fs.writeFileSync(blockedParent, "file");
        const blockedConfiguration = stateRestoreServiceInternalsForTest.validateConfiguration({
            oaamRoot: path.join(blockedParent, "oaam"),
            databasePath: path.join(blockedParent, "oaam", "index.db"),
            quiesceMutations: async () => undefined,
        });
        expect(() => stateRestoreServiceInternalsForTest.assertNoExistingRestoreTransaction(blockedConfiguration)).toThrow(
            expect.objectContaining<StateRestoreError>({
                code: "restore.reconciliation_required",
                targetPath: blockedParent,
            }),
        );
    });

    it.each(["aborted", "reconciled"] as const)("treats terminal %s markers as evidence rather than active work", (phase) => {
        writeMarker(phase, HASH);
        const observation = scanStateRestoreTransactions({ oaamRoot, databasePath })[0];
        expect(observation).toBeDefined();
        const configuration = stateRestoreReconciliationInternalsForTest.validateStartupConfiguration({
            oaamRoot,
            databasePath,
        });
        expect(
            stateRestoreReconciliationInternalsForTest.reconcileObservedTransaction(
                configuration,
                observation as NonNullable<typeof observation>,
            ),
        ).toEqual({ state: "none" });
    });

    it("uses the profile parent as public recovery evidence for non-restore filesystem failures", () => {
        fs.writeFileSync(oaamRoot, "not a directory");
        writeMarker("staging", HASH);

        expect(() => reconcileStateRestoreBeforeStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "restore_reconciliation",
                evidencePaths: [sandbox],
            }),
        );
    });

    it("keeps missing or malformed restore transactions out of normal profile startup", () => {
        const missingPaths = writeMarker("reprojecting", HASH);
        expect(() => assertStateProfileRestoreStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "restore_reconciliation",
                evidencePaths: [missingPaths.transactionPath],
            }),
        );

        fs.rmSync(missingPaths.transactionPath, { recursive: true });
        createProfile(oaamRoot, "live");
        fs.writeFileSync(transactionPaths().transactionPath, "invalid transaction entry");
        expect(() => assertStateProfileRestoreStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "restore_reconciliation",
                evidencePaths: [sandbox],
            }),
        );
    });

    it("distinguishes a lost restored database from ordinary missing-database profile evidence", () => {
        fs.mkdirSync(oaamRoot);
        fs.writeFileSync(path.join(oaamRoot, "profile.txt"), "restored material");
        const paths = writeMarker("reprojecting", HASH);

        expect(() => assertStateProfileRestoreStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "restore_reconciliation",
                evidencePaths: [paths.transactionPath],
            }),
        );

        fs.rmSync(paths.transactionPath, { recursive: true });
        expect(() => assertStateProfileRestoreStartup({ oaamRoot, databasePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "missing_database",
                evidencePaths: [path.join(oaamRoot, "profile.txt")],
            }),
        );
    });

    it("keeps an in-memory State DB outside durable restore-transaction discovery", () => {
        expect(
            assertStateProfileRestoreStartup({
                oaamRoot: path.join(sandbox, "memory-profile"),
                databasePath: ":memory:",
            }),
        ).toEqual({ state: "memory" });
    });
});
