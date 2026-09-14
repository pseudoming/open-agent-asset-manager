/** Ordinary Core/SQLite consumers of the restricted target operation; no real WSL process is claimed. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as publicationIo from "../../src/deployment/deployment-publication-io";
import * as deploymentState from "../../src/deployment/deployment-state-ops";
import * as renderAssetAuthority from "../../src/orchestration/deployment-render-asset-authority";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { readVersionAuthority } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { acquireAllLocks, computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";
import { executeDeployment, type DeployResult } from "../../src/deployment/deployment-executor";
import { readJournal } from "../../src/deployment/deployment-journal";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import type { RestrictedTargetRequest } from "../../src/deployment/restricted-target-contract";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import {
    withSelectedWslTargetExecution,
    type SelectedWslTargetExecution,
} from "../../src/orchestration/selected-wsl-target-execution";
import { getDb } from "../../src/persistence/db";
import { getDeployment, getDeploymentAsset, updateDeployment } from "../../src/persistence/state-db";
import { ASSET_ID, PROJECT_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    analyzeAndSelect,
    completeProbe,
    CLAUDE_CODE_FIXTURE,
    databasePath,
    DEPLOYMENT_ID,
    oaamRoot,
    previewedApply,
    provider,
    resolveObservedTarget,
    REVERSE_VERSION_ID,
    reverseUuidSequence,
    sandbox,
    seedAuthority,
    selectionRequest,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

it("refuses a missing selected-WSL target port before invoking the local operation", async () => {
    const run = vi.fn();
    const context = { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: "\\\\wsl.localhost\\Ubuntu\\" };
    await expect(
        withSelectedWslTargetExecution(
            { platformContexts: [context] },
            {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                deploymentId: DEPLOYMENT_ID,
                targetRootPath: context.accessRootPath + "home\\oaam\\project",
            },
            run,
        ),
    ).rejects.toThrow("Selected WSL target execution is unavailable");
    expect(run).not.toHaveBeenCalled();
});

function selectedFixture(
    options: {
        loseExecutionResponse?: boolean;
        mismatchBinding?: boolean;
        beforeInspection?: () => void;
        nestedTarget?: boolean;
    } = {},
) {
    seedAuthority();
    // This serialized-channel fixture owns all physical material under its
    // isolated root; the real environment/volume policy has separate tests.
    vi.spyOn(publicationIo, "publicationStagingRoot").mockImplementation((_ctx, transactionId) =>
        path.join(sandbox, `oaam-deployment-${transactionId}`),
    );
    const toHost = (value: string) => `\\\\wsl.localhost\\wsl-test${value.replaceAll("/", "\\")}`;
    const targetRootPath = toHost(targetRoot);
    // Validate the real native Project authority, then project only its physical
    // coordinates for this serialized Windows/WSL test on a Linux test runner.
    const loadProjectRoot = renderAssetAuthority.loadProjectRootPath;
    vi.spyOn(renderAssetAuthority, "loadProjectRootPath").mockImplementation((configuration, projectId) => {
        expect(projectId).toBe(PROJECT_ID);
        return toHost(loadProjectRoot(configuration, projectId));
    });
    const context = { platform: "wsl" as const, platformInstanceId: "wsl-test", accessRootPath: toHost(sandbox) };
    const db = getDb(databasePath);
    updateDeployment(db, DEPLOYMENT_ID, { targetRootPath }, 3);
    const profile = options.nestedTarget ? { ...CLAUDE_CODE_FIXTURE, relativePath: "nested/CLAUDE.md" } : CLAUDE_CODE_FIXTURE;
    const selected = provider({}, profile);
    selected.probe = async () => {
        const result = completeProbe(profile);
        for (const runtime of result.observation.observedAgentRuntimes)
            for (const evidence of runtime.installationEvidence) evidence.path = toHost(evidence.path);
        for (const root of result.observation.sourceRoots) root.path = toHost(root.path);
        for (const resource of result.observation.agentRuntimeResources) resource.path = toHost(resource.path);
        for (const candidate of result.observation.targetCandidates) candidate.targetRootPath = toHost(candidate.targetRootPath);
        return result;
    };
    const binding = {
        bindingId: randomUUID(),
        deploymentId: DEPLOYMENT_ID,
        platformInstanceId: "wsl-test",
        targetRootPath,
        executionRootPath: targetRoot,
    };
    const requests: RestrictedTargetRequest[] = [];
    const admissions: string[] = [];
    const executions: DeployResult[] = [];
    let loseResponse = options.loseExecutionResponse ?? false;
    let peers = 0;
    function createPeer() {
        peers += 1;
        const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
        const target = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
        return createRestrictedTargetChannel(session, (request) => {
            requests.push(structuredClone(request));
            if (request.operation.kind === "inspection_capture") options.beforeInspection?.();
            const result = target.handle(JSON.parse(JSON.stringify(request)));
            if (loseResponse && result.result.kind === "continue_graph" && result.result.step.kind === "executed") {
                loseResponse = false;
                throw new Error("controlled loss after actual target execution");
            }
            return JSON.parse(JSON.stringify(result));
        });
    }
    let channel = createPeer();
    const targetExecution: SelectedWslTargetExecution = {
        async withTarget(request, run) {
            expect(request).toEqual({ platformContext: context, deploymentId: DEPLOYMENT_ID, targetRootPath });
            admissions.push(request.targetRootPath);
            if (!channel.available) channel = createPeer();
            const execution = channel.bind(binding);
            return run(
                options.mismatchBinding ? { ...execution, binding: { ...binding, deploymentId: randomUUID() } } : execution,
            );
        },
    };
    const core = service(
        selected,
        Number.POSITIVE_INFINITY,
        {
            resolveObservedTargetContext(input) {
                return resolveObservedTarget(input, profile);
            },
            executeDeployment(input, compiled, replacement) {
                expect(input.targetExecution.kind).toBe("selected_wsl");
                expect(input.targetExecution.ownsDeployment(getDeployment(db, DEPLOYMENT_ID)!)).toBe(true);
                const result = executeDeployment(input, compiled, replacement);
                executions.push(result);
                return result;
            },
        },
        {
            platformContexts: [context],
            selectedWslTargetExecution: targetExecution,
            newUuid: reverseUuidSequence(),
            selectedWslProbeExecution: {
                async probe(adapterId, probeContext) {
                    const observed = await selected.probe(probeContext);
                    return { ...observed, observation: { ...observed.observation, adapterId, platformContext: context } };
                },
            },
        },
    );
    return { core, requests, executions, admissions, targetRootPath, peerCount: () => peers };
}

afterEach(() => vi.restoreAllMocks());

describe("ordinary Core selected-WSL target operations", () => {
    it("commits a newly created target parent through the V4 selected service and Host database", async () => {
        const h = selectedFixture({ nestedTarget: true });
        const selection = await analyzeAndSelect(h.core);
        const result = await h.core.deployDeployment(await previewedApply(h.core, selection));
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(h.executions[0]?.outcome).toBe("committed");
        const execution = h.requests.find((request) => request.operation.kind === "execute_graph");
        expect(execution).toMatchObject({
            operation: { journal: { schemaVersion: 4, directoryEntries: [{ relativePath: "nested" }] } },
        });
        expect(fs.readFileSync(path.join(targetRoot, "nested/CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        expect(readJournal(path.join(oaamRoot, "transactions"), h.executions[0]!.transactionId)).toBeNull();
    });

    it("inspects and scans fresh service bytes while keeping Host Version authority unchanged", async () => {
        const h = selectedFixture();
        const selection = await analyzeAndSelect(h.core);
        expect((await h.core.deployDeployment(await previewedApply(h.core, selection))).status).toBe("complete");
        const before = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Selected runtime edit\n");
        const inspected = await h.core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value.changes).toEqual([
            expect.objectContaining({
                changeKind: "file_content_replacement",
                replacementContent: { contentKind: "text", text: "# Selected runtime edit\n" },
            }),
        ]);
        const scanned = await h.core.scanDeployment(DEPLOYMENT_ID);
        expect(scanned.status, JSON.stringify(scanned.diagnostics)).toBe("complete");
        expect(scanned.value.derivedStatus.stage).toBe("conflict");
        expect(readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID)).toEqual(before);
        expect(h.requests.filter((request) => request.operation.kind === "inspection_capture")).toHaveLength(2);
        expect(h.peerCount()).toBe(1);
        expect(h.executions).toHaveLength(1);
    });

    it.each([
        false,
        true,
    ])("retains original reverse compile, Host locks and fresh service observations across commit (drift: %s)", async (drift) => {
        let committing = false;
        const lockStates: boolean[] = [];
        let physicalKeys: ReturnType<typeof computePhysicalClosureKeys> = [];
        const runtimePath = path.join(targetRoot, "CLAUDE.md");
        const h = selectedFixture({
            beforeInspection() {
                if (!committing) return;
                const available = acquireAllLocks(path.join(oaamRoot, "transactions"), physicalKeys);
                lockStates.push(available === null);
                available?.release();
                if (drift && lockStates.length === 2) fs.writeFileSync(runtimePath, "# Changed under Host locks\n");
            },
        });
        physicalKeys = computePhysicalClosureKeys("wsl", h.targetRootPath, [
            { relativePath: "CLAUDE.md", entryKind: "file", containingDirectoryBoundaries: [] },
        ]);
        const selection = await analyzeAndSelect(h.core);
        expect((await h.core.deployDeployment(await previewedApply(h.core, selection))).status).toBe("complete");
        fs.writeFileSync(runtimePath, "# Reviewed selected runtime\n");
        const before = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);
        const inspected = await h.core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        const prepared = await h.core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        if (prepared.value.preparationState !== "prepared") throw new Error("expected a prepared reverse operation");
        committing = true;
        const committed = await h.core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-selected-runtime-edit",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        committing = false;
        expect(lockStates).toEqual([false, true]);
        const version = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            ASSET_ID,
            REVERSE_VERSION_ID,
            createVersionDialectRegistry([], [], [], []),
        );
        if (drift) {
            expect(committed.status).toBe("failed");
            expect(committed.diagnostics[0]?.code).toBe("reverse_accept.inspection_stale");
            expect(version).toBeNull();
            expect(readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID)).toEqual(before);
            expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(VERSION_ID);
            expect(fs.readFileSync(runtimePath, "utf8")).toBe("# Changed under Host locks\n");
        } else {
            expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
            expect(committed.value).toEqual({
                commitState: "committed",
                version: { assetId: ASSET_ID, versionId: REVERSE_VERSION_ID },
            });
            expect(version?.files).toEqual([
                expect.objectContaining({ contentKind: "text", text: "# Reviewed selected runtime\n" }),
            ]);
            expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(REVERSE_VERSION_ID);
            expect(fs.readFileSync(runtimePath, "utf8")).toBe("# Reviewed selected runtime\n");
        }
        expect(h.executions).toHaveLength(1);
        expect(h.peerCount()).toBe(1);
        const released = acquireAllLocks(path.join(oaamRoot, "transactions"), physicalKeys);
        expect(released).not.toBeNull();
        released?.release();
    });

    it("previews and commits through the bound complete target service while Host State remains authoritative", async () => {
        const h = selectedFixture();
        const selection = await analyzeAndSelect(h.core);
        const input = await previewedApply(h.core, selection);
        const result = await h.core.deployDeployment(input);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(h.executions).toHaveLength(1);
        expect(h.executions[0]!.outcome).toBe("committed");
        expect(h.requests.map((request) => request.operation.kind)).toEqual([
            "preview",
            "preview",
            "prepare_graph",
            "execute_graph",
            "continue_graph",
            "continue_graph",
            "recover_graph",
        ]);
        expect(h.admissions).toHaveLength(3);
        expect(h.peerCount()).toBe(1);
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)!.committedTransactionId).toBe(h.executions[0]!.transactionId);
        expect(readJournal(path.join(oaamRoot, "transactions"), h.executions[0]!.transactionId)).toBeNull();
    });

    it("republishes a vanished committed target through durable Host receipts before cleaning its journal", async () => {
        const h = selectedFixture();
        const commit = deploymentState.commitDeploymentSuccess;
        vi.spyOn(deploymentState, "commitDeploymentSuccess").mockImplementationOnce((...args) => {
            commit(...args);
            fs.rmSync(path.join(targetRoot, "CLAUDE.md"));
        });
        const selection = await analyzeAndSelect(h.core);
        const result = await h.core.deployDeployment(await previewedApply(h.core, selection));
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(h.executions[0]).toMatchObject({ outcome: "committed", diagnostics: [] });
        const recoveryIndex = h.requests.findIndex((request) => request.operation.kind === "recover_graph");
        expect(recoveryIndex).toBeGreaterThan(0);
        expect(h.requests.slice(recoveryIndex + 1).some((request) => request.operation.kind === "continue_graph")).toBe(true);
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        expect(readJournal(path.join(oaamRoot, "transactions"), h.executions[0]!.transactionId)).toBeNull();
    });

    it("retains a third value after commit and recovers the committed side only after that value is removed", async () => {
        const h = selectedFixture();
        const commit = deploymentState.commitDeploymentSuccess;
        vi.spyOn(deploymentState, "commitDeploymentSuccess").mockImplementationOnce((...args) => {
            commit(...args);
            fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "external after commit");
        });
        const selection = await analyzeAndSelect(h.core);
        await h.core.deployDeployment(await previewedApply(h.core, selection));
        expect(h.executions[0]).toMatchObject({ outcome: "committed", diagnostics: [{ code: "journal_marker_stuck" }] });
        const transactionId = h.executions[0]!.transactionId;
        const before = readJournal(path.join(oaamRoot, "transactions"), transactionId);
        expect(before?.schemaVersion).toBe(4);
        const blocked = await h.core.recoverDeployment(DEPLOYMENT_ID);
        expect(blocked.status).toBe("failed");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("external after commit");
        expect(readJournal(path.join(oaamRoot, "transactions"), transactionId)).toEqual(before);
        fs.rmSync(path.join(targetRoot, "CLAUDE.md"));
        const recovered = await h.core.recoverDeployment(DEPLOYMENT_ID);
        expect(recovered.status, JSON.stringify(recovered.diagnostics)).toBe("complete");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        expect(readJournal(path.join(oaamRoot, "transactions"), transactionId)).toBeNull();
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)!.committedTransactionId).toBe(transactionId);
    });

    it("reopens the original V4 journal through ordinary recovery after losing the actual publication result", async () => {
        const h = selectedFixture({ loseExecutionResponse: true });
        const selection = await analyzeAndSelect(h.core);
        const result = await h.core.deployDeployment(await previewedApply(h.core, selection));
        expect(result.status).toBe("failed");
        expect(h.executions[0]!.outcome).toBe("blocked");
        const request = h.requests.find((request) => request.operation.kind === "execute_graph");
        if (request?.operation.kind !== "execute_graph") throw new Error("expected the original published execution journal");
        const transactionId = request.operation.journal.transactionId;
        expect(readJournal(path.join(oaamRoot, "transactions"), transactionId)?.schemaVersion).toBe(4);
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)!.committedTransactionId).toBe("");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        const recovered = await h.core.recoverDeployment(DEPLOYMENT_ID);
        expect(recovered.status, JSON.stringify(recovered.diagnostics)).toBe("complete");
        expect(h.peerCount()).toBe(2);
        expect(h.requests.some((request) => request.operation.kind === "recover_graph")).toBe(true);
        expect(h.requests.at(-1)?.operation.kind).toBe("continue_graph");
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(readJournal(path.join(oaamRoot, "transactions"), transactionId)).toBeNull();
    });

    it("publishes the confirmed Version over a later complete-target edit through the real serialized channel", async () => {
        const h = selectedFixture();
        const selection = await analyzeAndSelect(h.core);
        const input = await previewedApply(h.core, selection);
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "external text\n");
        const result = await h.core.deployDeployment(input);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(h.executions).toHaveLength(1);
        const execution = h.requests.find((request) => request.operation.kind === "execute_graph");
        expect(execution).toMatchObject({ operation: { journal: { schemaVersion: 4 } } });
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)!.committedTransactionId).toBe(h.executions[0]!.transactionId);
    });

    it("rejects a mismatched execution owner before its review or executor can consume the target", async () => {
        const h = selectedFixture({ mismatchBinding: true });
        const selectionRequest = await analyzeAndSelect(h.core);
        const result = await h.core.previewDeploymentRender({ deploymentId: DEPLOYMENT_ID, selectionRequest });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("render.selected_wsl_target_mismatch");
        expect(h.requests).toHaveLength(0);
        expect(h.executions).toHaveLength(0);
    });

    it("retains the existing native path for a WSL-local Core even when the trusted selected-Windows port is present", async () => {
        seedAuthority();
        const core = service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            {
                selectedWslTargetExecution: {
                    async withTarget() {
                        throw new Error("native Core must not enter the Windows-selected execution port");
                    },
                },
            },
        );
        const selection = await analyzeAndSelect(core);
        const result = await core.deployDeployment(await previewedApply(core, selection));
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
    });
});
