import { readDirectoryEntriesBounded } from "@oaam/shared/filesystem";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    findClaudeCodeAppInstallation,
    findClaudeCodeAppInstallationForTest,
    parseAppxIdentity,
    parseRegisteredPackageInventory,
    resolveClaudeCodeAppxProcessEnvironmentForTest,
} from "../src/claudecode-probe-app-installation";

const PUBLISHER =
    "CN=&quot;Anthropic, PBC&quot;, O=&quot;Anthropic, PBC&quot;, L=San Francisco, S=California, C=US, SERIALNUMBER=4860621, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US";

let sandbox = "";
let home = "";
let localAppData = "";
let programFiles = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claude-app-install-"));
    home = path.join(sandbox, "home");
    localAppData = path.join(home, "AppData", "Local");
    programFiles = path.join(sandbox, "Program Files");
    fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Claude Code App installation discovery", () => {
    it("returns checked absence and rejects invalid or unselected roots", async () => {
        expect(await findApp()).toMatchObject({ status: "not_found", versionText: "", appVersionText: "" });
        expect(await findClaudeCodeAppInstallation({}, home, { ...context(), platform: "linux" })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_linux_root_outside_selection" })],
        });
        expect(await findClaudeCodeAppInstallation({}, "relative", context())).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_home_invalid" })],
        });
        expect(
            await findClaudeCodeAppInstallation(
                { LOCALAPPDATA: path.join(sandbox, "outside"), ProgramFiles: programFiles },
                home,
                context(home),
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_install_root_invalid" })],
        });
    });

    it("selects the newest exact AppX and App-owned Code engine", async () => {
        createPackage("1.24011.1.0");
        const selectedPackage = createPackage("1.24012.9.0");
        createEngine("2.1.218");
        const selectedEngine = createEngine("2.1.219");

        expect(await findApp()).toEqual({
            status: "available",
            evidence: [
                { kind: "install_root", path: selectedPackage, evidenceLevel: "local_artifact", diagnostics: [] },
                {
                    kind: "install_root",
                    path: path.dirname(selectedEngine),
                    evidenceLevel: "local_artifact",
                    diagnostics: [],
                },
                { kind: "executable", path: selectedEngine, evidenceLevel: "agent_runtime_verified", diagnostics: [] },
            ],
            diagnostics: [],
            versionText: "2.1.219",
            appVersionText: "1.24012.9.0",
        });
    });

    it("uses an explicit App-owned engine root while the ordinary LocalAppData profile stays isolated", async () => {
        const selectedPackage = createPackage("1.24012.9.0");
        const externalLocalAppData = path.join(home, "external-install");
        const externalEngineRoot = path.join(externalLocalAppData, "Claude-3p", "claude-code");
        const selectedEngine = createEngine("2.1.219", { localAppData: externalLocalAppData });
        const isolatedLocalAppData = path.join(home, "isolated", "AppData", "Local");

        await expect(
            findClaudeCodeAppInstallation(
                {
                    CLAUDE_CODE_APP_ENGINE_ROOT: externalEngineRoot,
                    LOCALAPPDATA: isolatedLocalAppData,
                    ProgramFiles: programFiles,
                },
                home,
                context(),
            ),
        ).resolves.toMatchObject({
            status: "available",
            evidence: expect.arrayContaining([
                expect.objectContaining({ path: selectedPackage }),
                expect.objectContaining({ path: selectedEngine }),
            ]),
            versionText: "2.1.219",
        });
        expect(fs.existsSync(path.join(isolatedLocalAppData, "Claude-3p", "claude-code"))).toBe(false);
    });

    it("validates a selected App package, engine, or common parent without borrowing ordinary install roots", async () => {
        const selectedPackage = createPackage("1.24012.9.0");
        const packageEngine = path.join(selectedPackage, "2.1.219", "claude.exe");
        writePe(packageEngine);
        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                selectedPackage,
            ),
        ).resolves.toMatchObject({
            status: "available",
            versionText: "2.1.219",
            appVersionText: "1.24012.9.0",
            evidence: expect.arrayContaining([
                expect.objectContaining({ path: selectedPackage }),
                expect.objectContaining({ path: packageEngine }),
            ]),
        });

        const selectedEngine = path.join(sandbox, "2.1.220");
        const engineExecutable = path.join(selectedEngine, "claude.exe");
        const nestedPackage = path.join(selectedEngine, "Claude_1.24013.1.0_x64__pzs8sxrjxfjjc");
        writePe(engineExecutable);
        fs.mkdirSync(path.join(nestedPackage, "app"), { recursive: true });
        fs.writeFileSync(path.join(nestedPackage, "AppxManifest.xml"), manifest("1.24013.1.0"));
        writePe(path.join(nestedPackage, "app", "Claude.exe"));
        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                selectedEngine,
            ),
        ).resolves.toMatchObject({
            status: "available",
            versionText: "2.1.220",
            appVersionText: "1.24013.1.0",
        });

        const empty = path.join(sandbox, "selected-empty");
        fs.mkdirSync(empty);
        await expect(
            findClaudeCodeAppInstallation({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, home, context(), empty),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_selected_install_root_unverified" })],
        });

        const deniedSelected = path.join(sandbox, "selected-denied");
        fs.mkdirSync(deniedSelected);
        await expect(
            findClaudeCodeAppInstallationForTest(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                { readDirectoryEntries: readWithFailure(deniedSelected, "EACCES") },
                deniedSelected,
            ),
        ).resolves.toMatchObject({
            status: "needs_permission",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_inventory_failed" })],
        });
        await expect(
            findClaudeCodeAppInstallation(
                {
                    LOCALAPPDATA: path.join(home, "AppData", "Local"),
                    ProgramFiles: path.join(home, "Program Files"),
                },
                home,
                context(home),
                selectedEngine,
            ),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_selected_install_root_invalid" })],
        });

        const packageOnly = path.join(sandbox, "Claude_1.24014.0.0_x64__pzs8sxrjxfjjc");
        fs.mkdirSync(path.join(packageOnly, "app"), { recursive: true });
        fs.writeFileSync(path.join(packageOnly, "AppxManifest.xml"), manifest("1.24014.0.0"));
        writePe(path.join(packageOnly, "app", "Claude.exe"));
        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                packageOnly,
            ),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_install_incomplete" })],
        });

        const engineOnly = path.join(sandbox, "2.1.222");
        writePe(path.join(engineOnly, "claude.exe"));
        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                engineOnly,
            ),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_install_incomplete" })],
        });

        const invalidPackage = path.join(sandbox, "Claude_1.24014.1.0_x64__pzs8sxrjxfjjc");
        fs.mkdirSync(invalidPackage);
        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                invalidPackage,
            ),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_selected_package_invalid" })],
        });

        const invalidEngine = path.join(sandbox, "2.1.221");
        fs.mkdirSync(invalidEngine);
        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                invalidEngine,
            ),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_selected_engine_invalid" })],
        });
    });

    it("selects deterministically between numerically equal engine versions inside one selected root", async () => {
        const selectedRoot = path.join(sandbox, "selected-tie");
        const selectedPackage = path.join(selectedRoot, "Claude_1.24015.0.0_x64__pzs8sxrjxfjjc");
        fs.mkdirSync(path.join(selectedPackage, "app"), { recursive: true });
        fs.writeFileSync(path.join(selectedPackage, "AppxManifest.xml"), manifest("1.24015.0.0"));
        writePe(path.join(selectedPackage, "app", "Claude.exe"));
        writePe(path.join(selectedRoot, "02.1.219", "claude.exe"));
        const selectedEngine = path.join(selectedRoot, "2.1.219", "claude.exe");
        writePe(selectedEngine);

        await expect(
            findClaudeCodeAppInstallation(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
                home,
                context(),
                selectedRoot,
            ),
        ).resolves.toMatchObject({
            status: "available",
            appVersionText: "1.24015.0.0",
            versionText: "2.1.219",
            evidence: expect.arrayContaining([expect.objectContaining({ path: selectedEngine })]),
        });
    });

    it("uses bounded default roots and ignores unrelated files and directories", async () => {
        const selectedPackage = createPackage("1.24012.9.0");
        const selectedEngine = createEngine("2.1.219");
        fs.writeFileSync(path.join(programFiles, "WindowsApps", "not-a-package.txt"), "ignored");
        fs.mkdirSync(path.join(programFiles, "WindowsApps", "Other_1.0.0.0_x64__publisher"));
        fs.writeFileSync(path.join(localAppData, "Claude-3p", "claude-code", "README.txt"), "ignored");
        fs.mkdirSync(path.join(localAppData, "Claude-3p", "claude-code", "latest"));

        await expect(findClaudeCodeAppInstallation({}, home, context())).resolves.toMatchObject({
            status: "available",
            appVersionText: "1.24012.9.0",
            versionText: "2.1.219",
            evidence: expect.arrayContaining([
                expect.objectContaining({ path: selectedPackage }),
                expect.objectContaining({ path: selectedEngine }),
            ]),
        });
    });

    it("fails closed for incomplete, malformed, linked, non-regular, and over-bounded candidates", async () => {
        createPackage("1.24012.9.0");
        expect(await findApp()).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_install_incomplete" })],
        });

        fs.rmSync(path.join(programFiles, "WindowsApps"), { recursive: true });
        createEngine("2.1.219");
        expect(await findApp()).toMatchObject({ status: "unknown" });

        fs.rmSync(sandbox, { recursive: true });
        fs.mkdirSync(home, { recursive: true });
        createPackage("1.24012.9.0", { publisher: "CN=Imposter" });
        createEngine("2.1.219");
        expect(await findApp()).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_inventory_failed" })],
        });

        fs.rmSync(sandbox, { recursive: true });
        fs.mkdirSync(home, { recursive: true });
        createPackage("1.24012.9.0");
        const engine = createEngine("2.1.219");
        fs.rmSync(engine);
        fs.mkdirSync(engine);
        expect(await findApp()).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_engine_inventory_failed" })],
        });
        fs.rmSync(engine, { recursive: true });
        const foreign = path.join(sandbox, "foreign.exe");
        writePe(foreign);
        fs.symlinkSync(foreign, engine);
        expect(await findApp()).toMatchObject({ status: "unknown" });

        fs.rmSync(path.join(localAppData, "Claude-3p", "claude-code"), { recursive: true });
        const engineRoot = path.join(localAppData, "Claude-3p", "claude-code");
        for (let index = 0; index < 129; index += 1) fs.mkdirSync(path.join(engineRoot, `ignore-${index}`), { recursive: true });
        expect(await findApp()).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_engine_inventory_failed" })],
        });
    });

    it("rejects oversized or malformed manifests and unexpected package identities", async () => {
        const cases = [
            manifest("1.24012.9.0").replace('Name="Claude"', 'Name="Other"'),
            manifest("1.24012.9.0").replace('ProcessorArchitecture="x64"', 'ProcessorArchitecture="arm64"'),
            manifest("1.24012.9.0").replace('Version="1.24012.9.0"', 'Version="1.0.0.0"'),
            manifest("1.24012.9.0").replace("<Identity", "<Identity Name=broken"),
            manifest("1.24012.9.0").replace(
                "</Package>",
                `${manifest("1.24012.9.0").match(/<Identity[\s\S]*?\/>/u)?.[0]}</Package>`,
            ),
            `${"x".repeat(256 * 1024)}x`,
        ];
        for (const [index, text] of cases.entries()) {
            resetRoots();
            createPackage("1.24012.9.0", { manifestText: text });
            createEngine("2.1.219");
            expect(await findApp(), `case ${index}`).toMatchObject({
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "claudecode_app_package_inventory_failed" })],
            });
        }
    });

    it("uses the fixed registration query only when the protected WindowsApps inventory is permission denied", async () => {
        const selectedPackage = createPackage("1.24012.9.0");
        const selectedEngine = createEngine("2.1.219");
        let queryCount = 0;
        const result = await findClaudeCodeAppInstallationForTest(
            { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
            home,
            context(),
            {
                readDirectoryEntries(root, maximumEntries) {
                    if (root === path.join(programFiles, "WindowsApps"))
                        throw Object.assign(new Error("denied"), { code: "EACCES" });
                    return readDirectoryEntriesBounded(root, maximumEntries);
                },
                inspectExecutable() {
                    return { deviceId: "fixture-device", fileId: "fixture-file", entryKind: "file" };
                },
                resolvePackageQueryEnvironment: testPackageQueryEnvironment,
                async invokeExecutableTree(input) {
                    queryCount += 1;
                    expect(input.arguments).toEqual([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        expect.stringContaining("Get-AppxPackage -Name 'Claude'"),
                    ]);
                    expect(input.environmentVariableNames).toEqual(
                        expect.arrayContaining(["ProgramData", "SystemDrive", "SystemRoot", "WINDIR"]),
                    );
                    return registeredQueryInvocation(selectedPackage);
                },
            },
        );
        expect(queryCount).toBe(1);
        expect(result).toMatchObject({
            status: "available",
            versionText: "2.1.219",
            appVersionText: "1.24012.9.0",
            evidence: expect.arrayContaining([
                expect.objectContaining({ kind: "executable", path: selectedEngine, evidenceLevel: "agent_runtime_verified" }),
            ]),
        });

        const denied = await findClaudeCodeAppInstallationForTest(
            { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
            home,
            context(),
            {
                readDirectoryEntries(root, maximumEntries) {
                    if (root === path.join(programFiles, "WindowsApps"))
                        throw Object.assign(new Error("denied"), { code: "EACCES" });
                    return readDirectoryEntriesBounded(root, maximumEntries);
                },
                inspectExecutable() {
                    return { deviceId: "fixture-device", fileId: "fixture-file", entryKind: "file" };
                },
                resolvePackageQueryEnvironment: testPackageQueryEnvironment,
                async invokeExecutableTree() {
                    return {
                        status: "failed" as const,
                        exitCode: 1,
                        signal: null,
                        stdout: new Uint8Array(),
                        stderr: new Uint8Array(),
                        rootProcess: null,
                        observedProcesses: [],
                        cleanupComplete: true,
                        invocationTokenAbsent: true,
                        failureCode: "exit",
                        executableSha256: `sha256:${"0".repeat(64)}` as const,
                    };
                },
            },
        );
        expect(denied).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_registration_query_failed" })],
        });
    });

    it("derives SystemDrive from one trusted SystemRoot and requires exact ProgramData", () => {
        const platformContext = {
            platform: "win32" as const,
            platformInstanceId: "windows",
            accessRootPath: "C:\\",
        };
        expect(
            resolveClaudeCodeAppxProcessEnvironmentForTest(
                { SystemRoot: String.raw`C:\Windows`, ProgramData: String.raw`C:\ProgramData` },
                String.raw`C:\Windows`,
                platformContext,
            ),
        ).toMatchObject({
            SystemDrive: "C:",
            SystemRoot: String.raw`C:\Windows`,
            WINDIR: String.raw`C:\Windows`,
            ProgramData: String.raw`C:\ProgramData`,
        });

        for (const environment of [
            { SystemDrive: "D:", ProgramData: String.raw`C:\ProgramData` },
            { SystemDrive: "%SystemDrive%", ProgramData: String.raw`C:\ProgramData` },
            { SystemRoot: String.raw`D:\Windows`, ProgramData: String.raw`C:\ProgramData` },
            { WINDIR: String.raw`D:\Windows`, ProgramData: String.raw`C:\ProgramData` },
            {},
            { ProgramData: String.raw`D:\ProgramData` },
            { ProgramData: String.raw`C:\Windows\..\ProgramData` },
            { ProgramData: String.raw`C:\ProgramData`, PROGRAMDATA: String.raw`C:\Other` },
            { ProgramData: "%SystemDrive%\\ProgramData" },
        ]) {
            expect(
                resolveClaudeCodeAppxProcessEnvironmentForTest(environment, String.raw`C:\Windows`, platformContext),
            ).toBeNull();
        }
    });

    it("keeps inventory and fixed registration-query failures distinct and fail closed", async () => {
        createEngine("2.1.219");
        const windowsAppsRoot = path.join(programFiles, "WindowsApps");
        const engineRoot = path.join(localAppData, "Claude-3p", "claude-code");
        const inspectExecutable = () => ({ deviceId: "fixture-device", fileId: "fixture-file", entryKind: "file" as const });

        await expect(
            findClaudeCodeAppInstallationForTest({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, home, context(), {
                readDirectoryEntries: readWithFailure(engineRoot, "EACCES"),
            }),
        ).resolves.toMatchObject({
            status: "needs_permission",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_engine_inventory_failed" })],
        });
        await expect(
            findClaudeCodeAppInstallationForTest({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, home, context(), {
                readDirectoryEntries: readWithFailure(windowsAppsRoot, "EIO"),
            }),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_inventory_failed" })],
        });
        await expect(
            findClaudeCodeAppInstallationForTest(
                { LOCALAPPDATA: localAppData, ProgramFiles: programFiles, SystemRoot: path.dirname(sandbox) },
                home,
                context(),
                { readDirectoryEntries: readWithFailure(windowsAppsRoot, "EACCES"), inspectExecutable },
            ),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_registration_query_invalid" })],
        });

        const environmentRejectedInvocation = vi.fn();
        await expect(
            findClaudeCodeAppInstallationForTest({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, home, context(), {
                readDirectoryEntries: readWithFailure(windowsAppsRoot, "EACCES"),
                inspectExecutable,
                invokeExecutableTree: environmentRejectedInvocation,
                resolvePackageQueryEnvironment: () => null,
            }),
        ).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_registration_environment_invalid" })],
        });
        expect(environmentRejectedInvocation).not.toHaveBeenCalled();

        const registrationCases = [
            async () => {
                throw new Error("query failed before output");
            },
            async () => ({ ...registeredQueryInvocation("unused"), stdout: new TextEncoder().encode("not-json") }),
            async () => ({ ...registeredQueryInvocation("unused"), cleanupComplete: false }),
        ];
        for (const invokeExecutableTree of registrationCases) {
            await expect(
                findClaudeCodeAppInstallationForTest(
                    {
                        LOCALAPPDATA: localAppData,
                        ProgramFiles: programFiles,
                        SystemRoot: path.join(sandbox, "Windows"),
                    },
                    home,
                    context(),
                    {
                        readDirectoryEntries: readWithFailure(windowsAppsRoot, "EACCES"),
                        inspectExecutable,
                        resolvePackageQueryEnvironment: testPackageQueryEnvironment,
                        invokeExecutableTree,
                    },
                ),
            ).resolves.toMatchObject({
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "claudecode_app_package_registration_query_failed" })],
            });
        }
    });

    it("strictly validates the bounded AppX registration projection before opening the exact package", () => {
        const selectedPackage = createPackage("1.24012.9.0");
        const windowsAppsRoot = path.join(programFiles, "WindowsApps");
        const record = registrationRecord(selectedPackage);
        expect(parseRegisteredPackageInventory(JSON.stringify([record]), windowsAppsRoot, context())).toEqual([selectedPackage]);
        expect(parseRegisteredPackageInventory("[]", windowsAppsRoot, context())).toEqual([]);
        const invalid = [
            null,
            { ...record, Name: "Other" },
            { ...record, PackageFullName: "Claude_1.24012.8.0_x64__pzs8sxrjxfjjc" },
            { ...record, InstallLocation: path.join(sandbox, "elsewhere", path.basename(selectedPackage)) },
            { ...record, Architecture: 11 },
            { ...record, PublisherId: "other" },
            { ...record, Status: 1 },
            { ...record, Version: "1.24012.8.0" },
            { ...record, Extra: "accepted-but-irrelevant" },
        ];
        for (const value of invalid) {
            expect(() => parseRegisteredPackageInventory(JSON.stringify([value]), windowsAppsRoot, context())).toThrow();
        }
        expect(() => parseRegisteredPackageInventory("not-json", windowsAppsRoot, context())).toThrow();
        expect(() =>
            parseRegisteredPackageInventory(JSON.stringify(Array.from({ length: 17 }, () => record)), windowsAppsRoot, context()),
        ).toThrow(/exceeds/u);

        expect(parseRegisteredPackageInventory(JSON.stringify(record), windowsAppsRoot, context())).toEqual([selectedPackage]);
        const differentlyCasedLocation = path.join(path.dirname(windowsAppsRoot), "windowsapps", path.basename(selectedPackage));
        expect(
            parseRegisteredPackageInventory(
                JSON.stringify({ ...record, InstallLocation: differentlyCasedLocation }),
                windowsAppsRoot,
                context(),
            ),
        ).toEqual([differentlyCasedLocation]);
        expect(() =>
            parseRegisteredPackageInventory(
                JSON.stringify({ ...record, InstallLocation: differentlyCasedLocation }),
                windowsAppsRoot,
                { ...context(), platform: "linux" },
            ),
        ).toThrow(/outside/u);
        for (const [Architecture, Status] of [
            ["X64", "Ok"],
            ["x64", "OK"],
        ]) {
            expect(
                parseRegisteredPackageInventory(JSON.stringify({ ...record, Architecture, Status }), windowsAppsRoot, context()),
            ).toEqual([selectedPackage]);
        }
        for (const value of [
            { ...record, Name: "" },
            { ...record, Name: " Claude" },
            { ...record, InstallLocation: 42 },
            { ...record, PublisherId: null },
        ]) {
            expect(() => parseRegisteredPackageInventory(JSON.stringify(value), windowsAppsRoot, context())).toThrow();
        }
    });

    it("parses one canonical Identity element and rejects duplicate or stray attributes", () => {
        expect(parseAppxIdentity(manifest("1.24012.9.0"))).toMatchObject({
            Name: "Claude",
            ProcessorArchitecture: "x64",
            Publisher: PUBLISHER,
            Version: "1.24012.9.0",
        });
        expect(() => parseAppxIdentity("<Package />")).toThrow(/one self-closing Identity/u);
        expect(() => parseAppxIdentity('<Identity Name="Claude" Name="Other" />')).toThrow(/duplicate/u);
        expect(() => parseAppxIdentity('<Identity Name="Claude" broken />')).toThrow(/malformed/u);
        expect(parseAppxIdentity(manifest("1.24012.9.0").replaceAll('="', "='").replaceAll('"', "'"))).toMatchObject({
            Name: "Claude",
            Version: "1.24012.9.0",
        });
    });

    it("requires regular no-follow executable identities for both package and engine candidates", async () => {
        const packageRoot = createPackage("1.24012.9.0");
        const packageExecutable = path.join(packageRoot, "app", "Claude.exe");
        fs.rmSync(packageExecutable);
        fs.mkdirSync(packageExecutable);
        createEngine("2.1.219");
        await expect(findApp()).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_package_inventory_failed" })],
        });

        resetRoots();
        createPackage("1.24012.9.0");
        const engine = createEngine("2.1.219");
        fs.rmSync(engine);
        fs.mkdirSync(engine);
        await expect(findApp()).resolves.toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_engine_inventory_failed" })],
        });
    });
});

