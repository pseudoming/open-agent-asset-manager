import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { inspectDirectoryNoFollow } from "@oaam/shared/filesystem";
import { describe, expect, it, vi } from "vitest";
import { type ActiveJournalV3, readJournal, recordJournalCreatedDirectory } from "../../src/deployment/deployment-journal";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { createRestrictedTargetGraphOperation } from "../../src/deployment/restricted-target-graph-operation";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";

import { FP, finish, fixture, persist, wire } from "./fixtures/restricted-target-graph-fixture";

describe("restricted target graph durable directory continuation", () => {
    it.each([
        false,
        true,
    ])("preserves a second-file third value after a real first write; rollback failure=%s", (failRollback) => {
        const oldFirst = Buffer.from([0, 255, 10, 128]);
        const oldSecond = Buffer.from("# Old runnable resource\n");
        const third = Buffer.from("# Independently changed resource\n");
        const h = fixture(true, false, "leaf", (target) => {
            fs.writeFileSync(path.join(target, "leaf/SKILL.md"), oldFirst, { mode: 0o744 });
            fs.writeFileSync(path.join(target, "leaf/resources/run.sh"), oldSecond, { mode: 0o644 });
        });
        const first = path.join(h.target, "leaf/SKILL.md");
        const second = path.join(h.target, "leaf/resources/run.sh");
        const write = targetIo.ioWrite;
        const writes: Buffer[] = [];
        const seam = vi.spyOn(targetIo, "ioWrite").mockImplementation((ctx, absolutePath, bytes) => {
            if (absolutePath === first) {
                writes.push(Buffer.from(bytes));
                if (writes.length > 1 && failRollback) throw new Error("owned control denies rollback write");
            }
            write(ctx, absolutePath, bytes);
            if (absolutePath === first && writes.length === 1) {
                expect(fs.readFileSync(first)).toEqual(Buffer.from("# Complete skill\n"));
                fs.writeFileSync(second, third);
            }
        });
        const result = finish(h);
        expect(result.step).toEqual({ kind: "executed", result: { outcome: failRollback ? "uncertain" : "conflict" } });
        expect(writes).toEqual([Buffer.from("# Complete skill\n"), oldFirst]);
        expect(fs.readFileSync(first)).toEqual(failRollback ? Buffer.from("# Complete skill\n") : oldFirst);
        expect(fs.statSync(first).mode & 0o111).toBe(failRollback ? 0 : 0o100);
        expect(fs.readFileSync(second)).toEqual(third);
        expect(fs.statSync(second).mode & 0o111).toBe(0);
        expect(fs.readdirSync(path.join(h.target, "leaf/empty"))).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        seam.mockRestore();
        const recovery = createRestrictedTargetGraphOperation(h.binding);
        expect(recovery.recover(h.journal, "old")).toEqual({ kind: "recovered", outcome: "third_value" });
        expect(fs.readFileSync(first)).toEqual(oldFirst);
        expect(fs.statSync(first).mode & 0o111).toBe(0o100);
        expect(fs.readFileSync(second)).toEqual(third);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each([
        "existing-parent",
        "ancestor-removal",
        "unrelated",
        "missing-native-directory",
    ] as const)("rejects a %s response that broadens or drops the reviewed nested graph", (change) => {
        const h = fixture(false, false, ".agents/skills/leaf");
        const peer = wire(h, (response) => {
            if (response.result.kind !== "prepare_graph" || response.result.result.outcome !== "ready") return;
            const entries = response.result.result.prepared.directoryEntries;
            const parent = entries[0]!;
            if (change === "unrelated") parent.relativePath = ".foreign";
            else if (change === "missing-native-directory")
                entries.splice(
                    entries.findIndex((entry) => entry.relativePath === `${h.leaf}/empty`),
                    1,
                );
            else {
                parent.oldState = "present";
                parent.oldIdentity = inspectDirectoryNoFollow(h.target);
                if (change === "ancestor-removal") parent.desiredState = "missing";
            }
        });
        expect(peer.graph.prepare(h.input)).toEqual({ outcome: "unavailable" });
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("creates a nested managed graph through durable ancestor receipts and restores every original missing path", () => {
        const h = fixture(false, false, ".agents/skills/leaf");
        expect(fs.readdirSync(h.target)).toEqual([]);
        const { journal, step, receipts } = finish(h);
        expect(receipts).toEqual([".agents", ".agents/skills", h.leaf, `${h.leaf}/empty`, `${h.leaf}/resources`]);
        expect(journal.managedDirectoryBoundaries).toEqual([h.leaf]);
        expect(step).toEqual({ kind: "executed", result: { outcome: "verified", verified: expect.any(Array) } });
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(fs.statSync(path.join(h.target, h.leaf, "resources/run.sh")).mode & 0o111).not.toBe(0);
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
        expect(createRestrictedTargetGraphOperation(h.binding).recover(journal, "old")).toEqual({
            kind: "recovered",
            outcome: "done",
        });
        expect(fs.readdirSync(h.target)).toEqual([]);
    });

    it("retains a receipted ancestor and the original journal when another writer populates that shared parent", () => {
        const h = fixture(false, false, ".agents/skills/leaf");
        const { journal } = finish(h);
        fs.writeFileSync(path.join(h.target, ".agents/skills/other.txt"), "Foreign content\n");
        expect(createRestrictedTargetGraphOperation(h.binding).recover(journal, "old")).toEqual({
            kind: "recovered",
            outcome: "io_failed",
        });
        expect(fs.readFileSync(path.join(h.target, ".agents/skills/other.txt"), "utf8")).toBe("Foreign content\n");
        expect(fs.existsSync(path.join(h.target, h.leaf))).toBe(false);
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("prepares without target writes and waits for three exact durable receipts before writing the complete graph", () => {
        const h = fixture();
        expect(fs.readdirSync(h.target)).toEqual([]);
        const { journal, step, receipts } = finish(h);
        expect(receipts).toEqual(["leaf", "leaf/empty", "leaf/resources"]);
        expect(step).toEqual({ kind: "executed", result: { outcome: "verified", verified: expect.any(Array) } });
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(fs.readFileSync(path.join(h.target, "leaf/resources/run.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
        expect(fs.statSync(path.join(h.target, "leaf/resources/run.sh")).mode & 0o111).not.toBe(0);
        expect(fs.readdirSync(path.join(h.target, "leaf/empty"))).toEqual([]);
        for (const entry of journal.directoryEntries) {
            expect(entry.createdIdentity).toEqual(inspectDirectoryNoFollow(path.join(h.target, entry.relativePath)));
        }
        // The service has no authority to resolve Windows' durable marker.
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
        expect(() => h.operation.execute(h.prepared.preparationId, journal)).toThrow(/cannot be replayed/);
    });

    it("rejects the previous or tampered journal while the first directory awaits its durable receipt", () => {
        const h = fixture();
        const step = h.operation.execute(h.prepared.preparationId, h.journal);
        expect(step.kind).toBe("directory_receipt_required");
        expect(() => h.operation.continue(h.journal)).toThrow(/durable receipt/);
        expect(() => h.operation.recover(h.journal, "old")).toThrow(/pending operation/);
        const updated = persist(h, h.journal, step);
        expect(() => h.operation.continue({ ...updated, createdAt: updated.createdAt + 1 })).toThrow(/durable receipt/);
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
        expect(h.operation.continue(updated).kind).toBe("directory_receipt_required");
    });

    it.each([
        "old",
        "new",
    ] as const)("blocks %s recovery after mkdir succeeds but before any identity receipt reaches Windows", (side) => {
        const h = fixture();
        const step = h.operation.execute(h.prepared.preparationId, h.journal);
        expect(step.kind).toBe("directory_receipt_required");
        const identity = inspectDirectoryNoFollow(path.join(h.target, "leaf"));
        const reopened = createRestrictedTargetGraphOperation(h.binding);
        const ensure = vi.spyOn(targetIo, "ensureTargetDirectory");
        expect(reopened.recover(readJournal(h.transactions, h.journal.transactionId) as ActiveJournalV3, side)).toEqual({
            kind: "recovered",
            outcome: "third_value",
        });
        expect(ensure).not.toHaveBeenCalled();
        expect(inspectDirectoryNoFollow(path.join(h.target, "leaf"))).toEqual(identity);
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("uses the original journal after all directory receipts persist but the final acknowledgement is lost", () => {
        const h = fixture();
        let journal = h.journal;
        let step = h.operation.execute(h.prepared.preparationId, journal);
        for (let index = 0; index < 3; index++) {
            journal = persist(h, journal, step);
            if (index < 2) step = h.operation.continue(journal);
        }
        expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
        const ensure = vi.spyOn(targetIo, "ensureTargetDirectory");
        const reopened = createRestrictedTargetGraphOperation(h.binding);
        expect(reopened.recover(readJournal(h.transactions, journal.transactionId) as ActiveJournalV3, "new")).toEqual({
            kind: "recovered",
            outcome: "done",
        });
        expect(ensure).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("rolls back an acknowledged directory whose acknowledgement never reached the old service", () => {
        const h = fixture();
        const step = h.operation.execute(h.prepared.preparationId, h.journal);
        const journal = persist(h, h.journal, step);
        const reopened = createRestrictedTargetGraphOperation(h.binding);
        expect(reopened.recover(journal, "old")).toEqual({ kind: "recovered", outcome: "done" });
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("restores the complete old graph after file writes finish and the execution response is lost", () => {
        const h = fixture();
        const { journal, step } = finish(h);
        expect(step.kind).toBe("executed");
        const reopened = createRestrictedTargetGraphOperation(h.binding);
        expect(reopened.recover(journal, "old")).toEqual({ kind: "recovered", outcome: "done" });
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("persists each recreated old directory before restoring its binary file, and reopens without repeating mkdir", () => {
        const h = fixture(true, true);
        const applied = finish(h);
        expect(applied.step).toEqual({ kind: "executed", result: { outcome: "verified", verified: expect.any(Array) } });
        expect(fs.existsSync(path.join(h.target, "leaf/obsolete"))).toBe(false);
        let journal = applied.journal;
        let step = createRestrictedTargetGraphOperation(h.binding).recover(journal, "old");
        for (const relativePath of ["leaf/obsolete", "leaf/obsolete/empty"]) {
            expect(step).toEqual(expect.objectContaining({ kind: "directory_receipt_required", side: "old", relativePath }));
            expect(fs.existsSync(path.join(h.target, "leaf/obsolete/old.bin"))).toBe(false);
            journal = persist(h, journal, step);
            const entry = journal.directoryEntries.find((entry) => entry.relativePath === relativePath)!;
            expect(entry.restoredIdentity).toEqual(inspectDirectoryNoFollow(path.join(h.target, relativePath)));
            expect(entry.restoredIdentity).not.toEqual(entry.oldIdentity);
            // Lose this acknowledgement and create a fresh operation owner.
            step = createRestrictedTargetGraphOperation(h.binding).recover(
                readJournal(h.transactions, journal.transactionId) as ActiveJournalV3,
                "old",
            );
        }
        expect(step).toEqual({ kind: "recovered", outcome: "done" });
        expect(fs.readFileSync(path.join(h.target, "leaf/obsolete/old.bin"))).toEqual(Buffer.from([0, 255, 10, 128]));
        expect(fs.statSync(path.join(h.target, "leaf/obsolete/old.bin")).mode & 0o111).not.toBe(0);
        expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
        expect(fs.readdirSync(path.join(h.target, "leaf/obsolete/empty"))).toEqual([]);
        const restore = vi.spyOn(targetIo, "restoreTargetDirectory");
        expect(createRestrictedTargetGraphOperation(h.binding).recover(journal, "old")).toEqual({
            kind: "recovered",
            outcome: "done",
        });
        expect(restore).not.toHaveBeenCalled();
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("retains an old-side recreation that lost contact before its identity reached the journal", () => {
        const h = fixture(true, true);
        const { journal } = finish(h);
        const step = createRestrictedTargetGraphOperation(h.binding).recover(journal, "old");
        expect(step).toEqual(
            expect.objectContaining({ kind: "directory_receipt_required", side: "old", relativePath: "leaf/obsolete" }),
        );
        const identity = inspectDirectoryNoFollow(path.join(h.target, "leaf/obsolete"));
        const restore = vi.spyOn(targetIo, "restoreTargetDirectory");
        expect(createRestrictedTargetGraphOperation(h.binding).recover(journal, "old")).toEqual({
            kind: "recovered",
            outcome: "third_value",
        });
        expect(restore).not.toHaveBeenCalled();
        expect(inspectDirectoryNoFollow(path.join(h.target, "leaf/obsolete"))).toEqual(identity);
        expect(fs.readdirSync(path.join(h.target, "leaf/obsolete"))).toEqual([]);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("preserves a third-party replacement after an old-side recreation identity was persisted", () => {
        const h = fixture(true, true);
        const applied = finish(h);
        const step = createRestrictedTargetGraphOperation(h.binding).recover(applied.journal, "old");
        const journal = persist(h, applied.journal, step);
        fs.renameSync(path.join(h.target, "leaf/obsolete"), path.join(h.root, "retained-restoration"));
        fs.mkdirSync(path.join(h.target, "leaf/obsolete"));
        fs.writeFileSync(path.join(h.target, "leaf/obsolete/external.txt"), "keep external");
        const identity = inspectDirectoryNoFollow(path.join(h.target, "leaf/obsolete"));
        expect(createRestrictedTargetGraphOperation(h.binding).recover(journal, "old")).toEqual({
            kind: "recovered",
            outcome: "third_value",
        });
        expect(inspectDirectoryNoFollow(path.join(h.target, "leaf/obsolete"))).toEqual(identity);
        expect(fs.readFileSync(path.join(h.target, "leaf/obsolete/external.txt"), "utf8")).toBe("keep external");
        expect(fs.existsSync(path.join(h.target, "leaf/obsolete/old.bin"))).toBe(false);
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it.each([
        "old",
        "new",
    ] as const)("preserves a third-party replacement of a receipted directory during %s recovery", (side) => {
        const h = fixture();
        const step = h.operation.execute(h.prepared.preparationId, h.journal);
        const journal = persist(h, h.journal, step);
        fs.renameSync(path.join(h.target, "leaf"), path.join(h.root, "retained-owned-leaf"));
        fs.mkdirSync(path.join(h.target, "leaf"));
        fs.writeFileSync(path.join(h.target, "leaf/third-party.txt"), "keep me");
        const identity = inspectDirectoryNoFollow(path.join(h.target, "leaf"));
        const reopened = createRestrictedTargetGraphOperation(h.binding);
        expect(reopened.recover(journal, side)).toEqual({ kind: "recovered", outcome: "third_value" });
        expect(inspectDirectoryNoFollow(path.join(h.target, "leaf"))).toEqual(identity);
        expect(fs.readFileSync(path.join(h.target, "leaf/third-party.txt"), "utf8")).toBe("keep me");
        expect(readJournal(h.transactions, journal.transactionId)).toEqual(journal);
    });

    it("records old directories from local observation and refuses a mixed-origin journal before writes", () => {
        const h = fixture(true);
        expect(h.prepared.directoryEntries.every((entry) => entry.oldState === "present")).toBe(true);
        for (const entry of h.prepared.directoryEntries) {
            expect(entry.oldIdentity).toEqual(inspectDirectoryNoFollow(path.join(h.target, entry.relativePath)));
        }
        const mixed = structuredClone(h.journal);
        mixed.directoryEntries[0]!.oldIdentity = {
            deviceId: "windows-volume",
            fileId: "windows-file-id",
            entryKind: "directory",
        };
        expect(() => h.operation.execute(h.prepared.preparationId, mixed)).toThrow(/differs from its preparation/);
        expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
        expect(h.operation.execute(h.prepared.preparationId, h.journal)).toEqual({
            kind: "executed",
            result: { outcome: "verified", verified: expect.any(Array) },
        });
    });

    it("refuses recovery after the selected root itself is replaced", () => {
        const h = fixture();
        fs.renameSync(h.target, path.join(h.root, "retained-original-target"));
        fs.mkdirSync(h.target);
        fs.writeFileSync(path.join(h.target, "external.txt"), "keep root");
        const reopened = createRestrictedTargetGraphOperation(h.binding);
        expect(() => reopened.recover(h.journal, "new")).toThrow(/execution binding mismatch/);
        expect(fs.readFileSync(path.join(h.target, "external.txt"), "utf8")).toBe("keep root");
        expect(fs.existsSync(path.join(h.target, "leaf"))).toBe(false);
    });

    it("rejects a changed distro or legacy journal instead of interpreting its directory identities locally", () => {
        const h = fixture();
        const changed = structuredClone(h.journal);
        changed.targetExecution.platformInstanceId = "other-selected";
        expect(() => h.operation.recover(changed, "old")).toThrow(/execution binding mismatch/);
        const { targetExecution: _execution, ...rest } = h.journal;
        expect(() => h.operation.recover({ ...rest, schemaVersion: 2 } as unknown as ActiveJournalV3, "new")).toThrow(
            /execution binding mismatch/,
        );
        expect(fs.readdirSync(h.target)).toEqual([]);
    });

    it("rejects traversal and missing directory review before reading or changing target entries", () => {
        const h = fixture();
        const malformed = structuredClone(h.input);
        malformed.entries[0]!.relativePath = "../outside.md";
        expect(() => h.operation.prepare(malformed)).toThrow(/invalid restricted graph preparation/);
        const { runtimeReplacementAuthority: _authority, ...noReview } = h.input;
        expect(() => h.operation.prepare(noReview)).toThrow(/exact reviewed directory authority/);
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });
});

describe("restricted target graph through the real private request/response channel", () => {
    it("carries every directory receipt through Windows journal readback before returning exact graph verification", () => {
        const h = fixture();
        const connection = wire(h);
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const persisted: string[] = [];
        const result = connection.graph.execute(preparation.prepared.preparationId, h.journal, (...args) => {
            expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
            persisted.push(args[1]);
            return connection.persistReceipt(...args);
        });
        expect(result.result.outcome).toBe("verified");
        expect(persisted).toEqual(["leaf", "leaf/empty", "leaf/resources"]);
        expect(connection.requests.map((request) => request.operation.kind)).toEqual([
            "prepare_graph",
            "execute_graph",
            "continue_graph",
            "continue_graph",
            "continue_graph",
        ]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(result.journal);
        expect(connection.channel.available).toBe(true);
    });

    it("preserves binary rollback bytes and records old-side directory recreation across the JSON protocol", () => {
        const h = fixture(true, true);
        const connection = wire(h);
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const applied = connection.graph.execute(preparation.prepared.preparationId, h.journal, connection.persistReceipt);
        expect(applied.result.outcome).toBe("verified");
        const reopened = wire(h);
        const restored: string[] = [];
        const recovered = reopened.graph.recover(applied.journal, "old", (...args) => {
            expect(args[3]).toBe("old");
            expect(fs.existsSync(path.join(h.target, "leaf/obsolete/old.bin"))).toBe(false);
            restored.push(args[1]);
            return reopened.persistReceipt(...args);
        });
        expect(recovered.outcome).toBe("done");
        expect(restored).toEqual(["leaf/obsolete", "leaf/obsolete/empty"]);
        expect(fs.readFileSync(path.join(h.target, "leaf/obsolete/old.bin"))).toEqual(Buffer.from([0, 255, 10, 128]));
        expect(fs.statSync(path.join(h.target, "leaf/obsolete/old.bin")).mode & 0o111).not.toBe(0);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(recovered.journal);
    });

    it("rejects a self-consistent changed desired file in the prepared response", () => {
        const h = fixture();
        const connection = wire(h, (response) => {
            if (response.result.kind !== "prepare_graph" || response.result.result.outcome !== "ready") return;
            const entry = response.result.result.prepared.entries[0]!;
            entry.newBytesBase64 = Buffer.from("changed desired bytes").toString("base64");
            entry.newHash = sha256Bytes(Buffer.from("changed desired bytes"));
        });
        expect(connection.graph.prepare(h.input)).toEqual({ outcome: "unavailable" });
        expect(connection.channel.available).toBe(false);
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(connection.requests).toHaveLength(1);
    });

    it("stops at a failed durable receipt without replay or a following target mutation", () => {
        const h = fixture();
        const connection = wire(h);
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const result = connection.graph.execute(preparation.prepared.preparationId, h.journal, () => {
            throw new Error("injected Windows receipt failure");
        });
        expect(result.result.outcome).toBe("uncertain");
        expect(result.journal).toEqual(h.journal);
        expect(connection.channel.available).toBe(false);
        expect(connection.requests.map((request) => request.operation.kind)).toEqual(["prepare_graph", "execute_graph"]);
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        const reopened = wire(h);
        expect(reopened.graph.recover(h.journal, "old", reopened.persistReceipt).outcome).toBe("third_value");
    });

    it.each([
        "fingerprint",
        "side",
        "identity",
        "extra",
    ])("rejects damaged receipt %s before persistence or continuation", (field) => {
        const h = fixture();
        const connection = wire(h, (response) => {
            if (response.result.kind !== "execute_graph" || response.result.step.kind !== "directory_receipt_required") return;
            const step = response.result.step;
            if (field === "fingerprint") step.journalFingerprint = FP;
            else if (field === "side") step.side = "old";
            else if (field === "identity") Object.assign(step, { identity: null });
            else Object.assign(step, { unrequested: true });
        });
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const persistReceipt = vi.fn(connection.persistReceipt);
        const result = connection.graph.execute(preparation.prepared.preparationId, h.journal, persistReceipt);
        expect(result).toEqual({ result: { outcome: "uncertain" }, journal: h.journal });
        expect(persistReceipt).not.toHaveBeenCalled();
        expect(connection.requests.map((request) => request.operation.kind)).toEqual(["prepare_graph", "execute_graph"]);
        expect(connection.channel.available).toBe(false);
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each([
        "deployment",
        "distro",
        "host_root",
        "execution_root",
    ])("refuses a foreign journal %s binding before execution", (field) => {
        const h = fixture();
        const connection = wire(h);
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const journal = structuredClone(h.journal);
        if (field === "deployment") journal.deploymentId = randomUUID();
        else if (field === "distro") journal.targetExecution.platformInstanceId = "another-selected";
        else if (field === "host_root") journal.targetExecution.targetRootPath = `${h.target}-other`;
        else journal.targetExecution.executionRootPath = `${h.target}-other`;
        const persistReceipt = vi.fn(connection.persistReceipt);
        expect(connection.graph.execute(preparation.prepared.preparationId, journal, persistReceipt).result.outcome).toBe(
            "uncertain",
        );
        expect(persistReceipt).not.toHaveBeenCalled();
        expect(connection.requests.map((request) => request.operation.kind)).toEqual(["prepare_graph"]);
        expect(connection.channel.available).toBe(false);
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each([
        "deployment",
        "compilation",
        "receipt",
    ])("retains the durable journal when persistence returns altered %s", (field) => {
        const h = fixture();
        const connection = wire(h);
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        let persisted: ActiveJournalV3 | undefined;
        const result = connection.graph.execute(preparation.prepared.preparationId, h.journal, (...args) => {
            persisted = connection.persistReceipt(...args);
            const damaged = structuredClone(persisted);
            if (field === "deployment") damaged.deploymentId = randomUUID();
            else if (field === "compilation") damaged.compilationFingerprint = sha256Bytes(Buffer.from("other compilation"));
            else damaged.directoryEntries[0]!.createdIdentity = null;
            return damaged;
        });
        expect(result).toEqual({ result: { outcome: "uncertain" }, journal: h.journal });
        expect(connection.channel.available).toBe(false);
        expect(connection.requests.map((request) => request.operation.kind)).toEqual(["prepare_graph", "execute_graph"]);
        expect(persisted?.directoryEntries[0]?.createdIdentity).not.toBeNull();
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(persisted);
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
        const reopened = wire(h);
        expect(reopened.graph.recover(persisted!, "old", reopened.persistReceipt).outcome).toBe("done");
        expect(fs.readdirSync(h.target)).toEqual([]);
    });

    it("recovers the disk journal when receipt persistence succeeds but its return is lost", () => {
        const h = fixture();
        const connection = wire(h);
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const result = connection.graph.execute(preparation.prepared.preparationId, h.journal, (...args) => {
            connection.persistReceipt(...args);
            throw new Error("injected lost persistence return");
        });
        expect(result.result.outcome).toBe("uncertain");
        const retained = readJournal(h.transactions, h.journal.transactionId) as ActiveJournalV3;
        expect(retained.directoryEntries[0]!.createdIdentity).not.toBeNull();
        const reopened = wire(h);
        expect(reopened.graph.recover(retained, "old", reopened.persistReceipt).outcome).toBe("done");
        expect(fs.readdirSync(h.target)).toEqual([]);
    });

    it("refuses an unrelated receipt path and retains the original journal", () => {
        const h = fixture();
        const connection = wire(h, (response) => {
            if (response.result.kind === "execute_graph" && response.result.step.kind === "directory_receipt_required")
                response.result.step.relativePath = "unapproved-leaf";
        });
        const preparation = connection.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("wire preparation did not complete");
        const persistReceipt = vi.fn(connection.persistReceipt);
        expect(connection.graph.execute(preparation.prepared.preparationId, h.journal, persistReceipt).result.outcome).toBe(
            "uncertain",
        );
        expect(persistReceipt).not.toHaveBeenCalled();
        expect(connection.channel.available).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        expect(fs.existsSync(path.join(h.target, "unapproved-leaf"))).toBe(false);
    });
});
