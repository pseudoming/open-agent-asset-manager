/** Real Node processes exercise death, restart and descriptor inheritance over the built Shared entry. */
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const modulePath = path.resolve(__dirname, "../../packages/shared/dist/paths/unix-like/filesystem-target-entry.js");
function lockFile(file: string): (() => void) | null {
    return createRequire(__filename)(modulePath).lockFile(file);
}
const ownerPath = path.resolve(__dirname, "fixtures/linux-file-lock-owner.mjs");
const owned: Array<{ child: ChildProcess; pid: number; birth: string }> = [];
const closed = new WeakSet<ChildProcess>();
let root = "";

function birth(pid: number): string | null {
    try {
        const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return value.slice(value.lastIndexOf(")") + 2).split(" ")[19]!;
    } catch {
        return null;
    }
}

function exited(child: ChildProcess): Promise<void> {
    if (closed.has(child)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("owned lock fixture did not exit")), 4000);
        child.once("close", () => {
            clearTimeout(timer);
            resolve();
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function launch(mode: "hold" | "linger", file: string) {
    const child = fork(ownerPath, [mode, modulePath, file], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { PATH: "/usr/bin:/bin", TMPDIR: root },
    });
    child.once("close", () => closed.add(child));
    if (child.pid === undefined) throw new Error("owned process did not start");
    const started = birth(child.pid);
    if (started === null) throw new Error("owned process birth is unavailable");
    const identity = { child, pid: child.pid, birth: started };
    owned.push(identity);
    let errors = "";
    child.stderr?.on("data", (chunk) => {
        errors = (errors + String(chunk)).slice(-4096);
    });
    const message = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`owned fixture did not become ready: ${errors}`)), 4000);
        child.once("message", (value) => {
            clearTimeout(timer);
            resolve(value);
        });
        child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`owned fixture exited before readiness: ${errors}`));
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    expect(message).toEqual({ kind: "ready", pid: identity.pid, birth: identity.birth });
    expect(birth(identity.pid)).toBe(identity.birth);
    return identity;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-linux-lock-process-"));
});
afterEach(async () => {
    for (const identity of owned.splice(0)) {
        if (birth(identity.pid) === identity.birth) identity.child.kill("SIGKILL");
        await exited(identity.child);
        expect(birth(identity.pid)).not.toBe(identity.birth);
    }
    fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("Linux lock process lifetime", () => {
    it("reopens the same neutral inode after a real holder is killed, with no marker relocation", async () => {
        const file = path.join(root, "lease.lock"),
            before = fs.readdirSync("/proc/self/fd").length;
        const first = await launch("hold", file);
        const original = fs.statSync(file, { bigint: true });
        expect(lockFile(file)).toBeNull();
        expect(birth(first.pid)).toBe(first.birth);
        first.child.kill("SIGKILL");
        await exited(first.child);
        expect(first.child.signalCode).toBe("SIGKILL");
        const restarted = await launch("hold", file);
        expect(lockFile(file)).toBeNull();
        const current = fs.statSync(file, { bigint: true });
        expect([current.dev, current.ino, current.size]).toEqual([original.dev, original.ino, 0n]);
        restarted.child.send({ kind: "release" });
        await exited(restarted.child);
        const release = lockFile(file);
        expect(release).toBeTypeOf("function");
        release?.();
        expect(fs.readdirSync(root)).toEqual(["lease.lock"]);
        expect(fs.readdirSync("/proc/self/fd").length).toBe(before);
    });

    it("does not pass a held descriptor into an unrelated child process", async () => {
        const file = path.join(root, "lease.lock"),
            release = lockFile(file);
        expect(release).toBeTypeOf("function");
        try {
            const unrelated = await launch("linger", file);
            release?.();
            expect(birth(unrelated.pid)).toBe(unrelated.birth);
            const contender = await launch("hold", file);
            expect(birth(unrelated.pid)).toBe(unrelated.birth);
            contender.child.send({ kind: "release" });
            await exited(contender.child);
            unrelated.child.send({ kind: "release" });
            await exited(unrelated.child);
        } finally {
            release?.();
        }
    });
});
