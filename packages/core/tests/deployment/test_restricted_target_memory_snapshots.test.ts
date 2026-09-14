import { withSelectedMemoryCatalogCapture } from "../../src/orchestration/deployment-target-operations";
/** Shared Catalog receipts retain ordinary projection and fresh selected-target reads. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetRequest,
    type RestrictedTargetResponse,
} from "../../src/deployment/restricted-target-contract";
import { bindRestrictedTargetReviewChannel } from "../../src/orchestration/restricted-target-review-channel";
import * as snapshotOwner from "../../src/orchestration/deployment-render-target-snapshot";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import type { RenderBaseAuthority } from "../../src/orchestration/deployment-render-authority";
import {
    prepareRenderOperation,
    reprojectObservedReverseRenderOperation,
} from "../../src/orchestration/deployment-render-service";
import { captureMemoryCatalogTargets } from "../../src/orchestration/deployment-render-target-snapshot";
import { type SelectedWslTargetExecution } from "../../src/orchestration/selected-wsl-target-execution";
import type { PosixRelativePath, ProbeResult } from "../../src/types";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import {
    executeRestrictedBuildObservation,
    type RestrictedBuildObservationSelection,
} from "../../src/orchestration/restricted-build-observation";
import { createTargetCheckObservationSnapshot } from "../../src/render/native-project-target-observation-snapshot";
import { partialUnknownProbe } from "../adapters/fixtures/adapter-contract-fixtures";
import {
    CATALOG_TEXT,
    CHANGED_CATALOG_TEXT,
    MEMORY_CATALOG_PATH,
    makeMemoryCatalogExactFileFixture,
} from "../render/fixtures/native-project-memory-catalog-test-fixtures";

const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(mutate?: (response: RestrictedTargetResponse) => void) {
    const catalog = makeMemoryCatalogExactFileFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-memory-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, MEMORY_CATALOG_PATH), CATALOG_TEXT);
    const hostRoot = `\\\\wsl.localhost\\test-wsl${root.replaceAll("/", "\\")}`;
    const context = { platform: "wsl" as const, platformInstanceId: "test-wsl", accessRootPath: hostRoot };
    const binding = {
        bindingId: randomUUID(),
        deploymentId: catalog.deployment.deploymentId,
        platformInstanceId: "test-wsl",
        targetRootPath: hostRoot,
        executionRootPath: root,
    };
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
    const requests: RestrictedTargetRequest[] = [];
    const channel = createRestrictedTargetChannel(session, (request) => {
        requests.push(structuredClone(request));
        const response = service.handle(JSON.parse(JSON.stringify(request)));
        mutate?.(response);
        return JSON.parse(JSON.stringify(response));
    });
    const review = channel.bind(binding).review!;
    const admissions: string[] = [];
    const selectedWslTargetExecution: SelectedWslTargetExecution = {
        async withTarget(request, run) {
            expect(request).toEqual({ platformContext: context, targetRootPath: hostRoot, deploymentId: binding.deploymentId });
            admissions.push(request.deploymentId);
            return run(channel.bind(binding));
        },
    };
    const base: RenderBaseAuthority = {
        deploymentId: catalog.deployment.deploymentId,
        consumerAgentRuntimeIds: catalog.deployment.consumerAgentRuntimeIds,
        platform: "wsl",
        platformInstanceId: "test-wsl",
        targetRootPath: hostRoot,
        projectId: catalog.deployment.projectId,
        projectRootPath: hostRoot,
        assets: catalog.deployment.assets,
        dialectInputs: catalog.analysisInput.dialectInputs,
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: catalog.deployment.deploymentId,
            consumerAgentRuntimeIds: catalog.deployment.consumerAgentRuntimeIds,
            assets: catalog.deployment.assets.map((asset) => ({ ...asset.version.ref, allowIncomplete: false })),
        },
    };
    const configuration = { platformContexts: [context], selectedWslTargetExecution };
    const probe: ProbeResult = {
        status: "complete",
        observation: {
            adapterId: catalog.provider.adapterId,
            platformContext: context,
            observedAgentRuntimes: [],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [],
    };
    const dependencies = {
        buildRenderRegistry: () => catalog.registry,
        probeAdapters: async () => ({ status: "complete" as const, value: [probe], diagnostics: [] }),
        resolveObservedTargetContext: () => ({
            status: "complete" as const,
            targetContext: catalog.deployment.targetContexts[0]!,
            diagnostics: [] as [],
        }),
    };
    return {
        root,
        hostRoot,
        binding,
        session,
        service,
        channel,
        review,
        requests,
        admissions,
        base,
        configuration,
        dependencies,
        capture: () => review.captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], hostRoot),
    };
}

describe("restricted Memory Catalog target snapshots", () => {
    it("passes the selected build reader through original render preparation and samples its exact fixture file", async () => {
        const h = fixture();
        const context = h.configuration.platformContexts[0]!;
        const filePath = h.hostRoot + "\\fixture-consumer";
        const bytes = Buffer.from("isolated build-observation fixture\n");
        fs.writeFileSync(path.join(h.root, "fixture-consumer"), bytes, { mode: 0o700 });
        const probe = (await h.dependencies.probeAdapters()).value[0]!;
        probe.observation.observedAgentRuntimes = [
            {
                ...partialUnknownProbe(h.base.consumerAgentRuntimeIds[0]!).observation.observedAgentRuntimes[0]!,
                installationStatus: "available",
                installationEvidence: [{ kind: "executable", path: filePath, evidenceLevel: "local_artifact", diagnostics: [] }],
            },
        ];
        const build = vi.fn((selection: RestrictedBuildObservationSelection) =>
            executeRestrictedBuildObservation(context, selection),
        );
        const selectedProbe = vi.fn(async () => {
            throw new Error("unexpected separate Provider probe");
        });
        const resolver: Parameters<typeof prepareRenderOperation>[2]["resolveObservedTargetContext"] = async (
            _input,
            _snapshot,
            read,
        ) => {
            if (read === undefined) throw new Error("original preparation omitted selected physical reader");
            const observed = await read({ ...context, filePath }, 25_000);
            expect(observed.sha256Hex).toBe(sha256Bytes(bytes).slice(7));
            expect(observed.executable).toBe(true);
            return h.dependencies.resolveObservedTargetContext();
        };
        const operation = await prepareRenderOperation(
            h.base,
            { ...h.configuration, selectedWslProbeExecution: { probe: selectedProbe, observeBuildArtifacts: build } } as never,
            { ...h.dependencies, resolveObservedTargetContext: resolver } as never,
            undefined,
            createTargetCheckObservationSnapshot(),
        );
        expect(build).toHaveBeenCalledOnce();
        expect(selectedProbe).not.toHaveBeenCalled();
        expect(operation.deployment.targetFileSnapshots).toEqual(captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.root));
        expect(fs.readFileSync(path.join(h.root, "fixture-consumer"))).toEqual(bytes);
    });

    it("rejects an invalid path closure in the original capture entrypoint", () => {
        const h = fixture();
        expect(() => captureMemoryCatalogTargets(["../outside" as PosixRelativePath], h.root)).toThrowError(
            expect.objectContaining({ code: "render.shared_target_path_closure_invalid", retryable: false }),
        );
        expect(fs.readFileSync(path.join(h.root, MEMORY_CATALOG_PATH), "utf8")).toBe(CATALOG_TEXT);
    });

    it.each(["kind", "failure", "capture"])("rejects malformed Memory Catalog %s after original snapshot capture", (kind) => {
        const h = fixture();
        const invalidate = vi.fn();
        const review = bindRestrictedTargetReviewChannel(
            h.binding,
            (_binding, operation) => {
                const result = h.service.handle({
                    ...h.session,
                    protocol: RESTRICTED_TARGET_PROTOCOL,
                    operationId: randomUUID(),
                    sequence: 1,
                    bindingId: h.binding.bindingId,
                    operation,
                }).result;
                expect(result).toMatchObject({ kind: "memory_catalog_snapshots", outcome: "captured" });
                if (kind === "kind") return { kind: "prepare", outcome: "ready" };
                if (kind === "failure")
                    return {
                        kind: "memory_catalog_snapshots",
                        outcome: "failed",
                        code: "unknown",
                        message: 1,
                        retryable: true,
                    } as never;
                return { ...result, extra: true };
            },
            invalidate,
        );
        expect(() => review.captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.hostRoot)).toThrow();
        expect(invalidate).toHaveBeenCalledOnce();
        expect(fs.readFileSync(path.join(h.root, MEMORY_CATALOG_PATH), "utf8")).toBe(CATALOG_TEXT);
    });

    it("retains a typed non-retryable closure refusal from the capture dependency", () => {
        const h = fixture();
        const invalidate = vi.fn();
        const review = bindRestrictedTargetReviewChannel(
            h.binding,
            () => ({
                kind: "memory_catalog_snapshots",
                outcome: "failed",
                code: "render.shared_target_path_closure_invalid",
                message: "capture rejected its closure",
                retryable: false,
            }),
            invalidate,
        );
        expect(() => review.captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.hostRoot)).toThrowError(
            expect.objectContaining({ code: "render.shared_target_path_closure_invalid", retryable: false }),
        );
        expect(invalidate).not.toHaveBeenCalled();
        expect(h.requests).toHaveLength(0);
    });

    it("rejects extra fields on an actual missing Memory Catalog snapshot", () => {
        const h = fixture((response) => {
            if (response.result.kind !== "memory_catalog_snapshots" || response.result.outcome !== "captured")
                throw new Error("expected capture");
            expect(response.result.snapshots[0]!.snapshotState).toBe("missing");
            Object.assign(response.result.snapshots[0]!, { contentHash: `sha256:${"0".repeat(64)}` });
        });
        fs.unlinkSync(path.join(h.root, MEMORY_CATALOG_PATH));
        expect(() => h.capture()).toThrow("invalid missing Memory Catalog snapshot");
        expect(h.channel.available).toBe(false);
    });

    it("propagates an untyped capture dependency exception without projecting a typed refusal", () => {
        const h = fixture();
        const original = snapshotOwner.captureMemoryCatalogTargets;
        vi.spyOn(snapshotOwner, "captureMemoryCatalogTargets").mockImplementation((...args) => {
            expect(original(...args)[0]!.snapshotState).toBe("present");
            throw new Error("Memory capture dependency failed after read");
        });
        expect(() => h.capture()).toThrow("Memory capture dependency failed after read");
        expect(h.channel.available).toBe(false);
    });

    it("captures fresh present, missing and executable receipts without transmitting Catalog contents", () => {
        const h = fixture();
        const first = h.capture();
        expect(first).toEqual(captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.root));
        fs.writeFileSync(path.join(h.root, MEMORY_CATALOG_PATH), CHANGED_CATALOG_TEXT);
        fs.chmodSync(path.join(h.root, MEMORY_CATALOG_PATH), 0o700);
        expect(h.capture()).not.toEqual(first);
        expect(h.capture()).toEqual(captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.root));
        fs.unlinkSync(path.join(h.root, MEMORY_CATALOG_PATH));
        expect(h.capture()).toEqual([{ relativePath: MEMORY_CATALOG_PATH, snapshotState: "missing" }]);
        expect(h.requests.every((request) => request.operation.kind === "memory_catalog_snapshots")).toBe(true);
        expect(JSON.stringify(h.requests)).not.toContain(CATALOG_TEXT);
        expect(h.channel.available).toBe(true);
    });

    it.each(["directory", "oversized"])("retains the original %s failure and reuses the channel after correction", (kind) => {
        const h = fixture();
        const target = path.join(h.root, MEMORY_CATALOG_PATH);
        if (kind === "directory") {
            fs.unlinkSync(target);
            fs.mkdirSync(target);
        } else fs.writeFileSync(target, Buffer.alloc(4 * 1024 * 1024 + 1));
        expect(() => h.capture()).toThrowError(
            expect.objectContaining({ code: "render.shared_target_unavailable", retryable: true }),
        );
        expect(h.channel.available).toBe(true);
        if (kind === "directory") fs.rmdirSync(target);
        fs.writeFileSync(target, CATALOG_TEXT);
        expect(h.capture()).toEqual(captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.root));
    });

    it.each(["foreign", "omitted", "hash", "extra_authority"])("retires %s receipt metadata without replay", (kind) => {
        const h = fixture((response) => {
            const result = response.result;
            if (result.kind !== "memory_catalog_snapshots" || result.outcome !== "captured")
                throw new Error("expected snapshots");
            const snapshot = result.snapshots[0]!;
            if (kind === "foreign") snapshot.relativePath = "other.md" as PosixRelativePath;
            else if (kind === "omitted") result.snapshots = [];
            else if (kind === "hash" && snapshot.snapshotState === "present") snapshot.contentHash = "sha256:invalid";
            else Object.assign(snapshot, { bytes: [1, 2], credentialPath: "/unapproved" });
        });
        expect(() => h.capture()).toThrow();
        expect(h.channel.available).toBe(false);
        expect(() => h.capture()).toThrow();
        expect(h.requests).toHaveLength(1);
    });

    it("rejects an unbounded or escaping path closure before exchange", () => {
        const h = fixture();
        expect(() => h.review.captureMemoryCatalogTargets(["../outside" as PosixRelativePath], h.hostRoot)).toThrow();
        expect(h.requests).toHaveLength(0);
        const second = fixture();
        expect(() =>
            second.review.captureMemoryCatalogTargets(
                Array.from({ length: 17 }, (_, index) => `file-${String(index).padStart(2, "0")}.md` as PosixRelativePath),
                second.hostRoot,
            ),
        ).toThrow();
        expect(second.requests).toHaveLength(0);
    });

    it("uses the selected target capture in ordinary preparation and fresh reverse projection", async () => {
        const h = fixture();
        const operation = await prepareRenderOperation(h.base, h.configuration as never, h.dependencies as never);
        expect(operation.deployment.targetFileSnapshots).toEqual(captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.root));
        expect(h.admissions).toHaveLength(1);
        fs.writeFileSync(path.join(h.root, MEMORY_CATALOG_PATH), CHANGED_CATALOG_TEXT);
        const projected = await withSelectedMemoryCatalogCapture(h.configuration, h.base, (capture) =>
            reprojectObservedReverseRenderOperation(h.base, { base: h.base, operation }, h.dependencies, capture),
        );
        expect(projected.deployment.targetFileSnapshots).toEqual(captureMemoryCatalogTargets([MEMORY_CATALOG_PATH], h.root));
        expect(projected.deployment.targetFileSnapshots).not.toEqual(operation.deployment.targetFileSnapshots);
        expect(h.admissions).toHaveLength(2);
        expect(h.requests).toHaveLength(2);
        expect(fs.existsSync(h.hostRoot)).toBe(false);
    });

    it("does not acquire a target process for an operation with no Catalog asset", async () => {
        const h = fixture();
        const base = {
            ...h.base,
            assets: h.base.assets.filter(
                (asset) => asset.version.canonical.kind !== "Memory" || asset.version.canonical.typeData.entityRole !== "catalog",
            ),
        };
        const capture = await withSelectedMemoryCatalogCapture(h.configuration, base, (selected) => selected);
        expect(capture).toBeUndefined();
        expect(h.admissions).toHaveLength(0);
        expect(h.requests).toHaveLength(0);
    });
});
