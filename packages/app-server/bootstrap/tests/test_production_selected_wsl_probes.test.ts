import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterProbeContext, PlatformContext } from "@oaam/core";
import {
    createRestrictedProbeService,
    type RestrictedProbeWireRequest,
    type RestrictedProbeWireResponse,
    type RestrictedProbeSession,
} from "@oaam/core/restricted-operations";
import { compileRestrictedBuildObservation } from "../../../core/src/orchestration/restricted-build-observation";
import type { InstalledRestrictedCode, RestrictedProcessLaunch, RestrictedProcessTransport } from "@oaam/app-server-host";
import { RestrictedProcessStartError } from "../../host/src/restricted-process-client";
import { createRestrictedProcessPoolForTest } from "../../host/src/restricted-process-pool";
import { makeContractProvider, partialUnknownProbe } from "../../../core/tests/adapters/fixtures/adapter-contract-fixtures";
import {
    createProductionSelectedWslProbes,
    createProductionSelectedWslProbesForTest,
} from "../src/production-selected-wsl-probes";

// Use the same current Host class identity as the actual pool, with its process factory seam below.
vi.mock("@oaam/app-server-host", () => import("../../host/src/index"));

function deferred<T>() {
    let resolve!: (value: T) => void;
    return {
        promise: new Promise<T>((yes) => {
            resolve = yes;
        }),
        resolve: (value: T) => resolve(value),
    };
}

