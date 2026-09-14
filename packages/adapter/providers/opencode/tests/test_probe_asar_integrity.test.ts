import { describe, expect, it, vi } from "vitest";
import { readOpencodeAppVersion } from "../src/opencode-probe-app-asar-version";
import { opencodeAppAsar } from "./opencode-app-asar-fixture";

const ARCHIVE = "/owned/resources/app.asar";
const IDENTITY = { deviceId: "local", fileId: "3", entryKind: "file" } as const;

function readRangeFrom(bytes: Uint8Array) {
    return vi.fn((_path: string, offset: number, maximumBytes: number) => ({
        bytes: bytes.slice(offset, offset + maximumBytes),
        byteOffset: offset,
        totalBytes: bytes.byteLength,
        executable: false,
        identity: IDENTITY,
    }));
}

describe("OpenCode physical ASAR integrity", () => {
    it.each([
        ["short prefix", Uint8Array.of(0)],
        ["wrong product", opencodeAppAsar("1.18.15", { name: "another-product" })],
        ["invalid version", opencodeAppAsar("not-a-version")],
        ["empty manifest", opencodeAppAsar("1.18.15", {}, { size: 0 })],
        ["missing integrity", opencodeAppAsar("1.18.15", {}, { integrity: null })],
        ["wrong digest", opencodeAppAsar("1.18.15", {}, { integrity: { algorithm: "SHA256", hash: "0".repeat(64) } })],
        ["out-of-archive offset", opencodeAppAsar("1.18.15", {}, { offset: "999999999999999" })],
        [
            "wrong pickle prefix",
            (() => {
                const b = Buffer.from(opencodeAppAsar("1.18.15"));
                b.writeUInt32LE(5, 0);
                return b;
            })(),
        ],
        [
            "oversized header",
            (() => {
                const b = Buffer.from(opencodeAppAsar("1.18.15"));
                b.writeUInt32LE(9 * 1024 * 1024, 4);
                return b;
            })(),
        ],
    ])("rejects %s under the same physical archive contract", (_name, bytes) => {
        expect(readOpencodeAppVersion(ARCHIVE, readRangeFrom(bytes as Uint8Array))).toBeNull();
    });

    it.each([2, 3, 4, 5, 6])("rejects an incomplete range at read %s", (readNumber) => {
        const bytes = opencodeAppAsar("1.18.15");
        let calls = 0;
        const reader = (_path: string, offset: number, size: number) => {
            calls += 1;
            return {
                bytes: bytes.slice(offset, offset + size - (calls === readNumber ? 1 : 0)),
                byteOffset: offset,
                totalBytes: bytes.byteLength,
                executable: false,
                identity: IDENTITY,
            };
        };
        expect(readOpencodeAppVersion(ARCHIVE, reader)).toBeNull();
        expect(calls).toBeGreaterThanOrEqual(readNumber);
    });

    it.each([3, 4, 5, 6])("rejects identity drift at read %s", (readNumber) => {
        const bytes = opencodeAppAsar("1.18.15");
        let calls = 0;
        expect(
            readOpencodeAppVersion(ARCHIVE, (_path, offset, size) => {
                calls += 1;
                return {
                    bytes: bytes.slice(offset, offset + size),
                    byteOffset: offset,
                    totalBytes: bytes.byteLength,
                    executable: false,
                    identity: calls === readNumber ? { ...IDENTITY, fileId: "changed" } : IDENTITY,
                };
            }),
        ).toBeNull();
    });

    it.each([4, 5, 6])("rejects same-identity content drift during repeated read %s", (readNumber) => {
        const bytes = opencodeAppAsar("1.18.15");
        let calls = 0;
        expect(
            readOpencodeAppVersion(ARCHIVE, (_path, offset, size) => {
                calls += 1;
                const sampled = bytes.slice(offset, offset + size);
                if (calls === readNumber) sampled[0] = sampled[0] === 0 ? 1 : 0;
                return {
                    bytes: sampled,
                    byteOffset: offset,
                    totalBytes: bytes.byteLength,
                    executable: false,
                    identity: IDENTITY,
                };
            }),
        ).toBeNull();
    });

    it("fails closed on a range-read failure", () => {
        expect(
            readOpencodeAppVersion(ARCHIVE, () => {
                throw new Error("injected range-read failure");
            }),
        ).toBeNull();
    });
});
