/** Physical build facts selected from existing Provider evidence; no arbitrary-path or byte-reading operation. */
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import {
    createSelectedWslPathProjection,
    observePlatformContextBuildArtifactsBounded,
    physicalAccessPathContains,
    snapshotPlatformContextRegularFileNoFollowBounded,
    type PlatformContextBuildObservationItem,
    type PlatformContextBuildObservationResult,
} from "@oaam/shared/paths";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import { fingerprintDomain } from "../foundation/fingerprint";
import { hasExactKeys, isCanonicalTargetRootPath, isSha256Digest } from "../foundation/validators";
import {
    NATIVE_PROJECT_BUILD_OBSERVATION_MILLISECONDS,
    OPERATION_BUILD_WAVE_CONCURRENCY,
    OPERATION_BUILD_WAVE_MILLISECONDS,
} from "../render/native-project-target-build-observation";
import { isBuildBearingFileEvidence, trustedBuildEvidence } from "../render/native-project-target-evidence";
import type { AdapterProvider, InstallationEvidence, PlatformContext, ProbeResult, Sha256Digest } from "../types";

export interface RestrictedBuildObservationSelection {
    readonly platformContext: PlatformContext;
    readonly mode: "wave" | "single";
    readonly entries: readonly {
        readonly adapterId: string;
        readonly agentRuntimeId: string;
        readonly probeFingerprint: Sha256Digest;
        readonly evidence: Pick<InstallationEvidence, "kind" | "path" | "evidenceLevel">;
    }[];
}

/** Called after original registered-probe validation; compilation retains only facts needed for this physical read. */
export function compileRestrictedBuildObservation(
    probeResults: readonly ProbeResult[],
    mode: RestrictedBuildObservationSelection["mode"],
    filePaths: readonly string[],
): RestrictedBuildObservationSelection {
    const context = probeResults[0]?.observation.platformContext;
    if (context === undefined) throw new Error("build observation has no probe Environment");
    const eligible = new Map<string, RestrictedBuildObservationSelection["entries"][number]>();
    const wanted = new Set(filePaths);
    const seen = new Set<string>();
    for (const result of probeResults) {
        const { adapterId, platformContext, observedAgentRuntimes } = result.observation;
        if (seen.has(adapterId) || !sameProbePlatformContext(platformContext, context))
            throw new Error("build observation Provider or Environment mismatch");
        seen.add(adapterId);
        let probeFingerprint: Sha256Digest | undefined;
        for (const runtime of observedAgentRuntimes) {
            if (runtime.installationStatus !== "available") continue;
            for (const evidence of runtime.installationEvidence) {
                if (
                    !wanted.has(evidence.path) ||
                    eligible.has(evidence.path) ||
                    !isBuildBearingFileEvidence(evidence) ||
                    !trustedBuildEvidence(evidence.evidenceLevel) ||
                    evidence.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
                    !isCanonicalTargetRootPath(evidence.path, context.platform) ||
                    !physicalAccessPathContains(context.accessRootPath, evidence.path)
                )
                    continue;
                probeFingerprint ??= fingerprintDomain("oaam.restricted-build.probe.v1", result);
                eligible.set(evidence.path, {
                    adapterId,
                    agentRuntimeId: runtime.agentRuntimeId,
                    probeFingerprint,
                    evidence: { kind: evidence.kind, path: evidence.path, evidenceLevel: evidence.evidenceLevel },
                });
            }
        }
    }
    const selection = {
        platformContext: structuredClone(context),
        mode,
        entries: filePaths.map((filePath) => {
            const entry = eligible.get(filePath);
            if (entry === undefined) throw new Error("build observation path is outside the exact trusted build evidence");
            return entry;
        }),
    };
    validateRestrictedBuildObservationSelection(selection, context);
    return structuredClone(selection);
}

/** The fingerprint binds the exact compiled request, including mode and original Host probe identity. */
export function restrictedBuildSelectionFingerprint(selection: RestrictedBuildObservationSelection): Sha256Digest {
    return fingerprintDomain("oaam.restricted-build.selection.v1", selection);
}

/** Recheck compiled physical claims against the service's Provider inventory, not the original complete probe. */
export function validateRestrictedBuildObservationSelection(
    value: unknown,
    context: PlatformContext,
    providers?: ReadonlyMap<string, AdapterProvider>,
): asserts value is RestrictedBuildObservationSelection {
    if (!hasExactKeys(value, ["platformContext", "mode", "entries"])) throw new Error("invalid build observation selection");
    const selection = value as RestrictedBuildObservationSelection;
    if (
        (selection.mode !== "wave" && selection.mode !== "single") ||
        !hasExactKeys(selection.platformContext, ["platform", "platformInstanceId", "accessRootPath"]) ||
        !sameProbePlatformContext(selection.platformContext, context) ||
        !Array.isArray(selection.entries) ||
        selection.entries.length === 0 ||
        selection.entries.length > 64 ||
        (selection.mode === "single" && selection.entries.length !== 1)
    )
        throw new Error("invalid build observation mode or Provider evidence");
    const seen = new Set<string>();
    const probes = new Map<string, Sha256Digest>();
    for (const entry of selection.entries) {
        if (
            !hasExactKeys(entry, ["adapterId", "agentRuntimeId", "probeFingerprint", "evidence"]) ||
            typeof entry.adapterId !== "string" ||
            entry.adapterId.length === 0 ||
            typeof entry.agentRuntimeId !== "string" ||
            entry.agentRuntimeId.length === 0 ||
            !isSha256Digest(entry.probeFingerprint) ||
            !hasExactKeys(entry.evidence, ["kind", "path", "evidenceLevel"]) ||
            !["executable", "launcher", "app_bundle"].includes(entry.evidence.kind) ||
            !trustedBuildEvidence(entry.evidence.evidenceLevel) ||
            !isCanonicalTargetRootPath(entry.evidence.path, context.platform) ||
            !physicalAccessPathContains(context.accessRootPath, entry.evidence.path) ||
            seen.has(entry.evidence.path)
        )
            throw new Error("invalid compiled build evidence");
        const previous = probes.get(entry.adapterId);
        if (previous !== undefined && previous !== entry.probeFingerprint)
            throw new Error("build observation mixes Provider probes");
        probes.set(entry.adapterId, entry.probeFingerprint);
        seen.add(entry.evidence.path);
        if (
            providers !== undefined &&
            !providers
                .get(entry.adapterId)
                ?.agentRuntimes.some((descriptor) => descriptor.agentRuntimeId === entry.agentRuntimeId)
        )
            throw new Error("build observation lacks its registered Provider owner");
    }
}

