import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductionHost } from "@oaam/app-server-host";
import { launchProductionHostForTest } from "../src/production-bootstrap";

let root: string | undefined;
let host: ProductionHost | undefined;
afterEach(async () => {
    try {
        await host?.shutdown();
    } catch {
        /* The failure test asserts that production keeps State open. */
    } finally {
        // Tests share one Node process; release only their own process database and frozen registry between cases.
        const database = require("@oaam/core/dist/persistence/db") as typeof import("../../../core/src/persistence/db");
        database.closeDb();
        const registry =
            require("@oaam/core/dist/orchestration/adapter-registry") as typeof import("../../../core/src/orchestration/adapter-registry");
        registry.clearRegistry();
    }
    host = undefined;
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
});

function options() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-owned-release-"));
    return {
        oaamRoot: root,
        databasePath: path.join(root, "index.db"),
        platformContexts: [
            { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: "\\\\wsl.localhost\\Ubuntu\\" },
        ],
    };
}

describe("ordinary Bootstrap restricted process and State release", () => {
    it("binds the actual Host/profile and waits for owned release before closing the real State database", async () => {
        const config = options();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const close = vi.fn(() => held);
        const probe = vi.fn(async () => {
            throw new Error("no authorized probe in this lifecycle control");
        });
        let identity!: () => string;
        const createRestricted = vi.fn((_contexts, _root, getHostInstanceId) => {
            identity = getHostInstanceId;
            return { execution: { probe }, close };
        });
        let targetIdentity!: () => string, sourceIdentity!: () => string;
        const createTargets = vi.fn<NonNullable<Parameters<typeof launchProductionHostForTest>[3]>>(
            (_contexts, _root, getHostInstanceId) => {
                targetIdentity = getHostInstanceId;
                return { execution: { withTarget: vi.fn() }, close: vi.fn(async () => undefined) };
            },
        );
        const createSources = vi.fn<NonNullable<Parameters<typeof launchProductionHostForTest>[4]>>(
            (_contexts, _root, getHostInstanceId) => {
                sourceIdentity = getHostInstanceId;
                return { execution: { read: vi.fn() }, close: vi.fn(async () => undefined) };
            },
        );
        host = launchProductionHostForTest(config, "win32", createRestricted, createTargets, createSources);
        expect(createRestricted).toHaveBeenCalledWith(config.platformContexts, config.oaamRoot, expect.any(Function));
        expect(identity()).toBe(host.hostInstanceId);
        expect(targetIdentity()).toBe(host.hostInstanceId);
        expect(sourceIdentity()).toBe(host.hostInstanceId);
        expect(probe).not.toHaveBeenCalled();
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
        const stopped = host.shutdown();
        try {
            await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
            expect(host.state).toBe("draining");
            expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
        } finally {
            release();
        }
        await stopped;
        expect(host.state).toBe("stopped");
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(false);
        expect(fs.existsSync(config.databasePath + "-shm")).toBe(false);
    });

    it("retains State and draining when restricted cleanup fails", async () => {
        const config = options();
        const close = vi.fn(async () => {
            throw new Error("owned release not confirmed");
        });
        host = launchProductionHostForTest(config, "win32", () => ({
            execution: {
                probe: async () => {
                    throw new Error("unused");
                },
            },
            close,
        }));
        await expect(host.shutdown()).rejects.toThrow("owned release not confirmed");
        expect(host.state).toBe("draining");
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
        expect(fs.existsSync(config.databasePath + "-shm")).toBe(true);
    });

    it("keeps native Unix hosts on their existing local composition", async () => {
        const config = options();
        const createRestricted = vi.fn(() => {
            throw new Error("must not initialize Windows ownership");
        });
        host = launchProductionHostForTest(
            { ...config, platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }] },
            "linux",
            createRestricted,
            createRestricted,
            createRestricted,
        );
        await host.shutdown();
        expect(createRestricted).not.toHaveBeenCalled();
    });

    it("waits for the complete target owner before closing real State even after the probe owner has closed", async () => {
        const config = options();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const probeClose = vi.fn(async () => undefined);
        const targetClose = vi.fn(() => held);
        host = launchProductionHostForTest(
            config,
            "win32",
            () => ({
                execution: {
                    probe: async () => {
                        throw new Error("unused");
                    },
                },
                close: probeClose,
            }),
            () => ({
                execution: {
                    withTarget: async () => {
                        throw new Error("unused");
                    },
                },
                close: targetClose,
            }),
        );
        const stopped = host.shutdown();
        try {
            await vi.waitFor(() => expect(targetClose).toHaveBeenCalledTimes(1));
            expect(probeClose).toHaveBeenCalledTimes(1);
            expect(host.state).toBe("draining");
            expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
        } finally {
            release();
        }
        await stopped;
        expect(host.state).toBe("stopped");
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(false);
    });

    it.each([
        "target",
        "both",
    ])("attempts both owner releases and keeps State open after %s cleanup uncertainty", async (uncertain) => {
        const config = options();
        const probeClose = vi.fn(async () => {
            if (uncertain === "both") throw new Error("probe cleanup unknown");
        });
        const targetClose = vi.fn(async () => {
            throw new Error("target cleanup unknown");
        });
        host = launchProductionHostForTest(
            config,
            "win32",
            () => ({
                execution: {
                    probe: async () => {
                        throw new Error("unused");
                    },
                },
                close: probeClose,
            }),
            () => ({
                execution: {
                    withTarget: async () => {
                        throw new Error("unused");
                    },
                },
                close: targetClose,
            }),
        );
        await expect(host.shutdown()).rejects.toThrow(
            uncertain === "both" ? /restricted process cleanup was not confirmed/ : /target cleanup unknown/,
        );
        expect(probeClose).toHaveBeenCalledTimes(1);
        expect(targetClose).toHaveBeenCalledTimes(1);
        expect(host.state).toBe("draining");
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
    });

    it("keeps real State open until the source owner has released its admitted read", async () => {
        const config = options();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const sourceClose = vi.fn(() => held);
        const unused = async () => {
            throw new Error("unused operation");
        };
        host = launchProductionHostForTest(
            config,
            "win32",
            () => ({ execution: { probe: unused }, close: async () => undefined }),
            () => ({ execution: { withTarget: unused }, close: async () => undefined }),
            () => ({ execution: { read: unused }, close: sourceClose }),
        );
        const stopped = host.shutdown();
        try {
            await vi.waitFor(() => expect(sourceClose).toHaveBeenCalledOnce());
            expect(host.state).toBe("draining");
            expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
        } finally {
            release();
        }
        await stopped;
        expect(host.state).toBe("stopped");
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(false);
    });

    it.each(["source", "all_three"])("attempts all owners and retains State after %s cleanup uncertainty", async (uncertain) => {
        const config = options();
        const unused = async () => {
            throw new Error("unused operation");
        };
        const probeClose = vi.fn(async () => {
            if (uncertain === "all_three") throw new Error("probe cleanup unknown");
        });
        const targetClose = vi.fn(async () => {
            if (uncertain === "all_three") throw new Error("target cleanup unknown");
        });
        const sourceClose = vi.fn(async () => {
            throw new Error("source cleanup unknown");
        });
        host = launchProductionHostForTest(
            config,
            "win32",
            () => ({ execution: { probe: unused }, close: probeClose }),
            () => ({ execution: { withTarget: unused }, close: targetClose }),
            () => ({ execution: { read: unused }, close: sourceClose }),
        );
        await expect(host.shutdown()).rejects.toThrow(
            uncertain === "source" ? /source cleanup unknown/ : /restricted process cleanup was not confirmed/,
        );
        for (const close of [probeClose, targetClose, sourceClose]) expect(close).toHaveBeenCalledOnce();
        expect(host.state).toBe("draining");
        expect(fs.existsSync(config.databasePath + "-wal")).toBe(true);
    });
});
