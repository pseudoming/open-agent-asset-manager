/** Minimal physical Electron ASAR carrying the current ZCode package manifest shape. */

import { createHash } from "node:crypto";

export function zcodeAppAsar(
    version: string,
    manifestOverrides: Readonly<Record<string, unknown>> = {},
    packageEntryOverrides: Readonly<Record<string, unknown>> = {},
): Uint8Array {
    const manifest = Buffer.from(
        JSON.stringify({
            name: "@zcode/desktop",
            productName: "ZCode",
            version,
            zcodeProductFlavor: "production",
            main: "out/main/index.js",
            ...manifestOverrides,
        }),
        "utf8",
    );
    const headerJson = Buffer.from(
        JSON.stringify({
            files: {
                "package.json": {
                    size: manifest.length,
                    offset: "0",
                    integrity: {
                        algorithm: "SHA256",
                        hash: createHash("sha256").update(manifest).digest("hex"),
                        blockSize: 4_194_304,
                        blocks: [createHash("sha256").update(manifest).digest("hex")],
                    },
                    ...packageEntryOverrides,
                },
            },
        }),
        "utf8",
    );
    const paddedHeaderStringBytes = (headerJson.length + 3) & ~3;
    const headerSize = 8 + paddedHeaderStringBytes;
    const archive = Buffer.alloc(8 + headerSize + manifest.length);
    archive.writeUInt32LE(4, 0);
    archive.writeUInt32LE(headerSize, 4);
    archive.writeUInt32LE(headerSize - 4, 8);
    archive.writeUInt32LE(headerJson.length, 12);
    headerJson.copy(archive, 16);
    manifest.copy(archive, 8 + headerSize);
    return archive;
}
