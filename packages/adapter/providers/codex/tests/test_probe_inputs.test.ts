import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { CodexProbeConfigResult } from "../src/codex-probe-guidance-config";
import { readCodexProbeConfig } from "../src/codex-probe-guidance-config";
import { observeCodexProbeInputs } from "../src/codex-probe-inputs";
import type { CodexInstallationSearch } from "../src/codex-probe-installation";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, decline) => {
        resolve = accept;
        reject = decline;
    });
    return { promise, resolve, reject };
}

const config = readCodexProbeConfig("/fixture/missing-config.toml", "not_found");
const cli: CodexInstallationSearch = { status: "not_found", evidence: [], diagnostics: [], versionText: "" };
const app: CodexInstallationSearch = { status: "unknown", evidence: [], diagnostics: [], versionText: "" };

describe("independent inputs to one Codex probe", () => {
    it("starts installation while the config read is pending and joins both before returning", async () => {
        const configRead = deferred<CodexProbeConfigResult>();
        const cliRead = deferred<CodexInstallationSearch>();
        const started: string[] = [];
        let settled = false;
        const result = observeCodexProbeInputs({
            config: () => {
                started.push("config");
                return configRead.promise;
            },
            cli: () => {
                started.push("cli");
                return cliRead.promise;
            },
            app: () => {
                started.push("app");
                return app;
            },
        }).then((value) => {
            settled = true;
            return value;
        });

        await setImmediate();
        expect(started).toEqual(["config", "cli", "app"]);
        cliRead.resolve(cli);
        await setImmediate();
        expect(settled).toBe(false);
        configRead.resolve(config);
        expect(await result).toEqual({ config, cliInstall: cli, appInstall: app });
        expect(settled).toBe(true);
    });

    it("waits for installation after a synchronous config failure and preserves that exact failure", async () => {
        const cliRead = deferred<CodexInstallationSearch>();
        const error = new Error("config owner failed");
        const appError = new Error("App owner failed");
        let cliStarted = false;
        let appStarted = false;
        let settled = false;
        const result = observeCodexProbeInputs({
            config: () => {
                throw error;
            },
            cli: () => {
                cliStarted = true;
                return cliRead.promise;
            },
            app: () => {
                appStarted = true;
                throw appError;
            },
        }).catch((failure: unknown) => {
            settled = true;
            return failure;
        });

        await setImmediate();
        expect(cliStarted && appStarted).toBe(true);
        expect(settled).toBe(false);
        cliRead.reject(new Error("CLI owner failed later"));
        expect(await result).toBe(error);
    });

    it("drains a pending config read before propagating the installation failure", async () => {
        const configRead = deferred<CodexProbeConfigResult>();
        const error = new Error("CLI owner failed");
        let settled = false;
        const result = observeCodexProbeInputs({
            config: () => configRead.promise,
            cli: async () => {
                throw error;
            },
            app: () => app,
        }).catch((failure: unknown) => {
            settled = true;
            return failure;
        });

        await setImmediate();
        expect(settled).toBe(false);
        configRead.resolve(config);
        expect(await result).toBe(error);
    });

    it("retains synchronous App failure precedence while waiting for the CLI terminal", async () => {
        const cliRead = deferred<CodexInstallationSearch>();
        const error = new Error("App owner failed");
        let settled = false;
        const result = observeCodexProbeInputs({
            config: async () => config,
            cli: () => cliRead.promise,
            app: () => {
                throw error;
            },
        }).catch((failure: unknown) => {
            settled = true;
            return failure;
        });

        await setImmediate();
        expect(settled).toBe(false);
        cliRead.reject(new Error("CLI owner failed later"));
        expect(await result).toBe(error);
    });
});
