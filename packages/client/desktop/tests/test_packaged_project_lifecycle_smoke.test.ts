import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL } from "../src/bridge/desktop-bridge";
import {
    PACKAGED_PROJECT_LIFECYCLE_SMOKE_SWITCH,
    provePackagedProjectLifecycle,
    resolvePackagedProjectRebindRoot,
} from "../src/main/packaged-project-lifecycle-smoke";

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

describe("packaged Project lifecycle main-process proof", () => {
    it("accepts one native rebind root beneath the isolated Desktop home", () => {
        expect(
            resolvePackagedProjectRebindRoot("C:\\proof", {
                OAAM_PACKAGED_PROJECT_REBIND_ROOT: "C:\\proof\\next\\..\\next",
            }),
        ).toBe("C:\\proof\\next");
        for (const candidate of [undefined, "next", "D:\\next", "C:\\outside", "C:\\proof", "C:\\proof\\bad\0root"]) {
            expect(() =>
                resolvePackagedProjectRebindRoot("C:\\proof", {
                    OAAM_PACKAGED_PROJECT_REBIND_ROOT: candidate,
                }),
            ).toThrow();
        }
        expect(() =>
            resolvePackagedProjectRebindRoot("/proof", {
                OAAM_PACKAGED_PROJECT_REBIND_ROOT: "C:\\proof\\next",
            }),
        ).toThrow(/absolute native Windows path/u);
    });

    it("claims one path-authority connection and closes every port after complete evidence", async () => {
        const protocolPort = transferPort();
        const clientPort = transferPort();
        const hostPort = new ResultPort();
        const supervisor = {
            connect: vi.fn(() => protocolPort),
            registerLocalPathSelection: vi.fn(async () => "rebind-token"),
        };
        const postMessage = vi.fn((channel: string, request: unknown, ports?: Electron.MessagePortMain[]) => {
            expect(channel).toBe(PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL);
            expect(request).toEqual({ rebindRootToken: "rebind-token", subject: SUBJECT });
            expect(ports).toEqual([protocolPort, clientPort]);
            hostPort.emit("message", { data: { status: "complete" } });
        });
        await expect(
            provePackagedProjectLifecycle(
                supervisor,
                { postMessage },
                { createChannel: () => ({ hostPort, clientPort }) },
                "C:\\proof\\next",
                SUBJECT,
            ),
        ).resolves.toBeUndefined();
        expect(supervisor.connect).toHaveBeenCalledWith({ claimPathSelectionAuthority: true });
        expect(supervisor.registerLocalPathSelection).toHaveBeenCalledWith("project_root", "C:\\proof\\next");
        expect(protocolPort.close).toHaveBeenCalledOnce();
        expect(hostPort.close).toHaveBeenCalledOnce();
    });

    it("closes owned resources for registration, renderer and delivery failures", async () => {
        const registrationPort = transferPort();
        const registrationFailure = new Error("selection rejected");
        await expect(
            provePackagedProjectLifecycle(
                {
                    connect: vi.fn(() => registrationPort),
                    registerLocalPathSelection: vi.fn(async () => {
                        throw registrationFailure;
                    }),
                },
                { postMessage: vi.fn() },
                { createChannel: vi.fn() },
                "C:\\proof\\next",
                SUBJECT,
            ),
        ).rejects.toBe(registrationFailure);
        expect(registrationPort.close).toHaveBeenCalledOnce();

        const failedPort = transferPort();
        const failedHostPort = new ResultPort();
        await expect(
            provePackagedProjectLifecycle(
                {
                    connect: vi.fn(() => failedPort),
                    registerLocalPathSelection: vi.fn(async () => "token"),
                },
                {
                    postMessage() {
                        failedHostPort.emit("message", {
                            data: { status: "failed", step: "rebind_commit", diagnosticCodes: ["project.stale"] },
                        });
                    },
                },
                { createChannel: () => ({ hostPort: failedHostPort, clientPort: transferPort() }) },
                "C:\\proof\\next",
                SUBJECT,
            ),
        ).rejects.toThrow(/rebind_commit \(project\.stale\)/u);

        const malformedPort = transferPort();
        const malformedHostPort = new ResultPort();
        await expect(
            provePackagedProjectLifecycle(
                {
                    connect: vi.fn(() => malformedPort),
                    registerLocalPathSelection: vi.fn(async () => "token"),
                },
                {
                    postMessage() {
                        malformedHostPort.emit("message", { data: { status: "complete", extra: true } });
                    },
                },
                { createChannel: () => ({ hostPort: malformedHostPort, clientPort: transferPort() }) },
                "C:\\proof\\next",
                SUBJECT,
            ),
        ).rejects.toThrow(/invalid packaged Project lifecycle proof reply/u);

        const closedPort = transferPort();
        const closedHostPort = new ResultPort();
        await expect(
            provePackagedProjectLifecycle(
                {
                    connect: vi.fn(() => closedPort),
                    registerLocalPathSelection: vi.fn(async () => "token"),
                },
                {
                    postMessage() {
                        closedHostPort.emit("close");
                    },
                },
                { createChannel: () => ({ hostPort: closedHostPort, clientPort: transferPort() }) },
                "C:\\proof\\next",
                SUBJECT,
            ),
        ).rejects.toThrow(/closed before a result/u);

        const deliveryPort = transferPort();
        const deliveryClientPort = transferPort();
        const deliveryHostPort = new ResultPort();
        const deliveryFailure = new Error("renderer unavailable");
        await expect(
            provePackagedProjectLifecycle(
                {
                    connect: vi.fn(() => deliveryPort),
                    registerLocalPathSelection: vi.fn(async () => "token"),
                },
                {
                    postMessage() {
                        throw deliveryFailure;
                    },
                },
                { createChannel: () => ({ hostPort: deliveryHostPort, clientPort: deliveryClientPort }) },
                "C:\\proof\\next",
                SUBJECT,
            ),
        ).rejects.toBe(deliveryFailure);
        expect(deliveryClientPort.close).toHaveBeenCalledOnce();
        expect(deliveryPort.close).toHaveBeenCalledOnce();
        expect(deliveryHostPort.close).toHaveBeenCalledOnce();
    });

    it("exports the exact smoke switch", () => {
        expect(PACKAGED_PROJECT_LIFECYCLE_SMOKE_SWITCH).toBe("--oaam-packaged-project-lifecycle-smoke");
    });
});
