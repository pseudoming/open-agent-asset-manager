import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SafeFilesystemError, type PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { buildAndVerifyBackupArchive, stateBackupArchiveInternalsForTest } from "../../src/orchestration/state-backup-archive";
import {
    assertPortableBackupPaths,
    failedBackupResult,
    MAXIMUM_BACKUP_FILES,
    MAXIMUM_BACKUP_LOGICAL_BYTES,
    StateBackupError,
    type CapturedBackupEntry,
    type CapturedBackupSource,
} from "../../src/orchestration/state-backup-model";
import { createStateBackupService, stateBackupInternalsForTest } from "../../src/orchestration/state-backup-service";
import { stateBackupSourceInternalsForTest } from "../../src/orchestration/state-backup-source";
import { createCoreService } from "../../src/orchestration/core-service";
import { closeDb, getDb } from "../../src/persistence/db";
import type {
    CreateStateBackupInputV1,
    InspectStateBackupInputV1,
    StateBackupEncryptionMode,
    StateBackupPreparationV1,
    UuidV4,
} from "../../src/types";

const BACKUP_ID = "00000000-0000-4000-8000-000000000047" as UuidV4;
const CREATED_AT = 1_721_800_000_000;

describe("complete immutable State backup", () => {
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

    function seedAuthorityClosure(): void {
        const files: Array<[string, string]> = [
            ["assets/asset-a/version.json", "asset"],
            ["projects/project-a/project.json", "project"],
            ["deployments/deployment-a/deployment.json", "deployment"],
            ["transactions/deployment-a.journal", "journal"],
            ["settings.json", '{"configVersion":1}'],
            ["profile-extension.txt", "extension"],
            ["assets/.staging/ignored.tmp", "ignored"],
            ["deployments/deployment-a/.staging/ignored.tmp", "ignored"],
            ["transactions/locks/ignored.lock", "ignored"],
            ["transactions/authority-locks/ignored.lock", "ignored"],
            ["cache/ignored.bin", "ignored"],
            ["logs/ignored.log", "ignored"],
            ["backups/ignored.zip", "ignored"],
        ];
        for (const [relativePath, body] of files) {
            const absolutePath = path.join(oaamRoot, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, body);
        }
    }

    it.each([
        ["none", undefined],
        ["compatible_password", "x"],
        ["strong_password", "correct horse battery staple"],
    ] as const)("creates and independently opens a %s standard ZIP", async (encryptionMode, password) => {
        getDb(databasePath);
        seedAuthorityClosure();
        const preparation = inspect(encryptionMode);
        expect(preparation.status).toBe("complete");
        expect(preparation.value.destination.directoryState).toBe("ready");
        expect(preparation.value.sourceFileCount).toBe(8);

        const result = await create(preparation.value, password);
        expect(result.status).toBe("complete");
        expect(result.value.archivePath).toBe(path.join(oaamRoot, "backups", preparation.value.outputFileName));
        expect(result.value.encryptionMode).toBe(encryptionMode);
        expect(fs.statSync(result.value.archivePath).size).toBe(result.value.archiveByteSize);

        const reader = new ZipReader(new Uint8ArrayReader(fs.readFileSync(result.value.archivePath)));
        const entries = await reader.getEntries();
        const names = entries.map((entry) => entry.filename).sort();
        expect(names).toEqual([
            "README.txt",
            "desktop/desktop-preferences.json",
            "manifest.json",
            "oaam/assets/asset-a/version.json",
            "oaam/deployments/deployment-a/deployment.json",
            "oaam/profile-extension.txt",
            "oaam/projects/project-a/project.json",
            "oaam/settings.json",
            "oaam/transactions/deployment-a.journal",
            "state/oaam.sqlite",
        ]);
        const manifestEntry = entries.find((entry) => entry.filename === "manifest.json");
        expect(manifestEntry?.directory).toBe(false);
        if (manifestEntry === undefined || manifestEntry.directory || !("getData" in manifestEntry)) {
            throw new Error("manifest file entry is missing");
        }
        const manifest = JSON.parse(
            new TextDecoder().decode(await manifestEntry.getData(new Uint8ArrayWriter(), { password })),
        ) as { format: string; backupId: string; entries: Array<{ logicalPath: string }> };
        expect(manifest.format).toBe("oaam-state-backup-v1");
        expect(manifest.backupId).toBe(BACKUP_ID);
        expect(manifest.entries.some((entry) => entry.logicalPath.includes("ignored"))).toBe(false);
        await reader.close();
    });

    it("uses an exact custom destination and refuses to overwrite an existing immutable output", async () => {
        getDb(databasePath);
        const preparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        });
        expect(preparation.status).toBe("complete");
        expect(preparation.value.destination.directoryState).toBe("ready");
        const first = await create(preparation.value);
        expect(first.status).toBe("complete");

        const secondPreparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        });
        expect(secondPreparation.status).toBe("failed");
        expect(secondPreparation.diagnostics[0]?.code).toBe("backup.output_exists");
    });

    it("creates the default backup directory only after the reviewed action and exposes the public Core route", async () => {
        getDb(databasePath);
        const preparation = inspect("none", { destinationKind: "oaam_default" }, undefined);
        expect(preparation.value.destination.directoryState).toBe("create_required");
        const created = await create(preparation.value, undefined, undefined);
        expect(created.status).toBe("complete");

        closeDb();
        clearRegistry();
        const publicRoot = path.join(sandbox, "public-profile");
        const publicDatabase = path.join(publicRoot, "index.db");
        const core = createCoreService({
            providers: [],
            platformContexts: [],
            oaamRoot: publicRoot,
            databasePath: publicDatabase,
        });
        const publicPreparation = core.inspectStateBackup({
            destination: { destinationKind: "oaam_default" },
            encryptionMode: "none",
        });
        expect(publicPreparation.status).toBe("complete");
        expect(publicPreparation.value.backupId).toMatch(/^[0-9a-f-]{36}$/);
        expect(core.listStateBackups()).toMatchObject({
            status: "complete",
            value: { schemaVersion: 1, entries: [], totalKnownArchiveBytes: 0, totalAvailableArchiveBytes: 0 },
        });
        const policy = core.getStateBackupPromptPolicy();
        expect(policy.value).toMatchObject({ revision: 0, mode: "ask_every_time" });
        const remembered = core.replaceStateBackupPromptPolicy({
            expectedRevision: policy.value.revision,
            expectedSettingFingerprint: policy.value.settingFingerprint,
            mode: "back_up_first",
            userActionId: "remember-backup-first",
        });
        expect(remembered.value).toMatchObject({ revision: 1, mode: "back_up_first" });
        expect(
            core.replaceStateBackupPromptPolicy({
                expectedRevision: 0,
                expectedSettingFingerprint: policy.value.settingFingerprint,
                mode: "ask_every_time",
                userActionId: "stale",
            }).status,
        ).toBe("failed");
    });

    it("fails closed when reviewed source bytes or destination identity change", async () => {
        getDb(databasePath);
        const sourcePreparation = inspect("none");
        fs.writeFileSync(path.join(oaamRoot, "changed.txt"), "changed");
        const staleSource = await create(sourcePreparation.value);
        expect(staleSource.status).toBe("failed");
        expect(staleSource.diagnostics[0]?.code).toBe("backup.source_changed");

        fs.rmSync(path.join(oaamRoot, "changed.txt"));
        const destinationPreparation = inspect("none", {
            destinationKind: "custom_directory",
            directoryPath: customDestination,
        });
        fs.renameSync(customDestination, `${customDestination}-replaced`);
        fs.mkdirSync(customDestination);
        const staleDestination = await create(destinationPreparation.value);
        expect(staleDestination.status).toBe("failed");
        expect(staleDestination.diagnostics[0]?.code).toBe("backup.destination_changed");
    });

    it("rejects missing authority, modified preparations, invalid passwords and invalid modes", async () => {
        getDb(databasePath);
        const preparation = inspect("none").value;
        const missingAction: CreateStateBackupInputV1 = {
            preparation,
            userActionId: " ",
        };
        expect((await service().createStateBackup(missingAction)).diagnostics[0]?.code).toBe("backup.user_action_missing");

        expect(
            (
                await service().createStateBackup({
                    preparation: { ...preparation, sourceFileCount: preparation.sourceFileCount + 1 },
                    userActionId: "changed-preparation",
                })
            ).diagnostics[0]?.code,
        ).toBe("backup.preparation_modified");
        expect((await create(preparation, "unexpected")).diagnostics[0]?.code).toBe("backup.password_unexpected");

        const protectedPreparation = inspect("strong_password").value;
        expect((await create(protectedPreparation)).diagnostics[0]?.code).toBe("backup.password_missing");
        expect((await create(protectedPreparation, "bad\0password")).diagnostics[0]?.code).toBe("backup.password_missing");
        const invalidMode = service().inspectStateBackup({
            destination: { destinationKind: "oaam_default" },
            encryptionMode: "future" as StateBackupEncryptionMode,
        });
        expect(invalidMode.diagnostics[0]?.code).toBe("backup.encryption_mode_invalid");
    });

    it.each([
        "",
        "relative",
        path.parse(process.cwd()).root,
        `${customDestination}${path.sep}`,
        oaamRoot,
        path.join(oaamRoot, "inside"),
        `${customDestination}\0bad`,
        path.join(customDestination, "..", "noncanonical"),
    ])("rejects unsafe custom destination %j", (directoryPath) => {
        getDb(databasePath);
        const result = inspect("none", { destinationKind: "custom_directory", directoryPath });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toMatch(/^backup\.destination_/);
    });

    it("does not reinterpret an invalid default destination as a missing directory", () => {
        getDb(databasePath);
        fs.writeFileSync(path.join(oaamRoot, "backups"), "not a directory");
        const result = inspect("none");
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("backup.filesystem_wrong_entry_type");
    });

    it("rejects the exact live profile and a real descendant as custom destinations", () => {
        getDb(databasePath);
        for (const directoryPath of [oaamRoot, path.join(oaamRoot, "inside")]) {
            const result = inspect("none", { destinationKind: "custom_directory", directoryPath });
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe("backup.destination_inside_profile");
        }
    });

    it("rejects non-portable and colliding archive paths", () => {
        expect(() => assertPortableBackupPaths(["../escape"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["a", "A"])).toThrow(/collide/);
        expect(() => assertPortableBackupPaths(["a\\b"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["a//b"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["a/./b"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["a/../b"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["/a"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["a/"])).toThrow(/not portable/);
        expect(() => assertPortableBackupPaths(["a\0b"])).toThrow(/not portable/);
    });

    it("validates every preparation scalar and custom-destination contract", () => {
        getDb(databasePath);
        const preparation = inspect("none").value;
        for (const candidate of [
            { ...preparation, schemaVersion: 2 },
            { ...preparation, backupId: "not-a-uuid" },
            { ...preparation, createdAt: -1 },
            { ...preparation, sourceFileCount: -1 },
            { ...preparation, sourceLogicalBytes: -1 },
            { ...preparation, requiredAvailableBytes: -1 },
            { ...preparation, availableBytes: -1 },
            { ...preparation, outputFileName: "wrong.zip" },
            { ...preparation, sourceSnapshotFingerprint: "bad" },
            { ...preparation, destinationFingerprint: "bad" },
            { ...preparation, preparationFingerprint: "bad" },
            {
                ...preparation,
                destination: {
                    ...preparation.destination,
                    destinationKind: "custom_directory",
                    directoryState: "create_required",
                },
            },
        ] as StateBackupPreparationV1[]) {
            expect(() => stateBackupInternalsForTest.validateBackupPreparation(candidate)).toThrow(/invalid authority shape/);
        }
    });

    it("maps filesystem and unknown failures into stable backup diagnostics", () => {
        const cases = [
            ["not_found", "not_found", false],
            ["permission_denied", "permission_denied", false],
            ["stale", "conflict", true],
            ["resource_limit", "unavailable", false],
            ["io_error", "internal_error", true],
            ["wrong_entry_type", "internal_error", false],
        ] as const;
        for (const [failureKind, causeKind, retryable] of cases) {
            const result = failedBackupResult(
                new SafeFilesystemError({
                    failureKind,
                    operation: "read_regular_file",
                    targetPath: "/tmp/target",
                    message: failureKind,
                }),
            );
            expect(result.diagnostics[0]).toMatchObject({
                code: `backup.filesystem_${failureKind}`,
                causeKind,
                retryable,
                path: "/tmp/target",
            });
        }
        expect(failedBackupResult(new Error("boom")).diagnostics[0]?.code).toBe("backup.internal_failure");
    });

    it("exercises exact source-closure bounds and identity failures without allocating huge payloads", () => {
        const identity = (deviceId: string, fileId = "file", entryKind: "file" | "directory" = "file") =>
            ({ deviceId, fileId, entryKind }) satisfies PhysicalPathIdentity;
        expect(() =>
            stateBackupSourceInternalsForTest.assertCapturedIdentity(identity("a"), identity("b"), "changed", "/tmp/source"),
        ).toThrow(/changed/);

        const full = new Array(MAXIMUM_BACKUP_FILES).fill(undefined) as CapturedBackupEntry[];
        expect(() =>
            stateBackupSourceInternalsForTest.appendCapturedEntry(
                full,
                { value: 0 },
                "too-many",
                "profile_material",
                new Uint8Array(),
                false,
            ),
        ).toThrow(/exceeds/);
        expect(() =>
            stateBackupSourceInternalsForTest.appendCapturedEntry(
                [],
                { value: MAXIMUM_BACKUP_LOGICAL_BYTES },
                "too-large",
                "profile_material",
                Uint8Array.of(1),
                false,
            ),
        ).toThrow(/exceeds/);

        expect(stateBackupSourceInternalsForTest.databasePathsWithinRoot(oaamRoot, ":memory:")).toEqual(new Set());
        expect(stateBackupSourceInternalsForTest.databasePathsWithinRoot(oaamRoot, customDestination)).toEqual(new Set());
        expect(stateBackupSourceInternalsForTest.databasePathsWithinRoot(oaamRoot, oaamRoot)).toEqual(new Set());
        expect(stateBackupSourceInternalsForTest.ownerForProfilePath(["other"])).toBe("profile_material");
        expect(stateBackupSourceInternalsForTest.skipProfilePath(["other"], new Set())).toBe(false);
    });

    it("rejects every stale destination and preparation postcondition", () => {
        getDb(databasePath);
        const preparation = inspect("none", { destinationKind: "custom_directory", directoryPath: customDestination }).value;
        const source: CapturedBackupSource = {
            entries: [],
            sourceFileCount: preparation.sourceFileCount,
            sourceLogicalBytes: preparation.sourceLogicalBytes,
            sourceSnapshotFingerprint: preparation.sourceSnapshotFingerprint,
        };
        expect(() =>
            stateBackupInternalsForTest.assertSourceMatchesPreparation(
                { ...source, sourceFileCount: source.sourceFileCount + 1 },
                preparation,
            ),
        ).toThrow(/changed after backup review/);
        expect(() =>
            stateBackupInternalsForTest.assertSourceMatchesPreparation(
                { ...source, sourceLogicalBytes: source.sourceLogicalBytes + 1 },
                preparation,
            ),
        ).toThrow(/changed after backup review/);
        expect(() =>
            stateBackupInternalsForTest.assertSourceStableDuringArchive(source, {
                ...source,
                sourceSnapshotFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            }),
        ).toThrow(/while the backup archive/);

        const destination = {
            destinationKind: "custom_directory" as const,
            directoryPath: customDestination,
            directoryState: "ready" as const,
            destinationFingerprint: preparation.destinationFingerprint,
            availableBytes: preparation.availableBytes,
            directoryIdentity: { deviceId: "a", fileId: "b", entryKind: "directory" as const },
        };
        for (const changed of [
            { ...destination, destinationKind: "oaam_default" as const },
            { ...destination, directoryPath: `${customDestination}-other` },
            { ...destination, directoryState: "create_required" as const },
            {
                ...destination,
                destinationFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const,
            },
        ]) {
            expect(() => stateBackupInternalsForTest.assertDestinationMatchesPreparation(changed, preparation)).toThrow(
                /destination changed/,
            );
        }
        expect(() =>
            stateBackupInternalsForTest.assertDestinationMatchesPreparation({ ...destination, availableBytes: 0 }, preparation),
        ).toThrow(/enough available capacity/);

        expect(() =>
            stateBackupInternalsForTest.buildPreparation({
                backupId: BACKUP_ID,
                createdAt: CREATED_AT,
                encryptionMode: "none",
                source: {
                    entries: [],
                    sourceFileCount: 0,
                    sourceLogicalBytes: 0,
                    sourceSnapshotFingerprint: preparation.sourceSnapshotFingerprint,
                },
                destination: { ...destination, availableBytes: 0 },
                outputFileName: preparation.outputFileName,
            }),
        ).toThrow(/enough currently available capacity/);
        expect(() =>
            stateBackupInternalsForTest.buildPreparation({
                backupId: BACKUP_ID,
                createdAt: CREATED_AT,
                encryptionMode: "none",
                source: {
                    entries: [],
                    sourceFileCount: Number.MAX_SAFE_INTEGER,
                    sourceLogicalBytes: Number.MAX_SAFE_INTEGER,
                    sourceSnapshotFingerprint: preparation.sourceSnapshotFingerprint,
                },
                destination: { ...destination, availableBytes: Number.MAX_SAFE_INTEGER },
                outputFileName: preparation.outputFileName,
            }),
        ).toThrow(/enough currently available capacity/);
    });

    it("rejects unsafe commit postconditions and a raced default-directory creation", () => {
        const identity = { deviceId: "1", fileId: "2", entryKind: "directory" as const };
        expect(() =>
            stateBackupInternalsForTest.assertDestinationIdentity(
                identity,
                { ...identity, deviceId: "3" },
                "identity changed",
                customDestination,
                true,
            ),
        ).toThrow(/identity changed/);
        expect(() =>
            stateBackupInternalsForTest.assertDestinationIdentity(
                identity,
                { ...identity, fileId: "3" },
                "identity changed",
                customDestination,
                false,
            ),
        ).toThrow(/identity changed/);
        expect(() =>
            stateBackupInternalsForTest.assertDestinationIdentity(
                identity,
                { ...identity, entryKind: "file" },
                "identity changed",
                customDestination,
                false,
            ),
        ).toThrow(/identity changed/);
        expect(() =>
            stateBackupInternalsForTest.assertCommittedArchiveBytes(Uint8Array.of(1), Uint8Array.of(2), "/tmp/a.zip"),
        ).toThrow(/do not match/);

        expect(() =>
            stateBackupInternalsForTest.ensurePreparedDestination(oaamRoot, {
                destinationKind: "custom_directory",
                directoryPath: customDestination,
                directoryState: "ready",
                destinationFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                availableBytes: 1,
            }),
        ).toThrow(/identity is missing/);

        fs.mkdirSync(path.join(oaamRoot, "backups"));
        expect(() =>
            stateBackupInternalsForTest.ensurePreparedDestination(oaamRoot, {
                destinationKind: "oaam_default",
                directoryPath: path.join(oaamRoot, "backups"),
                directoryState: "create_required",
                destinationFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                availableBytes: 1,
            }),
        ).toThrow(/appeared after review/);

        const outputDirectory = path.join(customDestination, "not-a-file.zip");
        fs.mkdirSync(outputDirectory);
        expect(() => stateBackupInternalsForTest.assertBackupOutputAbsent(outputDirectory)).toThrow();
        expect(() =>
            stateBackupInternalsForTest.revalidateDestination(
                customDestination,
                { deviceId: "wrong", fileId: "wrong", entryKind: "directory" },
                path.join(customDestination, "absent.zip"),
                1,
            ),
        ).toThrow(/identity changed/);
        expect(() =>
            stateBackupInternalsForTest.revalidateDestination(
                customDestination,
                stateBackupInternalsForTest.ensurePreparedDestination(oaamRoot, {
                    destinationKind: "custom_directory",
                    directoryPath: customDestination,
                    directoryState: "ready",
                    destinationFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    availableBytes: Number.MAX_SAFE_INTEGER,
                    directoryIdentity: fsIdentity(customDestination),
                }),
                path.join(customDestination, "absent.zip"),
                Number.MAX_SAFE_INTEGER,
            ),
        ).toThrow(/enough capacity/);
    });

    it("rejects hostile ZIP inventories, bodies and encryption metadata", async () => {
        const zip = async (
            entries: Array<{ name: string; bytes?: Uint8Array; directory?: boolean }>,
            password?: string,
        ): Promise<Uint8Array> => {
            const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
            for (const entry of entries) {
                await writer.add(
                    entry.name,
                    entry.directory ? undefined : new Uint8ArrayReader(entry.bytes ?? new Uint8Array()),
                    {
                        directory: entry.directory,
                        password,
                    },
                );
            }
            return writer.close();
        };
        const source: CapturedBackupSource = {
            entries: [
                {
                    logicalPath: "source.txt",
                    owner: "profile_material",
                    contentHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                    byteSize: 1,
                    executable: false,
                    bytes: Uint8Array.of(1),
                },
            ],
            sourceFileCount: 1,
            sourceLogicalBytes: 1,
            sourceSnapshotFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        };
        const manifest = Uint8Array.of(2);
        const readme = Uint8Array.of(3);
        await expect(
            stateBackupArchiveInternalsForTest.verifyBackupArchive(await zip([]), source, manifest, readme, "none", undefined),
        ).rejects.toThrow(/inventory/);
        await expect(
            stateBackupArchiveInternalsForTest.verifyBackupArchive(
                await zip([
                    { name: "source.txt", directory: true },
                    { name: "manifest.json", bytes: manifest },
                    { name: "README.txt", bytes: readme },
                ]),
                {
                    ...source,
                    entries: [{ ...(source.entries[0] as CapturedBackupEntry), logicalPath: "source.txt/" }],
                },
                manifest,
                readme,
                "none",
                undefined,
            ),
        ).rejects.toThrow(/directory/);
        await expect(
            stateBackupArchiveInternalsForTest.verifyBackupArchive(
                await zip([
                    { name: "source.txt", bytes: Uint8Array.of(9) },
                    { name: "manifest.json", bytes: manifest },
                    { name: "README.txt", bytes: readme },
                ]),
                source,
                manifest,
                readme,
                "none",
                undefined,
            ),
        ).rejects.toThrow(/entry does not match/);
        await expect(
            stateBackupArchiveInternalsForTest.verifyBackupArchive(
                await zip([
                    { name: "source.txt", bytes: Uint8Array.of(1) },
                    { name: "manifest.json", bytes: manifest },
                    { name: "README.txt", bytes: readme },
                ]),
                source,
                manifest,
                readme,
                "strong_password",
                undefined,
            ),
        ).rejects.toThrow(/encryption state/);

        const preparation = inspect("none").value;
        await expect(
            buildAndVerifyBackupArchive(
                {
                    ...source,
                    entries: [
                        source.entries[0] as CapturedBackupEntry,
                        { ...(source.entries[0] as CapturedBackupEntry), bytes: Uint8Array.of(2) },
                    ],
                    sourceFileCount: 2,
                },
                preparation,
                undefined,
            ),
        ).rejects.toThrow(/archive creation/);
        await expect(
            stateBackupArchiveInternalsForTest.closeIncompleteZip({
                close: async () => {
                    throw new Error("close failed");
                },
            }),
        ).resolves.toBeUndefined();
        let closeCalls = 0;
        await stateBackupArchiveInternalsForTest.cleanupIncompleteArchive(true, {
            close: async () => {
                closeCalls += 1;
                return new Uint8Array();
            },
        });
        expect(closeCalls).toBe(0);
        expect(() => stateBackupArchiveInternalsForTest.rethrowArchiveFailure(new Error("generic"))).toThrow(/archive creation/);
        expect(() =>
            stateBackupArchiveInternalsForTest.rethrowArchiveFailure(
                new StateBackupError("backup.test", "nested", "verification_failed", false),
            ),
        ).toThrow(/nested/);
    });
});

function fsIdentity(directoryPath: string): PhysicalPathIdentity {
    const stat = fs.statSync(directoryPath, { bigint: true });
    return {
        deviceId: stat.dev.toString(),
        fileId: stat.ino.toString(),
        entryKind: "directory",
    };
}
