import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    durablePublishRegularFile,
    inspectDirectoryNoFollow,
    inspectRegularFileNoFollow,
    readRegularFileNoFollow,
} from "../../src/paths/unix-like/safe-filesystem";
import { invokeLinuxEntryPublicationForTest } from "../../src/paths/unix-like/linux-entry-publication";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-entry-publication-"));
    roots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    fs.writeFileSync(source, "retained bytes", { mode: 0o755 });
    const input = {
        sourcePath: source,
        destinationPath: destination,
        sourceIdentity: inspectRegularFileNoFollow(source),
        sourceParentIdentity: inspectDirectoryNoFollow(root),
        destinationParentIdentity: inspectDirectoryNoFollow(root),
    };
    const dependencies = {
        helperPath: path.resolve(__dirname, "../../dist/paths/unix-like/oaam_linux_file_mutation"),
        readHelper: readRegularFileNoFollow,
        invoke: spawnSync,
        now: () => performance.now(),
    };
    return { root, source, destination, input, dependencies };
}

describe("regular-file no-replace publication", () => {
    it("moves the actual file once with bytes, identity and executable state intact", () => {
        const f = fixture();
        expect(durablePublishRegularFile(f.source, f.root, "destination")).toEqual(f.input.sourceIdentity);
        expect(fs.existsSync(f.source)).toBe(false);
        expect(readRegularFileNoFollow(f.destination)).toEqual(
            expect.objectContaining({
                identity: f.input.sourceIdentity,
                executable: true,
                bytes: Buffer.from("retained bytes"),
            }),
        );
    });
    it("refuses a destination created after wrapper preflight without losing either file", () => {
        const f = fixture();
        const invoke: typeof spawnSync = (...args) => {
            fs.writeFileSync(f.destination, "late user value");
            return spawnSync(...args);
        };
        expect(() => invokeLinuxEntryPublicationForTest(f.input, { ...f.dependencies, invoke })).toThrowError(
            expect.objectContaining({ mutationState: "not_applied", failureKind: "stale" }),
        );
        expect(fs.readFileSync(f.source, "utf8")).toBe("retained bytes");
        expect(fs.readFileSync(f.destination, "utf8")).toBe("late user value");
    });
    it("refuses a changed source identity before moving it", () => {
        const f = fixture();
        fs.renameSync(f.source, path.join(f.root, "original"));
        fs.writeFileSync(f.source, "replacement inode");
        expect(() => invokeLinuxEntryPublicationForTest(f.input, f.dependencies)).toThrowError(
            expect.objectContaining({ mutationState: "not_applied", failureKind: "stale" }),
        );
        expect(fs.readFileSync(f.source, "utf8")).toBe("replacement inode");
        expect(fs.existsSync(f.destination)).toBe(false);
    });
    it.each(["receipt", "throw", "helper_read"] as const)("retains applied uncertainty after %s failure", (failure) => {
        const f = fixture();
        let executed = false;
        const invoke: typeof spawnSync = (...args) => {
            const result = spawnSync(...args);
            expect(result.status).toBe(0);
            executed = true;
            if (failure === "throw") throw new Error("post-move delivery failure");
            if (failure === "receipt" && Buffer.isBuffer(result.stdout)) result.stdout[0] = 0;
            return result;
        };
        const readHelper: typeof readRegularFileNoFollow = (...args) => {
            if (executed && failure === "helper_read") throw new Error("post-move helper observation failed");
            return readRegularFileNoFollow(...args);
        };
        expect(() => invokeLinuxEntryPublicationForTest(f.input, { ...f.dependencies, invoke, readHelper })).toThrowError(
            expect.objectContaining({
                operation: "durable_publish_file",
                targetPath: f.destination,
                mutationState: "may_have_applied",
            }),
        );
        expect(executed).toBe(true);
        expect(fs.existsSync(f.source)).toBe(false);
        expect(fs.readFileSync(f.destination, "utf8")).toBe("retained bytes");
    });
});
