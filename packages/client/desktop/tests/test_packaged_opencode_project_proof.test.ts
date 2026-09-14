import type { ClientConnectionApi, ClientMessageTransport, createClientConnection } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import {
    PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL,
    type PackagedOpenCodeProjectProofRequest,
    parsePackagedOpenCodeProjectProofReply,
    parsePackagedOpenCodeProjectProofRequest,
} from "../src/bridge/desktop-bridge";
import type { BrowserProtocolPort } from "../src/renderer/client";
import {
    installPackagedOpenCodeProjectProofListener,
    provePackagedOpenCodeProjectWithConnection,
    runPackagedOpenCodeProjectProof,
} from "../src/renderer/client/packaged-opencode-project-proof";

const REQUEST: PackagedOpenCodeProjectProofRequest = Object.freeze({
    mode: "native",
    environment: Object.freeze({ platform: "win32", platformInstanceId: "desktop-local" }),
    expectedTargetPath: "C:\\proof\\project",
});

function terminalResult(
    overrides: {
        readonly platform?: "win32" | "wsl";
        readonly platformInstanceId?: string;
        readonly targetPath?: string;
        readonly resultStatus?: "complete" | "partial" | "failed";
        readonly installationStatus?: "available" | "not_found" | "unknown";
        readonly projectDiscoveryStatus?: "complete" | "partial" | "failed";
        readonly projectCount?: number;
        readonly targetCount?: number;
        readonly resultCount?: number;
        readonly includeUnsupportedDiagnostic?: boolean;
    } = {},
) {
    const result = {
        adapterId: "OPENCODE",
        environment: {
            platform: overrides.platform ?? "win32",
            platformInstanceId: overrides.platformInstanceId ?? "desktop-local",
        },
        status: overrides.resultStatus ?? "complete",
        runtimes: [
            {
                agentRuntimeId: "OPENCODE_CLI",
                installationStatus: overrides.installationStatus ?? "available",
                projectDiscoveryStatus: overrides.projectDiscoveryStatus ?? "complete",
            },
        ],
        projects: Array.from({ length: overrides.projectCount ?? 1 }, (_, index) => ({ projectKey: `project-${index}` })),
        targets: Array.from({ length: overrides.targetCount ?? 1 }, () => ({
            displayPath: overrides.targetPath ?? "C:\\proof\\project",
            entryApplicabilities: [{ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan" }],
        })),
        diagnostics: overrides.includeUnsupportedDiagnostic
            ? [{ code: "unsupported_platform", operation: "probe", severity: "error" }]
            : [{ code: "proof.warning", operation: "probe", severity: "warning" }],
    };
    return {
        status: "complete",
        diagnostics: [{ code: "proof.warning", operation: "probe", severity: "warning" }],
        value: { results: Array.from({ length: overrides.resultCount ?? 1 }, () => result) },
    };
}

function connectionFixture(options: {
    readonly terminal?:
        | ReturnType<typeof terminalResult>
        | { readonly status: "failed"; readonly diagnostics: readonly unknown[] };
    readonly alreadyEnabled?: boolean;
    readonly initializationVersion?: number;
    readonly getFails?: boolean;
    readonly replacementFails?: boolean;
    readonly replacementOmitsOpenCode?: boolean;
}) {
    const initialize = vi.fn(async () => ({ protocolVersion: options.initializationVersion ?? 1 }));
    const request = vi.fn(async (method: string) => {
        if (method === "adapter_enablement.get") {
            if (options.getFails) return { status: "failed", diagnostics: [] };
            return {
                status: "complete",
                value: {
                    revision: options.alreadyEnabled ? 1 : 0,
                    settingFingerprint: "sha256:enablement",
                    enabledAdapterIds: options.alreadyEnabled ? ["OPENCODE"] : [],
                },
            };
        }
        if (method === "adapter_enablement.replace") {
            if (options.replacementFails) return { status: "failed", diagnostics: [] };
            return {
                status: "complete",
                value: { enabledAdapterIds: options.replacementOmitsOpenCode ? [] : ["OPENCODE"] },
            };
        }
        throw new Error(`unexpected request ${method}`);
    });
    const start = vi.fn(async () => ({
        operationId: "operation-1",
        operation: "adapter.probe",
        terminal: Promise.resolve(options.terminal ?? terminalResult()),
        terminalSequence: null,
        subscribeProgress: () => () => undefined,
    }));
    const close = vi.fn();
    const connection = {
        state: "created",
        availableOperations: [],
        initialize,
        request,
        start,
        subscribeInvalidation: () => () => undefined,
        subscribeClose: () => () => undefined,
        close,
    } as unknown as ClientConnectionApi;
    return { connection, initialize, request, start, close };
}

function browserPort(): BrowserProtocolPort {
    return {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

describe("packaged OpenCode project renderer proof", () => {
    it("strictly parses proof requests and replies", () => {
        expect(parsePackagedOpenCodeProjectProofRequest(REQUEST)).toEqual(REQUEST);
        expect(() => parsePackagedOpenCodeProjectProofRequest({ ...REQUEST, extra: true })).toThrow(/invalid/u);
        expect(() =>
            parsePackagedOpenCodeProjectProofRequest({
                ...REQUEST,
                mode: "selected_wsl",
            }),
        ).toThrow(/invalid/u);
        const proof = {
            mode: "native",
            platform: "win32",
            platformInstanceId: "desktop-local",
            operationStatus: "complete",
            resultStatus: "complete",
            projectDiscoveryStatus: "complete",
            projectCount: 1,
            targetPath: "C:\\proof\\project",
            diagnosticCodes: ["proof.warning"],
        };
        expect(parsePackagedOpenCodeProjectProofReply({ status: "complete", proof })).toEqual({
            status: "complete",
            proof,
        });
        expect(parsePackagedOpenCodeProjectProofReply({ status: "failed", step: "probe", detail: "failed" })).toEqual({
            status: "failed",
            step: "probe",
            detail: "failed",
        });
        expect(() =>
            parsePackagedOpenCodeProjectProofReply({ status: "failed", step: "unknown-step", detail: "failed" }),
        ).toThrow(/invalid/u);
    });

    it("enables OpenCode and returns one exact physical target with deduplicated diagnostics", async () => {
        const value = connectionFixture({});
        await expect(provePackagedOpenCodeProjectWithConnection(value.connection, REQUEST)).resolves.toEqual({
            mode: "native",
            platform: "win32",
            platformInstanceId: "desktop-local",
            operationStatus: "complete",
            resultStatus: "complete",
            projectDiscoveryStatus: "complete",
            projectCount: 1,
            targetPath: "C:\\proof\\project",
            diagnosticCodes: ["proof.warning"],
        });
        expect(value.request.mock.calls.map(([method]) => method)).toEqual([
            "adapter_enablement.get",
            "adapter_enablement.replace",
        ]);
        expect(value.start).toHaveBeenCalledWith("adapter.probe", {
            adapterIds: ["OPENCODE"],
            environments: [{ platform: "win32", platformInstanceId: "desktop-local" }],
            authorization: { scope: "global" },
        });
    });

    it("preserves a truthful selected-WSL partial result", async () => {
        const targetPath = "\\\\wsl.localhost\\Ubuntu\\tmp\\proof\\project";
        const terminal = terminalResult({
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            targetPath,
            resultStatus: "partial",
        });
        terminal.status = "partial";
        terminal.value.results[0].diagnostics = [
            { code: "opencode_wsl_environment_unobserved", operation: "probe", severity: "warning" },
        ];
        const value = connectionFixture({ terminal, alreadyEnabled: true });
        await expect(
            provePackagedOpenCodeProjectWithConnection(value.connection, {
                mode: "selected_wsl",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                expectedTargetPath: targetPath,
            }),
        ).resolves.toMatchObject({
            mode: "selected_wsl",
            operationStatus: "partial",
            resultStatus: "partial",
            diagnosticCodes: ["opencode_wsl_environment_unobserved", "proof.warning"],
        });
        expect(value.request).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["wrong Protocol", { initializationVersion: 2 }, "initialize"],
        ["failed enablement read", { getFails: true }, "enablement"],
        ["failed replacement", { replacementFails: true }, "enablement"],
        ["replacement omission", { replacementOmitsOpenCode: true }, "enablement"],
        ["failed terminal", { terminal: { status: "failed" as const, diagnostics: [] } }, "probe"],
        ["duplicate results", { terminal: terminalResult({ resultCount: 2 }) }, "probe"],
        ["failed result", { terminal: terminalResult({ resultStatus: "failed" }) }, "runtime_identity"],
        [
            "wrong environment",
            { terminal: terminalResult({ platform: "wsl", platformInstanceId: "Ubuntu" }) },
            "runtime_identity",
        ],
        ["runtime unavailable", { terminal: terminalResult({ installationStatus: "not_found" }) }, "runtime_identity"],
        ["project discovery partial", { terminal: terminalResult({ projectDiscoveryStatus: "partial" }) }, "runtime_identity"],
        ["multiple projects", { terminal: terminalResult({ projectCount: 2 }) }, "exact_target"],
        ["multiple targets", { terminal: terminalResult({ targetCount: 2 }) }, "exact_target"],
        ["wrong target", { terminal: terminalResult({ targetPath: "C:\\foreign" }) }, "exact_target"],
        ["unsupported diagnostic", { terminal: terminalResult({ includeUnsupportedDiagnostic: true }) }, "exact_target"],
    ])("fails closed for a %s", async (_label, options, expectedStep) => {
        const value = connectionFixture(options);
        await expect(provePackagedOpenCodeProjectWithConnection(value.connection, REQUEST)).rejects.toMatchObject({
            step: expectedStep,
        });
    });

    it("owns the renderer transport lifecycle", async () => {
        const value = connectionFixture({ alreadyEnabled: true });
        const port = browserPort();
        const createConnection = vi.fn((transport: ClientMessageTransport) => {
            expect(transport).toBeDefined();
            return value.connection;
        }) as unknown as typeof createClientConnection;
        await expect(runPackagedOpenCodeProjectProof(port, REQUEST, createConnection, () => "request")).resolves.toMatchObject({
            targetPath: REQUEST.expectedTargetPath,
        });
        expect(value.close).toHaveBeenCalledOnce();
        expect(port.close).toHaveBeenCalledOnce();
    });

    it("posts a typed reply from the renderer listener and can be disposed", async () => {
        const value = connectionFixture({ alreadyEnabled: true });
        const port = browserPort();
        const resultPort = { postMessage: vi.fn(), close: vi.fn() };
        let receive: ((event: MessageEvent<unknown>) => void) | undefined;
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) => {
                receive = listener;
            }),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const createConnection = vi.fn(() => value.connection) as unknown as typeof createClientConnection;
        const dispose = installPackagedOpenCodeProjectProofListener(browserWindow, createConnection, () => "request");
        expect(receive).toBeDefined();
        receive?.({
            source: browserWindow,
            data: { signal: PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL, request: REQUEST },
            ports: [port, resultPort],
        } as unknown as MessageEvent<unknown>);
        await vi.waitFor(() =>
            expect(resultPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({ status: "complete" })),
        );
        expect(resultPort.close).toHaveBeenCalledOnce();
        dispose();
        expect(browserWindow.removeEventListener).toHaveBeenCalledWith("message", receive);
    });

    it("rejects malformed listener requests and closes invalid port sets", async () => {
        const value = connectionFixture({ alreadyEnabled: true });
        let receive: ((event: MessageEvent<unknown>) => void) | undefined;
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) => {
                receive = listener;
            }),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        installPackagedOpenCodeProjectProofListener(
            browserWindow,
            vi.fn(() => value.connection) as unknown as typeof createClientConnection,
            () => "request",
        );
        const singlePort = { close: vi.fn() };
        receive?.({
            source: browserWindow,
            data: { signal: PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL, request: REQUEST },
            ports: [singlePort],
        } as unknown as MessageEvent<unknown>);
        expect(singlePort.close).toHaveBeenCalledOnce();

        const protocolPort = browserPort();
        const resultPort = { postMessage: vi.fn(), close: vi.fn() };
        receive?.({
            source: browserWindow,
            data: { signal: PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL, request: {} },
            ports: [protocolPort, resultPort],
        } as unknown as MessageEvent<unknown>);
        await vi.waitFor(() =>
            expect(resultPort.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({ status: "failed", step: "unexpected" }),
            ),
        );
        expect(resultPort.close).toHaveBeenCalledOnce();
    });
});
