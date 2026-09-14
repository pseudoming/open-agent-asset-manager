import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL } from "../src/bridge/desktop-bridge";
import {
    applyPackagedOpenCodeProjectProofPlatformContexts,
    PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH,
    PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT,
    PACKAGED_OPENCODE_PROJECT_PROOF_LINE,
    PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT,
    PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT,
    PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH,
    PackagedOpenCodeProjectSmokeController,
    packagedOpenCodeProjectMode,
    provePackagedOpenCodeProjectDiscovery,
} from "../src/main/packaged-opencode-project-smoke";

class ResultPort extends EventEmitter {
    public readonly close = vi.fn(() => this.emit("close"));
    public readonly start = vi.fn();
}

function transferPort() {
    return { close: vi.fn() };
}

function completeProof(overrides: Record<string, unknown> = {}) {
    return {
        mode: "native",
        platform: "win32",
        platformInstanceId: "desktop-local",
        operationStatus: "complete",
        resultStatus: "complete",
        projectDiscoveryStatus: "complete",
        projectCount: 1,
        targetPath: "C:\\proof\\project",
        diagnosticCodes: [],
        ...overrides,
    };
}

function fixture() {
    const protocolPort = transferPort();
    const clientPort = transferPort();
    const hostPort = new ResultPort();
    const createChannel = vi.fn(() => ({ hostPort, clientPort }));
    const postMessage = vi.fn();
    const writeOutput = vi.fn();
    const input = {
        mode: "native" as const,
        platformContexts: [
            { platform: "win32" as const, platformInstanceId: "desktop-local", accessRootPath: "C:\\" },
            { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: "\\\\wsl.localhost\\Ubuntu\\" },
        ],
        environment: {
            [PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT]: "C:\\proof\\project",
            [PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT]: "Ubuntu",
        },
        connect: vi.fn(() => protocolPort),
        webContents: { postMessage },
        resultChannels: { createChannel },
        writeOutput,
    };
    return { protocolPort, clientPort, hostPort, createChannel, postMessage, writeOutput, input };
}

