import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL,
    packagedZcodeTargetProtocolPortCount,
    packagedZcodeTargetTransferPortCount,
    parsePackagedZcodeTargetProofReply,
    parsePackagedZcodeTargetProofRequest,
} from "../src/bridge/desktop-bridge";
import {
    PACKAGED_ZCODE_SKILL_DEPLOY_LINE,
    PACKAGED_ZCODE_SUBAGENT_DEPLOY_LINE,
    PACKAGED_ZCODE_WORKFLOW_DEPLOY_LINE,
    PACKAGED_ZCODE_MEMORY_DEPLOY_LINE,
    PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
    PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH,
    packagedZcodeTargetAssetKind,
    packagedZcodeTargetMode,
    preparePackagedZcodeTargetProof,
    provePackagedZcodeTarget,
    resolvePackagedZcodeProjectRoots,
} from "../src/main/packaged-zcode-target-smoke";
import {
    type PackagedProofLaunchAuthorization,
    readPackagedProofFixtureSubjects,
    writePackagedProofFixtureSubjects,
} from "../src/main/packaged-proof-launch-authority";

class ResultPort extends EventEmitter {
    public readonly close = vi.fn(() => this.emit("close"));
    public readonly start = vi.fn();
}

function transferPort() {
    return { close: vi.fn() };
}

const SUBJECTS = Object.freeze({
    assetKind: "Guidance" as const,
    source: Object.freeze({ projectId: "source-project", assetId: "source-asset", versionId: "source-version" }),
    target: Object.freeze({
        projectId: "target-project",
        assetId: "target-asset",
        versionId: "target-version",
        deploymentId: "target-deployment",
    }),
});
const temporaryRoots: string[] = [];

function authorization(mode: "deploy" | "reverse"): PackagedProofLaunchAuthorization {
    const profileRootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-target-smoke-"));
    temporaryRoots.push(profileRootPath);
    const ownership = Object.freeze({
        ownerId: "zcode_guidance_target_lifecycle",
        inheritance: Object.freeze({ kind: "none" as const }),
        producerSwitch: PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
        consumerSwitches: Object.freeze([PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH]),
        continuityToken: "a".repeat(64),
    });
    const result = Object.freeze({
        proofSwitch: mode === "deploy" ? PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH : PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH,
        profileRootPath,
        ownership,
    });
    if (mode === "reverse") {
        writePackagedProofFixtureSubjects(
            Object.freeze({ ...result, proofSwitch: PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH }),
            SUBJECTS,
        );
    }
    return result;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const protocolPorts = [transferPort(), transferPort(), transferPort(), transferPort()];
    const clientPort = transferPort();
    const hostPort = new ResultPort();
    let registration = 0;
    const registerLocalPathSelection = vi.fn(async (_kind: string, rootPath: string) => {
        registration += 1;
        return `token:${String(registration)}:${rootPath}`;
    });
    const supervisor = {
        connect: vi.fn(() => protocolPorts[supervisor.connect.mock.calls.length - 1] ?? transferPort()),
        registerLocalPathSelection,
    };
    const createChannel = vi.fn(() => ({ hostPort, clientPort }));
    const roots = {
        sourceProject: "C:\\proof\\source",
        targetProject: "C:\\proof\\target",
    };
    return { protocolPorts, clientPort, hostPort, supervisor, createChannel, registerLocalPathSelection, roots };
}

