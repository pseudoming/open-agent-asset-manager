import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const LINUX_APP_ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);

export function claudeLinuxAsar(
    manifest: unknown = { name: "@ant/desktop", productName: "Claude", version: "1.49585.0" },
): Buffer {
    const bytes = Buffer.from(JSON.stringify(manifest));
    const headerText = Buffer.from(
        JSON.stringify({
            files: {
                "package.json": {
                    size: bytes.length,
                    offset: "0",
                    integrity: {
                        algorithm: "SHA256",
                        hash: crypto.createHash("sha256").update(bytes).digest("hex"),
                    },
                },
            },
        }),
    );
    const padded = Math.ceil(headerText.length / 4) * 4;
    const header = Buffer.alloc(8 + padded);
    header.writeUInt32LE(header.length - 4, 0);
    header.writeUInt32LE(headerText.length, 4);
    headerText.copy(header, 8);
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(header.length, 4);
    return Buffer.concat([prefix, header, bytes]);
}

export function seedClaudeLinuxApp(root: string): void {
    fs.mkdirSync(path.join(root, "resources"), { recursive: true });
    fs.writeFileSync(path.join(root, "resources", "app.asar"), claudeLinuxAsar());
    fs.writeFileSync(path.join(root, "claude-desktop"), LINUX_APP_ELF, { mode: 0o755 });
}

export function seedClaudeLinuxEngine(root: string, version = "2.1.260"): string {
    const directory = path.join(root, version);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, ".verified"), "a".repeat(64));
    const engine = path.join(directory, "claude");
    fs.writeFileSync(engine, LINUX_APP_ELF, { mode: 0o755 });
    return engine;
}
