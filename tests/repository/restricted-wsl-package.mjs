/** Assemble and verify the complete Linux resource without rebuilding it for Electron. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { stop } from "esbuild";
import { buildRestrictedWslService } from "./restricted-wsl-service-build.mjs";

const require = createRequire(import.meta.url);
export const RESTRICTED_WSL_PACKAGE_PATH = path.join("node_modules", "@oaam", "app-server-host", "dist", "restricted-wsl");
export const RESTRICTED_WSL_PACKAGE_IGNORE =
    /[\\/]node_modules[\\/]@oaam[\\/]app-server-host[\\/]dist[\\/]restricted-wsl(?:[\\/]|$)/u;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function regularBytes(file, maximumBytes) {
    const before = fs.lstatSync(file);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= maximumBytes, `invalid package file: ${file}`);
    const bytes = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    assert.ok(after.isFile() && !after.isSymbolicLink());
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, bytes.length);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    return bytes;
}

function readManifest(root, architecture, expectedSha256) {
    const directory = fs.lstatSync(root);
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), "restricted package root must be a direct directory");
    const bytes = regularBytes(path.join(root, "manifest.json"), 64 * 1024);
    if (expectedSha256 !== undefined) assert.equal(digest(bytes), expectedSha256, "restricted manifest binding changed");
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    // The production grammar remains the single manifest owner; this is repository tooling, not another runtime loader.
    const { requireRestrictedArtifactManifest } = require("../../packages/app-server/host/dist/restricted-artifact-package.js");
    requireRestrictedArtifactManifest(manifest);
    if (architecture !== undefined) assert.equal(manifest.architecture, architecture, "restricted package architecture mismatch");
    return { manifest, bytes, sha256: digest(bytes) };
}

function checkFile(root, entry, architecture) {
    let directory = root;
    for (const segment of ["", ...entry.relativePath.split("/").slice(0, -1)]) {
        if (segment !== "") directory = path.join(directory, segment);
        const stat = fs.lstatSync(directory);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "restricted file parent must be a direct directory");
    }
    const file = path.join(root, ...entry.relativePath.split("/"));
    const bytes = regularBytes(file, entry.bytes);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256, `restricted file digest mismatch: ${entry.relativePath}`);
    if (
        entry.relativePath === "node" ||
        entry.relativePath === "oaam_linux_file_mutation" ||
        entry.relativePath.endsWith(".node")
    ) {
        assert.ok(
            bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
            "restricted native file must be ELF",
        );
        assert.equal(bytes[4], 2, "restricted native file must be 64 bit");
        assert.equal(bytes[5], 1, "restricted native file must be little endian");
        assert.equal(bytes.readUInt16LE(18), architecture === "x64" ? 62 : 183, "restricted native machine mismatch");
    }
    if (entry.executable && process.platform !== "win32")
        assert.ok((fs.statSync(file).mode & 0o111) !== 0, "restricted runtime is not executable");
    return bytes;
}

function inventory(root) {
    const stat = fs.lstatSync(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "restricted package directory is not direct");
    const files = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), "restricted package must not contain symlinks");
        if (entry.isDirectory()) {
            files.push(`${entry.name}/`);
            for (const nested of inventory(path.join(root, entry.name))) files.push(`${entry.name}/${nested}`);
        } else {
            assert.ok(entry.isFile(), "restricted package has a nonregular entry");
            files.push(entry.name);
        }
    }
    return files.sort();
}

export function validateInstalledRestrictedWslPackage(root, architecture, expectedSha256) {
    const observed = readManifest(root, architecture, expectedSha256);
    const { manifest } = observed;
    assert.deepEqual(fs.readdirSync(root).sort(), ["code", "manifest.json"]);
    const expected = new Set(manifest.files.map((file) => file.relativePath));
    assert.ok(expected.has("native/oaam_file_lock.node"), "restricted service requires its Linux process-lifetime lock module");
    for (const file of manifest.files) {
        let directory = path.posix.dirname(file.relativePath);
        while (directory !== ".") {
            expected.add(directory + "/");
            directory = path.posix.dirname(directory);
        }
    }
    assert.deepEqual(inventory(path.join(root, "code")), [...expected].sort());
    for (const file of manifest.files) checkFile(path.join(root, "code"), file, manifest.architecture);
    return Object.freeze({
        rootPath: root,
        manifestSha256: observed.sha256,
        architecture: manifest.architecture,
        fileCount: manifest.files.length,
        bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    });
}

/** Copy a previously validated layout after the packager's native rebuild and pruning. */
export function copyInstalledRestrictedWslPackage(source, destination, architecture) {
    const before = validateInstalledRestrictedWslPackage(source, architecture);
    assert.ok(!fs.existsSync(destination), "restricted package destination already exists");
    fs.mkdirSync(destination, { recursive: true });
    fs.mkdirSync(path.join(destination, "code"));
    const observed = readManifest(source, architecture, before.manifestSha256);
    for (const file of observed.manifest.files) {
        const bytes = checkFile(path.join(source, "code"), file, architecture);
        const target = path.join(destination, "code", ...file.relativePath.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }
    fs.writeFileSync(path.join(destination, "manifest.json"), observed.bytes, { flag: "wx" });
    return validateInstalledRestrictedWslPackage(destination, architecture, before.manifestSha256);
}

/** Keep the Linux runtime out of Electron's dependency rebuild/prune, then include its exact physical closure. */
export function restrictedWslDesktopPackaging(consumerRoot, platform, architecture) {
    const ignore = [/\.map$/u, /\.d\.(?:ts|mts|cts)$/u];
    if (platform !== "win32") return { ignore };
    const source = path.join(consumerRoot, RESTRICTED_WSL_PACKAGE_PATH);
    const expected = validateInstalledRestrictedWslPackage(source, architecture);
    return {
        ignore: [...ignore, RESTRICTED_WSL_PACKAGE_IGNORE],
        afterPrune: [
            async ({ buildPath }) => {
                const copied = copyInstalledRestrictedWslPackage(
                    source,
                    path.join(buildPath, RESTRICTED_WSL_PACKAGE_PATH),
                    architecture,
                );
                assert.equal(copied.manifestSha256, expected.manifestSha256);
            },
        ],
    };
}

/** A Windows distribution consumes a Linux-built artifact; native Windows builds can supply that exact artifact. */
export async function prepareRestrictedWslPackageForDelivery(graph, options = {}) {
    const host = graph.packages.find((entry) => entry.name === "@oaam/app-server-host");
    assert.ok(host, "restricted resource requires the production Host package");
    const architecture = options.architecture ?? process.arch;
    // This is a target delivery resource, assembled after npm installs the platform-neutral package closure.
    // Nested node_modules must not be entrusted to npm packing or Electron's native dependency rebuild.
    const destination = path.join(options.consumerRoot, RESTRICTED_WSL_PACKAGE_PATH);
    let temporary;
    let source = options.artifact?.rootPath;
    try {
        if (source === undefined) {
            assert.equal(process.platform, "linux", "Windows delivery needs an exact Linux-built restricted artifact");
            assert.equal(process.arch, architecture, "cross-architecture delivery needs its Linux target artifact");
            temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-package-build-"));
            source = path.join(temporary, "build");
            fs.mkdirSync(source);
            await buildRestrictedWslService(graph.repositoryRoot, source);
        } else {
            assert.match(options.artifact.manifestSha256, /^[a-f0-9]{64}$/u);
        }
        const observed = readManifest(source, architecture, options.artifact?.manifestSha256);
        if (fs.existsSync(destination)) return validateInstalledRestrictedWslPackage(destination, architecture, observed.sha256);
        fs.mkdirSync(destination, { recursive: true });
        fs.mkdirSync(path.join(destination, "code"));
        for (const file of observed.manifest.files) {
            const bytes = checkFile(source, file, architecture);
            const target = path.join(destination, "code", ...file.relativePath.split("/"));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
        }
        fs.writeFileSync(path.join(destination, "manifest.json"), observed.bytes, { flag: "wx" });
        return validateInstalledRestrictedWslPackage(destination, architecture, observed.sha256);
    } finally {
        stop();
        if (temporary !== undefined) fs.rmSync(temporary, { recursive: true, force: true });
    }
}
