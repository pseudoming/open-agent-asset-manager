import * as path from "node:path";
import * as crypto from "node:crypto";
import {
    SafeFilesystemError,
    durableEnsureDirectory,
    durableReplaceFile,
    readRegularFileNoFollow,
    readRegularFileRangeNoFollow,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import type { ContentKind, Sha256Digest } from "../contracts/primitives";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { isSha256Digest } from "../foundation/validators";
export { canonicalMediaType } from "../foundation/media-type";

const PAYLOADS_DIRECTORY = "payloads";

export interface StoredPayload {
    contentHash: Sha256Digest;
    byteSize: number;
}

export interface VerifiedTextPayloadPage {
    text: string;
    loadedByteStart: number;
    loadedByteEnd: number;
    totalBytes: number;
    firstLine: number;
    lastLine: number;
    totalLines: number;
}

export function normalizeText(text: string): { bytes: Uint8Array; normalized: string } {
    let normalized = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
    normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return { bytes: Buffer.from(normalized, "utf-8"), normalized };
}

export function textPayloadStats(text: string): StoredPayload {
    return payloadStats(normalizeText(text).bytes);
}

export function binaryPayloadStats(bytes: Uint8Array): StoredPayload {
    return payloadStats(bytes);
}

export function bytesForPayload(content: string | Uint8Array, contentKind: ContentKind): Uint8Array {
    if (contentKind === "text") {
        if (typeof content !== "string") throw new Error("text payload content must be a string");
        return normalizeText(content).bytes;
    }
    if (typeof content === "string") throw new Error("binary payload content must be Uint8Array");
    return new Uint8Array(content);
}

export function resolvePayloadPath(versionRoot: string, contentHash: Sha256Digest): string {
    if (!isSha256Digest(contentHash)) {
        throw new Error(`contentHash must be sha256:<64 lowercase hex>: ${String(contentHash)}`);
    }
    return path.join(versionRoot, PAYLOADS_DIRECTORY, contentHash.slice("sha256:".length));
}

/**
 * Store one immutable payload in a Version-local content-addressed pool.
 * Existing bytes are accepted only when their full digest and bytes agree.
 */
export function writePayload(versionRoot: string, content: string | Uint8Array, contentKind: ContentKind): StoredPayload {
    return writePayloadCore(versionRoot, content, contentKind, sha256Bytes);
}

/** Test-only digest seam for collision-path fault injection. */
export function writePayloadForTest(
    versionRoot: string,
    content: string | Uint8Array,
    contentKind: ContentKind,
    digest: (bytes: Uint8Array) => Sha256Digest,
): StoredPayload {
    return writePayloadCore(versionRoot, content, contentKind, digest);
}

function writePayloadCore(
    versionRoot: string,
    content: string | Uint8Array,
    contentKind: ContentKind,
    digest: (bytes: Uint8Array) => Sha256Digest,
): StoredPayload {
    const bytes = bytesForPayload(content, contentKind);
    const stats = payloadStats(bytes, digest);
    durableEnsureDirectory(path.dirname(versionRoot), path.basename(versionRoot));
    durableEnsureDirectory(versionRoot, PAYLOADS_DIRECTORY);
    const destination = resolvePayloadPath(versionRoot, stats.contentHash);

    try {
        const existing = readRegularFileNoFollow(destination).bytes;
        verifyBytes(existing, stats.contentHash, bytes.length, digest);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
            throw new Error(`payload collision: ${stats.contentHash} names different bytes`);
        }
        return stats;
    } catch (error) {
        if (!(error instanceof SafeFilesystemError) || error.failureKind !== "not_found") {
            throw error;
        }
    }

    durableReplaceFile(destination, bytes);
    const reopened = readRegularFileNoFollow(destination).bytes;
    verifyBytes(reopened, stats.contentHash, bytes.length, digest);
    return stats;
}

/** Store native/restoration bytes verbatim; unlike canonical text, no normalization applies. */
export function writePayloadBytes(versionRoot: string, bytes: Uint8Array): StoredPayload {
    return writePayloadBytesCore(versionRoot, bytes, sha256Bytes);
}

