/** Source owner controls use the real source channel/service and pool with only physical process creation substituted. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { createRestrictedProcessPoolForTest } from "../../host/src/restricted-process-pool";
import { RestrictedProcessStartError, DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES } from "@oaam/app-server-host";
import type { InstalledRestrictedCode, RestrictedProcessLaunch, RestrictedProcessTransport } from "@oaam/app-server-host";
import {
    createRestrictedSourceService,
    type RestrictedSourceServiceConfiguration,
    type SelectedWslSourceReadRequest,
} from "@oaam/core/restricted-operations";
import { createProductionSelectedWslSourcesForTest } from "../src/production-selected-wsl-sources";
import { prepareRead } from "../../../core/src/source-import/source-read-preparation";
import type {
    RestrictedSourceRequest,
    RestrictedSourceResponse,
} from "../../../core/src/source-import/restricted-source-protocol";
import {
    authority,
    provider,
    root,
    sandbox,
    sourceFile,
    target,
    validRead,
} from "../../../core/tests/source-import/fixtures/source-contract-test-fixtures";

const owners: Array<{
    behavior: { failClose: boolean };
    manager: Pick<ReturnType<typeof createProductionSelectedWslSourcesForTest>, "close">;
    peers: readonly { transport: RestrictedProcessTransport }[];
}> = [];
afterEach(async () => {
    for (const h of owners.splice(0)) {
        h.behavior.failClose = false;
        await h.manager.close().catch(() => undefined);
        for (const peer of h.peers) await peer.transport.close();
    }
    vi.restoreAllMocks();
});

function fixture(defaultCapacity = false) {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const behavior = {
        failClose: false,
        before: async (_request: RestrictedSourceRequest) => undefined as void,
        after: (_response: RestrictedSourceResponse) => undefined as void,
    };
    let reads = 0;
    const selected = provider(async (input) => {
        reads++;
        return validRead()(input);
    });
    const contexts = ["Ubuntu", "Debian"].map((platformInstanceId) => ({
        platform: "wsl" as const,
        platformInstanceId,
        accessRootPath: `\\\\wsl.localhost\\${platformInstanceId}${sandbox.replaceAll("/", "\\")}`,
    }));
    const requests = contexts.map((platformContext): SelectedWslSourceReadRequest => {
        const projection = createSelectedWslPathProjection(platformContext.platformInstanceId, platformContext.accessRootPath);
        const readTarget = target([root("root-1", projection.toHost(sourceFile))]);
        if (readTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected probe roots");
        readTarget.sourceSelector.observation.platformContext = platformContext;
        readTarget.sourceSelector.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path = projection.toHost(
            `${sandbox}/bin`,
        );
        const owned = authority();
        const preparation = prepareRead(selected, readTarget, owned);
        if ("diagnostics" in preparation) throw new Error(JSON.stringify(preparation.diagnostics));
        return { platformContext, target: readTarget, authority: owned, preparation, revalidateAuthority: () => true };
    });
    const peers: Array<{
        transport: RestrictedProcessTransport;
        launch: RestrictedProcessLaunch;
        requests: RestrictedSourceRequest[];
    }> = [];
    const start = vi.fn(async (launch: RestrictedProcessLaunch): Promise<RestrictedProcessTransport> => {
        const configuration = (launch.operation as { configuration: RestrictedSourceServiceConfiguration }).configuration;
        const service = createRestrictedSourceService({ ...configuration, providers: [selected] });
        let available = true;
        const requests: RestrictedSourceRequest[] = [];
        const transport: RestrictedProcessTransport = {
            ready: { ...launch.session },
            get available() {
                return available;
            },
            async exchange(value) {
                const request = JSON.parse(JSON.stringify(value)) as RestrictedSourceRequest;
                requests.push(request);
                await behavior.before(request);
                const response = await service.handle(request);
                behavior.after(response);
                return JSON.parse(JSON.stringify(response));
            },
            exchangeSync() {
                throw new Error("source continuation uses asynchronous exchange");
            },
            close: vi.fn(async () => {
                if (behavior.failClose) throw new Error("source process cleanup unconfirmed");
                available = false;
                service.close();
                await service.settled();
            }),
        };
        peers.push({ transport, launch, requests });
        return transport;
    });
    const pool = createRestrictedProcessPoolForTest(8, start);
    const acquire = vi.fn(pool.acquire);
    const installed: InstalledRestrictedCode = {
        wslExecutablePath: "C:\\Windows\\System32\\wsl.exe",
        windowsCodeRootPath: "C:\\OAAM\\code",
        code: {
            rootPath: "/owned-code",
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
    const hostInstanceId = randomUUID();
    const manager = createProductionSelectedWslSourcesForTest(
        contexts,
        "C:\\OAAM\\profile",
        () => hostInstanceId,
        { createPool: () => ({ acquire, close: pool.close }), resolveCode, now: () => now },
        defaultCapacity ? undefined : 96 * 1024 * 1024,
    );
    const h = {
        manager,
        peers,
        behavior,
        start,
        acquire,
        resolveCode,
        requests,
        reads: () => reads,
        run: (index = 0) => manager.execution.read(requests[index]!),
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
    };
    owners.push(h);
    return h;
}

describe("production selected WSL source owner", () => {
    it("uses the ordinary Host review capacity when no test override is supplied", async () => {
        const h = fixture(true);
        await h.run();
        expect(h.peers[0]!.launch.operation).toMatchObject({
            configuration: { maximumResultBytes: DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES },
        });
    });
    it.each(["mapping", "acquired"] as const)("closes during %s without starting a late source read", async (boundary) => {
        const h = fixture();
        let release!: () => void, reached!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const waiting = new Promise<void>((resolve) => {
            reached = resolve;
        });
        if (boundary === "mapping") {
            const original = h.resolveCode.getMockImplementation()!;
            h.resolveCode.mockImplementationOnce(async () => {
                const value = await original();
                reached();
                await held;
                return value;
            });
        } else {
            const original = h.acquire.getMockImplementation()!;
            h.acquire.mockImplementationOnce(async (...args) => {
                const value = await original(...args);
                reached();
                await held;
                return value;
            });
        }
        const pending = h.run();
        const rejected = expect(pending).rejects.toThrow("shutting down");
        await waiting;
        const closing = h.manager.close();
        release();
        await rejected;
        await closing;
        expect(h.reads()).toBe(0);
        expect(h.start).toHaveBeenCalledTimes(boundary === "mapping" ? 0 : 1);
        if (boundary === "acquired") expect(h.peers[0]!.transport.close).toHaveBeenCalled();
    });
    it.each([true, false])("preserves mapping cleanupConfirmed=%s without retrying uncertain owners", async (confirmed) => {
        const h = fixture();
        h.resolveCode.mockRejectedValueOnce(new RestrictedProcessStartError(confirmed, new Error("mapping failed")));
        await expect(h.run()).rejects.toThrow("mapping failed");
        expect(h.start).not.toHaveBeenCalled();
        if (confirmed) await expect(h.run()).resolves.toBeDefined();
        else {
            await expect(h.run()).rejects.toThrow("mapping failed");
            await expect(h.manager.close()).rejects.toThrow("release was not confirmed");
        }
        expect(h.resolveCode).toHaveBeenCalledTimes(confirmed ? 2 : 1);
    });
    it("reuses the exact Environment peer and binds the Host consumer capacity independently of the read budget", async () => {
        const h = fixture();
        expect((await h.run()).status).toBe("complete");
        expect((await h.run()).status).toBe("complete");
        expect(h.start).toHaveBeenCalledOnce();
        expect(h.reads()).toBe(2);
        expect(h.peers[0]!.launch.maximumConcurrentRequests).toBe(1);
        expect(h.peers[0]!.launch.operation).toMatchObject({ configuration: { maximumResultBytes: 96 * 1024 * 1024 } });
        await h.manager.close();
        expect(h.peers[0]!.transport.available).toBe(false);
    });

    it("freezes a queued read before its caller mutates the target and never overlaps Provider operations", async () => {
        const h = fixture();
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = false;
        h.behavior.before = async (request) => {
            if (!held && request.operation.kind === "begin") {
                held = true;
                entered();
                await gate;
            }
        };
        const first = h.run();
        await started;
        const second = h.run();
        h.requests[0]!.target.allowedKinds = ["Skill"];
        expect(h.peers[0]!.requests).toHaveLength(1);
        release();
        expect((await first).status).toBe("complete");
        expect((await second).status).toBe("complete");
        expect(h.reads()).toBe(2);
        expect(h.start).toHaveBeenCalledOnce();
    });

    it("keeps independently selected distro sessions separate and refuses an unselected context before package lookup", async () => {
        const h = fixture();
        expect((await h.run(0)).status).toBe("complete");
        expect((await h.run(1)).status).toBe("complete");
        expect(h.peers.map((peer) => peer.launch.distroName)).toEqual(["Ubuntu", "Debian"]);
        expect(new Set(h.peers.map((peer) => peer.launch.session.sessionId)).size).toBe(2);
        expect(new Set(h.peers.map((peer) => peer.launch.session.hostInstanceId)).size).toBe(1);
        await expect(
            h.manager.execution.read({
                ...h.requests[0]!,
                platformContext: { ...h.requests[0]!.platformContext, platformInstanceId: "unselected" },
            }),
        ).rejects.toThrow(/outside/);
        expect(h.resolveCode).toHaveBeenCalledTimes(2);
    });

    it("retires a malformed response, confirms cleanup and creates a new peer only for a new caller operation", async () => {
        const h = fixture();
        h.behavior.after = (response) => {
            response.sequence++;
        };
        await expect(h.run()).rejects.toThrow(/identity/);
        expect(h.start).toHaveBeenCalledOnce();
        expect(h.reads()).toBe(1);
        expect(h.peers[0]!.transport.available).toBe(false);
        h.behavior.after = () => undefined;
        expect((await h.run()).status).toBe("complete");
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.reads()).toBe(2);
    });

    it("blocks another admission after uncertain cleanup and retains failed shutdown instead of releasing Host State", async () => {
        const h = fixture();
        h.behavior.failClose = true;
        h.behavior.after = (response) => {
            response.sequence++;
        };
        await expect(h.run()).rejects.toThrow(/cleanup is unconfirmed/);
        await expect(h.run()).rejects.toThrow(/cleanup unconfirmed/);
        expect(h.start).toHaveBeenCalledOnce();
        await expect(h.manager.close()).rejects.toThrow(/release was not confirmed/);
    });

    it("reserves operation headroom by closing a near-expiry peer before another read", async () => {
        const h = fixture();
        expect((await h.run()).status).toBe("complete");
        h.advance(480_000);
        expect((await h.run()).status).toBe("complete");
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.peers[0]!.transport.available).toBe(false);
    });

    it("retires the exhausted 128-read service before the next fresh operation", async () => {
        const h = fixture();
        for (let index = 0; index < 129; index++) expect((await h.run()).status).toBe("complete");
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.reads()).toBe(129);
        expect(h.peers[0]!.transport.available).toBe(false);
    }, 60_000);

    it("joins the admitted read on shutdown while rejecting queued and newly submitted work", async () => {
        const h = fixture();
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.behavior.before = async (request) => {
            if (request.operation.kind === "begin") {
                entered();
                await gate;
            }
        };
        const first = h.run();
        await started;
        const queued = h.run().then(
            () => "unexpected",
            (error: Error) => error.message,
        );
        const closing = h.manager.close();
        await expect(h.run()).rejects.toThrow(/shutting down/);
        release();
        expect((await first).status).toBe("complete");
        expect(await queued).toContain("shutting down");
        await closing;
        expect(h.reads()).toBe(1);
    });
});
