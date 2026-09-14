import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import { registerStateBackupArtifact, stateBackupCatalogInternalsForTest } from "../../src/orchestration/state-backup-catalog";
import { stateBackupPolicyInternalsForTest } from "../../src/orchestration/state-backup-policy-service";
import { createStateBackupService } from "../../src/orchestration/state-backup-service";
import { createCoreService } from "../../src/orchestration/core-service";
import { closeDb, getDb } from "../../src/persistence/db";
import type { InspectStateBackupInputV1, StateBackupEncryptionMode, StateBackupPreparationV1, UuidV4 } from "../../src/types";

const BACKUP_ID = "00000000-0000-4000-8000-000000000047" as UuidV4;
const CREATED_AT = 1_721_800_000_000;

describe("State backup catalog and policy authorities", () => {
    let sandbox = "";
    let oaamRoot = "";
    let databasePath = "";
    let customDestination = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-backup-"));
        oaamRoot = path.join(sandbox, ".oaam");
        databasePath = path.join(oaamRoot, "index.db");
        customDestination = path.join(sandbox, "custom-backups");
        fs.mkdirSync(oaamRoot);
        fs.mkdirSync(customDestination);
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function service() {
        return createStateBackupService({
            db: getDb(databasePath),
            oaamRoot,
            databasePath,
            authorityLocksRoot: path.join(oaamRoot, "transactions", "authority-locks"),
            now: () => CREATED_AT,
            newUuid: () => BACKUP_ID,
        });
    }

    function serviceWithRecycle(recycleFileIfIdentity: (filePath: string, expectedIdentity: { entryKind: "file" }) => boolean) {
        return createStateBackupService({
            db: getDb(databasePath),
            oaamRoot,
            databasePath,
            authorityLocksRoot: path.join(oaamRoot, "transactions", "authority-locks"),
            now: () => CREATED_AT,
            newUuid: () => BACKUP_ID,
            recycleFileIfIdentity,
        });
    }

    function inspect(
        encryptionMode: StateBackupEncryptionMode,
        destination: InspectStateBackupInputV1["destination"] = { destinationKind: "oaam_default" },
        desktopPreferences = new TextEncoder().encode('{"theme":"dark"}\n'),
    ) {
        return service().inspectStateBackup({ destination, encryptionMode, desktopPreferences });
    }

    async function create(
        preparation: StateBackupPreparationV1,
        password?: string,
        desktopPreferences = new TextEncoder().encode('{"theme":"dark"}\n'),
    ) {
        return service().createStateBackup({
            preparation,
            password,
            desktopPreferences,
            userActionId: "manual-backup",
        });
    }

    it("registers exact inventory, reports real progress, and detects missing or replaced archives", async () => {
        getDb(databasePath);
        const progress: Array<{ stage: string; completedUnits: number; totalUnits: number }> = [];
        const preparation = service().inspectStateBackup(
            {
                destination: { destinationKind: "custom_directory", directoryPath: customDestination },
                encryptionMode: "strong_password",
            },
            { report: (event) => progress.push(event) },
        );
        const created = await service().createStateBackup(
            {
                preparation: preparation.value,
                password: "secret",
                userActionId: "manual-backup",
            },
            { report: (event) => progress.push(event) },
        );
        expect(created.status).toBe("complete");
        expect(progress.some((event) => event.stage === "inventory")).toBe(true);
        expect(progress.some((event) => event.stage === "packing" && event.completedUnits === event.totalUnits)).toBe(true);
        expect(progress).toContainEqual({ stage: "encryption", completedUnits: 1, totalUnits: 1 });
        expect(progress.some((event) => event.stage === "verification" && event.completedUnits === event.totalUnits)).toBe(true);
        expect(progress).toContainEqual({ stage: "commit", completedUnits: 2, totalUnits: 2 });

        const inventoryProgress: Array<{ stage: string; completedUnits: number; totalUnits: number }> = [];
        const available = service().listStateBackups({ report: (event) => inventoryProgress.push(event) });
        expect(available.value.entries).toHaveLength(1);
        expect(available.value.entries[0]).toMatchObject({
            backupId: BACKUP_ID,
            destinationKind: "custom_directory",
            observation: "available",
        });
        expect(available.value.totalKnownArchiveBytes).toBe(created.value.archiveByteSize);
        expect(available.value.totalAvailableArchiveBytes).toBe(created.value.archiveByteSize);
        expect(inventoryProgress).toEqual([
            { stage: "inventory", completedUnits: 0, totalUnits: 1 },
            { stage: "inventory", completedUnits: 1, totalUnits: 1 },
        ]);

        fs.rmSync(created.value.archivePath);
        expect(service().listStateBackups().value.entries[0]?.observation).toBe("missing");
        fs.writeFileSync(created.value.archivePath, "replacement");
        const replaced = service().listStateBackups();
        expect(replaced.value.entries[0]?.observation).toBe("replaced");
        expect(replaced.value.totalAvailableArchiveBytes).toBe(0);
        fs.rmSync(created.value.archivePath);
        fs.mkdirSync(created.value.archivePath);
        expect(service().listStateBackups().value.entries[0]?.observation).toBe("replaced");
    });

    it("does not let progress observer failures alter backup authority", async () => {
        getDb(databasePath);
        const observer = {
            report(): void {
                throw new Error("renderer disconnected");
            },
        };
        const preparation = service().inspectStateBackup(
            { destination: { destinationKind: "oaam_default" }, encryptionMode: "none" },
            observer,
        );
        const created = await service().createStateBackup(
            { preparation: preparation.value, userActionId: "manual-backup" },
            observer,
        );
        expect(created.status).toBe("complete");
        expect(service().listStateBackups(observer).value.entries[0]?.observation).toBe("available");
    });

    it("fails catalog races closed and leaves a committed but unregistered archive inspectable", async () => {
        getDb(databasePath);
        const preparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        }).value;
        const catalogDirectory = path.join(oaamRoot, "backups");
        fs.mkdirSync(catalogDirectory);
        fs.writeFileSync(path.join(catalogDirectory, "catalog.json"), "{}");
        const result = await create(preparation);
        expect(result.status).toBe("failed");
        expect(fs.existsSync(path.join(customDestination, preparation.outputFileName))).toBe(true);
        expect(service().listStateBackups().status).toBe("failed");
    });

    it("serializes backup catalog mutation with its exact authority lock", async () => {
        getDb(databasePath);
        fs.mkdirSync(path.join(oaamRoot, "transactions"), { recursive: true });
        const locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
        const release = tryAcquireAuthorityLocks(locksRoot, "state_backup", ["catalog"]);
        expect(release).not.toBeNull();
        const preparation = inspect("none").value;
        const result = await create(preparation);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.rawSummary).toContain("catalog is busy");
        release?.();
    });

    it("retires only the exact registered archive through identity-bound recycle or a confirmed external Trash", async () => {
        getDb(databasePath);
        const preparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        }).value;
        const created = await create(preparation);
        const recycle = vi.fn((filePath: string) => {
            fs.rmSync(filePath);
            return true;
        });
        const recyclingService = serviceWithRecycle(recycle);
        expect(
            recyclingService.recycleStateBackup({
                backupId: BACKUP_ID,
                userActionId: " ",
            }).status,
        ).toBe("failed");
        expect(recycle).not.toHaveBeenCalled();

        fs.writeFileSync(created.value.archivePath, "replacement");
        expect(
            recyclingService.recycleStateBackup({
                backupId: BACKUP_ID,
                userActionId: "trash-replaced",
            }).status,
        ).toBe("failed");
        expect(recycle).not.toHaveBeenCalled();
        fs.rmSync(created.value.archivePath);
        expect(
            recyclingService.retireMissingStateBackup({
                backupId: BACKUP_ID,
                userActionId: "external-trash-complete",
            }),
        ).toMatchObject({
            status: "complete",
            value: { schemaVersion: 1, backupId: BACKUP_ID },
        });
        expect(recyclingService.listStateBackups().value.entries).toEqual([]);

        const secondPreparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        }).value;
        const second = await create(secondPreparation);
        expect(
            recyclingService.retireMissingStateBackup({
                backupId: BACKUP_ID,
                userActionId: "still-present",
            }).status,
        ).toBe("failed");
        expect(
            serviceWithRecycle(() => false).recycleStateBackup({
                backupId: BACKUP_ID,
                userActionId: "disappeared-before-recycle",
            }).status,
        ).toBe("failed");
        expect(fs.existsSync(second.value.archivePath)).toBe(true);
        const recycled = recyclingService.recycleStateBackup({
            backupId: BACKUP_ID,
            userActionId: "identity-bound-trash",
        });
        expect(recycled).toMatchObject({
            status: "complete",
            value: { schemaVersion: 1, backupId: BACKUP_ID },
        });
        expect(recycle).toHaveBeenCalledWith(second.value.archivePath, expect.objectContaining({ entryKind: "file" }));
        expect(recyclingService.listStateBackups().value.entries).toEqual([]);
        expect(
            recyclingService.recycleStateBackup({
                backupId: BACKUP_ID,
                userActionId: "already-retired",
            }).status,
        ).toBe("failed");
        expect(
            service().recycleStateBackup({
                backupId: BACKUP_ID,
                userActionId: "default-recycle-without-entry",
            }).status,
        ).toBe("failed");
        expect(
            service().retireMissingStateBackup({
                backupId: BACKUP_ID,
                userActionId: "missing-entry",
            }).status,
        ).toBe("failed");
    });

    it("does not retire a backup while another operation owns the catalog lock", async () => {
        getDb(databasePath);
        const preparation = inspect("none").value;
        await create(preparation);
        const locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
        const release = tryAcquireAuthorityLocks(locksRoot, "state_backup", ["catalog"]);
        expect(release).not.toBeNull();
        try {
            expect(
                serviceWithRecycle(() => true).recycleStateBackup({
                    backupId: BACKUP_ID,
                    userActionId: "busy-recycle",
                }).status,
            ).toBe("failed");
            expect(
                service().retireMissingStateBackup({
                    backupId: BACKUP_ID,
                    userActionId: "busy-retire",
                }).status,
            ).toBe("failed");
        } finally {
            release?.();
        }
    });

    it("rejects mismatched or duplicate catalog registration without changing the current inventory", async () => {
        getDb(databasePath);
        const preparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        }).value;
        const created = await create(preparation);
        expect(created.status).toBe("complete");
        for (const artifact of [
            { ...created.value, backupId: "00000000-0000-4000-8000-000000000048" },
            { ...created.value, createdAt: CREATED_AT + 1 },
            { ...created.value, archivePath: `${created.value.archivePath}.other` },
            { ...created.value, encryptionMode: "strong_password" as const },
            {
                ...created.value,
                sourceSnapshotFingerprint: `sha256:${"f".repeat(64)}` as const,
            },
        ]) {
            expect(() => registerStateBackupArtifact(oaamRoot, preparation, artifact)).toThrow(/preparation/);
        }
        expect(() => registerStateBackupArtifact(oaamRoot, preparation, created.value)).toThrow(/already contains/);
        expect(service().listStateBackups().value.entries).toHaveLength(1);

        const catalogPath = path.join(oaamRoot, "backups", "catalog.json");
        fs.rmSync(catalogPath);
        expect(() =>
            registerStateBackupArtifact(oaamRoot, preparation, {
                ...created.value,
                archiveContentHash: `sha256:${"f".repeat(64)}`,
            }),
        ).toThrow(/changed before inventory/);
    });

    it("validates the strict catalog codec and canonical ordering", async () => {
        getDb(databasePath);
        const firstPreparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        }).value;
        const first = await create(firstPreparation);
        const catalogPath = path.join(oaamRoot, "backups", "catalog.json");
        const valid = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as {
            entries: Array<Record<string, unknown>>;
        };
        expect(() => stateBackupCatalogInternalsForTest.validateCatalog(valid)).not.toThrow();
        const entry = valid.entries[0] as Record<string, unknown>;

        for (const candidate of [
            null,
            { ...valid, extra: true },
            { ...valid, format: "wrong" },
            { ...valid, schemaVersion: 2 },
            { ...valid, entries: "wrong" },
            { ...valid, catalogFingerprint: "wrong" },
            { ...valid, catalogFingerprint: `sha256:${"f".repeat(64)}` },
        ]) {
            expect(() => stateBackupCatalogInternalsForTest.validateCatalog(candidate)).toThrow();
        }
        for (const candidate of [
            null,
            { ...entry, extra: true },
            { ...entry, schemaVersion: 2 },
            { ...entry, backupId: "bad" },
            { ...entry, createdAt: 0 },
            { ...entry, archivePath: "relative" },
            { ...entry, archivePath: path.join(customDestination, "wrong.zip") },
            { ...entry, archiveByteSize: 0 },
            { ...entry, archiveContentHash: "bad" },
            { ...entry, manifestFingerprint: "bad" },
            { ...entry, sourceSnapshotFingerprint: "bad" },
            { ...entry, encryptionMode: "future" },
        ]) {
            expect(() => stateBackupCatalogInternalsForTest.validateEntry(candidate)).toThrow();
        }
        for (const identity of [
            null,
            { deviceId: "d", fileId: "f", entryKind: "file", extra: true },
            { deviceId: "", fileId: "f", entryKind: "file" },
            { deviceId: "d", fileId: "", entryKind: "file" },
            { deviceId: "d", fileId: "f", entryKind: "directory" },
        ]) {
            expect(() => stateBackupCatalogInternalsForTest.validatePhysicalIdentity(identity)).toThrow();
        }

        const secondId = "00000000-0000-4000-8000-000000000048";
        const thirdId = "00000000-0000-4000-8000-000000000049";
        const second = {
            ...entry,
            backupId: secondId,
            archivePath: path.join(customDestination, `oaam-backup-${String(CREATED_AT)}-${secondId}.zip`),
        };
        const third = {
            ...entry,
            backupId: thirdId,
            createdAt: CREATED_AT + 1,
            archivePath: path.join(customDestination, `oaam-backup-${String(CREATED_AT + 1)}-${thirdId}.zip`),
        };
        stateBackupCatalogInternalsForTest.writeCatalog(oaamRoot, [third as never, second as never, entry as never]);
        const sorted = stateBackupCatalogInternalsForTest.readCatalog(oaamRoot);
        expect(sorted.entries.map((item) => item.backupId)).toEqual([BACKUP_ID, secondId, thirdId]);
        expect(
            service()
                .listStateBackups()
                .value.entries.map((item) => item.backupId),
        ).toEqual([thirdId, BACKUP_ID, secondId]);

        const duplicateIdentity = stateBackupCatalogInternalsForTest.buildCatalog([
            entry as never,
            {
                ...entry,
                createdAt: CREATED_AT + 1,
                archivePath: path.join(customDestination, `oaam-backup-${String(CREATED_AT + 1)}-${String(entry.backupId)}.zip`),
            } as never,
        ]);
        expect(() => stateBackupCatalogInternalsForTest.validateCatalog(duplicateIdentity)).toThrow(/identities/);
        const reversed = stateBackupCatalogInternalsForTest.buildCatalog([second as never, entry as never]);
        expect(() => stateBackupCatalogInternalsForTest.validateCatalog(reversed)).toThrow(/canonical/);

        expect(first.status).toBe("complete");
        fs.rmSync(catalogPath);
        fs.mkdirSync(catalogPath);
        expect(() => stateBackupCatalogInternalsForTest.readCatalog(oaamRoot)).toThrow();
    });

    it("projects policy failures from corrupt settings, busy locks, and non-Error causes", () => {
        const root = path.join(sandbox, "policy-profile");
        const core = createCoreService({
            providers: [],
            platformContexts: [],
            oaamRoot: root,
            databasePath: path.join(root, "index.db"),
        });
        const virgin = core.getStateBackupPromptPolicy().value;
        const release = tryAcquireAuthorityLocks(path.join(root, "transactions", "authority-locks"), "settings", ["settings"]);
        expect(release).not.toBeNull();
        expect(
            core.replaceStateBackupPromptPolicy({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                mode: "ask_every_time",
                userActionId: "busy",
            }).status,
        ).toBe("failed");
        release?.();
        fs.writeFileSync(path.join(root, "settings.json"), "{");
        expect(core.getStateBackupPromptPolicy().status).toBe("failed");
        expect(stateBackupPolicyInternalsForTest.failedPolicyResult("plain").diagnostics[0]?.rawSummary).toBe("plain");
    });
});
