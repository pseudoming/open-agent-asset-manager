import path from "node:path";
import {
    PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL,
    type PackagedProofSubjectIdentity,
    type PackagedStateResilienceProofMode,
    type PackagedStateResilienceProofRequest,
    parsePackagedStateResilienceProofReply,
} from "../bridge/desktop-bridge";
import {
    PACKAGED_STATE_BACKUP_SMOKE_SWITCH,
    PACKAGED_STATE_REOPEN_SMOKE_SWITCH,
    PACKAGED_STATE_RESTORE_SMOKE_SWITCH,
    PACKAGED_STATE_TRASH_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";
import type { UtilityHostSupervisor, UtilityTransferPort } from "./utility-host-supervisor";

export {
    PACKAGED_STATE_BACKUP_SMOKE_SWITCH,
    PACKAGED_STATE_REOPEN_SMOKE_SWITCH,
    PACKAGED_STATE_RESTORE_SMOKE_SWITCH,
    PACKAGED_STATE_TRASH_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";

export const PACKAGED_STATE_BACKUP_LINE =
    "OAAM_DESKTOP_STATE_RESILIENCE_SMOKE backup=complete modes=none,compatible_password,strong_password";
export const PACKAGED_STATE_RESTORE_LINE =
    "OAAM_DESKTOP_STATE_RESILIENCE_SMOKE wrong-password=blocked restore=activated recovery-host=restricted";
export const PACKAGED_STATE_REOPEN_LINE =
    "OAAM_DESKTOP_STATE_RESILIENCE_SMOKE reopen=complete asset=preserved project=preserved deployment=preserved";
export const PACKAGED_STATE_TRASH_LINE = "OAAM_DESKTOP_STATE_RESILIENCE_SMOKE trash=recycle-bin inventory=retired";

export interface PackagedStateResilienceWebContents {
    postMessage(channel: string, message: unknown, transfer?: Electron.MessagePortMain[]): void;
}

export interface PackagedStateResilienceResultPort extends UtilityTransferPort {
    once(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "close", listener: () => void): this;
    start(): void;
}

export interface PackagedStateResilienceChannelFactory {
    createChannel(): {
        readonly hostPort: PackagedStateResilienceResultPort;
        readonly clientPort: UtilityTransferPort;
    };
}

const PROOF_SWITCHES = Object.freeze(
    new Map<string, PackagedStateResilienceProofMode>([
        [PACKAGED_STATE_BACKUP_SMOKE_SWITCH, "backup"],
        [PACKAGED_STATE_RESTORE_SMOKE_SWITCH, "restore"],
        [PACKAGED_STATE_REOPEN_SMOKE_SWITCH, "reopen"],
        [PACKAGED_STATE_TRASH_SMOKE_SWITCH, "trash"],
    ]),
);

export function packagedStateResilienceMode(argv: readonly string[]): PackagedStateResilienceProofMode | null {
    const matches = [...PROOF_SWITCHES].filter(([proofSwitch]) => argv.includes(proofSwitch));
    if (matches.length > 1) throw new Error("Packaged State resilience smoke accepts exactly one mode");
    return matches[0]?.[1] ?? null;
}

export function resolvePackagedStateRestoreArchive(homePath: string, environment: NodeJS.ProcessEnv = process.env): string {
    const home = exactNativeWindowsPath(homePath, "Desktop home");
    const candidate = exactNativeWindowsPath(environment.OAAM_PACKAGED_STATE_RESTORE_ARCHIVE, "State restore archive");
    const relative = path.win32.relative(home, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
        throw new Error("State restore archive must stay beneath the isolated Desktop home");
    }
    return candidate;
}

export async function provePackagedStateResilience(
    mode: PackagedStateResilienceProofMode,
    supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">,
    webContents: PackagedStateResilienceWebContents,
    resultChannels: PackagedStateResilienceChannelFactory,
    restoreArchivePath?: string,
    subject?: PackagedProofSubjectIdentity,
): Promise<void> {
    const protocolPorts: UtilityTransferPort[] = [];
    let request: PackagedStateResilienceProofRequest;
    try {
        if (mode === "restore") {
            if (restoreArchivePath === undefined) throw new Error("Packaged State restore proof requires an archive");
            protocolPorts.push(supervisor.connect({ claimPathSelectionAuthority: true }));
            const wrongPasswordArchiveToken = await supervisor.registerLocalPathSelection("restore_archive", restoreArchivePath);
            protocolPorts.push(supervisor.connect({ claimPathSelectionAuthority: true }));
            request = Object.freeze({
                mode,
                wrongPasswordArchiveToken,
                archiveToken: await supervisor.registerLocalPathSelection("restore_archive", restoreArchivePath),
            });
        } else {
            if (subject === undefined) throw new Error("Packaged State proof requires one exact fixture subject");
            protocolPorts.push(supervisor.connect({ claimPathSelectionAuthority: false }));
            request = Object.freeze({ mode, subject });
        }
    } catch (error) {
        for (const protocolPort of protocolPorts) protocolPort.close();
        throw error;
    }

    const resultChannel = resultChannels.createChannel();
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const closeAll = (): void => {
            for (const protocolPort of protocolPorts) protocolPort.close();
            resultChannel.hostPort.close();
        };
        resultChannel.hostPort.once("message", (event) => {
            if (settled) return;
            settled = true;
            try {
                const reply = parsePackagedStateResilienceProofReply(event.data);
                if (reply.status === "complete") resolve();
                else {
                    const diagnostics = reply.diagnosticCodes.length === 0 ? "" : ` (${reply.diagnosticCodes.join(",")})`;
                    reject(new Error(`Packaged State resilience proof failed at ${reply.step}${diagnostics}`));
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
            for (const protocolPort of protocolPorts) protocolPort.close();
            reject(new Error("Packaged State resilience proof result port closed before a result"));
        });
        resultChannel.hostPort.start();
        try {
            webContents.postMessage(PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL, request, [
                ...protocolPorts.map((protocolPort) => protocolPort as Electron.MessagePortMain),
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

export function packagedStateResilienceProofLine(mode: PackagedStateResilienceProofMode): string {
    switch (mode) {
        case "backup":
            return PACKAGED_STATE_BACKUP_LINE;
        case "restore":
            return PACKAGED_STATE_RESTORE_LINE;
        case "reopen":
            return PACKAGED_STATE_REOPEN_LINE;
        case "trash":
            return PACKAGED_STATE_TRASH_LINE;
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