const fixtures: Array<{
    manager: ReturnType<typeof createProductionSelectedWslProbesForTest>;
    expectedCloseFailure: boolean;
}> = [];
const roots: string[] = [];
afterEach(async () => {
    try {
        for (const f of fixtures.splice(0)) {
            if (f.expectedCloseFailure) await expect(f.manager.close()).rejects.toThrow();
            else await f.manager.close();
        }
    } finally {
        for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
        vi.restoreAllMocks();
    }
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-production-probe-owner-"));
    roots.push(root);
    const context = (distro: string): PlatformContext => ({
        platform: "wsl",
        platformInstanceId: distro,
        accessRootPath: `\\\\wsl.localhost\\${distro}${root.replaceAll("/", "\\")}`,
    });
    const contexts = [context("Ubuntu"), context("Debian")];
    const hostInstanceId = randomUUID();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const behavior = {
        response: async (response: RestrictedProbeWireResponse, _request: RestrictedProbeWireRequest) => response,
    };
    const business = vi.fn(async () => partialUnknownProbe("PROBE_CLI"));
    const peers: Array<{
        transport: RestrictedProcessTransport;
        launch: RestrictedProcessLaunch;
        requests: RestrictedProbeWireRequest[];
        state: { available: boolean };
    }> = [];
    const createPeer = (launch: RestrictedProcessLaunch): RestrictedProcessTransport => {
        const configuration = (launch.operation as { configuration: RestrictedProbeSession & { deadlineAt: number } })
            .configuration;
        const service = createRestrictedProbeService({
            ...configuration,
            providers: [{ ...makeContractProvider("PROBE"), probe: business }],
        });
        const state = { available: true };
        const requests: RestrictedProbeWireRequest[] = [];
        const transport: RestrictedProcessTransport = {
            ready: { ...launch.session },
            get available() {
                return state.available;
            },
            async exchange(raw) {
                const request = raw as RestrictedProbeWireRequest;
                requests.push(request);
                return behavior.response(await service.handle(request), request);
            },
            exchangeSync() {
                throw new Error("probe never uses synchronous exchange");
            },
            close: vi.fn(async () => {
                state.available = false;
            }),
        };
        peers.push({ transport, launch, requests, state });
        return transport;
    };
    const start = vi.fn(async (launch: RestrictedProcessLaunch) => createPeer(launch));
    const pool = createRestrictedProcessPoolForTest(8, start);
    const acquire = vi.fn(pool.acquire);
    const installed: InstalledRestrictedCode = {
        wslExecutablePath: "C:\\Windows\\System32\\wsl.exe",
        windowsCodeRootPath: "C:\\OAAM\\code",
        code: {
            rootPath: "/custom-mounted-install/code",
            manifest: {
                schemaVersion: 1,
                platform: "linux",
                architecture: "x64",
                nodeVersion: process.versions.node,
                nodeModulesVersion: process.versions.modules,
                files: ["node", "restricted-wsl.cjs"].map((relativePath) => ({
                    relativePath,
                    bytes: 1,
                    sha256: "a".repeat(64),
                    executable: relativePath === "node",
                })),
            },
        },
    };
    const resolveCode = vi.fn(async () => installed);
    const manager = createProductionSelectedWslProbesForTest(contexts, "C:\\OAAM\\profile", () => hostInstanceId, {
        createPool: () => ({ acquire, close: pool.close }),
        resolveCode,
        now: () => now,
    });
    const run = (platformContext = contexts[0]!) =>
        manager.execution.probe("PROBE", { authorizationScope: "global", platformContext });
    const f = {
        root,
        contexts,
        hostInstanceId,
        behavior,
        business,
        peers,
        start,
        createPeer,
        acquire,
        resolveCode,
        manager,
        run,
        advanceTo: (value: number) => {
            now = value;
        },
        expectedCloseFailure: false,
    };
    fixtures.push(f);
    return f;
}

describe("ordinary selected-WSL probe ownership", () => {
    it("closes the ordinary unselected composition without requesting a Host identity or process", async () => {
        const identity = vi.fn(() => randomUUID());
        const manager = createProductionSelectedWslProbes([], "C:\\OAAM\\unused-profile", identity);
        await expect(manager.close()).resolves.toBeUndefined();
        expect(identity).not.toHaveBeenCalled();
    });
    it("rejects loss of the compiled Environment before acquiring another process", async () => {
        const f = await buildFixture();
        const selection = structuredClone(f.selection);
        Reflect.deleteProperty(selection, "platformContext");
        await expect(f.manager.execution.observeBuildArtifacts!(selection)).rejects.toThrow("no Environment");
        expect(f.start).toHaveBeenCalledOnce();
    });
    it("releases an acquired peer when shutdown wins before Bootstrap resumes admission", async () => {
        const f = fixture(),
            held = deferred<void>(),
            reached = deferred<void>();
        const acquire = f.acquire.getMockImplementation()!;
        f.acquire.mockImplementationOnce(async (...args) => {
            const peer = await acquire(...args);
            reached.resolve();
            await held.promise;
            return peer;
        });
        const pending = f.run();
        const rejected = expect(pending).rejects.toThrow("shutting down");
        await reached.promise;
        const closing = f.manager.close();
        held.resolve();
        await rejected;
        await closing;
        expect(f.business).not.toHaveBeenCalled();
        expect(f.peers[0]!.transport.close).toHaveBeenCalled();
    });
    async function buildFixture() {
        const f = fixture();
        const file = path.join(f.root, "consumer");
        fs.writeFileSync(file, "build A", { mode: 0o700 });
        const value = partialUnknownProbe("PROBE_CLI");
        value.observation.observedAgentRuntimes[0]!.installationStatus = "available";
        value.observation.observedAgentRuntimes[0]!.installationEvidence = [
            { kind: "executable", path: file, evidenceLevel: "local_artifact", diagnostics: [] },
        ];
        f.business.mockResolvedValue(value);
        const observed = await f.run();
        const selection = compileRestrictedBuildObservation([observed], "single", [
            observed.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path,
        ]);
        return { ...f, file, selection };
    }

    it("reuses the probe peer for fresh build facts and freezes the submitted evidence before admission", async () => {
        const f = await buildFixture();
        const original = structuredClone(f.selection);
        const pending = f.manager.execution.observeBuildArtifacts!(f.selection);
        f.selection.entries[0]!.evidence.path += "-mutated-after-call";
        const first = await pending;
        expect(first.items[0]).toMatchObject({ status: "complete", byteSize: 7 });
        fs.writeFileSync(f.file, "build B changed");
        const second = await f.manager.execution.observeBuildArtifacts!(original);
        expect(second.items[0]).toMatchObject({ status: "complete", byteSize: 15 });
        expect(second.items[0]).not.toEqual(first.items[0]);
        expect(f.start).toHaveBeenCalledOnce();
        expect(f.business).toHaveBeenCalledOnce();
        expect(f.peers[0]!.requests.map((request) => request.sequence)).toEqual([1, 2, 3]);
        expect(f.peers[0]!.requests[1]).toMatchObject({ buildObservation: original });
    });

    it("reuses a typed build failure and replaces a corrupt peer only for a later operation", async () => {
        const f = await buildFixture();
        fs.unlinkSync(f.file);
        expect((await f.manager.execution.observeBuildArtifacts!(f.selection)).items[0]).toMatchObject({
            status: "failed",
            failureKind: "not_found",
        });
        fs.writeFileSync(f.file, "corrected build", { mode: 0o700 });
        expect((await f.manager.execution.observeBuildArtifacts!(f.selection)).items[0].status).toBe("complete");
        f.behavior.response = async (response) =>
            "observations" in response ? { ...response, selectionFingerprint: `sha256:${"0".repeat(64)}` } : response;
        await expect(f.manager.execution.observeBuildArtifacts!(f.selection)).rejects.toThrow("identity mismatch");
        expect(f.start).toHaveBeenCalledOnce();
        f.behavior.response = async (response) => response;
        expect((await f.manager.execution.observeBuildArtifacts!(f.selection)).items[0].status).toBe("complete");
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(f.business).toHaveBeenCalledOnce();
        expect(f.peers[0]!.transport.close).toHaveBeenCalled();
        expect(f.peers[1]!.requests[0]!.sequence).toBe(1);
    });

    it("starts lazily, shares the actual channel and sequence across parallel and later requests, and calls Provider afresh", async () => {
        const f = fixture();
        expect(f.start).not.toHaveBeenCalled();
        expect(f.resolveCode).not.toHaveBeenCalled();
        const results = await Promise.all(Array.from({ length: 6 }, () => f.run()));
        expect(results.every((result) => result.status === "partial")).toBe(true);
        await f.run();
        expect(f.resolveCode).toHaveBeenCalledTimes(1);
        expect(f.start).toHaveBeenCalledTimes(1);
        expect(f.business).toHaveBeenCalledTimes(7);
        expect(f.peers[0]!.requests.map((request) => request.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(f.peers[0]!.launch.session.hostInstanceId).toBe(f.hostInstanceId);
        expect(f.peers[0]!.launch.code.rootPath).toBe("/custom-mounted-install/code");
    });

    it("keeps Environment and installed-package bindings separate and rejects a foreign root before admission", async () => {
        const f = fixture();
        await Promise.all(f.contexts.map((context) => f.run(context)));
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(new Set(f.acquire.mock.calls.map(([key]) => key)).size).toBe(2);
        expect(f.peers.map((peer) => peer.launch.distroName).sort()).toEqual(["Debian", "Ubuntu"]);
        await expect(f.run({ ...f.contexts[0]!, accessRootPath: f.contexts[0]!.accessRootPath + "\\foreign" })).rejects.toThrow(
            "outside this Host",
        );
        expect(f.resolveCode).toHaveBeenCalledTimes(2);
    });

    it("retires a corrupt channel even while its transport stays available, without replaying the failed request", async () => {
        const f = fixture();
        f.behavior.response = async (response) => ({ ...response, sessionId: randomUUID() });
        await expect(f.run()).rejects.toThrow("identity mismatch");
        expect(f.peers[0]!.transport.available).toBe(true);
        expect(f.business).toHaveBeenCalledTimes(1);
        f.behavior.response = async (response) => response;
        await f.run();
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(f.peers[0]!.transport.close).toHaveBeenCalled();
        expect(f.peers[1]!.requests[0]!.sequence).toBe(1);
        expect(f.peers[1]!.launch.session.sessionId).not.toBe(f.peers[0]!.launch.session.sessionId);
    });

    it("keeps a normal Provider failure local while reusing the valid process and channel", async () => {
        const f = fixture();
        f.business.mockRejectedValueOnce(new Error("Provider read failed"));
        expect((await f.run()).status).toBe("failed");
        expect((await f.run()).status).toBe("partial");
        expect(f.start).toHaveBeenCalledTimes(1);
        expect(f.peers[0]!.requests.map((request) => request.sequence)).toEqual([1, 2]);
    });

    it("reserves the 128th sequence and waits for its response before replacing the exhausted pair", async () => {
        const f = fixture();
        for (let index = 0; index < 127; index += 1) await f.run();
        const held = deferred<void>();
        f.behavior.response = async (response, request) => {
            if (request.sequence === 128) await held.promise;
            return response;
        };
        const last = f.run(),
            next = f.run();
        try {
            await vi.waitFor(() => expect(f.peers[0]!.requests).toHaveLength(128));
            expect(f.start).toHaveBeenCalledTimes(1);
            expect(f.peers[0]!.transport.close).not.toHaveBeenCalled();
        } finally {
            held.resolve();
        }
        await Promise.all([last, next]);
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(f.peers[1]!.requests[0]!.sequence).toBe(1);
    });

    it("bounds concurrent requests without closing an in-flight pair at admission capacity", async () => {
        const f = fixture(),
            held = deferred<void>();
        f.behavior.response = async (response) => {
            await held.promise;
            return response;
        };
        const requests = Array.from({ length: 17 }, () => f.run());
        try {
            await vi.waitFor(() => expect(f.peers[0]?.requests).toHaveLength(16));
            expect(f.start).toHaveBeenCalledTimes(1);
            expect(f.peers[0]!.transport.close).not.toHaveBeenCalled();
        } finally {
            held.resolve();
        }
        await Promise.all(requests);
        expect(f.peers[0]!.requests).toHaveLength(17);
    });

    it("rotates before the original launch deadline loses the existing request window", async () => {
        const f = fixture();
        await f.run();
        f.advanceTo(f.peers[0]!.launch.deadlineAt - 30_000);
        await f.run();
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(f.peers[0]!.transport.close).toHaveBeenCalled();
        expect(f.peers[1]!.requests[0]!.sequence).toBe(1);
    });

    it("replaces an idle exited process with a fresh channel", async () => {
        const f = fixture();
        await f.run();
        f.peers[0]!.state.available = false;
        await f.run();
        expect(f.start).toHaveBeenCalledTimes(2);
        expect(f.peers[1]!.requests[0]!.sequence).toBe(1);
    });

    it("allows only a new explicit request to retry a cleanup-confirmed start failure", async () => {
        const f = fixture();
        f.start.mockRejectedValueOnce(new RestrictedProcessStartError(true, new Error("clean failure")));
        await expect(f.run()).rejects.toThrow("clean failure");
        expect(f.start).toHaveBeenCalledTimes(1);
        await f.run();
        expect(f.start).toHaveBeenCalledTimes(2);
    });

    it("keeps an uncertain mapping owner sticky and preserves failure through shutdown", async () => {
        const f = fixture();
        f.expectedCloseFailure = true;
        f.resolveCode.mockRejectedValueOnce(new RestrictedProcessStartError(false, new Error("mapping owner lost")));
        await expect(f.run()).rejects.toThrow("mapping owner lost");
        await expect(f.run()).rejects.toThrow("mapping owner lost");
        expect(f.resolveCode).toHaveBeenCalledTimes(1);
        expect(f.start).not.toHaveBeenCalled();
        await expect(f.manager.close()).rejects.toThrow("release was not confirmed");
    });

    it("does not replace a pair whose retirement cleanup could not be confirmed", async () => {
        const f = fixture();
        await f.run();
        f.expectedCloseFailure = true;
        vi.mocked(f.peers[0]!.transport.close).mockRejectedValue(new Error("owned cleanup uncertain"));
        f.peers[0]!.state.available = false;
        await expect(f.run()).rejects.toThrow("cleanup uncertain");
        await expect(f.run()).rejects.toThrow("cleanup uncertain");
        expect(f.start).toHaveBeenCalledTimes(1);
    });

    it("joins preparation during shutdown, starts no late process and rejects future work", async () => {
        const f = fixture(),
            prepared = deferred<InstalledRestrictedCode>();
        f.resolveCode.mockReturnValueOnce(prepared.promise);
        const pending = f.run().then(
            () => undefined,
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(f.resolveCode).toHaveBeenCalledTimes(1));
        const closing = f.manager.close();
        prepared.resolve(await f.resolveCode());
        await closing;
        expect(await pending).toBeInstanceOf(Error);
        expect(f.start).not.toHaveBeenCalled();
        await expect(f.run()).rejects.toThrow("shutting down");
        expect(f.manager.close()).toBe(closing);
    });
});
