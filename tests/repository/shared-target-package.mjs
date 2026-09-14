#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { walkGovernedRegularFiles } from "./governed-filesystem.mjs";

const COMPILED_EXTENSIONS = Object.freeze([".js", ".js.map", ".d.ts", ".d.ts.map"]);
const SOURCE_EXPORTS = Object.freeze({
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
});
const SOURCE_TYPES_VERSIONS = Object.freeze({
    "*": {
        filesystem: ["dist/paths/unix-like/filesystem-target-entry.d.ts"],
        paths: ["dist/paths/unix-like/path-environment.d.ts"],
    },
});
export const WINDOWS_TARGET_EXPORTS = Object.freeze({
    "./filesystem": {
        types: "./dist/paths/win32/filesystem-target-entry.d.ts",
        require: "./dist/paths/win32/filesystem-target-entry.js",
        default: "./dist/paths/win32/filesystem-target-entry.js",
    },
    "./paths": {
        types: "./dist/paths/win32/path-environment.d.ts",
        require: "./dist/paths/win32/path-environment.js",
        default: "./dist/paths/win32/path-environment.js",
    },
});
const WINDOWS_TARGET_TYPES_VERSIONS = Object.freeze({
    "*": {
        filesystem: ["dist/paths/win32/filesystem-target-entry.d.ts"],
        paths: ["dist/paths/win32/path-environment.d.ts"],
    },
});

export const WINDOWS_SHARED_COMPILED_STEMS = Object.freeze([
    "filesystem/filesystem-facts",
    "filesystem/filesystem-types",
    "filesystem/physical-filesystem-backend",
    "filesystem/regular-file-read-batch",
    "paths/committed-sqlite-snapshot",
    "paths/directory-member-observation",
    "paths/packaged-worker-path",
    "paths/path-environment",
    "paths/physical-access-paths",
    "paths/selected-wsl-path-projection",
    "paths/wsl-distro-discovery",
    "paths/win32/filesystem-backend",
    "paths/win32/filesystem-target-entry",
    "paths/win32/local-executable-invocation",
    "paths/win32/local-executable-worker",
    "paths/win32/local-executable-worker-client",
    "paths/win32/native-addon-contract",
    "paths/win32/native-addon",
    "paths/win32/packaged-worker-path",
    "paths/win32/path-environment",
    "paths/win32/platform-context-regular-file",
    "paths/win32/process-observation",
    "paths/win32/recycle-bin-worker",
    "paths/win32/recycle-bin-worker-client",
    "paths/win32/selected-wsl-helper-paths",
    "paths/win32/selected-wsl-process-lifecycle",
    "paths/win32/selected-wsl-process-lifecycle-pair",
    "paths/win32/selected-wsl-process-validation",
]);

export const WINDOWS_SHARED_ADDON_PATH = "dist/paths/win32/native/oaam_windows_filesystem.node";

function fail(message) {
    throw new Error(message);
}

function toPortablePath(value) {
    return value.split(path.sep).join("/");
}

function requireRegularFile(filePath, label) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch {
        fail(`${label} is missing`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        fail(`${label} must be a regular non-symlink file`);
    }
}

function writeExclusive(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data, { flag: "wx" });
}

