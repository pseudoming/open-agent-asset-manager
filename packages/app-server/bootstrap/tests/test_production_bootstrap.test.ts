import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProtocolNotificationV1 } from "@oaam/app-server-protocol";
import type { HostOutboundMessage } from "@oaam/app-server-host";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { HostStartupError, launchProductionHost } from "../src";
import { listProductionProviderIdsForTest } from "../src/production-bootstrap";

function operationTerminal(
    messages: readonly HostOutboundMessage[],
    operation: string,
): Extract<ProtocolNotificationV1, { readonly method: "operation.terminal" }> | undefined {
    return messages.find(
        (message): message is Extract<ProtocolNotificationV1, { readonly method: "operation.terminal" }> =>
            "method" in message && message.method === "operation.terminal" && message.params.operation === operation,
    );
}

async function waitForOperationTerminal(
    messages: readonly HostOutboundMessage[],
    operation: string,
): Promise<Extract<ProtocolNotificationV1, { readonly method: "operation.terminal" }>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const terminal = operationTerminal(messages, operation);
        if (terminal !== undefined) return terminal;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new TypeError(`${operation} did not reach a terminal state`);
}

function terminalValue<T>(terminal: Extract<ProtocolNotificationV1, { readonly method: "operation.terminal" }>): T {
    const outcome = terminal.params.outcome;
    if (outcome.status === "failed" || !("value" in outcome)) {
        throw new TypeError(`${terminal.params.operation} did not return a value: ${JSON.stringify(outcome)}`);
    }
    return outcome.value as T;
}

