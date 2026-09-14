/** Real isolated files and the original async target resolver; the service transport is serialized in process. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import * as physicalPaths from "@oaam/shared/paths";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { validateAdapterProbeResult } from "../../src/adapters/adapter-probe-validator";
import {
    compileRestrictedBuildObservation,
    validateRestrictedBuildObservationSelection,
} from "../../src/orchestration/restricted-build-observation";
import { selectedWslBuildObservation } from "../../src/orchestration/selected-wsl-build-observation";
import {
    createRestrictedProbeChannel,
    createRestrictedProbeService,
    RESTRICTED_PROBE_MAX_FRAME_BYTES,
    type RestrictedProbeWireRequest,
    type RestrictedProbeWireResponse,
} from "../../src/orchestration/restricted-probe-service";
import { resolveObservedNativeProjectTargetContextAsyncWithSnapshot } from "../../src/render/native-project-guidance-observation";
import {
    primeOperationLocalBuildArtifactObservations,
    OPERATION_BUILD_WAVE_MILLISECONDS,
} from "../../src/render/native-project-target-build-observation";
import {
    createTargetCheckObservationSnapshot,
    prewarmedTargetCheckBuildObservation,
} from "../../src/render/native-project-target-observation-snapshot";
import type { AdapterProbeResult, ProbeResult } from "../../src/types";
import { BUILD_BYTES, BUILD_IDENTITY, makeFixture } from "../render/fixtures/observed-native-project-guidance-test-fixtures";
import { makeContractProvider } from "./fixtures/adapter-contract-fixtures";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
});

async function fixture(largeMetadata = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-build-"));
    roots.push(root);
    const project = path.join(root, "project");
    const file = path.join(root, "bin", "consumer");
    fs.mkdirSync(path.dirname(file));
    fs.mkdirSync(project);
    fs.writeFileSync(file, BUILD_BYTES, { mode: 0o700 });
    const original = makeFixture({ accessRootPath: root, targetRootPath: project });
    if (largeMetadata) original.input.probeResult.observation.observedProjects[0]!.displayName = "x".repeat(7 * 1024 * 1024);
    const secondary = structuredClone(original.input.probeResult);
    secondary.observation.adapterId = "SECOND";
    secondary.observation.observedAgentRuntimes[0]!.agentRuntimeId = "SECOND_CLI";
    secondary.observation.targetCandidates[0]!.entryApplicabilities[0]!.agentRuntimeId = "SECOND_CLI";
    const raw = (result: ProbeResult): AdapterProbeResult => {
        const { adapterId: _owner, platformContext: _context, ...observation } = result.observation;
        return { status: result.status, diagnostics: result.diagnostics, observation };
    };
    const probe = vi.fn(async () => raw(original.input.probeResult));
    const providers = [
        { ...makeContractProvider("ANTIGRAVITY"), probe },
        { ...makeContractProvider("SECOND"), probe: async () => raw(secondary) },
    ];
    expect(
        validateAdapterProbeResult(
            providers[0]!,
            raw(original.input.probeResult),
            original.input.probeResult.observation.platformContext,
        ),
    ).toEqual([]);
    expect(validateAdapterProbeResult(providers[1]!, raw(secondary), secondary.observation.platformContext)).toEqual([]);
    const context = {
        platform: "wsl" as const,
        platformInstanceId: "wsl-test",
        accessRootPath: `\\\\wsl.localhost\\wsl-test${root.replaceAll("/", "\\")}`,
    };
    const projection = createSelectedWslPathProjection(context.platformInstanceId, context.accessRootPath);
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID(), platformContext: context };
    const service = createRestrictedProbeService({ ...session, providers, deadlineAt: Date.now() + 60_000 });
    const requests: RestrictedProbeWireRequest[] = [];
    const behavior = {
        after: (_response: RestrictedProbeWireResponse) => undefined as void,
        before: (_request: RestrictedProbeWireRequest) => undefined as void,
    };
    const channel = createRestrictedProbeChannel({
        ...session,
        async exchange(source) {
            const request = JSON.parse(JSON.stringify(source)) as RestrictedProbeWireRequest;
            requests.push(request);
            behavior.before(request);
            const response = await service.handle(request);
            behavior.after(response);
            return JSON.parse(JSON.stringify(response));
        },
    });
    const observed = await channel.probe("ANTIGRAVITY", {
        authorizationScope: "project",
        platformContext: context,
        projectRootPath: projection.toHost(project),
    });
    expect(observed.observation.observedAgentRuntimes[0]!.installationStatus).toBe("available");
    const input = {
        ...original.input,
        probeResult: observed,
        targetRootPath: projection.toHost(project),
        projectRootPath: projection.toHost(project),
    };
    const physical = selectedWslBuildObservation([context], channel, [observed])!;
    return { root, file, input, context, channel, behavior, requests, probe, observed, physical, projection, service };
}

describe("selected WSL build observations", () => {
    it.each(["empty", "duplicate", "environment"])("rejects %s probe authority before compilation", async (kind) => {
        const h = await fixture();
        const other = structuredClone(h.observed);
        other.observation.adapterId = "SECOND";
        other.observation.platformContext.platformInstanceId = "OTHER";
        const probes = kind === "empty" ? [] : [h.observed, kind === "duplicate" ? h.observed : other];
        expect(() => compileRestrictedBuildObservation(probes, "single", [h.projection.toHost(h.file)])).toThrow();
        expect(h.requests).toHaveLength(1);
    });

    it.each([
        "extra",
        "mode",
        "empty",
        "entry",
        "duplicate",
        "mixed_probe",
    ])("rejects malformed compiled selection %s", async (kind) => {
        const h = await fixture();
        const original = compileRestrictedBuildObservation([h.observed], "single", [h.projection.toHost(h.file)]);
        expect(() => validateRestrictedBuildObservationSelection(original, h.context)).not.toThrow();
        const selection = structuredClone(original);
        if (kind === "extra") Object.assign(selection, { extra: true });
        else if (kind === "mode") Object.assign(selection, { mode: "unknown" });
        else if (kind === "empty") Object.assign(selection, { entries: [] });
        else if (kind === "entry") Object.assign(selection.entries[0]!, { adapterId: "" });
        else {
            const other = structuredClone(selection.entries[0]!);
            if (kind === "mixed_probe") {
                Object.assign(other, { probeFingerprint: `sha256:${"0".repeat(64)}` });
                other.evidence.path += "-another";
            }
            Object.assign(selection, { mode: "wave", entries: [...selection.entries, other] });
        }
        expect(() => validateRestrictedBuildObservationSelection(selection, h.context)).toThrow();
        expect(h.requests).toHaveLength(1);
    });

    it.each([
        "envelope",
        "result_envelope",
        "result_bounds",
    ])("retires after original build observation returns %s damage", async (kind) => {
        const h = await fixture();
        h.behavior.after = (response) => {
            if (!("observations" in response)) return;
            expect(response.observations.items[0]).toMatchObject({ status: "complete", sha256Hex: BUILD_IDENTITY.slice(7) });
            if (kind === "envelope") Object.assign(response, { extra: true });
            else if (kind === "result_envelope") Object.assign(response.observations, { extra: true });
            else Object.assign(response.observations, { maximumConcurrencyObserved: 2 });
        };
        const selection = compileRestrictedBuildObservation([h.observed], "single", [h.projection.toHost(h.file)]);
        await expect(h.channel.observeBuildArtifacts(selection)).rejects.toThrow();
        await expect(h.channel.observeBuildArtifacts(selection)).rejects.toThrow("unavailable");
        expect(h.requests).toHaveLength(2);
        expect(fs.readFileSync(h.file)).toEqual(Buffer.from(BUILD_BYTES));
    });

    it("rejects a compiled request exceeding the original frame limit before exchange", async () => {
        const h = await fixture();
        const selection = compileRestrictedBuildObservation([h.observed], "single", [h.projection.toHost(h.file)]);
        Object.assign(selection.entries[0]!, { adapterId: "x".repeat(RESTRICTED_PROBE_MAX_FRAME_BYTES) });
        expect(() => validateRestrictedBuildObservationSelection(selection, h.context)).not.toThrow();
        await expect(h.channel.observeBuildArtifacts(selection)).rejects.toThrow("request exceeds limit");
        expect(h.requests).toHaveLength(1);
    });

    it("expires after the actual build file observation and rejects its late result", async () => {
        const h = await fixture();
        const original = physicalPaths.snapshotPlatformContextRegularFileNoFollowBounded;
        vi.spyOn(physicalPaths, "snapshotPlatformContextRegularFileNoFollowBounded").mockImplementation(async (...args) => {
            const observed = await original(...args);
            expect(observed.sha256Hex).toBe(BUILD_IDENTITY.slice(7));
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(Date.now() + 60_000);
            return observed;
        });
        await expect(
            h.physical.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).rejects.toThrow("expired during build observation");
        expect(h.requests).toHaveLength(2);
    });

    it("propagates an ordinary physical dependency failure without inventing a typed observation", async () => {
        const h = await fixture();
        const failure = new Error("physical dependency failed before receipt");
        vi.spyOn(physicalPaths, "snapshotPlatformContextRegularFileNoFollowBounded").mockRejectedValue(failure);
        await expect(
            h.physical.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).rejects.toBe(failure);
        expect(h.requests).toHaveLength(2);
        expect(fs.readFileSync(h.file)).toEqual(Buffer.from(BUILD_BYTES));
    });

    it.each([
        "wave_context",
        "wave_concurrency",
        "wave_timeout",
        "single_context",
        "single_timeout",
    ])("rejects changed original physical request %s before dispatch", async (kind) => {
        const h = await fixture();
        const input = {
            ...h.context,
            filePaths: [h.projection.toHost(h.file)],
            maximumConcurrency: 1,
            timeoutMilliseconds: OPERATION_BUILD_WAVE_MILLISECONDS,
        };
        if (kind.endsWith("context")) input.platformInstanceId = "OTHER";
        if (kind === "wave_concurrency") input.maximumConcurrency = 2;
        if (kind.endsWith("timeout")) input.timeoutMilliseconds = 1;
        if (kind.startsWith("wave"))
            expect(() => h.physical.observeBuildArtifacts(input)).toThrow("changed its original physical request");
        else
            await expect(
                h.physical.snapshotRegularFile(
                    { ...input, filePath: input.filePaths[0]! },
                    kind === "single_timeout" ? 1 : 25_000,
                ),
            ).rejects.toThrow("changed its original physical request");
        expect(h.requests).toHaveLength(1);
    });

    it("retains the original 64-file wave bound and rejects a larger closure before admission", async () => {
        const h = await fixture();
        const source = structuredClone(h.observed);
        const runtime = source.observation.observedAgentRuntimes[0]!;
        const template = runtime.installationEvidence[0]!;
        runtime.installationEvidence = Array.from({ length: 65 }, (_, index) => {
            const file = path.join(h.root, `build-${index}`);
            fs.writeFileSync(file, BUILD_BYTES, { mode: 0o700 });
            return { ...template, path: h.projection.toHost(file) };
        });
        const paths = runtime.installationEvidence.map((entry) => entry.path);
        const result = await h.channel.observeBuildArtifacts(
            compileRestrictedBuildObservation([source], "wave", paths.slice(0, 64)),
        );
        expect(result.items).toHaveLength(64);
        expect(result.items.every((item) => item.status === "complete" && item.sha256Hex === BUILD_IDENTITY.slice(7))).toBe(true);
        expect(result.maximumConcurrencyObserved).toBeLessThanOrEqual(4);
        expect(() => compileRestrictedBuildObservation([source], "wave", paths)).toThrow("mode or Provider evidence");
        expect(h.requests).toHaveLength(2);
    });

    it("uses the original async target resolver and a fresh Linux snapshot without another Provider invocation", async () => {
        const h = await fixture();
        const resolve = () =>
            resolveObservedNativeProjectTargetContextAsyncWithSnapshot(
                h.input,
                createTargetCheckObservationSnapshot(),
                h.physical.snapshotRegularFile,
            );
        expect((await resolve()).status).toBe("complete");
        expect(h.probe).toHaveBeenCalledOnce();
        expect(h.requests.map((request) => request.sequence)).toEqual([1, 2]);
        expect(h.requests[1]).toMatchObject({
            buildObservation: { mode: "single", entries: [{ evidence: { path: h.projection.toHost(h.file) } }] },
        });
        fs.writeFileSync(h.file, "actual changed executable");
        expect(await resolve()).toMatchObject({ status: "failed" });
        expect(h.probe).toHaveBeenCalledOnce();
        expect(h.requests).toHaveLength(3);
    });

    it("shares the original build wave and retained facts while reading only missing current observations", async () => {
        const h = await fixture();
        const retained = structuredClone(h.observed);
        const evidence = retained.observation.observedAgentRuntimes[0]!.installationEvidence[0]!;
        retained.observation.observedAgentRuntimes[0]!.installationEvidence.push({
            ...evidence,
            path: h.projection.toHost(path.join(h.root, "retained")),
            currentBuildObservation: {
                identity: { deviceId: "kept", fileId: "original", entryKind: "file" },
                executable: true,
                byteSize: 9,
                buildIdentity: BUILD_IDENTITY,
            },
        });
        const physical = selectedWslBuildObservation([h.context], h.channel, [retained])!;
        const snapshot = createTargetCheckObservationSnapshot();
        primeOperationLocalBuildArtifactObservations([retained], snapshot, physical.observeBuildArtifacts);
        expect(await prewarmedTargetCheckBuildObservation(snapshot, evidence.path)).toMatchObject({
            buildIdentity: BUILD_IDENTITY,
        });
        expect(
            await prewarmedTargetCheckBuildObservation(snapshot, h.projection.toHost(path.join(h.root, "retained"))),
        ).toMatchObject({ identity: { fileId: "original" } });
        expect(h.requests[1]).toMatchObject({
            buildObservation: { mode: "wave", entries: [{ evidence: { path: evidence.path } }] },
        });
        const buildRequest = h.requests[1];
        if (buildRequest === undefined || !("buildObservation" in buildRequest)) throw new Error("expected a build request");
        expect(buildRequest.buildObservation.entries).toHaveLength(1);
        await resolveObservedNativeProjectTargetContextAsyncWithSnapshot(h.input, snapshot, physical.snapshotRegularFile);
        expect(h.requests).toHaveLength(2);
    });

    it("keeps two individually valid 7 MiB probe metadata payloads off the build frame", async () => {
        const h = await fixture(true);
        const second = await h.channel.probe("SECOND", { authorizationScope: "global", platformContext: h.context });
        const results = [h.observed, second];
        expect(Buffer.byteLength(JSON.stringify(results))).toBeGreaterThan(12 * 1024 * 1024);
        const selection = compileRestrictedBuildObservation(results, "wave", [h.projection.toHost(h.file)]);
        expect(Buffer.byteLength(JSON.stringify(selection))).toBeLessThan(2048);
        expect((await h.channel.observeBuildArtifacts(selection)).items[0]).toMatchObject({
            status: "complete",
            sha256Hex: BUILD_IDENTITY.slice(7),
        });
        expect(h.probe).toHaveBeenCalledOnce();
    });

    it("preserves a typed missing-file failure in Host coordinates and permits same-peer correction", async () => {
        const h = await fixture();
        fs.unlinkSync(h.file);
        await expect(
            h.physical.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).rejects.toMatchObject({ failureKind: "not_found", targetPath: h.projection.toHost(h.file) });
        fs.writeFileSync(h.file, BUILD_BYTES, { mode: 0o700 });
        expect(
            await h.physical.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).toMatchObject({ sha256Hex: BUILD_IDENTITY.slice(7) });
        expect(h.requests.map((request) => request.sequence)).toEqual([1, 2, 3]);
    });

    it("rejects unselected contexts and missing B ownership without falling back to the local reader", async () => {
        const h = await fixture();
        expect(() => selectedWslBuildObservation([], h.channel, [h.observed])).toThrow("selected Environment");
        const missing = selectedWslBuildObservation([h.context], { probe: h.channel.probe }, [h.observed])!;
        await expect(
            missing.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).rejects.toThrow("owner is unavailable");
        const native = structuredClone(h.observed);
        native.observation.platformContext.accessRootPath = h.root;
        expect(selectedWslBuildObservation([native.observation.platformContext], h.channel, [native])).toBeUndefined();
        expect(selectedWslBuildObservation([h.context], undefined, [h.observed])).toBeUndefined();
        expect(h.requests).toHaveLength(1);
    });

    it.each([
        "untrusted",
        "error",
        "outside",
        "unavailable",
        "kind",
    ])("rejects %s evidence before service admission", async (variant) => {
        const h = await fixture();
        const source = structuredClone(h.observed);
        const runtime = source.observation.observedAgentRuntimes[0]!;
        const evidence = runtime.installationEvidence[0]!;
        if (variant === "untrusted") evidence.evidenceLevel = "source_code";
        if (variant === "outside") evidence.path = h.context.accessRootPath + "\\..\\outside";
        if (variant === "unavailable") runtime.installationStatus = "unknown";
        if (variant === "kind") evidence.kind = "install_root";
        if (variant === "error")
            evidence.diagnostics = [
                {
                    code: "test.failed",
                    severity: "error",
                    message: "real compile refusal",
                    rawSummary: "",
                    traceId: "",
                    path: evidence.path,
                    operation: "probe",
                    causeKind: "unavailable",
                    retryable: false,
                    suggestedActions: [],
                },
            ];
        expect(() => compileRestrictedBuildObservation([source], "single", [evidence.path])).toThrow("trusted build evidence");
        expect(h.requests).toHaveLength(1);
    });

    it.each([
        "foreign_owner",
        "foreign_runtime",
        "extra_path",
        "malformed_identity",
        "failure",
        "fingerprint",
    ])("rejects %s at the wire boundary and retires without replay", async (variant) => {
        const h = await fixture();
        const selection = compileRestrictedBuildObservation([h.observed], "single", [h.projection.toHost(h.file)]);
        h.behavior.before = (request) => {
            if (!("buildObservation" in request)) return;
            if (variant === "foreign_owner") (request.buildObservation.entries[0] as { adapterId: string }).adapterId = "FOREIGN";
            if (variant === "foreign_runtime")
                (request.buildObservation.entries[0] as { agentRuntimeId: string }).agentRuntimeId = "SECOND_CLI";
        };
        h.behavior.after = (response) => {
            if (!("observations" in response)) return;
            const item = response.observations.items[0] as unknown as Record<string, unknown>;
            if (variant === "extra_path") item.filePath = h.context.accessRootPath + "\\other";
            if (variant === "malformed_identity") item.identity = { deviceId: "x", fileId: "y", entryKind: "directory" };
            if (variant === "failure") Object.assign(item, { status: "failed", failureKind: "unknown", systemCode: "EIO" });
            if (variant === "fingerprint") response.selectionFingerprint = `sha256:${"0".repeat(64)}`;
        };
        await expect(h.channel.observeBuildArtifacts(selection)).rejects.toThrow();
        await expect(h.channel.observeBuildArtifacts(selection)).rejects.toThrow("unavailable");
        expect(h.requests).toHaveLength(2);
    });

    it("rejects a replaced selected root and a real symlink while preserving original file bytes", async () => {
        const h = await fixture();
        const original = fs.readFileSync(h.file);
        fs.renameSync(h.file, h.file + ".original");
        fs.symlinkSync(h.file + ".original", h.file);
        await expect(
            h.physical.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).rejects.toBeInstanceOf(SafeFilesystemError);
        expect(fs.readFileSync(h.file + ".original")).toEqual(original);
        fs.renameSync(h.root, h.root + "-replaced");
        roots.push(h.root + "-replaced");
        fs.mkdirSync(h.root);
        await expect(
            h.physical.snapshotRegularFile({ ...h.context, filePath: h.projection.toHost(h.file) }, 25_000),
        ).rejects.toThrow("root identity changed");
    });
});
