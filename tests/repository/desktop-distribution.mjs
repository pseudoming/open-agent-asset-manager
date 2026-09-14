import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";
import { validateBuiltPackageEntries, validatePackageDeliveryPolicies } from "./package-build-policy.mjs";
import { installWorkspaceConsumer, packWorkspaceTarballs, runPackageCommand } from "./package-consumer.mjs";
import { assembleDesktopPackage, ensureVerifiedDesktopElectronArchive } from "./desktop-package-assembly.mjs";
import { createPackageArtifact, fileSha256, packageFileInventory, verifyPackageArtifact } from "./package-artifact.mjs";
import {
    copyInstalledRestrictedWslPackage,
    prepareRestrictedWslPackageForDelivery,
    RESTRICTED_WSL_PACKAGE_PATH,
    validateInstalledRestrictedWslPackage,
} from "./restricted-wsl-package.mjs";
import { readProductRelease, windowsProductVersion } from "./product-release.mjs";
import { buildWindowsSharedTarball } from "./windows-shared-build.mjs";
import { readWindowsVersionInfo, stampWindowsProductVersion } from "./windows-version-info.mjs";

export function readDistributionSource(repositoryRoot, options = {}) {
    const git = (...args) =>
        runPackageCommand("distribution source identity", "git", args, {
            cwd: repositoryRoot,
            encoding: "utf8",
            stdio: "pipe",
        }).stdout.trim();
    assert.equal(git("status", "--porcelain", "--untracked-files=normal"), "", "distribution requires a clean source checkout");
    const sourceCommit = git("rev-parse", "HEAD"),
        sourceTree = git("rev-parse", "HEAD^{tree}");
    assert.match(sourceCommit, /^[0-9a-f]{40}$/u);
    assert.match(sourceTree, /^[0-9a-f]{40}$/u);
    const release = readProductRelease(repositoryRoot);
    if (options.tag !== undefined) {
        assert.equal(options.tag, `v${release.version}`, "Release tag must exactly match the product version");
        assert.notEqual(release.channel, "dev", "internal development versions cannot create public Release drafts");
        assert.equal(git("rev-parse", `${options.tag}^{commit}`), sourceCommit, "Release tag does not identify this source");
    }
    const buildNumber = options.buildNumber ?? process.env.GITHUB_RUN_NUMBER ?? "local";
    assert.match(buildNumber, /^[A-Za-z0-9._-]{1,64}$/u);
    const buildTime = options.buildTime ?? new Date().toISOString();
    assert.ok(typeof buildTime === "string" && new Date(buildTime).toISOString() === buildTime, "invalid build time");
    return Object.freeze({
        productVersion: release.version,
        channel: release.channel,
        sourceCommit,
        sourceTree,
        buildNumber,
        buildTime,
        sourceLockSha256: fileSha256(path.join(repositoryRoot, "package-lock.json")),
        assemblyLockSha256: fileSha256(path.join(repositoryRoot, "tests/repository/package-assembly/package-lock.json")),
    });
}

function installedToolVersion(require, name) {
    let directory = path.dirname(require.resolve(name));
    for (;;) {
        const file = path.join(directory, "package.json");
        if (fs.existsSync(file)) {
            const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
            if (manifest.name === name) return manifest.version;
        }
        const parent = path.dirname(directory);
        assert.notEqual(parent, directory, `installed tool manifest is missing: ${name}`);
        directory = parent;
    }
}

function freshOutput(root) {
    assert.ok(
        typeof root === "string" && path.isAbsolute(root) && !fs.existsSync(root),
        "output requires a new absolute directory",
    );
    fs.mkdirSync(root, { recursive: true });
    return root;
}

