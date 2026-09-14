import * as crypto from "node:crypto";
import type { AssetVersionFileContentV2, Sha256Digest } from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core";

export function textFile(
    logicalPath: string,
    text: string,
    fileId: string,
    role: "entry" | "resource",
    executable: boolean,
): AssetVersionFileContentV2 {
    return {
        contentKind: "text",
        text,
        file: {
            fileId,
            logicalPath,
            role,
            contentHash: sha256Text(text),
            contentKind: "text",
            mediaType: inferCanonicalMediaType(logicalPath, "text"),
            byteSize: Buffer.byteLength(text),
            executable,
            references: [],
        },
    };
}

export function binaryFile(logicalPath: string, source: Uint8Array, fileId: string): AssetVersionFileContentV2 {
    const bytes = new Uint8Array(source);
    return {
        contentKind: "binary",
        bytes,
        file: {
            fileId,
            logicalPath,
            role: "resource",
            contentHash: sha256Bytes(bytes),
            contentKind: "binary",
            mediaType: inferCanonicalMediaType(logicalPath, "binary"),
            byteSize: bytes.byteLength,
            executable: false,
            references: [],
        },
    };
}

export function nativeText(relativePath: string, text: string, executable: boolean) {
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: inferCanonicalMediaType(relativePath, "text"),
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable,
        text,
    };
}

export function nativeBinary(relativePath: string, source: Uint8Array, executable: boolean) {
    const bytes = new Uint8Array(source);
    return {
        relativePath,
        contentKind: "binary" as const,
        mediaType: inferCanonicalMediaType(relativePath, "binary"),
        contentHash: sha256Bytes(bytes),
        byteSize: bytes.byteLength,
        executable,
        bytes,
    };
}

export function nativeDescriptor(file: ReturnType<typeof nativeText> | ReturnType<typeof nativeBinary>) {
    const { text: _text, bytes: _bytes, ...descriptor } = file as typeof file & { text?: string; bytes?: Uint8Array };
    return descriptor;
}

export function fileContent(file: ReturnType<typeof nativeText> | ReturnType<typeof nativeBinary>) {
    return file.contentKind === "text"
        ? { contentKind: "text" as const, text: file.text }
        : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) };
}

export function sha256Text(text: string): Sha256Digest {
    return sha256Bytes(new TextEncoder().encode(text));
}

export function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
