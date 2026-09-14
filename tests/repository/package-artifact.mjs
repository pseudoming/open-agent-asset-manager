import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";

export const fileSha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function safeRelative(value) {
    assert.ok(
        typeof value === "string" &&
            value.length > 0 &&
            !value.includes("\\") &&
            !value.includes("\0") &&
            !value.includes(":") &&
            !value.split("/").some((part) => ["", ".", ".."].includes(part)),
        "unsafe artifact path",
    );
    return value;
}

export function packageFileInventory(root) {
    const stat = fs.lstatSync(root);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "artifact root must be a direct directory");
    const files = [];
    const directories = [];
    function visit(directory, prefix) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relativePath = safeRelative(prefix + entry.name);
            const file = path.join(directory, entry.name);
            const current = fs.lstatSync(file);
            assert.ok(!current.isSymbolicLink(), "artifact must not contain symbolic links");
            if (current.isDirectory()) {
                directories.push(relativePath);
                visit(file, relativePath + "/");
            } else {
                assert.ok(current.isFile(), "artifact must contain only directories and regular files");
                files.push({ relativePath, bytes: current.size, sha256: fileSha256(file), mode: current.mode & 0o777 });
            }
        }
    }
    visit(root, "");
    return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en")), directories: directories.sort() };
}

/** The outer manifest binds the complete archive; it is deliberately outside the archive it hashes. */
export async function createPackageArtifact(root, outputDirectory, archiveName, metadata) {
    safeRelative(archiveName);
    assert.ok(!archiveName.includes("/") && /\.(?:zip|tar\.gz)$/u.test(archiveName), "unsupported artifact format");
    const rootDirectory = safeRelative(path.basename(root));
    const inventory = packageFileInventory(root);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const archive = path.join(outputDirectory, archiveName);
    assert.ok(!fs.existsSync(archive) && !fs.existsSync(archive + ".manifest.json"), "artifact already exists");
    if (archiveName.endsWith(".zip")) {
        const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
        for (const directory of [rootDirectory, ...inventory.directories.map((entry) => `${rootDirectory}/${entry}`)]) {
            await writer.add(directory + "/", undefined, { directory: true });
        }
        for (const file of inventory.files) {
            await writer.add(
                `${rootDirectory}/${file.relativePath}`,
                new Uint8ArrayReader(fs.readFileSync(path.join(root, file.relativePath))),
                { level: 6, lastModDate: new Date(0) },
            );
        }
        fs.writeFileSync(archive, await writer.close(), { flag: "wx" });
    } else {
        await tar.c({ file: archive, cwd: path.dirname(root), gzip: true, portable: true, noMtime: true }, [rootDirectory]);
    }
    const manifest = {
        schemaVersion: 1,
        ...metadata,
        rootDirectory,
        archive: {
            name: archiveName,
            bytes: fs.statSync(archive).size,
            sha256: fileSha256(archive),
        },
        ...inventory,
    };
    fs.writeFileSync(archive + ".manifest.json", JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return Object.freeze({ archive, manifestPath: archive + ".manifest.json", manifest });
}

function readArtifactManifest(manifestPath) {
    assert.ok(fs.statSync(manifestPath).size <= 8 * 1024 * 1024, "artifact manifest is too large");
    const manifest = json(manifestPath);
    assert.equal(manifest.schemaVersion, 1, "unknown artifact manifest version");
    safeRelative(manifest.rootDirectory);
    safeRelative(manifest.archive.name);
    assert.ok(!manifest.rootDirectory.includes("/") && !manifest.archive.name.includes("/"), "artifact names must be basenames");
    assert.match(manifest.archive.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 20000);
    assert.ok(Array.isArray(manifest.directories) && manifest.directories.length <= 20000);
    const names = new Set();
    for (const file of manifest.files) {
        safeRelative(file.relativePath);
        assert.ok(!names.has(file.relativePath), "duplicate artifact file");
        names.add(file.relativePath);
        assert.match(file.sha256, /^[0-9a-f]{64}$/u);
        assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 1024 ** 3);
        assert.ok(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777);
    }
    assert.ok(manifest.files.reduce((sum, file) => sum + file.bytes, 0) <= 2 * 1024 ** 3, "artifact exceeds extraction budget");
    for (const directory of manifest.directories) {
        safeRelative(directory);
        assert.ok(!names.has(directory), "duplicate artifact path");
        names.add(directory);
    }
    return manifest;
}

