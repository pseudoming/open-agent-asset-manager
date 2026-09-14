import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext, SelectedWslTargetRequest } from "@oaam/core";
import {
    createRestrictedTargetService,
    type RestrictedTargetRequest,
    type RestrictedTargetServiceConfiguration,
} from "@oaam/core/restricted-operations";
import type { InstalledRestrictedCode, RestrictedProcessLaunch, RestrictedProcessTransport } from "@oaam/app-server-host";
import { RestrictedProcessStartError } from "../../host/src/restricted-process-client";
import { createRestrictedProcessPoolForTest } from "../../host/src/restricted-process-pool";
import { createProductionSelectedWslTargetsForTest } from "../src/production-selected-wsl-targets";
import {
    type ActiveJournalV3,
    publishJournal,
    readJournal,
    recordJournalCreatedDirectory,
} from "../../../core/src/deployment/deployment-journal";
import { computePhysicalClosureKeys } from "../../../core/src/foundation/physical-path-locks";
import { buildDeployEntries } from "../../../core/src/deployment/deployment-target-entries";
import { sha256Bytes } from "../../../core/src/foundation/crypto-bytes";

vi.mock("@oaam/app-server-host", () => import("../../host/src/index"));
type Response = ReturnType<ReturnType<typeof createRestrictedTargetService>["handle"]>;
const FP = `sha256:${"a".repeat(64)}` as const;
const roots: string[] = [];
const fixtures: Array<{ manager: ReturnType<typeof createProductionSelectedWslTargetsForTest>; expectedCloseFailure: boolean }> =
    [];
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

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-production-target-owner-"));
    roots.push(root);
    const localRoots = [path.join(root, "ubuntu"), path.join(root, "debian")];
    for (const local of localRoots) {
        fs.mkdirSync(path.join(local, "target"), { recursive: true });
        fs.writeFileSync(path.join(local, "target/GUIDANCE.md"), "old\n");
    }
    const contexts: PlatformContext[] = ["Ubuntu", "Debian"].map((distro, index) => ({
        platform: "wsl",
        platformInstanceId: distro,
        accessRootPath: `\\\\wsl.localhost\\${distro}${localRoots[index]!.replaceAll("/", "\\")}`,
    }));
    const requests: SelectedWslTargetRequest[] = contexts.map((context) => ({
        platformContext: context,
        deploymentId: randomUUID(),
        targetRootPath: `${context.accessRootPath}\\target`,
    }));
    const hostInstanceId = randomUUID();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const behavior = { response: (response: Response): unknown => response };
    const peers: Array<{
        transport: RestrictedProcessTransport;
        launch: RestrictedProcessLaunch;
        requests: RestrictedTargetRequest[];
        state: { available: boolean };
    }> = [];
    const start = vi.fn(async (launch: RestrictedProcessLaunch): Promise<RestrictedProcessTransport> => {
        const { configuration } = launch.operation as { configuration: RestrictedTargetServiceConfiguration };
        const service = createRestrictedTargetService(configuration);
        const state = { available: true };
        const requests: RestrictedTargetRequest[] = [];
        const transport: RestrictedProcessTransport = {
            ready: { ...launch.session },
            get available() {
                return state.available;
            },
            async exchange() {
                throw new Error("complete target operations use the synchronous channel");
            },
            exchangeSync(value) {
                const request = JSON.parse(JSON.stringify(value)) as RestrictedTargetRequest;
                requests.push(request);
                return JSON.parse(JSON.stringify(behavior.response(service.handle(request))));
            },
            close: vi.fn(async () => {
                state.available = false;
            }),
        };
        peers.push({ transport, launch, requests, state });
        return transport;
    });
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
    const manager = createProductionSelectedWslTargetsForTest(contexts, "C:\\OAAM\\profile", () => hostInstanceId, {
        createPool: () => ({ acquire, close: pool.close }),
        resolveCode,
        now: () => now,
    });
    const input = (request = requests[0]!) => ({
        deploymentId: request.deploymentId,
        targetRootPath: request.targetRootPath,
        renderInputFingerprint: FP,
        selectionFingerprint: FP,
        compilationFingerprint: FP,
        baseline: [],
        targetPlan: {
            schemaVersion: 1 as const,
            managedDirectoryBoundaries: [],
            targetFiles: [
                {
                    relativePath: "GUIDANCE.md",
                    content: { contentKind: "text" as const, text: "new\n" },
                    executable: false,
                    outputUnitFingerprint: FP,
                    materializationFingerprint: FP,
                    semanticRefFingerprints: [],
                    sectionBindings: [],
                },
            ],
        },
    });
    const run = (request = requests[0]!) =>
        manager.execution.withTarget(request, (execution) => execution.review!.capturePreWritePreview(input(request)));
    const f = {
        root,
        localRoots,
        contexts,
        requests,
        hostInstanceId,
        peers,
        start,
        acquire,
        behavior,
        manager,
        resolveCode,
        input,
        run,
        expectedCloseFailure: false,
        advanceTo: (value: number) => {
            now = value;
        },
    };
    fixtures.push(f);
    return f;
}

