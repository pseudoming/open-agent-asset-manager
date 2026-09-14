import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";

const MAXIMUM_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAXIMUM_EXPANDED_BYTES = 256 * 1024 * 1024;

export interface RestrictedArtifactFile {
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly executable: boolean;
}

export interface RestrictedArtifactManifest {
    readonly schemaVersion: 1;
    readonly platform: "linux";
    readonly architecture: "x64" | "arm64";
    readonly nodeVersion: string;
    readonly nodeModulesVersion: string;
    readonly files: readonly RestrictedArtifactFile[];
}

export interface RestrictedArtifactPackageReference {
    readonly manifestPath: string;
    readonly payloadPath: string;
    readonly manifestSha256: string;
    readonly payloadSha256: string;
}

export interface RestrictedArtifactPackage {
    readonly manifest: RestrictedArtifactManifest;
    readonly payload: Uint8Array;
}

/** Read the exact shipped code artifact before any selected-WSL process or file creation. */
export function loadRestrictedArtifactPackage(reference: RestrictedArtifactPackageReference): RestrictedArtifactPackage {
    requireHash(reference.manifestSha256);
    requireHash(reference.payloadSha256);
    const manifest = readRegularFileNoFollow(reference.manifestPath, 64 * 1024).bytes;
    const payload = readRegularFileNoFollow(reference.payloadPath, MAXIMUM_PAYLOAD_BYTES).bytes;
    if (sha256(manifest) !== reference.manifestSha256 || sha256(payload) !== reference.payloadSha256)
        throw new Error("restricted artifact identity mismatch");
    return validateRestrictedArtifactPackage(manifest, payload);
}

/** @internal One package grammar, shared by the installed loader and bounded artifact tests. */
export function validateRestrictedArtifactPackage(manifestBytes: Uint8Array, payload: Uint8Array): RestrictedArtifactPackage {
    if (manifestBytes.byteLength > 64 * 1024 || payload.byteLength > MAXIMUM_PAYLOAD_BYTES)
        throw new Error("restricted artifact exceeds its package bounds");
    const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    requireRestrictedArtifactManifest(manifest);
    const expanded = gunzipSync(payload, { maxOutputLength: MAXIMUM_EXPANDED_BYTES });
    validateRegularTar(expanded, manifest.files);
    return {
        manifest: Object.freeze({ ...manifest, files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))) }),
        payload,
    };
}

/** @internal Shipped-code manifest grammar shared by archive and unpacked-package validation. */
export function requireRestrictedArtifactManifest(value: unknown): asserts value is RestrictedArtifactManifest {
    if (!exactKeys(value, ["schemaVersion", "platform", "architecture", "nodeVersion", "nodeModulesVersion", "files"]))
        throw new Error("invalid restricted artifact manifest");
    const manifest = value as unknown as RestrictedArtifactManifest;
    if (
        manifest.schemaVersion !== 1 ||
        manifest.platform !== "linux" ||
        (manifest.architecture !== "x64" && manifest.architecture !== "arm64") ||
        typeof manifest.nodeVersion !== "string" ||
        !/^\d+\.\d+\.\d+$/u.test(manifest.nodeVersion) ||
        typeof manifest.nodeModulesVersion !== "string" ||
        !/^[1-9][0-9]*$/u.test(manifest.nodeModulesVersion) ||
        !Array.isArray(manifest.files) ||
        manifest.files.length < 2 ||
        manifest.files.length > 128
    )
        throw new Error("invalid restricted artifact target or inventory");
    const seen = new Set<string>();
    let bytes = 0;
    for (const file of manifest.files) {
        if (!exactKeys(file, ["relativePath", "bytes", "sha256", "executable"]))
            throw new Error("invalid restricted artifact file");
        requireRelativePath(file.relativePath);
        requireHash(file.sha256);
        if (
            seen.has(file.relativePath) ||
            typeof file.bytes !== "number" ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
            file.bytes > 128 * 1024 * 1024 ||
            typeof file.executable !== "boolean"
        )
            throw new Error("invalid restricted artifact file bounds");
        seen.add(file.relativePath);
        bytes += file.bytes;
    }
    if (
        bytes > MAXIMUM_EXPANDED_BYTES ||
        !seen.has("node") ||
        !seen.has("restricted-wsl.cjs") ||
        manifest.files.find((file) => file.relativePath === "node")?.executable !== true
    )
        throw new Error("restricted artifact lacks its target-local runtime");
}

