import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockFile } from "@oaam/shared/filesystem";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintDomain } from "../../src/foundation/fingerprint";
import {
    type BackupManifestEntryV1,
    type BackupManifestV1,
    MAXIMUM_BACKUP_FILES,
    MAXIMUM_BACKUP_LOGICAL_BYTES,
} from "../../src/orchestration/state-backup-model";
import { createStateBackupService } from "../../src/orchestration/state-backup-service";
import { readAndValidateStateRestoreArchive } from "../../src/orchestration/state-restore-archive";
import {
    MAXIMUM_RESTORE_ARCHIVE_BYTES,
    RESTORE_MARKER_NAME,
    StateRestoreError,
    type StateRestoreMarkerV1,
    stateRestoreModelInternalsForTest,
} from "../../src/orchestration/state-restore-model";
import {
    createStateRestoreService,
    createStateRestoreServiceForTest,
    stateRestoreServiceInternalsForTest,
} from "../../src/orchestration/state-restore-service";
import { closeDb, getDb } from "../../src/persistence/db";
import type {
    CoreResult,
    StateBackupArtifactV1,
    StateBackupEncryptionMode,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
    UuidV4,
} from "../../src/types";

const BACKUP_ID = "00000000-0000-4000-8000-000000000147" as UuidV4;
const RESTORE_ID = "00000000-0000-4000-8000-000000000247" as UuidV4;
const BACKUP_TIME = 1_721_800_000_000;
const RESTORE_TIME = 1_721_800_001_000;
const encoder = new TextEncoder();