export async function buildRestrictedWslDistribution(repositoryRoot, options) {
    assert.equal(process.platform, "linux", "restricted WSL resource must be built on Linux");
    const source = readDistributionSource(repositoryRoot, options);
    const root = freshOutput(options.outputRoot);
    const graph = resolveWorkspaceGraph(repositoryRoot);
    const prepared = await prepareRestrictedWslPackageForDelivery(graph, {
        consumerRoot: path.join(root, "staging"),
        architecture: "x64",
    });
    const artifact = await createPackageArtifact(
        prepared.rootPath,
        path.join(root, "artifacts"),
        `OAAM-${source.productVersion}-restricted-wsl-support-linux-x64.tar.gz`,
        {
            ...source,
            component: "restricted-wsl-support",
            platform: "linux",
            arch: "x64",
            resourceManifestSha256: prepared.manifestSha256,
        },
    );
    const verified = await verifyPackageArtifact(artifact.archive, artifact.manifestPath, path.join(root, "verified"), {
        sourceCommit: source.sourceCommit,
        component: "restricted-wsl-support",
    });
    validateInstalledRestrictedWslPackage(verified.root, "x64", prepared.manifestSha256);
    return artifact;
}

/** Consume the installed Linux archive layout used by a Windows Desktop distribution. */
export async function installRestrictedWslResourceArchive(options) {
    assert.ok(options.archive && options.manifestPath, "Windows Desktop requires the Linux-built restricted resource artifact");
    const resource = await verifyPackageArtifact(options.archive, options.manifestPath, options.extractionRoot, {
        sourceCommit: options.sourceCommit,
        productVersion: options.productVersion,
        component: "restricted-wsl-support",
        platform: "linux",
        arch: options.architecture,
    });
    const checked = validateInstalledRestrictedWslPackage(
        resource.root,
        options.architecture,
        resource.manifest.resourceManifestSha256,
    );
    const copied = copyInstalledRestrictedWslPackage(
        resource.root,
        path.join(options.consumerRoot, RESTRICTED_WSL_PACKAGE_PATH),
        options.architecture,
    );
    assert.equal(copied.manifestSha256, checked.manifestSha256, "restricted resource binding changed during copy");
    return copied;
}

