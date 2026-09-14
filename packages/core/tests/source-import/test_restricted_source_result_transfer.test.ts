/** Byte-transfer controls use a valid original failure result and never invoke a Provider. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    createRestrictedSourceResultReceiver,
    createRestrictedSourceResultTransfer,
    RESTRICTED_SOURCE_CHUNK_BYTES,
} from "../../src/source-import/restricted-source-result-transfer";
import { failedResult, sourceDiagnostic } from "../../src/source-import/source-read-validation-helpers";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import type { AdapterReadResult } from "../../src/types";

function fixture(large = false) {
    const result = failedResult<AdapterReadResult>([
        sourceDiagnostic("read.control_failure", large ? "x".repeat(RESTRICTED_SOURCE_CHUNK_BYTES) : "original bounded failure"),
    ]);
    const transfer = createRestrictedSourceResultTransfer(result, 4 * RESTRICTED_SOURCE_CHUNK_BYTES);
    const descriptor = transfer.descriptor;
    const receiver = createRestrictedSourceResultReceiver(descriptor, 4 * RESTRICTED_SOURCE_CHUNK_BYTES);
    return { result, transfer, descriptor, receiver };
}
describe("restricted source ordered result transfer", () => {
    it("assembles multiple original chunks, verifies the complete hash, and retires both ends after acknowledgement", () => {
        const h = fixture(true);
        let chunks = 0;
        while (!h.receiver.isComplete()) {
            h.receiver.accept(h.transfer.next(h.receiver.nextRequest()));
            chunks++;
        }
        expect(chunks).toBe(2);
        expect(h.receiver.finish()).toEqual(h.result);
        h.transfer.acknowledge({ transferId: h.descriptor.transferId, contentHash: h.descriptor.contentHash });
        expect(() => h.transfer.next({ transferId: h.descriptor.transferId, offset: h.descriptor.byteLength })).toThrow();
        expect(() =>
            h.transfer.acknowledge({ transferId: h.descriptor.transferId, contentHash: h.descriptor.contentHash }),
        ).toThrow();
        expect(() => h.receiver.finish()).toThrow(/already consumed/);
        expect(() => h.receiver.nextRequest()).toThrow(/no pending/);
        expect(h.receiver.isComplete()).toBe(false);
    });
    it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])("refuses an invalid capacity %s at each endpoint", (capacity) => {
        const h = fixture();
        expect(() => createRestrictedSourceResultTransfer(h.result, capacity)).toThrow(/capacity/);
        expect(() => createRestrictedSourceResultReceiver(h.descriptor, capacity)).toThrow(/capacity/);
        h.transfer.dispose();
        h.receiver.dispose();
    });
    it.each(["extra", "wrong_id", "wrong_offset", "disposed", "exhausted"])("rejects a stale transfer request %s", (kind) => {
        const h = fixture();
        const request = { transferId: h.descriptor.transferId, offset: 0 };
        if (kind === "extra") Object.assign(request, { extra: true });
        else if (kind === "wrong_id") request.transferId = randomUUID();
        else if (kind === "wrong_offset") request.offset = 1;
        else if (kind === "disposed") h.transfer.dispose();
        else {
            h.transfer.next(request);
            request.offset = h.descriptor.byteLength;
        }
        expect(() => h.transfer.next(request)).toThrow(/stale|sequence/);
        h.transfer.dispose();
        h.receiver.dispose();
    });
    it.each(["extra", "wrong_id", "wrong_hash", "incomplete"])("refuses an invalid acknowledgement %s", (kind) => {
        const h = fixture();
        const request = { transferId: h.descriptor.transferId, contentHash: h.descriptor.contentHash };
        if (kind !== "incomplete") h.transfer.next(h.receiver.nextRequest());
        if (kind === "extra") Object.assign(request, { extra: true });
        else if (kind === "wrong_id") request.transferId = randomUUID();
        else if (kind === "wrong_hash") request.contentHash = sha256Bytes(Buffer.from("other"));
        expect(() => h.transfer.acknowledge(request)).toThrow(/incomplete|unrelated/);
        h.transfer.dispose();
        h.receiver.dispose();
    });
});

describe("restricted source receiver grammar and final content identity", () => {
    it.each(["shape", "id", "fractional", "empty", "capacity", "hash"])("rejects invalid descriptor %s", (kind) => {
        const h = fixture();
        const descriptor = { ...h.descriptor };
        if (kind === "shape") Object.assign(descriptor, { extra: true });
        else if (kind === "id") descriptor.transferId = "invalid";
        else if (kind === "fractional") descriptor.byteLength = 1.5;
        else if (kind === "empty") descriptor.byteLength = 0;
        else if (kind === "capacity") descriptor.byteLength = 4 * RESTRICTED_SOURCE_CHUNK_BYTES + 1;
        else Object.assign(descriptor, { contentHash: "invalid" });
        expect(() => createRestrictedSourceResultReceiver(descriptor, 4 * RESTRICTED_SOURCE_CHUNK_BYTES)).toThrow();
        h.transfer.dispose();
        h.receiver.dispose();
    });
    it.each([
        "extra",
        "offset",
        "length",
        "type",
        "encoded_length",
        "hash_shape",
        "base64",
        "hash",
        "disposed",
        "exhausted",
    ])("refuses invalid or replayed chunk %s", (kind) => {
        const h = fixture();
        const chunk = h.transfer.next(h.receiver.nextRequest());
        if (kind === "extra") Object.assign(chunk, { extra: true });
        else if (kind === "offset") chunk.offset = 1;
        else if (kind === "length") chunk.byteLength++;
        else if (kind === "type") Object.assign(chunk, { bytesBase64: null });
        else if (kind === "encoded_length") chunk.bytesBase64 += "A";
        else if (kind === "hash_shape") Object.assign(chunk, { contentHash: "invalid" });
        else if (kind === "base64") chunk.bytesBase64 = "?".repeat(chunk.bytesBase64.length);
        else if (kind === "hash") chunk.contentHash = sha256Bytes(Buffer.from("different chunk"));
        else if (kind === "disposed") h.receiver.dispose();
        else h.receiver.accept(chunk);
        expect(() => h.receiver.accept(chunk)).toThrow();
        h.transfer.dispose();
        h.receiver.dispose();
    });
    it("rejects incomplete content and a wrong final descriptor hash even when every chunk has a valid receipt", () => {
        const h = fixture();
        expect(() => h.receiver.finish()).toThrow(/incomplete/);
        const receiver = createRestrictedSourceResultReceiver(
            { ...h.descriptor, contentHash: sha256Bytes(Buffer.from("different result")) },
            4 * RESTRICTED_SOURCE_CHUNK_BYTES,
        );
        receiver.accept(h.transfer.next(receiver.nextRequest()));
        expect(receiver.isComplete()).toBe(true);
        expect(() => receiver.nextRequest()).toThrow(/no pending/);
        expect(() => receiver.finish()).toThrow(/complete result hash mismatch/);
        expect(receiver.isComplete()).toBe(false);
        h.transfer.dispose();
        h.receiver.dispose();
        receiver.dispose();
    });
});
