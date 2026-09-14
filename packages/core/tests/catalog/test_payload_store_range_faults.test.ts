import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVerifiedTextPayloadPage, resolvePayloadPath } from "../../src/catalog/payload-store";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";

let root = "";
let versionRoot = "";

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-payload-range-faults-"));
    versionRoot = path.join(root, "version");
    fs.mkdirSync(path.join(versionRoot, "payloads"), { recursive: true });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function writePayload(bytes: Uint8Array, namedHash = sha256Bytes(bytes)): string {
    fs.writeFileSync(resolvePayloadPath(versionRoot, namedHash), bytes);
    return namedHash;
}

describe("verified text payload range faults", () => {
    it("requires positive page sizes and non-negative safe page offsets", () => {
        const hash = writePayload(Buffer.from("text", "utf-8"));
        for (const pageBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
            expect(() => readVerifiedTextPayloadPage(versionRoot, hash, 4, 0, pageBytes)).toThrow(/page size/u);
        }
        for (const byteOffset of [-1, 1.5, Number.POSITIVE_INFINITY]) {
            expect(() => readVerifiedTextPayloadPage(versionRoot, hash, 4, byteOffset, 2)).toThrow(/page offset/u);
        }
        expect(readVerifiedTextPayloadPage(versionRoot, hash, 4, 1, 2)).toMatchObject({
            text: "ex",
            loadedByteStart: 1,
            loadedByteEnd: 3,
        });
    });

    it("rejects byte-size, BOM, newline, hash, UTF-8, and out-of-range violations", () => {
        const bytes = Buffer.from("abc", "utf-8");
        const hash = writePayload(bytes);
        expect(() => readVerifiedTextPayloadPage(versionRoot, hash, 4, 0, 2)).toThrow(/byteSize mismatch/u);

        const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
        const bomHash = writePayload(bom);
        expect(() => readVerifiedTextPayloadPage(versionRoot, bomHash, bom.length, 0, 1)).toThrow(/BOM/u);

        const crlf = Buffer.from("a\r\n", "utf-8");
        const crlfHash = writePayload(crlf);
        expect(() => readVerifiedTextPayloadPage(versionRoot, crlfHash, crlf.length, 0, 3)).toThrow(/LF newlines/u);

        const expectedHash = sha256Bytes(Buffer.from("abd", "utf-8"));
        writePayload(bytes, expectedHash);
        expect(() => readVerifiedTextPayloadPage(versionRoot, expectedHash, bytes.length, 0, 2)).toThrow(/hash mismatch/u);

        const invalidUtf8 = Buffer.from([0xc3, 0x28]);
        const invalidUtf8Hash = writePayload(invalidUtf8);
        expect(() => readVerifiedTextPayloadPage(versionRoot, invalidUtf8Hash, invalidUtf8.length, 0, 2)).toThrow();

        expect(() => readVerifiedTextPayloadPage(versionRoot, hash, bytes.length, 4, 2)).toThrow(/outside the payload/u);
    });

    it("accepts short and empty canonical payloads without inventing lines or bytes", () => {
        const short = Buffer.from("a", "utf-8");
        const shortHash = writePayload(short);
        expect(readVerifiedTextPayloadPage(versionRoot, shortHash, 1, 0, 1)).toEqual({
            text: "a",
            loadedByteStart: 0,
            loadedByteEnd: 1,
            totalBytes: 1,
            firstLine: 1,
            lastLine: 1,
            totalLines: 1,
        });

        const multiline = Buffer.from("a\nb", "utf-8");
        const multilineHash = writePayload(multiline);
        expect(readVerifiedTextPayloadPage(versionRoot, multilineHash, multiline.length, 0, multiline.length)).toMatchObject({
            text: "a\nb",
            lastLine: 2,
            totalLines: 2,
        });

        const empty = new Uint8Array();
        const emptyHash = writePayload(empty);
        expect(readVerifiedTextPayloadPage(versionRoot, emptyHash, 0, 0, 1)).toEqual({
            text: "",
            loadedByteStart: 0,
            loadedByteEnd: 0,
            totalBytes: 0,
            firstLine: 1,
            lastLine: 1,
            totalLines: 1,
        });
    });

    it("keeps every progressive page on an exact UTF-8 code-point boundary", () => {
        const bytes = Buffer.from("A€B", "utf-8");
        const hash = writePayload(bytes);
        const first = readVerifiedTextPayloadPage(versionRoot, hash, bytes.length, 0, 2);
        const second = readVerifiedTextPayloadPage(versionRoot, hash, bytes.length, first.loadedByteEnd, 2);

        expect(first).toMatchObject({
            text: "A€",
            loadedByteStart: 0,
            loadedByteEnd: 4,
        });
        expect(second).toMatchObject({
            text: "B",
            loadedByteStart: 4,
            loadedByteEnd: 5,
        });
        expect(first.text + second.text).toBe("A€B");
        expect(() => readVerifiedTextPayloadPage(versionRoot, hash, bytes.length, 2, 2)).toThrow(/UTF-8 code-point boundary/u);
    });
});
