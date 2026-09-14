import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    assembleWindowsSharedTargetPackage,
    expectedWindowsSharedTargetFiles,
    validateWindowsSharedTargetPackage,
    WINDOWS_SHARED_ADDON_PATH,
    WINDOWS_SHARED_COMPILED_STEMS,
    WINDOWS_TARGET_EXPORTS,
} from "./shared-target-package.mjs";

const temporaryRoots: string[] = [];
const COMPILED_EXTENSIONS = [".js", ".js.map", ".d.ts", ".d.ts.map"] as const;

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function createFixture(): { addonPath: string; outputRoot: string; sharedRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-shared-target-package-"));
    temporaryRoots.push(root);
    const sharedRoot = path.join(root, "shared");
    fs.mkdirSync(sharedRoot);
    fs.writeFileSync(
        path.join(sharedRoot, "package.json"),
        `${JSON.stringify({
            name: "@oaam/shared",
            version: "0.1.0",
            description: "fixture",
            license: "MIT",
            type: "commonjs",
            main: "./dist/paths/unix-like/filesystem-target-entry.js",
            types: "./dist/paths/unix-like/filesystem-target-entry.d.ts",
            exports: {
                "./filesystem": {
                    types: "./dist/paths/unix-like/filesystem-target-entry.d.ts",
                    require: "./dist/paths/unix-like/filesystem-target-entry.js",
                    default: "./dist/paths/unix-like/filesystem-target-entry.js",
                },
                "./paths": {
                    types: "./dist/paths/unix-like/path-environment.d.ts",
                    require: "./dist/paths/unix-like/path-environment.js",
                    default: "./dist/paths/unix-like/path-environment.js",
                },
            },
            typesVersions: {
                "*": {
                    filesystem: ["dist/paths/unix-like/filesystem-target-entry.d.ts"],
                    paths: ["dist/paths/unix-like/path-environment.d.ts"],
                },
            },
            dependencies: {},
            engines: { node: ">=22.0.0" },
        })}\n`,
    );
    for (const sourceStem of WINDOWS_SHARED_COMPILED_STEMS) {
        for (const extension of COMPILED_EXTENSIONS) {
            const filePath = path.join(sharedRoot, "dist", ...sourceStem.split("/")) + extension;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(
                filePath,
                extension.endsWith(".map")
                    ? `${JSON.stringify({ version: 3, file: path.basename(filePath, ".map"), sources: [] })}\n`
                    : `${extension === ".js" ? '"use strict";' : "export {};"}\n//# sourceMappingURL=${path.basename(filePath)}.map\n`,
            );
        }
    }
    const addonPath = path.join(root, "oaam_windows_filesystem.node");
    fs.writeFileSync(addonPath, "fixture-addon");

    return {
        addonPath,

        outputRoot: path.join(root, "output"),
        sharedRoot,
    };
}

