import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createRestrictedProbeChannel,
    createRestrictedProbeService,
    RESTRICTED_PROBE_PROTOCOL,
    RESTRICTED_PROBE_MAX_FRAME_BYTES,
    type RestrictedProbeRequest,
    type RestrictedProbeSession,
} from "../../src/orchestration/restricted-probe-service";
import type { AdapterProbeContext, AdapterProbeResult } from "../../src/types";
import { makeContractProvider, partialUnknownProbe, testDiagnostic } from "./fixtures/adapter-contract-fixtures";
import * as probeFailure from "../../src/adapters/probe-failure";

describe("restricted WSL probe service and channel", () => {
    let parent: string;
    let root: string;
    let session: RestrictedProbeSession;
    beforeEach(() => {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-probe-"));
        root = path.join(parent, "selected");
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, "unchanged.txt"), "readonly input");
        session = {
            hostInstanceId: randomUUID(),
            sessionId: randomUUID(),
            platformContext: {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu" + root.split("/").join("\\"),
            },
        };
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        fs.rmSync(parent, { recursive: true, force: true });
    });

    function request(
        context: AdapterProbeContext = { authorizationScope: "global", platformContext: session.platformContext },
    ): RestrictedProbeRequest {
        return {
            protocol: RESTRICTED_PROBE_PROTOCOL,
            hostInstanceId: session.hostInstanceId,
            sessionId: session.sessionId,
            operationId: randomUUID(),
            sequence: 1,
            adapterId: "PROBE",
            context,
        };
    }
    function result(): AdapterProbeResult {
        const result = partialUnknownProbe("PROBE_CLI");
        result.observation.sourceRoots = [
            {
                sourceRootId: "opaque:/native/private-id",
                rootRole: "source",
                sourceDomain: "agent_runtime_private",
                path: root,
                accessStatus: "available",
                locatorEvidence: [
                    { locatorKind: "runtime_known_rule", locatorKey: "/native/private-key", evidenceLevel: "local_artifact" },
                ],
                diagnostics: [],
            },
        ];
        result.observation.observedAgentRuntimes[0]!.sourceRootIds = ["opaque:/native/private-id"];
        result.observation.observedAgentRuntimes[0]!.installationEvidence = [
            { kind: "executable", path: path.join(root, "tool"), evidenceLevel: "local_artifact", diagnostics: [] },
        ];
        return result;
    }
    function service(probe = vi.fn(async (_context: AdapterProbeContext) => result())) {
        return {
            probe,
            service: createRestrictedProbeService({
                ...session,
                deadlineAt: Date.now() + 30_000,
                providers: [{ ...makeContractProvider("PROBE"), probe }],
            }),
        };
    }

    it.each([
        "host",
        "session",
        "platform",
        "past",
        "future",
        "fractional",
        "empty",
        "duplicate",
    ])("rejects invalid probe configuration %s", (kind) => {
        const provider = makeContractProvider("PROBE");
        const configuration: Parameters<typeof createRestrictedProbeService>[0] = {
            ...structuredClone(session),
            deadlineAt: Date.now() + 30_000,
            providers: [provider],
        };
        if (kind === "host") configuration.hostInstanceId = "invalid";
        else if (kind === "session") configuration.sessionId = "invalid";
        else if (kind === "platform") configuration.platformContext.platform = "linux";
        else if (kind === "past") configuration.deadlineAt = Date.now() - 1;
        else if (kind === "future") configuration.deadlineAt = Date.now() + 700_000;
        else if (kind === "fractional") configuration.deadlineAt = Date.now() + 0.5;
        else if (kind === "empty") configuration.providers = [];
        else configuration.providers = [provider, provider];
        expect(() => createRestrictedProbeService(configuration)).toThrow();
    });

    it("maps an admitted directory scope and optional installation root through the selected projection", async () => {
        const { probe, service: target } = service();
        await target.handle(
            request({
                authorizationScope: "directory",
                platformContext: session.platformContext,
                directoryRootPath: session.platformContext.accessRootPath,
                installationRootPath: session.platformContext.accessRootPath,
            }),
        );
        expect(probe).toHaveBeenCalledWith({
            authorizationScope: "directory",
            platformContext: { ...session.platformContext, accessRootPath: root },
            directoryRootPath: root,
            installationRootPath: root,
        });
    });

    it.each([
        "unknown_scope",
        "extra_scope",
        "protocol",
        "operation_id",
        "oversize",
    ])("rejects request %s before Provider entry", async (kind) => {
        const h = service();
        const input = request();
        if (kind === "unknown_scope") Object.assign(input.context, { authorizationScope: "unknown" });
        else if (kind === "extra_scope") Object.assign(input.context, { extra: true });
        else if (kind === "protocol") Object.assign(input, { protocol: "unknown" });
        else if (kind === "operation_id") input.operationId = "invalid";
        else input.adapterId = "x".repeat(RESTRICTED_PROBE_MAX_FRAME_BYTES);
        await expect(h.service.handle(input)).rejects.toThrow();
        expect(h.probe).not.toHaveBeenCalled();
    });

    it.each([
        "primitive_error",
        "large_result",
        "large_error",
        "unprintable_error",
    ])("bounds Provider failure or observation %s", async (kind) => {
        const h = service(
            vi.fn(async () => {
                if (kind === "primitive_error") throw "original primitive Provider failure";
                if (kind === "large_error") throw new Error("x".repeat(RESTRICTED_PROBE_MAX_FRAME_BYTES));
                if (kind === "unprintable_error")
                    throw {
                        toString() {
                            throw new Error("unprintable");
                        },
                    };
                const observed = result();
                observed.diagnostics = [
                    { ...testDiagnostic("large.control", "probe"), message: "x".repeat(RESTRICTED_PROBE_MAX_FRAME_BYTES) },
                ];
                return observed;
            }),
        );
        const observed = await h.service.handle(request());
        expect(observed.result.status).toBe("failed");
        expect(observed.result.observation.sourceRoots).toEqual([]);
        expect(JSON.stringify(observed).length).toBeLessThan(RESTRICTED_PROBE_MAX_FRAME_BYTES);
        expect(observed.result.diagnostics[0]!.message.length).toBeLessThan(2_500);
        if (kind === "unprintable_error")
            expect(observed.result.diagnostics[0]!.message).toContain("unprintable Provider failure");
        expect(h.probe).toHaveBeenCalledTimes(1);
    });

    it("keeps the original 128-call service and channel lifetime", async () => {
        const h = service();
        const channel = createRestrictedProbeChannel({ ...session, exchange: (request) => h.service.handle(request) });
        const context: AdapterProbeContext = { authorizationScope: "global", platformContext: session.platformContext };
        for (let count = 0; count < 128; count++) expect((await channel.probe("PROBE", context)).status).toBe("partial");
        await expect(channel.probe("PROBE", context)).rejects.toThrow(/unavailable/);
        await expect(h.service.handle({ ...request(), sequence: 129 })).rejects.toThrow(/mismatch/);
        expect(h.probe).toHaveBeenCalledTimes(128);
    });

    it("rejects a failure-formatter dependency that expands a real Provider error beyond the frame budget", async () => {
        const format = probeFailure.probeExceptionDiagnostic;
        vi.spyOn(probeFailure, "probeExceptionDiagnostic").mockImplementation((...args) => ({
            ...format(...args),
            message: "x".repeat(RESTRICTED_PROBE_MAX_FRAME_BYTES),
        }));
        const h = service(
            vi.fn(async () => {
                throw new Error("real Provider rejection");
            }),
        );
        await expect(h.service.handle(request())).rejects.toThrow(/response exceeds limit/);
        expect(h.probe).toHaveBeenCalledTimes(1);
    });

    it("rejects a late healthy response after a concurrent request invalidates the channel", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = service(
            vi.fn(async () => {
                await gate;
                return result();
            }),
        );
        const channel = createRestrictedProbeChannel({ ...session, exchange: (request) => h.service.handle(request) });
        const first = channel.probe("PROBE", { authorizationScope: "global", platformContext: session.platformContext });
        await expect(
            channel.probe("PROBE", {
                authorizationScope: "global",
                platformContext: { ...session.platformContext, platformInstanceId: "foreign" },
            }),
        ).rejects.toThrow(/Environment mismatch/);
        release();
        await expect(first).rejects.toThrow(/became unavailable/);
        expect(h.probe).toHaveBeenCalledTimes(1);
    });

    it("refuses a malformed response envelope from an actual Provider call", async () => {
        const h = service();
        const channel = createRestrictedProbeChannel({
            ...session,
            exchange: async (request) => ({ ...(await h.service.handle(request)), extra: true }),
        });
        await expect(
            channel.probe("PROBE", { authorizationScope: "global", platformContext: session.platformContext }),
        ).rejects.toThrow(/response envelope/);
        expect(h.probe).toHaveBeenCalledTimes(1);
    });

    it("observes locally and projects only structured physical paths, preserving private IDs and strings without State", async () => {
        const { probe, service: target } = service();
        const channel = createRestrictedProbeChannel({ ...session, exchange: (value) => target.handle(value) });
        const observed = await channel.probe("PROBE", {
            authorizationScope: "project",
            projectRootPath: session.platformContext.accessRootPath,
            platformContext: session.platformContext,
        });
        expect(probe).toHaveBeenCalledWith({
            authorizationScope: "project",
            projectRootPath: root,
            platformContext: { ...session.platformContext, accessRootPath: root },
        });
        expect(observed.observation.platformContext).toEqual(session.platformContext);
        expect(observed.observation.sourceRoots[0]).toMatchObject({
            sourceRootId: "opaque:/native/private-id",
            path: session.platformContext.accessRootPath,
            locatorEvidence: [
                { locatorKind: "runtime_known_rule", locatorKey: "/native/private-key", evidenceLevel: "local_artifact" },
            ],
        });
        expect(observed.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path).toBe(
            session.platformContext.accessRootPath + "\\tool",
        );
        expect(fs.readdirSync(root)).toEqual(["unchanged.txt"]);
        expect(fs.readFileSync(path.join(root, "unchanged.txt"), "utf8")).toBe("readonly input");
    });

    it("returns Host-visible diagnostic paths through nested target applicability and the linked probe graph", async () => {
        const local = result();
        const physical = {
            ...testDiagnostic("physical_advisory", "probe"),
            severity: "info" as const,
            path: root,
            message: `Provider text ${root} stays exact`,
            rawSummary: root,
        };
        const diagnostics = () => [structuredClone(physical)];
        local.diagnostics = [...diagnostics(), { ...physical, path: "relative/provider-key" }, { ...physical, path: "" }];
        const runtime = local.observation.observedAgentRuntimes[0]!;
        runtime.diagnostics = diagnostics();
        runtime.installationEvidence[0]!.diagnostics = diagnostics();
        runtime.agentRuntimeResourceIds = ["private:/resource"];
        runtime.observedProjectIds = ["private:/project"];
        runtime.projectDiscoveryStatus = "partial";
        local.observation.sourceRoots[0]!.diagnostics = diagnostics();
        local.observation.sourceRoots[0]!.rootRole = "project_actual";
        local.observation.sourceRoots[0]!.sourceDomain = "project_root";
        local.observation.agentRuntimeResources = [
            {
                agentRuntimeResourceId: "private:/resource",
                roles: ["project_registry"],
                path: root + "/registry",
                accessStatus: "available",
                locatorEvidence: [
                    { locatorKind: "runtime_known_rule", locatorKey: "/private/registry-key", evidenceLevel: "local_artifact" },
                ],
                diagnostics: diagnostics(),
            },
        ];
        local.observation.observedProjects = [
            {
                observedProjectId: "private:/project",
                runtimeProjectKey: "/private/project-key",
                displayName: "Diagnostic projection fixture",
                workspaces: [{ sourceRootId: "opaque:/native/private-id", role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: "private:/resource",
                        locatorKey: "/private/locator",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: diagnostics(),
            },
        ];
        local.observation.targetCandidates = [
            {
                targetCandidateId: "/private/target-id",
                targetRootPath: root,
                targetKind: "project",
                displayName: "Target diagnostic fixture",
                entryApplicabilities: [
                    { agentRuntimeId: "PROBE_CLI", status: "unknown", locatorEvidence: [], diagnostics: diagnostics() },
                ],
                diagnostics: diagnostics(),
            },
        ];
        const original = structuredClone(local);
        const { service: target } = service(vi.fn(async () => local));
        const channel = createRestrictedProbeChannel({ ...session, exchange: (value) => target.handle(value) });
        const observed = await channel.probe("PROBE", { authorizationScope: "global", platformContext: session.platformContext });
        expect(observed.status, JSON.stringify(observed.diagnostics)).toBe("partial");
        const expected = { ...physical, path: session.platformContext.accessRootPath };
        expect(observed.diagnostics).toEqual([expected, original.diagnostics[1], original.diagnostics[2]]);
        expect(observed.observation.observedAgentRuntimes[0]!.diagnostics).toEqual([expected]);
        expect(observed.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.diagnostics).toEqual([expected]);
        expect(observed.observation.sourceRoots[0]!.diagnostics).toEqual([expected]);
        expect(observed.observation.agentRuntimeResources[0]!.diagnostics).toEqual([expected]);
        expect(observed.observation.observedProjects[0]!).toEqual({
            ...original.observation.observedProjects[0],
            diagnostics: [expected],
        });
        expect(observed.observation.targetCandidates[0]!).toEqual({
            ...original.observation.targetCandidates[0],
            targetRootPath: session.platformContext.accessRootPath,
            diagnostics: [expected],
            entryApplicabilities: [
                { ...original.observation.targetCandidates[0]!.entryApplicabilities[0], diagnostics: [expected] },
            ],
        });
        expect(local).toEqual(original);
    });

    it.each([
        "outside",
        "noncanonical",
    ])("rejects an %s absolute diagnostic path without broadening the selected root", async (kind) => {
        const local = result();
        local.diagnostics = [
            {
                ...testDiagnostic("invalid_physical_hint", "probe"),
                path: kind === "outside" ? path.join(parent, "outside") : root + "/../outside",
            },
        ];
        const { service: target } = service(vi.fn(async () => local));
        const channel = createRestrictedProbeChannel({ ...session, exchange: (value) => target.handle(value) });
        const observed = await channel.probe("PROBE", { authorizationScope: "global", platformContext: session.platformContext });
        expect(observed.status).toBe("failed");
        expect(observed.observation.sourceRoots).toEqual([]);
        expect(observed.observation.targetCandidates).toEqual([]);
    });

    it.each([
        "session",
        "host",
        "sequence",
        "adapter",
        "scope",
        "environment",
        "extra",
    ])("rejects a foreign or malformed %s before any Provider observation", async (field) => {
        const { probe, service: target } = service();
        const value = request();
        if (field === "session") value.sessionId = randomUUID();
        if (field === "host") value.hostInstanceId = randomUUID();
        if (field === "sequence") value.sequence = 2;
        if (field === "adapter") value.adapterId = "FOREIGN";
        if (field === "scope")
            value.context = {
                authorizationScope: "directory",
                directoryRootPath: session.platformContext.accessRootPath + "\\..\\outside",
                platformContext: session.platformContext,
            };
        if (field === "environment")
            value.context = {
                authorizationScope: "global",
                platformContext: { ...session.platformContext, platformInstanceId: "Debian" },
            };
        await expect(target.handle(field === "extra" ? { ...value, transactionId: randomUUID() } : value)).rejects.toThrow();
        expect(probe).not.toHaveBeenCalled();
    });

    it("rejects replay and sequence gaps without inventing a transaction", async () => {
        const { probe, service: target } = service();
        const value = request();
        await target.handle(value);
        await expect(target.handle(value)).rejects.toThrow(/sequence/);
        await expect(target.handle({ ...request(), sequence: 3 })).rejects.toThrow(/sequence/);
        expect(probe).toHaveBeenCalledOnce();
    });

    it.each(["before", "during"])("rejects an access-root replacement %s the Provider operation", async (when) => {
        const replace = () => {
            fs.renameSync(root, path.join(parent, "retained"));
            fs.mkdirSync(root);
        };
        const probe = vi.fn(async (_context: AdapterProbeContext) => {
            if (when === "during") replace();
            return result();
        });
        const { service: target } = service(probe);
        if (when === "before") replace();
        await expect(target.handle(request())).rejects.toThrow(/root identity/);
        expect(probe).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
        expect(fs.readFileSync(path.join(parent, "retained", "unchanged.txt"), "utf8")).toBe("readonly input");
    });

    it("invalidates a channel after a mismatched response and does not replay the read", async () => {
        const { service: target } = service();
        const exchange = vi.fn(async (value: RestrictedProbeRequest) => ({
            ...(await target.handle(value)),
            operationId: randomUUID(),
        }));
        const channel = createRestrictedProbeChannel({ ...session, exchange });
        const context: AdapterProbeContext = { authorizationScope: "global", platformContext: session.platformContext };
        await expect(channel.probe("PROBE", context)).rejects.toThrow(/identity/);
        await expect(channel.probe("PROBE", context)).rejects.toThrow(/unavailable/);
        expect(exchange).toHaveBeenCalledOnce();
    });

    it("does not return late observations after the fixed operation lifetime", async () => {
        const { service: target } = service(
            vi.fn(async () => {
                vi.setSystemTime(Date.now() + 31_000);
                return result();
            }),
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        await expect(target.handle(request())).rejects.toThrow(/expired/);
    });

    it.each([
        "throw",
        "malformed",
        "foreign-entry",
    ])("keeps concurrent healthy Providers and subsequent calls usable after one Provider's %s", async (failure) => {
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        let healthyCalls = 0;
        const target = createRestrictedProbeService({
            ...session,
            deadlineAt: Date.now() + 30_000,
            providers: [
                {
                    ...makeContractProvider("BROKEN"),
                    async probe() {
                        if (failure === "throw") throw new Error("one Provider failed");
                        if (failure === "malformed") return {} as AdapterProbeResult;
                        return partialUnknownProbe("FOREIGN_CLI");
                    },
                },
                {
                    ...makeContractProvider("HEALTHY"),
                    async probe() {
                        healthyCalls += 1;
                        if (healthyCalls === 1) await waiting;
                        return partialUnknownProbe("HEALTHY_CLI");
                    },
                },
            ],
        });
        const channel = createRestrictedProbeChannel({ ...session, exchange: (value) => target.handle(value) });
        const context: AdapterProbeContext = { authorizationScope: "global", platformContext: session.platformContext };
        const failed = channel.probe("BROKEN", context);
        const healthy = channel.probe("HEALTHY", context);
        const rejectedProvider = await failed;
        expect(rejectedProvider).toMatchObject({
            status: "failed",
            observation: { adapterId: "BROKEN", platformContext: session.platformContext, observedAgentRuntimes: [] },
        });
        expect(rejectedProvider.diagnostics.length).toBeGreaterThan(0);
        release();
        expect(await healthy).toMatchObject({
            status: "partial",
            observation: { adapterId: "HEALTHY", observedAgentRuntimes: [{ agentRuntimeId: "HEALTHY_CLI" }] },
        });
        expect(await channel.probe("HEALTHY", context)).toMatchObject({
            status: "partial",
            observation: { adapterId: "HEALTHY" },
        });
        expect(healthyCalls).toBe(2);
    });
});
