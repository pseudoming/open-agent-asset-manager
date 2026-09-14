import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    assertAuthorityLockLease,
    tryAcquireAuthorityLockLease,
    tryAcquireAuthorityLockLeaseForTest,
    tryAcquireAuthorityLocks,
    tryAcquireAuthorityLocksForTest,
} from "../../src/foundation/authority-locks";

let root = "";

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-authority-locks-"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("authority lock acquisition", () => {
    it("holds every requested lock until the idempotent release handle is called", () => {
        const locksRoot = path.join(root, "locks");
        const release = tryAcquireAuthorityLocks(locksRoot, "assets", ["a", "b"]);
        expect(release).not.toBeNull();
        expect(tryAcquireAuthorityLocks(locksRoot, "assets", ["a"])).toBeNull();
        release?.();
        release?.();
        const retry = tryAcquireAuthorityLocks(locksRoot, "assets", ["a"]);
        expect(retry).not.toBeNull();
        retry?.();
    });

    it("calls an injected release handle only once", () => {
        let releaseCalls = 0;
        const release = tryAcquireAuthorityLocksForTest(path.join(root, "locks"), "assets", ["a"], () => () => {
            releaseCalls += 1;
        });
        release?.();
        release?.();
        expect(releaseCalls).toBe(1);
    });

    it("issues an exact live lease that cannot be forged, widened, or reused after release", () => {
        const locksRoot = path.join(root, "locks");
        let releases = 0;
        const lease = tryAcquireAuthorityLockLeaseForTest(locksRoot, "assets", ["a", "b"], () => () => {
            releases += 1;
        });
        if (lease === null) throw new Error("fixture lease missing");
        expect(() => assertAuthorityLockLease(lease.proof, locksRoot, "assets", ["a", "b"])).not.toThrow();
        for (const invalid of [
            [path.join(root, "other"), "assets", ["a", "b"]],
            [locksRoot, "settings", ["a", "b"]],
            [locksRoot, "assets", ["a"]],
            [locksRoot, "assets", ["a", "c"]],
        ] as const) {
            expect(() => assertAuthorityLockLease(lease.proof, invalid[0], invalid[1], invalid[2])).toThrow(/does not cover/);
        }
        expect(() => assertAuthorityLockLease({} as never, locksRoot, "assets", ["a", "b"])).toThrow(/does not cover/);
        lease.release();
        lease.release();
        expect(releases).toBe(2);
        expect(() => assertAuthorityLockLease(lease.proof, locksRoot, "assets", ["a", "b"])).toThrow(/does not cover/);
    });

    it("returns null for a busy lease and releases a production lease normally", () => {
        const locksRoot = path.join(root, "locks");
        const lease = tryAcquireAuthorityLockLease(locksRoot, "settings", ["settings"]);
        expect(lease).not.toBeNull();
        expect(tryAcquireAuthorityLockLease(locksRoot, "settings", ["settings"])).toBeNull();
        lease?.release();
        const retry = tryAcquireAuthorityLockLease(locksRoot, "settings", ["settings"]);
        expect(retry).not.toBeNull();
        retry?.release();
    });

    it("releases earlier locks when a later lock is busy", () => {
        const events: string[] = [];
        let call = 0;
        const result = tryAcquireAuthorityLocksForTest(path.join(root, "locks"), "assets", ["first", "second"], () => {
            call += 1;
            return call === 1 ? () => events.push("released-first") : null;
        });
        expect(result).toBeNull();
        expect(events).toEqual(["released-first"]);
    });

    it("releases earlier locks in reverse order when acquisition throws", () => {
        const events: string[] = [];
        let call = 0;
        expect(() =>
            tryAcquireAuthorityLocksForTest(path.join(root, "locks"), "assets", ["first", "second", "third"], () => {
                call += 1;
                if (call === 3) throw new Error("faulting lock provider");
                const current = call;
                return () => events.push(`released-${current}`);
            }),
        ).toThrow("faulting lock provider");
        expect(events).toEqual(["released-2", "released-1"]);
    });

    it("rejects unsafe authority roots, namespaces, and lock-name components before acquisition", () => {
        let calls = 0;
        const acquire = () => {
            calls += 1;
            return () => undefined;
        };
        for (const invalidRoot of [
            "",
            "relative/locks",
            `${path.join(root, "locks")}${path.sep}`,
            path.parse(root).root,
            `${path.join(root, "locks")}\0bad`,
        ]) {
            expect(() => tryAcquireAuthorityLocksForTest(invalidRoot, "assets", ["safe"], acquire)).toThrow(/authorityLocksRoot/);
        }
        expect(() => tryAcquireAuthorityLocksForTest(root, "../escape", ["safe"], acquire)).toThrow(/lock namespace/);
        expect(() => tryAcquireAuthorityLocksForTest(root, "assets", ["a/b"], acquire)).toThrow(/lock name/);
        expect(calls).toBe(0);
    });
});
