/** Exact runtime-neutral byte hashing and base64 codec mechanics. */
import * as crypto from "node:crypto";
import type { Sha256Digest } from "../contracts/primitives";

/** Return the canonical OAAM SHA-256 wire form for the exact input bytes. */
export function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

/** Encode the exact input bytes with Node's Buffer base64 codec. */
export function bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

/**
 * Decode with Node's permissive Buffer base64 codec.
 *
 * This operation does not validate a persisted wire shape. Callers that need
 * canonical base64 must validate before decoding.
 */
export function base64ToBytes(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, "base64"));
}
