import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type { Entry } from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { stateRestoreArchiveInternalsForTest } from "../../src/orchestration/state-restore-archive";
import { StateRestoreError, stateRestoreModelInternalsForTest } from "../../src/orchestration/state-restore-model";
import { stateRestoreServiceInternalsForTest } from "../../src/orchestration/state-restore-service";
import { closeDb } from "../../src/persistence/db";
import type { StateRestorePreparationV1, UuidV4 } from "../../src/types";

const BACKUP_ID = "00000000-0000-4000-8000-000000000147" as UuidV4;
const BACKUP_TIME = 1_721_800_000_000;
const encoder = new TextEncoder();

describe("State restore activation mechanics", () => {
    let sandbox = "";
    let oaamRoot = "";
    let databasePath = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-restore-mechanics-"));
        oaamRoot = path.join(sandbox, ".oaam");
        databasePath = path.join(oaamRoot, "index.db");
        fs.mkdirSync(oaamRoot);
        closeDb();
    });

    afterEach(() => {
        closeDb();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("keeps activation mechanics fail-closed around unexpected paths and occupied targets", () => {
        expect(() => stateRestoreServiceInternalsForTest.requireCanonicalNonRootPath(".", "root")).toThrow(/canonical/u);
        expect(() => stateRestoreServiceInternalsForTest.requireCanonicalNonRootPath(42, "root")).toThrow(/canonical/u);
        expect(() => stateRestoreModelInternalsForTest.portableLogicalPathKey("ok/path")).not.toThrow();
        expect(() =>
            stateRestoreModelInternalsForTest.validateStateRestorePreparation({
                schemaVersion: 2,
            } as StateRestorePreparationV1),
        ).toThrow(/preparation/u);
        expect(
            stateRestoreModelInternalsForTest.normalizeRestoreError(
                new StateRestoreError("existing", "existing", "conflict", false),
            ),
        ).toMatchObject({ code: "existing" });
        expect(() => stateRestoreServiceInternalsForTest.assertDirectoryAbsent(oaamRoot)).toThrow(/occupied/u);
        expect(stateRestoreServiceInternalsForTest.durableDirectoryExists(path.join(sandbox, "missing"))).toBe(false);
        expect(
            stateRestoreServiceInternalsForTest.stagedTargetPath(
                stateRestoreServiceInternalsForTest.validateConfiguration({
                    oaamRoot,
                    databasePath,
                    quiesceMutations: async () => undefined,
                }),
                path.join(sandbox, "stage"),
                "desktop/desktop-preferences.json",
            ),
        ).toBeNull();
        expect(() =>
            stateRestoreServiceInternalsForTest.stagedTargetPath(
                stateRestoreServiceInternalsForTest.validateConfiguration({
                    oaamRoot,
                    databasePath,
                    quiesceMutations: async () => undefined,
                }),
                path.join(sandbox, "stage"),
                "foreign/file",
            ),
        ).toThrow(/no profile mapping/u);
        const configuration = stateRestoreServiceInternalsForTest.validateConfiguration({
            oaamRoot,
            databasePath,
            quiesceMutations: async () => undefined,
        });
        expect(configuration.now()).toBeGreaterThan(0);
        expect(configuration.newUuid()).toMatch(/^[0-9a-f-]{36}$/u);
        expect(() => stateRestoreServiceInternalsForTest.requireRestoreId("invalid" as UuidV4)).toThrow(/invalid UUID v4/u);
        expect(() => stateRestoreServiceInternalsForTest.requireRestoreTime(-1 as never)).toThrow(/invalid activation time/u);
        expect(stateRestoreServiceInternalsForTest.requireRestoreId(BACKUP_ID)).toBe(BACKUP_ID);
        expect(stateRestoreServiceInternalsForTest.requireRestoreTime(BACKUP_TIME)).toBe(BACKUP_TIME);
        for (const relative of ["", "/absolute", "..", `..${path.sep}x`, `x${path.sep}..${path.sep}y`, "backups/x"]) {
            expect(stateRestoreServiceInternalsForTest.isSupportedDatabaseRelativePath(relative)).toBe(false);
        }
        expect(stateRestoreServiceInternalsForTest.isSupportedDatabaseRelativePath("state/index.db")).toBe(true);

        const newDirectory = stateRestoreServiceInternalsForTest.ensureNewDirectory(sandbox, "new", "code", "message");
        expect(newDirectory).toBe(path.join(sandbox, "new"));
        expect(() => stateRestoreServiceInternalsForTest.ensureNewDirectory(sandbox, "new", "code", "message")).toThrow(
            /message/u,
        );
        stateRestoreServiceInternalsForTest.ensureRelativeParentDirectories(
            path.join(sandbox, "new"),
            path.join("nested", "child", "file"),
        );
        stateRestoreServiceInternalsForTest.ensureRelativeParentDirectories(
            path.join(sandbox, "new"),
            path.join("nested", "child", "other"),
        );
        expect(() =>
            stateRestoreServiceInternalsForTest.assertStagedEntry(Uint8Array.of(1), 2, `sha256:${"0".repeat(64)}`, "/tmp/file"),
        ).toThrow(/staged restore body/u);
        expect(() =>
            stateRestoreServiceInternalsForTest.assertStagedEntry(Uint8Array.of(1), 1, `sha256:${"0".repeat(64)}`, "/tmp/file"),
        ).toThrow(/staged restore body/u);
        expect(() =>
            stateRestoreServiceInternalsForTest.requireCurrentStateDatabase(
                path.join(sandbox, "missing.db"),
                "restore.test",
                "not current",
                "verification_failed",
            ),
        ).toThrow(/not current/u);
        const regularFile = path.join(sandbox, "regular");
        fs.writeFileSync(regularFile, "x");
        expect(() => stateRestoreServiceInternalsForTest.durableDirectoryExists(regularFile)).toThrow();

        const displaced = path.join(sandbox, "displaced");
        const staged = path.join(sandbox, "staged");
        fs.mkdirSync(displaced);
        fs.mkdirSync(staged);
        expect(() => stateRestoreServiceInternalsForTest.carryForwardBackupDirectory(displaced, staged)).not.toThrow();
        fs.writeFileSync(path.join(displaced, "backups"), "not a directory");
        expect(() => stateRestoreServiceInternalsForTest.carryForwardBackupDirectory(displaced, staged)).not.toThrow();
        fs.rmSync(path.join(displaced, "backups"));
        fs.symlinkSync(path.join(sandbox, "elsewhere"), path.join(displaced, "backups"));
        expect(() => stateRestoreServiceInternalsForTest.carryForwardBackupDirectory(displaced, staged)).toThrow();

        const collisionStage = path.join(sandbox, "collision-stage");
        fs.mkdirSync(collisionStage);
        const collisionBytes = encoder.encode("same");
        const collisionEntry = {
            logicalPath: "oaam/Duplicate.txt",
            owner: "profile_material" as const,
            contentHash: sha256Bytes(collisionBytes),
            byteSize: collisionBytes.byteLength,
            executable: false,
            bytes: collisionBytes,
        };
        expect(() =>
            stateRestoreServiceInternalsForTest.populateStagedProfile(
                configuration,
                {
                    archivePath: path.join(sandbox, "candidate.zip"),
                    archiveByteSize: 0,
                    archiveContentHash: `sha256:${"0".repeat(64)}`,
                    archiveIdentity: { deviceId: "1", fileId: "1", entryKind: "file" },
                    manifest: {
                        format: "oaam-state-backup-v1",
                        schemaVersion: 1,
                        backupId: BACKUP_ID,
                        createdAt: BACKUP_TIME,
                        encryptionMode: "none",
                        sourceFileCount: 2,
                        sourceLogicalBytes: collisionBytes.byteLength * 2,
                        sourceSnapshotFingerprint: `sha256:${"0".repeat(64)}`,
                        entries: [],
                        manifestFingerprint: `sha256:${"0".repeat(64)}`,
                    },
                    source: {
                        entries: [collisionEntry, { ...collisionEntry, logicalPath: "oaam/duplicate.txt" }],
                        sourceFileCount: 2,
                        sourceLogicalBytes: collisionBytes.byteLength * 2,
                        sourceSnapshotFingerprint: `sha256:${"0".repeat(64)}`,
                    },
                },
                collisionStage,
            ),
        ).toThrow(/multiple entries/u);
    });

    it("exercises pure hostile validators and diagnostic normalization without weakening production checks", async () => {
        const internals = stateRestoreArchiveInternalsForTest;
        for (const unsafe of ["", "/absolute", "trailing/", "back\\slash", "nul\0x", "a//b", "a/./b", "a/../b"]) {
            expect(() => internals.requireSafeArchiveFilename(unsafe)).toThrow(/unsafe path/u);
        }
        expect(internals.unsupportedUnixFileType({ unixMode: 0 } as Entry)).toBe(false);
        expect(internals.unsupportedUnixFileType({ unixMode: 0x8000 } as Entry)).toBe(false);
        expect(internals.unsupportedUnixFileType({ unixMode: 0xa000 } as Entry)).toBe(true);
        expect(internals.unsupportedUnixFileType({} as Entry)).toBe(false);
        expect(() => internals.parseManifestJson(Uint8Array.of(0xff))).toThrow(/UTF-8 JSON/u);
        expect(() => internals.validateArchiveInventory([], ["state/oaam.sqlite"])).toThrow(/inventory/u);
        expect(() => internals.validateArchiveEncryption([{ encrypted: true, zipCrypto: true }] as Entry[], "none")).toThrow(
            /encryption/u,
        );
        expect(() =>
            internals.validateArchiveEncryption([{ encrypted: true, zipCrypto: false }] as Entry[], "compatible_password"),
        ).toThrow(/encryption/u);
        expect(() =>
            internals.validateArchiveEncryption([{ encrypted: false, zipCrypto: false }] as Entry[], "strong_password"),
        ).toThrow(/encryption/u);
        const regularEntries = (sizes: number[]): Entry[] =>
            sizes.map(
                (uncompressedSize, index) =>
                    ({
                        filename: `entry-${String(index)}`,
                        directory: false,
                        encrypted: false,
                        zipCrypto: false,
                        uncompressedSize,
                    }) as Entry,
            );
        expect(() => internals.validateArchiveMetadata([])).toThrow(/entry count/u);
        expect(() => internals.validateArchiveMetadata(regularEntries([0, -1, 0]))).toThrow(/invalid-size/u);
        expect(() => internals.validateArchiveMetadata(regularEntries([0, Number.NaN, 0]))).toThrow(/invalid-size/u);
        expect(() => internals.validateArchiveMetadata(regularEntries([0, 2 ** 31, 0]))).toThrow(/invalid-size/u);
        expect(() => internals.validateArchiveMetadata(regularEntries([400_000_000, 400_000_000, 0]))).toThrow(
            /uncompressed size/u,
        );
        expect(() =>
            internals.validateArchiveMetadata([
                ...regularEntries([0, 0]),
                { ...regularEntries([0])[0], filename: "link", unixMode: 0xa000 } as Entry,
            ]),
        ).toThrow(/device/u);
        await expect(
            internals.extractEntry(
                {
                    filename: "large",
                    uncompressedSize: 2,
                    getData: async () => Uint8Array.of(1),
                } as never,
                undefined,
                1,
                "/tmp/archive.zip",
            ),
        ).rejects.toThrow(/bounded size/u);
        await expect(
            internals.extractEntry(
                {
                    filename: "expanded",
                    uncompressedSize: 1,
                    getData: async () => Uint8Array.of(1, 2),
                } as never,
                undefined,
                1,
                "/tmp/archive.zip",
            ),
        ).rejects.toThrow(/expanded beyond/u);
        await expect(
            internals.extractEntry(
                {
                    filename: "encrypted",
                    encrypted: true,
                    uncompressedSize: 1,
                    getData: async () => {
                        throw new Error("Invalid compressed data");
                    },
                } as never,
                "wrong",
                1,
                "/tmp/archive.zip",
            ),
        ).rejects.toMatchObject({ code: "restore.archive_password_invalid", causeKind: "permission_denied" });
        await expect(
            internals.extractEntry(
                {
                    filename: "plain",
                    encrypted: false,
                    uncompressedSize: 1,
                    getData: async () => {
                        throw new Error("Invalid compressed data");
                    },
                } as never,
                "wrong",
                1,
                "/tmp/archive.zip",
            ),
        ).rejects.toMatchObject({ code: "restore.archive_invalid", causeKind: "invalid_schema" });
        expect(() => internals.requireFileEntry([], "manifest.json")).toThrow(/missing required/u);
        expect(() =>
            internals.assertArchiveIdentity(
                { deviceId: "1", fileId: "1", entryKind: "file" },
                { deviceId: "1", fileId: "2", entryKind: "file" },
                "/tmp/archive.zip",
            ),
        ).toThrow(/identity changed/u);
        expect(() =>
            internals.assertArchiveIdentity(
                { deviceId: "1", fileId: "1", entryKind: "file" },
                { deviceId: "1", fileId: "1", entryKind: "file" },
                "/tmp/archive.zip",
            ),
        ).not.toThrow();

        const normalized = stateRestoreModelInternalsForTest.failedRestoreResult<never>(
            new SafeFilesystemError({
                failureKind: "stale",
                operation: "read_regular_file",
                targetPath: "/tmp/changed",
                message: "changed",
            }),
        );
        expect(normalized.diagnostics[0]).toMatchObject({
            operation: "restore",
            causeKind: "conflict",
            retryable: true,
        });
        const generic = stateRestoreModelInternalsForTest.failedRestoreResult<never>(new Error("unknown"));
        expect(generic.diagnostics[0]?.code).toBe("restore.internal_failure");
        for (const [failureKind, causeKind, retryable] of [
            ["not_found", "not_found", false],
            ["permission_denied", "permission_denied", false],
            ["resource_limit", "unavailable", false],
            ["io_error", "internal_error", true],
            ["wrong_entry_type", "internal_error", false],
        ] as const) {
            const error = new SafeFilesystemError({
                failureKind,
                operation: "read_regular_file",
                targetPath: "/tmp/x",
                message: failureKind,
            });
            expect(stateRestoreModelInternalsForTest.normalizeRestoreError(error)).toMatchObject({
                causeKind,
                retryable,
            });
        }
        expect(
            internals.normalizeArchiveReadFailure(
                new SafeFilesystemError({
                    failureKind: "permission_denied",
                    operation: "read_regular_file",
                    targetPath: "/tmp/x",
                    message: "denied",
                }),
                "/tmp/x",
            ),
        ).toMatchObject({ causeKind: "permission_denied", retryable: false });
        expect(internals.normalizeArchiveReadFailure(new Error("generic"), "/tmp/x")).toMatchObject({
            code: "restore.archive_unreadable",
            retryable: true,
        });
        expect(
            internals.normalizeArchiveFailure(new StateRestoreError("x", "x", "conflict", false), "/tmp/x", undefined),
        ).toMatchObject({ code: "x" });
        expect(internals.normalizeArchiveFailure(new Error("password required"), "/tmp/x", undefined)).toMatchObject({
            code: "restore.archive_password_invalid",
        });
        for (const message of ["Invalid signature", "Invalid compressed data", "Invalid uncompressed size"]) {
            expect(internals.normalizeArchiveFailure(new Error(message), "/tmp/x", "present", true)).toMatchObject({
                code: "restore.archive_password_invalid",
                causeKind: "permission_denied",
            });
            expect(internals.normalizeArchiveFailure(new Error(message), "/tmp/x", "present", false)).toMatchObject({
                code: "restore.archive_invalid",
                causeKind: "invalid_schema",
            });
        }
        expect(internals.normalizeArchiveFailure("not an Error", "/tmp/x", "present")).toMatchObject({
            code: "restore.archive_invalid",
        });
        const existingRestoreError = new StateRestoreError("existing", "existing", "conflict", false);
        expect(internals.normalizeArchiveReadFailure(existingRestoreError, "/tmp/x")).toBe(existingRestoreError);
        for (const [failureKind, causeKind, retryable] of [
            ["not_found", "not_found", false],
            ["resource_limit", "unavailable", false],
            ["io_error", "internal_error", true],
        ] as const) {
            expect(
                internals.normalizeArchiveReadFailure(
                    new SafeFilesystemError({
                        failureKind,
                        operation: "read_regular_file",
                        targetPath: "/tmp/x",
                        message: failureKind,
                    }),
                    "/tmp/x",
                ),
            ).toMatchObject({ causeKind, retryable });
        }
    });
});
