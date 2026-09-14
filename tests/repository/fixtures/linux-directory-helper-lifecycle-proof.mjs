import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const birth = (pid) => {
    try {
        const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return text.slice(text.lastIndexOf(") ") + 2).split(" ")[19];
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
};
async function until(predicate, maximumMilliseconds) {
    const deadline = performance.now() + maximumMilliseconds;
    while (!predicate()) {
        if (performance.now() >= deadline) throw new Error("bounded lifecycle observation timed out");
        await sleep(10);
    }
}
function frame(source, destination, fault) {
    const parent = path.dirname(source),
        sourceStat = fs.lstatSync(source, { bigint: true });
    const parentStat = fs.lstatSync(parent, { bigint: true }),
        destinationStat = fs.lstatSync(path.dirname(destination), { bigint: true });
    const rootBytes = Buffer.from(parent),
        sourceBytes = Buffer.from(source),
        payload = Buffer.from(destination);
    const header = Buffer.alloc(112);
    header.write("OAAMWFM1");
    header.writeUInt16LE(2, 8);
    header[10] = 7;
    header[11] = 1;
    header[12] = fault;
    header.writeUInt32LE(rootBytes.length, 16);
    header.writeUInt32LE(sourceBytes.length, 20);
    header.writeBigUInt64LE(BigInt(payload.length), 24);
    randomBytes(32).copy(header, 32);
    header.writeBigUInt64LE(sourceStat.dev, 64);
    header.writeBigUInt64LE(sourceStat.ino, 72);
    header.writeBigUInt64LE(destinationStat.dev, 80);
    header.writeBigUInt64LE(destinationStat.ino, 88);
    header.writeBigUInt64LE(parentStat.dev, 96);
    header.writeBigUInt64LE(parentStat.ino, 104);
    return Buffer.concat([header, rootBytes, sourceBytes, payload]);
}
function start(executable, args, input) {
    const child = spawn(executable, args, { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    void closed.finally(() => clearTimeout(timeout));
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 4096) child.kill("SIGKILL");
        });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    return { child, closed, pid: child.pid, creationToken: birth(child.pid) };
}

if (process.argv[2] === "--caller") {
    const config = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const invocation = start(
        config.helper,
        ["--owned-parent", String(process.pid), birth(process.pid)],
        frame(config.source, config.destination, 15),
    );
    fs.writeFileSync(config.receipt, JSON.stringify({ processId: invocation.pid, creationToken: invocation.creationToken }), {
        flag: "wx",
    });
    await invocation.closed;
} else {
    const [helper, faultHelper, ownedParent] = process.argv.slice(2);
    assert.ok(helper && faultHelper && ownedParent);
    for (const file of [helper, faultHelper]) {
        const stat = fs.lstatSync(file);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0);
    }
    const root = fs.mkdtempSync(path.join(ownedParent, "oaam-directory-lifecycle-"));
    const observations = [],
        owned = [];
    const createGraph = (name) => {
        const source = path.join(root, `${name}-source`),
            destination = path.join(root, `${name}-destination`);
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, "resource"), "original");
        return { source, destination };
    };
    const unchanged = ({ source, destination }) => {
        assert.equal(fs.readFileSync(path.join(source, "resource"), "utf8"), "original");
        assert.equal(fs.existsSync(destination), false);
    };
    try {
        const mismatch = createGraph("mismatched-parent");
        const refused = start(
            helper,
            ["--owned-parent", String(process.pid), "1"],
            frame(mismatch.source, mismatch.destination, 0),
        );
        owned.push({ processId: refused.pid, creationToken: refused.creationToken });
        assert.deepEqual(await refused.closed, { code: 121, signal: null });
        unchanged(mismatch);
        observations.push("parent_birth_mismatch_refused_before_mutation");

        const unownedGraph = createGraph("unbound-process");
        const unowned = start(helper, [], frame(unownedGraph.source, unownedGraph.destination, 0));
        owned.push({ processId: unowned.pid, creationToken: unowned.creationToken });
        assert.deepEqual(await unowned.closed, { code: 121, signal: null });
        unchanged(unownedGraph);
        observations.push("unbound_process_refused");

        const deadlineGraph = createGraph("self-deadline");
        const started = performance.now();
        const timed = start(
            faultHelper,
            ["--owned-parent", String(process.pid), birth(process.pid)],
            frame(deadlineGraph.source, deadlineGraph.destination, 15),
        );
        owned.push({ processId: timed.pid, creationToken: timed.creationToken });
        await until(() => fs.existsSync(`${deadlineGraph.source}.oaam-publish-ready`), 2_000);
        assert.deepEqual(await timed.closed, { code: null, signal: "SIGALRM" });
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 4_500 && elapsed < 7_000);
        unchanged(deadlineGraph);
        observations.push("helper_self_deadline_stops_a_stalled_publication");

        const killed = createGraph("parent-death");
        const configPath = path.join(root, "caller.json"),
            receipt = path.join(root, "helper-process.json");
        fs.writeFileSync(configPath, JSON.stringify({ ...killed, helper: faultHelper, receipt }), { flag: "wx" });
        const caller = start(process.execPath, [fileURLToPath(import.meta.url), "--caller", configPath], Buffer.alloc(0));
        owned.push({ processId: caller.pid, creationToken: caller.creationToken });
        await until(() => fs.existsSync(receipt) && fs.existsSync(`${killed.source}.oaam-publish-ready`), 2_000);
        const child = JSON.parse(fs.readFileSync(receipt, "utf8"));
        owned.push(child);
        assert.equal(birth(caller.pid), caller.creationToken);
        assert.equal(birth(child.processId), child.creationToken);
        caller.child.kill("SIGKILL");
        assert.deepEqual(await caller.closed, { code: null, signal: "SIGKILL" });
        await until(() => birth(child.processId) !== child.creationToken, 2_000);
        unchanged(killed);
        observations.push("parent_death_kills_the_exact_paused_helper");
        assert.ok(owned.every((record) => birth(record.processId) !== record.creationToken));
        process.stdout.write(
            JSON.stringify({
                schemaVersion: 1,
                status: "pass",
                observations,
                owned,
                helperSha256: createHash("sha256").update(fs.readFileSync(helper)).digest("hex"),
                faultHelperSha256: createHash("sha256").update(fs.readFileSync(faultHelper)).digest("hex"),
                residual: [],
            }) + "\n",
        );
    } finally {
        for (const record of owned)
            if (birth(record.processId) === record.creationToken) process.kill(record.processId, "SIGKILL");
        fs.rmSync(root, { recursive: true, force: true });
    }
}
