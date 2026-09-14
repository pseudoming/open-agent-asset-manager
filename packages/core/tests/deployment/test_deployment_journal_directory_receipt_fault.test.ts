import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ dropReplacement: false, onDroppedReplacement: null as null | (() => void) }));

vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        durableReplaceFile: (...args: Parameters<typeof actual.durableReplaceFile>) => {
            if (!shared.dropReplacement) return actual.durableReplaceFile(...args);
            shared.onDroppedReplacement?.();
            return undefined;
        },
    };
});

import { type ActiveJournalV2, publishJournal, recordJournalCreatedDirectory } from "../../src/deployment/deployment-journal";
import { ensureManagedTargetDirectories } from "../../src/deployment/deployment-managed-directory-execution";
import { createTargetIo } from "../../src/deployment/deployment-target-io";
import { bytesToBase64, sha256Bytes } from "../../src/foundation/crypto-bytes";
import { computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";

const FP = `sha256:${"a".repeat(64)}`;

describe("created-directory journal receipt read-back", () => {
    let root = "";
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-directory-receipt-"));
        shared.dropReplacement = false;
        shared.onDroppedReplacement = null;
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("fails closed when the replacement marker does not read back", () => {
        const bytes = Buffer.from("skill");
        const journal: ActiveJournalV2 = {
            schemaVersion: 2,
            transactionId: "11111111-1111-4111-8111-111111111111",
            deploymentId: "22222222-2222-4222-8222-222222222222",
            createdAt: 1,
            compilationFingerprint: FP,
            reservedPhysicalKeys: computePhysicalClosureKeys("linux", "/root", [
                {
                    relativePath: "leaf/SKILL.md",
                    entryKind: "file",
                    containingDirectoryBoundaries: ["leaf"],
                },
                { relativePath: "leaf", entryKind: "directory", containingDirectoryBoundaries: ["leaf"] },
            ]),
            entries: [
                {
                    relativePath: "leaf/SKILL.md",
                    oldHash: "",
                    oldBytesBase64: "",
                    oldExecutable: false,
                    oldProvenanceFingerprint: "",
                    oldMaterializationFingerprint: "",
                    newHash: sha256Bytes(bytes),
                    newBytesBase64: bytesToBase64(bytes),
                    newExecutable: false,
                    newProvenanceFingerprint: FP,
                    newMaterializationFingerprint: FP,
                    isRemoval: false,
                    entryAuthority: "managed_baseline",
                },
            ],
            managedDirectoryBoundaries: ["leaf"],
            directoryEntries: [
                {
                    relativePath: "leaf",
                    oldState: "missing",
                    desiredState: "present",
                    oldIdentity: null,
                    createdIdentity: null,
                },
            ],
        };
        publishJournal(root, journal);
        shared.dropReplacement = true;
        expect(() =>
            recordJournalCreatedDirectory(root, journal, "leaf", {
                deviceId: "device",
                fileId: "leaf",
                entryKind: "directory",
            }),
        ).toThrow(/did not read back exactly/);
    });

    it("retains the journal when a failed directory receipt cannot safely clean the populated directory", () => {
        const targetRoot = path.join(root, "target");
        const transactionsRoot = path.join(root, "transactions");
        fs.mkdirSync(targetRoot);
        fs.mkdirSync(transactionsRoot);
        const journal: ActiveJournalV2 = {
            schemaVersion: 2,
            transactionId: "33333333-3333-4333-8333-333333333333",
            deploymentId: "22222222-2222-4222-8222-222222222222",
            createdAt: 1,
            compilationFingerprint: FP,
            reservedPhysicalKeys: computePhysicalClosureKeys("linux", targetRoot, [
                { relativePath: "leaf/SKILL.md", entryKind: "file", containingDirectoryBoundaries: ["leaf"] },
                { relativePath: "leaf", entryKind: "directory", containingDirectoryBoundaries: ["leaf"] },
            ]),
            entries: [
                {
                    relativePath: "leaf/SKILL.md",
                    oldHash: "",
                    oldBytesBase64: "",
                    oldExecutable: false,
                    oldProvenanceFingerprint: "",
                    oldMaterializationFingerprint: "",
                    newHash: sha256Bytes(Buffer.from("skill")),
                    newBytesBase64: bytesToBase64(Buffer.from("skill")),
                    newExecutable: false,
                    newProvenanceFingerprint: FP,
                    newMaterializationFingerprint: FP,
                    isRemoval: false,
                    entryAuthority: "managed_baseline",
                },
            ],
            managedDirectoryBoundaries: ["leaf"],
            directoryEntries: [
                {
                    relativePath: "leaf",
                    oldState: "missing",
                    desiredState: "present",
                    oldIdentity: null,
                    createdIdentity: null,
                },
            ],
        };
        publishJournal(transactionsRoot, journal);
        shared.dropReplacement = true;
        shared.onDroppedReplacement = () => fs.writeFileSync(path.join(targetRoot, "leaf", "foreign.txt"), "foreign");

        expect(
            ensureManagedTargetDirectories({
                ctx: createTargetIo(targetRoot),
                journal,
                transactionsRoot,
                deleteJournal: () => true,
            }),
        ).toMatchObject({ ok: false, message: expect.stringContaining("receipt failed") });
        expect(fs.readFileSync(path.join(targetRoot, "leaf", "foreign.txt"), "utf8")).toBe("foreign");
        expect(fs.existsSync(path.join(transactionsRoot, journal.transactionId, "journal.json"))).toBe(true);
    });
});
