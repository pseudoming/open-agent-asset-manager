import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    assertPackagedAssetUsageAuthoritySnapshot,
    assertPackagedAssetUsageAuthorityUnchanged,
    type PackagedAssetUsageAuthoritySnapshot,
    snapshotPackagedAssetUsageAuthority,
    waitForPackagedAssetUsageAuthorityQuiescence,
} from "../src/main/packaged-asset-usage-authority-proof";
import { waitForPackagedProviderSourceIgnoreAuthorityQuiescence } from "../src/main/packaged-onboarding-provider-sweep";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

function authoritySnapshot(
    businessAuthorityTreeFingerprint = "a".repeat(64),
    desktopPreferencesFingerprint = "b".repeat(64),
    lastSelectedProjectId: string | null = PROJECT_ID,
): PackagedAssetUsageAuthoritySnapshot {
    return {
        businessAuthorityEntryCount: 3,
        businessAuthorityTreeFingerprint,
        businessAuthorityManifest: [
            { relativePath: "oaam.sqlite", kind: "file", size: 8, sha256: "c".repeat(64) },
            { relativePath: "versions", kind: "directory", size: null, sha256: null },
            { relativePath: "versions/asset.bin", kind: "file", size: 5, sha256: "d".repeat(64) },
        ],
        observabilityEntryCount: 0,
        observabilityTreeFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        observabilityManifest: [],
        desktopPreferencesFingerprint,
        desktopPreferences: {
            schemaVersion: 4,
            onboardingCompleted: true,
            lastSelectedProjectId,
            assetLayout: "list",
        },
        coordinationPaths: ["oaam.sqlite-shm"],
    };
}

function preferenceBytes(lastSelectedProjectId: string | null = PROJECT_ID): Buffer {
    return Buffer.from(
        `${JSON.stringify(
            {
                schemaVersion: 4,
                language: "system",
                theme: "system",
                textSize: "default",
                surfacePalette: "warm",
                leftPaneWidth: 288,
                rightPaneWidth: 336,
                onboardingCompleted: true,
                assetLayout: "list",
                ...(lastSelectedProjectId === null ? {} : { lastSelectedProjectId }),
            },
            null,
            4,
        )}\n`,
    );
}

function durablyReplaceFixture(filePath: string, nextBytes: string): void {
    const replacementPath = `${filePath}.replacement`;
    fs.writeFileSync(replacementPath, nextBytes, { flag: "wx" });
    fs.renameSync(replacementPath, filePath);
}