function findApp() {
    return findClaudeCodeAppInstallation({ LOCALAPPDATA: localAppData, ProgramFiles: programFiles }, home, context());
}

function registrationRecord(packageRoot: string): Record<string, unknown> {
    return {
        Name: "Claude",
        PackageFullName: path.basename(packageRoot),
        InstallLocation: packageRoot,
        Version: "1.24012.9.0",
        Architecture: 9,
        PublisherId: "pzs8sxrjxfjjc",
        Status: 0,
    };
}

function registeredQueryInvocation(packageRoot: string) {
    return {
        status: "complete" as const,
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode(JSON.stringify([registrationRecord(packageRoot)])),
        stderr: new Uint8Array(),
        rootProcess: { processId: 42, lifecycleToken: "fixture-lifecycle" },
        observedProcesses: [{ processId: 42, lifecycleToken: "fixture-lifecycle" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: `sha256:${"0".repeat(64)}` as const,
    };
}

function context(accessRootPath = sandbox) {
    return { platform: "win32" as const, platformInstanceId: "fixture", accessRootPath };
}

function testPackageQueryEnvironment(environment: NodeJS.ProcessEnv, systemRoot: string): NodeJS.ProcessEnv {
    return {
        ...environment,
        ProgramData: path.join(sandbox, "ProgramData"),
        SystemDrive: "/",
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
    };
}

function createPackage(version: string, overrides: { publisher?: string; manifestText?: string } = {}): string {
    const root = path.join(programFiles, "WindowsApps", `Claude_${version}_x64__pzs8sxrjxfjjc`);
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.writeFileSync(
        path.join(root, "AppxManifest.xml"),
        overrides.manifestText ?? manifest(version, overrides.publisher ?? PUBLISHER),
    );
    writePe(path.join(root, "app", "Claude.exe"));
    return root;
}

function createEngine(version: string, options: { localAppData?: string } = {}): string {
    const executable = path.join(options.localAppData ?? localAppData, "Claude-3p", "claude-code", version, "claude.exe");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, Buffer.from([0x4d, 0x5a, 0, 0]));
    return executable;
}

function writePe(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from([0x4d, 0x5a, 0, 0]));
}

function readWithFailure(failedRoot: string, code: string) {
    return (root: string, maximumEntries: number) => {
        if (root === failedRoot) throw Object.assign(new Error(code), { code });
        return readDirectoryEntriesBounded(root, maximumEntries);
    };
}

function manifest(version: string, publisher = PUBLISHER): string {
    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<Package>",
        "  <Identity",
        '    Name="Claude"',
        '    ProcessorArchitecture="x64"',
        `    Publisher="${publisher}"`,
        `    Version="${version}" />`,
        "</Package>",
        "",
    ].join("\n");
}

function resetRoots(): void {
    fs.rmSync(programFiles, { recursive: true, force: true });
    fs.rmSync(localAppData, { recursive: true, force: true });
}
