import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WSL_HELPER_NATIVE_FILES = Object.freeze(["wsl-helper/oaam-wsl-file-mutation.cc", "wsl-helper/sha256.h"]);

const WSL_HELPER_PROOF_FIXTURE = "tests/repository/fixtures/wsl-file-mutation-helper-proof.mjs";
const WSL_HELPER_SHA256_PROOF_FIXTURE = "tests/repository/fixtures/wsl-sha256-proof.mjs";
const DIRECTORY_HELPER_LIFECYCLE_PROOF = "tests/repository/fixtures/linux-directory-helper-lifecycle-proof.mjs";

function hasExactKeys(value, expectedKeys) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort())
    );
}

export function validateSelectedWslMutationHelperSource(sourcePathOrPaths) {
    const sourcePaths = Array.isArray(sourcePathOrPaths) ? sourcePathOrPaths : [sourcePathOrPaths];
    const source = sourcePaths.map((sourcePath) => fs.readFileSync(sourcePath, "utf8")).join("\n");
    const errors = [];
    const requiredFragments = [
        '#error "OAAM\'s selected-WSL mutation helper may only be built for Linux."',
        "RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS",
        "syscall(SYS_openat2",
        "RENAME_NOREPLACE",
        "fsync(source_parent)",
        "fsync(destination_parent.get())",
        'if (argc != 4 || std::string_view(argv[1]) != "--owned-parent") return false;',
        'open("/proc/self/exe"',
        'std::string_view(value.machine) == "x86_64"',
        "ScopedMemoryZero",
        "Operation::publish_directory",
        "Operation::publish_file",
        "TestFault::directory_target_race",
        "BindOwnedParent",
        "PR_SET_PDEATHSIG",
        "alarm(5U)",
        "request.expected_identity",
        "SameIdentity(source, request.expected_identity)",
        "OAAM_WSL_FILE_MUTATION_TEST_FAULTS",
    ];
    for (const fragment of requiredFragments) {
        if (!source.includes(fragment)) errors.push(`selected-WSL helper is missing reviewed primitive: ${fragment}`);
    }
    const forbidden = [
        /\b(?:system|popen|execv|execve|execl|fork|vfork|clone|socket|connect|getenv|putenv|setenv|unsetenv|dlopen)\s*\(/u,
        /\b(?:PATH|HOME)\b/u,
        /STDERR_FILENO|std::filesystem|std::(?:cout|cerr)|<sys\/socket\.h>/u,
    ];
    for (const pattern of forbidden) {
        if (pattern.test(source)) errors.push(`selected-WSL helper contains forbidden ambient primitive ${String(pattern)}`);
    }
    if ((source.match(/\bint main\s*\(/gu) ?? []).length !== 1) {
        errors.push("selected-WSL helper must have exactly one private process entrypoint");
    }
    return errors;
}

export function buildAndProveSelectedWslMutationHelper({
    targetRoot,
    inventoryPath,
    repositoryRoot,
    nativeRoot,
    runCommand,
    appendEvent,
}) {
    const compiler = fs.realpathSync("/usr/bin/x86_64-linux-gnu-g++-11");
    const compilerStat = fs.lstatSync(compiler);
    if (compiler !== "/usr/bin/x86_64-linux-gnu-g++-11" || compilerStat.isSymbolicLink() || !compilerStat.isFile()) {
        throw new Error("selected-WSL helper requires the reviewed Ubuntu x86_64 g++ 11 toolchain");
    }
    const version = runCommand("selected-WSL helper compiler version", compiler, [
        "-dumpfullversion",
        "-dumpversion",
    ]).stdout.trim();
    if (version !== "11.4.0") throw new Error(`selected-WSL helper compiler version drifted to ${version}`);
    const toolchainArtifacts = [
        "ld",
        "libstdc++.a",
        "libgcc.a",
        "libc.a",
        "Scrt1.o",
        "crti.o",
        "crtbeginS.o",
        "crtendS.o",
        "crtn.o",
    ].map((name) => {
        const reported = runCommand(`selected-WSL helper ${name} location`, compiler, [
            name === "ld" ? "-print-prog-name=ld" : `-print-file-name=${name}`,
        ]).stdout.trim();
        const resolved = fs.realpathSync(name === "ld" && !path.isAbsolute(reported) ? `/usr/bin/${reported}` : reported);
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`selected-WSL helper toolchain artifact ${name} is not a regular file`);
        }
        return Object.freeze({
            name,
            path: resolved,
            sha256: crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex"),
        });
    });
    const sourcePaths = WSL_HELPER_NATIVE_FILES.map((relativePath) => path.join(targetRoot, ...relativePath.split("/")));
    const sourcePath = sourcePaths.find((candidate) => candidate.endsWith("oaam-wsl-file-mutation.cc"));
    if (sourcePath === undefined) throw new Error("selected-WSL helper source closure has no process entrypoint");
    const outputRoots = ["wsl-helper-build-a", "wsl-helper-build-b"].map((name) => path.join(targetRoot, name));
    for (const root of outputRoots) fs.mkdirSync(root);
    const outputs = outputRoots.map((root) => path.join(root, "oaam_wsl_file_mutation"));
    const faultOutputRoot = path.join(targetRoot, "wsl-helper-build-fault");
    fs.mkdirSync(faultOutputRoot);
    const faultOutput = path.join(faultOutputRoot, "oaam_wsl_file_mutation_faults");
    const commonArguments = [
        "-std=c++20",
        "-O2",
        "-pthread",
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
        `-ffile-prefix-map=${targetRoot}=.`,
        sourcePath,
    ];
    for (const outputPath of outputs) {
        runCommand("selected-WSL helper reproducible build", compiler, [...commonArguments, "-o", outputPath], {
            cwd: targetRoot,
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        });
    }
    runCommand(
        "selected-WSL helper fault build",
        compiler,
        [...commonArguments, "-DOAAM_WSL_FILE_MUTATION_TEST_FAULTS=1", "-o", faultOutput],
        { cwd: targetRoot, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
    );
    const outputBytes = outputs.map((outputPath) => fs.readFileSync(outputPath));
    if (!outputBytes[0].equals(outputBytes[1])) {
        throw new Error("selected-WSL helper reproducible builds are not byte-identical");
    }
    const dynamic = runCommand("selected-WSL helper dynamic inventory", "/usr/bin/readelf", ["-d", outputs[0]]).stdout;
    const elfHeader = runCommand("selected-WSL helper ELF header", "/usr/bin/readelf", ["-h", outputs[0]]).stdout;
    const program = runCommand("selected-WSL helper program inventory", "/usr/bin/readelf", ["-l", outputs[0]]).stdout;
    const binaryKind = runCommand("selected-WSL helper binary kind", "/usr/bin/file", ["--brief", outputs[0]]).stdout.trim();
    const outputStat = fs.lstatSync(outputs[0]);
    if (
        dynamic.includes("(NEEDED)") ||
        program.includes("INTERP") ||
        !/Type:\s+DYN \(Position-Independent Executable file\)/u.test(elfHeader) ||
        !/Machine:\s+Advanced Micro Devices X86-64/u.test(elfHeader) ||
        !/GNU_STACK[\s\S]{0,300}\sRW\s/u.test(program) ||
        /GNU_STACK[\s\S]{0,300}\sRWE\s/u.test(program) ||
        !program.includes("GNU_RELRO") ||
        !binaryKind.includes("ELF 64-bit LSB pie executable") ||
        !binaryKind.includes("x86-64") ||
        !binaryKind.includes("static-pie linked") ||
        outputStat.isSymbolicLink() ||
        !outputStat.isFile() ||
        (outputStat.mode & 0o111) === 0 ||
        outputStat.size <= 0 ||
        outputStat.size > 4 * 1_024 * 1_024
    ) {
        throw new Error("selected-WSL helper is not the reviewed dependency-free Linux x86_64 static PIE");
    }
    const sha256 = crypto.createHash("sha256").update(outputBytes[0]).digest("hex");
    appendEvent(inventoryPath, {
        event: "selected_wsl_helper_build_passed",
        source: `${nativeRoot}/${WSL_HELPER_NATIVE_FILES[0]}`,
        sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
        sources: sourcePaths.map((candidate, index) => ({
            path: `${nativeRoot}/${WSL_HELPER_NATIVE_FILES[index]}`,
            sha256: crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
        })),
        compiler,
        compilerVersion: version,
        compilerSha256: crypto.createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"),
        toolchainArtifacts,
        command: [...commonArguments.slice(0, -1), "<reviewed-source-closure>", "-o", "<owned-output>"],
        outputSha256: sha256,
        outputBytes: outputBytes[0].byteLength,
        reproducibleCopies: 2,
        faultOutputSha256: crypto.createHash("sha256").update(fs.readFileSync(faultOutput)).digest("hex"),
    });

    const proofPath = path.join(repositoryRoot, ...WSL_HELPER_PROOF_FIXTURE.split("/"));
    const helperProof = runCommand(
        "selected-WSL helper raw durability proof",
        process.execPath,
        [proofPath, outputs[0], faultOutput, path.dirname(inventoryPath)],
        { cwd: repositoryRoot, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: "/tmp" } },
    );
    const helperProofRecord = JSON.parse(helperProof.stdout.trim());
    if (
        !hasExactKeys(helperProofRecord, [
            "architecture",
            "faultSha256",
            "observations",
            "platform",
            "productionSha256",
            "residue",
            "schemaVersion",
            "status",
        ]) ||
        helperProofRecord.schemaVersion !== 1 ||
        helperProofRecord.status !== "pass" ||
        helperProofRecord.platform !== "linux" ||
        helperProofRecord.architecture !== "x64" ||
        helperProofRecord.productionSha256 !== sha256 ||
        !Array.isArray(helperProofRecord.observations) ||
        helperProofRecord.observations.length !== 18 ||
        JSON.stringify(helperProofRecord.residue) !== "[]"
    ) {
        throw new Error("selected-WSL helper raw durability proof returned an invalid receipt");
    }
    appendEvent(inventoryPath, {
        event: "selected_wsl_helper_raw_proof_passed",
        fixture: WSL_HELPER_PROOF_FIXTURE,
        fixtureSha256: crypto.createHash("sha256").update(fs.readFileSync(proofPath)).digest("hex"),
        ...helperProofRecord,
    });

    const hashProofPath = path.join(repositoryRoot, ...WSL_HELPER_SHA256_PROOF_FIXTURE.split("/"));
    const hashHeaderPath = path.join(targetRoot, "wsl-helper", "sha256.h");
    const hashProof = runCommand(
        "selected-WSL helper SHA-256 compression proof",
        process.execPath,
        [hashProofPath, hashHeaderPath, compiler, path.dirname(inventoryPath)],
        { cwd: repositoryRoot, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: "/tmp" } },
    );
    const hashProofRecord = JSON.parse(hashProof.stdout.trim());
    if (
        !hasExactKeys(hashProofRecord, ["schemaVersion", "status", "sourceSha256", "casesPerMode", "results", "residue"]) ||
        hashProofRecord.schemaVersion !== 1 ||
        hashProofRecord.status !== "pass" ||
        hashProofRecord.sourceSha256 !== crypto.createHash("sha256").update(fs.readFileSync(hashHeaderPath)).digest("hex") ||
        hashProofRecord.casesPerMode !== 1489 ||
        !Array.isArray(hashProofRecord.results) ||
        hashProofRecord.results.length !== 2 ||
        !["automatic", "portable"].every((mode, index) => {
            const result = hashProofRecord.results[index];
            return (
                result.mode === mode &&
                result.cases === 1489 &&
                result.guardPage === "pass" &&
                typeof result.hardwareAvailable === "boolean" &&
                (mode !== "portable" || !result.hardwareAvailable) &&
                /^[0-9a-f]{64}$/u.test(result.executableSha256) &&
                Number.isFinite(result.largeSampleMilliseconds)
            );
        }) ||
        JSON.stringify(hashProofRecord.residue) !== "[]"
    ) {
        throw new Error("selected-WSL helper SHA-256 compression proof returned an invalid receipt");
    }
    appendEvent(inventoryPath, {
        event: "selected_wsl_helper_sha256_proof_passed",
        fixture: WSL_HELPER_SHA256_PROOF_FIXTURE,
        fixtureSha256: crypto.createHash("sha256").update(fs.readFileSync(hashProofPath)).digest("hex"),
        ...hashProofRecord,
    });
    const lifecyclePath = path.join(repositoryRoot, DIRECTORY_HELPER_LIFECYCLE_PROOF);
    const lifecycleProof = runCommand(
        "Linux directory helper parent-death proof",
        process.execPath,
        [lifecyclePath, outputs[0], faultOutput, path.dirname(inventoryPath)],
        { cwd: repositoryRoot, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: "/tmp" } },
    );
    const lifecycle = JSON.parse(lifecycleProof.stdout.trim());
    if (
        !hasExactKeys(lifecycle, [
            "schemaVersion",
            "status",
            "observations",
            "owned",
            "helperSha256",
            "faultHelperSha256",
            "residual",
        ]) ||
        lifecycle.schemaVersion !== 1 ||
        lifecycle.status !== "pass" ||
        lifecycle.helperSha256 !== sha256 ||
        lifecycle.faultHelperSha256 !== crypto.createHash("sha256").update(fs.readFileSync(faultOutput)).digest("hex") ||
        JSON.stringify(lifecycle.observations) !==
            JSON.stringify([
                "parent_birth_mismatch_refused_before_mutation",
                "unbound_process_refused",
                "helper_self_deadline_stops_a_stalled_publication",
                "parent_death_kills_the_exact_paused_helper",
            ]) ||
        JSON.stringify(lifecycle.residual) !== "[]"
    )
        throw new Error("Linux directory helper lifecycle proof is invalid");
    appendEvent(inventoryPath, {
        event: "linux_directory_helper_lifecycle_proof_passed",
        fixture: DIRECTORY_HELPER_LIFECYCLE_PROOF,
        fixtureSha256: crypto.createHash("sha256").update(fs.readFileSync(lifecyclePath)).digest("hex"),
        ...lifecycle,
    });
    return Object.freeze({ helperPath: outputs[0], faultHelperPath: faultOutput, sha256 });
}
