import fs from "node:fs";
import path from "node:path";
import { WINDOWS_SHARED_COMPILED_STEMS } from "./shared-target-package.mjs";
import { RESTRICTED_WSL_PACKAGE_PATH, validateInstalledRestrictedWslPackage } from "./restricted-wsl-package.mjs";
import { WorkspaceGraphError } from "./workspace-graph.mjs";

// ASAR globs use forward slashes even when the packager runs on Windows.
export const WINDOWS_UNPACK_DIR = path.posix.join(
    "node_modules",
    "{@oaam/{shared,app-server-host,core},@zip.js/zip.js,better-sqlite3,bindings,file-uri-to-path}",
);

export const LINUX_PHYSICAL_HELPER_PATH = "node_modules/@oaam/shared/dist/paths/unix-like/oaam_linux_file_mutation";
export const LINUX_FILE_LOCK_PATH = "node_modules/@oaam/shared/dist/paths/unix-like/native/oaam_file_lock.node";
export const LINUX_UNPACK_FILES = `{**/{.**,**}/**/*.node,**/${LINUX_PHYSICAL_HELPER_PATH}}`;

/** Keep each platform's executable resources outside the Electron archive. */
export function desktopAsarOptions(platform) {
    if (platform === "win32") return { unpack: "**/{.**,**}/**/*.node", unpackDir: WINDOWS_UNPACK_DIR };
    if (platform === "linux") return { unpack: LINUX_UNPACK_FILES };
    return true;
}

function fail(message) {
    throw new WorkspaceGraphError(message);
}

function assertRegularFile(filePath, label) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch {
        fail(`${label} is missing`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file`);
}

/** Validate the immutable visual resources consumed by the Desktop packager. */
export function validateDesktopShellResources(desktopPackageRoot) {
    const resourceRoot = path.join(desktopPackageRoot, "resources");
    const pngPath = path.join(resourceRoot, "oaam-tray.png");
    const windowsIconPath = path.join(resourceRoot, "oaam-tray.ico");
    assertRegularFile(pngPath, "Desktop Tray PNG");
    assertRegularFile(windowsIconPath, "Desktop Windows icon");

    const png = fs.readFileSync(pngPath);
    if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        fail("Desktop Tray PNG has an invalid signature");
    }
    const icon = fs.readFileSync(windowsIconPath);
    if (icon.length < 6 || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1) {
        fail("Desktop Windows icon has an invalid ICO header");
    }
    const imageCount = icon.readUInt16LE(4);
    if (imageCount !== 5 || icon.length < 6 + imageCount * 16) {
        fail("Desktop Windows icon must contain the reviewed 16/24/32/48/64 pixel image set");
    }
    const dimensions = Array.from({ length: imageCount }, (_, index) => {
        const encodedWidth = icon[6 + index * 16];
        return encodedWidth === 0 ? 256 : encodedWidth;
    }).sort((left, right) => left - right);
    if (dimensions.join(",") !== "16,24,32,48,64") {
        fail(`Desktop Windows icon has unexpected image dimensions ${dimensions.join(",")}`);
    }
    return Object.freeze({ pngPath, windowsIconPath });
}

/** Validate that a packaged Desktop carries every platform-specific executable dependency. */
export function validatePackagedDesktop(packagedRoot, platform, architecture = process.arch) {
    const executablePath =
        platform === "darwin"
            ? path.join(packagedRoot, "OAAM.app", "Contents", "MacOS", "oaam-desktop")
            : path.join(packagedRoot, platform === "win32" ? "oaam-desktop.exe" : "oaam-desktop");
    const resourcesRoot =
        platform === "darwin"
            ? path.join(packagedRoot, "OAAM.app", "Contents", "Resources")
            : path.join(packagedRoot, "resources");
    assertRegularFile(executablePath, "packaged Desktop executable");
    assertRegularFile(path.join(resourcesRoot, "app.asar"), "packaged Desktop app.asar");
    assertRegularFile(
        path.join(
            resourcesRoot,
            "app.asar.unpacked",
            "node_modules",
            "better-sqlite3",
            "build",
            "Release",
            "better_sqlite3.node",
        ),
        "packaged Electron-ABI better-sqlite3 module",
    );
    if (platform === "linux") {
        const helperPath = path.join(resourcesRoot, "app.asar.unpacked", ...LINUX_PHYSICAL_HELPER_PATH.split("/"));
        assertRegularFile(helperPath, "packaged Linux physical helper");
        if ((fs.lstatSync(helperPath).mode & 0o111) === 0) fail("packaged Linux physical helper must be executable");
        assertRegularFile(
            path.join(resourcesRoot, "app.asar.unpacked", ...LINUX_FILE_LOCK_PATH.split("/")),
            "packaged Linux process-lifetime lock module",
        );
    }
    if (platform === "win32") {
        const resourceRoot = path.join(resourcesRoot, "app.asar.unpacked", RESTRICTED_WSL_PACKAGE_PATH);
        validateInstalledRestrictedWslPackage(resourceRoot, architecture);
        const hostWorker = path.join(path.dirname(resourceRoot), "restricted-process-worker.js");
        assertRegularFile(hostWorker, "packaged restricted process worker");
        const expectedWorker = path.relative(packagedRoot, hostWorker).split(path.sep).join("/");
        const occurrences = fs
            .globSync("**/restricted-process-worker.js", { cwd: packagedRoot })
            .map((entry) => entry.split(path.sep).join("/"))
            .sort();
        if (JSON.stringify(occurrences) !== JSON.stringify([expectedWorker])) {
            fail("packaged Desktop must contain the restricted process worker exactly once outside app.asar");
        }
        const codeOccurrences = fs
            .globSync("**/restricted-wsl.cjs", { cwd: packagedRoot })
            .map((entry) => entry.split(path.sep).join("/"))
            .sort();
        const expectedCode = path
            .relative(packagedRoot, path.join(resourceRoot, "code", "restricted-wsl.cjs"))
            .split(path.sep)
            .join("/");
        if (JSON.stringify(codeOccurrences) !== JSON.stringify([expectedCode])) {
            fail("packaged Desktop must contain its restricted code resource exactly once outside app.asar");
        }
        const unpackedSharedRoot = path.join(resourcesRoot, "app.asar.unpacked", "node_modules", "@oaam", "shared");
        for (const stem of WINDOWS_SHARED_COMPILED_STEMS) {
            assertRegularFile(
                `${path.join(unpackedSharedRoot, "dist", ...stem.split("/"))}.js`,
                `packaged target-built Windows Shared module ${stem}`,
            );
        }
        assertRegularFile(
            path.join(unpackedSharedRoot, "dist", "paths", "win32", "native", "oaam_windows_filesystem.node"),
            "packaged target-built Windows Shared addon",
        );
        if (fs.globSync("**/oaam_wsl_file_mutation", { cwd: packagedRoot }).length !== 0) {
            fail("packaged Desktop contains the retired Windows-to-WSL helper");
        }
    }
    return executablePath;
}
