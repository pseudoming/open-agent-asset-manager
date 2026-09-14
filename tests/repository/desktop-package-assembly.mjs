import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { downloadArtifact as downloadElectronArtifact } from "@electron/get";
import { packager as electronPackager } from "@electron/packager";
import { rebuild as electronRebuild } from "@electron/rebuild";
import { restrictedWslDesktopPackaging } from "./restricted-wsl-package.mjs";
import { removePackagedSqliteBuildInputs, removeUnusedDesktopLocales } from "./desktop-package-content.mjs";
import { validateDesktopShellResources, validatePackagedDesktop, desktopAsarOptions } from "./desktop-package-validation.mjs";
import { validateWindowsSharedTargetPackage } from "./shared-target-package.mjs";
import { WorkspaceGraphError } from "./workspace-graph.mjs";
import { tryClassifyWorkspaceRole } from "./workspace-roles.mjs";
import { readProductRelease, windowsProductVersion } from "./product-release.mjs";
function fail(message) {
    throw new WorkspaceGraphError(message);
}

function readJsonObject(filePath, label) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        fail(`${label}: cannot read valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${label}: expected a JSON object`);
    }
    return value;
}

function desktopWorkspace(graph) {
    const entries = graph.packages.filter((entry) => tryClassifyWorkspaceRole(entry) === "client_desktop");
    if (entries.length !== 1)
        fail(`packaged Desktop smoke requires exactly one client_desktop workspace, received ${entries.length}`);
    return entries[0];
}

export function readDesktopElectronVersion(graph) {
    const desktop = desktopWorkspace(graph);
    const manifestPath = path.join(graph.repositoryRoot, ...desktop.relativePath.split("/"), "package.json");
    const manifest = readJsonObject(manifestPath, `${desktop.relativePath}/package.json`);
    const version = manifest.devDependencies?.electron;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
        fail(`${desktop.relativePath}/package.json: devDependencies.electron must be one exact version`);
    }
    const installedManifestPath = createRequire(manifestPath).resolve("electron/package.json");
    const installedManifest = readJsonObject(installedManifestPath, "installed Electron package.json");
    if (installedManifest.version !== version) {
        fail(`installed Electron version ${String(installedManifest.version)} does not match Desktop ${version}`);
    }
    return version;
}

function defaultElectronCacheRoot(platform) {
    if (process.env.electron_config_cache !== undefined) return path.resolve(process.env.electron_config_cache);
    if (platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA;
        if (localAppData === undefined) fail("LOCALAPPDATA is required to locate the Electron cache");
        return path.join(localAppData, "electron", "Cache");
    }
    if (platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "electron");
    return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "electron");
}

async function sha256(filePath) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
}

async function locateVerifiedElectronZip(graph, version, platform, arch, cacheRoot) {
    const fileName = `electron-v${version}-${platform}-${arch}.zip`;
    const desktop = desktopWorkspace(graph);
    const manifestPath = path.join(graph.repositoryRoot, ...desktop.relativePath.split("/"), "package.json");
    const installedRoot = path.dirname(createRequire(manifestPath).resolve("electron/package.json"));
    const checksums = readJsonObject(path.join(installedRoot, "checksums.json"), "installed Electron checksums.json");
    const expectedHash = checksums[fileName];
    if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/u.test(expectedHash)) {
        fail(`installed Electron checksums.json does not cover ${fileName}`);
    }
    const candidates = [];
    if (fs.existsSync(cacheRoot)) {
        for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const candidate = entry.isDirectory() ? path.join(cacheRoot, entry.name, fileName) : path.join(cacheRoot, fileName);
            if (!fs.existsSync(candidate)) continue;
            const stat = fs.lstatSync(candidate);
            if (!stat.isSymbolicLink() && stat.isFile()) candidates.push(candidate);
        }
    }
    for (const candidate of candidates.sort()) {
        if ((await sha256(candidate)) === expectedHash) return candidate;
    }
    fail(`verified Electron archive ${fileName} is absent; run the pinned Electron installer before package verification`);
}

export async function ensureVerifiedDesktopElectronArchive(graph, platform, arch, cacheRoot, options = {}) {
    const version = readDesktopElectronVersion(graph);
    const desktop = desktopWorkspace(graph);
    const manifestPath = path.join(graph.repositoryRoot, ...desktop.relativePath.split("/"), "package.json");
    const installedRoot = path.dirname(createRequire(manifestPath).resolve("electron/package.json"));
    const checksums = readJsonObject(path.join(installedRoot, "checksums.json"), "installed Electron checksums.json");
    await (options.downloadArtifact ?? downloadElectronArtifact)({
        version,
        artifactName: "electron",
        platform,
        arch,
        cacheRoot,
        checksums,
    });
    return locateVerifiedElectronZip(graph, version, platform, arch, cacheRoot);
}