function usage(h: ReturnType<typeof fixture>, request = h.requests[0]!) {
    return h.manager.execution.withUsageTarget(
        { platformContext: request.platformContext, targetRootPath: request.targetRootPath },
        (execution) => {
            expect(Object.keys(execution).sort()).toEqual(["binding", "review"]);
            expect(execution.binding).not.toHaveProperty("deploymentId");
            return execution.review.observeAssetUsageTargets([
                {
                    files: [
                        {
                            relativePath: "GUIDANCE.md",
                            contentHash: sha256Bytes(Buffer.from("old\n")),
                            byteSize: 4,
                            executable: false,
                        },
                    ],
                    directoryBoundaries: [],
                    sourceIdentityFingerprints: [],
                },
            ]);
        },
    );
}

describe("Bootstrap read-only usage ownership", () => {
    it("reuses one exact-root usage peer across fresh checks and interleaved real Deployment reviews", async () => {
        const h = fixture();
        expect((await usage(h))[0]!.observedTargetState).toBe("already_usable");
        await h.run();
        const usagePeer = h.peers[0]!,
            deploymentPeer = h.peers[1]!;
        fs.writeFileSync(path.join(h.localRoots[0]!, "target/GUIDANCE.md"), "new\n");
        expect((await usage(h))[0]!.observedTargetState).toBe("different");
        await h.run();
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(usagePeer.requests.map((request) => request.operation.kind)).toEqual(["asset_usage", "asset_usage"]);
        expect(deploymentPeer.requests.map((request) => request.operation.kind)).toEqual(["preview", "preview"]);
        expect(usagePeer.transport.close).not.toHaveBeenCalled();
        expect(deploymentPeer.transport.close).not.toHaveBeenCalled();
        await h.manager.close();
        expect(h.peers.every((peer) => !peer.state.available)).toBe(true);
    });

    it("retires only the old usage root when another approved root is selected", async () => {
        const h = fixture();
        await h.run();
        await usage(h);
        fs.mkdirSync(path.join(h.localRoots[0]!, "other"));
        const changed = { ...h.requests[0]!, targetRootPath: `${h.contexts[0]!.accessRootPath}\\other` };
        expect((await usage(h, changed))[0]!.observedTargetState).toBe("absent");
        expect(h.peers[1]!.state.available).toBe(false);
        expect(h.peers[0]!.transport.close).not.toHaveBeenCalled();
        await h.run();
        expect(h.start).toHaveBeenCalledTimes(3);
    });

    it("serializes usage and Deployment admission within the same Environment", async () => {
        const h = fixture();
        const entered = deferred(),
            release = deferred();
        const active = h.manager.execution.withUsageTarget(h.requests[0]!, async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const pending = h.run();
        try {
            await Promise.resolve();
            expect(h.start).toHaveBeenCalledTimes(1);
        } finally {
            release.resolve();
        }
        await Promise.all([active, pending]);
        expect(h.start).toHaveBeenCalledTimes(2);
    });

    it("blocks both purposes after uncertain cleanup of the usage peer", async () => {
        const h = fixture();
        await usage(h);
        await h.run();
        vi.mocked(h.peers[0]!.transport.close).mockRejectedValue(new Error("usage cleanup unknown"));
        h.expectedCloseFailure = true;
        const changed = { ...h.requests[0]!, targetRootPath: `${h.contexts[0]!.accessRootPath}\\other` };
        await expect(usage(h, changed)).rejects.toThrow("usage cleanup unknown");
        await expect(h.run()).rejects.toThrow("usage cleanup unknown");
        expect(h.start).toHaveBeenCalledTimes(2);
    });

    it("rotates an expired usage peer while keeping the healthy Deployment peer", async () => {
        const h = fixture();
        await usage(h);
        h.advanceTo(Date.now() + 60_000);
        await h.run();
        h.advanceTo(h.peers[0]!.launch.deadlineAt - 29_999);
        await usage(h);
        await h.run();
        expect(h.start).toHaveBeenCalledTimes(3);
        expect(h.peers[0]!.state.available).toBe(false);
        expect(h.peers[1]!.transport.close).not.toHaveBeenCalled();
    });
});

describe("ordinary Bootstrap complete selected target ownership", () => {
    it("continues a retained V3 graph only after persisting its created-directory receipt", async () => {
        const h = fixture(),
            transactions = path.join(h.root, "transactions"),
            request = h.requests[0]!;
        await h.manager.execution.withTarget(request, (execution) => {
            const targetPlan = {
                ...h.input().targetPlan,
                targetFiles: h.input().targetPlan.targetFiles.map((file) => ({ ...file, relativePath: "empty/SKILL.md" })),
                managedDirectoryBoundaries: [
                    { relativePath: "empty", outputUnitFingerprint: FP, desiredDirectoryPaths: ["empty"] },
                ],
            };
            const preview = execution.review!.capturePreWritePreview({
                ...h.input(),
                targetPlan,
            });
            const { replacementScope: _completeScope, ...legacyAuthority } = preview.runtimeReplacementAuthority;
            const graph = execution.graph!;
            const prepared = graph.prepare({
                compilationFingerprint: FP,
                entries: buildDeployEntries(targetPlan, new Map()).map((entry) => ({
                    ...entry,
                    newProvenanceFingerprint: FP,
                    newMaterializationFingerprint: FP,
                })),
                managedDirectoryBoundaries: ["empty"],
                desiredDirectoryPaths: ["empty"],
                runtimeReplacementAuthority: legacyAuthority,
            });
            if (prepared.outcome !== "ready")
                throw new Error(`expected graph preparation: ${JSON.stringify({ prepared, requests: h.peers[0]!.requests })}`);
            const value = prepared.prepared;
            const journal: ActiveJournalV3 = {
                schemaVersion: 3,
                transactionId: randomUUID(),
                deploymentId: request.deploymentId,
                createdAt: Date.now(),
                compilationFingerprint: value.compilationFingerprint,
                entries: value.entries,
                managedDirectoryBoundaries: value.managedDirectoryBoundaries,
                directoryEntries: value.directoryEntries,
                targetExecution: value.targetExecution,
                reservedPhysicalKeys: computePhysicalClosureKeys("wsl", request.targetRootPath, [
                    ...value.entries.map((entry) => ({
                        relativePath: entry.relativePath,
                        entryKind: "file" as const,
                        containingDirectoryBoundaries: ["empty"],
                    })),
                    ...value.directoryEntries.map((entry) => ({
                        relativePath: entry.relativePath,
                        entryKind: "directory" as const,
                    })),
                ]),
            };
            publishJournal(transactions, journal);
            const persist = vi.fn(
                (
                    current: ActiveJournalV3,
                    relativePath: string,
                    identity: Parameters<typeof recordJournalCreatedDirectory>[3],
                    side: "old" | "new",
                ) => {
                    expect(side).toBe("new");
                    expect(readJournal(transactions, current.transactionId)).toEqual(current);
                    expect(h.peers[0]!.requests.at(-1)!.operation.kind).toBe("execute_graph");
                    const updated = recordJournalCreatedDirectory(transactions, current, relativePath, identity);
                    expect(readJournal(transactions, current.transactionId)).toEqual(updated);
                    return updated;
                },
            );
            const result = graph.execute(value.preparationId, journal, persist);
            expect(result.result.outcome).toBe("verified");
            expect(persist).toHaveBeenCalledOnce();
        });
        expect(h.peers[0]!.requests.map((value) => value.operation.kind)).toEqual([
            "preview",
            "prepare_graph",
            "execute_graph",
            "continue_graph",
        ]);
        expect(fs.statSync(path.join(h.localRoots[0]!, "target/empty")).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(h.localRoots[0]!, "target/GUIDANCE.md"), "utf8")).toBe("old\n");
    });
    it.each([
        "mapping",
        "acquired",
        "queued",
    ] as const)("closes during %s without invoking the target callback", async (boundary) => {
        const h = fixture(),
            held = deferred(),
            reached = deferred(),
            callback = vi.fn();
        if (boundary === "mapping") {
            const resolveCode = h.resolveCode.getMockImplementation()!;
            h.resolveCode.mockImplementationOnce(async () => {
                const value = await resolveCode();
                reached.resolve();
                await held.promise;
                return value;
            });
        } else if (boundary === "acquired") {
            const acquire = h.acquire.getMockImplementation()!;
            h.acquire.mockImplementationOnce(async (...args) => {
                const value = await acquire(...args);
                reached.resolve();
                await held.promise;
                return value;
            });
        }
        const pending = h.manager.execution.withTarget(h.requests[0]!, callback);
        const rejected = expect(pending).rejects.toThrow("shutting down");
        if (boundary !== "queued") await reached.promise;
        const closing = h.manager.close();
        held.resolve();
        await rejected;
        await closing;
        expect(callback).not.toHaveBeenCalled();
        expect(h.start).toHaveBeenCalledTimes(boundary === "acquired" ? 1 : 0);
        if (boundary === "acquired") expect(h.peers[0]!.transport.close).toHaveBeenCalled();
    });
    it("enforces the business-operation cap inside one admitted callback", async () => {
        const h = fixture();
        await expect(
            h.manager.execution.withTarget(h.requests[0]!, (execution) => {
                for (let index = 0; index <= 128; index += 1) execution.review!.capturePreWritePreview(h.input());
            }),
        ).rejects.toThrow("budget exhausted");
        expect(h.peers[0]!.requests).toHaveLength(128);
        await h.run();
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.peers[0]!.transport.close).toHaveBeenCalled();
    });
    it("starts lazily and reuses the exact Host/profile/root channel across queued and later fresh observations", async () => {
        const h = fixture();
        expect(h.start).not.toHaveBeenCalled();
        const first = await h.run();
        fs.writeFileSync(path.join(h.localRoots[0]!, "target/GUIDANCE.md"), "changed\n");
        const [second, third] = await Promise.all([h.run(), h.run()]);
        expect(second.view.previewFingerprint).toBe(first.view.previewFingerprint);
        for (const [result, bytes] of [
            [first, "old\n"],
            [second, "changed\n"],
        ] as const) {
            const file = result.runtimeReplacementAuthority.files.find((entry) => entry.relativePath === "GUIDANCE.md");
            if (file?.expectedState !== "present") throw new Error("Expected a fresh present-file observation");
            expect(Buffer.from(file.expectedBytes).toString("utf8")).toBe(bytes);
        }
        expect(third).toEqual(second);
        expect(h.start).toHaveBeenCalledTimes(1);
        expect(h.resolveCode).toHaveBeenCalledTimes(1);
        expect(h.peers[0]!.requests.map((request) => request.sequence)).toEqual([1, 2, 3]);
        expect(h.peers[0]!.launch.session.hostInstanceId).toBe(h.hostInstanceId);
        expect(h.peers[0]!.launch.distroName).toBe("Ubuntu");
        expect(h.peers[0]!.launch.maximumConcurrentRequests).toBe(1);
    });

    it("waits for the current operation before closing and rebinding the same selected Environment", async () => {
        const h = fixture();
        const entered = deferred();
        const release = deferred();
        const first = h.manager.execution.withTarget(h.requests[0]!, async (execution) => {
            const value = execution.review!.capturePreWritePreview(h.input());
            entered.resolve();
            await release.promise;
            return value;
        });
        await entered.promise;
        fs.mkdirSync(path.join(h.localRoots[0]!, "second"));
        const changed = {
            ...h.requests[0]!,
            deploymentId: randomUUID(),
            targetRootPath: `${h.contexts[0]!.accessRootPath}\\second`,
        };
        const second = h.run(changed);
        try {
            await Promise.resolve();
            expect(h.start).toHaveBeenCalledTimes(1);
            expect(h.peers[0]!.transport.close).not.toHaveBeenCalled();
        } finally {
            release.resolve();
        }
        await first;
        await second;
        expect(h.peers[0]!.transport.close).toHaveBeenCalledTimes(1);
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.peers[1]!.requests[0]!.sequence).toBe(1);
    });

    it("keeps selected Environments independent and rejects an unselected context before admission", async () => {
        const h = fixture();
        const entered = deferred();
        const release = deferred();
        const first = h.manager.execution.withTarget(h.requests[0]!, async (execution) => {
            entered.resolve();
            await release.promise;
            return execution.review!.capturePreWritePreview(h.input());
        });
        await entered.promise;
        try {
            await h.run(h.requests[1]);
            expect(h.start).toHaveBeenCalledTimes(2);
            expect(h.peers.map((peer) => peer.launch.distroName)).toEqual(["Ubuntu", "Debian"]);
            await expect(
                h.run({
                    ...h.requests[0]!,
                    platformContext: { ...h.contexts[0]!, accessRootPath: `${h.contexts[0]!.accessRootPath}\\foreign` },
                }),
            ).rejects.toThrow(/outside this Host/);
            expect(h.start).toHaveBeenCalledTimes(2);
        } finally {
            release.resolve();
        }
        await first;
    });

    it("keeps the process after a normal target-read refusal and observes the repaired target afresh", async () => {
        const h = fixture();
        const file = path.join(h.localRoots[0]!, "target/GUIDANCE.md");
        fs.unlinkSync(file);
        fs.mkdirSync(file);
        await expect(h.run()).rejects.toThrow(/cannot read/);
        expect(h.peers[0]!.transport.close).not.toHaveBeenCalled();
        fs.rmdirSync(file);
        fs.writeFileSync(file, "repaired\n");
        await h.run();
        expect(h.start).toHaveBeenCalledTimes(1);
        expect(h.peers[0]!.requests).toHaveLength(2);
    });

    it("retires a malformed response without replay and confirms cleanup before a later explicit request", async () => {
        const h = fixture();
        h.behavior.response = (response) => ({ ...response, sessionId: randomUUID() });
        await expect(h.run()).rejects.toThrow(/identity mismatch/);
        expect(h.peers[0]!.requests).toHaveLength(1);
        h.behavior.response = (response) => response;
        await h.run();
        expect(h.peers[0]!.transport.close).toHaveBeenCalled();
        expect(h.peers[0]!.state.available).toBe(false);
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.peers[1]!.requests[0]!.sequence).toBe(1);
    });

    it("reserves sufficient business-operation headroom and rotates only before the next admission", async () => {
        const h = fixture();
        for (let i = 0; i < 120; i++) await h.run();
        await h.manager.execution.withTarget(h.requests[0]!, (execution) => {
            for (let i = 0; i < 8; i++) execution.review!.capturePreWritePreview(h.input());
        });
        expect(h.start).toHaveBeenCalledTimes(1);
        expect(h.peers[0]!.requests).toHaveLength(128);
        await h.run();
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.peers[0]!.transport.close).toHaveBeenCalled();
        expect(h.peers[0]!.state.available).toBe(false);
    });

    it("rotates before the original deadline loses its request window", async () => {
        const h = fixture();
        await h.run();
        h.advanceTo(h.peers[0]!.launch.deadlineAt - 29_999);
        await h.run();
        expect(h.peers[0]!.transport.close).toHaveBeenCalled();
        expect(h.peers[0]!.state.available).toBe(false);
        expect(h.start).toHaveBeenCalledTimes(2);
        expect(h.peers[1]!.launch.deadlineAt).toBeGreaterThan(h.peers[0]!.launch.deadlineAt);
    });

    it("blocks replacement and shutdown completion after cleanup uncertainty", async () => {
        const h = fixture();
        await h.run();
        vi.mocked(h.peers[0]!.transport.close).mockRejectedValue(new Error("owned target cleanup unknown"));
        h.expectedCloseFailure = true;
        const changed = { ...h.requests[0]!, deploymentId: randomUUID() };
        await expect(h.run(changed)).rejects.toThrow(/cleanup unknown/);
        await expect(h.run()).rejects.toThrow(/cleanup unknown/);
        expect(h.start).toHaveBeenCalledTimes(1);
        await expect(h.manager.close()).rejects.toThrow(/release was not confirmed/);
    });

    it.each([true, false])("handles startup cleanupConfirmed=%s without retrying the failed request", async (confirmed) => {
        const h = fixture();
        h.start.mockRejectedValueOnce(new RestrictedProcessStartError(confirmed, new Error("controlled start failure")));
        if (!confirmed) h.expectedCloseFailure = true;
        await expect(h.run()).rejects.toThrow(/controlled start failure/);
        expect(h.start).toHaveBeenCalledTimes(1);
        if (confirmed) {
            await h.run();
            expect(h.start).toHaveBeenCalledTimes(2);
        } else {
            await expect(h.run()).rejects.toThrow(/controlled start failure/);
            expect(h.start).toHaveBeenCalledTimes(1);
        }
    });

    it("joins active work before closing and immediately rejects new admissions during shutdown", async () => {
        const h = fixture();
        const entered = deferred();
        const release = deferred();
        const active = h.manager.execution.withTarget(h.requests[0]!, async (execution) => {
            const result = execution.review!.capturePreWritePreview(h.input());
            entered.resolve();
            await release.promise;
            return result;
        });
        await entered.promise;
        const stopped = h.manager.close();
        try {
            await expect(h.run()).rejects.toThrow(/shutting down/);
            expect(h.peers[0]!.transport.close).not.toHaveBeenCalled();
        } finally {
            release.resolve();
        }
        await active;
        await stopped;
        expect(h.peers[0]!.transport.close).toHaveBeenCalledTimes(1);
        expect(h.start).toHaveBeenCalledTimes(1);
    });
});
