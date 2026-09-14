import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [headerPath, compiler, ownedParent] = process.argv.slice(2);
for (const file of [headerPath, compiler]) {
    assert.ok(file && path.isAbsolute(file));
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
}
assert.equal(compiler, "/usr/bin/x86_64-linux-gnu-g++-11");
assert.ok(ownedParent && fs.lstatSync(ownedParent).isDirectory() && !fs.lstatSync(ownedParent).isSymbolicLink());
const root = fs.mkdtempSync(path.join(ownedParent, "oaam-sha256-proof-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = fs.readFileSync(headerPath);
fs.writeFileSync(path.join(root, "sha256.h"), source, { flag: "wx" });
const sourceSha256 = sha256(source);

const program = String.raw`
#include "sha256.h"
#include <chrono>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <sys/mman.h>
#include <unistd.h>
using namespace oaam::wsl_file_mutation;
void PrintHash(const std::array<std::uint8_t,32>& hash) {
    for (const auto byte : hash) std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(byte);
    std::cout << std::dec;
}
void CheckGuardPage() {
    const long page_value = sysconf(_SC_PAGESIZE);
    if (page_value < 64) throw std::runtime_error("invalid page size");
    const auto page = static_cast<std::size_t>(page_value);
    void* mapping = mmap(nullptr,page*3U,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if (mapping == MAP_FAILED) throw std::runtime_error("guard mmap failed");
    auto* middle = static_cast<std::uint8_t*>(mapping)+page;
    if (mprotect(middle,page,PROT_READ|PROT_WRITE)!=0) throw std::runtime_error("guard mprotect failed");
    for (std::size_t i=0;i<page;++i) middle[i]=static_cast<std::uint8_t>(i&255U);
    Sha256 automatic, portable;
    CompressSha256(automatic,middle+page-64U);
    CompressSha256Portable(portable,middle+page-64U);
    if (automatic.state != portable.state) throw std::runtime_error("guard block differs");
    for (const std::size_t size : {1U,55U,56U,63U,64U,65U,127U,128U,129U}) {
        Sha256 guarded, copied;
        std::vector<std::uint8_t> value(middle+page-size,middle+page);
        UpdateSha256(guarded,middle+page-size,size);
        UpdateSha256(copied,value.data(),size);
        if (FinishSha256(guarded)!=FinishSha256(copied)) throw std::runtime_error("guard update differs");
    }
    if (munmap(mapping,page*3U)!=0) throw std::runtime_error("guard munmap failed");
}
int main() {
    CheckGuardPage();
    std::cout << "capability " << HardwareSha256Available() << " guard_page_complete\n";
    std::size_t size=0,chunk=0;
    std::uint32_t seed=0,pattern=0;
    while (std::cin >> size >> chunk >> seed >> pattern) {
        if (size>268435456U || chunk==0 || chunk>268435457U || pattern>4U) return 2;
        const std::size_t offset=(seed%15U)+1U;
        std::vector<std::uint8_t> storage(size+offset);
        auto* bytes=storage.data()+offset;
        std::uint32_t state=seed;
        for (std::size_t i=0;i<size;++i) {
            state=state*1664525U+1013904223U;
            bytes[i]=pattern==0U ? static_cast<std::uint8_t>(state>>24U) :
                pattern==1U ? 0U : pattern==2U ? 255U : pattern==3U ? 97U :
                static_cast<std::uint8_t>(97U+(i%3U));
        }
        Sha256 hash;
        UpdateSha256(hash,nullptr,0);
        const auto started=std::chrono::steady_clock::now();
        for (std::size_t i=0;i<size;i+=chunk) UpdateSha256(hash,bytes+i,std::min(chunk,size-i));
        const auto digest=FinishSha256(hash);
        const auto ended=std::chrono::steady_clock::now();
        if (FinishSha256(hash)!=digest) return 3;
        const std::uint8_t suffix=0x5aU;
        UpdateSha256(hash,&suffix,1);
        std::cout << size << " " << chunk << " " << seed << " " << pattern << " ";
        PrintHash(digest); std::cout << " "; PrintHash(FinishSha256(hash));
        std::cout << " " << std::chrono::duration<double,std::milli>(ended-started).count() << "\n";
    }
}
`;
const programPath = path.join(root, "proof.cc");
fs.writeFileSync(programPath, program, { flag: "wx" });

function processRows() {
    return fs
        .readdirSync("/proc")
        .filter((name) => /^\d+$/u.test(name))
        .flatMap((name) => {
            try {
                const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
                const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                return [{ pid: Number(name), group: Number(fields[2]), start: fields[19] }];
            } catch {
                return [];
            }
        });
}

const executions = [];
async function run(name, executable, args, input = "") {
    const started = Date.now();
    const child = spawn(executable, args, {
        cwd: root,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: "/tmp" },
    });
    let identity;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const kill = () => {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
        }
    };
    const timer = setTimeout(() => {
        timedOut = true;
        kill();
    }, 60_000);
    child.stdout.on("data", (bytes) => {
        stdout += bytes;
        if (stdout.length > 2_000_000) kill();
    });
    child.stderr.on("data", (bytes) => {
        stderr += bytes;
        if (stderr.length > 64_000) kill();
    });
    child.once("spawn", () => {
        identity = processRows().find((row) => row.pid === child.pid);
        child.stdin.end(input);
    });
    const terminal = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    const residue = processRows().filter((row) => row.group === child.pid);
    if (residue.length > 0) kill();
    const execution = {
        name,
        executable,
        args,
        identity,
        elapsedMilliseconds: Date.now() - started,
        ...terminal,
        timedOut,
        residue,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
    };
    executions.push(execution);
    fs.writeFileSync(path.join(root, `${name}.stdout`), stdout, { flag: "wx" });
    fs.writeFileSync(path.join(root, `${name}.stderr`), stderr, { flag: "wx" });
    assert.ok(identity && identity.group === identity.pid, "process identity was not bound");
    assert.deepEqual(residue, []);
    assert.equal(timedOut, false);
    assert.equal(terminal.code, 0, stderr);
    assert.equal(terminal.signal, null);
    assert.equal(stderr, "");
    return stdout;
}

