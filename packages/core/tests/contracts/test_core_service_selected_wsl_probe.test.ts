import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService, type CoreServiceProcessOwner } from "../../src/orchestration/core-service";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import type { SelectedWslProbeExecution } from "../../src/orchestration/selected-wsl-probe-execution";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    PlatformContext,
    ProbeAdapterProgress,
    ProbeResult,
} from "../../src/types";
import { makeContractProvider, partialUnknownProbe } from "../adapters/fixtures/adapter-contract-fixtures";

const WINDOWS: PlatformContext = { platform: "win32", platformInstanceId: "local", accessRootPath: "C:\\" };
const UBUNTU: PlatformContext = { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: "\\\\wsl.localhost\\Ubuntu\\" };
const DEBIAN: PlatformContext = { platform: "wsl", platformInstanceId: "Debian", accessRootPath: "\\\\wsl.localhost\\Debian\\" };
const LOCAL_WSL: PlatformContext = { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: "/" };

function observation(adapterId: string, context: AdapterProbeContext): AdapterProbeResult {
    const result = partialUnknownProbe(`${adapterId}_CLI`);
    const paths = context.platformContext.accessRootPath.startsWith("/") ? path.posix : path.win32;
    result.observation.sourceRoots = [
        {
            sourceRootId: "provider-owned-source-id",
            rootRole: "source",
            sourceDomain: "agent_runtime_private",
            path: paths.join(context.platformContext.accessRootPath, "selected-source"),
            accessStatus: "available",
            locatorEvidence: [
                { locatorKind: "runtime_known_rule", locatorKey: "provider-private-key", evidenceLevel: "local_artifact" },
            ],
            diagnostics: [],
        },
    ];
    result.observation.observedAgentRuntimes[0]!.sourceRootIds = ["provider-owned-source-id"];
    return result;
}

function remoteObservation(adapterId: string, context: AdapterProbeContext): ProbeResult {
    const result = observation(adapterId, context);
    return {
        ...result,
        observation: { ...result.observation, adapterId, platformContext: structuredClone(context.platformContext) },
    };
}

function fileSnapshot(root: string): unknown {
    return fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const file = path.join(entry.parentPath, entry.name);
            return [path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
        })
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

