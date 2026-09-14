/** Exact service admission and response proof through the formal graph/review protocol. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJournal } from "../../src/deployment/deployment-journal";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { encodeRestrictedGraphPreparation } from "../../src/deployment/restricted-target-graph-codec";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetOperation,
    type RestrictedTargetRequest,
    type RestrictedTargetResponse,
} from "../../src/deployment/restricted-target-contract";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { fixture as graphFixture, FP } from "./fixtures/restricted-target-graph-fixture";

function fixture() {
    const h = graphFixture(true);
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const configuration = { ...session, bindings: [h.binding], deadlineAt: Date.now() + 60_000 };
    const request = (
        operation: RestrictedTargetOperation = { kind: "prepare_graph", input: encodeRestrictedGraphPreparation(h.input) },
        sequence = 1,
    ): RestrictedTargetRequest => ({
        protocol: RESTRICTED_TARGET_PROTOCOL,
        ...session,
        operationId: randomUUID(),
        sequence,
        bindingId: h.binding.bindingId,
        operation,
    });
    return { ...h, session, configuration, request, service: createRestrictedTargetService(configuration) };
}
type Fixture = ReturnType<typeof fixture>;
function connection(h: Fixture, change: (response: RestrictedTargetResponse) => unknown = (value) => value) {
    const exchange = vi.fn((request: RestrictedTargetRequest) =>
        structuredClone(change(h.service.handle(structuredClone(request)))),
    );
    const channel = createRestrictedTargetChannel(h.session, exchange);
    return { ...channel.bind(h.binding), channel, exchange };
}
function prepare(h: Fixture, peer: ReturnType<typeof connection>) {
    const result = peer.graph.prepare(h.input);
    if (result.outcome !== "ready") throw new Error(`preparation failed: ${result.outcome}`);
    return result.prepared.preparationId;
}
function unexpectedReceipt(): never {
    throw new Error("existing directories need no creation receipt");
}
function expectRetained(h: Fixture) {
    expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
    expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
}

describe("restricted target exact lifetime and request admission", () => {
    it.each([
        "host",
        "session",
        "deadline_past",
        "deadline_future",
        "deadline_fractional",
        "empty",
        "too_many",
        "binding",
        "deployment",
        "relative_root",
        "mapping",
        "duplicate",
    ])("rejects invalid configuration %s before requests", (field) => {
        const h = fixture();
        const configuration = structuredClone(h.configuration);
        if (field === "host") configuration.hostInstanceId = "invalid";
        else if (field === "session") configuration.sessionId = "invalid";
        else if (field === "deadline_past") configuration.deadlineAt = Date.now() - 1;
        else if (field === "deadline_future") configuration.deadlineAt = Date.now() + 700_000;
        else if (field === "deadline_fractional") configuration.deadlineAt = Date.now() + 0.5;
        else if (field === "empty") configuration.bindings = [];
        else if (field === "too_many")
            configuration.bindings = Array.from({ length: 9 }, () => ({ ...h.binding, bindingId: randomUUID() }));
        else if (field === "binding") configuration.bindings[0]!.bindingId = "invalid";
        else if (field === "deployment") configuration.bindings[0]!.deploymentId = "invalid";
        else if (field === "relative_root") configuration.bindings[0]!.targetRootPath = "relative";
        else if (field === "mapping") configuration.bindings[0]!.executionRootPath = `${h.target}-other`;
        else configuration.bindings = [...configuration.bindings, { ...configuration.bindings[0]! }];
        expect(() => createRestrictedTargetService(configuration)).toThrow();
        expectRetained(h);
    });

    it.each([
        "protocol",
        "host",
        "session",
        "operation_id",
        "binding_id",
        "sequence_fractional",
        "sequence_zero",
        "sequence_gap",
        "foreign_host",
        "foreign_session",
        "foreign_binding",
        "unknown_operation",
        "extra",
        "null",
    ])("rejects malformed or unrelated request %s without consuming the next sequence", (field) => {
        const h = fixture();
        const input = h.request();
        const damaged = structuredClone(input) as unknown as Record<string, unknown>;
        if (field === "protocol") damaged.protocol = "other";
        else if (field === "host") damaged.hostInstanceId = "invalid";
        else if (field === "session") damaged.sessionId = "invalid";
        else if (field === "operation_id") damaged.operationId = "invalid";
        else if (field === "binding_id") damaged.bindingId = "invalid";
        else if (field === "sequence_fractional") damaged.sequence = 1.5;
        else if (field === "sequence_zero") damaged.sequence = 0;
        else if (field === "sequence_gap") damaged.sequence = 2;
        else if (field === "foreign_host") damaged.hostInstanceId = randomUUID();
        else if (field === "foreign_session") damaged.sessionId = randomUUID();
        else if (field === "foreign_binding") damaged.bindingId = randomUUID();
        else if (field === "unknown_operation") damaged.operation = { kind: "arbitrary_write" };
        else damaged.extra = true;
        expect(() => h.service.handle(field === "null" ? null : damaged)).toThrow();
        expect(h.service.handle(input).result).toMatchObject({ kind: "prepare_graph", result: { outcome: "ready" } });
        expectRetained(h);
    });

    it("rejects a foreign Deployment journal and invalid recovery side before physical writes", () => {
        const h = fixture();
        expect(() =>
            h.service.handle(
                h.request({ kind: "recover_graph", journal: { ...h.journal, deploymentId: randomUUID() }, side: "old" }),
            ),
        ).toThrow("another Deployment");
        expect(() =>
            h.service.handle(h.request({ kind: "recover_graph", journal: h.journal, side: "unknown" } as never)),
        ).toThrow("request rejected");
        expectRetained(h);
    });

    it("refuses an operation replay, transaction replay and an expired request after real graph execution", () => {
        const h = fixture();
        const prepared = h.service.handle(h.request()).result;
        if (prepared.kind !== "prepare_graph" || prepared.result.outcome !== "ready") throw new Error("expected preparation");
        const operation: RestrictedTargetOperation = {
            kind: "execute_graph",
            preparationId: prepared.result.prepared.preparationId,
            journal: h.journal,
        };
        const request = h.request(operation, 2);
        expect(h.service.handle(request).result).toMatchObject({
            kind: "execute_graph",
            step: { kind: "executed", result: { outcome: "verified" } },
        });
        expect(() => h.service.handle({ ...request, sequence: 3 })).toThrow(/rejected/);
        expect(() => h.service.handle(h.request(operation, 3))).toThrow(/replay/);
        vi.spyOn(Date, "now").mockReturnValue(h.configuration.deadlineAt);
        expect(() => h.service.handle(h.request(undefined, 4))).toThrow(/rejected/);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("retains the 128 business-operation bound with real read-only captures", () => {
        const h = fixture();
        const operation: RestrictedTargetOperation = { kind: "memory_catalog_snapshots", paths: ["leaf/SKILL.md"] };
        for (let sequence = 1; sequence <= 128; sequence++)
            expect(h.service.handle(h.request(operation, sequence)).result).toEqual({
                kind: "memory_catalog_snapshots",
                outcome: "captured",
                snapshots: [{ relativePath: "leaf/SKILL.md", snapshotState: "missing" }],
            });
        expect(() => h.service.handle(h.request(operation, 129))).toThrow(/rejected/);
        expectRetained(h);
    });

    it("retains a completed write as uncertain when the original deadline expires during the write", () => {
        const h = fixture();
        const peer = connection(h);
        const preparationId = prepare(h, peer);
        const original = targetIo.ioWrite;
        vi.spyOn(targetIo, "ioWrite").mockImplementation((...args) => {
            original(...args);
            vi.spyOn(Date, "now").mockReturnValue(h.configuration.deadlineAt);
        });
        expect(peer.graph.execute(preparationId, h.journal, unexpectedReceipt).result).toEqual({ outcome: "uncertain" });
        expect(peer.channel.available).toBe(false);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(fs.readFileSync(path.join(h.target, "leaf/resources/run.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });
});

describe("restricted graph response proof", () => {
    it.each([
        "extra_envelope",
        "wrong_kind",
        "extra_result",
        "invalid_outcome",
        "missing_verified",
        "short_verified",
        "wrong_hash",
        "extra_verified",
    ])("refuses %s after an actual write and retains its original journal", (field) => {
        const h = fixture();
        const peer = connection(h, (response) => {
            const result = response.result;
            if (result.kind !== "execute_graph" || result.step.kind !== "executed") return response;
            if (result.step.result.outcome !== "verified") throw new Error("expected verified write");
            const verification = result.step.result;
            if (field === "extra_envelope") Object.assign(response, { extra: true });
            else if (field === "wrong_kind") Object.assign(result, { kind: "recover_graph" });
            else if (field === "extra_result") Object.assign(result, { extra: true });
            else if (field === "invalid_outcome") Object.assign(verification, { outcome: "success" });
            else if (field === "missing_verified") Object.assign(verification, { verified: undefined });
            else if (field === "short_verified") verification.verified.pop();
            else if (field === "wrong_hash") verification.verified[0]!.appliedContentHash = FP;
            else Object.assign(verification.verified[0]!, { extra: true });
            return response;
        });
        const preparationId = prepare(h, peer);
        expect(peer.graph.execute(preparationId, h.journal, unexpectedReceipt).result).toEqual({ outcome: "uncertain" });
        expect(peer.channel.available).toBe(false);
        expect(peer.graph.recover(h.journal, "old", unexpectedReceipt).outcome).toBe("io_failed");
        expect(peer.exchange).toHaveBeenCalledTimes(2);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        const reopened = connection({ ...h, service: createRestrictedTargetService(h.configuration) });
        expect(reopened.graph.recover(h.journal, "old", unexpectedReceipt).outcome).toBe("done");
        expectRetained(h);
    });

    it("retires a thrown recovery transport without making a second request", () => {
        const h = fixture();
        const exchange = vi.fn(() => {
            throw new Error("lost recovery transport");
        });
        const channel = createRestrictedTargetChannel(h.session, exchange);
        const graph = channel.bind(h.binding).graph;
        expect(graph.recover(h.journal, "old", unexpectedReceipt).outcome).toBe("io_failed");
        expect(channel.available).toBe(false);
        expect(graph.prepare(h.input).outcome).toBe("unavailable");
        expect(exchange).toHaveBeenCalledOnce();
        expectRetained(h);
    });

    it.each(["prepare_graph", "recover_graph"])("retires a malformed %s result after the actual service operation", (kind) => {
        const h = fixture();
        const peer = connection(h, (response) => ({ ...response, result: { ...response.result, extra: true } }));
        if (kind === "prepare_graph") expect(peer.graph.prepare(h.input).outcome).toBe("unavailable");
        else expect(peer.graph.recover(h.journal, "old", unexpectedReceipt).outcome).toBe("io_failed");
        expect(peer.channel.available).toBe(false);
        expect(peer.graph.recover(h.journal, "old", unexpectedReceipt).outcome).toBe("io_failed");
        expect(peer.exchange).toHaveBeenCalledOnce();
        expectRetained(h);
    });
});
