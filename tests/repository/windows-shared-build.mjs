import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runPackageCommand } from "./package-consumer.mjs";
import { assembleWindowsSharedTargetPackage, expectedWindowsSharedTargetFiles } from "./shared-target-package.mjs";

export const WINDOWS_ADDON_NATIVE_FILES = Object.freeze([
    "binding.gyp",
    "src/addon.cc",
    "src/native-errors.cc",
    "src/native-errors.h",
    "src/process-invocation.cc",
    "src/process-invocation.h",
    "src/process-observation.cc",
    "src/process-observation.h",
    "src/recycle-bin.cc",
    "src/safe-mutation.cc",
    "src/safe-read.cc",
    "src/safe-read.h",
]);

/** Native Windows CI and local packaging compile only the already approved Node-API addon. */
export function buildWindowsSharedTarball(repositoryRoot, buildRoot) {
    assert.equal(process.platform, "win32", "Windows Shared must be compiled on its target host");
    assert.equal(process.arch, "x64", "Windows Desktop currently targets x64");
    assert.ok(!fs.existsSync(buildRoot), "native build requires a new directory");
    fs.mkdirSync(buildRoot, { recursive: true });
    for (const relative of WINDOWS_ADDON_NATIVE_FILES) {
        const source = path.join(repositoryRoot, "packages/shared/src/paths/win32/native", relative);
        const stat = fs.lstatSync(source);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), "native input must be a direct file");
        const destination = path.join(buildRoot, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    }
    const require = createRequire(path.join(repositoryRoot, "package.json"));
    assert.equal(require("node-gyp/package.json").version, "12.4.0", "native build tool version changed");
    for (const command of ["configure", "build"]) {
        runPackageCommand(
            `Windows Shared ${command}`,
            process.execPath,
            [require.resolve("node-gyp/bin/node-gyp.js"), command, "--arch=x64", `--devdir=${path.join(buildRoot, "headers")}`],
            { cwd: buildRoot, encoding: "utf8", stdio: "pipe" },
        );
    }
    const target = assembleWindowsSharedTargetPackage(
        path.join(repositoryRoot, "packages/shared"),
        path.join(buildRoot, "build/Release/oaam_windows_filesystem.node"),
        path.join(buildRoot, "shared-target"),
    );
    return packWindowsSharedTarball(target.packageRoot, buildRoot);
}

export function packWindowsSharedTarball(packageRoot, destination) {
    const result = runPackageCommand(
        "pack Windows Shared",
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["pack", "--json", "--pack-destination", destination, packageRoot],
        { cwd: destination, encoding: "utf8", stdio: "pipe" },
    );
    const records = JSON.parse(result.stdout);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.name, "@oaam/shared");
    assert.deepEqual(record.files.map((file) => file.path).sort(), expectedWindowsSharedTargetFiles());
    assert.equal(path.basename(record.filename), record.filename);
    return Object.freeze({ name: record.name, version: record.version, path: path.join(destination, record.filename) });
}
