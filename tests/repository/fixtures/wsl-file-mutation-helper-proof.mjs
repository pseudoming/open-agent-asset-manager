#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [helperPath, faultHelperPath, ownedParent] = process.argv.slice(2);
if (helperPath === undefined || faultHelperPath === undefined || ownedParent === undefined) {
    throw new Error("usage: wsl-file-mutation-helper-proof.mjs <helper> <fault-helper> <owned-parent>");
}
for (const [filePath, label] of [
    [helperPath, "production helper"],
    [faultHelperPath, "fault helper"],
]) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) {
        throw new Error(`${label} is not one executable regular file`);
    }
}
const parentStat = fs.lstatSync(ownedParent);
if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error("owned parent is not a regular directory");

const REQUEST_BYTES = 96;
const RECEIPT_BYTES = 200;
const fixtureRoot = fs.mkdtempSync(path.join(ownedParent, "oaam-wsl-helper-proof-"));
const root = path.join(fixtureRoot, "project");
const target = path.join(root, "CLAUDE.md");
fs.mkdirSync(root);

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest();
}

function request(input = {}) {
    const operation = input.operation ?? 1;
    const expected = input.expected ?? null;
    const payload = input.payload ?? Buffer.alloc(0);
    const rootPath = input.rootPath ?? root;
    const targetPath = input.targetPath ?? target;
    const rootBytes = Buffer.from(rootPath, "utf8");
    const targetBytes = Buffer.from(targetPath, "utf8");
    const header = Buffer.alloc(REQUEST_BYTES + (operation === 7 || operation === 8 ? 16 : 0));
    header.write(input.magic ?? "OAAMWFM1", 0, "ascii");
    header.writeUInt16LE(input.schemaVersion ?? (operation === 7 || operation === 8 ? 2 : operation === 9 ? 3 : 1), 8);
    header[10] = operation;
    header[11] =
        (expected === null && input.expectedIdentity === undefined ? 0 : 1) |
        (input.expectedExecutable === true ? 2 : 0) |
        (input.desiredExecutable === true ? 4 : 0);
    header[12] = input.fault ?? 0;
    header.writeUInt32LE(input.rootBytes ?? rootBytes.byteLength, 16);
    header.writeUInt32LE(input.targetBytes ?? targetBytes.byteLength, 20);
    header.writeBigUInt64LE(input.payloadBytes ?? BigInt(payload.byteLength), 24);
    (input.nonce ?? randomBytes(32)).copy(header, 32);
    if (input.expectedIdentity !== undefined) {
        header.writeBigUInt64LE(input.expectedIdentity.device, 64);
        header.writeBigUInt64LE(input.expectedIdentity.inode, 72);
    } else if (expected !== null) {
        sha256(expected).copy(header, 64);
    }
    if (operation === 7 || operation === 8) {
        const sourceParent = input.sourceParentIdentity ?? fs.lstatSync(rootPath, { bigint: true });
        const destinationParentPath =
            path.isAbsolute(payload.toString()) && !payload.includes(0) ? path.dirname(payload.toString()) : rootPath;
        const destinationParent = input.destinationParentIdentity ?? fs.lstatSync(destinationParentPath, { bigint: true });
        header.writeBigUInt64LE(destinationParent.dev, 80);
        header.writeBigUInt64LE(destinationParent.ino, 88);
        header.writeBigUInt64LE(sourceParent.dev, 96);
        header.writeBigUInt64LE(sourceParent.ino, 104);
    }
    return Buffer.concat([header, rootBytes, targetBytes, payload, input.trailing ?? Buffer.alloc(0)]);
}

function parseReceipt(bytes) {
    if (bytes.byteLength !== RECEIPT_BYTES || bytes.subarray(0, 8).toString("ascii") !== "OAAMWFR1") {
        throw new Error("helper returned a malformed bounded receipt");
    }
    return Object.freeze({
        schemaVersion: bytes.readUInt16LE(8),
        status: bytes[10],
        certainty: bytes[11],
        operation: bytes[12],
        failure: bytes[13],
        cleanupComplete: bytes[14] === 1,
        byteSize: Number(bytes.readBigUInt64LE(16)),
        targetBeforeDevice: bytes.readBigUInt64LE(56),
        targetBeforeInode: bytes.readBigUInt64LE(64),
        targetAfterDevice: bytes.readBigUInt64LE(72),
        targetAfterInode: bytes.readBigUInt64LE(80),
        contentSha256: bytes.subarray(104, 136).toString("hex"),
        helperSha256: bytes.subarray(136, 168).toString("hex"),
        nonce: bytes.subarray(168, 200).toString("hex"),
    });
}

