/** Missing shared ancestors are transaction-scoped creations, never managed content boundaries. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDirectoryNoFollow } from "@oaam/shared/filesystem";
import {
    isValidJournal,
    publishJournal,
    readJournal,
    type ActiveJournalV2,
    type JournalEntry,
} from "../../src/deployment/deployment-journal";
import { ensureManagedTargetDirectories } from "../../src/deployment/deployment-managed-directory-execution";
import { cleanupTargetDirectories, createTargetIo, planTargetDirectories } from "../../src/deployment/deployment-target-io";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";

const boundary = ".agents/skills/demo";
const fp = sha256Bytes(Buffer.from("owned graph"));
let root = "";
let target = "";
let transactions = "";
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-missing-managed-parents-"));
    target = path.join(root, "target");
    transactions = path.join(root, "transactions");
    fs.mkdirSync(target);
    fs.mkdirSync(transactions);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function prepare(): ActiveJournalV2 {
    const entries: JournalEntry[] = [
        {
            relativePath: `${boundary}/SKILL.md`,
            oldHash: "",
            oldBytesBase64: "",
            oldExecutable: false,
            oldProvenanceFingerprint: "",
            oldMaterializationFingerprint: "",
            newHash: fp,
            newBytesBase64: Buffer.from("owned graph").toString("base64"),
            newExecutable: false,
            newProvenanceFingerprint: fp,
            newMaterializationFingerprint: fp,
            isRemoval: false,
            entryAuthority: "managed_baseline",
        },
    ];
    const directoryEntries = planTargetDirectories(
        createTargetIo(target),
        entries,
        [],
        [boundary],
        [boundary, `${boundary}/empty`],
    );
    return {
        schemaVersion: 2,
        transactionId: randomUUID(),
        deploymentId: randomUUID(),
        createdAt: Date.now(),
        compilationFingerprint: fp,
        entries,
        managedDirectoryBoundaries: [boundary],
        directoryEntries,
        reservedPhysicalKeys: computePhysicalClosureKeys("linux", target, [
            ...entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries: [boundary],
            })),
            ...directoryEntries.map((entry) => ({ relativePath: entry.relativePath, entryKind: "directory" as const })),
        ]),
    };
}

function create(journal: ActiveJournalV2) {
    publishJournal(transactions, journal);
    return ensureManagedTargetDirectories({
        ctx: createTargetIo(target),
        journal,
        transactionsRoot: transactions,
        deleteJournal: () => {
            throw new Error("unexpected receipt failure cleanup");
        },
    });
}

describe("managed directory missing ancestor creation", () => {
    it("creates and receipts every missing ancestor before the leaf, then restores the original empty target", () => {
        const journal = prepare();
        expect(fs.readdirSync(target)).toEqual([]);
        const created = create(journal);
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) throw new Error(created.message);
        expect(created.journal.directoryEntries.map((entry) => entry.relativePath)).toEqual([
            ".agents",
            ".agents/skills",
            boundary,
            `${boundary}/empty`,
        ]);
        expect(created.journal.managedDirectoryBoundaries).toEqual([boundary]);
        expect(readJournal(transactions, journal.transactionId)).toEqual(created.journal);
        for (const entry of created.journal.directoryEntries) {
            expect(entry.oldState).toBe("missing");
            expect(entry.createdIdentity).toEqual(inspectDirectoryNoFollow(path.join(target, entry.relativePath)));
        }
        expect(cleanupTargetDirectories(createTargetIo(target), created.journal.directoryEntries)).toEqual({
            ok: true,
            failedRelativePaths: [],
        });
        expect(fs.readdirSync(target)).toEqual([]);
    });

    it("preserves existing shared ancestors and another Skill without including them in the journal", () => {
        fs.mkdirSync(path.join(target, ".agents/skills/other"), { recursive: true });
        fs.writeFileSync(path.join(target, ".agents/skills/other/SKILL.md"), "Another Skill\n");
        const parentIdentity = inspectDirectoryNoFollow(path.join(target, ".agents/skills"));
        const journal = prepare();
        expect(journal.directoryEntries.map((entry) => entry.relativePath)).toEqual([boundary, `${boundary}/empty`]);
        const created = create(journal);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.message);
        expect(cleanupTargetDirectories(createTargetIo(target), created.journal.directoryEntries).ok).toBe(true);
        expect(inspectDirectoryNoFollow(path.join(target, ".agents/skills"))).toEqual(parentIdentity);
        expect(fs.readFileSync(path.join(target, ".agents/skills/other/SKILL.md"), "utf8")).toBe("Another Skill\n");
        expect(fs.existsSync(path.join(target, boundary))).toBe(false);
    });

    it("refuses a missing ancestor created by another writer after preparation", () => {
        const journal = prepare();
        fs.mkdirSync(path.join(target, ".agents"));
        fs.writeFileSync(path.join(target, ".agents/foreign.txt"), "Foreign bytes\n");
        const identity = inspectDirectoryNoFollow(path.join(target, ".agents"));
        const created = create(journal);
        expect(created.ok).toBe(false);
        expect(fs.existsSync(path.join(target, ".agents/skills"))).toBe(false);
        expect(inspectDirectoryNoFollow(path.join(target, ".agents"))).toEqual(identity);
        expect(fs.readFileSync(path.join(target, ".agents/foreign.txt"), "utf8")).toBe("Foreign bytes\n");
        expect(readJournal(transactions, journal.transactionId)).toEqual(journal);
    });

    it("keeps a newly created ancestor and journal when foreign content makes cleanup unsafe", () => {
        const journal = prepare();
        const created = create(journal);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.message);
        fs.writeFileSync(path.join(target, ".agents/skills/foreign.txt"), "Do not remove\n");
        const cleanup = cleanupTargetDirectories(createTargetIo(target), created.journal.directoryEntries);
        expect(cleanup.ok).toBe(false);
        expect(cleanup.failedRelativePaths).toContain(".agents/skills");
        expect(fs.existsSync(path.join(target, boundary))).toBe(false);
        expect(fs.readFileSync(path.join(target, ".agents/skills/foreign.txt"), "utf8")).toBe("Do not remove\n");
        expect(readJournal(transactions, journal.transactionId)).toEqual(created.journal);
    });

    it("retains legacy leaf-only journals and rejects existing-parent ownership, ancestor deletion and unrelated creation", () => {
        const journal = prepare();
        expect(isValidJournal(journal)).toBe(true);
        const legacy = structuredClone(journal);
        legacy.directoryEntries = legacy.directoryEntries.filter((entry) => entry.relativePath.startsWith(boundary));
        expect(isValidJournal(legacy)).toBe(true);
        for (const invalidKind of ["existing", "remove", "unrelated"] as const) {
            const invalid = structuredClone(journal);
            const parent = invalid.directoryEntries[0]!;
            if (invalidKind === "unrelated") parent.relativePath = ".foreign";
            else {
                parent.oldState = "present";
                parent.oldIdentity = { deviceId: "device", fileId: "foreign", entryKind: "directory" };
                if (invalidKind === "remove") parent.desiredState = "missing";
            }
            expect(isValidJournal(invalid), invalidKind).toBe(false);
        }
    });

    it("rejects a linked ancestor before creating directories outside the target", () => {
        const foreign = path.join(root, "foreign");
        fs.mkdirSync(foreign);
        fs.symlinkSync(foreign, path.join(target, ".agents"));
        expect(() => prepare()).toThrow();
        expect(fs.readdirSync(foreign)).toEqual([]);
    });
});
