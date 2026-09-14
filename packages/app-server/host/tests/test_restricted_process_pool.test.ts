import { describe, expect, it, vi } from "vitest";
import { createRestrictedProcessPool, createRestrictedProcessPoolForTest } from "../src/restricted-process-pool";
import {
    RestrictedProcessStartError,
    type RestrictedProcessLaunch,
    type RestrictedProcessTransport,
} from "../src/restricted-process-client";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    return {
        promise: new Promise<T>((yes, no) => {
            resolve = yes;
            reject = no;
        }),
        resolve: (value: T) => resolve(value),
        reject: (error: Error) => reject(error),
    };
}
const configure = () => ({ session: { sessionId: "owned-test-start" } }) as RestrictedProcessLaunch;
function owner() {
    const state = { available: true };
    const peer: RestrictedProcessTransport = {
        ready: {},
        get available() {
            return state.available;
        },
        exchange: vi.fn(),
        exchangeSync: vi.fn(),
        close: vi.fn(async () => {
            state.available = false;
        }),
    };
    return { state, peer };
}

describe("restricted process reuse and release", () => {
    it("accepts confirmed startup cleanup when shutdown already captured the pending owner", async () => {
        const pending = deferred<RestrictedProcessTransport>(),
            start = vi.fn(() => pending.promise);
        const pool = createRestrictedProcessPoolForTest(1, start);
        const acquisition = pool.acquire("same", configure);
        const rejected = expect(acquisition).rejects.toMatchObject({ cleanupConfirmed: true });
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        const closing = pool.close();
        await Promise.resolve();
        await Promise.resolve();
        pending.reject(new RestrictedProcessStartError(true, new Error("startup released")));
        await rejected;
        await expect(closing).resolves.toBeUndefined();
        expect(start).toHaveBeenCalledOnce();
    });
    it("closes an unused production pool without starting a process", async () => {
        await expect(createRestrictedProcessPool().close()).resolves.toBeUndefined();
    });
    it.each([0, 17, NaN])("rejects invalid pool capacity %s", (maximum) => {
        const start = vi.fn();
        expect(() => createRestrictedProcessPoolForTest(maximum, start)).toThrow("invalid restricted process pool bound");
        expect(start).not.toHaveBeenCalled();
    });
    it.each(["", "x".repeat(513), "invalid\0key"])("rejects invalid session key %j before configuring", async (key) => {
        const start = vi.fn(),
            config = vi.fn(configure),
            pool = createRestrictedProcessPoolForTest(1, start);
        await expect(pool.acquire(key, config)).rejects.toThrow("invalid restricted process key");
        expect(config).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        await pool.close();
    });
    it("refuses configuration admitted just before shutdown without launching an owner", async () => {
        const start = vi.fn(),
            config = vi.fn(configure),
            pool = createRestrictedProcessPoolForTest(1, start);
        const acquisition = pool.acquire("same", config);
        const closing = Promise.resolve().then(() => pool.close());
        await expect(acquisition).rejects.toThrow("shutting down");
        await closing;
        expect(config).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });
    it("joins an unavailable owner being replaced when shutdown arrives during its release", async () => {
        const old = owner(),
            released = deferred<void>(),
            start = vi.fn(async () => old.peer);
        const pool = createRestrictedProcessPoolForTest(1, start);
        await pool.acquire("same", configure);
        old.state.available = false;
        vi.mocked(old.peer.close).mockImplementation(() => released.promise);
        const next = pool.acquire("same", configure);
        const rejected = expect(next).rejects.toThrow("shutting down");
        await vi.waitFor(() => expect(old.peer.close).toHaveBeenCalledOnce());
        const closing = pool.close();
        released.resolve();
        await rejected;
        await closing;
        expect(start).toHaveBeenCalledOnce();
    });
    it("shares one pending start for concurrent requests and reuses its ready owner", async () => {
        const pending = deferred<RestrictedProcessTransport>(),
            f = owner();
        const start = vi.fn(() => pending.promise),
            config = vi.fn(configure);
        const pool = createRestrictedProcessPoolForTest(2, start);
        const first = pool.acquire("same", config),
            second = pool.acquire("same", config);
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
        pending.resolve(f.peer);
        expect(await first).toBe(f.peer);
        expect(await second).toBe(f.peer);
        expect(await pool.acquire("same", config)).toBe(f.peer);
        expect(config).toHaveBeenCalledTimes(1);
        await pool.close();
        expect(f.peer.close).toHaveBeenCalledTimes(1);
    });

    it("starts distinct admitted sessions concurrently without exceeding the process bound", async () => {
        const a = deferred<RestrictedProcessTransport>(),
            b = deferred<RestrictedProcessTransport>();
        const start = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const pool = createRestrictedProcessPoolForTest(2, start),
            left = owner(),
            right = owner();
        const first = pool.acquire("a", configure),
            second = pool.acquire("b", configure);
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
        await expect(pool.acquire("c", configure)).rejects.toThrow("at capacity");
        a.resolve(left.peer);
        b.resolve(right.peer);
        await Promise.all([first, second]);
        await pool.close();
        expect(left.peer.close).toHaveBeenCalledTimes(1);
        expect(right.peer.close).toHaveBeenCalledTimes(1);
    });

    it("joins unavailable-owner cleanup before either concurrent replacement can start", async () => {
        const old = owner(),
            next = owner(),
            released = deferred<void>();
        const start = vi.fn().mockResolvedValueOnce(old.peer).mockResolvedValueOnce(next.peer);
        const pool = createRestrictedProcessPoolForTest(1, start);
        await pool.acquire("same", configure);
        old.state.available = false;
        vi.mocked(old.peer.close).mockImplementation(() => released.promise);
        const first = pool.acquire("same", configure),
            second = pool.acquire("same", configure);
        await vi.waitFor(() => expect(old.peer.close).toHaveBeenCalledTimes(1));
        expect(start).toHaveBeenCalledTimes(1);
        released.resolve();
        expect(await first).toBe(next.peer);
        expect(await second).toBe(next.peer);
        expect(start).toHaveBeenCalledTimes(2);
        await pool.close();
    });

    it("reclaims only an unavailable owner when a new session needs the last slot", async () => {
        const old = owner(),
            next = owner();
        const pool = createRestrictedProcessPoolForTest(
            1,
            vi.fn().mockResolvedValueOnce(old.peer).mockResolvedValueOnce(next.peer),
        );
        await pool.acquire("old", configure);
        old.state.available = false;
        expect(await pool.acquire("new", configure)).toBe(next.peer);
        expect(old.peer.close).toHaveBeenCalledTimes(1);
        await pool.close();
    });

    it("does not replace an owner whose cleanup is unconfirmed", async () => {
        const f = owner(),
            start = vi.fn(async () => f.peer),
            pool = createRestrictedProcessPoolForTest(1, start);
        await pool.acquire("same", configure);
        f.state.available = false;
        vi.mocked(f.peer.close).mockRejectedValue(new Error("cleanup uncertain"));
        await expect(pool.acquire("same", configure)).rejects.toThrow("cleanup uncertain");
        await expect(pool.acquire("new", configure)).rejects.toThrow("cleanup uncertain");
        expect(start).toHaveBeenCalledTimes(1);
        await expect(pool.close()).rejects.toThrow("cleanup was not confirmed");
    });

    it("permits a later explicit request after a failed start with confirmed cleanup", async () => {
        const f = owner(),
            start = vi
                .fn()
                .mockRejectedValueOnce(new RestrictedProcessStartError(true, new Error("bad startup")))
                .mockResolvedValueOnce(f.peer);
        const pool = createRestrictedProcessPoolForTest(1, start);
        await expect(pool.acquire("same", configure)).rejects.toThrow("bad startup");
        expect(await pool.acquire("same", configure)).toBe(f.peer);
        expect(start).toHaveBeenCalledTimes(2);
        await pool.close();
    });

    it("retains an uncertain failed start and refuses to claim successful shutdown", async () => {
        const start = vi.fn().mockRejectedValue(new RestrictedProcessStartError(false, new Error("unreleased startup")));
        const pool = createRestrictedProcessPoolForTest(1, start);
        await expect(pool.acquire("same", configure)).rejects.toThrow("unreleased startup");
        await expect(pool.acquire("same", configure)).rejects.toThrow("unreleased startup");
        expect(start).toHaveBeenCalledTimes(1);
        await expect(pool.close()).rejects.toThrow("cleanup was not confirmed");
    });

    it("waits for an already starting owner and its release while rejecting later work", async () => {
        const pending = deferred<RestrictedProcessTransport>(),
            released = deferred<void>(),
            f = owner();
        vi.mocked(f.peer.close).mockImplementation(() => released.promise);
        const start = vi.fn(() => pending.promise),
            pool = createRestrictedProcessPoolForTest(1, start);
        const acquired = pool.acquire("same", configure);
        const rejected = expect(acquired).rejects.toThrow("shutting down");
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
        let closed = false;
        const closing = pool.close().then(() => {
            closed = true;
        });
        expect(pool.close()).toBe(pool.close());
        await expect(pool.acquire("late", configure)).rejects.toThrow("shutting down");
        pending.resolve(f.peer);
        await rejected;
        await vi.waitFor(() => expect(f.peer.close).toHaveBeenCalledTimes(1));
        expect(closed).toBe(false);
        released.resolve();
        await closing;
        expect(closed).toBe(true);
    });
});
