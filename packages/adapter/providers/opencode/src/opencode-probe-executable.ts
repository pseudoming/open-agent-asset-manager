import type { Platform, PlatformContext } from "@oaam/core";
import { closeSync, openSync, readSync } from "node:fs";

/**
 * A Win32 stat over a selected WSL UNC path does not carry authoritative Linux
 * executable-mode bits. The selected-WSL process probe revalidates the exact
 * runtime executable through /proc before any public read is accepted.
 */
export function installationRequiresExecutableMode(platformContext: PlatformContext): boolean {
    return platformContext.platform !== "win32";
}

export function hasNativeBinaryMagic(path: string, platform: Platform): boolean {
    const descriptor = openSync(path, "r");
    try {
        const bytes = Buffer.alloc(4);
        const byteCount = readSync(descriptor, bytes, 0, bytes.length, 0);
        return hasNativeBinaryMagicBytes(bytes.subarray(0, byteCount), platform);
    } finally {
        closeSync(descriptor);
    }
}

export function hasNativeBinaryMagicBytes(bytes: Uint8Array, platform: Platform): boolean {
    if (platform === "win32") return bytes.byteLength >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
    if (bytes.byteLength < 4) return false;
    if (platform === "linux" || platform === "wsl") {
        return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    }
    const value = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0);
    return (
        value === 0xfeedface ||
        value === 0xfeedfacf ||
        value === 0xcefaedfe ||
        value === 0xcffaedfe ||
        value === 0xcafebabe ||
        value === 0xbebafeca ||
        value === 0xcafebabf ||
        value === 0xbfbafeca
    );
}