/** Verify a downloaded archive before extraction, then independently verify its extracted bytes and modes. */
export async function verifyPackageArtifact(archive, manifestPath, extractionRoot, expected = {}) {
    const manifest = readArtifactManifest(manifestPath);
    assert.equal(path.basename(archive), manifest.archive.name, "artifact filename changed");
    assert.equal(fs.statSync(archive).size, manifest.archive.bytes, "artifact size changed");
    assert.equal(fileSha256(archive), manifest.archive.sha256, "artifact digest changed");
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(manifest[key], value, `artifact ${key} mismatch`);
    assert.ok(!fs.existsSync(extractionRoot), "artifact extraction requires a new directory");
    const prefix = manifest.rootDirectory + "/";
    const expectedFiles = new Map(manifest.files.map((file) => [prefix + file.relativePath, file]));
    const expectedDirectories = new Set([manifest.rootDirectory, ...manifest.directories.map((dir) => prefix + dir)]);
    const seen = new Set();
    const checkEntry = (name, directory, bytes) => {
        const normalized = directory && name.endsWith("/") ? name.slice(0, -1) : name;
        safeRelative(normalized);
        assert.ok(!seen.has(normalized), "duplicate archive entry");
        seen.add(normalized);
        if (directory) assert.ok(expectedDirectories.has(normalized), "unexpected archive directory");
        else {
            assert.ok(expectedFiles.has(normalized), "unexpected archive file");
            assert.equal(bytes, expectedFiles.get(normalized).bytes, "archive file size differs from inventory");
        }
    };
    if (archive.endsWith(".zip")) {
        const reader = new ZipReader(new Uint8ArrayReader(fs.readFileSync(archive)), { useWebWorkers: false });
        try {
            const entries = await reader.getEntries();
            for (const entry of entries) {
                const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
                assert.ok(
                    kind === 0 || kind === 0o100000 || (entry.directory && kind === 0o040000),
                    "archive contains a link or device",
                );
                checkEntry(entry.filename, entry.directory, entry.uncompressedSize);
            }
            assert.equal(seen.size, expectedFiles.size + expectedDirectories.size, "archive inventory is incomplete");
            fs.mkdirSync(extractionRoot, { recursive: true });
            for (const entry of entries) {
                const destination = path.join(extractionRoot, ...entry.filename.split("/"));
                if (entry.directory) fs.mkdirSync(destination, { recursive: true });
                else {
                    fs.mkdirSync(path.dirname(destination), { recursive: true });
                    fs.writeFileSync(destination, await entry.getData(new Uint8ArrayWriter()), { flag: "wx" });
                }
            }
        } finally {
            await reader.close();
        }
    } else {
        assert.ok(archive.endsWith(".tar.gz"), "unsupported artifact format");
        await tar.t({
            file: archive,
            strict: true,
            onReadEntry(entry) {
                assert.ok(entry.type === "File" || entry.type === "Directory", "archive contains a link or device");
                checkEntry(entry.path, entry.type === "Directory", entry.size);
            },
        });
        assert.equal(seen.size, expectedFiles.size + expectedDirectories.size, "archive inventory is incomplete");
        fs.mkdirSync(extractionRoot, { recursive: true });
        await tar.x({ file: archive, cwd: extractionRoot, strict: true, preserveOwner: false });
    }
    const root = path.join(extractionRoot, manifest.rootDirectory);
    const observed = packageFileInventory(root);
    assert.deepEqual(observed.directories, manifest.directories, "extracted directory graph changed");
    const withoutMode = (files) => files.map(({ mode, ...file }) => file);
    assert.deepEqual(withoutMode(observed.files), withoutMode(manifest.files), "extracted file bytes changed");
    if (manifest.platform === "linux" && process.platform !== "win32")
        assert.deepEqual(observed.files, manifest.files, "Linux executable modes changed");
    return Object.freeze({ root, manifest });
}