describe("CoreService selected WSL probe composition", () => {
    let service: CoreServiceProcessOwner | undefined;
    let root: string | undefined;
    afterEach(() => {
        service?.shutdownProcessState();
        service = undefined;
        clearRegistry();
        if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
    });

    function start(execution?: SelectedWslProbeExecution, contexts = [WINDOWS, UBUNTU, DEBIAN]) {
        clearRegistry();
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-selected-probe-"));
        const local = vi.fn(async (adapterId: string, context: AdapterProbeContext) => observation(adapterId, context));
        service = createCoreService({
            oaamRoot: root,
            databasePath: path.join(root, "index.db"),
            platformContexts: contexts,
            providers: ["PROBE_A", "PROBE_B"].map((adapterId) => ({
                ...makeContractProvider(adapterId),
                probe: (context: AdapterProbeContext) => local(adapterId, context),
            })),
            ...(execution === undefined ? {} : { selectedWslProbeExecution: execution }),
        });
        const enablement = service.getAdapterEnablement().value;
        expect(
            service.replaceAdapterEnablement({
                expectedRevision: enablement.revision,
                expectedSettingFingerprint: enablement.settingFingerprint,
                enabledAdapterIds: ["PROBE_A", "PROBE_B"],
                userActionId: "enable-selected-probe-fixture",
            }).status,
        ).toBe("complete");
        return { core: service, local, root };
    }

    it("routes each mixed-scan branch independently and preserves exact contexts, entries, paths and progress without State writes", async () => {
        const remote = vi.fn(async (adapterId: string, context: AdapterProbeContext) => remoteObservation(adapterId, context));
        const { core, local, root } = start({ probe: remote });
        const before = fileSnapshot(root);
        const progress: ProbeAdapterProgress[] = [];
        const result = await core.probeAdapters(
            { contexts: [WINDOWS, UBUNTU, DEBIAN], target: { authorizationScope: "global" } },
            (value) => progress.push(value),
        );
        expect(result.status).toBe("partial");
        expect(result.value).toHaveLength(6);
        expect(local.mock.calls.map(([, context]) => context.platformContext)).toEqual([WINDOWS, WINDOWS]);
        expect(remote.mock.calls.map(([, context]) => context.platformContext)).toEqual([UBUNTU, DEBIAN, UBUNTU, DEBIAN]);
        for (const item of result.value!) {
            const exact = [WINDOWS, UBUNTU, DEBIAN].find(
                (context) => context.platformInstanceId === item.observation.platformContext.platformInstanceId,
            )!;
            expect(item.observation.platformContext).toEqual(exact);
            expect(item.observation.observedAgentRuntimes[0]!.agentRuntimeId).toBe(`${item.observation.adapterId}_CLI`);
            expect(item.observation.sourceRoots[0]).toMatchObject({
                sourceRootId: "provider-owned-source-id",
                path: path.win32.join(exact.accessRootPath, "selected-source"),
            });
        }
        expect(progress).toHaveLength(7);
        expect(progress[0]).toEqual({ stage: "provider_probe", completedUnits: 0, totalUnits: 6 });
        expect(progress.slice(1).map((value) => value.completedUnits)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(fileSnapshot(root)).toEqual(before);
    });

    it("keeps Win→Win and WSL→WSL local, including an App Server without a delegation port", async () => {
        const remote = vi.fn(async (adapterId: string, context: AdapterProbeContext) => remoteObservation(adapterId, context));
        const { core, local } = start({ probe: remote }, [WINDOWS, LOCAL_WSL]);
        await core.probeAdapters({
            adapterIds: ["PROBE_A"],
            contexts: [WINDOWS, LOCAL_WSL],
            target: { authorizationScope: "global" },
        });
        expect(remote).not.toHaveBeenCalled();
        expect(local.mock.calls.map(([, context]) => context.platformContext)).toEqual([WINDOWS, LOCAL_WSL]);
        core.shutdownProcessState();
        service = undefined;
        fs.rmSync(root!, { recursive: true, force: true });
        const second = start(undefined, [WINDOWS, LOCAL_WSL]);
        await second.core.probeAdapters({
            adapterIds: ["PROBE_A"],
            contexts: [LOCAL_WSL],
            target: { authorizationScope: "global" },
        });
        expect(second.local).toHaveBeenCalledOnce();
    });

    it("rejects a missing WSL execution port while preserving the local Windows sibling", async () => {
        const { core, local } = start();
        const result = await core.probeAdapters({
            adapterIds: ["PROBE_A"],
            contexts: [WINDOWS, UBUNTU],
            target: { authorizationScope: "global" },
        });
        expect(local.mock.calls.map(([, context]) => context.platformContext)).toEqual([WINDOWS]);
        expect(result.value?.map((item) => [item.observation.platformContext, item.status])).toEqual([
            [WINDOWS, "partial"],
            [UBUNTU, "failed"],
        ]);
        expect(result.value?.[1]?.diagnostics[0]?.message).toContain("selected WSL probe execution is unavailable");
    });

    it.each([
        "throw",
        "reject",
    ])("retains Windows and sibling distro observations when one WSL channel fails by %s", async (failure) => {
        const { core } = start({
            probe(adapterId, context) {
                if (context.platformContext.platformInstanceId === "Ubuntu") {
                    if (failure === "throw") throw new Error("channel unavailable before request");
                    return Promise.reject(new Error("channel lost during request"));
                }
                return Promise.resolve(remoteObservation(adapterId, context));
            },
        });
        const result = await core.probeAdapters({
            adapterIds: ["PROBE_A"],
            contexts: [WINDOWS, UBUNTU, DEBIAN],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("partial");
        expect(result.value?.map((item) => [item.observation.platformContext, item.status])).toEqual([
            [WINDOWS, "partial"],
            [UBUNTU, "failed"],
            [DEBIAN, "partial"],
        ]);
        expect(result.value?.[1]?.observation.observedAgentRuntimes).toEqual([]);
        expect(result.value?.[1]?.diagnostics[0]?.code).toContain("probe_error");
    });

    it.each([
        "adapter",
        "platform",
        "distro",
        "root",
        "entry",
    ])("rejects a response with a foreign %s before assigning the requested context", async (field) => {
        const { core } = start({
            probe: async (adapterId, context) => {
                const result = remoteObservation(adapterId, context);
                if (field === "adapter") result.observation.adapterId = "PROBE_B";
                if (field === "platform") result.observation.platformContext.platform = "win32";
                if (field === "distro") result.observation.platformContext.platformInstanceId = "Debian";
                if (field === "root") result.observation.platformContext.accessRootPath = DEBIAN.accessRootPath;
                if (field === "entry") result.observation.observedAgentRuntimes[0]!.agentRuntimeId = "PROBE_B_CLI";
                return result;
            },
        });
        const result = await core.probeAdapters({
            adapterIds: ["PROBE_A"],
            contexts: [WINDOWS, UBUNTU],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("partial");
        expect(result.value?.[0]?.status).toBe("partial");
        expect(result.value?.[1]).toMatchObject({
            status: "failed",
            observation: { adapterId: "PROBE_A", platformContext: UBUNTU, observedAgentRuntimes: [] },
        });
    });

    it("does not delegate or retry locally for an unselected WSL Environment", async () => {
        const remote = vi.fn(async (adapterId: string, context: AdapterProbeContext) => remoteObservation(adapterId, context));
        const { core, local } = start({ probe: remote }, [WINDOWS, UBUNTU]);
        const result = await core.probeAdapters({
            adapterIds: ["PROBE_A"],
            contexts: [WINDOWS, DEBIAN],
            target: { authorizationScope: "global" },
        });
        expect(remote).not.toHaveBeenCalled();
        expect(local).toHaveBeenCalledOnce();
        expect(result.value?.[1]).toMatchObject({ status: "failed", observation: { platformContext: DEBIAN } });
    });
});