function durablyGrowFixture(filePath: string, growth: string): void {
    durablyReplaceFixture(filePath, `${fs.readFileSync(filePath, "utf8")}${growth}`);
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("packaged Asset-usage authority comparison", () => {
    it("records exact before, after and State-file delta before failing closed", () => {
        const before = authoritySnapshot();
        const after = {
            ...authoritySnapshot("e".repeat(64)),
            businessAuthorityManifest: authoritySnapshot().businessAuthorityManifest.map((entry) =>
                entry.relativePath === "oaam.sqlite" ? { ...entry, sha256: "f".repeat(64) } : entry,
            ),
        };
        const recordAuthorityChange = vi.fn();

        expect(() => assertPackagedAssetUsageAuthorityUnchanged(before, after, recordAuthorityChange)).toThrow(
            "changed business authority or emitted an invalid observability delta",
        );
        expect(recordAuthorityChange).toHaveBeenCalledWith({
            schemaVersion: 2,
            before,
            after,
            delta: expect.objectContaining({
                authorityChanged: true,
                businessAuthorityChanged: true,
                preferencesChanged: false,
                businessAuthority: expect.objectContaining({
                    changed: [expect.objectContaining({ relativePath: "oaam.sqlite" })],
                }),
            }),
        });
    });

    it("waits for the exact Project preference and two equal complete snapshots", async () => {
        const oldPreference = authoritySnapshot("a".repeat(64), "1".repeat(64), null);
        const settled = authoritySnapshot();
        const readSnapshot = vi
            .fn<() => PackagedAssetUsageAuthoritySnapshot>()
            .mockReturnValueOnce(oldPreference)
            .mockReturnValueOnce(settled)
            .mockReturnValueOnce(settled);

        await expect(
            waitForPackagedAssetUsageAuthorityQuiescence(readSnapshot, PROJECT_ID, {
                deadlineMilliseconds: 100,
                pollIntervalMilliseconds: 1,
            }),
        ).resolves.toBe(settled);
        expect(readSnapshot).toHaveBeenCalledTimes(3);
    });

    it("fails bounded before the relationship when the exact Project preference never settles", async () => {
        const readSnapshot = vi.fn(() => authoritySnapshot("a".repeat(64), "1".repeat(64), null));

        await expect(
            waitForPackagedAssetUsageAuthorityQuiescence(readSnapshot, PROJECT_ID, {
                deadlineMilliseconds: 5,
                pollIntervalMilliseconds: 1,
            }),
        ).rejects.toThrow("timed out waiting for the exact Project preference and stable authority");
    });

    it.each([
        "disappeared",
        "changed",
    ] as const)("retries an exact ordinary publish temporary that %s during baseline observation", async (transition) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `oaam-packaged-publish-${transition}-`));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const ordinary = path.join(root, "logs", "ordinary");
        fs.mkdirSync(ordinary, { recursive: true });
        const publishTemporary = path.join(ordinary, `.oaam-publish-${"a".repeat(32)}`);
        fs.writeFileSync(publishTemporary, "pending");
        const realLstat = fs.lstatSync.bind(fs);
        let publishObservationCount = 0;
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
            const resolved = path.resolve(String(target));
            if (resolved !== publishTemporary) return realLstat(target);
            publishObservationCount += 1;
            const stat = realLstat(target);
            if ((transition === "disappeared" && publishObservationCount === 1) || publishObservationCount === 2) {
                fs.rmSync(publishTemporary);
                if (transition === "disappeared") {
                    throw Object.assign(new Error("publish temporary disappeared"), { code: "ENOENT" });
                }
                return new Proxy(stat, {
                    get(current, property) {
                        if (property === "size") return current.size + 1;
                        const value = Reflect.get(current, property, current) as unknown;
                        return typeof value === "function" ? value.bind(current) : value;
                    },
                });
            }
            return stat;
        }) as typeof fs.lstatSync);
        const readSnapshot = vi.fn(() => snapshotPackagedAssetUsageAuthority(root, preferenceBytes()));
        try {
            await expect(
                waitForPackagedAssetUsageAuthorityQuiescence(readSnapshot, PROJECT_ID, {
                    deadlineMilliseconds: 100,
                    pollIntervalMilliseconds: 1,
                }),
            ).resolves.toEqual(expect.objectContaining({ businessAuthorityEntryCount: 1 }));
            expect(readSnapshot.mock.calls.length).toBeGreaterThanOrEqual(3);
        } finally {
            lstat.mockRestore();
        }
    });

    it("times out while an exact ordinary publish temporary remains non-comparable", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-publish-permanent-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const ordinary = path.join(root, "logs", "ordinary");
        fs.mkdirSync(ordinary, { recursive: true });
        fs.writeFileSync(path.join(ordinary, `.oaam-publish-${"b".repeat(32)}`), "pending");

        await expect(
            waitForPackagedAssetUsageAuthorityQuiescence(
                () => snapshotPackagedAssetUsageAuthority(root, preferenceBytes()),
                PROJECT_ID,
                { deadlineMilliseconds: 5, pollIntervalMilliseconds: 1 },
            ),
        ).rejects.toThrow(/observability_non_comparable/u);
    });

    it("retries when an exact ordinary publish temporary disappears after its bytes are read", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-publish-after-read-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const ordinary = path.join(root, "logs", "ordinary");
        fs.mkdirSync(ordinary, { recursive: true });
        const publishTemporary = path.join(ordinary, `.oaam-publish-${"c".repeat(32)}`);
        fs.writeFileSync(publishTemporary, "pending");
        const realLstat = fs.lstatSync.bind(fs);
        let publishObservationCount = 0;
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
            if (path.resolve(String(target)) !== publishTemporary) return realLstat(target);
            publishObservationCount += 1;
            if (publishObservationCount === 2) {
                fs.rmSync(publishTemporary);
                throw Object.assign(new Error("publish temporary disappeared after read"), { code: "ENOENT" });
            }
            return realLstat(target);
        }) as typeof fs.lstatSync);
        try {
            await expect(
                waitForPackagedAssetUsageAuthorityQuiescence(
                    () => snapshotPackagedAssetUsageAuthority(root, preferenceBytes()),
                    PROJECT_ID,
                    { deadlineMilliseconds: 100, pollIntervalMilliseconds: 1 },
                ),
            ).resolves.toEqual(expect.objectContaining({ businessAuthorityEntryCount: 1 }));
        } finally {
            lstat.mockRestore();
        }
    });

    it("rejects an exact ordinary publish temporary that is a directory", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-publish-directory-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        fs.mkdirSync(path.join(root, "logs", "ordinary", `.oaam-publish-${"d".repeat(32)}`), { recursive: true });

        expect(() => snapshotPackagedAssetUsageAuthority(root, preferenceBytes())).toThrow(
            "publish temporary is not a regular file",
        );
    });

    it("fails closed on ENOENT outside the exact ordinary publish temporary grammar", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-business-enoent-"));
        roots.push(root);
        const database = path.join(root, "oaam.sqlite");
        fs.writeFileSync(database, "database");
        const realLstat = fs.lstatSync.bind(fs);
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
            if (path.resolve(String(target)) === database) {
                throw Object.assign(new Error("business path disappeared"), { code: "ENOENT" });
            }
            return realLstat(target);
        }) as typeof fs.lstatSync);
        try {
            await expect(
                waitForPackagedAssetUsageAuthorityQuiescence(
                    () => snapshotPackagedAssetUsageAuthority(root, preferenceBytes()),
                    PROJECT_ID,
                    { deadlineMilliseconds: 100, pollIntervalMilliseconds: 1 },
                ),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            lstat.mockRestore();
        }
    });

    it("reports but does not treat the exact SQLite shared-memory path as authority", () => {
        const before = authoritySnapshot();
        const after = { ...authoritySnapshot(), coordinationPaths: [] };

        expect(assertPackagedAssetUsageAuthorityUnchanged(before, after, vi.fn())).toMatchObject({
            authorityChanged: false,
            businessAuthorityChanged: false,
            preferencesChanged: false,
            coordinationChanged: true,
            coordination: { added: [], removed: ["oaam.sqlite-shm"] },
        });
    });

    it("accepts only the exact zero-byte root SQLite WAL lifecycle as coordination", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-zero-wal-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        fs.writeFileSync(path.join(root, "oaam.sqlite-shm"), "coordination");
        fs.writeFileSync(path.join(root, "oaam.sqlite-wal"), "");
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        fs.rmSync(path.join(root, "oaam.sqlite-shm"));
        fs.rmSync(path.join(root, "oaam.sqlite-wal"));
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());

        expect(before.coordinationPaths).toEqual(["oaam.sqlite-shm", "oaam.sqlite-wal"]);
        expect(before.businessAuthorityManifest.map((entry) => entry.relativePath)).toEqual(["oaam.sqlite"]);
        expect(assertPackagedAssetUsageAuthorityUnchanged(before, after, vi.fn())).toMatchObject({
            authorityChanged: false,
            businessAuthorityChanged: false,
            coordinationChanged: true,
            coordination: { added: [], removed: ["oaam.sqlite-shm", "oaam.sqlite-wal"] },
        });
    });

    it("accepts only exact SQLite and Core lock coordination grammar", () => {
        const physicalLock = `transactions/locks/${"a".repeat(64)}.lock`;
        expect(() =>
            assertPackagedAssetUsageAuthoritySnapshot({
                ...authoritySnapshot(),
                coordinationPaths: [
                    "oaam.sqlite-shm",
                    "oaam.sqlite-wal",
                    "transactions",
                    "transactions/authority-locks",
                    "transactions/authority-locks/projects",
                    "transactions/authority-locks/projects/catalog.lock",
                    "transactions/locks",
                    physicalLock,
                ],
            }),
        ).not.toThrow();
        for (const relativePath of [
            "versions/asset.sqlite-shm",
            "versions/oaam.sqlite-wal",
            "oaam.sqlite-wal/child",
            "oaam.sqlite-wal.lock",
            `transactions/locks/${"a".repeat(63)}.lock`,
            `transactions/locks/${"A".repeat(64)}.lock`,
            `transactions/locks/${"a".repeat(64)}.txt`,
            `transactions/locks/deep/${"a".repeat(64)}.lock`,
            "transactions/authority-locks/projects/catalog",
            "transactions/authority-locks/projects/catalog.txt",
            "transactions/authority-locks/projects/deep/catalog.lock",
            "transactions/authority-locks/../catalog.lock",
        ]) {
            expect(() =>
                assertPackagedAssetUsageAuthoritySnapshot({
                    ...authoritySnapshot(),
                    coordinationPaths: [relativePath],
                }),
            ).toThrow("invalid packaged Asset-usage authority snapshot");
        }
    });

    it("rejects malformed manifests, unstable ordering and invalid quiescence bounds", async () => {
        expect(() =>
            assertPackagedAssetUsageAuthoritySnapshot({
                ...authoritySnapshot(),
                businessAuthorityManifest: [
                    { relativePath: "oaam.sqlite", kind: "file", size: 8, sha256: "not-a-sha" },
                    ...authoritySnapshot().businessAuthorityManifest.slice(1),
                ],
            }),
        ).toThrow("invalid packaged Asset-usage authority manifest entry");
        expect(() =>
            assertPackagedAssetUsageAuthoritySnapshot({
                ...authoritySnapshot(),
                businessAuthorityManifest: [...authoritySnapshot().businessAuthorityManifest].reverse(),
            }),
        ).toThrow("invalid packaged Asset-usage authority manifest order");
        await expect(
            waitForPackagedAssetUsageAuthorityQuiescence(() => authoritySnapshot(), PROJECT_ID, {
                deadlineMilliseconds: 0,
                pollIntervalMilliseconds: 1,
            }),
        ).rejects.toThrow("invalid packaged Asset-usage authority quiescence bounds");
    });
});

