import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    binaryPayloadStats,
    bytesForPayload,
    canonicalMediaType,
    normalizeText,
    readPayload,
    resolvePayloadPath,
    textPayloadStats,
    writePayload,
    writePayloadForTest,
    writePayloadBytes,
    writePayloadBytesForTest,
} from "../../src/catalog/payload-store";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { inferCanonicalMediaType } from "../../src/foundation/media-type";

describe("Version-local content-addressed payload store", () => {
    let versionRoot: string;

    beforeEach(() => {
        versionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-p3-payload-"));
    });

    afterEach(() => fs.rmSync(versionRoot, { recursive: true, force: true }));

    it("normalizes canonical text to UTF-8 without BOM and with LF", () => {
        const normalized = normalizeText("\ufeffa\r\nb\rc");
        expect(normalized.normalized).toBe("a\nb\nc");
        expect(Buffer.from(normalized.bytes).toString("utf-8")).toBe("a\nb\nc");
        expect(textPayloadStats("\ufeffa\r\nb\rc")).toEqual({
            contentHash: sha256Bytes(Buffer.from("a\nb\nc")),
            byteSize: 5,
        });
    });

    it("stores canonical text by digest and reopens exact verified bytes", () => {
        const stored = writePayload(versionRoot, "hello\r\n", "text");
        const expectedPath = resolvePayloadPath(versionRoot, stored.contentHash);
        expect(path.basename(expectedPath)).toBe(stored.contentHash.slice(7));
        expect(Buffer.from(readPayload(versionRoot, stored.contentHash, stored.byteSize).bytes).toString()).toBe("hello\n");
    });

    it("deduplicates identical owner-local bytes without changing the payload", () => {
        const first = writePayload(versionRoot, new Uint8Array([0, 1, 2]), "binary");
        const second = writePayload(versionRoot, new Uint8Array([0, 1, 2]), "binary");
        expect(second).toEqual(first);
        expect(fs.readdirSync(path.join(versionRoot, "payloads"))).toHaveLength(1);
    });

    it("rejects an existing digest path containing different bytes", () => {
        const expected = binaryPayloadStats(new Uint8Array([1, 2, 3]));
        const target = resolvePayloadPath(versionRoot, expected.contentHash);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, new Uint8Array([9, 9, 9]));
        expect(() => writePayload(versionRoot, new Uint8Array([1, 2, 3]), "binary")).toThrow(/payload hash mismatch/);
    });

    it("detects a payload tampered after publication and wrong byteSize", () => {
        const stored = writePayload(versionRoot, "hello", "text");
        expect(() => readPayload(versionRoot, stored.contentHash, stored.byteSize + 1)).toThrow(/byteSize mismatch/);
        fs.writeFileSync(resolvePayloadPath(versionRoot, stored.contentHash), "evil");
        expect(() => readPayload(versionRoot, stored.contentHash)).toThrow(/payload hash mismatch/);
    });

    it("rejects symlink aliases instead of following them", () => {
        const stored = writePayload(versionRoot, "hello", "text");
        const real = resolvePayloadPath(versionRoot, stored.contentHash);
        const linkedHash = `sha256:${"a".repeat(64)}` as const;
        fs.symlinkSync(real, resolvePayloadPath(versionRoot, linkedHash));
        expect(() => readPayload(versionRoot, linkedHash)).toThrow(/symbolic|link/i);
    });

    it("stores native/restoration bytes verbatim without canonical text normalization", () => {
        const raw = Buffer.from("\ufeffa\r\n", "utf-8");
        const stored = writePayloadBytes(versionRoot, raw);
        expect(Buffer.from(readPayload(versionRoot, stored.contentHash).bytes)).toEqual(raw);
        expect(writePayloadBytes(versionRoot, raw)).toEqual(stored);
    });

    it("rejects equal-length different bytes even under an injected digest collision", () => {
        const collisionHash = `sha256:${"c".repeat(64)}` as const;
        const collide = () => collisionHash;
        writePayloadForTest(versionRoot, "aa", "text", collide);
        expect(() => writePayloadForTest(versionRoot, "bb", "text", collide)).toThrow(/different bytes/);

        const rawRoot = path.join(versionRoot, "raw");
        writePayloadBytesForTest(rawRoot, Buffer.from("aa"), collide);
        expect(() => writePayloadBytesForTest(rawRoot, Buffer.from("bb"), collide)).toThrow(/different bytes/);
    });

    it("validates content branches and digest paths", () => {
        expect(() => bytesForPayload(new Uint8Array([1]), "text")).toThrow(/must be a string/);
        expect(() => bytesForPayload("x", "binary")).toThrow(/must be Uint8Array/);
        expect(Buffer.from(bytesForPayload("x", "text")).toString()).toBe("x");
        expect(Array.from(bytesForPayload(new Uint8Array([1]), "binary"))).toEqual([1]);
        expect(() => resolvePayloadPath(versionRoot, "nope" as never)).toThrow(/contentHash/);
    });

    it("canonicalizes media types without inventing parameters", () => {
        expect(canonicalMediaType(" Text/Markdown; charset=UTF-8 ")).toBe("text/markdown");
        expect(canonicalMediaType(" ")).toBe("application/octet-stream");
        expect(canonicalMediaType(" ;charset=x")).toBe("application/octet-stream");
        expect(canonicalMediaType("application/json")).toBe("application/json");
    });

    it("infers one canonical media type table with a binary-safe fallback", () => {
        expect(
            [
                "FILE.JSON",
                "file.jsonc",
                "file.js",
                "file.MARKDOWN",
                "file.md",
                "file.mjs",
                "file.ts",
                "file.txt",
                "file.yaml",
                "file.yml",
                "file.unknown",
            ].map((logicalPath) => inferCanonicalMediaType(logicalPath, "text")),
        ).toEqual([
            "application/json",
            "application/json",
            "text/javascript",
            "text/markdown",
            "text/markdown",
            "text/javascript",
            "text/typescript",
            "text/plain",
            "application/yaml",
            "application/yaml",
            "application/octet-stream",
        ]);
        expect(inferCanonicalMediaType("misleading.md", "binary")).toBe("application/octet-stream");
    });
});