/** Test-only digest seam for raw native/restoration collision fault injection. */
export function writePayloadBytesForTest(
    versionRoot: string,
    bytes: Uint8Array,
    digest: (value: Uint8Array) => Sha256Digest,
): StoredPayload {
    return writePayloadBytesCore(versionRoot, bytes, digest);
}

function writePayloadBytesCore(
    versionRoot: string,
    bytes: Uint8Array,
    digest: (value: Uint8Array) => Sha256Digest,
): StoredPayload {
    const stats = payloadStats(bytes, digest);
    durableEnsureDirectory(path.dirname(versionRoot), path.basename(versionRoot));
    durableEnsureDirectory(versionRoot, PAYLOADS_DIRECTORY);
    const destination = resolvePayloadPath(versionRoot, stats.contentHash);
    try {
        const existing = readRegularFileNoFollow(destination).bytes;
        verifyBytes(existing, stats.contentHash, bytes.length, digest);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
            throw new Error(`payload collision: ${stats.contentHash} names different bytes`);
        }
        return stats;
    } catch (error) {
        if (!(error instanceof SafeFilesystemError) || error.failureKind !== "not_found") {
            throw error;
        }
    }
    durableReplaceFile(destination, bytes);
    const reopened = readRegularFileNoFollow(destination).bytes;
    verifyBytes(reopened, stats.contentHash, bytes.length, digest);
    return stats;
}

export function readPayload(
    versionRoot: string,
    contentHash: Sha256Digest,
    expectedByteSize?: number,
): { bytes: Uint8Array; stats: StoredPayload } {
    const payloadPath = resolvePayloadPath(versionRoot, contentHash);
    const bytes = readRegularFileNoFollow(payloadPath).bytes;
    verifyBytes(bytes, contentHash, expectedByteSize);
    return { bytes, stats: { contentHash, byteSize: bytes.length } };
}

/**
 * Verify one immutable text payload while retaining only one bounded page.
 *
 * The complete payload is streamed in fixed-size ranges so its content hash,
 * UTF-8 encoding and canonical newline form are proven without loading the
 * whole file into memory. A page may retain up to three following bytes so its
 * end and the next cursor remain exact UTF-8 code-point boundaries.
 */
