import path from "node:path";
import {
    PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL,
    type PackagedDiagnosticsProofRequest,
    parsePackagedDiagnosticsProofControlRequest,
    parsePackagedDiagnosticsProofReply,
} from "../bridge/desktop-bridge";
import { PACKAGED_DIAGNOSTICS_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
import type { UtilityHostSupervisor, UtilityTransferPort } from "./utility-host-supervisor";

export { PACKAGED_DIAGNOSTICS_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
export const PACKAGED_DIAGNOSTICS_LINE =
    "OAAM_DESKTOP_DIAGNOSTICS_SMOKE health=healthy logs=settings+cleared support=standard-zip+extended-reviewed cache=cleared reset=preserved performance=recorded+discarded failure=blocked";

export interface PackagedDiagnosticsWebContents {
    postMessage(channel: string, message: unknown, transfer?: Electron.MessagePortMain[]): void;
}

export interface PackagedDiagnosticsResultPort extends UtilityTransferPort {
    on(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "close", listener: () => void): this;
    postMessage(message: unknown): void;
    start(): void;
}

export interface PackagedDiagnosticsChannelFactory {
    createChannel(): {
        readonly hostPort: PackagedDiagnosticsResultPort;
        readonly clientPort: UtilityTransferPort;
    };
}

export function resolvePackagedDiagnosticsExportPath(homePath: string, environment: NodeJS.ProcessEnv = process.env): string {
    const home = exactNativeWindowsPath(homePath, "Desktop home");
    const candidate = exactNativeWindowsPath(environment.OAAM_PACKAGED_SUPPORT_BUNDLE_FILE, "support-bundle export file");
    const relative = path.win32.relative(home, candidate);
    if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.win32.sep}`) ||
        path.win32.isAbsolute(relative) ||
        path.win32.extname(candidate).toLocaleLowerCase("en-US") !== ".zip"
    ) {
        throw new Error("Packaged support-bundle export must be one ZIP beneath the isolated Desktop home");
    }
    return candidate;
}

export async function provePackagedDiagnostics(
    supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">,
    webContents: PackagedDiagnosticsWebContents,
    resultChannels: PackagedDiagnosticsChannelFactory,
    exportFilePath: string,
): Promise<void> {
    const protocolPort = supervisor.connect({ claimPathSelectionAuthority: true });
    let request: PackagedDiagnosticsProofRequest;
    try {
        request = Object.freeze({
            supportBundleExportToken: await supervisor.registerLocalPathSelection("support_bundle_file", exportFilePath),
        });
    } catch (error) {
        protocolPort.close();
        throw error;
    }
    const resultChannel = resultChannels.createChannel();
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let existingTokenRequested = false;
        const closeAll = (): void => {
            protocolPort.close();
            resultChannel.hostPort.close();
        };
        const rejectAndClose = (error: unknown): void => {
            if (settled) return;
            settled = true;
            closeAll();
            reject(error);
        };
        resultChannel.hostPort.on("message", (event) => {
            if (settled) return;
            if (event.data !== null && typeof event.data === "object" && "control" in event.data) {
                try {
                    parsePackagedDiagnosticsProofControlRequest(event.data);
                    if (existingTokenRequested) throw new Error("Packaged diagnostics proof requested a duplicate token");
                    existingTokenRequested = true;
                    void supervisor.registerLocalPathSelection("support_bundle_file", exportFilePath).then((token) => {
                        if (settled) return;
                        resultChannel.hostPort.postMessage(
                            Object.freeze({
                                control: "existing_support_bundle_token",
                                existingSupportBundleToken: token,
                            }),
                        );
                    }, rejectAndClose);
                } catch (error) {
                    rejectAndClose(error);
                }
                return;
            }
            try {
                const reply = parsePackagedDiagnosticsProofReply(event.data);
                settled = true;
                if (reply.status === "complete") resolve();
                else {
                    const diagnostics = reply.diagnosticCodes.length === 0 ? "" : ` (${reply.diagnosticCodes.join(",")})`;
                    reject(new Error(`Packaged diagnostics proof failed at ${reply.step}${diagnostics}`));
                }
            } catch (error) {
                reject(error);
            } finally {
                settled = true;
                closeAll();
            }
        });
        resultChannel.hostPort.once("close", () => {
            if (settled) return;
            settled = true;
            protocolPort.close();
            reject(new Error("Packaged diagnostics proof result port closed before a result"));
        });
        resultChannel.hostPort.start();
        try {
            webContents.postMessage(PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL, request, [
                protocolPort as Electron.MessagePortMain,
                resultChannel.clientPort as Electron.MessagePortMain,
            ]);
        } catch (error) {
            settled = true;
            resultChannel.clientPort.close();
            closeAll();
            reject(error);
        }
    });
}

export interface PackagedDiagnosticsSmokeControllerDependencies {
    readonly homePath: () => string;
    readonly channels: PackagedDiagnosticsChannelFactory;
    readonly writeOutput: (text: string) => void;
    readonly writeError: (text: string) => void;
    readonly requestShutdown: (failed: boolean) => void;
}

export class PackagedDiagnosticsSmokeController {
    readonly #enabled: boolean;
    readonly #dependencies: PackagedDiagnosticsSmokeControllerDependencies;
    #started = false;

    public constructor(argv: readonly string[], dependencies: PackagedDiagnosticsSmokeControllerDependencies) {
        this.#enabled = argv.includes(PACKAGED_DIAGNOSTICS_SMOKE_SWITCH);
        this.#dependencies = dependencies;
    }

    public start(
        supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">,
        webContents: PackagedDiagnosticsWebContents | undefined,
    ): void {
        if (!this.#enabled || this.#started || webContents === undefined) return;
        this.#started = true;
        let exportPath: string;
        try {
            exportPath = resolvePackagedDiagnosticsExportPath(this.#dependencies.homePath());
        } catch (error) {
            this.#fail(error);
            return;
        }
        void provePackagedDiagnostics(supervisor, webContents, this.#dependencies.channels, exportPath).then(
            () => {
                this.#dependencies.writeOutput(`${PACKAGED_DIAGNOSTICS_LINE}\n`);
                this.#dependencies.requestShutdown(false);
            },
            (error) => this.#fail(error),
        );
    }

    #fail(error: unknown): void {
        this.#dependencies.writeError(
            `OAAM_DESKTOP_DIAGNOSTICS_SMOKE failed=proof detail=${error instanceof Error ? error.message : String(error)}\n`,
        );
        this.#dependencies.requestShutdown(true);
    }
}

function exactNativeWindowsPath(value: string | undefined, label: string): string {
    if (
        typeof value !== "string" ||
        value === "" ||
        value.includes("\0") ||
        !path.win32.isAbsolute(value) ||
        !/^[a-z]:[\\/]/iu.test(value)
    ) {
        throw new Error(`${label} must be an absolute native Windows path`);
    }
    return path.win32.resolve(value);
}