export async function buildDesktopDistribution(repositoryRoot, options) {
    const source = readDistributionSource(repositoryRoot, options);
    const platform = options.platform ?? process.platform,
        arch = "x64";
    assert.ok(platform === "linux" || platform === "win32", "release Desktop targets Windows or Linux");
    assert.equal(process.arch, arch, "release Desktop currently targets x64");
    const graph = resolveWorkspaceGraph(repositoryRoot);
    const policies = validatePackageDeliveryPolicies(graph);
    validateBuiltPackageEntries(graph, policies);
    const stamp = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, "packages/client/desktop/dist/product-release.json"), "utf8"),
    );
    assert.deepEqual(
        stamp,
        { component: "desktop", version: source.productVersion, channel: source.channel },
        "built Desktop version stamp is stale",
    );
    const root = freshOutput(options.outputRoot);
    let sharedTarget;
    if (platform === "win32") {
        if (process.platform === "win32") sharedTarget = buildWindowsSharedTarball(repositoryRoot, path.join(root, "native"));
        else {
            assert.ok(
                options.sharedTargetTarball && options.sharedTargetSha256,
                "cross-target assembly requires a verified target-built Shared tarball",
            );
            assert.equal(
                fileSha256(options.sharedTargetTarball),
                options.sharedTargetSha256,
                "target Shared tarball digest changed",
            );
            const shared = graph.packages.find((entry) => entry.name === "@oaam/shared");
            sharedTarget = { name: shared.name, version: shared.version, path: path.resolve(options.sharedTargetTarball) };
        }
    } else assert.equal(process.platform, "linux", "Linux Desktop must be assembled on Linux");
    const tarballs = packWorkspaceTarballs(
        graph,
        policies,
        path.join(root, "tarballs"),
        sharedTarget ? { prevalidatedWorkspaceTarballOverrides: [sharedTarget] } : {},
    );
    const consumerRoot = path.join(root, "consumer");
    const closure = installWorkspaceConsumer(graph, tarballs, consumerRoot);
    let restrictedWsl;
    if (platform === "win32") {
        restrictedWsl = await installRestrictedWslResourceArchive({
            archive: options.wslArchive,
            manifestPath: options.wslManifest,
            extractionRoot: path.join(root, "wsl-input"),
            consumerRoot,
            architecture: arch,
            sourceCommit: source.sourceCommit,
            productVersion: source.productVersion,
        });
    }
    const electronCacheRoot = options.electronCacheRoot ?? path.join(root, "electron-cache");
    await ensureVerifiedDesktopElectronArchive(graph, platform, arch, electronCacheRoot);
    const packaged = await assembleDesktopPackage(graph, consumerRoot, {
        platform,
        arch,
        electronCacheRoot,
        outputRoot: path.join(root, "package"),
    });
    const require = createRequire(path.join(repositoryRoot, "package.json"));
    const buildInfo = {
        schemaVersion: 1,
        component: "desktop",
        ...source,
        platform,
        arch,
        externalClosureSha256: closure.externalLockSha256,
        externalPackageCount: closure.packageCount,
        tools: {
            node: process.versions.node,
            electron: packaged.electronVersion,
            packager: installedToolVersion(require, "@electron/packager"),
            rebuild: installedToolVersion(require, "@electron/rebuild"),
        },
        ...(restrictedWsl
            ? {
                  restrictedWsl: {
                      component: "restricted-wsl-support",
                      platform: "linux",
                      arch,
                      manifestSha256: restrictedWsl.manifestSha256,
                      sourceCommit: source.sourceCommit,
                  },
              }
            : {}),
    };
    if (platform === "win32") {
        stampWindowsProductVersion(path.join(packaged.packagedRoot, "oaam-desktop.exe"), source.productVersion);
        const pe = readWindowsVersionInfo(path.join(packaged.packagedRoot, "oaam-desktop.exe"));
        assert.equal(pe.fileVersion, windowsProductVersion(source.productVersion), "PE numeric file version mismatch");
        assert.equal(pe.productVersion, windowsProductVersion(source.productVersion), "PE numeric product version mismatch");
        assert.equal(pe.strings.FileVersion, windowsProductVersion(source.productVersion), "PE file version string mismatch");
        assert.equal(pe.strings.ProductVersion, source.productVersion, "PE product version mismatch");
        assert.equal(pe.strings.CompanyName, "OAAM contributors", "PE inherited publisher was not replaced");
        assert.equal(pe.strings.LegalCopyright, "Copyright OAAM contributors", "PE inherited copyright was not replaced");
        buildInfo.windowsVersionInfo = pe;
    }
    fs.writeFileSync(path.join(packaged.packagedRoot, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n", {
        flag: "wx",
    });
    const artifact = await createPackageArtifact(
        packaged.packagedRoot,
        path.join(root, "artifacts"),
        `OAAM-${source.productVersion}-desktop-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`,
        buildInfo,
    );
    if (platform === "win32") {
        assert.ok(artifact.manifest.archive.bytes <= 200 * 1024 ** 2, "Windows ZIP exceeds the accepted 200 MiB budget");
        assert.ok(
            artifact.manifest.files.reduce((total, file) => total + file.bytes, 0) <= 480 * 1024 ** 2,
            "Windows package exceeds 480 MiB",
        );
        assert.ok(
            fs.statSync(path.join(packaged.packagedRoot, "resources/app.asar")).size <= 45 * 1024 ** 2,
            "Windows app.asar exceeds 45 MiB",
        );
    }
    await verifyPackageArtifact(artifact.archive, artifact.manifestPath, path.join(root, "verified"), {
        sourceCommit: source.sourceCommit,
        component: "desktop",
        platform,
        arch,
        productVersion: source.productVersion,
    });
    assert.deepEqual(
        packageFileInventory(packaged.packagedRoot).files,
        artifact.manifest.files,
        "package changed during archiving",
    );
    return artifact;
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
    try {
        const { values } = parseArgs({
            options: {
                output: { type: "string" },
                "wsl-resource": { type: "boolean" },
                "wsl-archive": { type: "string" },
                "wsl-manifest": { type: "string" },
                tag: { type: "string" },
                "build-number": { type: "string" },
                "build-time": { type: "string" },
            },
        });
        const options = {
            outputRoot: values.output,
            buildNumber: values["build-number"],
            buildTime: values["build-time"],
            tag: values.tag ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined),
            wslArchive: values["wsl-archive"],
            wslManifest: values["wsl-manifest"],
        };
        const result = await (values["wsl-resource"] ? buildRestrictedWslDistribution : buildDesktopDistribution)(
            process.cwd(),
            options,
        );
        process.stdout.write(JSON.stringify({ archive: result.archive, manifest: result.manifestPath }, null, 2) + "\n");
    } catch (error) {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
    }
}