describe("packaged OpenCode project discovery main handoff", () => {
    it("selects only one explicit proof mode", () => {
        expect(packagedOpenCodeProjectMode([])).toBeNull();
        expect(packagedOpenCodeProjectMode([PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH])).toBe("native");
        expect(packagedOpenCodeProjectMode([PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH])).toBe("selected_wsl");
        expect(() =>
            packagedOpenCodeProjectMode([
                PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH,
                PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH,
            ]),
        ).toThrow(/exactly one mode/u);
    });

    it("narrows only the selected-WSL proof PlatformContext to one canonical isolated HOME", () => {
        const environment: NodeJS.ProcessEnv = {
            [PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT]: "Ubuntu",
            [PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT]: "\\\\wsl.localhost\\Ubuntu\\tmp\\oaam-proof\\home",
        };
        const platformContexts = [
            { platform: "win32" as const, platformInstanceId: "desktop-local", accessRootPath: "C:\\" },
            {
                platform: "wsl" as const,
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
            },
        ];
        const narrowed = applyPackagedOpenCodeProjectProofPlatformContexts("selected_wsl", environment, platformContexts);
        expect(narrowed).toEqual([
            platformContexts[0],
            {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\tmp\\oaam-proof\\home",
            },
        ]);
        expect(platformContexts[1]?.accessRootPath).toBe("\\\\wsl.localhost\\Ubuntu\\");
        expect(applyPackagedOpenCodeProjectProofPlatformContexts("native", {}, platformContexts)).toBe(platformContexts);
        expect(() =>
            applyPackagedOpenCodeProjectProofPlatformContexts(
                "native",
                {
                    [PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT]: "\\\\wsl.localhost\\Ubuntu\\tmp\\oaam-proof\\home",
                },
                platformContexts,
            ),
        ).toThrow(/valid only/u);
        for (const invalid of [
            "\\\\wsl.localhost\\Debian\\tmp\\oaam-proof\\home",
            "\\\\wsl.localhost\\Ubuntu\\tmp\\oaam-proof\\..\\foreign",
            "\\\\wsl.localhost\\Ubuntu\\",
        ]) {
            expect(() =>
                applyPackagedOpenCodeProjectProofPlatformContexts(
                    "selected_wsl",
                    {
                        [PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT]: "Ubuntu",
                        [PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT]: invalid,
                    },
                    platformContexts,
                ),
            ).toThrow(/canonical child/u);
        }
        const windowsContext = platformContexts[0];
        if (windowsContext === undefined) throw new Error("test fixture is missing its Windows context");
        expect(() => applyPackagedOpenCodeProjectProofPlatformContexts("selected_wsl", environment, [windowsContext])).toThrow(
            /boot-authorized/u,
        );
    });

    it("hands the Protocol port to renderer and validates the returned exact proof", async () => {
        const value = fixture();
        value.postMessage.mockImplementation((channel: string, request: unknown, ports?: Electron.MessagePortMain[]) => {
            expect(channel).toBe(PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL);
            expect(request).toEqual({
                mode: "native",
                environment: { platform: "win32", platformInstanceId: "desktop-local" },
                expectedTargetPath: "C:\\proof\\project",
            });
            expect(ports).toHaveLength(2);
            value.hostPort.emit("message", { data: { status: "complete", proof: completeProof() } });
        });

        await expect(provePackagedOpenCodeProjectDiscovery(value.input)).resolves.toEqual(completeProof());
        expect(value.hostPort.start).toHaveBeenCalledOnce();
        expect(value.protocolPort.close).toHaveBeenCalledOnce();
        expect(value.hostPort.close).toHaveBeenCalledOnce();
        expect(value.writeOutput).toHaveBeenCalledWith(
            `${PACKAGED_OPENCODE_PROJECT_PROOF_LINE} ${JSON.stringify(completeProof())}\n`,
        );
    });

    it("hands off one selected-WSL request without adding native context", async () => {
        const value = fixture();
        const expectedTargetPath = "\\\\wsl.localhost\\Ubuntu\\tmp\\proof\\project";
        value.postMessage.mockImplementation((_channel: string, request: unknown) => {
            expect(request).toEqual({
                mode: "selected_wsl",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                expectedTargetPath,
            });
            value.hostPort.emit("message", {
                data: {
                    status: "complete",
                    proof: completeProof({
                        mode: "selected_wsl",
                        platform: "wsl",
                        platformInstanceId: "Ubuntu",
                        operationStatus: "partial",
                        resultStatus: "partial",
                        targetPath: expectedTargetPath,
                        diagnosticCodes: ["opencode_wsl_environment_unobserved"],
                    }),
                },
            });
        });
        await expect(
            provePackagedOpenCodeProjectDiscovery({
                ...value.input,
                mode: "selected_wsl",
                environment: {
                    ...value.input.environment,
                    [PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT]: expectedTargetPath,
                },
            }),
        ).resolves.toMatchObject({ mode: "selected_wsl", targetPath: expectedTargetPath });
    });

    it.each([
        ["renderer failure", { status: "failed", step: "probe", detail: "probe failed" }, /failed at probe/u],
        ["malformed reply", { status: "complete", proof: {} }, /invalid packaged OpenCode project proof result/u],
        [
            "mismatched proof",
            { status: "complete", proof: completeProof({ targetPath: "C:\\foreign" }) },
            /does not match its launch authority/u,
        ],
    ])("fails closed for a %s", async (_label, reply, expected) => {
        const value = fixture();
        value.postMessage.mockImplementation(() => value.hostPort.emit("message", { data: reply }));
        await expect(provePackagedOpenCodeProjectDiscovery(value.input)).rejects.toThrow(expected);
        expect(value.protocolPort.close).toHaveBeenCalledOnce();
        expect(value.hostPort.close).toHaveBeenCalledOnce();
    });

    it("fails if the renderer result port closes before evidence", async () => {
        const value = fixture();
        value.postMessage.mockImplementation(() => value.hostPort.emit("close"));
        await expect(provePackagedOpenCodeProjectDiscovery(value.input)).rejects.toThrow(/closed before a result/u);
        expect(value.protocolPort.close).toHaveBeenCalledOnce();
    });

    it("closes every created port if renderer delivery throws", async () => {
        const value = fixture();
        const failure = new Error("renderer unavailable");
        value.postMessage.mockImplementation(() => {
            throw failure;
        });
        await expect(provePackagedOpenCodeProjectDiscovery(value.input)).rejects.toBe(failure);
        expect(value.clientPort.close).toHaveBeenCalledOnce();
        expect(value.protocolPort.close).toHaveBeenCalledOnce();
        expect(value.hostPort.close).toHaveBeenCalledOnce();
    });

    it("closes the Protocol port if result-channel construction throws", async () => {
        const value = fixture();
        const failure = new Error("channel unavailable");
        value.createChannel.mockImplementation(() => {
            throw failure;
        });
        await expect(provePackagedOpenCodeProjectDiscovery(value.input)).rejects.toBe(failure);
        expect(value.protocolPort.close).toHaveBeenCalledOnce();
        expect(value.postMessage).not.toHaveBeenCalled();
    });

    it("starts its proof controller once and requests a successful shutdown", async () => {
        const value = fixture();
        const requestShutdown = vi.fn();
        value.postMessage.mockImplementation(() =>
            value.hostPort.emit("message", { data: { status: "complete", proof: completeProof() } }),
        );
        const controller = new PackagedOpenCodeProjectSmokeController({
            mode: "native",
            environment: value.input.environment,
            connect: value.input.connect,
            resultChannels: value.input.resultChannels,
            writeOutput: value.writeOutput,
            writeError: vi.fn(),
            requestShutdown,
        });
        expect(controller.start(value.input.platformContexts, value.input.webContents)).toBe(true);
        expect(controller.start(value.input.platformContexts, value.input.webContents)).toBe(false);
        await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledWith(false));
    });

    it("keeps a disabled controller inert and reports an enabled controller failure", async () => {
        const value = fixture();
        const inert = new PackagedOpenCodeProjectSmokeController({
            mode: null,
            environment: value.input.environment,
            connect: value.input.connect,
            resultChannels: value.input.resultChannels,
            writeOutput: value.writeOutput,
            writeError: vi.fn(),
            requestShutdown: vi.fn(),
        });
        expect(inert.start(value.input.platformContexts, value.input.webContents)).toBe(false);
        expect(value.input.connect).not.toHaveBeenCalled();

        const writeError = vi.fn();
        const requestShutdown = vi.fn();
        value.postMessage.mockImplementation(() =>
            value.hostPort.emit("message", { data: { status: "failed", step: "probe", detail: "probe failed" } }),
        );
        const failing = new PackagedOpenCodeProjectSmokeController({
            mode: "native",
            environment: value.input.environment,
            connect: value.input.connect,
            resultChannels: value.input.resultChannels,
            writeOutput: value.writeOutput,
            writeError,
            requestShutdown,
        });
        expect(failing.start(value.input.platformContexts, value.input.webContents)).toBe(true);
        await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledWith(true));
        expect(writeError).toHaveBeenCalledWith(
            expect.stringContaining("failed=packaged OpenCode project proof failed at probe"),
        );
    });

    it.each([
        ["missing target", { environment: {} }, PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT],
        [
            "missing WSL distribution",
            {
                mode: "selected_wsl" as const,
                environment: { [PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT]: "target" },
            },
            PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT,
        ],
        [
            "missing context",
            {
                platformContexts: [],
                environment: {
                    [PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT]: "C:\\proof\\project",
                    [PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT]: "Ubuntu",
                },
            },
            "boot-authorized PlatformContext",
        ],
        [
            "duplicate context",
            {
                platformContexts: [
                    { platform: "win32" as const, platformInstanceId: "desktop-local", accessRootPath: "C:\\" },
                    { platform: "win32" as const, platformInstanceId: "desktop-local", accessRootPath: "D:\\" },
                ],
                environment: {
                    [PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT]: "C:\\proof\\project",
                    [PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT]: "Ubuntu",
                },
            },
            "boot-authorized PlatformContext",
        ],
    ])("fails before opening a Protocol port for a %s", async (_label, overrides, expected) => {
        const value = fixture();
        await expect(
            provePackagedOpenCodeProjectDiscovery({
                ...value.input,
                ...overrides,
                environment: overrides.environment,
            }),
        ).rejects.toThrow(expected);
        expect(value.input.connect).not.toHaveBeenCalled();
    });
});