describe("packaged Asset-usage authority snapshot", () => {
    it("waits past publish temporaries until read initialization and complete JSONL are stable", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-provider-ignore-quiescence-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const ordinary = path.join(root, "logs", "ordinary");
        fs.mkdirSync(ordinary, { recursive: true });
        const segment = path.join(ordinary, `ordinary-1-${"a".repeat(32)}.jsonl`);
        fs.writeFileSync(segment, "{}\n");
        fs.writeFileSync(path.join(ordinary, `.oaam-publish-${"f".repeat(32)}`), "pending");
        const publishing = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        fs.rmSync(path.join(ordinary, `.oaam-publish-${"f".repeat(32)}`));
        fs.mkdirSync(path.join(root, "transactions", "authority-locks", "projects"), { recursive: true });
        const settled = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const read = vi.fn().mockReturnValueOnce(publishing).mockReturnValue(settled);

        await expect(waitForPackagedProviderSourceIgnoreAuthorityQuiescence(read, 100)).resolves.toBe(settled);
        expect(settled.coordinationPaths).toEqual([
            "transactions",
            "transactions/authority-locks",
            "transactions/authority-locks/projects",
        ]);

        durablyReplaceFixture(segment, "{");
        const incomplete = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        await expect(waitForPackagedProviderSourceIgnoreAuthorityQuiescence(() => incomplete, 5)).rejects.toThrow(
            /timed out waiting for stable Provider source-ignore authority/u,
        );
    });

    it("retains a nonempty SQLite WAL in business authority while ignoring exact SQLite coordination", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-authority-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "versions"));
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        fs.writeFileSync(path.join(root, "oaam.sqlite-wal"), "journal");
        fs.writeFileSync(path.join(root, "oaam.sqlite-shm"), "coordination-a");
        fs.writeFileSync(path.join(root, "versions", "asset.bin"), "asset");
        fs.writeFileSync(path.join(root, "versions", "asset.sqlite-shm"), "asset-coordination-name");

        const first = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        fs.writeFileSync(path.join(root, "oaam.sqlite-shm"), "coordination-b");
        const second = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const changedPreferences = snapshotPackagedAssetUsageAuthority(
            root,
            Buffer.from(preferenceBytes().toString("utf8").replace('"assetLayout": "list"', '"assetLayout": "cards"')),
        );
        fs.writeFileSync(path.join(root, "oaam.sqlite-wal"), "changed-journal");
        const changedState = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());

        expect(first).toEqual(second);
        expect(first.coordinationPaths).toEqual(["oaam.sqlite-shm"]);
        expect(first.businessAuthorityEntryCount).toBe(5);
        expect(first.businessAuthorityManifest).toEqual([
            expect.objectContaining({ relativePath: "oaam.sqlite", kind: "file", size: 8, sha256: expect.any(String) }),
            expect.objectContaining({ relativePath: "oaam.sqlite-wal", kind: "file", size: 7, sha256: expect.any(String) }),
            { relativePath: "versions", kind: "directory", size: null, sha256: null },
            expect.objectContaining({ relativePath: "versions/asset.bin", kind: "file", size: 5, sha256: expect.any(String) }),
            expect.objectContaining({
                relativePath: "versions/asset.sqlite-shm",
                kind: "file",
                size: 23,
                sha256: expect.any(String),
            }),
        ]);
        expect(first.desktopPreferences).toEqual({
            schemaVersion: 4,
            onboardingCompleted: true,
            lastSelectedProjectId: PROJECT_ID,
            assetLayout: "list",
        });
        expect(changedPreferences.businessAuthorityTreeFingerprint).toBe(first.businessAuthorityTreeFingerprint);
        expect(changedPreferences.desktopPreferencesFingerprint).not.toBe(first.desktopPreferencesFingerprint);
        expect(changedPreferences.desktopPreferences.assetLayout).toBe("cards");
        expect(changedState.businessAuthorityTreeFingerprint).not.toBe(first.businessAuthorityTreeFingerprint);
    });

    it("fails closed when an exact zero-byte SQLite WAL changes identity while being observed", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-changing-wal-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const walPath = path.join(root, "oaam.sqlite-wal");
        fs.writeFileSync(walPath, "");
        const realLstat = fs.lstatSync.bind(fs);
        let observationCount = 0;
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
            const stat = realLstat(target);
            if (path.resolve(String(target)) !== walPath || ++observationCount !== 2) return stat;
            return new Proxy(stat, {
                get(current, property) {
                    if (property === "ino") return current.ino + 1;
                    const value = Reflect.get(current, property, current) as unknown;
                    return typeof value === "function" ? value.bind(current) : value;
                },
            });
        }) as typeof fs.lstatSync);
        try {
            expect(() => snapshotPackagedAssetUsageAuthority(root, preferenceBytes())).toThrow(
                "lock anchor is non-empty or changed while being observed",
            );
        } finally {
            lstat.mockRestore();
        }
    });

    it("partitions lock coordination per entry without hiding business children", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-authority-locks-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const locks = path.join(root, "transactions", "authority-locks", "projects");
        fs.mkdirSync(path.join(locks, "deep"), { recursive: true });
        fs.writeFileSync(path.join(locks, "catalog.lock"), "");
        fs.writeFileSync(path.join(locks, "receipt.json"), "business");
        fs.writeFileSync(path.join(locks, "deep", "nested.lock"), "business");
        const physicalLocks = path.join(root, "transactions", "locks");
        fs.mkdirSync(path.join(physicalLocks, "deep"), { recursive: true });
        fs.writeFileSync(path.join(physicalLocks, `${"a".repeat(64)}.lock`), "");
        fs.writeFileSync(path.join(physicalLocks, "receipt.json"), "business");
        fs.writeFileSync(path.join(physicalLocks, "deep", `${"b".repeat(64)}.lock`), "business");

        const snapshot = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());

        expect(snapshot.coordinationPaths).toEqual([
            "transactions",
            "transactions/authority-locks",
            "transactions/authority-locks/projects",
            "transactions/authority-locks/projects/catalog.lock",
            "transactions/locks",
            `transactions/locks/${"a".repeat(64)}.lock`,
        ]);
        expect(snapshot.businessAuthorityManifest.map((entry) => entry.relativePath)).toEqual([
            "oaam.sqlite",
            "transactions/authority-locks/projects/deep",
            "transactions/authority-locks/projects/deep/nested.lock",
            "transactions/authority-locks/projects/receipt.json",
            "transactions/locks/deep",
            `transactions/locks/deep/${"b".repeat(64)}.lock`,
            "transactions/locks/receipt.json",
        ]);
        fs.writeFileSync(path.join(locks, "catalog.lock"), "not-an-empty-anchor");
        expect(() => snapshotPackagedAssetUsageAuthority(root, preferenceBytes())).toThrow(/lock anchor is non-empty/u);
        fs.writeFileSync(path.join(locks, "catalog.lock"), "");
        fs.writeFileSync(path.join(physicalLocks, `${"a".repeat(64)}.lock`), "not-an-empty-anchor");
        expect(() => snapshotPackagedAssetUsageAuthority(root, preferenceBytes())).toThrow(/lock anchor is non-empty/u);
    });

    it("reports one exact Host-owned ordinary-log durable replacement without treating it as business authority", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-observability-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "logs", "ordinary"), { recursive: true });
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        fs.writeFileSync(path.join(root, "logs", "ordinary-settings.json"), '{"schemaVersion":1}\n');
        const segmentPath = path.join(root, "logs", "ordinary", `ordinary-10-${"a".repeat(32)}.jsonl`);
        fs.writeFileSync(segmentPath, '{"schemaVersion":1,"occurredAt":10}\n');
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        durablyGrowFixture(segmentPath, '{"schemaVersion":1,"occurredAt":11}\n');
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const delta = assertPackagedAssetUsageAuthorityUnchanged(before, after, vi.fn());

        expect(delta).toMatchObject({
            authorityChanged: false,
            businessAuthorityChanged: false,
            observabilityChanged: true,
            observability: {
                added: [],
                removed: [],
                validDurableReplacementGrowth: true,
                durableReplacement: {
                    relativePath: `logs/ordinary/ordinary-10-${"a".repeat(32)}.jsonl`,
                    beforeSize: 36,
                    afterSize: 72,
                    beforeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
                    afterSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
                    growthBytes: 36,
                    growthSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
                    segmentPathMatched: true,
                    physicalIdentityTransition: {
                        before: { dev: expect.stringMatching(/^[0-9]+$/u), ino: expect.stringMatching(/^[0-9]+$/u) },
                        after: { dev: expect.stringMatching(/^[0-9]+$/u), ino: expect.stringMatching(/^[0-9]+$/u) },
                        changed: true,
                    },
                    prefixMatched: true,
                    beforeNewlineTerminated: true,
                    newlineTerminated: true,
                    jsonLineCount: 1,
                    jsonLinesParseable: true,
                },
            },
        });
        expect(delta.observability.durableReplacement?.physicalIdentityTransition?.before).not.toEqual(
            delta.observability.durableReplacement?.physicalIdentityTransition?.after,
        );
        expect(before.businessAuthorityManifest).toContainEqual(
            expect.objectContaining({ relativePath: "logs/ordinary-settings.json" }),
        );
        expect(before.observabilityManifest.map((entry) => entry.relativePath)).toEqual([
            "logs",
            "logs/ordinary",
            `logs/ordinary/ordinary-10-${"a".repeat(32)}.jsonl`,
        ]);
        expect(before.businessAuthorityManifest.map((entry) => entry.relativePath)).not.toContain("logs");
    });

    it.each([
        ["adds a segment", (segmentPath: string) => fs.writeFileSync(`${segmentPath}.added`, "{}\n")],
        ["removes a segment", (segmentPath: string) => fs.rmSync(segmentPath)],
        ["shortens a segment", (segmentPath: string) => durablyReplaceFixture(segmentPath, "{}\n")],
        ["rewrites the prefix", (segmentPath: string) => durablyReplaceFixture(segmentPath, `${'{"changed":true}\n'.repeat(4)}`)],
        ["publishes an incomplete growth line", (segmentPath: string) => durablyGrowFixture(segmentPath, "{}")],
        ["publishes invalid growth JSON", (segmentPath: string) => durablyGrowFixture(segmentPath, "not-json\n")],
    ])("rejects ordinary-log observability that %s", (_label, mutate) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-invalid-observability-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "logs", "ordinary"), { recursive: true });
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        fs.writeFileSync(path.join(root, "logs", "ordinary-settings.json"), '{"schemaVersion":1}\n');
        const segmentPath = path.join(root, "logs", "ordinary", `ordinary-10-${"b".repeat(32)}.jsonl`);
        fs.writeFileSync(segmentPath, '{"schemaVersion":1,"occurredAt":10}\n');
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        mutate(segmentPath);
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const recordAuthorityChange = vi.fn();

        expect(() => assertPackagedAssetUsageAuthorityUnchanged(before, after, recordAuthorityChange)).toThrow(
            "invalid observability delta",
        );
        expect(recordAuthorityChange).toHaveBeenCalledWith(
            expect.objectContaining({
                delta: expect.objectContaining({
                    authorityChanged: false,
                    observabilityChanged: true,
                    observability: expect.objectContaining({ validDurableReplacementGrowth: false }),
                }),
            }),
        );
    });

    it("classifies only exact log structure and keeps every nonordinary log file in business authority", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-log-settings-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "logs", "ordinary"), { recursive: true });
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        fs.writeFileSync(path.join(root, "logs", "ordinary-settings.json"), '{"schemaVersion":1}\n');
        fs.writeFileSync(path.join(root, "logs", "support.json"), "before");
        fs.mkdirSync(path.join(root, "logs", "ordinary", "nested"));
        fs.writeFileSync(path.join(root, "logs", "ordinary", "nested", "receipt.json"), "business");
        fs.writeFileSync(
            path.join(root, "logs", "ordinary", `ordinary-10-${"c".repeat(32)}.jsonl`),
            '{"schemaVersion":1,"occurredAt":10}\n',
        );
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        fs.writeFileSync(path.join(root, "logs", "ordinary-settings.json"), '{"schemaVersion":2}\n');
        fs.writeFileSync(path.join(root, "logs", "support.json"), "after");
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const recordAuthorityChange = vi.fn();

        expect(before.observabilityManifest.map((entry) => entry.relativePath)).toEqual([
            "logs",
            "logs/ordinary",
            `logs/ordinary/ordinary-10-${"c".repeat(32)}.jsonl`,
        ]);
        expect(before.businessAuthorityManifest.map((entry) => entry.relativePath)).toEqual([
            "logs/ordinary-settings.json",
            "logs/ordinary/nested",
            "logs/ordinary/nested/receipt.json",
            "logs/support.json",
            "oaam.sqlite",
        ]);

        expect(() => assertPackagedAssetUsageAuthorityUnchanged(before, after, recordAuthorityChange)).toThrow(
            "changed business authority",
        );
        expect(recordAuthorityChange).toHaveBeenCalledWith(
            expect.objectContaining({
                delta: expect.objectContaining({
                    authorityChanged: true,
                    businessAuthorityChanged: true,
                    businessAuthority: expect.objectContaining({
                        changed: expect.arrayContaining([
                            expect.objectContaining({ relativePath: "logs/ordinary-settings.json" }),
                            expect.objectContaining({ relativePath: "logs/support.json" }),
                        ]),
                    }),
                }),
            }),
        );
    });

    it("rejects an append to a logs/ordinary file outside the exact Host-owned segment grammar", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-invalid-segment-name-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "logs", "ordinary"), { recursive: true });
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const segmentPath = path.join(root, "logs", "ordinary", "ordinary-010-invalid.jsonl");
        fs.writeFileSync(segmentPath, "{}\n");
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        fs.appendFileSync(segmentPath, "{}\n");
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const recordAuthorityChange = vi.fn();

        expect(() => assertPackagedAssetUsageAuthorityUnchanged(before, after, recordAuthorityChange)).toThrow(
            "invalid observability delta",
        );
        expect(recordAuthorityChange).toHaveBeenCalledWith(
            expect.objectContaining({
                delta: expect.objectContaining({
                    observability: expect.objectContaining({
                        validDurableReplacementGrowth: false,
                        durableReplacement: expect.objectContaining({ segmentPathMatched: false }),
                    }),
                }),
            }),
        );
    });

    it("rejects growth in two existing ordinary-log segments", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-multiple-segments-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "logs", "ordinary"), { recursive: true });
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const paths = ["d", "e"].map((identity, index) => {
            const segmentPath = path.join(root, "logs", "ordinary", `ordinary-${10 + index}-${identity.repeat(32)}.jsonl`);
            fs.writeFileSync(segmentPath, `{"occurredAt":${10 + index}}\n`);
            return segmentPath;
        });
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        for (const segmentPath of paths) fs.appendFileSync(segmentPath, "{}\n");
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());

        expect(() => assertPackagedAssetUsageAuthorityUnchanged(before, after, vi.fn())).toThrow("invalid observability delta");
    });

    it("rejects indirect roots and symlinked State entries", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-indirect-"));
        roots.push(parent);
        const root = path.join(parent, "state");
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const indirectRoot = path.join(parent, "state-link");
        fs.symlinkSync(root, indirectRoot, "dir");
        expect(() => snapshotPackagedAssetUsageAuthority(indirectRoot, Buffer.alloc(0))).toThrow("one direct directory");

        fs.symlinkSync(path.join(root, "oaam.sqlite"), path.join(root, "database-link"));
        expect(() => snapshotPackagedAssetUsageAuthority(root, Buffer.alloc(0))).toThrow("contains a symbolic link");
    });

    it("rejects malformed Desktop preference bytes before publishing a snapshot", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-preferences-"));
        roots.push(root);
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");

        expect(() => snapshotPackagedAssetUsageAuthority(root, Buffer.from("{"))).toThrow(
            "packaged Asset-usage Desktop preferences are invalid",
        );
    });

    it("rejects in-place ordinary-log growth even when the new bytes preserve the old prefix", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-in-place-segment-"));
        roots.push(root);
        fs.mkdirSync(path.join(root, "logs", "ordinary"), { recursive: true });
        fs.writeFileSync(path.join(root, "oaam.sqlite"), "database");
        const segmentPath = path.join(root, "logs", "ordinary", `ordinary-10-${"f".repeat(32)}.jsonl`);
        const beforeBytes = '{"occurredAt":10}\n';
        fs.writeFileSync(segmentPath, beforeBytes);
        const before = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        fs.appendFileSync(segmentPath, "{}\n");
        const after = snapshotPackagedAssetUsageAuthority(root, preferenceBytes());
        const recordAuthorityChange = vi.fn();

        expect(() => assertPackagedAssetUsageAuthorityUnchanged(before, after, recordAuthorityChange)).toThrow(
            "invalid observability delta",
        );
        expect(recordAuthorityChange).toHaveBeenCalledWith(
            expect.objectContaining({
                delta: expect.objectContaining({
                    observability: expect.objectContaining({
                        validDurableReplacementGrowth: false,
                        durableReplacement: expect.objectContaining({
                            physicalIdentityTransition: expect.objectContaining({ changed: false }),
                            prefixMatched: true,
                        }),
                    }),
                }),
            }),
        );
    });

    it("rejects special entries and a file identity that changes during observation", () => {
        const specialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-special-"));
        roots.push(specialRoot);
        fs.writeFileSync(path.join(specialRoot, "special"), "fixture");
        const readdir = vi.spyOn(fs, "readdirSync").mockReturnValue([
            {
                name: "special",
                isDirectory: () => false,
                isFile: () => false,
                isSymbolicLink: () => false,
            },
        ] as unknown as fs.Dirent[]);
        try {
            expect(() => snapshotPackagedAssetUsageAuthority(specialRoot, Buffer.alloc(0))).toThrow(
                "contains a special filesystem entry",
            );
        } finally {
            readdir.mockRestore();
        }

        const changingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-asset-usage-changing-"));
        roots.push(changingRoot);
        const filePath = path.join(changingRoot, "oaam.sqlite");
        fs.writeFileSync(filePath, "database");
        const realLstat = fs.lstatSync.bind(fs);
        let fileObservationCount = 0;
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
            const stat = realLstat(target);
            if (path.resolve(String(target)) !== filePath || ++fileObservationCount !== 2) return stat;
            return new Proxy(stat, {
                get(current, property) {
                    if (property === "size") return current.size + 1;
                    const value = Reflect.get(current, property, current) as unknown;
                    return typeof value === "function" ? value.bind(current) : value;
                },
            });
        }) as typeof fs.lstatSync);
        try {
            expect(() => snapshotPackagedAssetUsageAuthority(changingRoot, Buffer.alloc(0))).toThrow(
                "changed while being observed",
            );
        } finally {
            lstat.mockRestore();
        }
    });
});