describe("whole-unit State restore", () => {
    let sandbox = "";
    let oaamRoot = "";
    let databasePath = "";
    let externalBackups = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-restore-"));
        oaamRoot = path.join(sandbox, ".oaam");
        databasePath = path.join(oaamRoot, "index.db");
        externalBackups = path.join(sandbox, "external-backups");
        fs.mkdirSync(oaamRoot);
        fs.mkdirSync(externalBackups);
        closeDb();
    });

    afterEach(() => {
        closeDb();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function seedProfile(version: number, label: string): void {
        const db = getDb(databasePath);
        db.pragma(`user_version = ${String(version)}`);
        for (const [relativePath, body] of [
            ["settings.json", `{"label":"${label}"}`],
            ["assets/asset-a/version.json", `${label}-asset`],
            ["projects/project-a/project.json", `${label}-project`],
            ["deployments/deployment-a/deployment.json", `${label}-deployment`],
            ["transactions/deployment-a.journal", `${label}-journal`],
            ["profile-extension.txt", `${label}-extension`],
        ]) {
            const absolutePath = path.join(oaamRoot, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, body);
        }
    }

    async function createBackup(
        encryptionMode: StateBackupEncryptionMode = "none",
        password?: string,
        useExternalDestination = false,
        includeDesktopPreferences = true,
    ): Promise<StateBackupArtifactV1> {
        const desktopPreferences = includeDesktopPreferences ? encoder.encode('{"theme":"dark"}\n') : undefined;
        const service = createStateBackupService({
            db: getDb(databasePath),
            oaamRoot,
            databasePath,
            authorityLocksRoot: path.join(oaamRoot, "transactions", "authority-locks"),
            now: () => BACKUP_TIME,
            newUuid: () => BACKUP_ID,
        });
        const preparation = service.inspectStateBackup({
            destination: useExternalDestination
                ? { destinationKind: "custom_directory", directoryPath: externalBackups }
                : { destinationKind: "oaam_default" },
            encryptionMode,
            desktopPreferences,
        });
        expect(preparation.status).toBe("complete");
        const created = await service.createStateBackup({
            preparation: preparation.value,
            password,
            desktopPreferences,
            userActionId: "create-before-restore",
        });
        expect(created.status).toBe("complete");
        return created.value;
    }

    function restoreService(quiesceMutations: () => Promise<void> = async () => undefined) {
        return createStateRestoreServiceForTest({
            oaamRoot,
            databasePath,
            quiesceMutations,
            now: () => RESTORE_TIME,
            newUuid: () => RESTORE_ID,
        });
    }

    async function inspectRestore(archivePath: string, password?: string): Promise<CoreResult<StateRestorePreparationV1>> {
        return restoreService().inspectStateRestore({ archivePath, password });
    }

    it("restores one verified unit, preserves displaced state, carries backups, and returns Desktop preferences", async () => {
        seedProfile(7, "before");
        const backup = await createBackup();
        const backupName = path.basename(backup.archivePath);

        seedProfile(9, "after");
        fs.writeFileSync(path.join(oaamRoot, "after-only.txt"), "after-only");
        let quiesceCalls = 0;
        const service = restoreService(async () => {
            quiesceCalls += 1;
            expect(getDb(databasePath).pragma("user_version", { simple: true })).toBe(9);
        });
        const inspected = await service.inspectStateRestore({ archivePath: backup.archivePath });
        expect(inspected.status).toBe("complete");
        expect(inspected.value.includesDesktopPreferences).toBe(true);

        const activated = await service.activateStateRestore({
            preparation: inspected.value,
            userActionId: "restore-selected-backup",
        });
        expect(activated.status).toBe("complete");
        expect(quiesceCalls).toBe(1);
        expect(activated.value).toMatchObject({
            schemaVersion: 1,
            restoreId: RESTORE_ID,
            backupId: BACKUP_ID,
            activatedAt: RESTORE_TIME,
            requiresRestart: true,
            displacedState: { state: "preserved" },
        });
        expect(new TextDecoder().decode(activated.value.desktopPreferences)).toBe('{"theme":"dark"}\n');
        expect(fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf8")).toBe('{"label":"before"}');
        expect(fs.existsSync(path.join(oaamRoot, "after-only.txt"))).toBe(false);
        expect(fs.existsSync(path.join(oaamRoot, "backups", backupName))).toBe(true);
        expect(getDb(databasePath).pragma("user_version", { simple: true })).toBe(7);

        const displaced = requirePreservedPath(activated.value);
        expect(fs.readFileSync(path.join(displaced, "settings.json"), "utf8")).toBe('{"label":"after"}');
        expect(fs.readFileSync(path.join(displaced, "after-only.txt"), "utf8")).toBe("after-only");
        expect(fs.existsSync(path.join(displaced, "backups"))).toBe(false);
        closeDb();
        expect(getDb(path.join(displaced, "index.db")).pragma("user_version", { simple: true })).toBe(9);
        closeDb();

        const marker = JSON.parse(
            fs.readFileSync(path.join(activated.value.restoreTransactionPath, RESTORE_MARKER_NAME), "utf8"),
        ) as StateRestoreMarkerV1;
        expect(marker.phase).toBe("activated");
        expect(marker.markerFingerprint).toBe(
            fingerprintDomain("oaam.restore.transaction-marker.v1", {
                format: marker.format,
                schemaVersion: marker.schemaVersion,
                restoreId: marker.restoreId,
                backupId: marker.backupId,
                archiveContentHash: marker.archiveContentHash,
                sourceSnapshotFingerprint: marker.sourceSnapshotFingerprint,
                profileSnapshotFingerprint: marker.profileSnapshotFingerprint,
                oaamRoot: marker.oaamRoot,
                databasePath: marker.databasePath,
                transactionPath: marker.transactionPath,
                stagedPath: marker.stagedPath,
                displacedPath: marker.displacedPath,
                phase: marker.phase,
            }),
        );
    });

    it("restores into a missing profile without inventing displaced material", async () => {
        seedProfile(4, "portable");
        const backup = await createBackup("none", undefined, true, false);
        closeDb();
        const former = path.join(sandbox, "former-profile");
        fs.renameSync(oaamRoot, former);

        const inspected = await inspectRestore(backup.archivePath);
        expect(inspected.status).toBe("complete");
        const activated = await restoreService().activateStateRestore({
            preparation: inspected.value,
            userActionId: "restore-into-missing-profile",
        });
        expect(activated.status).toBe("complete");
        expect(activated.value.displacedState).toEqual({ state: "none" });
        expect(activated.value.desktopPreferences).toBeUndefined();
        expect(fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf8")).toBe('{"label":"portable"}');
        expect(getDb(databasePath).pragma("user_version", { simple: true })).toBe(4);
    });

    it.each([
        ["compatible_password", "x"],
        ["strong_password", "correct horse battery staple"],
    ] as const)("validates and restores the %s backup mode only with its transient password", async (mode, password) => {
        seedProfile(3, mode);
        const backup = await createBackup(mode, password);
        closeDb();

        const wrong = await restoreService().inspectStateRestore({ archivePath: backup.archivePath, password: "wrong" });
        expect(wrong.status).toBe("failed");
        expect(wrong.diagnostics[0]?.code).toBe("restore.archive_password_invalid");

        const inspected = await restoreService().inspectStateRestore({ archivePath: backup.archivePath, password });
        expect(inspected.status).toBe("complete");
        const activated = await restoreService().activateStateRestore({
            preparation: inspected.value,
            password,
            userActionId: "password-restore",
        });
        expect(activated.status).toBe("complete");
    });

    it("binds activation to the reviewed archive bytes, preparation, user action and exclusive transaction", async () => {
        seedProfile(2, "bound");
        const first = await createBackup("none", undefined, true);
        const originalArchiveBytes = fs.readFileSync(first.archivePath);
        const inspected = await inspectRestore(first.archivePath);
        expect(inspected.status).toBe("complete");

        const noAction = await restoreService().activateStateRestore({
            preparation: inspected.value,
            userActionId: " ",
        });
        expect(noAction.diagnostics[0]?.code).toBe("restore.user_action_missing");

        const modifiedPreparation = {
            ...inspected.value,
            sourceFileCount: inspected.value.sourceFileCount + 1,
        };
        const modified = await restoreService().activateStateRestore({
            preparation: modifiedPreparation,
            userActionId: "modified",
        });
        expect(modified.diagnostics[0]?.code).toMatch(/restore\.preparation_/u);

        const repackedArchive = await rewriteZip(first.archivePath, (entries) => entries);
        fs.copyFileSync(repackedArchive, first.archivePath);
        const changed = await restoreService().activateStateRestore({
            preparation: inspected.value,
            userActionId: "changed",
        });
        expect(changed.diagnostics[0]?.code).toBe("restore.archive_changed");

        const secondArchivePath = path.join(externalBackups, "second.zip");
        fs.writeFileSync(secondArchivePath, originalArchiveBytes);
        const secondInspection = await inspectRestore(secondArchivePath);
        const release = lockFile(path.join(sandbox, `.${path.basename(oaamRoot)}.restore.lock`));
        expect(release).not.toBeNull();
        try {
            const locked = await restoreService().activateStateRestore({
                preparation: secondInspection.value,
                userActionId: "locked",
            });
            expect(locked.diagnostics[0]?.code).toBe("restore.operation_locked");
        } finally {
            release?.();
        }

        const existingTransaction = path.join(sandbox, `.${path.basename(oaamRoot)}.restore-txn-existing`);
        fs.mkdirSync(existingTransaction);
        const blocked = await restoreService().activateStateRestore({
            preparation: secondInspection.value,
            userActionId: "existing-transaction",
        });
        expect(blocked.diagnostics[0]?.code).toBe("restore.reconciliation_required");
    });

    it("keeps live State untouched when Host mutation quiescence fails", async () => {
        seedProfile(2, "live");
        const backup = await createBackup("none", undefined, true);
        const service = restoreService(async () => {
            throw new Error("mutation drain failed");
        });
        const inspected = await service.inspectStateRestore({ archivePath: backup.archivePath });
        const result = await service.activateStateRestore({
            preparation: inspected.value,
            userActionId: "quiescence-failure",
        });

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("restore.internal_failure");
        expect(fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf8")).toBe('{"label":"live"}');
        const transactionPath = restoreTransactionPath(sandbox, oaamRoot);
        const marker = JSON.parse(
            fs.readFileSync(path.join(transactionPath, RESTORE_MARKER_NAME), "utf8"),
        ) as StateRestoreMarkerV1;
        expect(marker.phase).toBe("candidate_ready");
        expect(fs.existsSync(marker.stagedPath)).toBe(true);
        expect(fs.existsSync(marker.displacedPath)).toBe(false);
    });

    it("preserves staged and displaced material when activation fails after live displacement", async () => {
        seedProfile(2, "backup");
        const backup = await createBackup();
        seedProfile(9, "live");
        const service = restoreService(async () => {
            const transactionPath = restoreTransactionPath(sandbox, oaamRoot);
            const stagedBackups = path.join(transactionPath, "staged", "backups");
            fs.mkdirSync(stagedBackups);
            fs.writeFileSync(path.join(stagedBackups, "collision"), "force non-empty target");
        });
        const inspected = await service.inspectStateRestore({ archivePath: backup.archivePath });
        const result = await service.activateStateRestore({
            preparation: inspected.value,
            userActionId: "post-displacement-failure",
        });

        expect(result.status).toBe("failed");
        expect(fs.existsSync(oaamRoot)).toBe(false);
        const transactionPath = restoreTransactionPath(sandbox, oaamRoot);
        const marker = JSON.parse(
            fs.readFileSync(path.join(transactionPath, RESTORE_MARKER_NAME), "utf8"),
        ) as StateRestoreMarkerV1;
        expect(marker.phase).toBe("live_displaced");
        expect(fs.readFileSync(path.join(marker.stagedPath, "settings.json"), "utf8")).toBe('{"label":"backup"}');
        expect(fs.readFileSync(path.join(marker.displacedPath, "settings.json"), "utf8")).toBe('{"label":"live"}');
    });

    it("rejects unsafe configuration and archive paths before touching live State", async () => {
        const configurationCases: Array<Parameters<typeof createStateRestoreService>[0]> = [
            { oaamRoot: ".", databasePath, quiesceMutations: async () => undefined },
            { oaamRoot: path.parse(oaamRoot).root, databasePath, quiesceMutations: async () => undefined },
            { oaamRoot, databasePath: ":memory:", quiesceMutations: async () => undefined },
            { oaamRoot, databasePath: path.join(sandbox, "external.db"), quiesceMutations: async () => undefined },
            { oaamRoot, databasePath: path.join(oaamRoot, "backups", "index.db"), quiesceMutations: async () => undefined },
        ];
        for (const configuration of configurationCases) {
            expect(() => createStateRestoreService(configuration)).toThrow(StateRestoreError);
        }

        for (const archivePath of ["relative.zip", path.parse(oaamRoot).root, `${oaamRoot}${path.sep}`, `${oaamRoot}\0x`]) {
            const result = await restoreService().inspectStateRestore({ archivePath });
            expect(result.diagnostics[0]?.code).toBe("restore.archive_path_invalid");
        }
        const nonStringPath = await restoreService().inspectStateRestore({ archivePath: 42 as never });
        expect(nonStringPath.diagnostics[0]?.code).toBe("restore.archive_path_invalid");
        const missing = await restoreService().inspectStateRestore({ archivePath: path.join(sandbox, "missing.zip") });
        expect(missing.diagnostics[0]?.causeKind).toBe("not_found");
        const defaultTestAuthorities = createStateRestoreServiceForTest({
            oaamRoot,
            databasePath,
            quiesceMutations: async () => undefined,
        });
        const defaultAuthorityFailure = await defaultTestAuthorities.inspectStateRestore({
            archivePath: path.join(sandbox, "still-missing.zip"),
        });
        expect(defaultAuthorityFailure.diagnostics[0]?.causeKind).toBe("not_found");
    });

    it("rejects hostile ZIP inventory, manifest, body and format mutations", async () => {
        seedProfile(6, "hostile");
        const backup = await createBackup("none", undefined, true);
        closeDb();

        const traversal = await rewriteZip(backup.archivePath, (entries) => [
            ...entries,
            { filename: "../escape", bytes: encoder.encode("escape") },
        ]);
        expect((await inspectRestore(traversal)).diagnostics[0]?.code).toBe("restore.archive_path_invalid");

        const collision = await rewriteZip(backup.archivePath, (entries) => [
            ...entries,
            { filename: "README.TXT", bytes: encoder.encode("collision") },
        ]);
        expect((await inspectRestore(collision)).diagnostics[0]?.code).toBe("restore.archive_path_collision");

        const directory = await rewriteZip(backup.archivePath, (entries) => [
            ...entries,
            { filename: "directory/", bytes: new Uint8Array(), directory: true },
        ]);
        expect((await inspectRestore(directory)).diagnostics[0]?.code).toMatch(/restore\.archive_/u);

        const missingReadme = await rewriteZip(backup.archivePath, (entries) =>
            entries.filter((entry) => entry.filename !== "README.txt"),
        );
        expect((await inspectRestore(missingReadme)).diagnostics[0]?.code).toBe("restore.archive_inventory_mismatch");

        const badManifest = await rewriteZip(backup.archivePath, (entries) =>
            entries.map((entry) =>
                entry.filename === "manifest.json" ? { ...entry, bytes: encoder.encode("{bad-json") } : entry,
            ),
        );
        expect((await inspectRestore(badManifest)).diagnostics[0]?.code).toBe("restore.manifest_invalid");

        const badBody = await rewriteZip(backup.archivePath, (entries) =>
            entries.map((entry) =>
                entry.filename === "oaam/settings.json" ? { ...entry, bytes: encoder.encode("tampered") } : entry,
            ),
        );
        expect((await inspectRestore(badBody)).diagnostics[0]?.code).toBe("restore.archive_body_mismatch");

        const garbage = path.join(sandbox, "garbage.zip");
        fs.writeFileSync(garbage, "not a zip");
        expect((await inspectRestore(garbage)).diagnostics[0]?.code).toBe("restore.archive_invalid");
    });

    it("strictly validates every preparation and manifest authority field", async () => {
        seedProfile(8, "strict");
        const backup = await createBackup("none", undefined, true);
        const candidate = await readAndValidateStateRestoreArchive(backup.archivePath, undefined);
        const preparation = stateRestoreServiceInternalsForTest.buildPreparation(candidate);

        const invalidPreparations: Array<[keyof StateRestorePreparationV1, unknown]> = [
            ["schemaVersion", 2],
            ["archiveByteSize", -1],
            ["archiveByteSize", MAXIMUM_RESTORE_ARCHIVE_BYTES + 1],
            ["archiveContentHash", "sha256:bad"],
            ["backupId", "bad-id"],
            ["backupCreatedAt", -1],
            ["sourceFileCount", -1],
            ["sourceFileCount", MAXIMUM_BACKUP_FILES + 1],
            ["sourceLogicalBytes", -1],
            ["sourceLogicalBytes", MAXIMUM_BACKUP_LOGICAL_BYTES + 1],
            ["sourceSnapshotFingerprint", "sha256:bad"],
            ["manifestFingerprint", "sha256:bad"],
            ["includesDesktopPreferences", "yes"],
            ["preparationFingerprint", "sha256:bad"],
        ];
        for (const [field, value] of invalidPreparations) {
            expect(() =>
                stateRestoreModelInternalsForTest.validateStateRestorePreparation({
                    ...preparation,
                    [field]: value,
                } as StateRestorePreparationV1),
            ).toThrow(/preparation/u);
        }
        const wrongEncryption = {
            ...preparation,
            encryptionMode: "future",
        } as unknown as StateRestorePreparationV1;
        expect(() => stateRestoreModelInternalsForTest.validateStateRestorePreparation(wrongEncryption)).toThrow(
            /encryption mode/u,
        );
        const refingerprinted = {
            ...preparation,
            sourceFileCount: preparation.sourceFileCount - 1,
        };
        refingerprinted.preparationFingerprint = fingerprintDomain(
            "oaam.restore.preparation.v1",
            stateRestoreModelInternalsForTest.restorePreparationPreimage(refingerprinted),
        );
        expect(() => stateRestoreModelInternalsForTest.validateStateRestorePreparation(refingerprinted)).not.toThrow();
        refingerprinted.preparationFingerprint = preparation.preparationFingerprint;
        expect(() => stateRestoreModelInternalsForTest.validateStateRestorePreparation(refingerprinted)).toThrow(
            /no longer matches/u,
        );

        const manifest = structuredClone(candidate.manifest);
        const invalidTopLevels: Array<[keyof BackupManifestV1, unknown]> = [
            ["format", "future"],
            ["schemaVersion", 2],
            ["backupId", "bad-id"],
            ["createdAt", -1],
            ["sourceFileCount", -1],
            ["sourceFileCount", MAXIMUM_BACKUP_FILES + 1],
            ["sourceLogicalBytes", -1],
            ["sourceLogicalBytes", MAXIMUM_BACKUP_LOGICAL_BYTES + 1],
            ["sourceSnapshotFingerprint", "sha256:bad"],
            ["entries", "not-an-array"],
            ["manifestFingerprint", "sha256:bad"],
        ];
        expect(() => stateRestoreModelInternalsForTest.validateBackupManifestDocument(null)).toThrow(/top-level/u);
        expect(() => stateRestoreModelInternalsForTest.validateBackupManifestDocument({ ...manifest, extra: true })).toThrow(
            /top-level/u,
        );
        for (const [field, value] of invalidTopLevels) {
            expect(() =>
                stateRestoreModelInternalsForTest.validateBackupManifestDocument({
                    ...manifest,
                    [field]: value,
                }),
            ).toThrow(/top-level/u);
        }
        expect(() =>
            stateRestoreModelInternalsForTest.validateBackupManifestDocument({
                ...manifest,
                encryptionMode: "future",
            }),
        ).toThrow(/encryption mode/u);

        const firstEntry = manifest.entries[0] as BackupManifestEntryV1;
        const invalidEntries: Array<Partial<Record<keyof BackupManifestEntryV1, unknown>> & Record<string, unknown>> = [
            { logicalPath: 42 },
            { owner: "foreign" },
            { contentHash: "sha256:bad" },
            { byteSize: -1 },
            { byteSize: MAXIMUM_BACKUP_LOGICAL_BYTES + 1 },
            { executable: "yes" },
            { extra: true },
        ];
        for (const mutation of invalidEntries) {
            expect(() =>
                stateRestoreModelInternalsForTest.validateBackupManifestDocument({
                    ...manifest,
                    entries: [{ ...firstEntry, ...mutation }, ...manifest.entries.slice(1)],
                }),
            ).toThrow(/invalid entry/u);
        }
        expect(() =>
            stateRestoreModelInternalsForTest.validateBackupManifestDocument({
                ...manifest,
                entries: [null, ...manifest.entries.slice(1)],
            }),
        ).toThrow(/invalid entry/u);
        expect(() =>
            stateRestoreModelInternalsForTest.validateBackupManifestDocument({
                ...manifest,
                sourceFileCount: manifest.sourceFileCount + 1,
            }),
        ).toThrow(/file count/u);
        expect(() =>
            stateRestoreModelInternalsForTest.validateBackupManifestDocument({
                ...manifest,
                sourceLogicalBytes: manifest.sourceLogicalBytes + 1,
            }),
        ).toThrow(/logical byte count/u);

        const refingerprintedManifest = refingerprintManifest({
            ...manifest,
            sourceSnapshotFingerprint: `sha256:${"0".repeat(64)}`,
        });
        refingerprintedManifest.sourceSnapshotFingerprint = `sha256:${"f".repeat(64)}`;
        expect(() => stateRestoreModelInternalsForTest.validateBackupManifestDocument(refingerprintedManifest)).toThrow(
            /source snapshot fingerprint/u,
        );

        const wrongManifestFingerprint = refingerprintManifest(manifest);
        wrongManifestFingerprint.manifestFingerprint = `sha256:${"0".repeat(64)}`;
        expect(() => stateRestoreModelInternalsForTest.validateBackupManifestDocument(wrongManifestFingerprint)).toThrow(
            /manifest fingerprint/u,
        );
    });

    it("rejects logical-path ambiguity, owner drift and incomplete State membership", async () => {
        seedProfile(5, "logical");
        const backup = await createBackup("none", undefined, true);
        const candidate = await readAndValidateStateRestoreArchive(backup.archivePath, undefined);
        const entries = candidate.manifest.entries;
        const state = entries.find((entry) => entry.logicalPath === "state/oaam.sqlite") as BackupManifestEntryV1;

        expect(() =>
            stateRestoreModelInternalsForTest.assertManifestEntryOrderAndOwnership([
                state,
                { ...state, logicalPath: "STATE/oaam.sqlite" },
            ]),
        ).toThrow(/colliding/u);
        expect(() => stateRestoreModelInternalsForTest.assertManifestEntryOrderAndOwnership([...entries].reverse())).toThrow(
            /canonical UTF-8/u,
        );
        expect(() =>
            stateRestoreModelInternalsForTest.assertManifestEntryOrderAndOwnership([{ ...state, owner: "profile_material" }]),
        ).toThrow(/owner/u);
        expect(() => stateRestoreModelInternalsForTest.assertManifestEntryOrderAndOwnership([])).toThrow(/exactly one State DB/u);

        for (const unsafe of ["", "/absolute", "trailing/", "back\\slash", "nul\0x", "a//b", "a/./b", "a/../b"]) {
            expect(() => stateRestoreModelInternalsForTest.portableLogicalPathKey(unsafe)).toThrow(/not portable/u);
        }
        for (const excluded of ["oaam/backups/x", "oaam/cache/x", "oaam/logs/x"]) {
            expect(() => stateRestoreModelInternalsForTest.requiredOwnerForLogicalPath(excluded)).toThrow(/excluded/u);
        }
        expect(() => stateRestoreModelInternalsForTest.requiredOwnerForLogicalPath("foreign/file")).toThrow(/unsupported/u);
        expect(() => stateRestoreModelInternalsForTest.requiredOwnerForLogicalPath("oaam/transactions/locks/x")).toThrow(
            /excluded lock/u,
        );
        expect(() =>
            stateRestoreModelInternalsForTest.requiredOwnerForLogicalPath("oaam/transactions/authority-locks/x"),
        ).toThrow(/excluded lock/u);
        expect(stateRestoreModelInternalsForTest.requiredOwnerForLogicalPath("oaam/other/file")).toBe("profile_material");
    });
});

interface RewrittenZipEntry {
    filename: string;
    bytes: Uint8Array;
    directory?: boolean;
}

async function rewriteZip(sourcePath: string, transform: (entries: RewrittenZipEntry[]) => RewrittenZipEntry[]): Promise<string> {
    const reader = new ZipReader(new Uint8ArrayReader(fs.readFileSync(sourcePath)), { useWebWorkers: false });
    const sourceEntries = await reader.getEntries();
    const entries: RewrittenZipEntry[] = [];
    for (const entry of sourceEntries) {
        entries.push({
            filename: entry.filename,
            bytes:
                entry.directory || !("getData" in entry)
                    ? new Uint8Array()
                    : await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false }),
            directory: entry.directory,
        });
    }
    await reader.close();

    const targetPath = `${sourcePath}.${String((rewriteCounter += 1))}.zip`;
    const output = new Uint8ArrayWriter();
    const writer = new ZipWriter(output, { useWebWorkers: false });
    for (const entry of transform(entries)) {
        await writer.add(
            entry.filename,
            entry.directory ? undefined : new Uint8ArrayReader(entry.bytes),
            entry.directory ? { directory: true } : undefined,
        );
    }
    fs.writeFileSync(targetPath, await writer.close());
    return targetPath;
}

let rewriteCounter = 0;

function requirePreservedPath(activation: StateRestoreActivationV1): string {
    if (activation.displacedState.state !== "preserved") throw new Error("expected displaced state");
    return activation.displacedState.path;
}

function restoreTransactionPath(sandbox: string, oaamRoot: string): string {
    const prefix = `.${path.basename(oaamRoot)}.restore-txn-`;
    const entries = fs.readdirSync(sandbox).filter((entry) => entry.startsWith(prefix));
    if (entries.length !== 1) throw new Error(`expected one restore transaction, found ${String(entries.length)}`);
    return path.join(sandbox, entries[0] as string);
}

function refingerprintManifest(source: BackupManifestV1): BackupManifestV1 {
    const preimage: Omit<BackupManifestV1, "manifestFingerprint"> = {
        format: source.format,
        schemaVersion: source.schemaVersion,
        backupId: source.backupId,
        createdAt: source.createdAt,
        encryptionMode: source.encryptionMode,
        sourceFileCount: source.sourceFileCount,
        sourceLogicalBytes: source.sourceLogicalBytes,
        sourceSnapshotFingerprint: source.sourceSnapshotFingerprint,
        entries: source.entries,
    };
    return {
        ...preimage,
        manifestFingerprint: fingerprintDomain("oaam.backup.manifest.v1", preimage),
    };
}