export function readVerifiedTextPayloadPage(
    versionRoot: string,
    contentHash: Sha256Digest,
    expectedByteSize: number,
    byteOffset: number,
    pageBytes: number,
): VerifiedTextPayloadPage {
    if (!Number.isSafeInteger(pageBytes) || pageBytes < 1) {
        throw new Error("text payload page size must be a positive safe integer");
    }
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
        throw new Error("text payload page offset must be a non-negative safe integer");
    }
    const payloadPath = resolvePayloadPath(versionRoot, contentHash);
    const digest = crypto.createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let expectedIdentity: ReturnType<typeof readRegularFileRangeNoFollow>["identity"] | undefined;
    let totalBytes: number | undefined;
    let position = 0;
    const leadingBytes: number[] = [];
    const pageChunks: Uint8Array[] = [];
    let newlineCountBeforePage = 0;
    let totalNewlineCount = 0;

    while (true) {
        const range = readRegularFileRangeNoFollow(payloadPath, position, pageBytes);
        if (totalBytes === undefined) totalBytes = range.totalBytes;
        if (range.totalBytes !== totalBytes || range.totalBytes !== expectedByteSize) {
            throw new Error(
                `payload byteSize mismatch for ${contentHash}: expected ${expectedByteSize}, got ${range.totalBytes}`,
            );
        }
        if (expectedIdentity === undefined) expectedIdentity = range.identity;
        if (!samePhysicalPathIdentity(expectedIdentity, range.identity)) {
            throw new Error("payload physical identity changed while its ranges were verified");
        }
        if (range.byteOffset !== position) {
            throw new Error("payload range reader returned a mismatched byte offset");
        }
        for (const byte of range.bytes) {
            if (leadingBytes.length < 3) leadingBytes.push(byte);
        }
        if (range.bytes.includes(0x0d)) {
            throw new Error("canonical text payload must use LF newlines");
        }
        digest.update(range.bytes);
        const end = position + range.bytes.length;
        decoder.decode(range.bytes, { stream: end < range.totalBytes });
        totalNewlineCount += countByte(range.bytes, 0x0a);
        if (position < byteOffset) {
            newlineCountBeforePage += countByte(
                range.bytes.subarray(0, Math.min(range.bytes.length, byteOffset - position)),
                0x0a,
            );
        }
        const remainingFromPage = Math.max(0, range.totalBytes - byteOffset);
        const desiredPageLength = Math.min(pageBytes, remainingFromPage);
        const candidatePageLength = Math.min(remainingFromPage, desiredPageLength + 3);
        const pageEndLimit = byteOffset + candidatePageLength;
        const overlapStart = Math.max(position, byteOffset);
        const overlapEnd = Math.min(end, pageEndLimit);
        if (overlapStart < overlapEnd) {
            pageChunks.push(range.bytes.slice(overlapStart - position, overlapEnd - position));
        }
        if (end >= range.totalBytes) break;
        if (range.bytes.length === 0) throw new Error("payload range reader made no progress");
        position = end;
    }

    if (leadingBytes[0] === 0xef && leadingBytes[1] === 0xbb && leadingBytes[2] === 0xbf) {
        throw new Error("canonical text payload must not contain a UTF-8 BOM");
    }
    const actualHash = `sha256:${digest.digest("hex")}`;
    if (actualHash !== contentHash) {
        throw new Error(`payload hash mismatch: expected ${contentHash}, got ${actualHash}`);
    }
    const resolvedTotalBytes = totalBytes as number;
    if (byteOffset > resolvedTotalBytes) throw new Error("text payload page offset is outside the payload");
    const remainingBytes = resolvedTotalBytes - byteOffset;
    const desiredPageLength = Math.min(pageBytes, remainingBytes);
    const candidateBytes = Buffer.concat(pageChunks.map((chunk) => Buffer.from(chunk)));
    const page = decodeCompleteUtf8Page(candidateBytes, desiredPageLength);
    const loadedByteEnd = byteOffset + page.bytes;
    const firstLine = newlineCountBeforePage + 1;
    const pageNewlineCount = countByte(candidateBytes.subarray(0, page.bytes), 0x0a);
    return {
        text: page.text,
        loadedByteStart: byteOffset,
        loadedByteEnd,
        totalBytes: resolvedTotalBytes,
        firstLine,
        lastLine: firstLine + pageNewlineCount,
        totalLines: totalNewlineCount + 1,
    };
}

function decodeCompleteUtf8Page(bytes: Uint8Array, desiredLength: number): { text: string; bytes: number } {
    for (let length = desiredLength; length <= bytes.length; length += 1) {
        try {
            return {
                text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
                bytes: length,
            };
        } catch {
            // At most three following bytes are retained so a split UTF-8 code point can finish.
        }
    }
    throw new Error("text payload page offset is not aligned to a UTF-8 code-point boundary");
}

function countByte(bytes: Uint8Array, expected: number): number {
    let count = 0;
    for (const byte of bytes) {
        if (byte === expected) count += 1;
    }
    return count;
}

function verifyBytes(
    bytes: Uint8Array,
    expectedHash: Sha256Digest,
    expectedByteSize?: number,
    digest: (value: Uint8Array) => Sha256Digest = sha256Bytes,
): void {
    if (expectedByteSize !== undefined && bytes.length !== expectedByteSize) {
        throw new Error(`payload byteSize mismatch for ${expectedHash}: expected ${expectedByteSize}, got ${bytes.length}`);
    }
    const actual = digest(bytes);
    if (actual !== expectedHash) {
        throw new Error(`payload hash mismatch: expected ${expectedHash}, got ${actual}`);
    }
}

function payloadStats(bytes: Uint8Array, digest: (value: Uint8Array) => Sha256Digest = sha256Bytes): StoredPayload {
    return { contentHash: digest(bytes), byteSize: bytes.length };
}
