/** Ordered bounded frames for one completed source result; downloading never re-reads source files. */
import { createHash, randomUUID } from "node:crypto";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { hasExactKeys, isSha256Digest, isUuidV4 } from "../foundation/validators";
import type { AdapterReadResult, CoreResult, Sha256Digest } from "../types";
import { decodeRestrictedSourceReadResult, encodeRestrictedSourceReadResult } from "./restricted-source-result-codec";

export const RESTRICTED_SOURCE_CHUNK_BYTES = 1024 * 1024;
export interface RestrictedSourceResultDescriptor {
    transferId: string;
    byteLength: number;
    contentHash: Sha256Digest;
}
export interface RestrictedSourceResultChunk {
    offset: number;
    byteLength: number;
    bytesBase64: string;
    contentHash: Sha256Digest;
}
export class RestrictedSourceResultCapacityError extends Error {
    constructor() {
        super("restricted source result exceeds the Host's configured review transfer capacity");
    }
}

export function createRestrictedSourceResultTransfer(result: CoreResult<AdapterReadResult>, maximumResultBytes: number) {
    requireCapacity(maximumResultBytes);
    let bytes: Buffer | undefined = encodeRestrictedSourceReadResult(result);
    if (bytes.byteLength > maximumResultBytes) throw new RestrictedSourceResultCapacityError();
    const descriptor: RestrictedSourceResultDescriptor = {
        transferId: randomUUID(),
        byteLength: bytes.byteLength,
        contentHash: sha256Bytes(bytes),
    };
    let offset = 0;
    return Object.freeze({
        descriptor: Object.freeze(descriptor),
        next(request: { transferId: string; offset: number }): RestrictedSourceResultChunk {
            if (
                !hasExactKeys(request, ["transferId", "offset"]) ||
                bytes === undefined ||
                request.transferId !== descriptor.transferId ||
                request.offset !== offset ||
                offset >= descriptor.byteLength
            )
                throw new Error("restricted source result request is stale or out of sequence");
            const current = bytes.subarray(offset, offset + RESTRICTED_SOURCE_CHUNK_BYTES);
            const chunk = {
                offset,
                byteLength: current.byteLength,
                bytesBase64: current.toString("base64"),
                contentHash: sha256Bytes(current),
            };
            offset += current.byteLength;
            return chunk;
        },
        acknowledge(request: { transferId: string; contentHash: Sha256Digest }) {
            if (
                !hasExactKeys(request, ["transferId", "contentHash"]) ||
                bytes === undefined ||
                request.transferId !== descriptor.transferId ||
                request.contentHash !== descriptor.contentHash ||
                offset !== descriptor.byteLength
            )
                throw new Error("restricted source result acknowledgement is incomplete or unrelated");
            bytes = undefined;
        },
        dispose() {
            bytes = undefined;
        },
    });
}

/** Capacity is supplied by the Host that owns the result consumer, not inferred from the physical read-byte budget. */
export function createRestrictedSourceResultReceiver(value: unknown, maximumResultBytes: number) {
    requireCapacity(maximumResultBytes);
    if (!hasExactKeys(value, ["transferId", "byteLength", "contentHash"]))
        throw new Error("invalid restricted source transfer descriptor");
    const descriptor = structuredClone(value) as RestrictedSourceResultDescriptor;
    if (
        !isUuidV4(descriptor.transferId) ||
        !Number.isSafeInteger(descriptor.byteLength) ||
        descriptor.byteLength < 1 ||
        descriptor.byteLength > maximumResultBytes ||
        !isSha256Digest(descriptor.contentHash)
    )
        throw new Error("restricted source result descriptor exceeds its admitted identity or capacity");
    let offset = 0;
    let closed = false;
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    return Object.freeze({
        descriptor: Object.freeze(descriptor),
        nextRequest() {
            if (closed || offset >= descriptor.byteLength) throw new Error("restricted source transfer has no pending chunk");
            return { transferId: descriptor.transferId, offset };
        },
        accept(value: unknown) {
            if (closed || !hasExactKeys(value, ["offset", "byteLength", "bytesBase64", "contentHash"]))
                throw new Error("invalid restricted source chunk");
            const chunk = value as RestrictedSourceResultChunk;
            const expectedLength = Math.min(RESTRICTED_SOURCE_CHUNK_BYTES, descriptor.byteLength - offset);
            if (
                expectedLength < 1 ||
                chunk.offset !== offset ||
                chunk.byteLength !== expectedLength ||
                typeof chunk.bytesBase64 !== "string" ||
                chunk.bytesBase64.length !== 4 * Math.ceil(expectedLength / 3) ||
                !isSha256Digest(chunk.contentHash)
            )
                throw new Error("restricted source chunk is truncated, replayed or out of order");
            const bytes = Buffer.from(chunk.bytesBase64, "base64");
            if (
                bytes.byteLength !== expectedLength ||
                bytes.toString("base64") !== chunk.bytesBase64 ||
                sha256Bytes(bytes) !== chunk.contentHash
            )
                throw new Error("restricted source chunk bytes do not match their receipt");
            chunks.push(bytes);
            hash.update(bytes);
            offset += bytes.byteLength;
        },
        isComplete: () => !closed && offset === descriptor.byteLength,
        finish(): CoreResult<AdapterReadResult> {
            if (closed || offset !== descriptor.byteLength)
                throw new Error("restricted source result is incomplete or already consumed");
            closed = true;
            try {
                if (`sha256:${hash.digest("hex")}` !== descriptor.contentHash)
                    throw new Error("restricted source complete result hash mismatch");
                return decodeRestrictedSourceReadResult(Buffer.concat(chunks, descriptor.byteLength));
            } finally {
                chunks.length = 0;
            }
        },
        dispose() {
            closed = true;
            chunks.length = 0;
        },
    });
}

function requireCapacity(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid Host source-result capacity");
}
