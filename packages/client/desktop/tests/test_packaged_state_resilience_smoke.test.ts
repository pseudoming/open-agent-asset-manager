import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL } from "../src/bridge/desktop-bridge";
import {
    PACKAGED_STATE_BACKUP_LINE,
    PACKAGED_STATE_BACKUP_SMOKE_SWITCH,
    PACKAGED_STATE_REOPEN_LINE,
    PACKAGED_STATE_REOPEN_SMOKE_SWITCH,
    PACKAGED_STATE_RESTORE_LINE,
    PACKAGED_STATE_RESTORE_SMOKE_SWITCH,
    PACKAGED_STATE_TRASH_LINE,
    PACKAGED_STATE_TRASH_SMOKE_SWITCH,
    packagedStateResilienceMode,
    packagedStateResilienceProofLine,
    provePackagedStateResilience,
    resolvePackagedStateRestoreArchive,
} from "../src/main/packaged-state-resilience-smoke";

class ResultPort extends EventEmitter {
    public readonly close = vi.fn(() => this.emit("close"));
    public readonly start = vi.fn();
}

function transferPort() {
    return { close: vi.fn() };
}

const SUBJECT = Object.freeze({
    projectId: "project",
    assetId: "asset",
    versionId: "version",
    deploymentId: "deployment",
});

