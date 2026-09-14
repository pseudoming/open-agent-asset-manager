import { win32 as win32Path } from "node:path";
import {
    PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL,
    type PackagedOpenCodeProjectProofMode,
    type PackagedOpenCodeProjectProofRequest,
    type PackagedOpenCodeProjectProofResult,
    parsePackagedOpenCodeProjectProofReply,
} from "../bridge/desktop-bridge";
import type { DesktopHostBootOptions } from "../process/control-protocol";
import {
    PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH,
    PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";
import type { UtilityTransferPort } from "./utility-host-supervisor";

export {
    PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH,
    PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";

export const PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT = "OAAM_PACKAGED_OPENCODE_WSL_DISTRO";
export const PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT = "OAAM_PACKAGED_OPENCODE_WSL_HOME_PATH";
export const PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT = "OAAM_PACKAGED_OPENCODE_EXPECTED_TARGET_PATH";
export const PACKAGED_OPENCODE_PROJECT_PROOF_LINE = "OAAM_DESKTOP_OPENCODE_PROJECT_SMOKE";

export type PackagedOpenCodeProjectMode = PackagedOpenCodeProjectProofMode;

export interface PackagedOpenCodeProjectWebContents {
    postMessage(channel: string, message: unknown, transfer?: Electron.MessagePortMain[]): void;
}

export interface PackagedOpenCodeProjectResultPort extends UtilityTransferPort {
    once(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "close", listener: () => void): this;
    start(): void;
}

export interface PackagedOpenCodeProjectChannelFactory {
    createChannel(): {
        readonly hostPort: PackagedOpenCodeProjectResultPort;
        readonly clientPort: UtilityTransferPort;
    };
}

interface PackagedOpenCodeProjectProofInput {
    readonly mode: PackagedOpenCodeProjectMode;
    readonly platformContexts: DesktopHostBootOptions["platformContexts"];
    readonly environment: NodeJS.ProcessEnv;
    readonly connect: () => UtilityTransferPort;
    readonly webContents: PackagedOpenCodeProjectWebContents;
    readonly resultChannels: PackagedOpenCodeProjectChannelFactory;
    readonly writeOutput: (text: string) => void;
}

export interface PackagedOpenCodeProjectSmokeControllerDependencies {
    readonly mode: PackagedOpenCodeProjectMode | null;
    readonly environment: NodeJS.ProcessEnv;
    readonly connect: () => UtilityTransferPort;
    readonly resultChannels: PackagedOpenCodeProjectChannelFactory;
    readonly writeOutput: (text: string) => void;
    readonly writeError: (text: string) => void;
    readonly requestShutdown: (failed: boolean) => void;
}

export class PackagedOpenCodeProjectSmokeController {
    readonly #dependencies: PackagedOpenCodeProjectSmokeControllerDependencies;
    #started = false;

    public constructor(dependencies: PackagedOpenCodeProjectSmokeControllerDependencies) {
        this.#dependencies = dependencies;
    }

    public start(
        platformContexts: DesktopHostBootOptions["platformContexts"],
        webContents: PackagedOpenCodeProjectWebContents,
    ): boolean {
        if (this.#dependencies.mode === null || this.#started) return false;
        this.#started = true;
        void provePackagedOpenCodeProjectDiscovery({
            mode: this.#dependencies.mode,
            platformContexts,
            environment: this.#dependencies.environment,
            connect: this.#dependencies.connect,
            webContents,
            resultChannels: this.#dependencies.resultChannels,
            writeOutput: this.#dependencies.writeOutput,
        }).then(
            () => this.#dependencies.requestShutdown(false),
            (error) => {
                this.#dependencies.writeError(
                    `OAAM_DESKTOP_OPENCODE_PROJECT_SMOKE failed=${error instanceof Error ? error.message : String(error)}\n`,
                );
                this.#dependencies.requestShutdown(true);
            },
        );
        return true;
    }
}

export function packagedOpenCodeProjectMode(argv: readonly string[]): PackagedOpenCodeProjectMode | null {
    const native = argv.includes(PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH);
    const selectedWsl = argv.includes(PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH);
    if (native && selectedWsl) throw new TypeError("packaged OpenCode project proof accepts exactly one mode");
    if (native) return "native";
    if (selectedWsl) return "selected_wsl";
    return null;
}

export function applyPackagedOpenCodeProjectProofPlatformContexts(
    mode: PackagedOpenCodeProjectMode | null,
    environment: NodeJS.ProcessEnv,
    platformContexts: DesktopHostBootOptions["platformContexts"],
): DesktopHostBootOptions["platformContexts"] {
    const wslHome = environment[PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT];
    if (mode !== "selected_wsl") {
        if (wslHome !== undefined) throw new TypeError("packaged OpenCode WSL HOME is valid only for the selected-WSL proof");
        return platformContexts;
    }
    const distroName = requiredEnvironmentValue(environment, PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT);
    const canonicalHome = requiredEnvironmentValue(environment, PACKAGED_OPENCODE_PROJECT_WSL_HOME_ENVIRONMENT);
    const root = `\\\\wsl.localhost\\${distroName}\\`;
    if (
        !win32Path.isAbsolute(canonicalHome) ||
        win32Path.normalize(canonicalHome) !== canonicalHome ||
        !canonicalHome.toLowerCase().startsWith(root.toLowerCase()) ||
        canonicalHome.length <= root.length
    ) {
        throw new TypeError("packaged OpenCode WSL HOME must be one canonical child of the selected WSL share");
    }
    const matches = platformContexts.filter((context) => context.platform === "wsl" && context.platformInstanceId === distroName);
    if (matches.length !== 1) {
        throw new TypeError("packaged OpenCode WSL HOME requires one exact boot-authorized WSL PlatformContext");
    }
    const selected = matches[0];
    return Object.freeze(
        platformContexts.map((context) =>
            context === selected ? Object.freeze({ ...context, accessRootPath: canonicalHome }) : context,
        ),
    );
}

export async function provePackagedOpenCodeProjectDiscovery(
    input: PackagedOpenCodeProjectProofInput,
): Promise<PackagedOpenCodeProjectProofResult> {
    const request = resolveProofRequest(input);
    const protocolPort = input.connect();
    let resultChannel: ReturnType<PackagedOpenCodeProjectChannelFactory["createChannel"]>;
    try {
        resultChannel = input.resultChannels.createChannel();
    } catch (error) {
        protocolPort.close();
        throw error;
    }
    return new Promise<PackagedOpenCodeProjectProofResult>((resolve, reject) => {
        let settled = false;
        const closeAll = (): void => {
            protocolPort.close();
            resultChannel.hostPort.close();
        };
        resultChannel.hostPort.once("message", (event) => {
            if (settled) return;
            settled = true;
            try {
                const reply = parsePackagedOpenCodeProjectProofReply(event.data);
                if (reply.status === "failed") {
                    reject(new Error(`packaged OpenCode project proof failed at ${reply.step}: ${reply.detail}`));
                    return;
                }
                assertProofMatchesRequest(reply.proof, request);
                input.writeOutput(`${PACKAGED_OPENCODE_PROJECT_PROOF_LINE} ${JSON.stringify(reply.proof)}\n`);
                resolve(reply.proof);
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
            reject(new Error("packaged OpenCode project proof result port closed before a result"));
        });
        resultChannel.hostPort.start();
        try {
            input.webContents.postMessage(PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL, request, [
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

function resolveProofRequest(input: PackagedOpenCodeProjectProofInput): PackagedOpenCodeProjectProofRequest {
    const platform = input.mode === "native" ? "win32" : "wsl";
    const platformInstanceId =
        input.mode === "native"
            ? "desktop-local"
            : requiredEnvironmentValue(input.environment, PACKAGED_OPENCODE_PROJECT_WSL_DISTRO_ENVIRONMENT);
    const matches = input.platformContexts.filter(
        (candidate) => candidate.platform === platform && candidate.platformInstanceId === platformInstanceId,
    );
    if (matches.length !== 1) {
        throw new Error("packaged OpenCode project proof requires one exact boot-authorized PlatformContext");
    }
    return Object.freeze({
        mode: input.mode,
        environment: Object.freeze({ platform, platformInstanceId }),
        expectedTargetPath: requiredEnvironmentValue(input.environment, PACKAGED_OPENCODE_PROJECT_EXPECTED_TARGET_ENVIRONMENT),
    });
}

function assertProofMatchesRequest(
    proof: PackagedOpenCodeProjectProofResult,
    request: PackagedOpenCodeProjectProofRequest,
): void {
    if (
        proof.mode !== request.mode ||
        proof.platform !== request.environment.platform ||
        proof.platformInstanceId !== request.environment.platformInstanceId ||
        proof.targetPath !== request.expectedTargetPath
    ) {
        throw new Error("packaged OpenCode project proof reply does not match its launch authority");
    }
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        throw new TypeError(`${name} must be one non-empty NUL-free value`);
    }
    return value;
}