const cases = [];
function add(size, chunk, seed, pattern = 0) {
    cases.push({ size, chunk, seed, pattern });
}
for (let size = 0; size <= 129; size += 1) {
    for (const chunk of [1, 7, 55, 56, 63, 64, 65, 127, 128, 129]) add(size, chunk, size + 1);
}
for (const size of [16_383, 16_384, 16_385, 1_048_576]) {
    for (const chunk of [63, 64, 65, 16_383, 16_384, 16_385]) add(size, chunk, 0x9e3779b9);
}
for (let index = 0; index < 128; index += 1) add((index * 1031 + 17) % 8193, ((index * 137 + 3) % 1025) + 1, index + 91);
for (const pattern of [1, 2, 3, 4]) {
    for (const size of [0, 3, 55, 56, 63, 64, 65, 257, 1_000_000]) add(size, 137, 41, pattern);
}
add(268_435_456, 16_384, 12345);
const expected = new Map();
function expectedHash(value) {
    const key = `${value.size}:${value.seed}:${value.pattern}`;
    if (!expected.has(key)) {
        const bytes = Buffer.alloc(value.size);
        let state = value.seed;
        for (let i = 0; i < bytes.length; i += 1) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            bytes[i] =
                value.pattern === 0
                    ? state >>> 24
                    : value.pattern === 1
                      ? 0
                      : value.pattern === 2
                        ? 255
                        : value.pattern === 3
                          ? 97
                          : 97 + (i % 3);
        }
        expected.set(key, [
            sha256(bytes),
            createHash("sha256")
                .update(bytes)
                .update(Buffer.from([0x5a]))
                .digest("hex"),
        ]);
    }
    return expected.get(key);
}
const input = cases.map((value) => `${value.size} ${value.chunk} ${value.seed} ${value.pattern}\n`).join("");
fs.writeFileSync(path.join(root, "cases.txt"), input, { flag: "wx" });
const results = [];
try {
    for (const mode of ["automatic", "portable"]) {
        const executable = path.join(root, `proof-${mode}`);
        await run(`compile-${mode}`, compiler, [
            "-std=c++20",
            "-O2",
            "-static-pie",
            "-fPIE",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wconversion",
            "-Wsign-conversion",
            "-fstack-protector-strong",
            "-D_FORTIFY_SOURCE=2",
            "-Wl,-z,relro,-z,now,-z,noexecstack,--build-id=none",
            ...(mode === "portable" ? ["-DOAAM_WSL_FILE_MUTATION_TEST_FAULTS=1", "-DOAAM_WSL_SHA256_FORCE_PORTABLE=1"] : []),
            programPath,
            "-o",
            executable,
        ]);
        const stdout = await run(`run-${mode}`, executable, [], input);
        const [capability, ...lines] = stdout.trim().split("\n");
        assert.match(capability, /^capability [01] guard_page_complete$/u);
        if (mode === "portable") assert.equal(capability, "capability 0 guard_page_complete");
        assert.equal(lines.length, cases.length);
        let largeSampleMilliseconds;
        for (const [index, line] of lines.entries()) {
            const [size, chunk, seed, pattern, digest, extended, ms] = line.split(" ");
            const value = cases[index];
            assert.deepEqual([Number(size), Number(chunk), Number(seed), Number(pattern)], Object.values(value));
            assert.deepEqual([digest, extended], expectedHash(value), `${mode} case ${index}`);
            assert.ok(Number.isFinite(Number(ms)) && Number(ms) >= 0);
            if (index === cases.length - 1) largeSampleMilliseconds = Number(ms);
        }
        results.push({
            mode,
            hardwareAvailable: capability.includes(" 1 "),
            cases: lines.length,
            executableSha256: sha256(fs.readFileSync(executable)),
            guardPage: "pass",
            largeSampleMilliseconds,
        });
    }
    assert.equal(sha256(fs.readFileSync(headerPath)), sourceSha256);
    const result = { schemaVersion: 1, status: "pass", sourceSha256, casesPerMode: cases.length, results, residue: [] };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ ...result, executions }, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(result));
} catch (error) {
    fs.writeFileSync(path.join(root, "failure.json"), JSON.stringify({ error: String(error), executions }, null, 2) + "\n", {
        flag: "wx",
    });
    throw error;
}
