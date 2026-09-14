/** Original service operations with explicit corruption at the graph-channel dependency boundary. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJournal, type ActiveJournalV3 } from "../../src/deployment/deployment-journal";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { bindRestrictedTargetGraphChannel } from "../../src/deployment/restricted-target-graph-channel";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetResult,
    type RestrictedTargetOperation,
    type RestrictedTargetBinding,
} from "../../src/deployment/restricted-target-contract";
import { restrictedGraphJournalFingerprint } from "../../src/deployment/restricted-target-graph-contract";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { fixture, wire, FP, type Fixture } from "./fixtures/restricted-target-graph-fixture";

function peer(h: Fixture, corrupt: (result: RestrictedTargetResult, journal?: ActiveJournalV3) => unknown = (value) => value) {
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, bindings: [h.binding], deadlineAt: Date.now() + 60_000 });
    const invalidate = vi.fn();
    let sequence = 0;
    const call = vi.fn((_binding: RestrictedTargetBinding, operation: RestrictedTargetOperation) => {
        const result = service.handle({
            ...session,
            protocol: RESTRICTED_TARGET_PROTOCOL,
            operationId: randomUUID(),
            sequence: ++sequence,
            bindingId: h.binding.bindingId,
            operation,
        }).result;
        return corrupt(
            structuredClone(result),
            "journal" in operation && operation.journal.schemaVersion === 3 ? operation.journal : undefined,
        ) as RestrictedTargetResult;
    });
    const graph = bindRestrictedTargetGraphChannel(h.binding, call, invalidate);
    const persist = wire(h).persistReceipt;
    return { graph, call, invalidate, persist };
}

describe("restricted graph channel failure boundaries", () => {
    it.each(["conflict", "uncertain"])("preserves the original service execution refusal %s and its journal", (kind) => {
        const h = fixture(true);
        const p = peer(h);
        const prepared = p.graph.prepare(h.input);
        if (prepared.outcome !== "ready") throw new Error("expected preparation");
        if (kind === "conflict") fs.writeFileSync(path.join(h.target, "leaf/SKILL.md"), "third value");
        else {
            const original = targetIo.ioWrite;
            vi.spyOn(targetIo, "ioWrite").mockImplementation((...args) => {
                original(...args);
                throw new Error("write dependency lost its completion receipt");
            });
        }
        expect(p.graph.execute(prepared.prepared.preparationId, h.journal, p.persist).result).toEqual({ outcome: kind });
        expect(p.invalidate).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe(
            kind === "conflict" ? "third value" : "# Complete skill\n",
        );
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("rejects a new-side receipt substituted for the original old-directory restoration receipt", () => {
        const h = fixture(true, true);
        const first = wire(h);
        const prepared = first.graph.prepare(h.input);
        if (prepared.outcome !== "ready") throw new Error("expected preparation");
        const completed = first.graph.execute(prepared.prepared.preparationId, h.journal, first.persistReceipt);
        expect(completed.result.outcome).toBe("verified");
        const p = peer(h, (result) => {
            if (result.kind === "recover_graph" && result.step.kind === "directory_receipt_required") {
                expect(result.step.side).toBe("old");
                result.step.side = "new";
            }
            return result;
        });
        const persist = vi.fn(p.persist);
        expect(p.graph.recover(completed.journal, "old", persist).outcome).toBe("io_failed");
        expect(persist).not.toHaveBeenCalled();
        expect(fs.readdirSync(path.join(h.target, "leaf/obsolete"))).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
    });

    it.each([
        "kind",
        "envelope",
        "outcome",
        "outcome_extra",
        "prepared",
        "entry",
        "directory",
    ])("rejects %s preparation damage after original service preparation", (kind) => {
        const h = fixture();
        const p = peer(h, (result) => {
            if (result.kind !== "prepare_graph" || result.result.outcome !== "ready")
                throw new Error("expected original ready preparation");
            if (kind === "kind") return { kind: "prepare", outcome: "ready" };
            if (kind === "envelope") return { ...result, extra: true };
            if (kind === "outcome") return { ...result, result: { outcome: "unknown" } };
            if (kind === "outcome_extra") return { ...result, result: { outcome: "conflict", extra: true } };
            if (kind === "prepared") Object.assign(result.result.prepared, { extra: true });
            if (kind === "entry") result.result.prepared.entries[0]!.newExecutable = true;
            if (kind === "directory") result.result.prepared.directoryEntries.pop();
            return result;
        });
        expect(p.graph.prepare(h.input)).toEqual({ outcome: "unavailable" });
        expect(p.invalidate).toHaveBeenCalledOnce();
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each([
        "unavailable",
        "conflict",
        "unsupported",
    ])("preserves actual preparation refusal %s without retiring the channel", (kind) => {
        const h = fixture();
        const p = peer(h);
        if (kind === "unavailable") fs.mkdirSync(path.join(h.target, "leaf/SKILL.md"), { recursive: true });
        else if (kind === "conflict") {
            fs.mkdirSync(path.join(h.target, "leaf"));
            fs.writeFileSync(path.join(h.target, "leaf/SKILL.md"), "external value");
        } else
            vi.spyOn(targetIo, "ioAssertExecutableStateSupported").mockImplementation(() => {
                throw new Error("unsupported physical mode");
            });
        expect(p.graph.prepare(h.input)).toEqual({ outcome: kind });
        expect(p.invalidate).not.toHaveBeenCalled();
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each(["empty", "loose_files"])("validates original %s preparation without replacement authority", (kind) => {
        const h = fixture();
        const p = peer(h);
        const input = {
            compilationFingerprint: FP,
            entries: kind === "empty" ? [] : h.input.entries,
            managedDirectoryBoundaries: [],
            desiredDirectoryPaths: [],
        };
        expect(p.graph.prepare(input).outcome).toBe("ready");
        expect(p.invalidate).not.toHaveBeenCalled();
        expect(fs.readdirSync(h.target)).toEqual([]);
    });

    it.each([
        "step",
        "result",
        "verification",
    ])("retains real written files and journal after %s execution response damage", (kind) => {
        const h = fixture(true);
        const p = peer(h, (result) => {
            if (result.kind !== "execute_graph" || result.step.kind !== "executed") return result;
            expect(result.step.result.outcome).toBe("verified");
            if (kind === "step") return { ...result, extra: true };
            if (kind === "result") return { ...result, step: { kind: "executed", result: { outcome: "unknown" } } };
            if (result.step.result.outcome === "verified")
                result.step.result.verified[0]!.appliedContentHash = `sha256:${"0".repeat(64)}`;
            return result;
        });
        const prepared = p.graph.prepare(h.input);
        if (prepared.outcome !== "ready") throw new Error("expected original preparation");
        expect(p.graph.execute(prepared.prepared.preparationId, h.journal, p.persist).result).toEqual({ outcome: "uncertain" });
        expect(p.invalidate).toHaveBeenCalled();
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        const reopened = wire(h);
        expect(reopened.graph.recover(h.journal, "old", reopened.persistReceipt).outcome).toBe("done");
    });

    it("refuses an extra receipt after the original service has completed every recorded directory", () => {
        const h = fixture();
        const p = peer(h, (result, journal) => {
            if (result.kind === "continue_graph" && result.step.kind === "executed") {
                if (journal === undefined) throw new Error("expected final durable journal");
                return {
                    ...result,
                    step: {
                        kind: "directory_receipt_required",
                        side: "new",
                        journalFingerprint: restrictedGraphJournalFingerprint(journal),
                        relativePath: journal.directoryEntries[0]!.relativePath,
                        identity: journal.directoryEntries[0]!.createdIdentity,
                    },
                };
            }
            return result;
        });
        const prepared = p.graph.prepare(h.input);
        if (prepared.outcome !== "ready") throw new Error("expected original preparation");
        const persist = vi.fn(p.persist);
        const result = p.graph.execute(prepared.prepared.preparationId, h.journal, persist);
        expect(result.result).toEqual({ outcome: "uncertain" });
        expect(persist).toHaveBeenCalledTimes(h.journal.directoryEntries.length);
        expect(p.invalidate).toHaveBeenCalled();
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(result.journal);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
    });

    it("rejects a corrupted recovery terminal after original old-side recovery", () => {
        const h = fixture(true);
        const original = wire(h);
        const preparation = original.graph.prepare(h.input);
        if (preparation.outcome !== "ready") throw new Error("expected preparation");
        const completed = original.graph.execute(preparation.prepared.preparationId, h.journal, original.persistReceipt);
        expect(completed.result.outcome).toBe("verified");
        const p = peer(h, (result) =>
            result.kind === "recover_graph" ? { ...result, step: { kind: "recovered", outcome: "unknown" } } : result,
        );
        expect(p.graph.recover(completed.journal, "old", p.persist).outcome).toBe("io_failed");
        expect(p.invalidate).toHaveBeenCalledOnce();
        expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
    });
});
