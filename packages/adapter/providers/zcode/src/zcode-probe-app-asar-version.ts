/** Bounded, no-follow ZCode App version extraction from the physical Electron ASAR. */

import { createHash } from "node:crypto";
import {
    type ProviderRegularFileRangeRead,
    readProviderRegularFileRangeNoFollow,
    sameProviderRegularFileIdentity,
} from "@oaam/adapter-framework";

const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_HEADER_BYTES = 8 * 1024 * 1024;
const MAXIMUM_PACKAGE_JSON_BYTES = 64 * 1024;
const PREFIX_BYTES = 16;

interface AsarPackageEntry {
    size: number;
    offset: number;
    integrityHash: string;
}

/**
 * Read only the ASAR header and root package manifest. Each range is sampled
 * twice and bound to one physical identity so a replaced or changing archive
 * cannot contribute installation version evidence.
 */
export function readZcodeAppVersion(archivePath: string): string | null {
    try {
        const prefix = readExactRange(archivePath, 0, PREFIX_BYTES);
        if (prefix === null || prefix.totalBytes > MAXIMUM_ARCHIVE_BYTES) return null;
        const prefixBytes = Buffer.from(prefix.bytes);
        if (prefixBytes.readUInt32LE(0) !== 4) return null;
        const headerSize = prefixBytes.readUInt32LE(4);
        if (headerSize < 8 || headerSize > MAXIMUM_HEADER_BYTES || 8 + headerSize > prefix.totalBytes) return null;

        const header = readExactRange(archivePath, 8, headerSize);
        if (header === null || !sameSample(prefix, header)) return null;
        const headerBytes = Buffer.from(header.bytes);
        if (!prefixBytes.subarray(8).equals(headerBytes.subarray(0, 8))) return null;
        const packageEntry = parsePackageEntry(headerBytes, headerSize);
        if (packageEntry === null) return null;

        const packageStart = 8 + headerSize + packageEntry.offset;
        if (
            !Number.isSafeInteger(packageStart) ||
            packageStart < 8 + headerSize ||
            packageStart + packageEntry.size > prefix.totalBytes
        ) {
            return null;
        }
        const manifest = readExactRange(archivePath, packageStart, packageEntry.size);
        if (manifest === null || !sameSample(prefix, manifest)) return null;
        if (sha256Hex(manifest.bytes) !== packageEntry.integrityHash) return null;

        const repeatedPrefix = readExactRange(archivePath, 0, PREFIX_BYTES);
        const repeatedHeader = readExactRange(archivePath, 8, headerSize);
        const repeatedManifest = readExactRange(archivePath, packageStart, packageEntry.size);
        if (
            repeatedPrefix === null ||
            repeatedHeader === null ||
            repeatedManifest === null ||
            !sameSample(prefix, repeatedPrefix) ||
            !sameSample(prefix, repeatedHeader) ||
            !sameSample(prefix, repeatedManifest) ||
            !Buffer.from(repeatedPrefix.bytes).equals(prefixBytes) ||
            !Buffer.from(repeatedHeader.bytes).equals(headerBytes) ||
            !Buffer.from(repeatedManifest.bytes).equals(Buffer.from(manifest.bytes))
        ) {
            return null;
        }

        const packageManifest = parseJsonRecord(manifest.bytes);
        const versionText = stringValue(packageManifest?.version);
        return packageManifest?.name === "@zcode/desktop" &&
            packageManifest.productName === "ZCode" &&
            packageManifest.zcodeProductFlavor === "production" &&
            isNumericDottedVersion(versionText)
            ? versionText
            : null;
    } catch {
        return null;
    }
}

function readExactRange(path: string, offset: number, length: number): ProviderRegularFileRangeRead | null {
    const result = readProviderRegularFileRangeNoFollow(path, offset, length);
    return result.byteOffset === offset && result.bytes.byteLength === length ? result : null;
}

function parsePackageEntry(headerBytes: Buffer, headerSize: number): AsarPackageEntry | null {
    if (headerBytes.readUInt32LE(0) !== headerSize - 4) return null;
    const headerStringBytes = headerBytes.readUInt32LE(4);
    if (headerStringBytes === 0 || headerStringBytes > headerSize - 8) return null;
    const padding = headerBytes.subarray(8 + headerStringBytes);
    if (padding.length > 3 || padding.some((byte) => byte !== 0)) return null;

    const header = parseJsonRecord(headerBytes.subarray(8, 8 + headerStringBytes));
    const packageEntry = isRecord(header?.files) ? header.files["package.json"] : null;
    if (
        !isRecord(packageEntry) ||
        "files" in packageEntry ||
        "link" in packageEntry ||
        packageEntry.unpacked === true ||
        !isRecord(packageEntry.integrity)
    ) {
        return null;
    }
    const { size, offset, integrity } = packageEntry;
    if (
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAXIMUM_PACKAGE_JSON_BYTES ||
        typeof offset !== "string" ||
        !/^(?:0|[1-9][0-9]{0,15})$/u.test(offset) ||
        integrity.algorithm !== "SHA256" ||
        typeof integrity.hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(integrity.hash)
    ) {
        return null;
    }
    const numericOffset = Number(offset);
    return Number.isSafeInteger(numericOffset) ? { size, offset: numericOffset, integrityHash: integrity.hash } : null;
}

function sameSample(left: ProviderRegularFileRangeRead, right: ProviderRegularFileRangeRead): boolean {
    return (
        left.totalBytes === right.totalBytes &&
        left.executable === right.executable &&
        sameProviderRegularFileIdentity(left.identity, right.identity)
    );
}

function parseJsonRecord(bytes: Uint8Array): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function isNumericDottedVersion(value: string): boolean {
    return /^[0-9]+(?:\.[0-9]+){1,15}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]{0,127})?$/u.test(value);
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
