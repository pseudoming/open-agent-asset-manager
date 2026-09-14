import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, sha256Bytes } from "../../src/foundation/crypto-bytes";

describe("Core byte crypto and base64 mechanics", () => {
    it("hashes the exact bytes into the canonical sha256-prefixed wire form", () => {
        expect(sha256Bytes(Buffer.from("abc", "utf-8"))).toBe(
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        expect(sha256Bytes(new Uint8Array())).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("round-trips empty and non-text binary bytes through Buffer base64", () => {
        const binary = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
        expect(bytesToBase64(binary)).toBe("AAH+/w==");
        expect(base64ToBytes("AAH+/w==")).toEqual(binary);
        expect(bytesToBase64(new Uint8Array())).toBe("");
        expect(base64ToBytes("")).toEqual(new Uint8Array());
    });

    it("remains a permissive codec rather than claiming canonical base64 validation", () => {
        expect(base64ToBytes("YQ")).toEqual(new Uint8Array([0x61]));
        expect(base64ToBytes("%%%")).toEqual(new Uint8Array());
    });
});