describe("packaged ZCode target main-process proof", () => {
    it("selects exactly one diagnostic mode", () => {
        expect(packagedZcodeTargetMode([])).toBeNull();
        expect(packagedZcodeTargetMode([PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH])).toBe("deploy");
        expect(packagedZcodeTargetMode([PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH])).toBe("reverse");
        expect(() => packagedZcodeTargetMode([PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH, PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH])).toThrow(
            /exactly one mode/u,
        );
    });

    it("defaults the targeted asset kind to Guidance and accepts the explicit lifecycle alternatives", () => {
        expect(packagedZcodeTargetAssetKind({})).toBe("Guidance");
        expect(packagedZcodeTargetAssetKind({ OAAM_PACKAGED_ZCODE_ASSET_KIND: "Workflow" })).toBe("Workflow");
        expect(packagedZcodeTargetAssetKind({ OAAM_PACKAGED_ZCODE_ASSET_KIND: "Skill" })).toBe("Skill");
        expect(packagedZcodeTargetAssetKind({ OAAM_PACKAGED_ZCODE_ASSET_KIND: "Subagent" })).toBe("Subagent");
        expect(packagedZcodeTargetAssetKind({ OAAM_PACKAGED_ZCODE_ASSET_KIND: "Memory" })).toBe("Memory");
        expect(() => packagedZcodeTargetAssetKind({ OAAM_PACKAGED_ZCODE_ASSET_KIND: "Rule" })).toThrow(
            /Guidance, Workflow, Skill, Subagent, or Memory/u,
        );
    });

    it("parses exact deploy and reverse protocol messages and computes their owned port counts", () => {
        const deploy = {
            mode: "deploy",
            assetKind: "Workflow",
            sourceProjectRegistrationToken: "source-project-registration-token",
            sourceProjectToken: "source-token",
            targetProjectRegistrationToken: "target-project-registration-token",
            targetProjectToken: "target-token",
        } as const;
        expect(parsePackagedZcodeTargetProofRequest(deploy)).toEqual(deploy);
        expect(
            parsePackagedZcodeTargetProofRequest({ mode: "reverse", assetKind: "Workflow", subject: SUBJECTS.target }),
        ).toEqual({ mode: "reverse", assetKind: "Workflow", subject: SUBJECTS.target });
        expect(packagedZcodeTargetProtocolPortCount("deploy")).toBe(4);
        expect(packagedZcodeTargetProtocolPortCount("reverse")).toBe(1);
        expect(packagedZcodeTargetTransferPortCount("deploy")).toBe(5);
        expect(packagedZcodeTargetTransferPortCount("reverse")).toBe(2);
        expect(parsePackagedZcodeTargetProofReply({ status: "complete" })).toEqual({ status: "complete" });
        expect(
            parsePackagedZcodeTargetProofReply({ status: "failed", step: "stale_reverse", diagnosticCodes: ["reverse.stale"] }),
        ).toEqual({ status: "failed", step: "stale_reverse", diagnosticCodes: ["reverse.stale"] });
    });

    it("rejects malformed target protocol requests and replies", () => {
        for (const malformed of [
            {
                mode: "deploy",
                assetKind: "Workflow",
                sourceProjectRegistrationToken: "registration",
                sourceProjectToken: "",
                targetProjectRegistrationToken: "target-registration",
                targetProjectToken: "target",
            },
            {
                mode: "deploy",
                assetKind: "Rule",
                sourceProjectRegistrationToken: "registration",
                sourceProjectToken: "source",
                targetProjectRegistrationToken: "target-registration",
                targetProjectToken: "target",
            },
            {
                mode: "deploy",
                assetKind: "Guidance",
                sourceProjectRegistrationToken: "registration",
                sourceProjectToken: "source",
                targetProjectRegistrationToken: "target-registration",
                targetProjectToken: "bad\0target",
            },
            {
                mode: "deploy",
                assetKind: "Guidance",
                sourceProjectRegistrationToken: "registration",
                sourceProjectToken: "source",
                targetProjectToken: "target",
            },
            { mode: "reverse", assetKind: "Workflow", extra: true },
            { mode: "reverse", assetKind: "Workflow", subject: { ...SUBJECTS.target, assetId: " asset" } },
            { mode: "reverse", assetKind: "Workflow", subject: { ...SUBJECTS.target, deploymentId: "x".repeat(257) } },
        ]) {
            expect(() => parsePackagedZcodeTargetProofRequest(malformed)).toThrow(
                /invalid packaged (?:ZCode target proof|proof subject identity)/u,
            );
        }
        for (const malformed of [
            { status: "failed", step: "foreign", diagnosticCodes: [] },
            { status: "failed", step: "stale_reverse", diagnosticCodes: ["z", "a"] },
        ]) {
            expect(() => parsePackagedZcodeTargetProofReply(malformed)).toThrow(/invalid packaged ZCode target proof reply/u);
        }
    });

    it("accepts only distinct native projects owned by the isolated Desktop home", () => {
        expect(
            resolvePackagedZcodeProjectRoots("C:\\proof", {
                OAAM_PACKAGED_ZCODE_SOURCE_PROJECT: "C:\\proof\\source\\..\\source",
                OAAM_PACKAGED_ZCODE_TARGET_PROJECT: "C:\\proof\\target",
            }),
        ).toEqual({ sourceProject: "C:\\proof\\source", targetProject: "C:\\proof\\target" });
    });

    it.each([
        ["missing source", "C:\\proof", undefined, "C:\\proof\\target", /absolute native Windows path/u],
        ["relative source", "C:\\proof", "source", "C:\\proof\\target", /absolute native Windows path/u],
        ["NUL source", "C:\\proof", "C:\\proof\\bad\0source", "C:\\proof\\target", /absolute native Windows path/u],
        ["foreign source", "C:\\proof", "D:\\source", "C:\\proof\\target", /beneath the isolated Desktop home/u],
        ["parent source", "C:\\proof", "C:\\outside", "C:\\proof\\target", /beneath the isolated Desktop home/u],
        ["home as source", "C:\\proof", "C:\\proof", "C:\\proof\\target", /beneath the isolated Desktop home/u],
        ["same projects", "C:\\proof", "C:\\proof\\same", "c:\\proof\\same", /must be distinct/u],
        ["invalid home", "/proof", "C:\\proof\\source", "C:\\proof\\target", /absolute native Windows path/u],
    ])("rejects %s", (_label, home, source, target, expected) => {
        expect(() =>
            resolvePackagedZcodeProjectRoots(home, {
                OAAM_PACKAGED_ZCODE_SOURCE_PROJECT: source,
                OAAM_PACKAGED_ZCODE_TARGET_PROJECT: target,
            }),
        ).toThrow(expected);
    });

    it("claims path authority, registers both roots and closes every port after a complete deploy reply", async () => {
        const value = fixture();
        const postMessage = vi.fn((channel: string, request: unknown, ports?: Electron.MessagePortMain[]) => {
            expect(channel).toBe(PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL);
            expect(request).toEqual({
                mode: "deploy",
                assetKind: "Guidance",
                sourceProjectRegistrationToken: `token:1:${value.roots.sourceProject}`,
                sourceProjectToken: `token:2:${value.roots.sourceProject}`,
                targetProjectRegistrationToken: `token:3:${value.roots.targetProject}`,
                targetProjectToken: `token:4:${value.roots.targetProject}`,
            });
            expect(ports).toHaveLength(5);
            value.hostPort.emit("message", { data: { status: "complete", subjects: SUBJECTS } });
        });

        await expect(
            provePackagedZcodeTarget(
                "deploy",
                value.supervisor,
                { postMessage },
                { createChannel: value.createChannel },
                value.roots,
                authorization("deploy"),
            ),
        ).resolves.toBeUndefined();
        expect(value.supervisor.connect).toHaveBeenCalledTimes(4);
        expect(value.supervisor.connect).toHaveBeenCalledWith({ claimPathSelectionAuthority: true });
        expect(value.registerLocalPathSelection.mock.calls).toEqual([
            ["project_root", value.roots.sourceProject],
            ["project_root", value.roots.sourceProject],
            ["project_root", value.roots.targetProject],
            ["project_root", value.roots.targetProject],
        ]);
        expect(value.hostPort.start).toHaveBeenCalledOnce();
        expect(value.hostPort.close).toHaveBeenCalledOnce();
        for (const port of value.protocolPorts) expect(port.close).toHaveBeenCalledOnce();
    });

    it("prepares a Workflow deploy with exact owned roots and the Workflow-specific terminal line", async () => {
        const value = fixture();
        const workflowSubjects = Object.freeze({ ...SUBJECTS, assetKind: "Workflow" as const });
        const postMessage = vi.fn((_channel: string, request: unknown) => {
            expect(request).toEqual({
                mode: "deploy",
                assetKind: "Workflow",
                sourceProjectRegistrationToken: `token:1:${value.roots.sourceProject}`,
                sourceProjectToken: `token:2:${value.roots.sourceProject}`,
                targetProjectRegistrationToken: `token:3:${value.roots.targetProject}`,
                targetProjectToken: `token:4:${value.roots.targetProject}`,
            });
            value.hostPort.emit("message", { data: { status: "complete", subjects: workflowSubjects } });
        });
        const prepared = preparePackagedZcodeTargetProof({
            mode: "deploy",
            homePath: "C:\\proof",
            supervisor: value.supervisor,
            webContents: { postMessage },
            resultChannels: { createChannel: value.createChannel },
            authorization: authorization("deploy"),
            environment: {
                OAAM_PACKAGED_ZCODE_ASSET_KIND: "Workflow",
                OAAM_PACKAGED_ZCODE_SOURCE_PROJECT: value.roots.sourceProject,
                OAAM_PACKAGED_ZCODE_TARGET_PROJECT: value.roots.targetProject,
            },
        });

        expect(prepared.successLine).toBe(PACKAGED_ZCODE_WORKFLOW_DEPLOY_LINE);
        await expect(prepared.proof).resolves.toBeUndefined();
    });

    it("prepares a Skill deploy with exact owned roots and the Skill-specific terminal line", async () => {
        const value = fixture();
        const skillSubjects = Object.freeze({ ...SUBJECTS, assetKind: "Skill" as const });
        const postMessage = vi.fn((_channel: string, request: unknown) => {
            expect(request).toEqual({
                mode: "deploy",
                assetKind: "Skill",
                sourceProjectRegistrationToken: `token:1:${value.roots.sourceProject}`,
                sourceProjectToken: `token:2:${value.roots.sourceProject}`,
                targetProjectRegistrationToken: `token:3:${value.roots.targetProject}`,
                targetProjectToken: `token:4:${value.roots.targetProject}`,
            });
            value.hostPort.emit("message", { data: { status: "complete", subjects: skillSubjects } });
        });
        const prepared = preparePackagedZcodeTargetProof({
            mode: "deploy",
            homePath: "C:\\proof",
            supervisor: value.supervisor,
            webContents: { postMessage },
            resultChannels: { createChannel: value.createChannel },
            authorization: authorization("deploy"),
            environment: {
                OAAM_PACKAGED_ZCODE_ASSET_KIND: "Skill",
                OAAM_PACKAGED_ZCODE_SOURCE_PROJECT: value.roots.sourceProject,
                OAAM_PACKAGED_ZCODE_TARGET_PROJECT: value.roots.targetProject,
            },
        });

        expect(prepared.successLine).toBe(PACKAGED_ZCODE_SKILL_DEPLOY_LINE);
        await expect(prepared.proof).resolves.toBeUndefined();
    });

    it("prepares a Subagent deploy with exact owned roots and the Subagent-specific terminal line", async () => {
        const value = fixture();
        const subagentSubjects = Object.freeze({ ...SUBJECTS, assetKind: "Subagent" as const });
        const postMessage = vi.fn((_channel: string, request: unknown) => {
            expect(request).toEqual({
                mode: "deploy",
                assetKind: "Subagent",
                sourceProjectRegistrationToken: `token:1:${value.roots.sourceProject}`,
                sourceProjectToken: `token:2:${value.roots.sourceProject}`,
                targetProjectRegistrationToken: `token:3:${value.roots.targetProject}`,
                targetProjectToken: `token:4:${value.roots.targetProject}`,
            });
            value.hostPort.emit("message", { data: { status: "complete", subjects: subagentSubjects } });
        });
        const preparation = preparePackagedZcodeTargetProof({
            mode: "deploy",
            homePath: "C:\\proof",
            supervisor: value.supervisor,
            webContents: { postMessage },
            resultChannels: { createChannel: value.createChannel },
            authorization: authorization("deploy"),
            environment: {
                OAAM_PACKAGED_ZCODE_SOURCE_PROJECT: "C:\\proof\\source",
                OAAM_PACKAGED_ZCODE_TARGET_PROJECT: "C:\\proof\\target",
                OAAM_PACKAGED_ZCODE_ASSET_KIND: "Subagent",
            },
        });
        expect(preparation.successLine).toBe(PACKAGED_ZCODE_SUBAGENT_DEPLOY_LINE);
        await expect(preparation.proof).resolves.toBeUndefined();
    });

    it("prepares a Memory deploy with exact Project roots and the Memory-specific terminal line", async () => {
        const value = fixture();
        const memorySubjects = Object.freeze({ ...SUBJECTS, assetKind: "Memory" as const });
        const postMessage = vi.fn((_channel: string, request: unknown) => {
            expect(request).toEqual({
                mode: "deploy",
                assetKind: "Memory",
                sourceProjectRegistrationToken: `token:1:${value.roots.sourceProject}`,
                sourceProjectToken: `token:2:${value.roots.sourceProject}`,
                targetProjectRegistrationToken: `token:3:${value.roots.targetProject}`,
                targetProjectToken: `token:4:${value.roots.targetProject}`,
            });
            value.hostPort.emit("message", { data: { status: "complete", subjects: memorySubjects } });
        });
        const preparation = preparePackagedZcodeTargetProof({
            mode: "deploy",
            homePath: "C:\\proof",
            supervisor: value.supervisor,
            webContents: { postMessage },
            resultChannels: { createChannel: value.createChannel },
            authorization: authorization("deploy"),
            environment: {
                OAAM_PACKAGED_ZCODE_SOURCE_PROJECT: value.roots.sourceProject,
                OAAM_PACKAGED_ZCODE_TARGET_PROJECT: value.roots.targetProject,
                OAAM_PACKAGED_ZCODE_ASSET_KIND: "Memory",
            },
        });
        expect(preparation.successLine).toBe(PACKAGED_ZCODE_MEMORY_DEPLOY_LINE);
        await expect(preparation.proof).resolves.toBeUndefined();
    });

    it("finalizes only the exact reverse subject returned by the renderer", async () => {
        const value = fixture();
        const proofAuthorization = authorization("reverse");
        const finalTarget = Object.freeze({ ...SUBJECTS.target, versionId: "final-version" });
        const postMessage = vi.fn((_channel: string, request: unknown) => {
            expect(request).toEqual({ mode: "reverse", assetKind: "Guidance", subject: SUBJECTS.target });
            value.hostPort.emit("message", { data: { status: "complete", subject: finalTarget } });
        });

        await expect(
            provePackagedZcodeTarget(
                "reverse",
                value.supervisor,
                { postMessage },
                { createChannel: value.createChannel },
                value.roots,
                proofAuthorization,
            ),
        ).resolves.toBeUndefined();
        expect(readPackagedProofFixtureSubjects(proofAuthorization)).toEqual({
            assetKind: "Guidance",
            source: SUBJECTS.source,
            target: finalTarget,
        });
        expect(value.hostPort.close).toHaveBeenCalledOnce();
        expect(value.protocolPorts[0]?.close).toHaveBeenCalledOnce();
    });

    it.each(["deploy", "reverse"] as const)("rejects a complete %s reply without its exact subjects", async (mode) => {
        const value = fixture();
        const postMessage = vi.fn(() => value.hostPort.emit("message", { data: { status: "complete" } }));
        await expect(
            provePackagedZcodeTarget(
                mode,
                value.supervisor,
                { postMessage },
                { createChannel: value.createChannel },
                value.roots,
                authorization(mode),
            ),
        ).rejects.toThrow(mode === "deploy" ? /omitted its exact fixture subjects/u : /omitted its finalized fixture subject/u);
        expect(value.hostPort.close).toHaveBeenCalledOnce();
        for (const port of value.protocolPorts.slice(0, mode === "deploy" ? 4 : 1)) {
            expect(port.close).toHaveBeenCalledOnce();
        }
    });

    it("runs reverse without path tokens and surfaces a typed failed reply", async () => {
        const value = fixture();
        const postMessage = vi.fn((_channel: string, request: unknown) => {
            expect(request).toEqual({ mode: "reverse", assetKind: "Guidance", subject: SUBJECTS.target });
            value.hostPort.emit("message", { data: { status: "failed", step: "stale_reverse", diagnosticCodes: [] } });
        });
        await expect(
            provePackagedZcodeTarget(
                "reverse",
                value.supervisor,
                { postMessage },
                { createChannel: value.createChannel },
                value.roots,
                authorization("reverse"),
            ),
        ).rejects.toThrow(/failed at stale_reverse/u);
        expect(value.supervisor.connect).toHaveBeenCalledWith({ claimPathSelectionAuthority: false });
        expect(value.registerLocalPathSelection).not.toHaveBeenCalled();
    });

    it("closes the protocol port when path registration rejects", async () => {
        const value = fixture();
        const failure = new Error("selection rejected");
        value.registerLocalPathSelection.mockRejectedValueOnce(failure);
        await expect(
            provePackagedZcodeTarget(
                "deploy",
                value.supervisor,
                { postMessage: vi.fn() },
                { createChannel: value.createChannel },
                value.roots,
                authorization("deploy"),
            ),
        ).rejects.toBe(failure);
        expect(value.createChannel).not.toHaveBeenCalled();
        expect(value.protocolPorts[0]?.close).toHaveBeenCalledOnce();
    });

    it("rejects malformed renderer evidence and closes every owned port", async () => {
        const value = fixture();
        const postMessage = vi.fn(() => value.hostPort.emit("message", { data: { status: "complete", extra: true } }));
        await expect(
            provePackagedZcodeTarget(
                "reverse",
                value.supervisor,
                { postMessage },
                { createChannel: value.createChannel },
                value.roots,
                authorization("reverse"),
            ),
        ).rejects.toThrow(/invalid packaged ZCode target proof reply/u);
        expect(value.hostPort.close).toHaveBeenCalledOnce();
        expect(value.protocolPorts[0]?.close).toHaveBeenCalledOnce();
    });

    it("fails when the renderer result port closes before evidence", async () => {
        const value = fixture();
        const postMessage = vi.fn(() => value.hostPort.emit("close"));
        await expect(
            provePackagedZcodeTarget(
                "reverse",
                value.supervisor,
                { postMessage },
                { createChannel: value.createChannel },
                value.roots,
                authorization("reverse"),
            ),
        ).rejects.toThrow(/closed before a result/u);
        expect(value.protocolPorts[0]?.close).toHaveBeenCalledOnce();
    });

    it("closes both transfer ports if renderer delivery throws", async () => {
        const value = fixture();
        const failure = new Error("renderer unavailable");
        await expect(
            provePackagedZcodeTarget(
                "reverse",
                value.supervisor,
                {
                    postMessage() {
                        throw failure;
                    },
                },
                { createChannel: value.createChannel },
                value.roots,
                authorization("reverse"),
            ),
        ).rejects.toBe(failure);
        expect(value.clientPort.close).toHaveBeenCalledOnce();
        expect(value.hostPort.close).toHaveBeenCalledOnce();
        expect(value.protocolPorts[0]?.close).toHaveBeenCalledOnce();
    });
});
