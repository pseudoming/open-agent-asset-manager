import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
    loadRestrictedArtifactPackage,
    requireRestrictedArtifactManifest,
    validateRestrictedArtifactPackage,
} from "../src/restricted-artifact-package";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const entries = [
    { name: "node", bytes: Buffer.from("test-runtime-bytes"), executable: true },
    { name: "restricted-wsl.cjs", bytes: Buffer.from("test-entry-bytes"), executable: false },
    { name: "node_modules/private/reader.js", bytes: Buffer.from("test-reader-bytes"), executable: false },
];

function checksum(header: Buffer) {
    header.fill(32, 148, 156);
    const sum = header.reduce((result, byte) => result + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}

function tar(files = entries): Buffer {
    const blocks: Buffer[] = [];
    for (const file of files) {
        const header = Buffer.alloc(512);
        header.write(file.name, 0, 100, "ascii");
        const octal = (offset: number, length: number, value: number) =>
            header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
        octal(100, 8, file.executable ? 0o700 : 0o600);
        octal(108, 8, 0);
        octal(116, 8, 0);
        octal(124, 12, file.bytes.byteLength);
        octal(136, 12, 0);
        header[156] = 48;
        header.write("ustar\0", 257);
        header.write("00", 263);
        checksum(header);
        blocks.push(header, file.bytes, Buffer.alloc((512 - (file.bytes.length % 512)) % 512));
    }
    return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function manifest() {
    return {
        schemaVersion: 1,
        platform: "linux",
        architecture: "x64",
        nodeVersion: "22.14.0",
        nodeModulesVersion: "127",
        files: entries.map((file) => ({
            relativePath: file.name,
            bytes: file.bytes.length,
            sha256: hash(file.bytes),
            executable: file.executable,
        })),
    };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("shipped restricted artifact package", () => {
    it("rejects a maximum-width tar size that disagrees with its manifest", () => {
        const archive = tar();
        archive.write("777777777777", 124, 12, "ascii");
        checksum(archive.subarray(0, 512));
        expect(() => validateRestrictedArtifactPackage(encode(manifest()), gzipSync(archive))).toThrow(
            "bytes or permissions differ",
        );
    });
    it("rejects a manifest above the original byte bound before parsing", () => {
        expect(() => validateRestrictedArtifactPackage(Buffer.alloc(64 * 1024 + 1), gzipSync(tar()))).toThrow("package bounds");
    });
    it.each([null, 1, [], {}, { ...manifest(), extra: true }])("rejects noncanonical manifest shape %j", (value) => {
        expect(() => requireRestrictedArtifactManifest(value)).toThrow("invalid restricted artifact manifest");
    });
    it.each(["shape", "digest_type", "digest_text"] as const)("rejects file %s before reading the archive", (failure) => {
        const value = manifest();
        if (failure === "shape") Object.assign(value.files[0]!, { extra: true });
        else Object.assign(value.files[0]!, { sha256: failure === "digest_type" ? 1 : "invalid" });
        expect(() => requireRestrictedArtifactManifest(value)).toThrow(
            failure === "shape" ? "invalid restricted artifact file" : "invalid restricted artifact digest",
        );
    });
    it("accepts an exact 100-byte archive name without a terminator", () => {
        const value = manifest(),
            name = "a".repeat(100);
        value.files[2]!.relativePath = name;
        const files = entries.map((file, index) => (index === 2 ? { ...file, name } : file));
        expect(validateRestrictedArtifactPackage(encode(value), gzipSync(tar(files))).manifest.files[2]!.relativePath).toBe(name);
    });
    it.each([
        "non_ascii",
        "hidden_suffix",
        "entry_truncated",
        "trailer_missing",
    ] as const)("rejects %s in otherwise valid archive bytes", (failure) => {
        let archive = tar();
        if (failure === "non_ascii") archive[0] = 255;
        if (failure === "hidden_suffix") archive[99] = 65;
        if (failure === "entry_truncated") archive = archive.subarray(0, 513);
        if (failure === "trailer_missing") archive = archive.subarray(0, -1024);
        expect(() => validateRestrictedArtifactPackage(encode(manifest()), gzipSync(archive))).toThrow(
            failure === "non_ascii" || failure === "hidden_suffix"
                ? "archive name"
                : failure === "entry_truncated"
                  ? "truncated restricted artifact entry"
                  : "no complete trailer",
        );
    });
    it("loads exactly the bound regular file inventory, bytes and executable attributes", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-artifact-test-"));
        roots.push(root);
        const manifestBytes = encode(manifest());
        const payload = gzipSync(tar());
        const manifestPath = path.join(root, "manifest.json");
        const payloadPath = path.join(root, "payload.tgz");
        fs.writeFileSync(manifestPath, manifestBytes);
        fs.writeFileSync(payloadPath, payload);
        const reference = { manifestPath, payloadPath, manifestSha256: hash(manifestBytes), payloadSha256: hash(payload) };
        const loaded = loadRestrictedArtifactPackage(reference);
        expect(loaded.manifest.files).toHaveLength(3);
        expect(loaded.manifest.files[0]?.executable).toBe(true);
        expect(hash(loaded.payload)).toBe(hash(payload));
        fs.writeFileSync(payloadPath, Buffer.from("replaced package"));
        expect(() => loadRestrictedArtifactPackage(reference)).toThrow("identity mismatch");
    });

    it.each(["1", "2", "5", "x", "g"])("rejects archive entry type %s before any installation", (type) => {
        const archive = tar();
        archive[156] = type.charCodeAt(0);
        checksum(archive.subarray(0, 512));
        expect(() => validateRestrictedArtifactPackage(encode(manifest()), gzipSync(archive))).toThrow(
            "regular-file archive header",
        );
    });

    it.each([
        "../escape",
        "/absolute",
        "x/../node",
        "node//file",
        "./node",
        "node\\file",
    ])("rejects noncanonical manifest path %s", (relativePath) => {
        const value = manifest();
        value.files[0]!.relativePath = relativePath;
        expect(() => validateRestrictedArtifactPackage(encode(value), gzipSync(tar()))).toThrow("canonical relative file");
    });

    it.each(["duplicate", "extra", "missing", "truncated", "trailing"])("rejects a %s archive inventory", (kind) => {
        const files =
            kind === "duplicate"
                ? [...entries, entries[0]!]
                : kind === "extra"
                  ? [...entries, { name: "unapproved.js", bytes: Buffer.from("extra"), executable: false }]
                  : kind === "missing"
                    ? entries.slice(0, 2)
                    : entries;
        let archive = tar(files);
        if (kind === "truncated") archive = archive.subarray(0, -1);
        if (kind === "trailing") archive = Buffer.concat([archive, Buffer.from("unexpected")]);
        expect(() => validateRestrictedArtifactPackage(encode(manifest()), gzipSync(archive))).toThrow();
    });

    it.each([
        "bytes",
        "mode",
        "checksum",
        "link",
        "prefix",
        "padding",
    ])("rejects altered %s in an otherwise named artifact", (kind) => {
        const archive = tar();
        const header = archive.subarray(0, 512);
        if (kind === "bytes") archive[512] = 0;
        if (kind === "mode") header.write("0000777\0", 100, 8, "ascii");
        if (kind === "link") header.write("/outside", 157, 100, "ascii");
        if (kind === "prefix") header.write("/outside", 345, 155, "ascii");
        if (kind === "padding") archive[512 + entries[0]!.bytes.length] = 1;
        checksum(header);
        if (kind === "checksum") header[148] = 57;
        expect(() => validateRestrictedArtifactPackage(encode(manifest()), gzipSync(archive))).toThrow();
    });

    it("rejects duplicate manifest members and a nonexecutable private runtime", () => {
        const duplicate = manifest();
        duplicate.files.push(duplicate.files[0]!);
        expect(() => validateRestrictedArtifactPackage(encode(duplicate), gzipSync(tar()))).toThrow("file bounds");
        const nonexecutable = manifest();
        nonexecutable.files[0]!.executable = false;
        expect(() => validateRestrictedArtifactPackage(encode(nonexecutable), gzipSync(tar()))).toThrow("target-local runtime");
    });
});
