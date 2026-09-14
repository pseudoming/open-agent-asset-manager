/** V4 publication through the production serialized service/channel and Host journal owner. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixture, wire } from "./fixtures/restricted-target-graph-fixture";
import { readJournal, type ActiveJournalV4 } from "../../src/deployment/deployment-journal";
import { recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import * as publicationIo from "../../src/deployment/deployment-publication-io";
import type { RestrictedTargetResponse } from "../../src/deployment/restricted-target-contract";

function publicationWire(corrupt?: (response: RestrictedTargetResponse) => void) {
    const h = fixture(true, true, "leaf", (root) => fs.writeFileSync(path.join(root, "leaf/SKILL.md"), "# original\n"));
    vi.spyOn(publicationIo, "publicationStagingRoot").mockImplementation((_ctx, transactionId) =>
        path.join(h.root, `oaam-deployment-${transactionId}`),
    );
    const channel = wire(h, corrupt);
    const prepared = channel.graph.prepare({
        ...h.input,
        runtimeReplacementAuthority: h.preview.runtimeReplacementAuthority,
        publicationTransactionId: h.journal.transactionId,
    });
    expect(prepared.outcome).toBe("ready");
    if (prepared.outcome !== "ready" || prepared.prepared.publication === undefined)
        throw new Error("V4 preparation unavailable");
    const result = prepared.prepared;
    const journal: ActiveJournalV4 = {
        ...h.journal,
        schemaVersion: 4,
        entries: result.entries,
        directoryEntries: result.directoryEntries.map(({ restoredIdentity: _restored, ...entry }) => entry),
        targetExecution: result.targetExecution,
        staging: result.publication!.staging,
        publicationPhase: "preparing",
        publications: result.publication!.publications,
    };
    fs.writeFileSync(path.join(h.transactions, journal.transactionId, "journal.json"), JSON.stringify(journal));
    const persist = (mode: "execute" | "old" | "new") => (previous: ActiveJournalV4, next: ActiveJournalV4) =>
        recordPublicationJournal(h.transactions, previous, next, mode);
    return { ...h, ...channel, prepared: result, journal, persist };
}

describe("restricted V4 publication receipts", () => {
    it.each([false, true])("prepares protected V4 authority without a replacement grant, empty=%s", (empty) => {
        const h = fixture();
        vi.spyOn(publicationIo, "publicationStagingRoot").mockImplementation((_ctx, id) =>
            path.join(h.root, `oaam-deployment-${id}`),
        );
        const graph = wire(h).graph;
        const { runtimeReplacementAuthority: _legacy, ...unscoped } = h.input;
        const input = empty
            ? {
                  ...unscoped,
                  publicationTransactionId: h.journal.transactionId,
                  entries: [],
                  managedDirectoryBoundaries: [],
                  desiredDirectoryPaths: [],
              }
            : { ...h.input, publicationTransactionId: h.journal.transactionId };
        const prepared = graph.prepare(input);
        expect(prepared.outcome).toBe("ready");
        if (prepared.outcome !== "ready") throw new Error("expected protected publication preparation");
        expect(prepared.prepared.publication!.publications.every((unit) => !unit.completeReplacement)).toBe(true);
        expect(prepared.prepared.publication!.publications.length).toBe(empty ? 0 : 1);
        expect(fs.existsSync(prepared.prepared.publication!.staging.rootPath)).toBe(false);
    });

    it("projects the exact Windows Project anchor into the bound target's preparation", () => {
        const h = fixture();
        const hostPath = (value: string) => `\\\\wsl.localhost\\test-selected${value.replaceAll("/", "\\")}`;
        h.binding.targetRootPath = hostPath(h.target);
        const staging = vi
            .spyOn(publicationIo, "publicationStagingRoot")
            .mockImplementation((_ctx, id) => path.join(h.root, `oaam-deployment-${id}`));
        const result = wire(h).graph.prepare({
            ...h.input,
            publicationTransactionId: h.journal.transactionId,
            publicationProjectRootPath: hostPath(h.root),
        });
        expect(result.outcome).toBe("ready");
        expect(staging).toHaveBeenCalledWith(
            expect.anything(),
            h.journal.transactionId,
            expect.any(Array),
            h.input.managedDirectoryBoundaries,
            { projectRootPath: h.root },
        );
    });

    it("rejects malformed rollback bytes even when confirmed replacement excludes the current-content observation", () => {
        const h = fixture();
        vi.spyOn(publicationIo, "publicationStagingRoot").mockImplementation((_ctx, id) =>
            path.join(h.root, `oaam-deployment-${id}`),
        );
        const graph = wire(h, (response) => {
            if (response.result.kind !== "prepare_graph" || response.result.result.outcome !== "ready") return;
            response.result.result.prepared.entries[0]!.runtimeRollbackOverride = {
                state: "present",
                contentHash: "invalid" as never,
                bytesBase64: "",
                executable: false,
            };
        }).graph;
        expect(
            graph.prepare({
                ...h.input,
                runtimeReplacementAuthority: h.preview.runtimeReplacementAuthority,
                publicationTransactionId: h.journal.transactionId,
            }).outcome,
        ).toBe("unavailable");
        expect(fs.existsSync(path.join(h.root, `oaam-deployment-${h.journal.transactionId}`))).toBe(false);
    });

    it.each([
        "missing_rollback",
        "different_desired",
        "missing_publication",
        "wrong_transaction",
        "occupied_staging",
        "changed_scope",
        "prepared_identity",
        "invalid_legacy_shape",
    ])("rejects %s in a serialized preparation before journal publication", (fault) => {
        const h = fixture(true);
        vi.spyOn(publicationIo, "publicationStagingRoot").mockImplementation((_ctx, id) =>
            path.join(h.root, `oaam-deployment-${id}`),
        );
        const channel = wire(h, (response) => {
            if (response.result.kind !== "prepare_graph" || response.result.result.outcome !== "ready") return;
            const prepared = response.result.result.prepared;
            if (fault === "missing_rollback") delete prepared.entries[0]!.runtimeRollbackOverride;
            if (fault === "different_desired") prepared.entries[0]!.newExecutable = !prepared.entries[0]!.newExecutable;
            if (fault === "missing_publication") delete prepared.publication;
            if (fault === "wrong_transaction") prepared.publication!.transactionId = h.binding.deploymentId;
            if (fault === "occupied_staging")
                prepared.publication!.staging.identity = publicationIo.publicationIdentity(h.root, "directory");
            if (fault === "changed_scope") prepared.publication!.publications[0]!.completeReplacement = false;
            if (fault === "prepared_identity") {
                const unit = prepared.publication!.publications[0]!;
                if (unit.kind !== "directory") throw new Error("expected directory");
                unit.preparedIdentity = publicationIo.publicationIdentity(h.root, "directory");
            }
            if (fault === "invalid_legacy_shape")
                prepared.directoryEntries[0]!.createdIdentity = {
                    ...publicationIo.publicationIdentity(h.root, "directory")!,
                    entryKind: "file",
                };
        });
        expect(
            channel.graph.prepare({
                ...h.input,
                runtimeReplacementAuthority: h.preview.runtimeReplacementAuthority,
                publicationTransactionId: h.journal.transactionId,
            }).outcome,
        ).toBe("unavailable");
        expect(fs.existsSync(path.join(h.root, `oaam-deployment-${h.journal.transactionId}`))).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each([
        "transaction",
        "staging",
        "phase",
        "scope",
        "entries",
        "directories",
    ])("refuses a changed %s between preparation and execute", (changed) => {
        const h = publicationWire();
        const journal = structuredClone(h.journal);
        if (changed === "transaction") journal.transactionId = h.binding.deploymentId;
        if (changed === "staging")
            journal.staging.rootPath = path.join(h.root, "different", path.basename(journal.staging.rootPath));
        if (changed === "phase") {
            journal.publicationPhase = "publishing";
            journal.staging.identity = publicationIo.publicationIdentity(h.root, "directory");
            const unit = journal.publications[0]!;
            if (unit.kind !== "directory") throw new Error("expected directory");
            unit.preparedIdentity = journal.staging.identity;
        }
        if (changed === "scope") journal.publications[0]!.completeReplacement = false;
        if (changed === "entries") journal.entries[0]!.newExecutable = !journal.entries[0]!.newExecutable;
        if (changed === "directories") journal.directoryEntries[0]!.desiredState = "missing";
        const result = h.graph.executePublication(h.prepared.preparationId, journal, h.persist("execute"));
        expect(result.result.outcome).toBe("uncertain");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("retires the channel when a Host persistence callback returns a different receipt", () => {
        const h = publicationWire();
        const result = h.graph.executePublication(h.prepared.preparationId, h.journal, (previous, next) => {
            const stored = h.persist("execute")(previous, next);
            return { ...stored, createdAt: stored.createdAt + 1 };
        });
        expect(result.result.outcome).toBe("uncertain");
        expect(h.requests.filter((request) => request.operation.kind === "continue_graph")).toHaveLength(0);
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
        const sent = h.requests.length;
        expect(h.graph.executePublication(h.prepared.preparationId, h.journal, h.persist("execute")).result.outcome).toBe(
            "uncertain",
        );
        expect(h.requests).toHaveLength(sent);
    });

    it("publishes and restores one exact complete tree through serialized requests and durable Host barriers", () => {
        const h = publicationWire();
        const original = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const phases: string[] = [];
        const executed = h.graph.executePublication(h.prepared.preparationId, h.journal, (previous, next) => {
            phases.push(next.publicationPhase);
            if (previous.publicationPhase === "preparing")
                expect(publicationIo.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(original);
            return h.persist("execute")(previous, next);
        });
        expect(executed.result.outcome).toBe("verified");
        expect(phases).toEqual(["preparing", "preparing", "publishing"]);
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        const recovered = wire(h).graph.recoverPublication(executed.journal, "old", h.persist("old"));
        expect(recovered.outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(original);
        expect(fs.existsSync(executed.journal.staging.rootPath)).toBe(false);
        expect(h.requests.filter((request) => request.operation.kind === "continue_graph")).toHaveLength(3);
    });

    it("losing the publishing permission receipt cannot begin public mutation and a fresh service can end preparation", () => {
        const h = publicationWire();
        const original = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const executed = h.graph.executePublication(h.prepared.preparationId, h.journal, (previous, next) => {
            if (next.publicationPhase === "publishing") throw new Error("Host journal write failed");
            return h.persist("execute")(previous, next);
        });
        expect(executed.result.outcome).toBe("uncertain");
        expect(executed.journal.publicationPhase).toBe("preparing");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(executed.journal);
        expect(wire(h).graph.recoverPublication(executed.journal, "old", h.persist("old")).outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(original);
    });

    it("recovers the original physical directory when the post-publication response is lost", () => {
        const h = publicationWire((response) => {
            if (response.result.kind === "continue_graph" && response.result.step.kind === "executed")
                throw new Error("response channel died after actual publication");
        });
        const original = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const executed = h.graph.executePublication(h.prepared.preparationId, h.journal, h.persist("execute"));
        expect(executed.result.outcome).toBe("uncertain");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(wire(h).graph.recoverPublication(executed.journal, "old", h.persist("old")).outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(original);
    });

    it("rejects a receipt that changes desired bytes before persisting or allowing publication", () => {
        const h = publicationWire((response) => {
            if (response.result.kind === "execute_graph" && response.result.step.kind === "publication_receipt_required")
                response.result.step.journal.entries[0]!.newBytesBase64 = Buffer.from("injected").toString("base64");
        });
        const persist = vi.fn(h.persist("execute"));
        const result = h.graph.executePublication(h.prepared.preparationId, h.journal, persist);
        expect(result.result.outcome).toBe("uncertain");
        expect(persist).not.toHaveBeenCalled();
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it("cannot route a Host V4 journal into the selected service", () => {
        const h = publicationWire();
        const journal: ActiveJournalV4 = { ...h.journal, targetExecution: { kind: "host" } };
        const sent = h.requests.length;
        expect(h.graph.recoverPublication(journal, "old", h.persist("old")).outcome).toBe("io_failed");
        expect(h.requests).toHaveLength(sent);
    });
});
