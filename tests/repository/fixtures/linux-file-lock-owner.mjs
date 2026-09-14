/** Owned, bounded process-lifetime fixture. It never starts another process. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const [mode, modulePath, lockPath] = process.argv.slice(2);
assert.ok(mode === "hold" || mode === "linger");
assert.ok(process.send);
const deadline = setTimeout(() => process.exit(91), 10_000);
const readBirth = () => {
    const value = fs.readFileSync("/proc/self/stat", "utf8");
    return value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
};
let release;
if (mode === "hold") {
    release = createRequire(import.meta.url)(modulePath).lockFile(lockPath);
    assert.equal(typeof release, "function", "fixture could not acquire the lock");
}
process.send({ kind: "ready", pid: process.pid, birth: readBirth() });
process.once("message", (message) => {
    assert.deepEqual(message, { kind: "release" });
    release?.();
    clearTimeout(deadline);
    process.disconnect();
});
process.once("disconnect", () => {
    release?.();
    clearTimeout(deadline);
});