async function run(executablePath, frame) {
    return await new Promise((resolve, reject) => {
        const stat = fs.readFileSync("/proc/self/stat", "utf8");
        const birth = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
        const child = spawn(executablePath, ["--owned-parent", String(process.pid), birth], {
            cwd: root,
            env: {},
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("helper exceeded its two-second direct-proof deadline"));
        }, 2_000);
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > RECEIPT_BYTES) child.kill("SIGKILL");
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes > 4_096) child.kill("SIGKILL");
            stderr.push(chunk);
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", (code, signal) => {
            clearTimeout(timeout);
            const output = Buffer.concat(stdout);
            const errorOutput = Buffer.concat(stderr);
            if (code !== 0 || signal !== null || errorOutput.byteLength !== 0 || output.byteLength !== RECEIPT_BYTES) {
                reject(
                    new Error(
                        `helper invocation failed: ${JSON.stringify({ code, signal, stdout: output.byteLength, stderr: errorOutput.byteLength })}`,
                    ),
                );
                return;
            }
            resolve(parseReceipt(output));
        });
        child.stdin.end(frame);
    });
}

function expectReceipt(actual, expected) {
    for (const [key, value] of Object.entries(expected)) {
        if (actual[key] !== value) {
            throw new Error(`helper receipt ${key} mismatch: expected ${String(value)}, received ${String(actual[key])}`);
        }
    }
}

function residue() {
    return fs
        .readdirSync(root)
        .filter((name) => name.startsWith(".oaam-publish-"))
        .sort();
}

