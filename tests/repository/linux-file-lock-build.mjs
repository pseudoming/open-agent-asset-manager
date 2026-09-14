/** Build the exact private Linux Node-API lock module; no runtime or model process is launched. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LINUX_LOCK_SOURCE = "packages/shared/src/paths/unix-like/native/file-lock.cc";
export const LINUX_LOCK_ARTIFACT = "dist/paths/unix-like/native/oaam_file_lock.node";
export const LINUX_LOCK_CONTRACT = "oaam.linux.file-lock.v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateLinuxFileLockBoundary(repositoryRoot) {
    const source = path.join(repositoryRoot, LINUX_LOCK_SOURCE);
    const errors = [];
    if (
        !fs.existsSync(path.dirname(source)) &&
        !fs.existsSync(path.join(repositoryRoot, "tests/repository/linux-file-lock-build.mjs"))
    )
        return errors;
    try {
        const names = fs.readdirSync(path.dirname(source)).sort();
        if (JSON.stringify(names) !== '["file-lock.cc"]')
            errors.push("Linux native lock source inventory must contain only file-lock.cc");
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink()) errors.push("Linux lock source must be one regular file");
        const text = fs.readFileSync(source, "utf8");
        if (!text.includes('"oaam.linux.file-lock.v1"') || !text.includes("flock(fd, LOCK_EX | LOCK_NB)"))
            errors.push("Linux lock source must retain its exact private nonblocking contract");
        if (/\b(?:fork|execve|system|popen|dlopen|dlsym|unlink|rename|ftruncate|kill|open|write)\s*\(/u.test(text))
            errors.push("Linux lock bridge must not acquire process, file mutation or arbitrary FFI authority");
    } catch (error) {
        errors.push(`Linux lock source boundary unavailable: ${String(error)}`);
    }
    return errors;
}

export function buildLinuxFileLock(repositoryRoot) {
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "x64", "Linux lock delivery currently has exact x64 evidence");
    assert.deepEqual(validateLinuxFileLockBoundary(repositoryRoot), []);
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-linux-lock-build-"));
    const sourcePath = path.join(repositoryRoot, LINUX_LOCK_SOURCE);
    const source = fs.readFileSync(sourcePath);
    const input = path.join(evidenceRoot, "file-lock.cc");
    fs.writeFileSync(input, source, { flag: "wx" });
    const headersRoot = path.resolve(path.dirname(process.execPath), "../include/node");
    const headers = ["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h", "node_version.h"].map(
        (name) => ({
            name,
            sha256: digest(fs.readFileSync(path.join(headersRoot, name))),
        }),
    );
    const built = path.join(evidenceRoot, "oaam_file_lock.node");
    const args = [
        "--kill-after=2s",
        "30s",
        "/usr/bin/c++",
        "-shared",
        "-fPIC",
        "-O2",
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fvisibility=hidden",
        "-fstack-protector-strong",
        "-Wl,-z,relro,-z,now",
        "-DNAPI_VERSION=9",
        "-DNODE_GYP_MODULE_NAME=oaam_file_lock",
        "-I",
        headersRoot,
        input,
        "-o",
        built,
    ];
    const startedAt = Date.now();
    const result = spawnSync("/usr/bin/timeout", args, {
        cwd: evidenceRoot,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        encoding: "utf8",
        timeout: 35_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
    });
    const command = {
        executable: "/usr/bin/timeout",
        args,
        pid: result.pid,
        elapsedMs: Date.now() - startedAt,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
    };
    fs.writeFileSync(path.join(evidenceRoot, "compile.json"), JSON.stringify(command, null, 2) + "\n");
    fs.writeFileSync(path.join(evidenceRoot, "compile.stdout.log"), result.stdout ?? "");
    fs.writeFileSync(path.join(evidenceRoot, "compile.stderr.log"), result.stderr ?? "");
    assert.equal(result.error, undefined, `Linux lock compile did not complete; evidence: ${evidenceRoot}`);
    assert.equal(result.status, 0, `Linux lock compile failed; evidence: ${evidenceRoot}; ${result.stderr}`);
    assert.deepEqual(fs.readFileSync(sourcePath), source, "Linux lock source changed during build");
    for (const header of headers) assert.equal(digest(fs.readFileSync(path.join(headersRoot, header.name))), header.sha256);
    const bytes = fs.readFileSync(built);
    assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
    assert.equal(bytes[4], 2);
    assert.equal(bytes[5], 1);
    assert.equal(bytes.readUInt16LE(18), 62);
    const native = createRequire(import.meta.url)(built);
    assert.deepEqual(Object.keys(native).sort(), ["contractVersion", "tryAcquire"]);
    assert.equal(native.contractVersion, LINUX_LOCK_CONTRACT);
    assert.equal(typeof native.tryAcquire, "function");
    const target = path.join(repositoryRoot, "packages/shared", LINUX_LOCK_ARTIFACT);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(built, target);
    const manifest = {
        schemaVersion: 1,
        target: "linux-x64",
        napiVersion: 9,
        contractVersion: LINUX_LOCK_CONTRACT,
        file: "oaam_file_lock.node",
        bytes: bytes.length,
        sha256: digest(bytes),
        source: { path: LINUX_LOCK_SOURCE, sha256: digest(source) },
        headers,
        nodeVersion: process.versions.node,
    };
    fs.writeFileSync(path.join(path.dirname(target), "file-lock-inventory.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { ...manifest, evidenceRoot };
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.write(JSON.stringify(buildLinuxFileLock(process.cwd())) + "\n");
}
