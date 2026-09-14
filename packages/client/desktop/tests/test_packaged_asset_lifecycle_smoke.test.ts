import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL } from "../src/bridge/desktop-bridge";
import {
    PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH,
    provePackagedAssetLifecycle,
    resolvePackagedAssetLifecycleExportPath,
} from "../src/main/packaged-asset-lifecycle-smoke";

class ResultPort extends EventEmitter {
    public readonly close = vi.fn(() => this.emit("close"));
    public readonly postMessage = vi.fn();
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

describe("packaged Asset lifecycle main-process proof", () => {
    it("accepts one ZIP destination beneath the isolated Desktop home", () => {
        expect(
            resolvePackagedAssetLifecycleExportPath("C:\\proof", {
                OAAM_PACKAGED_ASSET_EXPORT_FILE: "C:\\proof\\exports\\..\\exports\\asset.zip",
            }),
        ).toBe("C:\\proof\\exports\\asset.zip");
        for (const candidate of [
            undefined,
            "asset.zip",
            "D:\\asset.zip",
            "C:\\outside.zip",
            "C:\\proof",
            "C:\\proof\\asset.txt",
            "C:\\proof\\bad\0.zip",
        ]) {
            expect(() =>
                resolvePackagedAssetLifecycleExportPath("C:\\proof", {
                    OAAM_PACKAGED_ASSET_EXPORT_FILE: candidate,
                }),
            ).toThrow();
        }
        expect(() =>
            resolvePackagedAssetLifecycleExportPath("/proof", {
                OAAM_PACKAGED_ASSET_EXPORT_FILE: "C:\\proof\\asset.zip",
            }),
        ).toThrow(/absolute native Windows path/u);
    });

    it("registers two one-shot save tokens and closes every port after complete evidence", async () => {
        const protocolPort = transferPort();
        const clientPort = transferPort();
        const hostPort = new ResultPort();
        const supervisor = {
            connect: vi.fn(() => protocolPort),
            registerLocalPathSelection: vi.fn().mockResolvedValueOnce("export-token").mockResolvedValueOnce("existing-token"),
        };
        const postMessage = vi.fn((channel: string, request: unknown, ports?: Electron.MessagePortMain[]) => {
            expect(channel).toBe(PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL);
            expect(request).toEqual({ exportToken: "export-token", subject: SUBJECT });
            expect(ports).toEqual([protocolPort, clientPort]);
        });
        const proof = provePackagedAssetLifecycle(
            supervisor,
            { postMessage },
            { createChannel: () => ({ hostPort, clientPort }) },
            "C:\\proof\\asset.zip",
            SUBJECT,
        );
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
        hostPort.emit("message", { data: { control: "request_existing_export_token" } });
        await vi.waitFor(() =>
            expect(hostPort.postMessage).toHaveBeenCalledWith({
                control: "existing_export_token",
                existingExportToken: "existing-token",
            }),
        );
        hostPort.emit("message", { data: { status: "complete" } });
        await expect(proof).resolves.toBeUndefined();
        expect(supervisor.connect).toHaveBeenCalledWith({ claimPathSelectionAuthority: true });
        expect(supervisor.registerLocalPathSelection).toHaveBeenCalledTimes(2);
        expect(supervisor.registerLocalPathSelection).toHaveBeenNthCalledWith(1, "asset_export_file", "C:\\proof\\asset.zip");
        expect(supervisor.registerLocalPathSelection).toHaveBeenNthCalledWith(2, "asset_export_file", "C:\\proof\\asset.zip");
        expect(protocolPort.close).toHaveBeenCalledOnce();
        expect(hostPort.close).toHaveBeenCalledOnce();
    });

    it("fails closed on duplicate or rejected follow-up export-token requests", async () => {
        for (const outcome of ["duplicate", "rejected"] as const) {
            const protocolPort = transferPort();
            const hostPort = new ResultPort();
            const registration = vi
                .fn()
                .mockResolvedValueOnce("export-token")
                .mockImplementationOnce(async () => {
                    if (outcome === "rejected") throw new Error("selection rejected");
                    return "existing-token";
                });
            const proof = provePackagedAssetLifecycle(
                { connect: vi.fn(() => protocolPort), registerLocalPathSelection: registration },
                {
                    postMessage() {
                        hostPort.emit("message", { data: { control: "request_existing_export_token" } });
                        if (outcome === "duplicate") {
                            hostPort.emit("message", { data: { control: "request_existing_export_token" } });
                        }
                    },
                },
                { createChannel: () => ({ hostPort, clientPort: transferPort() }) },
                "C:\\proof\\asset.zip",
                SUBJECT,
            );
            await expect(proof).rejects.toThrow(outcome === "duplicate" ? /duplicate export token/u : /selection rejected/u);
            expect(protocolPort.close).toHaveBeenCalledOnce();
            expect(hostPort.close).toHaveBeenCalledOnce();
        }
    });

    it("closes owned resources for registration, renderer, malformed and delivery failures", async () => {
        const registrationPort = transferPort();
        const registrationFailure = new Error("selection rejected");
        await expect(
            provePackagedAssetLifecycle(
                {
                    connect: vi.fn(() => registrationPort),
                    registerLocalPathSelection: vi.fn(async () => {
                        throw registrationFailure;
                    }),
                },
                { postMessage: vi.fn() },
                { createChannel: vi.fn() },
                "C:\\proof\\asset.zip",
                SUBJECT,
            ),
        ).rejects.toBe(registrationFailure);
        expect(registrationPort.close).toHaveBeenCalledOnce();

        for (const data of [
            { status: "failed", step: "export_existing", diagnosticCodes: ["asset_export.failed"] },
            { status: "complete", extra: true },
        ]) {
            const protocolPort = transferPort();
            const hostPort = new ResultPort();
            const promise = provePackagedAssetLifecycle(
                {
                    connect: vi.fn(() => protocolPort),
                    registerLocalPathSelection: vi.fn(async () => "token"),
                },
                {
                    postMessage() {
                        hostPort.emit("message", { data });
                    },
                },
                { createChannel: () => ({ hostPort, clientPort: transferPort() }) },
                "C:\\proof\\asset.zip",
                SUBJECT,
            );
            if ("extra" in data) await expect(promise).rejects.toThrow(/invalid packaged Asset lifecycle proof reply/u);
            else await expect(promise).rejects.toThrow(/export_existing \(asset_export\.failed\)/u);
        }

        const closedPort = transferPort();
        const closedHostPort = new ResultPort();
        await expect(
            provePackagedAssetLifecycle(
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
                "C:\\proof\\asset.zip",
                SUBJECT,
            ),
        ).rejects.toThrow(/closed before a result/u);

        const deliveryPort = transferPort();
        const deliveryClientPort = transferPort();
        const deliveryHostPort = new ResultPort();
        const deliveryFailure = new Error("renderer unavailable");
        await expect(
            provePackagedAssetLifecycle(
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
                "C:\\proof\\asset.zip",
                SUBJECT,
            ),
        ).rejects.toBe(deliveryFailure);
        expect(deliveryClientPort.close).toHaveBeenCalledOnce();
        expect(deliveryPort.close).toHaveBeenCalledOnce();
        expect(deliveryHostPort.close).toHaveBeenCalledOnce();
    });

    it("exports the exact smoke switch", () => {
        expect(PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH).toBe("--oaam-packaged-asset-lifecycle-smoke");
    });
});
