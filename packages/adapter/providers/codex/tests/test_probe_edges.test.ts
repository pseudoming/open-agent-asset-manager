import type { PlatformContext } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    inspectCodexPath,
    makeCodexResource,
    makeCodexUserRoot,
    stableCodexId,
    uniqueSortedStrings,
} from "../src/codex-probe-foundation";
import { findCodexAppInstallation, findCodexCliInstallation } from "../src/codex-probe-installation";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-probe-edges-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Codex probe mechanics", () => {
    it("uses one user-selected CLI folder and does not borrow an unrelated PATH installation", async () => {
        const selectedRoot = path.join(sandbox, "selected-codex");
        const emptyRoot = path.join(sandbox, "empty-codex");
        writeMagic(path.join(selectedRoot, "codex"), [0x7f, 0x45, 0x4c, 0x46]);
        writeMagic(path.join(bin, "codex"), [0x7f, 0x45, 0x4c, 0x46]);
        fs.mkdirSync(emptyRoot);

        expect(await findCodexCliInstallation({ PATH: bin }, home, linuxContext(), selectedRoot)).toMatchObject({
            status: "available",
            evidence: [expect.objectContaining({ path: path.join(selectedRoot, "codex") })],
        });
        expect(await findCodexCliInstallation({ PATH: bin }, home, linuxContext(), emptyRoot)).toMatchObject({
            status: "not_found",
            evidence: [expect.objectContaining({ path: path.join(emptyRoot, "codex") })],
        });
    });

    it("classifies stable, missing, wrong-kind, symlink, and invalid source paths", () => {
        const file = path.join(sandbox, "file");
        const directory = path.join(sandbox, "directory");
        const link = path.join(sandbox, "link");
        fs.writeFileSync(file, "fixture");
        fs.mkdirSync(directory);
        fs.symlinkSync(directory, link);

        expect(inspectCodexPath(file, "file")).toEqual({ accessStatus: "available", diagnostics: [] });
        expect(inspectCodexPath(directory, "directory")).toEqual({ accessStatus: "available", diagnostics: [] });
        expect(inspectCodexPath(file, "directory")).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_probe_resource_kind_mismatch" })],
        });
        expect(inspectCodexPath(link, "directory")).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_probe_symlink_untrusted" })],
        });
        expect(inspectCodexPath(path.join(sandbox, "missing"), "file")).toEqual({
            accessStatus: "not_found",
            diagnostics: [],
        });
        expect(inspectCodexPath("\0", "file")).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_probe_io_error" })],
        });
    });

    it("builds deterministic user roots, declared resources, and sorted unique values", () => {
        const directory = path.join(sandbox, "source");
        const config = path.join(sandbox, "config.toml");
        fs.mkdirSync(directory);
        fs.writeFileSync(config, "fixture");
        const root = makeCodexUserRoot(directory, "source", "external_managed", "selected");
        const resource = makeCodexResource(
            { path: config, locatorKind: "runtime_declared_path", locatorKey: "CODEX_HOME:config.toml" },
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
            locatorEvidence: [expect.objectContaining({ evidenceLevel: "user_provided" })],
        });
        expect(stableCodexId("x", "y")).toMatch(/^x:[0-9a-f]{64}$/u);
        expect(uniqueSortedStrings(["b", "a", "b"])).toEqual(["a", "b"]);
    });

    it("returns trusted clean absence and resolves only an in-root native symlink", async () => {
        const context = linuxContext();
        const missing = await findCodexCliInstallation({ PATH: "" }, home, context);
        expect(missing).toMatchObject({ status: "not_found", diagnostics: [] });
        expect(missing.evidence).toEqual([expect.objectContaining({ path: path.join(home, ".local", "bin", "codex") })]);

        const native = path.join(sandbox, "native-codex");
        writeMagic(native, [0x7f, 0x45, 0x4c, 0x46]);
        fs.symlinkSync(native, path.join(bin, "codex"));
        const linked = await findCodexCliInstallation({ PATH: bin }, home, context);
        expect(linked).toMatchObject({ status: "available" });
        expect(linked.evidence).toEqual([expect.objectContaining({ path: native })]);

        fs.rmSync(path.join(bin, "codex"));
        fs.symlinkSync(path.join(sandbox, "missing-native"), path.join(bin, "codex"));
        expect(await findCodexCliInstallation({ PATH: bin }, home, context)).toMatchObject({ status: "unknown" });
    });

    it("treats an ENOTDIR candidate as checked absence and an escaping PATH candidate as incomplete discovery", async () => {
        const blockedHome = path.join(sandbox, "blocked-home");
        fs.mkdirSync(blockedHome);
        fs.writeFileSync(path.join(blockedHome, ".local"), "not a directory");
        expect(await findCodexCliInstallation({ PATH: "" }, blockedHome, linuxContext())).toMatchObject({
            status: "not_found",
        });

        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        fs.mkdirSync(selectedHome, { recursive: true });
        expect(
            await findCodexCliInstallation({ PATH: bin }, selectedHome, {
                platform: "linux",
                platformInstanceId: "fixture",
                accessRootPath: selectedRoot,
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_install_discovery_incomplete" })],
        });
    });

    it("rejects wrong CLI entry types, non-executable binaries, short files, and foreign PATH entries", async () => {
        const context = linuxContext();
        fs.mkdirSync(path.join(bin, "codex"));
        expect(await findCodexCliInstallation({ PATH: bin }, home, context)).toMatchObject({ status: "not_found" });

        fs.rmSync(path.join(bin, "codex"), { recursive: true });
        fs.writeFileSync(path.join(bin, "codex"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o644 });
        expect(await findCodexCliInstallation({ PATH: bin }, home, context)).toMatchObject({ status: "not_found" });

        fs.rmSync(path.join(bin, "codex"));
        fs.writeFileSync(path.join(bin, "codex"), Buffer.from([0x7f]), { mode: 0o755 });
        expect(await findCodexCliInstallation({ PATH: bin }, home, context)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_launcher_not_native" })],
        });

        expect(await findCodexCliInstallation({ PATH: "relative" }, home, context)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_install_discovery_incomplete" })],
        });
        expect(await findCodexCliInstallation({ PATH: "" }, "relative", context)).toMatchObject({
            status: "unknown",
        });
    });

    it("recognizes every supported Mach-O/fat magic and the Path fallback", async () => {
        const magics = [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
            [0xbe, 0xba, 0xfe, 0xca],
            [0xca, 0xfe, 0xba, 0xbf],
            [0xbf, 0xba, 0xfe, 0xca],
        ];
        const context: PlatformContext = { platform: "darwin", platformInstanceId: "fixture", accessRootPath: "/" };
        for (const magic of magics) {
            writeMagic(path.join(bin, "codex"), magic);
            expect((await findCodexCliInstallation({ Path: bin }, home, context)).status).toBe("available");
        }
    });

    it("covers clean, invalid, untrusted, and non-native Windows App roots", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");

        expect(findCodexAppInstallation({}, home, context)).toMatchObject({ status: "not_found" });
        expect(
            findCodexAppInstallation({ LOCALAPPDATA: path.join(sandbox, "foreign") }, home, windowsContext(home)),
        ).toMatchObject({ status: "unknown" });
        expect(findCodexAppInstallation({}, "relative", context)).toMatchObject({ status: "unknown" });

        fs.mkdirSync(binRoot, { recursive: true });
        expect(findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "not_found",
        });
        fs.rmSync(binRoot, { recursive: true });

        fs.mkdirSync(path.dirname(binRoot), { recursive: true });
        fs.writeFileSync(binRoot, "wrong kind");
        expect(findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "unknown",
        });

        fs.rmSync(binRoot);
        const realBin = path.join(sandbox, "real-bin");
        fs.mkdirSync(realBin);
        fs.symlinkSync(realBin, binRoot);
        expect(findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "unknown",
        });

        fs.rmSync(binRoot);
        fs.mkdirSync(path.join(binRoot, "build"), { recursive: true });
        writeMagic(path.join(binRoot, "build", "codex.exe"), [0x7f, 0x45, 0x4c, 0x46]);
        expect(findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_app_executable_not_native" })],
        });
    });

    it("treats an ENOTDIR App install root as checked absence", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const codexParent = path.join(localAppData, "OpenAI", "Codex");
        fs.mkdirSync(path.dirname(codexParent), { recursive: true });
        fs.writeFileSync(codexParent, "not a directory");

        expect(findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context)).toMatchObject({
            status: "not_found",
        });
    });

    it("ignores unrelated App build entries and selects the stable last verified build", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
        fs.mkdirSync(binRoot, { recursive: true });
        fs.writeFileSync(path.join(binRoot, "README"), "fixture");
        fs.mkdirSync(path.join(binRoot, "build-missing"));
        fs.mkdirSync(path.join(binRoot, "build-dir", "codex.exe"), { recursive: true });
        const target = path.join(sandbox, "linked-app.exe");
        writeMagic(target, [0x4d, 0x5a]);
        fs.mkdirSync(path.join(binRoot, "build-link"));
        fs.symlinkSync(target, path.join(binRoot, "build-link", "codex.exe"));
        writeMagic(path.join(binRoot, "build-a", "codex.exe"), [0x4d, 0x5a]);
        const selected = path.join(binRoot, "build-z", "codex.exe");
        writeMagic(selected, [0x4d, 0x5a]);

        const result = findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context);
        expect(result).toMatchObject({ status: "available" });
        expect(result.evidence.at(-1)).toMatchObject({ path: selected });
    });

    it("uses a bounded explicit App binary root without exposing the ordinary LocalAppData profile", () => {
        const context = windowsContext();
        const isolatedLocalAppData = path.join(home, "isolated", "AppData", "Local");
        const binRoot = path.join(home, "external-install", "OpenAI", "Codex", "bin");
        const selected = path.join(binRoot, "build-current", "codex.exe");
        writeMagic(selected, [0x4d, 0x5a]);

        expect(
            findCodexAppInstallation({ CODEX_APP_BIN_ROOT: binRoot, LOCALAPPDATA: isolatedLocalAppData }, home, context),
        ).toMatchObject({
            status: "available",
            evidence: [
                expect.objectContaining({ kind: "install_root", path: binRoot }),
                expect.objectContaining({ kind: "executable", path: selected }),
            ],
        });
        expect(fs.existsSync(path.join(isolatedLocalAppData, "OpenAI", "Codex", "bin"))).toBe(false);
        expect(
            findCodexAppInstallation(
                { CODEX_APP_BIN_ROOT: path.join(sandbox, "outside"), LOCALAPPDATA: isolatedLocalAppData },
                home,
                windowsContext(home),
            ),
        ).toMatchObject({ status: "unknown", diagnostics: [expect.objectContaining({ code: "codex_app_bin_root_invalid" })] });
    });

    it("accepts an exact selected App build folder without requiring its parent inventory", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const selectedRoot = path.join(sandbox, "0.148.0-alpha.9");
        const selected = path.join(selectedRoot, "codex.exe");
        writeMagic(selected, [0x4d, 0x5a]);

        expect(findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context, selectedRoot)).toMatchObject({
            status: "available",
            evidence: [
                expect.objectContaining({ kind: "install_root", path: selectedRoot }),
                expect.objectContaining({ kind: "executable", path: selected }),
            ],
        });
    });

    it("fails a bounded App build inventory instead of silently truncating it", () => {
        const context = windowsContext();
        const localAppData = path.join(home, "AppData", "Local");
        const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
        for (let index = 0; index < 129; index += 1) fs.mkdirSync(path.join(binRoot, `build-${index}`), { recursive: true });
        const result = findCodexAppInstallation({ LOCALAPPDATA: localAppData }, home, context);
        expect(result).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_app_install_io_error" })],
        });
    });
});

function linuxContext(): PlatformContext {
    return { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" };
}

function windowsContext(accessRootPath = "/"): PlatformContext {
    return { platform: "win32", platformInstanceId: "fixture", accessRootPath };
}

function writeMagic(target: string, bytes: number[]): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o755 });
}
