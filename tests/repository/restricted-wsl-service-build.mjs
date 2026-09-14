import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";
import { LINUX_LOCK_ARTIFACT, LINUX_LOCK_CONTRACT } from "./linux-file-lock-build.mjs";

/** Build the actual Bootstrap entry with one static Unix-like Shared backend. No service is launched. */
export async function buildRestrictedWslService(repositoryRoot, outputRoot) {
    const graph = resolveWorkspaceGraph(repositoryRoot);
    const alias = Object.fromEntries(
        graph.packages.map((entry) => [entry.name, path.join(repositoryRoot, entry.relativePath, "src/index.ts")]),
    );
    delete alias["@oaam/shared"];
    alias["@oaam/core/adapter-spi"] = path.join(repositoryRoot, "packages/core/src/adapter-spi.ts");
    alias["@oaam/core/restricted-operations"] = path.join(repositoryRoot, "packages/core/src/restricted-operations.ts");
    alias["@oaam/adapter-codex/restricted-probe"] = path.join(
        repositoryRoot,
        "packages/adapter/providers/codex/src/restricted-probe.ts",
    );
    alias["@oaam/app-server-host/restricted-transport"] = path.join(
        repositoryRoot,
        "packages/app-server/host/src/restricted-transport.ts",
    );
    alias["@oaam/shared/filesystem"] = path.join(
        repositoryRoot,
        "packages/shared/src/paths/unix-like/filesystem-target-entry.ts",
    );
    alias["@oaam/shared/paths"] = path.join(repositoryRoot, "packages/shared/src/paths/unix-like/path-environment.ts");
    const output = path.join(outputRoot, "restricted-wsl.cjs");
    const built = await build({
        absWorkingDir: repositoryRoot,
        entryPoints: ["packages/app-server/bootstrap/src/restricted-wsl-entry.ts"],
        outfile: output,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22",
        metafile: true,
        logLevel: "silent",
        alias,
        external: ["better-sqlite3"],
    });
    fs.writeFileSync(output + ".inputs.json", JSON.stringify(built.metafile, null, 2) + "\n", { flag: "wx" });
    const included = Object.values(built.metafile.outputs).flatMap((entry) =>
        Object.entries(entry.inputs)
            .filter(([, value]) => value.bytesInOutput > 0)
            .map(([name, value]) => ({ path: name, bytes: value.bytesInOutput })),
    );
    const stateInputs = included.filter((entry) =>
        /packages\/core\/src\/(persistence|orchestration\/core-service)/.test(entry.path),
    );
    const windowsInputs = included.filter((entry) => /packages\/shared\/src\/paths\/win32\//.test(entry.path));
    assert.equal(windowsInputs.length, 0, "restricted service must use only its static Unix-like backend");
    assert.equal(stateInputs.length, 0, "restricted service must not include OAAM State or ordinary CoreService bootstrap");
    const workers = [];
    for (const relativeEntry of ["packages/adapter/providers/opencode/src/opencode-compatibility-project-reader.ts"]) {
        const destination = path.join(outputRoot, path.basename(relativeEntry, ".ts") + ".js");
        const worker = await build({
            absWorkingDir: repositoryRoot,
            entryPoints: [relativeEntry],
            outfile: destination,
            bundle: true,
            platform: "node",
            format: "cjs",
            target: "node22",
            metafile: true,
            logLevel: "silent",
            alias,
            external: ["better-sqlite3", "better-sqlite3/package.json"],
        });
        const emitted = Object.values(worker.metafile.outputs).flatMap((entry) =>
            Object.entries(entry.inputs)
                .filter(([, value]) => value.bytesInOutput > 0)
                .map(([name]) => name),
        );
        assert.ok(
            !emitted.some((name) =>
                /packages\/core\/src\/(persistence|orchestration\/core-service)|packages\/shared\/src\/paths\/win32\//.test(name),
            ),
            "restricted worker has a foreign backend or State dependency",
        );
        fs.writeFileSync(destination + ".inputs.json", JSON.stringify(worker.metafile, null, 2) + "\n", { flag: "wx" });
        workers.push(path.basename(destination));
    }
    // These are existing Provider read-only metadata readers, not OAAM State.
    const require = createRequire(path.join(repositoryRoot, "package.json"));
    const files = ["restricted-wsl.cjs", ...workers, "package.json", "node"];
    function copyPackageFile(packageName, relativeFile) {
        const packageRoot = path.dirname(require.resolve(packageName + "/package.json"));
        const source = path.join(packageRoot, relativeFile);
        assert.ok(fs.lstatSync(source).isFile(), "payload dependencies must be regular files");
        const relative = `node_modules/${packageName}/${relativeFile}`;
        const destination = path.join(outputRoot, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        files.push(relative);
    }
    function copyPackageTree(packageName, relativeDirectory) {
        const packageRoot = path.dirname(require.resolve(packageName + "/package.json"));
        for (const entry of fs.readdirSync(path.join(packageRoot, relativeDirectory), { withFileTypes: true })) {
            const relative = path.posix.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) copyPackageTree(packageName, relative);
            else {
                assert.ok(entry.isFile());
                copyPackageFile(packageName, relative);
            }
        }
    }
    copyPackageTree("better-sqlite3", "lib");
    for (const [packageName, entries] of [
        ["better-sqlite3", ["package.json", "build/Release/better_sqlite3.node"]],
        ["bindings", ["package.json", "bindings.js"]],
        ["file-uri-to-path", ["package.json", "index.js"]],
    ])
        for (const entry of entries) copyPackageFile(packageName, entry);
    assert.equal(process.platform, "linux", "target payload must be assembled with a Linux Node/native dependency pair");
    assert.equal(process.arch, "x64", "the current Linux physical helper is verified for x64");
    const physicalHelper = path.join(repositoryRoot, "packages/shared/dist/paths/unix-like/oaam_linux_file_mutation");
    const helperInventory = JSON.parse(
        fs.readFileSync(path.join(path.dirname(physicalHelper), "linux-helper-inventory.json"), "utf8"),
    );
    assert.equal(helperInventory.target, "linux-x64");
    assert.equal(hash(physicalHelper), helperInventory.sha256, "physical helper differs from its built inventory");
    assert.ok(fs.lstatSync(physicalHelper).isFile() && !fs.lstatSync(physicalHelper).isSymbolicLink());
    fs.copyFileSync(physicalHelper, path.join(outputRoot, "oaam_linux_file_mutation"), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(outputRoot, "oaam_linux_file_mutation"), 0o700);
    files.push("oaam_linux_file_mutation");
    const lockModule = path.join(repositoryRoot, "packages/shared", LINUX_LOCK_ARTIFACT);
    const lockInventory = JSON.parse(fs.readFileSync(path.join(path.dirname(lockModule), "file-lock-inventory.json"), "utf8"));
    assert.equal(lockInventory.target, "linux-x64");
    assert.equal(lockInventory.contractVersion, LINUX_LOCK_CONTRACT);
    assert.equal(hash(lockModule), lockInventory.sha256, "Linux lock module differs from its built inventory");
    assert.ok(fs.lstatSync(lockModule).isFile() && !fs.lstatSync(lockModule).isSymbolicLink());
    assert.equal(fs.statSync(lockModule).size, lockInventory.bytes);
    fs.mkdirSync(path.join(outputRoot, "native"));
    fs.copyFileSync(lockModule, path.join(outputRoot, "native/oaam_file_lock.node"), fs.constants.COPYFILE_EXCL);
    files.push("native/oaam_file_lock.node");
    fs.copyFileSync(fs.realpathSync(process.execPath), path.join(outputRoot, "node"), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(outputRoot, "node"), 0o700);
    fs.writeFileSync(path.join(outputRoot, "package.json"), '{"private":true,"type":"commonjs"}\n', { flag: "wx" });
    const manifest = {
        schemaVersion: 1,
        platform: "linux",
        architecture: process.arch,
        nodeVersion: process.versions.node,
        nodeModulesVersion: process.versions.modules,
        files: files.sort().map((relativePath) => ({
            relativePath,
            sha256: hash(path.join(outputRoot, relativePath)),
            bytes: fs.statSync(path.join(outputRoot, relativePath)).size,
            executable: relativePath === "node" || relativePath === "oaam_linux_file_mutation",
        })),
    };
    fs.writeFileSync(path.join(outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const archive = gzipSync(makeTar(outputRoot, manifest.files));
    fs.writeFileSync(path.join(outputRoot, "payload.tgz"), archive, { flag: "wx" });
    const result = {
        entry: output,
        sha256: hash(output),
        bytes: fs.statSync(output).size,
        stateInputs,
        workers,
        manifestSha256: hash(path.join(outputRoot, "manifest.json")),
        payloadSha256: hash(path.join(outputRoot, "payload.tgz")),
        payloadBytes: archive.byteLength,
        windowsInputs,
    };
    fs.writeFileSync(path.join(outputRoot, "build-result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    return result;
}

function hash(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Fixed regular-file-only USTAR payload; no links, devices, absolute names or arbitrary archive inputs. */
function makeTar(root, files) {
    const chunks = [];
    for (const file of files) {
        assert.match(file.relativePath, /^[A-Za-z0-9_./-]+$/);
        assert.ok(
            !file.relativePath.startsWith("/") &&
                !file.relativePath.split("/").includes("..") &&
                Buffer.byteLength(file.relativePath) <= 100,
        );
        const bytes = fs.readFileSync(path.join(root, file.relativePath));
        assert.equal(bytes.byteLength, file.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
        const header = Buffer.alloc(512);
        header.write(file.relativePath, 0, 100, "ascii");
        const octal = (offset, length, value) =>
            header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
        octal(100, 8, file.executable ? 0o700 : 0o600);
        octal(108, 8, 0);
        octal(116, 8, 0);
        octal(124, 12, bytes.byteLength);
        octal(136, 12, 0);
        header.fill(32, 148, 156);
        header[156] = 48;
        header.write("ustar\0", 257, 6, "ascii");
        header.write("00", 263, 2, "ascii");
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
        chunks.push(header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512));
    }
    return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-wsl-service-"));
    try {
        console.log(JSON.stringify(await buildRestrictedWslService(process.cwd(), outputRoot), null, 2));
    } finally {
        stop();
    }
}