const observations = [];
try {
    let receipt;
    for (const operation of [1, 2, 3, 4, 5, 6, 9, 10, 11]) {
        receipt = await run(helperPath, request({ operation }));
        if (receipt.status !== 2 || receipt.certainty !== 1 || ![1, 20].includes(receipt.failure))
            throw new Error(`removed direct operation ${operation} was accepted`);
        if (fs.existsSync(target)) throw new Error("removed operation touched its target");
    }
    observations.push("removed_direct_mutation_operations_rejected");
    const publicationRoot = path.join(root, "publication");
    fs.mkdirSync(publicationRoot);
    const directoryIdentity = (directory) => {
        const stat = fs.lstatSync(directory, { bigint: true });
        return { device: stat.dev, inode: stat.ino };
    };
    const preparedDirectory = (name) => {
        const directory = path.join(publicationRoot, name);
        fs.mkdirSync(directory);
        fs.mkdirSync(path.join(directory, "empty"));
        fs.writeFileSync(path.join(directory, "resource"), "complete graph", { mode: 0o755 });
        return directory;
    };
    const publishRequest = (source, destination, fields = {}) =>
        request({
            operation: 7,
            rootPath: path.dirname(source),
            targetPath: source,
            expectedIdentity: directoryIdentity(source),
            payload: Buffer.from(destination),
            ...fields,
        });
    const assertGraph = (directory) => {
        if (
            fs.readFileSync(path.join(directory, "resource"), "utf8") !== "complete graph" ||
            (fs.statSync(path.join(directory, "resource")).mode & 0o111) !== 0o111 ||
            fs.readdirSync(path.join(directory, "empty")).length !== 0
        )
            throw new Error("published directory lost its graph or mode");
    };
    const frameSource = preparedDirectory("frame-controls");
    const frameDestination = path.join(root, "frame-destination");
    const retiredBatch = publishRequest(frameSource, frameDestination);
    retiredBatch.write("OAAMWBO1", 0, "ascii");
    receipt = await run(helperPath, retiredBatch);
    expectReceipt(receipt, { status: 2, certainty: 1, failure: 1 });
    assertGraph(frameSource);
    if (fs.existsSync(frameDestination)) throw new Error("retired batch protocol changed a target");
    observations.push("retired_observation_protocol_refused");
    for (const fault of [1, 2, 6, 7, 8, 10, 11, 12, 16, 17, 18, 19, 20, 21]) {
        receipt = await run(faultHelperPath, publishRequest(frameSource, frameDestination, { fault }));
        expectReceipt(receipt, { status: 2, certainty: 1, failure: 1 });
        assertGraph(frameSource);
        if (fs.existsSync(frameDestination)) throw new Error("retired fault selector changed a target");
    }
    observations.push("retired_fault_selectors_refused_on_valid_publication_frames");
    for (const corrupt of [
        (frame) => {
            frame[0] = 0;
        },
        (frame) => {
            frame.writeUInt16LE(1, 8);
        },
        (frame) => {
            frame[11] = 0;
        },
        (frame) => {
            frame[13] = 1;
        },
        (frame) => {
            frame.fill(0, 32, 64);
        },
        (frame) => {
            frame.fill(0, 64, 80);
        },
        (frame) => {
            frame.fill(0, 96, 112);
        },
        (frame) => {
            frame.writeUInt32LE(4097, 16);
        },
    ]) {
        const frame = publishRequest(frameSource, frameDestination);
        corrupt(frame);
        receipt = await run(helperPath, frame);
        if (receipt.status !== 2 || receipt.certainty !== 1 || ![1, 10].includes(receipt.failure))
            throw new Error("malformed publication frame was accepted");
        assertGraph(frameSource);
        if (fs.existsSync(frameDestination)) throw new Error("malformed publication mutated destination");
    }
    observations.push("publication_frame_and_authority_bounds_preserved");
    const sourceLink = path.join(publicationRoot, "source-link");
    fs.symlinkSync(frameSource, sourceLink);
    receipt = await run(helperPath, publishRequest(sourceLink, frameDestination));
    expectReceipt(receipt, { status: 2, certainty: 1, failure: 8 });
    assertGraph(frameSource);
    if (fs.existsSync(frameDestination) || !fs.lstatSync(sourceLink).isSymbolicLink())
        throw new Error("publication followed or changed a source symlink");
    observations.push("publication_source_nofollow_preserved");

    const prepared = preparedDirectory("prepared");
    const published = path.join(root, "published");
    const preparedIdentity = directoryIdentity(prepared);
    receipt = await run(helperPath, publishRequest(prepared, published));
    expectReceipt(receipt, {
        status: 1,
        certainty: 3,
        operation: 7,
        failure: 0,
        cleanupComplete: true,
        targetAfterDevice: preparedIdentity.device,
        targetAfterInode: preparedIdentity.inode,
    });
    assertGraph(published);
    if (fs.existsSync(prepared)) throw new Error("published source directory remains");
    observations.push("whole_directory_cross_parent_publication");

    for (const kind of ["empty", "nonempty", "file", "symlink"]) {
        const source = preparedDirectory(`source-${kind}`);
        const destination = path.join(root, `occupied-${kind}`);
        if (kind === "file") fs.writeFileSync(destination, "external");
        else if (kind === "symlink") fs.symlinkSync(published, destination);
        else {
            fs.mkdirSync(destination);
            if (kind === "nonempty") fs.writeFileSync(path.join(destination, "external"), "external");
        }
        const before = fs.lstatSync(destination, { bigint: true });
        receipt = await run(helperPath, publishRequest(source, destination));
        expectReceipt(receipt, { status: 2, certainty: 1, operation: 7, failure: 6, cleanupComplete: true });
        const after = fs.lstatSync(destination, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode)
            throw new Error("no-replace publication changed an occupied destination");
        assertGraph(source);
    }
    observations.push("directory_occupied_destination_preserved");

    const absentAuthority = preparedDirectory("missing-authority");
    receipt = await run(
        helperPath,
        publishRequest(absentAuthority, path.join(root, "unauthorized-publish"), { expectedIdentity: undefined }),
    );
    expectReceipt(receipt, { status: 2, certainty: 1, operation: 7, failure: 10 });
    assertGraph(absentAuthority);
    observations.push("directory_publication_requires_source_identity");

    const invalidSource = preparedDirectory("invalid-destination");
    for (const destination of ["relative", `${root}/../escape`, `${root}/nul\0suffix`]) {
        receipt = await run(helperPath, publishRequest(invalidSource, destination));
        expectReceipt(receipt, { status: 2, certainty: 1, operation: 7, failure: 3 });
        assertGraph(invalidSource);
    }
    observations.push("directory_publication_rejects_invalid_destination");

    const changedSource = preparedDirectory("changed-identity");
    const staleFrame = publishRequest(changedSource, path.join(root, "stale-publish"));
    fs.renameSync(changedSource, `${changedSource}.original`);
    fs.mkdirSync(changedSource);
    receipt = await run(helperPath, staleFrame);
    expectReceipt(receipt, { status: 2, certainty: 1, operation: 7, failure: 19 });
    assertGraph(`${changedSource}.original`);
    if (!fs.existsSync(changedSource) || fs.existsSync(path.join(root, "stale-publish")))
        throw new Error("stale publication mutated a target");
    observations.push("directory_publication_rejects_stale_source");

    const racedSource = preparedDirectory("source-race");
    const racedDestination = path.join(root, "raced-source-destination");
    receipt = await run(faultHelperPath, publishRequest(racedSource, racedDestination, { fault: 14 }));
    expectReceipt(receipt, { status: 2, certainty: 2, operation: 7, failure: 19 });
    assertGraph(`${racedSource}.oaam-source-race`);
    if (fs.readdirSync(racedDestination).length !== 0) throw new Error("uncertain source race lost its displaced value");
    observations.push("directory_late_source_race_retains_both_values");

    const lateSource = preparedDirectory("late-destination");
    const lateDestination = path.join(root, "late-empty-directory");
    receipt = await run(faultHelperPath, publishRequest(lateSource, lateDestination, { fault: 13 }));
    expectReceipt(receipt, { status: 2, certainty: 1, operation: 7, failure: 6 });
    assertGraph(lateSource);
    if (!fs.lstatSync(lateDestination).isDirectory() || fs.readdirSync(lateDestination).length !== 0)
        throw new Error("kernel no-replace lost the late empty directory");
    observations.push("directory_late_empty_destination_refused");

    for (const [fault, failure] of [
        [4, 15],
        [5, 16],
    ]) {
        const source = preparedDirectory(`uncertain-${fault}`);
        const destination = path.join(root, `uncertain-published-${fault}`);
        receipt = await run(faultHelperPath, publishRequest(source, destination, { fault }));
        expectReceipt(receipt, { status: 2, certainty: 2, operation: 7, failure });
        assertGraph(destination);
        if (fs.existsSync(source)) throw new Error("applied-uncertain directory was silently rolled back");
    }
    observations.push("directory_publication_retains_post_move_uncertainty");

    receipt = await run(helperPath, publishRequest(lateSource, path.join(root, "production-fault"), { fault: 13 }));
    expectReceipt(receipt, { status: 2, certainty: 1, operation: 7, failure: 1 });
    assertGraph(lateSource);
    observations.push("production_directory_fault_injection_refused");

    const fileSource = path.join(root, "prepared-file");
    const fileDestination = path.join(root, "published-file");
    const fileBytes = Buffer.from("#!/bin/sh\nretained regular file\n");
    fs.writeFileSync(fileSource, fileBytes, { mode: 0o755 });
    const fileIdentity = directoryIdentity(fileSource);
    const fileFrame = () =>
        request({ operation: 8, targetPath: fileSource, payload: Buffer.from(fileDestination), expectedIdentity: fileIdentity });
    receipt = await run(helperPath, fileFrame());
    expectReceipt(receipt, { status: 1, certainty: 3, operation: 8 });
    if (
        fs.existsSync(fileSource) ||
        !fs.readFileSync(fileDestination).equals(fileBytes) ||
        (fs.statSync(fileDestination).mode & 0o111) !== 0o111 ||
        fs.statSync(fileDestination, { bigint: true }).ino !== fileIdentity.inode
    )
        throw new Error("regular-file publication did not retain bytes, mode and identity");
    observations.push("regular_file_no_replace_move_preserves_identity_bytes_mode");
    fs.writeFileSync(fileSource, "third-party source");
    const occupiedFrame = request({
        operation: 8,
        targetPath: fileSource,
        payload: Buffer.from(fileDestination),
        expectedIdentity: directoryIdentity(fileSource),
    });
    receipt = await run(helperPath, occupiedFrame);
    expectReceipt(receipt, { status: 2, certainty: 1, operation: 8, failure: 6 });
    if (fs.readFileSync(fileSource, "utf8") !== "third-party source" || !fs.readFileSync(fileDestination).equals(fileBytes))
        throw new Error("regular-file publication overwrote an occupied destination");
    observations.push("regular_file_occupied_destination_preserves_both");
    const fileLateDestination = path.join(root, "file-late-destination");
    receipt = await run(
        faultHelperPath,
        request({
            operation: 8,
            fault: 13,
            targetPath: fileSource,
            payload: Buffer.from(fileLateDestination),
            expectedIdentity: directoryIdentity(fileSource),
        }),
    );
    expectReceipt(receipt, { status: 2, certainty: 1, operation: 8, failure: 6 });
    if (!fs.statSync(fileLateDestination).isDirectory() || fs.readFileSync(fileSource, "utf8") !== "third-party source")
        throw new Error("regular-file no-replace lost a late destination");
    observations.push("regular_file_late_destination_refused_by_kernel");
    const fileUncertain = path.join(root, "file-uncertain-destination");
    receipt = await run(
        faultHelperPath,
        request({
            operation: 8,
            fault: 4,
            targetPath: fileSource,
            payload: Buffer.from(fileUncertain),
            expectedIdentity: directoryIdentity(fileSource),
        }),
    );
    expectReceipt(receipt, { status: 2, certainty: 2, operation: 8, failure: 15 });
    if (fs.existsSync(fileSource) || fs.readFileSync(fileUncertain, "utf8") !== "third-party source")
        throw new Error("uncertain regular-file publication lost actual mutation");
    observations.push("regular_file_post_move_failure_preserves_uncertainty");

    const productionSha = sha256(fs.readFileSync(helperPath)).toString("hex");
    const faultSha = sha256(fs.readFileSync(faultHelperPath)).toString("hex");
    process.stdout.write(
        `${JSON.stringify({
            schemaVersion: 1,
            status: "pass",
            architecture: process.arch,
            platform: process.platform,
            productionSha256: productionSha,
            faultSha256: faultSha,
            observations,
            residue: residue(),
        })}\n`,
    );
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
