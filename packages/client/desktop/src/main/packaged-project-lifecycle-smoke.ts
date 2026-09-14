import path from "node:path";
import {
    PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL,
    type PackagedProofSubjectIdentity,
    type PackagedProjectLifecycleProofRequest,
    parsePackagedProjectLifecycleProofReply,
} from "../bridge/desktop-bridge";
import type { UtilityHostSupervisor, UtilityTransferPort } from "./utility-host-supervisor";

export { PACKAGED_PROJECT_LIFECYCLE_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
export const PACKAGED_PROJECT_LIFECYCLE_LINE =
    "OAAM_DESKTOP_PROJECT_LIFECYCLE_SMOKE rename=same-uuid rebind=same-uuid stop=retained restore=same-uuid deployment-target=preserved external-roots=preserved";

export interface PackagedProjectLifecycleWebContents {
    postMessage(channel: string, message: unknown, transfer?: Electron.MessagePortMain[]): void;
}

export interface PackagedProjectLifecycleResultPort extends UtilityTransferPort {
    once(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "close", listener: () => void): this;
    start(): void;
}

export interface PackagedProjectLifecycleChannelFactory {
    createChannel(): {
        readonly hostPort: PackagedProjectLifecycleResultPort;
        readonly clientPort: UtilityTransferPort;
    };
}

export function resolvePackagedProjectRebindRoot(homePath: string, environment: NodeJS.ProcessEnv = process.env): string {
    const home = exactNativeWindowsPath(homePath, "Desktop home");
    const candidate = exactNativeWindowsPath(environment.OAAM_PACKAGED_PROJECT_REBIND_ROOT, "Project rebind root");
    const relative = path.win32.relative(home, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
        throw new Error("Packaged Project rebind root must stay beneath the isolated Desktop home");
    }
    return candidate;
}

export async function provePackagedProjectLifecycle(
    supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">,
    webContents: PackagedProjectLifecycleWebContents,
    resultChannels: PackagedProjectLifecycleChannelFactory,
    rebindRootPath: string,
    subject: PackagedProofSubjectIdentity,
): Promise<void> {
    const protocolPort = supervisor.connect({ claimPathSelectionAuthority: true });
    let request: PackagedProjectLifecycleProofRequest;
    try {
        request = Object.freeze({
            rebindRootToken: await supervisor.registerLocalPathSelection("project_root", rebindRootPath),
            subject,
        });
    } catch (error) {
        protocolPort.close();
        throw error;
    }
    const resultChannel = resultChannels.createChannel();
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const closeAll = (): void => {
            protocolPort.close();
            resultChannel.hostPort.close();
        };
        resultChannel.hostPort.once("message", (event) => {
            if (settled) return;
            settled = true;
            try {
                const reply = parsePackagedProjectLifecycleProofReply(event.data);
                if (reply.status === "complete") resolve();
                else {
                    const diagnostics = reply.diagnosticCodes.length === 0 ? "" : ` (${reply.diagnosticCodes.join(",")})`;
                    reject(new Error(`Packaged Project lifecycle proof failed at ${reply.step}${diagnostics}`));
                }
            } catch (error) {
                reject(error);
            } finally {
                closeAll();
            }
        });
        resultChannel.hostPort.once("close", () => {
            if (settled) return;
            settled = true;
            protocolPort.close();
            reject(new Error("Packaged Project lifecycle proof result port closed before a result"));
        });
        resultChannel.hostPort.start();
        try {
            webContents.postMessage(PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL, request, [
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
