/** Reuse the reviewed static helper build/proof closure for the Linux Shared target. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    buildAndProveSelectedWslMutationHelper,
    validateSelectedWslMutationHelperSource,
    WSL_HELPER_NATIVE_FILES,
} from "./windows-selected-wsl-mutation-helper.mjs";

export function buildLinuxPhysicalHelper(repositoryRoot) {
    assert.equal(process.platform, "linux", "Linux helper assembly requires its Linux target toolchain");
    assert.equal(process.arch, "x64", "the current helper's reviewed build target is Linux x64");
    const nativeRoot = "packages/shared/src/paths/win32/native";
    const sources = WSL_HELPER_NATIVE_FILES.map((name) => path.join(repositoryRoot, nativeRoot, name));
    assert.deepEqual(validateSelectedWslMutationHelperSource(sources), []);
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-linux-helper-build-"));
    const targetRoot = path.join(workRoot, "source");
    fs.mkdirSync(targetRoot);
    for (const [index, name] of WSL_HELPER_NATIVE_FILES.entries()) {
        const destination = path.join(targetRoot, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(sources[index], destination, fs.constants.COPYFILE_EXCL);
    }
    const inventoryPath = path.join(workRoot, "inventory.jsonl");
    const events = [];
    const appendEvent = (file, value) => {
        events.push(value);
        fs.appendFileSync(file, JSON.stringify(value) + "\n");
    };
    const runCommand = (label, executable, args, options = {}) => {
        const result = spawnSync("/usr/bin/timeout", ["--kill-after=2s", "60s", executable, ...args], {
            cwd: options.cwd ?? repositoryRoot,
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: "/tmp" },
            encoding: "utf8",
            stdio: "pipe",
            timeout: 65_000,
            killSignal: "SIGKILL",
            maxBuffer: 8 * 1024 * 1024,
        });
        appendEvent(inventoryPath, {
            event: "command",
            label,
            executable,
            args,
            status: result.status,
            signal: result.signal,
            error: result.error?.message,
        });
        if (result.error !== undefined || result.status !== 0)
            throw new Error(`${label} failed; ${String(result.stderr)}; build evidence retained at ${workRoot}`);
        return { stdout: result.stdout, stderr: result.stderr };
    };
    const built = buildAndProveSelectedWslMutationHelper({
        targetRoot,
        inventoryPath,
        repositoryRoot,
        nativeRoot,
        runCommand,
        appendEvent,
    });
    for (const [index, name] of WSL_HELPER_NATIVE_FILES.entries())
        assert.deepEqual(
            fs.readFileSync(sources[index]),
            fs.readFileSync(path.join(targetRoot, name)),
            "native source changed during build",
        );
    const destination = path.join(repositoryRoot, "packages/shared/dist/paths/unix-like/oaam_linux_file_mutation");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(built.helperPath, destination);
    fs.chmodSync(destination, 0o755);
    const helperBytes = fs.readFileSync(destination);
    assert.equal(createHash("sha256").update(helperBytes).digest("hex"), built.sha256);
    const record = {
        schemaVersion: 1,
        target: "linux-x64",
        file: path.basename(destination),
        sha256: built.sha256,
        bytes: helperBytes.length,
        executable: true,
        sources: WSL_HELPER_NATIVE_FILES.map((name, index) => ({
            path: `${nativeRoot}/${name}`,
            sha256: createHash("sha256").update(fs.readFileSync(sources[index])).digest("hex"),
        })),
        compiler: events.find((event) => event.event === "selected_wsl_helper_build_passed")?.compilerVersion,
    };
    fs.writeFileSync(path.join(path.dirname(destination), "linux-helper-inventory.json"), JSON.stringify(record, null, 2) + "\n");
    return { ...record, evidenceRoot: workRoot };
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    process.stdout.write(JSON.stringify(buildLinuxPhysicalHelper(repositoryRoot)) + "\n");
}
