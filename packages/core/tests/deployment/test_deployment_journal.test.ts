/** Journal publication, strict read, schema, and byte-authority validation. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    type ActiveJournal,
    type ActiveJournalV2,
    publishJournal,
    readJournal,
    recordJournalCreatedDirectory,
} from "../../src/deployment/deployment-journal";
import { bytesToBase64, sha256Bytes } from "../../src/foundation/crypto-bytes";
import { computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";

const D1 = "00000000-0000-4000-8000-000000000001";
const D2 = "00000000-0000-4000-8000-000000000002";
const FP = `sha256:${"a".repeat(64)}`;

function hash(bytes: Uint8Array): string {
    return sha256Bytes(bytes);
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeJournal(txnId: string, deploymentId: string, entries: ActiveJournal["entries"] = []): ActiveJournal {
    return {
        schemaVersion: 1,
        transactionId: txnId,
        deploymentId,
        createdAt: 5000,
        compilationFingerprint: FP,
        reservedPhysicalKeys: computePhysicalClosureKeys(
            "linux",
            "/root",
            entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
            })),
        ),
        entries,
    };
}

function makeDirectoryJournal(txnId: string): ActiveJournalV2 {
    const newBytes = new Uint8Array([120]);
    const entries: ActiveJournalV2["entries"] = [
        {
            relativePath: "skills/demo/SKILL.md",
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            oldProvenanceFingerprint: "",
            oldMaterializationFingerprint: "",
            newHash: hash(newBytes),
            newBytesBase64: bytesToBase64(newBytes),
            newExecutable: false,
            newProvenanceFingerprint: FP,
            newMaterializationFingerprint: FP,
            isRemoval: false,
            entryAuthority: "managed_baseline",
        },
    ];
    return {
        schemaVersion: 2,
        transactionId: txnId,
        deploymentId: D1,
        createdAt: 5_000,
        compilationFingerprint: FP,
        reservedPhysicalKeys: computePhysicalClosureKeys("linux", "/root", [
            {
                relativePath: "skills/demo/SKILL.md",
                entryKind: "file",
                containingDirectoryBoundaries: ["skills/demo"],
            },
            { relativePath: "skills/demo", entryKind: "directory" },
        ]),
        entries,
        managedDirectoryBoundaries: ["skills/demo"],
        directoryEntries: [
            {
                relativePath: "skills/demo",
                oldState: "missing",
                desiredState: "present",
                oldIdentity: null,
                createdIdentity: null,
            },
        ],
    };
}

describe("publishJournal / readJournal", () => {
    let root: string;
    beforeEach(() => {
        root = tmpDir("oaam-journal-");
    });
    afterEach(() => {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it("publish then read round-trips the journal", () => {
        const txn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const oldBytes = new Uint8Array([1, 2, 3]);
        const newBytes = new Uint8Array([4, 5, 6]);
        const j = makeJournal(txn, D1, [
            {
                relativePath: "AGENTS.md",
                oldHash: hash(oldBytes),
                oldBytesBase64: bytesToBase64(oldBytes),
                oldExecutable: false,
                oldProvenanceFingerprint: FP,
                oldMaterializationFingerprint: FP,
                newHash: hash(newBytes),
                newBytesBase64: bytesToBase64(newBytes),
                newExecutable: true,
                newProvenanceFingerprint: FP,
                newMaterializationFingerprint: FP,
                isRemoval: false,
            },
        ]);
        publishJournal(root, j);
        const read = readJournal(root, txn);
        expect(read).not.toBeNull();
        expect(read!.transactionId).toBe(txn);
        expect(read!.deploymentId).toBe(D1);
        expect(read!.entries).toHaveLength(1);
        expect(read!.entries[0].newExecutable).toBe(true);
    });

    it("round-trips strict v2 leaf-graph authority and atomically records a created directory identity", () => {
        const txn = "abababab-abab-4bab-8bab-abababababab";
        const journal = makeDirectoryJournal(txn);
        journal.entries.push({
            ...journal.entries[0]!,
            relativePath: "skills/demo/resources/reference.md",
        });
        journal.directoryEntries.push({
            relativePath: "skills/demo/resources",
            oldState: "missing",
            desiredState: "present",
            oldIdentity: null,
            createdIdentity: null,
        });
        journal.reservedPhysicalKeys = computePhysicalClosureKeys("linux", "/root", [
            ...journal.entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries: ["skills/demo"],
            })),
            ...journal.directoryEntries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "directory" as const,
                containingDirectoryBoundaries: ["skills/demo"],
            })),
        ]);
        publishJournal(root, journal);
        expect(readJournal(root, txn)).toEqual(journal);

        const createdIdentity = { deviceId: "device", fileId: "directory", entryKind: "directory" as const };
        const updated = recordJournalCreatedDirectory(root, journal, "skills/demo", createdIdentity);
        expect(updated.directoryEntries[0]?.createdIdentity).toEqual(createdIdentity);
        expect(readJournal(root, txn)).toEqual(updated);
        expect(() => recordJournalCreatedDirectory(root, updated, "skills/demo", createdIdentity)).toThrow(
            /pending missing directory/,
        );
    });

    it("rejects malformed or stale created-directory receipts before journal replacement", () => {
        const txn = "adadadad-adad-4dad-8dad-adadadadadad";
        const journal = makeDirectoryJournal(txn);
        publishJournal(root, journal);
        expect(() =>
            recordJournalCreatedDirectory(root, journal, "skills/demo", {
                deviceId: "device",
                fileId: "file",
                entryKind: "file",
            }),
        ).toThrow(/directory identity/);
        expect(() =>
            recordJournalCreatedDirectory(root, journal, "skills/missing", {
                deviceId: "d",
                fileId: "f",
                entryKind: "directory",
            }),
        ).toThrow(/pending missing directory/);
        const changed = structuredClone(journal);
        changed.directoryEntries[0]!.createdIdentity = { deviceId: "d", fileId: "already", entryKind: "directory" };
        expect(() =>
            recordJournalCreatedDirectory(root, changed, "skills/demo", {
                deviceId: "d",
                fileId: "next",
                entryKind: "directory",
            }),
        ).toThrow(/active journal changed/);
    });

    it("rejects v2 graph journals with incomplete authority, shared-parent ownership, or malformed directory states", () => {
        const txn = "acacacac-acac-4cac-8cac-acacacacacac";
        const base = makeDirectoryJournal(txn);
        const corruptions: Array<(journal: ActiveJournalV2) => void> = [
            (journal) => {
                delete (journal.entries[0] as unknown as Record<string, unknown>).entryAuthority;
            },
            (journal) => {
                journal.entries[0]!.entryAuthority = "unknown" as never;
            },
            (journal) => {
                journal.entries[0]!.entryAuthority = "explicit_unmanaged_replacement";
            },
            (journal) => {
                (journal as unknown as Record<string, unknown>).extra = true;
            },
            (journal) => {
                journal.managedDirectoryBoundaries.push("skills/demo/nested");
            },
            (journal) => {
                journal.directoryEntries.unshift({
                    relativePath: "skills",
                    oldState: "present",
                    desiredState: "present",
                    oldIdentity: { deviceId: "device", fileId: "shared", entryKind: "directory" },
                    createdIdentity: null,
                });
            },
            (journal) => {
                journal.directoryEntries[0]!.oldState = "present";
            },
            (journal) => {
                journal.directoryEntries[0]!.createdIdentity = {
                    deviceId: "device",
                    fileId: "unexpected",
                    entryKind: "file" as never,
                };
            },
            (journal) => {
                journal.directoryEntries.push({
                    relativePath: "outside",
                    oldState: "present",
                    desiredState: "missing",
                    oldIdentity: { deviceId: "device", fileId: "outside", entryKind: "directory" },
                    createdIdentity: null,
                });
            },
            (journal) => {
                journal.entries[0] = {
                    ...journal.entries[0]!,
                    relativePath: "outside.txt",
                    isRemoval: true,
                    newHash: "",
                    newBytesBase64: "",
                    newProvenanceFingerprint: "",
                    newMaterializationFingerprint: "",
                    entryAuthority: "explicit_unmanaged_replacement",
                    runtimeRollbackOverride: {
                        state: "present",
                        contentHash: hash(new Uint8Array([120])),
                        bytesBase64: "eA==",
                        executable: false,
                    },
                };
                journal.directoryEntries = [];
            },
        ];
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        for (const mutate of corruptions) {
            const value = structuredClone(base);
            mutate(value);
            fs.writeFileSync(path.join(root, txn, "journal.json"), JSON.stringify(value));
            expect(readJournal(root, txn)).toBeNull();
        }
    });

    it("readJournal returns null when journal.json missing (H5 fail-closed)", () => {
        expect(readJournal(root, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeNull();
    });

    it("readJournal rejects a path-like transaction id before filesystem access", () => {
        expect(readJournal(root, "../outside")).toBeNull();
    });

    it("readJournal returns null when journal.json is not valid JSON", () => {
        const txn = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(path.join(root, txn, "journal.json"), "{not json");
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when schemaVersion != 1", () => {
        const txn = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 99,
                transactionId: txn,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: [],
                entries: [],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when transactionId is not a string", () => {
        const txn = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: 123,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: [],
                entries: [],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when entries is not an array", () => {
        const txn = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: [],
                entries: "nope",
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when deploymentId is not a string", () => {
        const txn = "11111111-1111-4111-8111-111111111111";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: null,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: [],
                entries: [],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when createdAt is not a number", () => {
        const txn = "22222222-2222-4222-8222-222222222222";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: D1,
                createdAt: "x",
                compilationFingerprint: FP,
                reservedPhysicalKeys: [],
                entries: [],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when parsed JSON is null (typeof-object short-circuit)", () => {
        const txn = "12345678-1234-4234-8234-123456789012";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(path.join(root, txn, "journal.json"), "null");
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when an entry has a missing field (entry shape guard, H5 fail-closed)", () => {
        const txn = "45454545-4545-4545-8454-454545454545";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        // Entry missing newHash + isRemoval → shape guard fails → null.
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: ["linux\0/root", "linux\0/root/a.md"],
                entries: [{ relativePath: "a.md", oldHash: "", oldBytesBase64: "", oldExecutable: false }],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when an entry has a wrong-typed field", () => {
        const txn = "46464646-4646-4646-8464-464646464646";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: ["linux\0/root", "linux\0/root/a.md"],
                entries: [
                    {
                        relativePath: "a.md",
                        oldHash: "",
                        oldBytesBase64: "",
                        oldExecutable: "not-bool",
                        oldProvenanceFingerprint: "",
                        oldMaterializationFingerprint: "",
                        newHash: "",
                        newBytesBase64: "",
                        newExecutable: false,
                        newProvenanceFingerprint: "",
                        newMaterializationFingerprint: "",
                        isRemoval: false,
                    },
                ],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal accepts a structurally-complete entry (positive control)", () => {
        const txn = "47474747-4747-4747-8474-474747474747";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: ["linux\0/root", "linux\0/root/a.md"],
                entries: [
                    {
                        relativePath: "a.md",
                        oldHash: "",
                        oldBytesBase64: "",
                        oldExecutable: false,
                        oldProvenanceFingerprint: "",
                        oldMaterializationFingerprint: "",
                        newHash: hash(new Uint8Array([120])),
                        newBytesBase64: "eA==",
                        newExecutable: false,
                        newProvenanceFingerprint: FP,
                        newMaterializationFingerprint: FP,
                        isRemoval: false,
                    },
                ],
            }),
        );
        expect(readJournal(root, txn)).not.toBeNull();
    });

    it("fails closed on strict authority-binding, byte and absence corruption", () => {
        const txn = "49494949-4949-4949-8494-494949494949";
        const oldBytes = new Uint8Array([1]);
        const newBytes = new Uint8Array([2]);
        const base = makeJournal(txn, D1, [
            {
                relativePath: "a.md",
                oldHash: hash(oldBytes),
                oldBytesBase64: bytesToBase64(oldBytes),
                oldExecutable: false,
                oldProvenanceFingerprint: FP,
                oldMaterializationFingerprint: FP,
                newHash: hash(newBytes),
                newBytesBase64: bytesToBase64(newBytes),
                newExecutable: false,
                newProvenanceFingerprint: FP,
                newMaterializationFingerprint: FP,
                isRemoval: false,
            },
        ]);
        const corruptions: Array<(journal: ActiveJournal) => void> = [
            (journal) => {
                (journal as unknown as Record<string, unknown>).extra = true;
            },
            (journal) => {
                journal.compilationFingerprint = "bad";
            },
            (journal) => {
                (journal as unknown as Record<string, unknown>).reservedPhysicalKeys = "bad";
            },
            (journal) => {
                (journal as unknown as { reservedPhysicalKeys: unknown[] }).reservedPhysicalKeys = [123];
            },
            (journal) => {
                journal.reservedPhysicalKeys = [];
            },
            (journal) => {
                journal.reservedPhysicalKeys = ["unknown\0/root"];
            },
            (journal) => {
                journal.reservedPhysicalKeys = ["linux\0/root\0bad"];
            },
            (journal) => {
                journal.reservedPhysicalKeys.push(journal.reservedPhysicalKeys[0]!);
            },
            (journal) => {
                journal.reservedPhysicalKeys.reverse();
            },
            (journal) => {
                (journal.entries[0] as unknown as Record<string, unknown>).extra = true;
            },
            (journal) => {
                (journal.entries[0] as unknown as Record<string, unknown>).entryAuthority = "managed_baseline";
            },
            (journal) => {
                journal.entries[0]!.relativePath = "../escape";
            },
            (journal) => {
                journal.entries[0]!.oldHash = "bad";
            },
            (journal) => {
                journal.entries[0]!.newHash = "bad";
            },
            (journal) => {
                journal.entries[0]!.oldProvenanceFingerprint = "bad";
            },
            (journal) => {
                journal.entries[0]!.oldMaterializationFingerprint = "bad";
            },
            (journal) => {
                journal.entries[0]!.oldProvenanceFingerprint = "";
            },
            (journal) => {
                journal.entries[0]!.oldMaterializationFingerprint = "";
            },
            (journal) => {
                journal.entries[0]!.newProvenanceFingerprint = "bad";
            },
            (journal) => {
                journal.entries[0]!.newMaterializationFingerprint = "bad";
            },
            (journal) => {
                journal.entries[0]!.oldBytesBase64 = "%%%";
            },
            (journal) => {
                journal.entries[0]!.newBytesBase64 = "%%%";
            },
            (journal) => {
                journal.entries[0]!.oldBytesBase64 = bytesToBase64(new Uint8Array([9]));
            },
            (journal) => {
                journal.entries[0]!.newBytesBase64 = bytesToBase64(new Uint8Array([9]));
            },
            (journal) => {
                (journal.entries[0] as unknown as { runtimeRollbackOverride: unknown }).runtimeRollbackOverride = null;
            },
            (journal) => {
                (journal.entries[0] as unknown as { runtimeRollbackOverride: unknown }).runtimeRollbackOverride = {
                    state: "missing",
                    unexpected: true,
                };
            },
            (journal) => {
                (journal.entries[0] as unknown as { runtimeRollbackOverride: unknown }).runtimeRollbackOverride = {
                    state: "present",
                    contentHash: `sha256:${"0".repeat(64)}`,
                    bytesBase64: "%%%",
                    executable: false,
                };
            },
            (journal) => {
                (journal.entries[0] as unknown as { runtimeRollbackOverride: unknown }).runtimeRollbackOverride = {
                    state: "present",
                    contentHash: `sha256:${"0".repeat(64)}`,
                    bytesBase64: bytesToBase64(new Uint8Array([9])),
                    executable: false,
                };
            },
        ];
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        for (const mutate of corruptions) {
            const value = structuredClone(base);
            mutate(value);
            fs.writeFileSync(path.join(root, txn, "journal.json"), JSON.stringify(value));
            expect(readJournal(root, txn)).toBeNull();
        }

        const absentBase = structuredClone(base);
        absentBase.entries[0]!.oldHash = "";
        absentBase.entries[0]!.oldBytesBase64 = "";
        absentBase.entries[0]!.oldProvenanceFingerprint = "";
        absentBase.entries[0]!.oldMaterializationFingerprint = "";
        for (const mutate of [
            (entry: ActiveJournal["entries"][number]) => {
                entry.oldBytesBase64 = "AA==";
            },
            (entry: ActiveJournal["entries"][number]) => {
                entry.oldProvenanceFingerprint = FP;
            },
            (entry: ActiveJournal["entries"][number]) => {
                entry.oldMaterializationFingerprint = FP;
            },
            (entry: ActiveJournal["entries"][number]) => {
                entry.oldExecutable = true;
            },
        ]) {
            const value = structuredClone(absentBase);
            mutate(value.entries[0]!);
            fs.writeFileSync(path.join(root, txn, "journal.json"), JSON.stringify(value));
            expect(readJournal(root, txn)).toBeNull();
        }

        const removal = structuredClone(base);
        Object.assign(removal.entries[0]!, {
            newHash: "",
            newBytesBase64: "",
            newExecutable: true,
            newProvenanceFingerprint: "",
            newMaterializationFingerprint: "",
            isRemoval: true,
        });
        fs.writeFileSync(path.join(root, txn, "journal.json"), JSON.stringify(removal));
        expect(readJournal(root, txn)).toBeNull();

        const duplicate = structuredClone(base);
        duplicate.entries.push(structuredClone(duplicate.entries[0]!));
        fs.writeFileSync(path.join(root, txn, "journal.json"), JSON.stringify(duplicate));
        expect(readJournal(root, txn)).toBeNull();

        const mismatchedTxn = structuredClone(base);
        mismatchedTxn.transactionId = "50505050-5050-4050-8050-505050505050";
        fs.writeFileSync(path.join(root, txn, "journal.json"), JSON.stringify(mismatchedTxn));
        expect(readJournal(root, txn)).toBeNull();
    });

    it("readJournal returns null when an entry is null (entry typeof-object short-circuit)", () => {
        const txn = "48484848-4848-4848-8484-484848484848";
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        fs.writeFileSync(
            path.join(root, txn, "journal.json"),
            JSON.stringify({
                schemaVersion: 1,
                transactionId: txn,
                deploymentId: D1,
                createdAt: 1,
                compilationFingerprint: FP,
                reservedPhysicalKeys: [],
                entries: [null],
            }),
        );
        expect(readJournal(root, txn)).toBeNull();
    });

    it("publishJournal creates the txn dir if missing", () => {
        const txn = "33333333-3333-4333-8333-333333333333";
        expect(fs.existsSync(path.join(root, txn))).toBe(false);
        publishJournal(root, makeJournal(txn, D1));
        expect(fs.existsSync(path.join(root, txn, "journal.json"))).toBe(true);
    });

    it("publishJournal succeeds when a descriptor-safe txn dir pre-exists without a marker", () => {
        const txn = "34343434-3434-4343-8343-343434343434";
        // Pre-create the txn dir with no journal.json. The safe directory
        // reopen must accept it while the marker no-overwrite guard remains.
        fs.mkdirSync(path.join(root, txn), { recursive: true });
        publishJournal(root, makeJournal(txn, D1));
        expect(readJournal(root, txn)).not.toBeNull();
        expect(readJournal(root, txn)!.deploymentId).toBe(D1);
    });

    it("publishJournal REFUSES to overwrite an existing journal.json (audit fix)", () => {
        const txn = "35353535-3535-4353-8353-353535353535";
        publishJournal(root, makeJournal(txn, D1));
        // Second publish with same txnId must throw — overwriting the active
        // marker would discard recovery material + silently replace reservation.
        expect(() => publishJournal(root, makeJournal(txn, D2))).toThrow();
        // Original journal intact.
        expect(readJournal(root, txn)!.deploymentId).toBe(D1);
    });

    it("publishJournal rejects a non-canonical authority before creating its marker", () => {
        const txn = "36363636-3636-4363-8363-363636363636";
        const invalid = makeJournal(txn, D1);
        invalid.compilationFingerprint = "bad";
        expect(() => publishJournal(root, invalid)).toThrow(/not strict\/canonical/);
        expect(fs.existsSync(path.join(root, txn, "journal.json"))).toBe(false);
    });

    it("rejects a symlinked transactions root without publishing outside it", () => {
        const txn = "37373737-3737-4373-8373-373737373737";
        const outside = tmpDir("oaam-journal-outside-");
        const linkedRoot = path.join(root, "linked-transactions");
        try {
            fs.symlinkSync(outside, linkedRoot);
            expect(() => publishJournal(linkedRoot, makeJournal(txn, D1))).toThrow(/symbolic|link/i);
            expect(fs.existsSync(path.join(outside, txn))).toBe(false);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
