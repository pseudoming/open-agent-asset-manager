import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as probeFilesystem from "@oaam/adapter-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findClaudeLinuxAppInstallation } from "../src/claudecode-probe-linux-app-installation";
import { readClaudeLinuxAppVersion } from "../src/claudecode-probe-linux-app-version";
import { claudeLinuxAsar, seedClaudeLinuxApp } from "./claudecode-linux-app-fixture";

let root = "";
let archive = "";
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-asar-guards-"));
    archive = path.join(root, "app.asar");
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

function archiveWithEntry(changes: Record<string, unknown>): Buffer {
    const original = claudeLinuxAsar();
    const headerLength = original.readUInt32LE(4);
    const header = JSON.parse(original.subarray(16, 16 + original.readUInt32LE(12)).toString("utf8"));
    Object.assign(header.files["package.json"], changes);
    const json = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(16 + Math.ceil(json.length / 4) * 4);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(prefix.length - 8, 4);
    prefix.writeUInt32LE(prefix.length - 12, 8);
    prefix.writeUInt32LE(json.length, 12);
    json.copy(prefix, 16);
    return Buffer.concat([prefix, original.subarray(8 + headerLength)]);
}

describe("Claude Linux App version evidence guards", () => {
    it.each([
        ["directory entry", { files: {} }],
        ["linked manifest", { link: "elsewhere/package.json" }],
        ["unpacked manifest", { unpacked: true }],
        ["missing integrity", { integrity: null }],
        ["empty manifest", { size: 0 }],
        ["oversized manifest", { size: 65537 }],
        ["negative offset", { offset: "-1" }],
        ["leading-zero offset", { offset: "01" }],
        ["unsafe integer offset", { offset: "9999999999999999" }],
        ["manifest outside archive", { offset: "100000" }],
    ])("rejects a %s without importing installation evidence", (_name, changes) => {
        fs.writeFileSync(archive, archiveWithEntry(changes as Record<string, unknown>));
        expect(readClaudeLinuxAppVersion(archive)).toBeNull();
    });

    it("rejects malformed header framing, JSON and nonzero padding", () => {
        const mutations: Array<(bytes: Buffer) => void> = [
            (bytes) => bytes.writeUInt32LE(3, 0),
            (bytes) => bytes.writeUInt32LE(7, 4),
            (bytes) => bytes.writeUInt32LE(8388609, 4),
            (bytes) => bytes.writeUInt32LE(0, 8),
            (bytes) => bytes.writeUInt32LE(0, 12),
            (bytes) => bytes.writeUInt32LE(bytes.length, 12),
            (bytes) => {
                bytes[16] = 0xff;
            },
            (bytes) => {
                const paddingStart = 16 + bytes.readUInt32LE(12);
                expect(paddingStart).toBeLessThan(8 + bytes.readUInt32LE(4));
                bytes[paddingStart] = 1;
            },
        ];
        for (const mutate of mutations) {
            const bytes = archiveWithEntry({ fixturePadding: "x" });
            mutate(bytes);
            fs.writeFileSync(archive, bytes);
            expect(readClaudeLinuxAppVersion(archive)).toBeNull();
        }
    });

    it("rejects validly hashed non-object metadata and non-string versions", () => {
        for (const manifest of [[], null, { name: "@ant/desktop", productName: "Claude", version: 123 }]) {
            fs.writeFileSync(archive, claudeLinuxAsar(manifest));
            expect(readClaudeLinuxAppVersion(archive)).toBeNull();
        }
    });

    it("rejects an archive changed after reading the first complete manifest", () => {
        fs.writeFileSync(archive, claudeLinuxAsar());
        const read = probeFilesystem.readProviderRegularFileRangeNoFollow;
        let calls = 0;
        vi.spyOn(probeFilesystem, "readProviderRegularFileRangeNoFollow").mockImplementation((...args) => {
            if (++calls === 4) {
                const bytes = fs.readFileSync(archive);
                bytes[bytes.length - 2] ^= 1;
                fs.writeFileSync(archive, bytes);
            }
            return read(...args);
        });
        expect(readClaudeLinuxAppVersion(archive)).toBeNull();
        expect(calls).toBeGreaterThanOrEqual(4);
    });

    it("distinguishes a missing archive from denied access", () => {
        expect(readClaudeLinuxAppVersion(archive)).toBeNull();
        const denied = Object.assign(new Error("fixture denied range read"), { code: "EACCES" });
        vi.spyOn(probeFilesystem, "readProviderRegularFileRangeNoFollow").mockImplementation(() => {
            throw denied;
        });
        expect(() => readClaudeLinuxAppVersion(archive)).toThrow(denied);
    });

    it("rejects an App bundle physically replaced during its version observation", () => {
        const app = path.join(root, "app");
        seedClaudeLinuxApp(app);
        const result = findClaudeLinuxAppInstallation(
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: root },
            app,
            {
                readVersion: () => {
                    fs.renameSync(app, path.join(root, "retained-original"));
                    seedClaudeLinuxApp(app);
                    return "1.49585.0";
                },
            },
        );
        expect(result).toMatchObject({ status: "unknown", diagnostics: [{ code: "claudecode_app_linux_bundle_changed" }] });
        expect(fs.existsSync(path.join(root, "retained-original", "claude-desktop"))).toBe(true);
    });
});