describe("Windows Shared target package assembly", () => {
    it("assembles the exact Win32 closure without Unix-like code, raw sources or lifecycle scripts", () => {
        const fixture = createFixture();
        const result = assembleWindowsSharedTargetPackage(
            fixture.sharedRoot,
            fixture.addonPath,

            fixture.outputRoot,
        );

        expect(result.files).toEqual(expectedWindowsSharedTargetFiles());
        expect(result.addonPath).toBe(path.join(fixture.outputRoot, ...WINDOWS_SHARED_ADDON_PATH.split("/")));

        expect(validateWindowsSharedTargetPackage(fixture.outputRoot)).toEqual(expectedWindowsSharedTargetFiles());
        const targetManifest = JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, "package.json"), "utf8"));
        expect(targetManifest.scripts).toBeUndefined();
        expect(targetManifest.exports).toEqual(WINDOWS_TARGET_EXPORTS);
        expect(
            fs.readFileSync(path.join(fixture.outputRoot, "dist", "paths", "win32", "filesystem-target-entry.js"), "utf8"),
        ).toContain("sourceMappingURL=filesystem-target-entry.js.map");
        expect(result.files.every((filePath) => !filePath.includes("unix-like") && !/\.(?:cc|h|gyp)$/u.test(filePath))).toBe(
            true,
        );
    });

    it("resolves declarations and both public module entries from the actual target tarball", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-shared-target-consumer-"));
        temporaryRoots.push(root);
        const addonPath = path.join(root, "oaam_windows_filesystem.node");

        const outputRoot = path.join(root, "target-package");
        fs.writeFileSync(addonPath, "fixture-addon");

        const assembled = assembleWindowsSharedTargetPackage(
            path.join(process.cwd(), "packages", "shared"),
            addonPath,

            outputRoot,
        );
        const tarballRoot = path.join(root, "tarball");
        const npmCache = path.join(root, "npm-cache");
        fs.mkdirSync(tarballRoot);
        fs.mkdirSync(npmCache);
        const npmEnvironment = {
            ...process.env,
            npm_config_cache: npmCache,
            npm_config_loglevel: "notice",
            npm_config_update_notifier: "false",
        };
        const packed = spawnSync(
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["pack", "--json", "--pack-destination", tarballRoot, outputRoot],
            { cwd: root, encoding: "utf8", env: npmEnvironment, windowsHide: true },
        );
        expect(packed.error, packed.error?.message).toBeUndefined();
        expect(packed.status, packed.stderr).toBe(0);
        const packReceipt = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
        expect(packReceipt).toHaveLength(1);
        expect(packReceipt[0]?.files.map((entry) => entry.path).sort()).toEqual(assembled.files);

        const consumerRoot = path.join(root, "consumer");
        fs.mkdirSync(consumerRoot);
        fs.writeFileSync(path.join(consumerRoot, "package.json"), '{"name":"consumer","private":true}\n');
        const installed = spawnSync(
            process.platform === "win32" ? "npm.cmd" : "npm",
            [
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--no-package-lock",
                path.join(tarballRoot, packReceipt[0]?.filename ?? "missing.tgz"),
            ],
            { cwd: consumerRoot, encoding: "utf8", env: npmEnvironment, windowsHide: true },
        );
        expect(installed.error, installed.error?.message).toBeUndefined();
        expect(installed.status, installed.stderr).toBe(0);
        fs.writeFileSync(
            path.join(consumerRoot, "index.ts"),
            'import type { PhysicalFilesystemBackend } from "@oaam/shared/filesystem";\n' +
                'import type { LocalProcessExecutableIdentity } from "@oaam/shared/paths";\n' +
                'import type { Win32NativeFilesystemAddon } from "./node_modules/@oaam/shared/dist/paths/win32/native-addon";\n' +
                "declare const backend: PhysicalFilesystemBackend;\n" +
                "declare const addon: Win32NativeFilesystemAddon;\n" +
                "declare const identity: LocalProcessExecutableIdentity;\n" +
                'const members: Array<{name: string; entryKind: "file" | "directory" | "other"}> = backend.observeDirectoryMembersBounded("selected-directory", 1);\n' +
                "void [backend, addon, identity, members];\n",
        );
        fs.writeFileSync(
            path.join(consumerRoot, "tsconfig.json"),
            `${JSON.stringify({
                compilerOptions: {
                    module: "Node16",
                    moduleResolution: "Node16",
                    noEmit: true,
                    skipLibCheck: false,
                    strict: true,
                    target: "ES2022",
                    typeRoots: [path.join(process.cwd(), "node_modules", "@types")],
                    types: ["node"],
                },
                files: ["index.ts"],
            })}\n`,
        );
        const typechecked = spawnSync(
            process.execPath,
            [path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
            { cwd: consumerRoot, encoding: "utf8", windowsHide: true },
        );
        expect(typechecked.error, typechecked.error?.message).toBeUndefined();
        expect(typechecked.status, `${typechecked.stdout}\n${typechecked.stderr}`).toBe(0);
        fs.writeFileSync(
            path.join(consumerRoot, "load.cjs"),
            'const paths = require("@oaam/shared/paths");\n' +
                'const filesystem = require("@oaam/shared/filesystem");\n' +
                'if (typeof paths.observeSelectedWslProcessLifecyclePairBounded !== "function" || typeof filesystem.readRegularFileNoFollow !== "function") process.exitCode = 2;\n' +
                'else { const fs = require("node:fs"); const path = require("node:path");\n' +
                'const root = path.join(__dirname, "observed"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "member"), "body");\n' +
                'require("node:assert/strict").deepEqual(filesystem.observeDirectoryMembersBounded(root, 1), [{name:"member",entryKind:"file"}]);\n' +
                'process.stdout.write("OAAM_WINDOWS_SHARED_LIFECYCLE_LOAD_PASS\\n"); }\n',
        );
        const loaded = spawnSync(process.execPath, ["load.cjs"], {
            cwd: consumerRoot,
            encoding: "utf8",
            windowsHide: true,
        });
        expect(loaded.error, loaded.error?.message).toBeUndefined();
        expect(loaded.status, `${loaded.stdout}\n${loaded.stderr}`).toBe(0);
        expect(loaded.stdout).toBe("OAAM_WINDOWS_SHARED_LIFECYCLE_LOAD_PASS\n");
        expect(loaded.stderr).toBe("");
    });

    it("rejects a missing compiled input, a non-node addon, and an existing output root", () => {
        const missing = createFixture();
        fs.rmSync(path.join(missing.sharedRoot, "dist", "paths", "win32", "native-addon.js"));
        expect(() => assembleWindowsSharedTargetPackage(missing.sharedRoot, missing.addonPath, missing.outputRoot)).toThrow(
            /native-addon\.js is missing/u,
        );

        const wrongAddon = createFixture();
        const wrongAddonPath = path.join(path.dirname(wrongAddon.addonPath), "addon.txt");
        fs.renameSync(wrongAddon.addonPath, wrongAddonPath);
        expect(() =>
            assembleWindowsSharedTargetPackage(
                wrongAddon.sharedRoot,
                wrongAddonPath,

                wrongAddon.outputRoot,
            ),
        ).toThrow(/\.node extension/u);

        const existing = createFixture();
        fs.mkdirSync(existing.outputRoot);
        expect(() => assembleWindowsSharedTargetPackage(existing.sharedRoot, existing.addonPath, existing.outputRoot)).toThrow(
            /output already exists/u,
        );
    });

    it.each([
        "local-executable-worker",
        "local-executable-worker-client",
    ])("rejects a target package missing its private %s closure", (stem) => {
        const missing = createFixture();
        fs.rmSync(path.join(missing.sharedRoot, "dist", "paths", "win32", `${stem}.js`));
        expect(() => assembleWindowsSharedTargetPackage(missing.sharedRoot, missing.addonPath, missing.outputRoot)).toThrow(
            `${stem}.js is missing`,
        );
    });

    it("rejects any inactive Unix-like or runtime platform selection that reaches the target package", () => {
        const fixture = createFixture();
        assembleWindowsSharedTargetPackage(fixture.sharedRoot, fixture.addonPath, fixture.outputRoot);
        const targetFile = path.join(fixture.outputRoot, "dist", "paths", "win32", "path-environment.js");
        fs.writeFileSync(targetFile, 'if (process.platform) require("./unix-like");\n');

        expect(() => validateWindowsSharedTargetPackage(fixture.outputRoot)).toThrow(/inactive or runtime-selected mechanics/u);
    });

    it("rejects an unreviewed public export or runtime dependency before target assembly", () => {
        const extraExport = createFixture();
        const extraExportManifestPath = path.join(extraExport.sharedRoot, "package.json");
        const extraExportManifest = JSON.parse(fs.readFileSync(extraExportManifestPath, "utf8"));
        extraExportManifest.exports["./internal"] = "./dist/internal.js";
        fs.writeFileSync(extraExportManifestPath, `${JSON.stringify(extraExportManifest, null, 2)}\n`);
        expect(() =>
            assembleWindowsSharedTargetPackage(
                extraExport.sharedRoot,
                extraExport.addonPath,

                extraExport.outputRoot,
            ),
        ).toThrow(/public surface or dependency closure drifted/u);

        const dependency = createFixture();
        const dependencyManifestPath = path.join(dependency.sharedRoot, "package.json");
        const dependencyManifest = JSON.parse(fs.readFileSync(dependencyManifestPath, "utf8"));
        dependencyManifest.dependencies = { unexpected: "1.0.0" };
        fs.writeFileSync(dependencyManifestPath, `${JSON.stringify(dependencyManifest, null, 2)}\n`);
        expect(() =>
            assembleWindowsSharedTargetPackage(
                dependency.sharedRoot,
                dependency.addonPath,

                dependency.outputRoot,
            ),
        ).toThrow(/public surface or dependency closure drifted/u);
    });
});
