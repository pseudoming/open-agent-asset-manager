/** Admission and terminal controls retain the original suspended Provider and Host lock owner. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestrictedSourceService } from "../../src/source-import/restricted-source-service";
import { createRestrictedSourceChannel } from "../../src/source-import/restricted-source-channel";
import { createRestrictedSourceHostAuthority } from "../../src/source-import/restricted-source-host-authority";
import * as transfer from "../../src/source-import/restricted-source-result-transfer";
import * as readRun from "../../src/source-import/restricted-source-read-run";
import { acquireAllLocks } from "../../src/foundation/physical-path-locks";
import { restrictedReadAuthorityKeys } from "../../src/source-import/restricted-source-read-operation";
import {
    isRestrictedSourceRequest,
    RESTRICTED_SOURCE_PROTOCOL,
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    RESTRICTED_SOURCE_MAX_READS,
    RESTRICTED_SOURCE_MAX_CONTINUATIONS,
    type RestrictedSourceOperation,
    type RestrictedSourceRequest,
} from "../../src/source-import/restricted-source-protocol";
import { sourceWireFixture } from "./fixtures/restricted-source-wire-fixtures";
import { sandbox } from "./fixtures/source-contract-test-fixtures";

const opened: ReturnType<typeof sourceWireFixture>[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const h of opened.splice(0)) await h.channel.close();
});

function fixture() {
    const h = sourceWireFixture();
    opened.push(h);
    let sequence = 0;
    const request = (operation: RestrictedSourceOperation): RestrictedSourceRequest => ({
        protocol: RESTRICTED_SOURCE_PROTOCOL,
        hostInstanceId: h.configuration.hostInstanceId,
        sessionId: h.configuration.sessionId,
        operationId: randomUUID(),
        sequence: ++sequence,
        operation,
    });
    const begin = (readId = randomUUID()): RestrictedSourceOperation => ({
        kind: "begin",
        readId,
        target: structuredClone(h.readRequest.target),
        authority: {
            managedTargetGuards: structuredClone(h.readRequest.authority.managedTargetGuards),
            reservationIdentityFingerprints: [...h.readRequest.authority.reservationIdentityFingerprints],
        },
    });
    return { ...h, request, begin, send: (operation: RestrictedSourceOperation) => h.service.handle(request(operation)) };
}

describe("restricted source service input admission", () => {
    it.each([
        "past",
        "future",
        "fractional",
        "capacity_zero",
        "capacity_fractional",
        "capacity_small",
        "empty_providers",
        "duplicate_providers",
    ])("rejects invalid service bounds or inventory: %s", (field) => {
        const h = fixture();
        const config: Parameters<typeof createRestrictedSourceService>[0] = { ...h.configuration, providers: [h.selected] };
        if (field === "past") config.deadlineAt = Date.now() - 1;
        else if (field === "future") config.deadlineAt = Date.now() + 700_000;
        else if (field === "fractional") config.deadlineAt = Date.now() + 0.5;
        else if (field === "capacity_zero") config.maximumResultBytes = 0;
        else if (field === "capacity_fractional") config.maximumResultBytes = 16_384.5;
        else if (field === "capacity_small") config.maximumResultBytes = 16_383;
        else if (field === "empty_providers") config.providers = [];
        else config.providers = [h.selected, h.selected];
        expect(() => createRestrictedSourceService(config)).toThrow();
        expect(h.providerCalls()).toBe(0);
    });

    it.each([
        "null",
        "protocol",
        "host",
        "session",
        "operation",
        "sequence",
        "read",
        "extra",
        "unknown",
    ])("rejects malformed wire request %s and retires that session", async (field) => {
        const h = fixture();
        const input = h.request(h.begin());
        if (field === "protocol") Object.assign(input, { protocol: "other" });
        else if (field === "host") input.hostInstanceId = "invalid";
        else if (field === "session") input.sessionId = "invalid";
        else if (field === "operation") input.operationId = "invalid";
        else if (field === "sequence") input.sequence = 0;
        else if (field === "read") input.operation.readId = "invalid";
        else if (field === "unknown") Object.assign(input.operation, { kind: "arbitrary_read" });
        else if (field === "extra") Object.assign(input, { extra: true });
        const damaged = field === "null" ? null : input;
        expect(isRestrictedSourceRequest(damaged)).toBe(false);
        await expect(h.service.handle(damaged)).rejects.toThrow(/mismatch/);
        await expect(h.send(h.begin())).rejects.toThrow(/closed/);
        expect(h.providerCalls()).toBe(0);
    });

    it.each([
        "host",
        "session",
        "sequence",
        "provider",
        "target",
        "oversize",
    ])("rejects structurally valid but unapproved %s before Provider entry", async (field) => {
        const h = fixture();
        const input = h.request(h.begin());
        if (input.operation.kind !== "begin") throw new Error("expected begin");
        if (field === "host") input.hostInstanceId = randomUUID();
        else if (field === "session") input.sessionId = randomUUID();
        else if (field === "sequence") input.sequence = 2;
        else if (field === "provider") input.operation.target.adapterId = "UNREGISTERED";
        else if (field === "target") input.operation.target.allowedKinds = ["Unregistered" as never];
        else Object.assign(input.operation.target, { oversized: "x".repeat(RESTRICTED_SOURCE_MAX_FRAME_BYTES) });
        expect(isRestrictedSourceRequest(input)).toBe(true);
        await expect(h.service.handle(input)).rejects.toThrow();
        expect(h.providerCalls()).toBe(0);
    });

    it("refuses selected-root replacement and expiry without entering a Provider", async () => {
        const h = fixture();
        const moved = `${sandbox}-replaced-control`;
        fs.renameSync(sandbox, moved);
        fs.mkdirSync(sandbox);
        try {
            await expect(h.send(h.begin())).rejects.toThrow(/root/);
            expect(h.providerCalls()).toBe(0);
        } finally {
            fs.rmdirSync(sandbox);
            fs.renameSync(moved, sandbox);
        }
        const next = fixture();
        vi.spyOn(Date, "now").mockReturnValue(next.configuration.deadlineAt);
        await expect(next.send(next.begin())).rejects.toThrow(/expired/);
        expect(next.providerCalls()).toBe(0);
    });
});

function continuation(readId: string): RestrictedSourceOperation {
    return { kind: "continue", readId, continuation: { stepId: randomUUID(), released: true } };
}
function earlyOperation(kind: string, readId: string): RestrictedSourceOperation {
    if (kind === "continue") return continuation(readId);
    if (kind === "result_chunk") return { kind, readId, transferId: randomUUID(), offset: 0 };
    if (kind === "acknowledge") return { kind, readId, transferId: randomUUID(), contentHash: `sha256:${"1".repeat(64)}` };
    return { kind: "cancel", readId };
}

describe("restricted source suspended-read and transfer terminals", () => {
    it.each([
        "continue",
        "result_chunk",
        "acknowledge",
        "cancel",
    ])("rejects malformed %s grammar from a valid operation envelope", (kind) => {
        const h = fixture();
        const input = h.request(earlyOperation(kind, randomUUID()));
        expect(isRestrictedSourceRequest(input)).toBe(true);
        const damaged = structuredClone(input);
        if (damaged.operation.kind === "continue") Object.assign(damaged.operation, { continuation: null });
        else if (damaged.operation.kind === "result_chunk") damaged.operation.offset = -1;
        else if (damaged.operation.kind === "acknowledge") Object.assign(damaged.operation, { contentHash: "invalid" });
        else Object.assign(damaged.operation, { extra: true });
        expect(isRestrictedSourceRequest(damaged)).toBe(false);
    });

    it.each([
        "oversize_acquire",
        "close_before_result",
    ])("retires the actual read when its dependency returns fault %s", async (kind) => {
        const h = fixture();
        const create = readRun.createRestrictedSourceReadRun;
        vi.spyOn(readRun, "createRestrictedSourceReadRun").mockImplementation((...args) => {
            const run = create(...args);
            return {
                ...run,
                async advance(...continuation) {
                    const step = await run.advance(...continuation);
                    if (kind === "oversize_acquire" && step.kind === "acquire_authority") {
                        // Deliberate bad dependency output; this does not claim a real directory has this path.
                        step.intent.targets[0]!.relativePath = "x".repeat(RESTRICTED_SOURCE_MAX_FRAME_BYTES);
                    } else if (kind === "close_before_result" && step.kind === "complete") h.service.close();
                    return step;
                },
            };
        });
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/frame capacity|lost its read identity/);
        await h.service.settled();
        expect(h.channel.available).toBe(false);
        expect(h.providerCalls()).toBe(1);
        expect(h.aborts()).toBe(1);
    });

    it.each(["continue", "result_chunk", "acknowledge", "cancel"])("rejects %s without an active read", async (kind) => {
        const h = fixture();
        await expect(h.send(earlyOperation(kind, randomUUID()))).rejects.toThrow(/no active read/);
        expect(h.providerCalls()).toBe(0);
    });

    it.each([
        "result_chunk",
        "acknowledge",
    ])("rejects early %s while the real Provider is waiting for permission", async (kind) => {
        const h = fixture();
        const operation = h.begin();
        const result = await h.send(operation);
        expect(result.result.kind).toBe("read_step");
        await expect(h.send(earlyOperation(kind, operation.readId))).rejects.toThrow(/not available|not completed/);
        await h.service.settled();
        expect(h.providerCalls()).toBe(1);
    });

    it("cancels and joins a suspended read, then admits a new read without replaying the old identity", async () => {
        const h = fixture();
        const first = h.begin();
        await h.send(first);
        expect((await h.send({ kind: "cancel", readId: first.readId })).result).toEqual({
            kind: "cancelled",
            readId: first.readId,
        });
        await h.service.settled();
        await h.send(h.begin());
        expect(h.providerCalls()).toBe(2);
        await expect(h.send(first)).rejects.toThrow(/overlapping|replayed/);
    });

    it("rejects a replayed operation identity and a foreign active read", async () => {
        const h = fixture();
        const input = h.request(h.begin());
        await h.service.handle(input);
        await expect(h.service.handle({ ...input, sequence: 2 })).rejects.toThrow(/mismatch/);
        await h.service.settled();
        const other = fixture();
        await other.send(other.begin());
        await expect(other.send({ kind: "cancel", readId: randomUUID() })).rejects.toThrow(/no active read/);
        expect(h.providerCalls()).toBe(1);
        expect(other.providerCalls()).toBe(1);
    });

    it("joins overlapping requests without allowing their Provider to resume", async () => {
        const h = fixture();
        const first = h.begin();
        const results = await Promise.allSettled([h.send(first), h.send({ kind: "cancel", readId: first.readId })]);
        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/overlap/);
        await h.service.settled();
        expect(h.providerCalls()).toBe(1);
    });

    it("keeps the original read-count limit after each real suspended read is cancelled", async () => {
        const h = fixture();
        for (let count = 0; count < RESTRICTED_SOURCE_MAX_READS; count++) {
            const operation = h.begin();
            await h.send(operation);
            expect((await h.send({ kind: "cancel", readId: operation.readId })).result.kind).toBe("cancelled");
        }
        await expect(h.send(h.begin())).rejects.toThrow(/exhausted/);
        expect(h.providerCalls()).toBe(RESTRICTED_SOURCE_MAX_READS);
    });

    it.each([
        "continue",
        "cancel",
    ])("handles %s after the actual read completes but before transfer acknowledgement", async (kind) => {
        const h = fixture();
        const authority = createRestrictedSourceHostAuthority(h.readRequest);
        const begin = h.begin();
        try {
            let result = (await h.send(begin)).result;
            let count = 0;
            while (result.kind === "read_step" && result.step.kind !== "result") {
                if (++count > 12) throw new Error("fixture unexpectedly exceeded the real file read steps");
                const step = result.step;
                const next = step.kind === "acquire_authority" ? authority.grant(step) : authority.release(step);
                result = (await h.send({ kind: "continue", readId: begin.readId, continuation: next })).result;
            }
            expect(result.kind === "read_step" && result.step.kind).toBe("result");
            if (kind === "continue") await expect(h.send(continuation(begin.readId))).rejects.toThrow(/terminal/);
            else expect((await h.send({ kind: "cancel", readId: begin.readId })).result.kind).toBe("cancelled");
            await h.service.settled();
            expect(h.providerCalls()).toBe(1);
        } finally {
            h.service.close();
            await h.service.settled();
            authority.dispose();
        }
    });

    it("closes and joins the service when result serialization fails after a real read", async () => {
        const h = fixture();
        const error = new Error("serializer failure control");
        vi.spyOn(transfer, "createRestrictedSourceResultTransfer").mockImplementation(() => {
            throw error;
        });
        await expect(h.channel.read(h.readRequest)).rejects.toBe(error);
        expect(h.providerCalls()).toBe(1);
        expect(h.channel.available).toBe(false);
        expect(h.aborts()).toBe(1);
        await h.service.settled();
    });
});

describe("restricted source Host channel bounds", () => {
    it("stops a nonterminating protocol peer at the original continuation bound while real Host locks refuse every read", async () => {
        const h = fixture();
        const intent = {
            phase: "access" as const,
            targets: [{ sourceRootId: "root-1", relativePath: "", entryKind: "file" as const }],
        };
        const keys = restrictedReadAuthorityKeys({ platform: "wsl", sourceRoots: h.readRequest.preparation.roots }, intent);
        const outside = acquireAllLocks(h.readRequest.authority.transactionsRoot, keys);
        expect(outside).not.toBeNull();
        let requests = 0;
        let acquiredStepId = "";
        let grants = 0;
        const abort = vi.fn(async () => undefined);
        const channel = createRestrictedSourceChannel({
            ...h.configuration,
            deadlineAt: Date.now() + 600_000,
            async exchange(request) {
                requests++;
                let step: readRun.RestrictedSourceReadStep;
                if (request.operation.kind === "continue" && "permission" in request.operation.continuation) {
                    expect(request.operation.continuation.permission).toEqual({ state: "busy" });
                    grants++;
                    step = { kind: "release_authority", stepId: randomUUID(), acquiredStepId };
                } else {
                    if (request.operation.kind !== "begin")
                        expect(request.operation).toMatchObject({ kind: "continue", continuation: { released: true } });
                    acquiredStepId = randomUUID();
                    step = { kind: "acquire_authority", stepId: acquiredStepId, intent };
                }
                const { operation, ...envelope } = request;
                return { ...envelope, result: { kind: "read_step", readId: operation.readId, step } };
            },
            abort,
        });
        try {
            await expect(channel.read(h.readRequest)).rejects.toThrow(/exhausted its continuation bound/);
            expect(requests).toBe(RESTRICTED_SOURCE_MAX_CONTINUATIONS + 2);
            expect(grants).toBe(Math.ceil((RESTRICTED_SOURCE_MAX_CONTINUATIONS + 1) / 2));
            expect(abort).toHaveBeenCalledTimes(1);
            expect(channel.available).toBe(false);
            expect(h.providerCalls()).toBe(0);
        } finally {
            await channel.close();
            outside!.release();
        }
        const released = acquireAllLocks(h.readRequest.authority.transactionsRoot, keys);
        try {
            expect(released).not.toBeNull();
        } finally {
            released?.release();
        }
    }, 60_000);

    it.each([
        "envelope",
        "kind",
        "capacity",
        "completed_step",
    ])("rejects corrupted peer response %s and confirms original read cleanup", async (kind) => {
        const h = fixture();
        const channel = createRestrictedSourceChannel({
            ...h.configuration,
            async exchange(request) {
                const response = await h.service.handle(request);
                if (kind === "envelope") Object.assign(response, { extra: true });
                else if (kind === "kind") Object.assign(response.result, { kind: "cancelled" });
                else if (kind === "capacity" && response.result.kind === "read_step")
                    Object.assign(response.result.step, { oversized: "x".repeat(RESTRICTED_SOURCE_MAX_FRAME_BYTES) });
                else if (
                    kind === "completed_step" &&
                    response.result.kind === "read_step" &&
                    response.result.step.kind === "result"
                )
                    Object.assign(response.result.step, { extra: true });
                return response;
            },
            async abort() {
                h.service.close();
                await h.service.settled();
            },
        });
        try {
            await expect(channel.read(h.readRequest)).rejects.toThrow(/envelope|kind mismatch|capacity|completed step/);
            expect(channel.available).toBe(false);
            expect(h.providerCalls()).toBe(1);
            await h.service.settled();
        } finally {
            await channel.close();
        }
    });

    it.each(["deadline", "capacity"])("rejects invalid %s without invoking the transport", (field) => {
        const h = fixture();
        const exchange = vi.fn();
        const config = { ...h.configuration, exchange, abort: async () => undefined };
        if (field === "deadline") config.deadlineAt = Date.now() + 700_000;
        else config.maximumResultBytes = 16_383;
        expect(() => createRestrictedSourceChannel(config)).toThrow(/bounds/);
        expect(exchange).not.toHaveBeenCalled();
    });

    it.each(["environment", "platform", "oversize"])("rejects an unadmitted %s read before a Provider call", async (kind) => {
        const h = fixture();
        const request = {
            ...h.readRequest,
            platformContext: { ...h.readRequest.platformContext },
            preparation: { ...h.readRequest.preparation },
            target: structuredClone(h.readRequest.target),
        };
        if (kind === "environment") request.platformContext.platformInstanceId = "another";
        else if (kind === "platform") request.preparation.platform = "linux";
        else Object.assign(request.target, { oversized: "x".repeat(RESTRICTED_SOURCE_MAX_FRAME_BYTES) });
        await expect(h.channel.read(request)).rejects.toThrow(/Environment|capacity/);
        expect(h.providerCalls()).toBe(0);
        expect(h.requests).toHaveLength(0);
    });

    it("rejects simultaneous Host admissions while the first uses the actual exchange", async () => {
        const h = fixture();
        const running = h.channel.read(h.readRequest);
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/overlaps/);
        expect((await running).status).toBe("complete");
        expect(h.providerCalls()).toBe(1);
    });
});
