import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDirectoryNoFollow } from "@oaam/shared/filesystem";
import {
    type ActiveJournalV3,
    getJournalDirectoryEntries,
    isValidJournal,
    publishJournal,
    readJournal,
    recordJournalCreatedDirectory,
    scanActiveJournalReservations,
} from "../../src/deployment/deployment-journal";
import { recoverDeployment } from "../../src/deployment/deployment-recovery";
import { computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";
import { D1, TXN_NO, deployEntry, harness, sha } from "./fixtures/deployment-recovery-test-fixtures";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-journal-execution-"));
    roots.push(root);
    const journal: ActiveJournalV3 = {
        schemaVersion: 3,
        transactionId: TXN_NO,
        deploymentId: D1,
        createdAt: 1,
        compilationFingerprint: sha("compiled"),
        entries: [
            {
                ...deployEntry("leaf/SKILL.md", "", "new"),
                entryAuthority: "managed_baseline",
                newProvenanceFingerprint: sha("provenance"),
                newMaterializationFingerprint: sha("materialization"),
            },
        ],
        reservedPhysicalKeys: computePhysicalClosureKeys("wsl", root, [
            { relativePath: "leaf/SKILL.md", entryKind: "file", containingDirectoryBoundaries: ["leaf"] },
            { relativePath: "leaf", entryKind: "directory" },
        ]),
        managedDirectoryBoundaries: ["leaf"],
        directoryEntries: [
            {
                relativePath: "leaf",
                oldState: "missing",
                desiredState: "present",
                oldIdentity: null,
                createdIdentity: null,
                restoredIdentity: null,
            },
        ],
        targetExecution: {
            kind: "selected_wsl",
            platformInstanceId: "test-selected",
            targetRootPath: root,
            executionRootPath: root,
            rootIdentity: inspectDirectoryNoFollow(root),
        },
    };
    return { root, journal };
}

describe("selected-WSL journal execution provenance", () => {
    it("retains a complete directory reservation and the execution binding through durable receipt publication", () => {
        const { root, journal } = fixture();
        const transactions = path.join(root, "transactions");
        publishJournal(transactions, journal);
        expect(readJournal(transactions, TXN_NO)).toEqual(journal);
        expect(scanActiveJournalReservations(transactions).journals).toEqual([journal]);
        fs.mkdirSync(path.join(root, "leaf"));
        const identity = inspectDirectoryNoFollow(path.join(root, "leaf"));
        const updated = recordJournalCreatedDirectory(transactions, journal, "leaf", identity);
        expect(updated.schemaVersion).toBe(3);
        expect(updated.targetExecution).toEqual(journal.targetExecution);
        expect(updated.reservedPhysicalKeys).toEqual(journal.reservedPhysicalKeys);
        expect(getJournalDirectoryEntries(updated)[0]?.createdIdentity).toEqual(identity);
        expect(readJournal(transactions, TXN_NO)).toEqual(updated);
        expect(() => recordJournalCreatedDirectory(transactions, journal, "leaf", identity)).toThrow(/active journal changed/);
        expect(() => recordJournalCreatedDirectory(transactions, updated, "leaf", identity)).toThrow(/pending missing directory/);
    });

    it.each([
        [
            "missing binding",
            (j: Record<string, unknown>) => {
                delete j.targetExecution;
            },
        ],
        [
            "legacy version with binding",
            (j: Record<string, unknown>) => {
                j.schemaVersion = 2;
            },
        ],
        [
            "foreign execution root",
            (j: Record<string, unknown>) => {
                (j.targetExecution as Record<string, unknown>).executionRootPath = "/foreign";
            },
        ],
        [
            "unsafe distro",
            (j: Record<string, unknown>) => {
                (j.targetExecution as Record<string, unknown>).platformInstanceId = "../other";
            },
        ],
        [
            "file root identity",
            (j: Record<string, unknown>) => {
                ((j.targetExecution as Record<string, unknown>).rootIdentity as Record<string, unknown>).entryKind = "file";
            },
        ],
        [
            "missing root identity",
            (j: Record<string, unknown>) => {
                (j.targetExecution as Record<string, unknown>).rootIdentity = null;
            },
        ],
        [
            "unknown binding field",
            (j: Record<string, unknown>) => {
                (j.targetExecution as Record<string, unknown>).extra = true;
            },
        ],
        [
            "unknown execution owner",
            (j: Record<string, unknown>) => {
                (j.targetExecution as Record<string, unknown>).kind = "host";
            },
        ],
        [
            "missing entry authority",
            (j: Record<string, unknown>) => {
                delete (j.entries as Array<Record<string, unknown>>)[0]!.entryAuthority;
            },
        ],
        [
            "missing directory member",
            (j: Record<string, unknown>) => {
                j.directoryEntries = [];
            },
        ],
    ])("rejects %s before the journal can become recovery authority", (_name, corrupt) => {
        const { root, journal } = fixture();
        const value = structuredClone(journal) as unknown as Record<string, unknown>;
        corrupt(value);
        expect(isValidJournal(value)).toBe(false);
        expect(() => publishJournal(path.join(root, "transactions"), value as unknown as ActiveJournalV3)).toThrow();
    });

    it("preserves strict legacy v2 journal bytes without inferring an execution binding", () => {
        const { journal } = fixture();
        const { targetExecution: _execution, ...rest } = journal;
        const legacy = {
            ...rest,
            directoryEntries: rest.directoryEntries.map(({ restoredIdentity: _restored, ...entry }) => entry),
            schemaVersion: 2 as const,
        };
        expect(isValidJournal(legacy)).toBe(true);
        expect(getJournalDirectoryEntries(legacy)).toEqual(legacy.directoryEntries);
        expect("targetExecution" in legacy).toBe(false);
    });

    it("retains a Linux-identity journal and untouched runtime when recovery has no matching execution owner", () => {
        const h = harness("");
        try {
            const { journal } = fixture();
            h.db
                .prepare("UPDATE deployments SET platform='wsl', platform_instance_id='test-selected' WHERE deployment_id=?")
                .run(D1);
            const file = path.join(h.root, "untouched.md");
            fs.writeFileSync(file, "external value");
            publishJournal(h.txnRoot, journal);
            expect(recoverDeployment(h.db, h.txnRoot, TXN_NO, localTargetTransactions)).toEqual({
                outcome: "blocked",
                reasonCode: "blocked_by_recovery_target_unavailable",
                journalResolved: false,
            });
            expect(readJournal(h.txnRoot, TXN_NO)).toEqual(journal);
            expect(fs.readFileSync(file, "utf8")).toBe("external value");
            expect(fs.existsSync(path.join(h.txnRoot, "locks"))).toBe(false);
        } finally {
            h.cleanup();
        }
    });
});