/** The session owner validates request identity, Provider evidence, root identity and lifetime around this call. */
export async function executeRestrictedBuildObservation(
    context: PlatformContext,
    selection: RestrictedBuildObservationSelection,
): Promise<PlatformContextBuildObservationResult> {
    const projection = createSelectedWslPathProjection(context.platformInstanceId, context.accessRootPath);
    const local = { ...context, accessRootPath: projection.executionAccessRootPath };
    const filePaths = selection.entries.map((entry) => entry.evidence.path);
    if (selection.mode === "wave") {
        const result = await observePlatformContextBuildArtifactsBounded({
            ...local,
            filePaths: filePaths.map(projection.toExecution),
            maximumConcurrency: Math.min(OPERATION_BUILD_WAVE_CONCURRENCY, filePaths.length),
            timeoutMilliseconds: OPERATION_BUILD_WAVE_MILLISECONDS,
        });
        return { ...result, items: result.items.map((item) => ({ ...item, filePath: projection.toHost(item.filePath) })) };
    }
    const started = performance.now();
    const filePath = filePaths[0]!;
    let item: PlatformContextBuildObservationItem;
    try {
        const value = await snapshotPlatformContextRegularFileNoFollowBounded(
            { ...local, filePath: projection.toExecution(filePath) },
            NATIVE_PROJECT_BUILD_OBSERVATION_MILLISECONDS,
        );
        item = { status: "complete", filePath, ...value };
    } catch (error) {
        if (!(error instanceof SafeFilesystemError)) throw error;
        item = { status: "failed", filePath, failureKind: error.failureKind, systemCode: error.systemCode };
    }
    return { items: [item], elapsedMilliseconds: performance.now() - started, maximumConcurrencyObserved: 1 };
}

/** Exact primitive receipts only. Extra paths, identities, bytes or untyped failures retire the channel. */
export function decodeRestrictedBuildObservationResult(
    value: unknown,
    selection: RestrictedBuildObservationSelection,
): PlatformContextBuildObservationResult {
    if (!hasExactKeys(value, ["items", "elapsedMilliseconds", "maximumConcurrencyObserved"])) {
        throw new Error("invalid build observation result");
    }
    const result = value as PlatformContextBuildObservationResult;
    if (
        !Array.isArray(result.items) ||
        result.items.length !== selection.entries.length ||
        !Number.isFinite(result.elapsedMilliseconds) ||
        result.elapsedMilliseconds < 0 ||
        !Number.isSafeInteger(result.maximumConcurrencyObserved) ||
        result.maximumConcurrencyObserved < 1 ||
        result.maximumConcurrencyObserved >
            (selection.mode === "single" ? 1 : Math.min(OPERATION_BUILD_WAVE_CONCURRENCY, selection.entries.length))
    )
        throw new Error("invalid build observation result bounds");
    for (const [index, item] of result.items.entries()) {
        if (item?.filePath !== selection.entries[index]?.evidence.path)
            throw new Error("build observation returned a foreign path");
        if (item.status === "complete") {
            if (
                !hasExactKeys(item, ["status", "filePath", "identity", "executable", "byteSize", "sha256Hex"]) ||
                !hasExactKeys(item.identity, ["deviceId", "fileId", "entryKind"]) ||
                typeof item.identity.deviceId !== "string" ||
                item.identity.deviceId.length === 0 ||
                typeof item.identity.fileId !== "string" ||
                item.identity.fileId.length === 0 ||
                item.identity.entryKind !== "file" ||
                typeof item.executable !== "boolean" ||
                !Number.isSafeInteger(item.byteSize) ||
                item.byteSize < 0 ||
                typeof item.sha256Hex !== "string" ||
                !/^[0-9a-f]{64}$/.test(item.sha256Hex)
            )
                throw new Error("invalid stable build observation");
        } else if (
            item.status !== "failed" ||
            !hasExactKeys(item, ["status", "filePath", "failureKind", "systemCode"]) ||
            ![
                "invalid_path",
                "not_found",
                "permission_denied",
                "symlink_or_reparse",
                "wrong_entry_type",
                "resource_limit",
                "stale",
                "unsupported_platform",
                "io_error",
            ].includes(item.failureKind) ||
            typeof item.systemCode !== "string"
        )
            throw new Error("invalid build observation failure");
    }
    return structuredClone(result);
}