function prepareConsumerApplication(graph, consumerRoot) {
    const desktop = desktopWorkspace(graph);
    const manifestPath = path.join(consumerRoot, "package.json");
    const manifest = readJsonObject(manifestPath, "isolated Desktop consumer package.json");
    const dependencies = manifest.dependencies;
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
        fail("isolated Desktop consumer has no installed dependency inventory");
    }
    if (typeof dependencies[desktop.name] !== "string") {
        fail(`isolated Desktop consumer does not depend on ${desktop.name}`);
    }
    const installedDependencies = Object.fromEntries(
        Object.keys(dependencies).map((name) => {
            const installed = readJsonObject(path.join(consumerRoot, "node_modules", name, "package.json"), name);
            if (installed.name !== name || typeof installed.version !== "string") fail(`invalid installed dependency ${name}`);
            return [name, installed.version];
        }),
    );
    fs.writeFileSync(
        manifestPath,
        `${JSON.stringify(
            {
                name: "oaam-desktop",
                productName: "OAAM",
                private: true,
                license: "Apache-2.0",
                version: readProductRelease(graph.repositoryRoot).version,
                dependencies: installedDependencies,
                main: `node_modules/${desktop.name}/dist/main/index.js`,
            },
            null,
            2,
        )}\n`,
    );
}

export async function assembleDesktopPackage(graph, consumerRoot, options = {}) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    if (!["darwin", "linux", "win32"].includes(platform)) fail(`packaged Desktop smoke does not support ${platform}`);
    if (!["arm64", "ia32", "x64"].includes(arch)) fail(`packaged Desktop smoke does not support ${arch}`);
    const electronVersion = readDesktopElectronVersion(graph);
    const desktop = desktopWorkspace(graph);
    const productVersion = readProductRelease(graph.repositoryRoot).version;
    const desktopPackageRoot = path.join(consumerRoot, "node_modules", desktop.name);
    const shellResources = validateDesktopShellResources(desktopPackageRoot);
    if (platform === "win32") {
        (options.validateWindowsSharedTargetPackage ?? validateWindowsSharedTargetPackage)(
            path.join(consumerRoot, "node_modules", "@oaam", "shared"),
        );
    }
    const electronZipPath = await locateVerifiedElectronZip(
        graph,
        electronVersion,
        platform,
        arch,
        options.electronCacheRoot ?? defaultElectronCacheRoot(platform),
    );
    prepareConsumerApplication(graph, consumerRoot);
    const outputRoot = path.resolve(options.outputRoot ?? path.join(path.dirname(consumerRoot), "packaged-desktop"));
    const rebuild = options.rebuild ?? electronRebuild;
    const wslPackaging = restrictedWslDesktopPackaging(consumerRoot, platform, arch);
    let rebuildCount = 0;
    const packagePaths = await (options.packager ?? electronPackager)({
        dir: consumerRoot,
        name: "OAAM",
        executableName: "oaam-desktop",
        out: outputRoot,
        overwrite: false,
        platform,
        arch,
        electronVersion,
        appVersion: productVersion,
        appCopyright: "Copyright OAAM contributors",
        ...(platform === "win32"
            ? {
                  buildVersion: windowsProductVersion(productVersion),
                  win32metadata: { CompanyName: "OAAM contributors", FileDescription: "OAAM Desktop", ProductName: "OAAM" },
              }
            : {}),
        electronZipDir: path.dirname(electronZipPath),
        asar: desktopAsarOptions(platform),
        prune: true,
        quiet: true,
        ...(platform === "win32"
            ? { icon: shellResources.windowsIconPath }
            : platform === "linux"
              ? { icon: shellResources.pngPath }
              : {}),
        ...wslPackaging,
        ignore: [...wslPackaging.ignore, /^\/(?:package-lock\.json|index\.ts|tsconfig\.json)$/u],
        afterExtract: [
            async ({ buildPath }) => {
                removeUnusedDesktopLocales(buildPath, platform);
            },
        ],
        afterCopy: [
            async ({ buildPath, electronVersion: copiedVersion, arch: copiedArch }) => {
                rebuildCount += 1;
                await rebuild({
                    buildPath,
                    electronVersion: copiedVersion,
                    platform,
                    arch: copiedArch,
                    force: true,
                    onlyModules: ["better-sqlite3"],
                });
                removePackagedSqliteBuildInputs(buildPath);
            },
        ],
    });
    if (!Array.isArray(packagePaths) || packagePaths.length !== 1 || rebuildCount !== 1) {
        fail(
            `packaged Desktop expected one package and one Electron-ABI rebuild, received ${Array.isArray(packagePaths) ? packagePaths.length : 0}/${rebuildCount}`,
        );
    }
    const packagedRoot = path.resolve(packagePaths[0]);
    const expectedParent = path.resolve(outputRoot);
    if (
        packagedRoot === expectedParent ||
        !packagedRoot.startsWith(`${expectedParent}${path.sep}`) ||
        fs.lstatSync(packagedRoot).isSymbolicLink()
    ) {
        fail("packaged Desktop output escaped its temporary output root");
    }
    validatePackagedDesktop(packagedRoot, platform, arch);
    return Object.freeze({ packagedRoot, platform, arch, electronVersion, productVersion });
}