describe("production bootstrap", () => {
    it("owns the exact Provider inventory and wires Desktop preferences through real backup and restore", async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-state-resilience-"));
        const oaamRoot = path.join(sandbox, "oaam");
        const preferences = new Uint8Array([1, 2, 3]);
        const read = vi.fn(async () => preferences);
        const applyRestored = vi.fn(async () => undefined);
        const restoreRequiresHostReplacement = vi.fn();
        fs.mkdirSync(oaamRoot);
        const runtime = launchProductionHost({
            oaamRoot,
            databasePath: path.join(oaamRoot, "index.db"),
            platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            desktopPreferences: { read, applyRestored },
            restoreRequiresHostReplacement,
        });
        expect(listProductionProviderIdsForTest()).toEqual(["CLAUDECODE", "ANTIGRAVITY", "OPENCODE", "CODEX", "ZCODE", "CURSOR"]);
        expect(runtime.state).toBe("ready");
        expect(runtime.startupDisposition).toEqual({ mode: "normal" });
        expect(runtime.hostInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
        const messages: HostOutboundMessage[] = [];
        const connection = runtime.openConnection({
            send: (message) => messages.push(message),
            close: vi.fn(),
        });
        connection.receive({
            id: "initialize",
            method: "initialize",
            params: { protocolVersion: 1, clientKind: "desktop", clientVersion: "0.1.0" },
        });

        try {
            connection.receive({
                id: "backup-inspect",
                method: "state_backup.inspect",
                params: { destination: { destinationKind: "oaam_default" }, encryptionMode: "none" },
            });
            const backupReview = terminalValue<{ readonly backupReviewToken: string }>(
                await waitForOperationTerminal(messages, "state_backup.inspect"),
            );
            connection.receive({
                id: "backup-create",
                method: "state_backup.create",
                params: {
                    backupReviewToken: backupReview.backupReviewToken,
                    userActionId: "backup-user-action",
                },
            });
            const backup = terminalValue<{ readonly backupId: string }>(
                await waitForOperationTerminal(messages, "state_backup.create"),
            );
            expect(read).toHaveBeenCalledTimes(2);

            connection.receive({
                id: "restore-inspect",
                method: "state_restore.inspect",
                params: { source: { sourceKind: "inventory_backup", backupId: backup.backupId } },
            });
            const restoreReview = terminalValue<{ readonly restoreReviewToken: string }>(
                await waitForOperationTerminal(messages, "state_restore.inspect"),
            );
            connection.receive({
                id: "restore-activate",
                method: "state_restore.activate",
                params: {
                    restoreReviewToken: restoreReview.restoreReviewToken,
                    userActionId: "restore-user-action",
                },
            });
            expect(
                terminalValue<{ readonly restoredDesktopPreferences: boolean }>(
                    await waitForOperationTerminal(messages, "state_restore.activate"),
                ),
            ).toMatchObject({ restoredDesktopPreferences: true });
            expect(applyRestored).toHaveBeenCalledWith(preferences, expect.stringContaining(".oaam.restore-txn-"));
            expect(restoreRequiresHostReplacement).toHaveBeenCalledTimes(1);
            expect(runtime.state).toBe("draining");
        } finally {
            await runtime.shutdown();
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it("maps construction failures without publishing a partial Host", () => {
        expect(() =>
            launchProductionHost({
                oaamRoot: "relative",
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            }),
        ).toThrow(HostStartupError);
        try {
            launchProductionHost({
                oaamRoot: "relative",
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            });
        } catch (error) {
            expect(error).toMatchObject({ name: "HostStartupError", state: "failed" });
        }
    });

    it("publishes only the finite recovery Host for an established profile with a missing database", async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-missing-state-"));
        const oaamRoot = path.join(sandbox, "oaam");
        const databasePath = path.join(oaamRoot, "index.db");
        fs.mkdirSync(oaamRoot);
        fs.writeFileSync(path.join(oaamRoot, "settings.json"), "{}");
        try {
            const runtime = launchProductionHost({
                oaamRoot,
                databasePath,
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            });
            expect(runtime.startupDisposition).toEqual({ mode: "state_recovery", reason: "missing_database" });
            expect(runtime.availableOperations).toEqual([
                "initialize",
                "operation.observe",
                "operation.cancel",
                "diagnostics.health.get",
                "diagnostics.ordinary_log.settings.get",
                "diagnostics.ordinary_log.settings.replace",
                "diagnostics.ordinary_log.clear",
                "diagnostics.support_bundle.inspect",
                "diagnostics.support_bundle.export",
                "state_restore.inspect",
                "state_restore.activate",
            ]);
            expect(fs.existsSync(databasePath)).toBe(false);
            expect(fs.readdirSync(oaamRoot).sort()).toEqual(["logs", "settings.json"]);
            const ordinaryLogRoot = path.join(oaamRoot, "logs", "ordinary");
            const [segmentName] = fs.readdirSync(ordinaryLogRoot);
            expect(segmentName).toMatch(/^ordinary-[0-9]+-[0-9a-f]{32}\.jsonl$/u);
            expect(fs.readFileSync(path.join(ordinaryLogRoot, segmentName ?? ""), "utf8")).toContain(
                '"code":"host.lifecycle.recovery_ready"',
            );
            await runtime.shutdown();
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it.each([
        {
            fixture: "corrupt",
            expectedReason: "host.state_database_corrupt",
            create(databasePath: string): void {
                fs.writeFileSync(databasePath, "not sqlite");
            },
        },
        {
            fixture: "incompatible",
            expectedReason: "host.state_database_incompatible",
            create(databasePath: string): void {
                const database = new Database(databasePath);
                database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
                database.close();
            },
        },
    ])("publishes only the finite recovery Host for $fixture State", async ({ create, expectedReason }) => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-invalid-state-"));
        const oaamRoot = path.join(sandbox, "oaam");
        const databasePath = path.join(oaamRoot, "index.db");
        fs.mkdirSync(oaamRoot);
        create(databasePath);
        try {
            const runtime = launchProductionHost({
                oaamRoot,
                databasePath,
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            });
            expect(runtime.startupDisposition).toEqual({
                mode: "state_recovery",
                reason: expectedReason === "host.state_database_corrupt" ? "corrupt_database" : "incompatible_database",
            });
            expect(runtime.availableOperations).not.toContain("asset.list");
            await runtime.shutdown();
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it("maps unresolved restore evidence to the finite recovery-only Host", async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-restore-reconciliation-"));
        const oaamRoot = path.join(sandbox, "oaam");
        const databasePath = path.join(oaamRoot, "index.db");
        const transactionPath = path.join(sandbox, ".oaam.restore-txn-00000000-0000-4000-8000-000000000347");
        fs.mkdirSync(oaamRoot);
        fs.mkdirSync(transactionPath);
        fs.writeFileSync(path.join(transactionPath, "restore.json"), "{bad");
        try {
            const runtime = launchProductionHost({
                oaamRoot,
                databasePath,
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            });
            expect(runtime.startupDisposition).toEqual({
                mode: "state_recovery",
                reason: "restore_reconciliation",
            });
            expect(fs.existsSync(databasePath)).toBe(false);
            expect(fs.existsSync(path.join(transactionPath, "restore.json"))).toBe(true);
            await runtime.shutdown();
        } finally {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });
});
