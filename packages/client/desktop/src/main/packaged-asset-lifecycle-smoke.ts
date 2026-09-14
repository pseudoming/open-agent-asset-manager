import path from "node:path";
import {
    PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL,
    type PackagedProofSubjectIdentity,
    type PackagedAssetLifecycleProofRequest,
    parsePackagedAssetLifecycleProofControlRequest,
    parsePackagedAssetLifecycleProofReply,
} from "../bridge/desktop-bridge";
import type { UtilityHostSupervisor, UtilityTransferPort } from "./utility-host-supervisor";

export { PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
export const PACKAGED_ASSET_LIFECYCLE_LINE =
    "OAAM_DESKTOP_ASSET_LIFECYCLE_SMOKE catalog=51 paging=50 large-text=progressive compare=complete export=standard-zip copy=preserved delete=restored purge=recycle-bin failures=blocked";

export interface PackagedAssetLifecycleWebContents {
    postMessage(channel: string, message: unknown, transfer?: Electron.MessagePortMain[]): void;
}

export interface PackagedAssetLifecycleResultPort extends UtilityTransferPort {
    on(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "close", listener: () => void): this;
    postMessage(message: unknown): void;
    start(): void;
}

export interface PackagedAssetLifecycleChannelFactory {
    createChannel(): {
        readonly hostPort: PackagedAssetLifecycleResultPort;
        readonly clientPort: UtilityTransferPort;
    };
}

export function resolvePackagedAssetLifecycleExportPath(homePath: string, environment: NodeJS.ProcessEnv = process.env): string {
    const home = exactNativeWindowsPath(homePath, "Desktop home");
    const candidate = exactNativeWindowsPath(environment.OAAM_PACKAGED_ASSET_EXPORT_FILE, "Asset export file");
    const relative = path.win32.relative(home, candidate);
    if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.win32.sep}`) ||
        path.win32.isAbsolute(relative) ||
        path.win32.extname(candidate).toLocaleLowerCase("en-US") !== ".zip"
    ) {
        throw new Error("Packaged Asset export file must be one ZIP beneath the isolated Desktop home");
    }
    return candidate;
}

export async function provePackagedAssetLifecycle(
    supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">,
    webContents: PackagedAssetLifecycleWebContents,
    resultChannels: PackagedAssetLifecycleChannelFactory,
    exportFilePath: string,
    subject: PackagedProofSubjectIdentity,
): Promise<void> {
    const protocolPort = supervisor.connect({ claimPathSelectionAuthority: true });
    let request: PackagedAssetLifecycleProofRequest;
    try {
        request = Object.freeze({
            exportToken: await supervisor.registerLocalPathSelection("asset_export_file", exportFilePath),
            subject,
        });
    } catch (error) {
        protocolPort.close();
        throw error;
    }
    const resultChannel = resultChannels.createChannel();
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let existingExportTokenRequested = false;
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
                    parsePackagedAssetLifecycleProofControlRequest(event.data);
                    if (existingExportTokenRequested) {
                        throw new Error("Packaged Asset lifecycle proof requested a duplicate export token");
                    }
                    existingExportTokenRequested = true;
                    void supervisor
                        .registerLocalPathSelection("asset_export_file", exportFilePath)
                        .then((existingExportToken) => {
                            if (settled) return;
                            try {
                                resultChannel.hostPort.postMessage(
                                    Object.freeze({ control: "existing_export_token", existingExportToken }),
                                );
                            } catch (error) {
                                rejectAndClose(error);
                            }
                        }, rejectAndClose);
                } catch (error) {
                    rejectAndClose(error);
                }
                return;
            }
            try {
                const reply = parsePackagedAssetLifecycleProofReply(event.data);
                settled = true;
                if (reply.status === "complete") resolve();
                else {
                    const diagnostics = reply.diagnosticCodes.length === 0 ? "" : ` (${reply.diagnosticCodes.join(",")})`;
                    reject(new Error(`Packaged Asset lifecycle proof failed at ${reply.step}${diagnostics}`));
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
            reject(new Error("Packaged Asset lifecycle proof result port closed before a result"));
        });
        resultChannel.hostPort.start();
        try {
            webContents.postMessage(PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL, request, [
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
