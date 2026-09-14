import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";

const mocked = vi.hoisted(() => ({
    readRange: vi.fn(),
}));

vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        readRegularFileRangeNoFollow: mocked.readRange,
    };
});

import { readVerifiedTextPayloadPage } from "../../src/catalog/payload-store";

const IDENTITY = Object.freeze({ deviceId: "device", fileId: "file", entryKind: "file" as const });

beforeEach(() => {
    mocked.readRange.mockReset();
});

describe("verified text payload range race boundaries", () => {
    it("rejects a physical identity replacement between ranges", () => {
        mocked.readRange
            .mockReturnValueOnce({ bytes: Buffer.from("a"), byteOffset: 0, totalBytes: 2, identity: IDENTITY })
            .mockReturnValueOnce({
                bytes: Buffer.from("b"),
                byteOffset: 1,
                totalBytes: 2,
                identity: { ...IDENTITY, fileId: "replacement" },
            });
        expect(() => readVerifiedTextPayloadPage("/version", sha256Bytes(Buffer.from("ab")), 2, 0, 1)).toThrow(
            /physical identity changed/u,
        );
    });

    it("rejects changing total size and a range reader that stops making progress", () => {
        mocked.readRange
            .mockReturnValueOnce({ bytes: Buffer.from("a"), byteOffset: 0, totalBytes: 2, identity: IDENTITY })
            .mockReturnValueOnce({ bytes: Buffer.from("b"), byteOffset: 1, totalBytes: 3, identity: IDENTITY });
        expect(() => readVerifiedTextPayloadPage("/version", sha256Bytes(Buffer.from("ab")), 2, 0, 1)).toThrow(
            /byteSize mismatch/u,
        );

        mocked.readRange.mockReset();
        mocked.readRange
            .mockReturnValueOnce({ bytes: Buffer.from("a"), byteOffset: 0, totalBytes: 2, identity: IDENTITY })
            .mockReturnValueOnce({ bytes: new Uint8Array(), byteOffset: 1, totalBytes: 2, identity: IDENTITY });
        expect(() => readVerifiedTextPayloadPage("/version", sha256Bytes(Buffer.from("ab")), 2, 0, 1)).toThrow(
            /made no progress/u,
        );
    });

    it("rejects a backend range that does not begin at the requested offset", () => {
        mocked.readRange.mockReturnValueOnce({
            bytes: Buffer.from("a"),
            byteOffset: 1,
            totalBytes: 1,
            identity: IDENTITY,
        });
        expect(() => readVerifiedTextPayloadPage("/version", sha256Bytes(Buffer.from("a")), 1, 0, 1)).toThrow(
            /mismatched byte offset/u,
        );
    });
});
