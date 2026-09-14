import type { PlatformContext } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOpencodeAppVersion } from "../src/opencode-probe-app-asar-version";
import { findOpencodeAppInstallation, inspectOpencodeAppCandidate } from "../src/opencode-probe-app-installation";
import { opencodeAppAsar } from "./opencode-app-asar-fixture";

let sandbox = "";
let home = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-app-probe-"));
    home = path.join(sandbox, "home");
    fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode Desktop installation evidence", () => {
    it("accepts only a complete user-selected App folder", () => {
        const selectedRoot = path.join(sandbox, "selected-opencode");
        const emptyRoot = path.join(sandbox, "empty-opencode");
        writeNative(path.join(selectedRoot, "ai.opencode.desktop"), [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(selectedRoot, "resources", "app.asar"), opencodeAppAsar("1.18.15"));
        fs.mkdirSync(emptyRoot);

        expect(findOpencodeAppInstallation({}, home, linuxContext(), true, selectedRoot)).toMatchObject({
            status: "available",
            versionText: "1.18.15",
            evidence: expect.arrayContaining([expect.objectContaining({ kind: "install_root", path: selectedRoot })]),
        });
        expect(findOpencodeAppInstallation({}, home, linuxContext(), true, emptyRoot)).toMatchObject({
            status: "not_found",
            evidence: [expect.objectContaining({ path: path.join(emptyRoot, "ai.opencode.desktop") })],
        });
    });

    it("returns checked Windows absence and verifies the exact physical App bundle", () => {
        const localAppData = path.join(home, "AppData", "Local");
        const context = windowsContext();
        expect(findOpencodeAppInstallation({ LOCALAPPDATA: localAppData }, home, context, false)).toMatchObject({
            status: "not_found",
            versionText: "",
        });

        const root = path.join(localAppData, "Programs", "OpenCode");
        writeNative(path.join(root, "OpenCode.exe"), [0x4d, 0x5a]);
        writeFile(path.join(root, "resources", "app.asar"), opencodeAppAsar("1.18.15"));
        expect(findOpencodeAppInstallation({ LOCALAPPDATA: localAppData }, home, context, false)).toMatchObject({
            status: "available",
            versionText: "1.18.15",
            evidence: [
                expect.objectContaining({ kind: "install_root", path: root }),
                expect.objectContaining({ kind: "app_bundle", path: path.join(root, "resources", "app.asar") }),
            ],
        });

        const programFiles = path.join(home, "Program Files");
        const programRoot = path.join(programFiles, "OpenCode");
        writeNative(path.join(programRoot, "OpenCode.exe"), [0x4d, 0x5a]);
        writeFile(path.join(programRoot, "resources", "app.asar"), opencodeAppAsar("1.18.15"));
        expect(
            findOpencodeAppInstallation(
                { LOCALAPPDATA: path.join(sandbox, "absent-local"), ProgramFiles: programFiles },
                home,
                context,
                false,
            ),
        ).toMatchObject({ status: "available", versionText: "1.18.15" });
    });

    it("verifies a declared Linux App and rejects non-native, non-executable, symlink and wrong-kind entries", () => {
        const root = path.join(sandbox, "app");
        const executable = path.join(root, "ai.opencode.desktop");
        writeNative(executable, [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(root, "resources", "app.asar"), opencodeAppAsar("1.18.15"));
        expect(findOpencodeAppInstallation({ OPENCODE_APP_INSTALL_DIR: root }, home, linuxContext(), true)).toMatchObject({
            status: "available",
            versionText: "1.18.15",
        });
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({
            state: "available",
            installRoot: root,
            appArchive: path.join(root, "resources", "app.asar"),
        });

        fs.chmodSync(executable, 0o644);
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });
        fs.chmodSync(executable, 0o755);
        fs.writeFileSync(executable, Buffer.from([0x4d, 0x5a]), { mode: 0o755 });
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });

        fs.rmSync(executable);
        fs.mkdirSync(executable);
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });
        fs.rmSync(executable, { recursive: true });
        const foreign = path.join(sandbox, "foreign");
        writeNative(foreign, [0x7f, 0x45, 0x4c, 0x46]);
        fs.symlinkSync(foreign, executable);
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });
    });

    it("classifies absent, incomplete, inaccessible and invalid App structures without following archive links", () => {
        const root = path.join(sandbox, "app");
        const executable = path.join(root, "ai.opencode.desktop");
        expect(inspectOpencodeAppCandidate(path.join(sandbox, "missing"), false, true)).toEqual({ state: "absent" });
        expect(inspectOpencodeAppCandidate("\0", false, true)).toEqual({ state: "unknown" });

        writeNative(executable, [0x7f, 0x45, 0x4c, 0x46]);
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });
        expect(findOpencodeAppInstallation({ OPENCODE_APP_INSTALL_DIR: root }, home, linuxContext(), true)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_app_install_structure_unverified" })],
        });

        const archive = path.join(root, "resources", "app.asar");
        fs.mkdirSync(archive, { recursive: true });
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });
        fs.rmSync(archive, { recursive: true });
        const archiveTarget = path.join(sandbox, "archive-target");
        writeFile(archiveTarget, opencodeAppAsar("1.18.15"));
        fs.symlinkSync(archiveTarget, archive);
        expect(inspectOpencodeAppCandidate(executable, false, true)).toEqual({ state: "structure_mismatch" });
        fs.rmSync(archive);

        fs.chmodSync(executable, 0o000);
        expect(findOpencodeAppInstallation({ OPENCODE_APP_INSTALL_DIR: root }, home, linuxContext(), false)).toMatchObject({
            status: "needs_permission",
            diagnostics: [expect.objectContaining({ code: "opencode_app_install_permission_denied" })],
        });
        fs.chmodSync(executable, 0o755);
    });

    it("reads only a bounded integrity-checked OpenCode manifest and fails closed for malformed archives", () => {
        const archive = path.join(sandbox, "app.asar");
        expect(readOpencodeAppVersion(path.join(sandbox, "missing"))).toBeNull();
        writeFile(archive, opencodeAppAsar("1.18.15"));
        expect(readOpencodeAppVersion(archive)).toBe("1.18.15");

        const invalidArchives = [
            Uint8Array.of(0),
            opencodeAppAsar("not-a-version"),
            opencodeAppAsar("1.18.15", { name: "another-product" }),
            opencodeAppAsar("1.18.15", {}, { size: 0 }),
            opencodeAppAsar("1.18.15", {}, { offset: "9999999999999999" }),
            opencodeAppAsar("1.18.15", {}, { integrity: null }),
            opencodeAppAsar("1.18.15", {}, { integrity: { algorithm: "SHA256", hash: "0".repeat(64) } }),
            (() => {
                const bytes = Buffer.from(opencodeAppAsar("1.18.15"));
                bytes.writeUInt32LE(5, 0);
                return bytes;
            })(),
        ];
        for (const invalid of invalidArchives) {
            writeFile(archive, invalid);
            expect(readOpencodeAppVersion(archive)).toBeNull();
        }
    });

    it("validates the same ASAR contract through bounded physical ranges", () => {
        const archive = Buffer.from(opencodeAppAsar("1.18.15"));
        const identity = { deviceId: "device", fileId: "file", entryKind: "file" as const };
        const readRange = vi.fn((_path: string, offset: number, maximumBytes: number) => ({
            bytes: new Uint8Array(archive.subarray(offset, offset + maximumBytes)),
            byteOffset: offset,
            totalBytes: archive.byteLength,
            executable: false,
            identity,
        }));

        expect(readOpencodeAppVersion("C:\\owned\\app.asar", readRange)).toBe("1.18.15");
        expect(readRange).toHaveBeenCalledTimes(6);

        readRange.mockImplementationOnce((_path, offset, maximumBytes) => ({
            bytes: new Uint8Array(archive.subarray(offset, offset + maximumBytes)),
            byteOffset: offset,
            totalBytes: archive.byteLength,
            executable: false,
            identity: { ...identity, fileId: "changed" },
        }));
        expect(readOpencodeAppVersion("C:\\owned\\app.asar", readRange)).toBeNull();
    });

    it("keeps a readable install non-callable when exact version metadata is invalid", () => {
        const root = path.join(sandbox, "app");
        writeNative(path.join(root, "ai.opencode.desktop"), [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(root, "resources", "app.asar"), "not-an-asar");
        expect(findOpencodeAppInstallation({ OPENCODE_APP_INSTALL_DIR: root }, home, linuxContext(), true)).toMatchObject({
            status: "unknown",
            versionText: "",
            diagnostics: [expect.objectContaining({ code: "opencode_app_version_metadata_unavailable" })],
        });
    });

    it("preserves Electron ASAR mode while inspecting the physical archive", () => {
        const root = path.join(sandbox, "app");
        const executable = path.join(root, "ai.opencode.desktop");
        writeNative(executable, [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(root, "resources", "app.asar"), opencodeAppAsar("1.18.15"));
        const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
        const previousElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
        const previousNoAsar = electronProcess.noAsar;
        if (!Reflect.defineProperty(process.versions, "electron", { configurable: true, value: "fixture" })) {
            throw new Error("fixture could not expose the Electron version marker");
        }
        electronProcess.noAsar = false;
        try {
            expect(inspectOpencodeAppCandidate(executable, false, true)).toMatchObject({ state: "available" });
            expect(electronProcess.noAsar).toBe(false);
        } finally {
            if (previousElectron === undefined) Reflect.deleteProperty(process.versions, "electron");
            else Reflect.defineProperty(process.versions, "electron", previousElectron);
            electronProcess.noAsar = previousNoAsar;
        }
    });

    it("reports incomplete discovery when an in-authority candidate is absent beside an out-of-authority default", () => {
        const root = path.join(sandbox, "missing-app");
        expect(findOpencodeAppInstallation({ OPENCODE_APP_INSTALL_DIR: root }, home, linuxContext(sandbox), true)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_app_install_discovery_incomplete" })],
        });
    });

    it("fails closed for unverified Darwin and out-of-authority declared roots", () => {
        expect(
            findOpencodeAppInstallation(
                {},
                home,
                { platform: "darwin", platformInstanceId: "fixture", accessRootPath: "/" },
                true,
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_app_install_rules_unverified" })],
        });
        expect(
            findOpencodeAppInstallation(
                { OPENCODE_APP_INSTALL_DIR: path.join(sandbox, "outside") },
                home,
                linuxContext(home),
                true,
            ),
        ).toMatchObject({ status: "unknown" });
    });
});

function windowsContext(accessRootPath = "/"): PlatformContext {
    return { platform: "win32", platformInstanceId: "fixture", accessRootPath };
}

function linuxContext(accessRootPath = "/"): PlatformContext {
    return { platform: "linux", platformInstanceId: "fixture", accessRootPath };
}

function writeNative(targetPath: string, magic: number[]): void {
    writeFile(targetPath, Buffer.from(magic));
    fs.chmodSync(targetPath, 0o755);
}

function writeFile(targetPath: string, bytes: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, bytes);
}
