import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Small ELF-shaped bytes test package routing and corruption; they are never executable proof. */
export function createRestrictedWslPackageFixture(root: string, installed = true): void {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(62, 18);
    const contents = new Map<string, Buffer>([
        ["node", elf],
        ["native/oaam_file_lock.node", elf],
        ["restricted-wsl.cjs", Buffer.from("require('better-sqlite3');\n")],
        ["package.json", Buffer.from('{"private":true,"type":"commonjs"}\n')],
        ["node_modules/better-sqlite3/package.json", Buffer.from('{"name":"better-sqlite3","main":"index.js"}\n')],
        [
            "node_modules/better-sqlite3/index.js",
            Buffer.from("module.exports = require('./build/Release/better_sqlite3.node');\n"),
        ],
        ["node_modules/better-sqlite3/build/Release/better_sqlite3.node", elf],
    ]);
    const codeRoot = installed ? path.join(root, "code") : root;
    const files = [...contents].map(([relativePath, bytes]) => {
        const target = path.join(codeRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { flag: "wx", mode: relativePath === "node" ? 0o700 : 0o600 });
        return {
            relativePath,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            executable: relativePath === "node",
        };
    });
    fs.writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({
            schemaVersion: 1,
            platform: "linux",
            architecture: "x64",
            nodeVersion: "22.0.0",
            nodeModulesVersion: "127",
            files,
        }),
        { flag: "wx" },
    );
}
