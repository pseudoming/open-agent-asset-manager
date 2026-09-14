import path from "node:path";
import {
    PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL,
    type PackagedZcodeTargetAssetKind,
    type PackagedZcodeTargetProofMode,
    type PackagedZcodeTargetProofRequest,
    packagedZcodeTargetProtocolPortCount,
    parsePackagedZcodeTargetProofReply,
} from "../bridge/desktop-bridge";
import {
    type PackagedProofLaunchAuthorization,
    PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
    PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH,
    readPackagedProofFixtureSubjects,
    writePackagedProofFinalFixtureSubjects,
    writePackagedProofFixtureSubjects,
} from "./packaged-proof-launch-authority";
import type { UtilityHostSupervisor, UtilityTransferPort } from "./utility-host-supervisor";

export { PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH, PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
export const PACKAGED_ZCODE_DEPLOY_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE deploy=complete review=unmanaged-replacement target=AGENTS.md platform=win32 core-executor=production";
export const PACKAGED_ZCODE_WORKFLOW_DEPLOY_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE deploy=complete review=unmanaged-replacement target=.zcode/commands/oaam-phase56-workflow.md platform=win32 core-executor=production";
export const PACKAGED_ZCODE_REVERSE_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE stale-prepare=blocked reverse=committed immutable-previous-version=preserved";
export const PACKAGED_ZCODE_WORKFLOW_REVERSE_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE stale-prepare=blocked reverse=committed immutable-previous-version=preserved asset-kind=Workflow";
export const PACKAGED_ZCODE_SKILL_DEPLOY_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE deploy=complete review=unmanaged-replacement target=.zcode/skills/oaam-phase56-skill platform=win32 core-executor=production asset-kind=Skill";
export const PACKAGED_ZCODE_SKILL_REVERSE_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE stale-prepare=blocked reverse=committed immutable-previous-version=preserved asset-kind=Skill";
export const PACKAGED_ZCODE_SUBAGENT_DEPLOY_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE deploy=complete review=unmanaged-replacement target=.zcode/agents/oaam-phase56-subagent.md platform=win32 core-executor=production asset-kind=Subagent";
export const PACKAGED_ZCODE_SUBAGENT_REVERSE_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE stale-prepare=blocked reverse=committed immutable-previous-version=preserved asset-kind=Subagent";
export const PACKAGED_ZCODE_MEMORY_DEPLOY_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE deploy=complete review=unmanaged-replacement target=topics/oaam-phase56-memory.md platform=win32 core-executor=production asset-kind=Memory";
export const PACKAGED_ZCODE_MEMORY_REVERSE_LINE =
    "OAAM_DESKTOP_ZCODE_TARGET_SMOKE stale-prepare=blocked reverse=committed immutable-previous-version=preserved asset-kind=Memory";

export interface PackagedZcodeTargetWebContents {
    postMessage(channel: string, message: unknown, transfer?: Electron.MessagePortMain[]): void;
}

export interface PackagedZcodeTargetResultPort extends UtilityTransferPort {
    once(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    once(event: "close", listener: () => void): this;
    start(): void;
}

export interface PackagedZcodeTargetChannelFactory {
    createChannel(): {
        readonly hostPort: PackagedZcodeTargetResultPort;
        readonly clientPort: UtilityTransferPort;
    };
}

export interface PackagedZcodeTargetProofPreparation {
    readonly mode: PackagedZcodeTargetProofMode;
    readonly homePath: string;
    readonly supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">;
    readonly webContents: PackagedZcodeTargetWebContents;
    readonly resultChannels: PackagedZcodeTargetChannelFactory;
    readonly authorization: PackagedProofLaunchAuthorization;
    readonly environment?: NodeJS.ProcessEnv;
}

export function packagedZcodeTargetMode(argv: readonly string[]): PackagedZcodeTargetProofMode | null {
    const deploy = argv.includes(PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH);
    const reverse = argv.includes(PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH);
    if (deploy && reverse) throw new Error("Packaged ZCode target smoke accepts exactly one mode");
    if (deploy) return "deploy";
    if (reverse) return "reverse";
    return null;
}

export function packagedZcodeTargetAssetKind(environment: NodeJS.ProcessEnv = process.env): PackagedZcodeTargetAssetKind {
    const value = environment.OAAM_PACKAGED_ZCODE_ASSET_KIND;
    if (value === undefined || value === "Guidance") return "Guidance";
    if (value === "Workflow" || value === "Skill" || value === "Subagent" || value === "Memory") return value;
    throw new Error("Packaged ZCode target smoke asset kind must be Guidance, Workflow, Skill, Subagent, or Memory");
}

export function resolvePackagedZcodeProjectRoots(homePath: string, environment: NodeJS.ProcessEnv = process.env) {
    const home = exactNativeWindowsPath(homePath, "Desktop home");
    const sourceProject = ownedChild(home, environment.OAAM_PACKAGED_ZCODE_SOURCE_PROJECT, "ZCode source project");
    const targetProject = ownedChild(home, environment.OAAM_PACKAGED_ZCODE_TARGET_PROJECT, "ZCode target project");
    if (sourceProject.toLowerCase() === targetProject.toLowerCase()) {
        throw new Error("Packaged ZCode source and target projects must be distinct");
    }
    return Object.freeze({ sourceProject, targetProject });
}

export function preparePackagedZcodeTargetProof(input: PackagedZcodeTargetProofPreparation): Readonly<{
    proof: Promise<void>;
    successLine: string;
}> {
    const environment = input.environment ?? process.env;
    const assetKind = packagedZcodeTargetAssetKind(environment);
    const roots = resolvePackagedZcodeProjectRoots(input.homePath, environment);
    const successLine =
        input.mode === "deploy"
            ? assetKind === "Memory"
                ? PACKAGED_ZCODE_MEMORY_DEPLOY_LINE
                : assetKind === "Skill"
                  ? PACKAGED_ZCODE_SKILL_DEPLOY_LINE
                  : assetKind === "Subagent"
                    ? PACKAGED_ZCODE_SUBAGENT_DEPLOY_LINE
                    : assetKind === "Workflow"
                      ? PACKAGED_ZCODE_WORKFLOW_DEPLOY_LINE
                      : PACKAGED_ZCODE_DEPLOY_LINE
            : assetKind === "Memory"
              ? PACKAGED_ZCODE_MEMORY_REVERSE_LINE
              : assetKind === "Skill"
                ? PACKAGED_ZCODE_SKILL_REVERSE_LINE
                : assetKind === "Subagent"
                  ? PACKAGED_ZCODE_SUBAGENT_REVERSE_LINE
                  : assetKind === "Workflow"
                    ? PACKAGED_ZCODE_WORKFLOW_REVERSE_LINE
                    : PACKAGED_ZCODE_REVERSE_LINE;
    return Object.freeze({
        proof: provePackagedZcodeTarget(
            input.mode,
            input.supervisor,
            input.webContents,
            input.resultChannels,
            roots,
            input.authorization,
            assetKind,
        ),
        successLine,
    });
}

export async function provePackagedZcodeTarget(
    mode: PackagedZcodeTargetProofMode,
    supervisor: Pick<UtilityHostSupervisor, "connect" | "registerLocalPathSelection">,
    webContents: PackagedZcodeTargetWebContents,
    resultChannels: PackagedZcodeTargetChannelFactory,
    roots: ReturnType<typeof resolvePackagedZcodeProjectRoots>,
    authorization: PackagedProofLaunchAuthorization,
    assetKind: PackagedZcodeTargetAssetKind = "Guidance",
): Promise<void> {
    const protocolPorts: UtilityTransferPort[] = [];
    let request: PackagedZcodeTargetProofRequest;
    try {
        if (mode === "deploy") {
            const connectWithProjectToken = async (rootPath: string): Promise<string> => {
                protocolPorts.push(supervisor.connect({ claimPathSelectionAuthority: true }));
                return supervisor.registerLocalPathSelection("project_root", rootPath);
            };
            request = Object.freeze({
                mode,
                assetKind,
                sourceProjectRegistrationToken: await connectWithProjectToken(roots.sourceProject),
                sourceProjectToken: await connectWithProjectToken(roots.sourceProject),
                targetProjectRegistrationToken: await connectWithProjectToken(roots.targetProject),
                targetProjectToken: await connectWithProjectToken(roots.targetProject),
            });
        } else {
            protocolPorts.push(supervisor.connect({ claimPathSelectionAuthority: false }));
            const subjects = readPackagedProofFixtureSubjects(authorization);
            if (subjects.assetKind !== assetKind) throw new Error("Packaged ZCode reverse proof asset kind changed");
            request = Object.freeze({ mode, assetKind, subject: subjects.target });
        }
    } catch (error) {
        for (const port of protocolPorts) port.close();
        throw error;
    }
    if (protocolPorts.length !== packagedZcodeTargetProtocolPortCount(mode)) {
        for (const port of protocolPorts) port.close();
        throw new Error("Packaged ZCode target proof created an invalid Protocol port count");
    }
    const resultChannel = resultChannels.createChannel();
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const closeAll = (): void => {
            for (const port of protocolPorts) port.close();
            resultChannel.hostPort.close();
        };
        resultChannel.hostPort.once("message", (event) => {
            if (settled) return;
            settled = true;
            try {
                const reply = parsePackagedZcodeTargetProofReply(event.data);
                if (reply.status === "complete") {
                    if (mode === "deploy") {
                        if (!("subjects" in reply) || reply.subjects === undefined) {
                            throw new Error("Packaged ZCode deploy proof omitted its exact fixture subjects");
                        }
                        writePackagedProofFixtureSubjects(authorization, reply.subjects);
                    } else {
                        if (!("subject" in reply)) {
                            throw new Error("Packaged ZCode reverse proof omitted its finalized fixture subject");
                        }
                        const original = readPackagedProofFixtureSubjects(authorization);
                        writePackagedProofFinalFixtureSubjects(
                            authorization,
                            Object.freeze({ assetKind: original.assetKind, source: original.source, target: reply.subject }),
                        );
                    }
                    resolve();
                } else {
                    const diagnostics = reply.diagnosticCodes.length === 0 ? "" : ` (${reply.diagnosticCodes.join(",")})`;
                    reject(new Error(`Packaged ZCode target proof failed at ${reply.step}${diagnostics}`));
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
            for (const port of protocolPorts) port.close();
            reject(new Error("Packaged ZCode target proof result port closed before a result"));
        });
        resultChannel.hostPort.start();
        try {
            webContents.postMessage(PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL, request, [
                ...protocolPorts.map((port) => port as Electron.MessagePortMain),
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

function ownedChild(home: string, value: string | undefined, label: string): string {
    const candidate = exactNativeWindowsPath(value, label);
    const relative = path.win32.relative(home, candidate);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) {
        throw new Error(`${label} must stay beneath the isolated Desktop home`);
    }
    return candidate;
}
