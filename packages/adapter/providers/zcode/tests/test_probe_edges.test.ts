import type { PlatformContext } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZcodeAppVersion } from "../src/zcode-probe-app-asar-version";
import {
    inspectZcodePath,
    makeZcodeResource,
    makeZcodeUserRoot,
    stableZcodeId,
    uniqueSortedStrings,
} from "../src/zcode-probe-foundation";
import { findZcodeAppInstallation, inspectZcodeAppCandidate } from "../src/zcode-probe-installation";
import { zcodeAppAsar } from "./zcode-app-asar-fixture";

let sandbox = "";
let home = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-probe-edges-"));
    home = path.join(sandbox, "home");
    fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode probe mechanics", () => {
    it("accepts only a complete user-selected App folder", () => {
        const selectedRoot = path.join(sandbox, "selected-zcode");
        const emptyRoot = path.join(sandbox, "empty-zcode");
        const context: PlatformContext = { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" };
        writeMagic(path.join(selectedRoot, "zcode"), [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(selectedRoot, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        fs.mkdirSync(emptyRoot);

        expect(findZcodeAppInstallation({}, home, context, selectedRoot)).toMatchObject({
            status: "available",
            versionText: "3.5.3",
            evidence: [expect.objectContaining({ kind: "install_root", path: selectedRoot })],
        });
        expect(findZcodeAppInstallation({}, home, context, emptyRoot)).toMatchObject({
            status: "not_found",
            evidence: [expect.objectContaining({ path: path.join(emptyRoot, "zcode") })],
        });
    });

    it("uses a valid Linux desktop registration and treats a stale registration as absence", () => {
        const context: PlatformContext = { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" };
        const root = path.join(sandbox, "registered-zcode");
        const executable = path.join(root, "zcode");
        const desktopEntry = path.join(home, ".local", "share", "applications", "zcode.desktop");
        writeMagic(executable, [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(root, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        writeFile(desktopEntry, `[Desktop Entry]\nType=Application\nName=ZCode\nExec="${executable}" --open\n`);

        expect(findZcodeAppInstallation({}, home, context)).toMatchObject({
            status: "available",
            versionText: "3.5.3",
            evidence: [expect.objectContaining({ kind: "install_root", path: root })],
        });
        fs.rmSync(executable);
        expect(findZcodeAppInstallation({}, home, context)).toMatchObject({ status: "not_found" });

        writeFile(desktopEntry, `[Desktop Entry]\nType=Application\nName=ZCode\nExec="${executable}" --open\n`);
        expect(
            findZcodeAppInstallation({}, home, {
                platform: "linux",
                platformInstanceId: "mismatched",
                accessRootPath: "C:\\isolated",
            }),
        ).toMatchObject({ status: "unknown" });
    });

    it("rejects ambiguous Linux desktop registrations and accepts only an absolute executable token", () => {
        const context: PlatformContext = { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" };
        const desktopEntry = path.join(home, ".local", "share", "applications", "zcode.desktop");
        const invalid = [
            "Name=ZCode\nExec=/missing/zcode\n",
            "[Desktop Entry]\nName=ZCode\nExec=/missing/zcode\n",
            "[Desktop Entry]\nType=Application\nExec=/missing/zcode\n",
            "[Desktop Entry]\nType=Application\nName=ZCode\n",
            "[Desktop Entry]\nType=Application\nName=ZCode\nExec=relative-zcode\n",
            '[Desktop Entry]\nType=Application\nName=ZCode\nExec="unterminated\n',
            '[Desktop Entry]\nType=Application\nName=ZCode\nExec="C:\\ZCode\\zcode"\n',
            "[Desktop Entry]\nType=Application\nName=ZCode\nExec=/missing\\zcode\n",
            "[Desktop Entry]\nType=Application\nName=ZCode\n[Other]\nExec=/missing/zcode\n",
        ];
        for (const content of invalid) {
            writeFile(desktopEntry, content);
            expect(findZcodeAppInstallation({}, home, context)).toMatchObject({
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "zcode_app_install_discovery_incomplete" })],
            });
        }

        writeFile(desktopEntry, "x".repeat(64 * 1024 + 1));
        expect(findZcodeAppInstallation({}, home, context)).toMatchObject({ status: "unknown" });
        fs.rmSync(desktopEntry);
        fs.mkdirSync(desktopEntry);
        expect(findZcodeAppInstallation({}, home, context)).toMatchObject({ status: "unknown" });

        fs.rmSync(desktopEntry, { recursive: true });
        writeFile(
            desktopEntry,
            `[Desktop Entry]\nType=Application\nName=ZCode\nExec=${path.join(sandbox, "missing-zcode")} --open\n[Other]\nName=Ignored\n`,
        );
        expect(findZcodeAppInstallation({}, home, context)).toMatchObject({ status: "not_found" });
    });

    it("classifies stable, missing, wrong-kind, symlink, and invalid paths", () => {
        const file = path.join(sandbox, "file");
        const directory = path.join(sandbox, "directory");
        const link = path.join(sandbox, "link");
        fs.writeFileSync(file, "fixture");
        fs.mkdirSync(directory);
        fs.symlinkSync(directory, link);
        expect(inspectZcodePath(file, "file")).toEqual({ accessStatus: "available", diagnostics: [] });
        expect(inspectZcodePath(directory, "directory")).toEqual({ accessStatus: "available", diagnostics: [] });
        expect(inspectZcodePath(file, "directory")).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "zcode_probe_resource_kind_mismatch" })],
        });
        expect(inspectZcodePath(link, "directory")).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "zcode_probe_symlink_untrusted" })],
        });
        expect(inspectZcodePath(path.join(sandbox, "missing"), "file")).toEqual({ accessStatus: "not_found", diagnostics: [] });
        expect(inspectZcodePath("\0", "file")).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "zcode_probe_io_error" })],
        });
    });

    it("builds deterministic user roots, declared resources, and sorted unique values", () => {
        const directory = path.join(sandbox, "source");
        const config = path.join(sandbox, "config.json");
        fs.mkdirSync(directory);
        fs.writeFileSync(config, "fixture");
        const root = makeZcodeUserRoot(directory, "source", "external_managed", "selected");
        const resource = makeZcodeResource(
            { path: config, locatorKind: "runtime_declared_path", locatorKey: "ZCODE_DATA_BASE_DIR:config" },
            ["project_registry"],
        );
        expect(root).toMatchObject({
            path: directory,
            accessStatus: "available",
            locatorEvidence: [expect.objectContaining({ evidenceLevel: "user_provided" })],
        });
        expect(resource).toMatchObject({
            path: config,
            accessStatus: "available",
            locatorEvidence: [expect.objectContaining({ evidenceLevel: "source_code" })],
        });
        expect(stableZcodeId("x", "y")).toMatch(/^x:[0-9a-f]{64}$/u);
        expect(uniqueSortedStrings(["b", "a", "b"])).toEqual(["a", "b"]);
    });

    it("returns checked Windows absence and verifies a complete native App fixture", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        expect(findZcodeAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "not_found",
        });

        const root = path.join(localAppData, "Programs", "ZCode");
        writeMagic(path.join(root, "ZCode.exe"), [0x4d, 0x5a]);
        writeFile(path.join(root, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        writeFile(path.join(root, "resources", "glm", "zcode.cjs"), "consumer bundle");
        expect(findZcodeAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "available",
            versionText: "3.5.3",
            evidence: [
                expect.objectContaining({ kind: "install_root" }),
                expect.objectContaining({ kind: "app_bundle", path: path.join(root, "resources", "glm", "zcode.cjs") }),
            ],
        });

        const programFilesRoot = path.join(home, "Program Files");
        const programInstall = path.join(programFilesRoot, "ZCode");
        writeMagic(path.join(programInstall, "ZCode.exe"), [0x4d, 0x5a]);
        writeFile(path.join(programInstall, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        expect(findZcodeAppInstallation({ ProgramFiles: programFilesRoot }, home, context)).toMatchObject({
            status: "available",
            versionText: "3.5.3",
        });
    });

    it("uses a declared Windows install root and rejects incomplete or non-native structure", () => {
        const context = windowsContext();
        const declared = path.join(home, "declared-zcode");
        writeMagic(path.join(declared, "ZCode.exe"), [0x4d, 0x5a]);
        expect(findZcodeAppInstallation({ ZCODE_WINDOWS_APP_INSTALL_DIR: declared }, home, context)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "zcode_app_install_structure_unverified" })],
        });

        writeFile(path.join(declared, "resources", "app.asar"), "archive");
        writeMagic(path.join(declared, "ZCode.exe"), [0x7f, 0x45, 0x4c, 0x46]);
        expect(findZcodeAppInstallation({ ZCODE_WINDOWS_APP_INSTALL_DIR: declared }, home, context)).toMatchObject({
            status: "unknown",
        });
    });

    it("rejects symlink, wrong-kind, and non-executable App candidates", () => {
        const context = windowsContext();
        const declared = path.join(home, "declared-zcode");
        const target = path.join(sandbox, "target.exe");
        writeMagic(target, [0x4d, 0x5a]);
        fs.mkdirSync(declared, { recursive: true });
        fs.symlinkSync(target, path.join(declared, "ZCode.exe"));
        expect(findZcodeAppInstallation({ ZCODE_WINDOWS_APP_INSTALL_DIR: declared }, home, context)).toMatchObject({
            status: "unknown",
        });

        fs.rmSync(path.join(declared, "ZCode.exe"));
        fs.mkdirSync(path.join(declared, "ZCode.exe"));
        expect(findZcodeAppInstallation({ ZCODE_WINDOWS_APP_INSTALL_DIR: declared }, home, context)).toMatchObject({
            status: "unknown",
        });

        fs.rmSync(path.join(declared, "ZCode.exe"), { recursive: true });
        writeMagic(path.join(declared, "ZCode.exe"), [0x7f, 0x45, 0x4c, 0x46]);
        fs.chmodSync(path.join(declared, "ZCode.exe"), 0o644);
        writeFile(path.join(declared, "resources", "app.asar"), "archive");
        expect(inspectZcodeAppCandidate(path.join(declared, "ZCode.exe"), false)).toEqual({ state: "structure_mismatch" });
    });

    it("classifies candidate absence, invalid I/O, native ELF, and untrusted app archives", () => {
        expect(inspectZcodeAppCandidate(path.join(sandbox, "missing"), false)).toEqual({ state: "absent" });
        expect(inspectZcodeAppCandidate("\0", false)).toEqual({ state: "unknown" });

        const root = path.join(sandbox, "linux-app");
        const executable = path.join(root, "zcode");
        writeMagic(executable, [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(root, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        expect(inspectZcodeAppCandidate(executable, false)).toEqual({ state: "available", installRoot: root });

        fs.rmSync(path.join(root, "resources", "app.asar"));
        fs.mkdirSync(path.join(root, "resources", "app.asar"));
        expect(inspectZcodeAppCandidate(executable, false)).toEqual({ state: "structure_mismatch" });
        fs.rmSync(path.join(root, "resources", "app.asar"), { recursive: true });
        const archiveTarget = path.join(sandbox, "archive-target");
        writeFile(archiveTarget, "archive");
        fs.symlinkSync(archiveTarget, path.join(root, "resources", "app.asar"));
        expect(inspectZcodeAppCandidate(executable, false)).toEqual({ state: "structure_mismatch" });
    });

    it("does not claim untrusted optional consumer bundles as exact build evidence", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const root = path.join(localAppData, "Programs", "ZCode");
        writeMagic(path.join(root, "ZCode.exe"), [0x4d, 0x5a]);
        writeFile(path.join(root, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        const consumerTarget = path.join(sandbox, "consumer-target.cjs");
        writeFile(consumerTarget, "consumer bundle");
        fs.mkdirSync(path.join(root, "resources", "glm"), { recursive: true });
        fs.symlinkSync(consumerTarget, path.join(root, "resources", "glm", "zcode.cjs"));

        const result = findZcodeAppInstallation({ LOCALAPPDATA: localAppData }, home, context);
        expect(result.status).toBe("available");
        expect(result.evidence.some((evidence) => evidence.kind === "app_bundle")).toBe(false);
    });

    it("reads only a bounded, integrity-checked ZCode package manifest from the physical ASAR", () => {
        const archive = path.join(sandbox, "app.asar");
        expect(readZcodeAppVersion(path.join(sandbox, "missing.asar"))).toBeNull();
        writeFile(archive, zcodeAppAsar("3.5.3"));
        expect(readZcodeAppVersion(archive)).toBe("3.5.3");

        const invalidArchives = [
            Uint8Array.of(0),
            zcodeAppAsar("not-a-version"),
            zcodeAppAsar("3.5.3", { name: "another-product" }),
            zcodeAppAsar("3.5.3", { productName: "Another Product" }),
            zcodeAppAsar("3.5.3", { zcodeProductFlavor: "development" }),
            zcodeAppAsar("3.5.3", {}, { size: 0 }),
            zcodeAppAsar("3.5.3", {}, { offset: "1" }),
            zcodeAppAsar("3.5.3", {}, { offset: "9999999999999999" }),
            zcodeAppAsar("3.5.3", {}, { integrity: null }),
            zcodeAppAsar("3.5.3", {}, { integrity: { algorithm: "SHA256", hash: "0".repeat(64) } }),
            (() => {
                const bytes = Buffer.from(zcodeAppAsar("3.5.3"));
                bytes.writeUInt32LE(5, 0);
                return bytes;
            })(),
        ];
        for (const invalid of invalidArchives) {
            writeFile(archive, invalid);
            expect(readZcodeAppVersion(archive)).toBeNull();
        }
    });

    it("keeps installation available but partial when ASAR version metadata is invalid", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const root = path.join(localAppData, "Programs", "ZCode");
        writeMagic(path.join(root, "ZCode.exe"), [0x4d, 0x5a]);
        writeFile(path.join(root, "resources", "app.asar"), "not-an-asar");
        writeFile(path.join(root, "resources", "glm", "zcode.cjs"), "consumer bundle");

        expect(findZcodeAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "available",
            versionText: "",
            diagnostics: [expect.objectContaining({ code: "zcode_app_version_metadata_unavailable" })],
        });
    });

    it("fails closed for unverified Darwin and a foreign declared root", () => {
        expect(
            findZcodeAppInstallation({}, home, { platform: "darwin", platformInstanceId: "fixture", accessRootPath: "/" }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "zcode_app_install_rules_unverified" })],
        });
        expect(
            findZcodeAppInstallation(
                { ZCODE_WINDOWS_APP_INSTALL_DIR: path.join(sandbox, "foreign") },
                home,
                windowsContext(home),
            ),
        ).toMatchObject({ status: "unknown" });
        expect(
            findZcodeAppInstallation({}, home, { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" }),
        ).toMatchObject({ status: "not_found" });
        expect(
            findZcodeAppInstallation({}, home, { platform: "wsl", platformInstanceId: "fixture", accessRootPath: "/" }),
        ).toMatchObject({ status: "not_found" });
    });
});

function windowsContext(accessRootPath = "/"): PlatformContext {
    return { platform: "win32", platformInstanceId: "fixture", accessRootPath };
}

function writeMagic(target: string, bytes: number[]): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o755 });
}

function writeFile(target: string, content: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}