describe("packaged State resilience main-process proof", () => {
    it("selects exactly one proof mode and publishes its exact line", () => {
        expect(packagedStateResilienceMode([])).toBeNull();
        expect(packagedStateResilienceMode([PACKAGED_STATE_BACKUP_SMOKE_SWITCH])).toBe("backup");
        expect(packagedStateResilienceMode([PACKAGED_STATE_RESTORE_SMOKE_SWITCH])).toBe("restore");
        expect(packagedStateResilienceMode([PACKAGED_STATE_REOPEN_SMOKE_SWITCH])).toBe("reopen");
        expect(packagedStateResilienceMode([PACKAGED_STATE_TRASH_SMOKE_SWITCH])).toBe("trash");
        expect(() =>
            packagedStateResilienceMode([PACKAGED_STATE_BACKUP_SMOKE_SWITCH, PACKAGED_STATE_RESTORE_SMOKE_SWITCH]),
        ).toThrow(/exactly one mode/u);
        expect(packagedStateResilienceProofLine("backup")).toBe(PACKAGED_STATE_BACKUP_LINE);
        expect(packagedStateResilienceProofLine("restore")).toBe(PACKAGED_STATE_RESTORE_LINE);
        expect(packagedStateResilienceProofLine("reopen")).toBe(PACKAGED_STATE_REOPEN_LINE);
        expect(packagedStateResilienceProofLine("trash")).toBe(PACKAGED_STATE_TRASH_LINE);
    });

    it("accepts only one native restore archive beneath the isolated Desktop home", () => {
        expect(
            resolvePackagedStateRestoreArchive("C:\\proof", {
                OAAM_PACKAGED_STATE_RESTORE_ARCHIVE: "C:\\proof\\external\\..\\external\\state.zip",
            }),
        ).toBe("C:\\proof\\external\\state.zip");
        for (const candidate of [undefined, "state.zip", "D:\\state.zip", "C:\\outside\\state.zip", "C:\\proof"]) {
            expect(() =>
                resolvePackagedStateRestoreArchive("C:\\proof", {
                    OAAM_PACKAGED_STATE_RESTORE_ARCHIVE: candidate,
                }),
            ).toThrow();
        }
    });

    it("registers two one-shot archive tokens and closes every owned port after restore proof", async () => {
        const wrongPasswordProtocolPort = transferPort();
        const restoreProtocolPort = transferPort();
        const resultClientPort = transferPort();
        const resultHostPort = new ResultPort();
        let registration = 0;
        const supervisor = {
            connect: vi.fn().mockReturnValueOnce(wrongPasswordProtocolPort).mockReturnValueOnce(restoreProtocolPort),
            registerLocalPathSelection: vi.fn(async (_kind: string, rootPath: string) => {
                registration += 1;
                return `token:${String(registration)}:${rootPath}`;
            }),
        };
        const postMessage = vi.fn((channel: string, request: unknown, ports?: Electron.MessagePortMain[]) => {
            expect(channel).toBe(PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL);
            expect(request).toEqual({
                mode: "restore",
                wrongPasswordArchiveToken: "token:1:C:\\proof\\state.zip",
                archiveToken: "token:2:C:\\proof\\state.zip",
            });
            expect(ports).toEqual([wrongPasswordProtocolPort, restoreProtocolPort, resultClientPort]);
            resultHostPort.emit("message", { data: { status: "complete" } });
        });

        await expect(
            provePackagedStateResilience(
                "restore",
                supervisor,
                { postMessage },
                { createChannel: () => ({ hostPort: resultHostPort, clientPort: resultClientPort }) },
                "C:\\proof\\state.zip",
            ),
        ).resolves.toBeUndefined();
        expect(supervisor.connect.mock.calls).toEqual([
            [{ claimPathSelectionAuthority: true }],
            [{ claimPathSelectionAuthority: true }],
        ]);
        expect(supervisor.registerLocalPathSelection.mock.calls).toEqual([
            ["restore_archive", "C:\\proof\\state.zip"],
            ["restore_archive", "C:\\proof\\state.zip"],
        ]);
        expect(wrongPasswordProtocolPort.close).toHaveBeenCalledOnce();
        expect(restoreProtocolPort.close).toHaveBeenCalledOnce();
        expect(resultHostPort.close).toHaveBeenCalledOnce();
    });

    it("runs non-restore modes without path authority and rejects malformed renderer evidence", async () => {
        const protocolPort = transferPort();
        const resultClientPort = transferPort();
        const resultHostPort = new ResultPort();
        const supervisor = {
            connect: vi.fn(() => protocolPort),
            registerLocalPathSelection: vi.fn(),
        };
        await expect(
            provePackagedStateResilience(
                "backup",
                supervisor,
                {
                    postMessage(_channel, request) {
                        expect(request).toEqual({ mode: "backup", subject: SUBJECT });
                        resultHostPort.emit("message", { data: { status: "complete", extra: true } });
                    },
                },
                { createChannel: () => ({ hostPort: resultHostPort, clientPort: resultClientPort }) },
                undefined,
                SUBJECT,
            ),
        ).rejects.toThrow(/invalid packaged State resilience proof reply/u);
        expect(supervisor.connect).toHaveBeenCalledWith({ claimPathSelectionAuthority: false });
        expect(supervisor.registerLocalPathSelection).not.toHaveBeenCalled();
    });

    it("closes already-owned ports when restore path registration fails", async () => {
        const protocolPort = transferPort();
        const failure = new Error("selection rejected");
        const supervisor = {
            connect: vi.fn(() => protocolPort),
            registerLocalPathSelection: vi.fn(async () => {
                throw failure;
            }),
        };
        await expect(
            provePackagedStateResilience(
                "restore",
                supervisor,
                { postMessage: vi.fn() },
                { createChannel: vi.fn() },
                "C:\\proof\\state.zip",
            ),
        ).rejects.toBe(failure);
        expect(protocolPort.close).toHaveBeenCalledOnce();
    });

    it("surfaces typed renderer failure diagnostics and premature result-port close", async () => {
        const failedProtocolPort = transferPort();
        const failedClientPort = transferPort();
        const failedHostPort = new ResultPort();
        const supervisor = {
            connect: vi.fn(() => failedProtocolPort),
            registerLocalPathSelection: vi.fn(),
        };
        await expect(
            provePackagedStateResilience(
                "reopen",
                supervisor,
                {
                    postMessage() {
                        failedHostPort.emit("message", {
                            data: { status: "failed", step: "reopen_state", diagnosticCodes: ["state.missing"] },
                        });
                    },
                },
                { createChannel: () => ({ hostPort: failedHostPort, clientPort: failedClientPort }) },
                undefined,
                SUBJECT,
            ),
        ).rejects.toThrow(/failed at reopen_state \(state\.missing\)/u);
        expect(failedProtocolPort.close).toHaveBeenCalledOnce();
        expect(failedHostPort.close).toHaveBeenCalledOnce();

        const closedProtocolPort = transferPort();
        const closedHostPort = new ResultPort();
        await expect(
            provePackagedStateResilience(
                "trash",
                {
                    connect: vi.fn(() => closedProtocolPort),
                    registerLocalPathSelection: vi.fn(),
                },
                {
                    postMessage() {
                        closedHostPort.emit("close");
                    },
                },
                { createChannel: () => ({ hostPort: closedHostPort, clientPort: transferPort() }) },
                undefined,
                SUBJECT,
            ),
        ).rejects.toThrow(/closed before a result/u);
        expect(closedProtocolPort.close).toHaveBeenCalledOnce();
    });

    it("closes all transfer ports when renderer delivery throws and requires a restore archive", async () => {
        const protocolPort = transferPort();
        const clientPort = transferPort();
        const hostPort = new ResultPort();
        const failure = new Error("renderer unavailable");
        await expect(
            provePackagedStateResilience(
                "backup",
                {
                    connect: vi.fn(() => protocolPort),
                    registerLocalPathSelection: vi.fn(),
                },
                {
                    postMessage() {
                        throw failure;
                    },
                },
                { createChannel: () => ({ hostPort, clientPort }) },
                undefined,
                SUBJECT,
            ),
        ).rejects.toBe(failure);
        expect(protocolPort.close).toHaveBeenCalledOnce();
        expect(clientPort.close).toHaveBeenCalledOnce();
        expect(hostPort.close).toHaveBeenCalledOnce();

        await expect(
            provePackagedStateResilience(
                "restore",
                {
                    connect: vi.fn(),
                    registerLocalPathSelection: vi.fn(),
                },
                { postMessage: vi.fn() },
                { createChannel: vi.fn() },
            ),
        ).rejects.toThrow(/requires an archive/u);
    });
});