function copyCompiledArtifact(sourcePath, destinationPath) {
    requireRegularFile(sourcePath, sourcePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
}

function targetManifest(sourceManifest) {
    const requiredStrings = ["name", "version", "description", "license", "type", "main", "types"];
    for (const field of requiredStrings) {
        if (typeof sourceManifest[field] !== "string" || sourceManifest[field].length === 0) {
            fail(`packages/shared/package.json: ${field} must be a non-empty string`);
        }
    }
    if (sourceManifest.name !== "@oaam/shared") {
        fail(`packages/shared/package.json: unexpected package name ${String(sourceManifest.name)}`);
    }
    if (
        sourceManifest.type !== "commonjs" ||
        sourceManifest.main !== "./dist/paths/unix-like/filesystem-target-entry.js" ||
        sourceManifest.types !== "./dist/paths/unix-like/filesystem-target-entry.d.ts" ||
        JSON.stringify(sourceManifest.exports) !== JSON.stringify(SOURCE_EXPORTS) ||
        JSON.stringify(sourceManifest.typesVersions) !== JSON.stringify(SOURCE_TYPES_VERSIONS) ||
        sourceManifest.dependencies === null ||
        typeof sourceManifest.dependencies !== "object" ||
        Array.isArray(sourceManifest.dependencies) ||
        Object.keys(sourceManifest.dependencies).length !== 0
    ) {
        fail("packages/shared/package.json: target package public surface or dependency closure drifted");
    }
    return {
        name: sourceManifest.name,
        version: sourceManifest.version,
        description: sourceManifest.description,
        license: sourceManifest.license,
        type: sourceManifest.type,
        main: "./dist/paths/win32/filesystem-target-entry.js",
        types: "./dist/paths/win32/filesystem-target-entry.d.ts",
        exports: WINDOWS_TARGET_EXPORTS,
        typesVersions: WINDOWS_TARGET_TYPES_VERSIONS,
        files: ["dist/filesystem", "dist/paths"],
        dependencies: sourceManifest.dependencies ?? {},
        engines: sourceManifest.engines,
    };
}

export function expectedWindowsSharedTargetFiles() {
    return Object.freeze(
        [
            "package.json",
            ...WINDOWS_SHARED_COMPILED_STEMS.flatMap((stem) =>
                COMPILED_EXTENSIONS.map((extension) => `dist/${stem}${extension}`),
            ),
            WINDOWS_SHARED_ADDON_PATH,
        ].sort(),
    );
}

export function validateWindowsSharedTargetPackage(packageRoot) {
    const files = walkGovernedRegularFiles(packageRoot, { label: "Windows Shared target package" })
        .map((filePath) => toPortablePath(path.relative(packageRoot, filePath)))
        .sort();
    const expected = expectedWindowsSharedTargetFiles();
    if (JSON.stringify(files) !== JSON.stringify(expected)) {
        fail(`Windows Shared target package inventory mismatch:\nexpected ${expected.join(", ")}\nreceived ${files.join(", ")}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (
        JSON.stringify(Object.keys(manifest).sort()) !==
            JSON.stringify(
                [
                    "dependencies",
                    "description",
                    "engines",
                    "exports",
                    "files",
                    "license",
                    "main",
                    "name",
                    "type",
                    "types",
                    "typesVersions",
                    "version",
                ].sort(),
            ) ||
        manifest.name !== "@oaam/shared" ||
        manifest.type !== "commonjs" ||
        manifest.main !== "./dist/paths/win32/filesystem-target-entry.js" ||
        manifest.types !== "./dist/paths/win32/filesystem-target-entry.d.ts" ||
        JSON.stringify(manifest.exports) !== JSON.stringify(WINDOWS_TARGET_EXPORTS) ||
        JSON.stringify(manifest.typesVersions) !== JSON.stringify(WINDOWS_TARGET_TYPES_VERSIONS) ||
        JSON.stringify(manifest.files) !== JSON.stringify(["dist/filesystem", "dist/paths"]) ||
        manifest.dependencies === null ||
        typeof manifest.dependencies !== "object" ||
        Array.isArray(manifest.dependencies) ||
        Object.keys(manifest.dependencies).length !== 0
    ) {
        fail("Windows Shared target package manifest is not the reviewed lifecycle-free closure");
    }
    const JavaScriptFiles = files.filter((filePath) => filePath.endsWith(".js"));
    for (const filePath of JavaScriptFiles) {
        const source = fs.readFileSync(path.join(packageRoot, ...filePath.split("/")), "utf8");
        if (source.includes("unix-like") || source.includes("process.platform")) {
            fail(`Windows Shared target package contains inactive or runtime-selected mechanics in ${filePath}`);
        }
    }
    return Object.freeze(files);
}

export function assembleWindowsSharedTargetPackage(sharedPackageRoot, addonPath, outputRoot) {
    const resolvedSharedRoot = path.resolve(sharedPackageRoot);
    const resolvedOutputRoot = path.resolve(outputRoot);
    if (fs.existsSync(resolvedOutputRoot)) {
        fail(`Windows Shared target output already exists: ${resolvedOutputRoot}`);
    }
    requireRegularFile(addonPath, "precompiled Windows Shared addon");
    if (path.extname(addonPath).toLowerCase() !== ".node") {
        fail("precompiled Windows Shared addon must have the .node extension");
    }
    const sourceManifestPath = path.join(resolvedSharedRoot, "package.json");
    requireRegularFile(sourceManifestPath, "packages/shared/package.json");
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
    fs.mkdirSync(resolvedOutputRoot, { recursive: false });
    writeExclusive(path.join(resolvedOutputRoot, "package.json"), `${JSON.stringify(targetManifest(sourceManifest), null, 2)}\n`);

    for (const stem of WINDOWS_SHARED_COMPILED_STEMS) {
        for (const extension of COMPILED_EXTENSIONS) {
            copyCompiledArtifact(
                path.join(resolvedSharedRoot, "dist", ...stem.split("/")) + extension,
                path.join(resolvedOutputRoot, "dist", ...stem.split("/")) + extension,
            );
        }
    }
    const targetAddon = path.join(resolvedOutputRoot, ...WINDOWS_SHARED_ADDON_PATH.split("/"));
    fs.mkdirSync(path.dirname(targetAddon), { recursive: true });
    fs.copyFileSync(addonPath, targetAddon, fs.constants.COPYFILE_EXCL);
    validateWindowsSharedTargetPackage(resolvedOutputRoot);
    return Object.freeze({
        packageRoot: resolvedOutputRoot,
        addonPath: targetAddon,
        files: expectedWindowsSharedTargetFiles(),
    });
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
    const [sharedPackageRoot, addonPath, outputRoot] = process.argv.slice(2);
    if (sharedPackageRoot === undefined || addonPath === undefined || outputRoot === undefined) {
        process.stderr.write("usage: shared-target-package.mjs <shared-package-root> <addon.node> <output-root>\n");
        process.exitCode = 1;
    } else {
        try {
            const result = assembleWindowsSharedTargetPackage(sharedPackageRoot, addonPath, outputRoot);
            process.stdout.write(
                `Windows Shared target package assembled (${result.files.length} files): ${result.packageRoot}\n`,
            );
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    }
}