function validateRegularTar(archive: Buffer, expected: readonly RestrictedArtifactFile[]): void {
    const inventory = new Map(expected.map((file) => [file.relativePath, file]));
    const seen = new Set<string>();
    let offset = 0;
    while (offset + 512 <= archive.byteLength) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            if (archive.byteLength - offset !== 1024 || !archive.subarray(offset).every((byte) => byte === 0))
                throw new Error("restricted artifact has an invalid archive trailer");
            if (seen.size !== inventory.size) throw new Error("restricted artifact inventory is incomplete");
            return;
        }
        const nameEnd = header.subarray(0, 100).indexOf(0);
        const nameBytes = header.subarray(0, nameEnd < 0 ? 100 : nameEnd);
        if (nameBytes.some((byte) => byte > 127) || (nameEnd >= 0 && !header.subarray(nameEnd, 100).every((byte) => byte === 0)))
            throw new Error("invalid restricted artifact archive name");
        const name = nameBytes.toString("ascii");
        requireRelativePath(name);
        const file = inventory.get(name);
        if (file === undefined || seen.has(name)) throw new Error("unexpected or duplicate restricted artifact entry");
        const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (
            checksum !== octal(header.subarray(148, 156)) ||
            header[156] !== 48 ||
            header.subarray(257, 263).toString("ascii") !== "ustar\0" ||
            header.subarray(263, 265).toString("ascii") !== "00"
        )
            throw new Error("invalid restricted regular-file archive header");
        if (!header.subarray(157, 257).every((byte) => byte === 0) || !header.subarray(345).every((byte) => byte === 0))
            throw new Error("restricted artifact link or path prefix is forbidden");
        const length = octal(header.subarray(124, 136));
        if (
            length !== file.bytes ||
            octal(header.subarray(100, 108)) !== (file.executable ? 0o700 : 0o600) ||
            octal(header.subarray(108, 116)) !== 0 ||
            octal(header.subarray(116, 124)) !== 0
        )
            throw new Error("restricted artifact bytes or permissions differ from its manifest");
        const end = offset + 512 + length;
        const paddedEnd = end + ((512 - (length % 512)) % 512);
        if (paddedEnd > archive.byteLength) throw new Error("truncated restricted artifact entry");
        const bytes = archive.subarray(offset + 512, end);
        if (sha256(bytes) !== file.sha256 || !archive.subarray(end, paddedEnd).every((byte) => byte === 0))
            throw new Error("restricted artifact entry digest or padding mismatch");
        seen.add(name);
        offset = paddedEnd;
    }
    throw new Error("restricted artifact archive has no complete trailer");
}

function octal(bytes: Buffer): number {
    const value = bytes.toString("ascii");
    if (!/^[0-7]+[\0 ]*$/u.test(value)) throw new Error("invalid restricted artifact archive number");
    // Private callers pass only fixed-width tar fields of at most 12 octal digits,
    // whose maximum value is below 2^36 and therefore exactly representable.
    return Number.parseInt(value, 8);
}

function requireRelativePath(value: unknown): asserts value is string {
    if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_.\/-]{1,100}$/u.test(value) ||
        value.split("/").some((part) => part === "" || part === "." || part === "..")
    )
        throw new Error("restricted artifact path must be one canonical relative file");
}

function requireHash(value: unknown): asserts value is string {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid restricted artifact digest");
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(",") === [...keys].sort().join(",")
    );
}

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
