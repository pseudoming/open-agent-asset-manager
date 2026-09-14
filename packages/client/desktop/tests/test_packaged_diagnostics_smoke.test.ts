import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL,
    parsePackagedDiagnosticsProofControlReply,
    parsePackagedDiagnosticsProofControlRequest,
    parsePackagedDiagnosticsProofReply,
    parsePackagedDiagnosticsProofRequest,
} from "../src/bridge/desktop-bridge";
import {
    PACKAGED_DIAGNOSTICS_LINE,
    PACKAGED_DIAGNOSTICS_SMOKE_SWITCH,
    PackagedDiagnosticsSmokeController,
    provePackagedDiagnostics,
    resolvePackagedDiagnosticsExportPath,
} from "../src/main/packaged-diagnostics-smoke";

class ResultPort extends EventEmitter {
    public readonly close = vi.fn(() => this.emit("close"));
    public readonly postMessage = vi.fn();
    public readonly start = vi.fn();
}

function transferPort() {
    return { close: vi.fn() };
}

afterEach(() => vi.unstubAllEnvs());

describe("packaged diagnostics main-process proof", () => {
    it("accepts one ZIP destination beneath the isolated native Windows home", () => {
        expect(
            resolvePackagedDiagnosticsExportPath("C:\\proof", {
                OAAM_PACKAGED_SUPPORT_BUNDLE_FILE: "C:\\proof\\diagnostics\\..\\diagnostics\\support.ZIP",
            }),
        ).toBe("C:\\proof\\diagnostics\\support.ZIP");
        for (const candidate of [
            undefined,
            "support.zip",
            "D:\\support.zip",
            "C:\\outside.zip",
            "C:\\proof",
            "C:\\proof\\support.txt",
            "C:\\proof\\bad\0.zip",
        ]) {
            expect(() =>
                resolvePackagedDiagnosticsExportPath("C:\\proof", {
                    OAAM_PACKAGED_SUPPORT_BUNDLE_FILE: candidate,
                }),
            ).toThrow();
        }
        expect(() =>
            resolvePackagedDiagnosticsExportPath("/proof", {
                OAAM_PACKAGED_SUPPORT_BUNDLE_FILE: "C:\\proof\\support.zip",
            }),
        ).toThrow(/absolute native Windows path/u);
    });

    it("parses only exact proof messages", () => {
        expect(parsePackagedDiagnosticsProofRequest({ supportBundleExportToken: "token" })).toEqual({
            supportBundleExportToken: "token",
        });
        expect(parsePackagedDiagnosticsProofControlRequest({ control: "request_existing_support_bundle_token" })).toEqual({
            control: "request_existing_support_bundle_token",
        });
        expect(
            parsePackagedDiagnosticsProofControlReply({
                control: "existing_support_bundle_token",
                existingSupportBundleToken: "existing",
            }),
        ).toEqual({ control: "existing_support_bundle_token", existingSupportBundleToken: "existing" });
        expect(parsePackagedDiagnosticsProofReply({ status: "complete" })).toEqual({ status: "complete" });
        expect(
            parsePackagedDiagnosticsProofReply({
                status: "failed",
                step: "support_standard_export",
                diagnosticCodes: ["support.failed"],
            }),
        ).toEqual({ status: "failed", step: "support_standard_export", diagnosticCodes: ["support.failed"] });

        for (const value of [
            null,
            [],
            { supportBundleExportToken: "" },
            { supportBundleExportToken: " token" },
            { supportBundleExportToken: "token", extra: true },
        ]) {
            expect(() => parsePackagedDiagnosticsProofRequest(value)).toThrow(/invalid packaged diagnostics proof request/u);
        }
        for (const value of [{}, { control: "other" }, { control: "request_existing_support_bundle_token", extra: true }]) {
            expect(() => parsePackagedDiagnosticsProofControlRequest(value)).toThrow(
                /invalid packaged diagnostics proof control request/u,
            );
        }
        for (const value of [
            { control: "existing_support_bundle_token", existingSupportBundleToken: "" },
            { control: "other", existingSupportBundleToken: "token" },
        ]) {
            expect(() => parsePackagedDiagnosticsProofControlReply(value)).toThrow(
                /invalid packaged diagnostics proof control reply/u,
            );
        }
        for (const value of [
            { status: "complete", extra: true },
            { status: "failed", step: "other", diagnosticCodes: [] },
            { status: "failed", step: "health", diagnosticCodes: ["BAD"] },
            { status: "failed", step: "health", diagnosticCodes: Array.from({ length: 9 }, () => "bad") },
        ]) {
            expect(() => parsePackagedDiagnosticsProofReply(value)).toThrow(/invalid packaged diagnostics proof reply/u);
        }
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
            expect(channel).toBe(PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL);
            expect(request).toEqual({ supportBundleExportToken: "export-token" });
            expect(ports).toEqual([protocolPort, clientPort]);
        });
        const proof = provePackagedDiagnostics(
            supervisor,
            { postMessage },
            { createChannel: () => ({ hostPort, clientPort }) },
            "C:\\proof\\support.zip",
        );
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
        hostPort.emit("message", { data: { control: "request_existing_support_bundle_token" } });
        await vi.waitFor(() =>
            expect(hostPort.postMessage).toHaveBeenCalledWith({
                control: "existing_support_bundle_token",
                existingSupportBundleToken: "existing-token",
            }),
        );
        hostPort.emit("message", { data: { status: "complete" } });
        await expect(proof).resolves.toBeUndefined();
        expect(supervisor.connect).toHaveBeenCalledWith({ claimPathSelectionAuthority: true });
        expect(supervisor.registerLocalPathSelection).toHaveBeenCalledTimes(2);
        expect(supervisor.registerLocalPathSelection).toHaveBeenNthCalledWith(1, "support_bundle_file", "C:\\proof\\support.zip");
        expect(supervisor.registerLocalPathSelection).toHaveBeenNthCalledWith(2, "support_bundle_file", "C:\\proof\\support.zip");
        expect(protocolPort.close).toHaveBeenCalledOnce();
        expect(hostPort.close).toHaveBeenCalledOnce();
    });

    it("fails closed for token, renderer, port and delivery failures", async () => {
        const registrationPort = transferPort();
        const registrationFailure = new Error("selection rejected");
        await expect(
            provePackagedDiagnostics(
                {
                    connect: vi.fn(() => registrationPort),
                    registerLocalPathSelection: vi.fn(async () => {
                        throw registrationFailure;
                    }),
                },
                { postMessage: vi.fn() },
                { createChannel: vi.fn() },
                "C:\\proof\\support.zip",
            ),
        ).rejects.toBe(registrationFailure);
        expect(registrationPort.close).toHaveBeenCalledOnce();

        for (const outcome of ["duplicate", "rejected"] as const) {
            const protocolPort = transferPort();
            const hostPort = new ResultPort();
            const registration = vi
                .fn()
                .mockResolvedValueOnce("export-token")
                .mockImplementationOnce(async () => {
                    if (outcome === "rejected") throw new Error("follow-up rejected");
                    return "existing-token";
                });
            const proof = provePackagedDiagnostics(
                { connect: vi.fn(() => protocolPort), registerLocalPathSelection: registration },
                {
                    postMessage() {
                        hostPort.emit("message", { data: { control: "request_existing_support_bundle_token" } });
                        if (outcome === "duplicate") {
                            hostPort.emit("message", { data: { control: "request_existing_support_bundle_token" } });
                        }
                    },
                },
                { createChannel: () => ({ hostPort, clientPort: transferPort() }) },
                "C:\\proof\\support.zip",
            );
            await expect(proof).rejects.toThrow(outcome === "duplicate" ? /duplicate token/u : /follow-up rejected/u);
        }

        for (const data of [
            { status: "failed", step: "health", diagnosticCodes: ["health.failed"] },
            { status: "complete", extra: true },
        ]) {
            const protocolPort = transferPort();
            const hostPort = new ResultPort();
            const proof = provePackagedDiagnostics(
                {
                    connect: vi.fn(() => protocolPort),
                    registerLocalPathSelection: vi.fn(async () => "token"),
                },
                { postMessage: () => hostPort.emit("message", { data }) },
                { createChannel: () => ({ hostPort, clientPort: transferPort() }) },
                "C:\\proof\\support.zip",
            );
            await expect(proof).rejects.toThrow("extra" in data ? /invalid packaged diagnostics proof reply/u : /health/u);
        }

        const closedHostPort = new ResultPort();
        await expect(
            provePackagedDiagnostics(
                { connect: vi.fn(() => transferPort()), registerLocalPathSelection: vi.fn(async () => "token") },
                { postMessage: () => closedHostPort.emit("close") },
                { createChannel: () => ({ hostPort: closedHostPort, clientPort: transferPort() }) },
                "C:\\proof\\support.zip",
            ),
        ).rejects.toThrow(/closed before a result/u);

        const deliveryClientPort = transferPort();
        const deliveryHostPort = new ResultPort();
        await expect(
            provePackagedDiagnostics(
                { connect: vi.fn(() => transferPort()), registerLocalPathSelection: vi.fn(async () => "token") },
                {
                    postMessage() {
                        throw new Error("renderer unavailable");
                    },
                },
                { createChannel: () => ({ hostPort: deliveryHostPort, clientPort: deliveryClientPort }) },
                "C:\\proof\\support.zip",
            ),
        ).rejects.toThrow(/renderer unavailable/u);
        expect(deliveryClientPort.close).toHaveBeenCalledOnce();
    });

    it("starts one enabled controller once and reports success or bounded failure", async () => {
        vi.stubEnv("OAAM_PACKAGED_SUPPORT_BUNDLE_FILE", "C:\\proof\\diagnostics\\support.zip");
        const output = vi.fn();
        const errorOutput = vi.fn();
        const shutdown = vi.fn();
        const hostPort = new ResultPort();
        const controller = new PackagedDiagnosticsSmokeController([PACKAGED_DIAGNOSTICS_SMOKE_SWITCH], {
            homePath: () => "C:\\proof",
            channels: { createChannel: () => ({ hostPort, clientPort: transferPort() }) },
            writeOutput: output,
            writeError: errorOutput,
            requestShutdown: shutdown,
        });
        const supervisor = {
            connect: vi.fn(() => transferPort()),
            registerLocalPathSelection: vi.fn(async () => "token"),
        };
        controller.start(supervisor, {
            postMessage() {
                hostPort.emit("message", { data: { status: "complete" } });
            },
        });
        controller.start(supervisor, undefined);
        await vi.waitFor(() => expect(output).toHaveBeenCalledWith(`${PACKAGED_DIAGNOSTICS_LINE}\n`));
        expect(shutdown).toHaveBeenCalledWith(false);
        expect(supervisor.connect).toHaveBeenCalledOnce();

        const failed = new PackagedDiagnosticsSmokeController([PACKAGED_DIAGNOSTICS_SMOKE_SWITCH], {
            homePath: () => "/not-windows",
            channels: { createChannel: vi.fn() },
            writeOutput: vi.fn(),
            writeError: errorOutput,
            requestShutdown: shutdown,
        });
        failed.start(supervisor, { postMessage: vi.fn() });
        expect(errorOutput).toHaveBeenCalledWith(expect.stringMatching(/failed=proof/u));
        expect(shutdown).toHaveBeenCalledWith(true);

        const disabled = new PackagedDiagnosticsSmokeController([], {
            homePath: vi.fn(),
            channels: { createChannel: vi.fn() },
            writeOutput: vi.fn(),
            writeError: vi.fn(),
            requestShutdown: vi.fn(),
        });
        disabled.start(supervisor, { postMessage: vi.fn() });
        expect(disabled).toBeDefined();
    });
});
