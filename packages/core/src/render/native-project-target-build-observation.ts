/** Operation-local physical build observation adapters for native project targets. */

import { SafeFilesystemError, type StableRegularFileRead } from "@oaam/shared/filesystem";
import {
    observePlatformContextBuildArtifactsBounded,
    physicalAccessPathContains,
    readPlatformContextRegularFileNoFollow,
    snapshotPlatformContextRegularFileNoFollowBounded,
} from "@oaam/shared/paths";
import { isCanonicalTargetRootPath } from "../foundation/validators";
import type { AgentRuntimeId, ProbeResult, Sha256Digest } from "../types";
import type {
    NativeProjectGuidanceObservationDependenciesForTest,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
} from "./native-project-guidance-profiles";
import type { ReadyObservedTargetCandidate } from "./native-project-target-authority";
import { isBuildBearingFileEvidence, trustedBuildEvidence } from "./native-project-target-evidence";
import {
    observeComputedBuildArtifactForTargetCheckAsync,
    observeStableBuildArtifactForTargetCheck,
    prewarmedTargetCheckBuildObservation,
    primeTargetCheckBuildObservations,
    type StableBuildArtifactObservation,
    type TargetCheckObservationSnapshot,
} from "./native-project-target-observation-snapshot";

export const NATIVE_PROJECT_BUILD_OBSERVATION_MILLISECONDS = 25_000;
export const OPERATION_BUILD_WAVE_MILLISECONDS = 10_000;
export const OPERATION_BUILD_WAVE_CONCURRENCY = 4;

/** @internal Retain fresh probe facts for selected consumers without observing unrelated or missing builds. */
export function retainCurrentTargetBuildObservations(
    currentProbeResults: readonly ProbeResult[],
    consumerAgentRuntimeIds: readonly AgentRuntimeId[],
    snapshot: TargetCheckObservationSnapshot,
): void {
    primeOperationLocalBuildArtifactObservations(
        currentProbeResults.map((result) => ({
            ...result,
            observation: {
                ...result.observation,
                observedAgentRuntimes: result.observation.observedAgentRuntimes
                    .filter((entry) => consumerAgentRuntimeIds.includes(entry.agentRuntimeId))
                    .map((entry) => ({
                        ...entry,
                        installationEvidence: entry.installationEvidence.filter(
                            (evidence) => evidence.currentBuildObservation !== undefined,
                        ),
                    })),
            },
        })),
        snapshot,
    );
}

/** @internal Pre-hash exact trusted file evidence once for this immutable Host target-check operation. */
export function primeOperationLocalBuildArtifactObservations(
    currentProbeResults: readonly ProbeResult[],
    snapshot: TargetCheckObservationSnapshot,
    observeBuildArtifacts: typeof observePlatformContextBuildArtifactsBounded = observePlatformContextBuildArtifactsBounded,
): void {
    const first = currentProbeResults[0]?.observation.platformContext;
    if (first === undefined) return;
    const observationsByPath = new Map<string, StableBuildArtifactObservation | null>();
    for (const result of currentProbeResults) {
        const context = result.observation.platformContext;
        if (
            context.platform !== first.platform ||
            context.platformInstanceId !== first.platformInstanceId ||
            context.accessRootPath !== first.accessRootPath
        ) {
            throw new TypeError("target-check build observation wave spans multiple platform contexts");
        }
        for (const runtime of result.observation.observedAgentRuntimes) {
            if (runtime.installationStatus !== "available") continue;
            for (const evidence of runtime.installationEvidence) {
                if (
                    !isBuildBearingFileEvidence(evidence) ||
                    !trustedBuildEvidence(evidence.evidenceLevel) ||
                    evidence.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
                    !isCanonicalTargetRootPath(evidence.path, context.platform) ||
                    !physicalAccessPathContains(context.accessRootPath, evidence.path)
                ) {
                    continue;
                }
                const current = evidence.currentBuildObservation;
                const observation =
                    current === undefined
                        ? null
                        : Object.freeze({
                              executable: current.executable,
                              identity: Object.freeze({ ...current.identity }),
                              byteSize: current.byteSize,
                              buildIdentity: current.buildIdentity,
                          });
                const retained = observationsByPath.get(evidence.path);
                if (
                    retained !== undefined &&
                    retained !== null &&
                    observation !== null &&
                    !sameCurrentBuildObservation(retained, observation)
                ) {
                    throw new TypeError("target-check current build observations disagree for one physical path");
                }
                if (retained === undefined || (retained === null && observation !== null)) {
                    observationsByPath.set(evidence.path, observation);
                }
            }
        }
    }
    if (observationsByPath.size === 0) return;
    const orderedPaths = [...observationsByPath.keys()].sort(compareUtf8);
    const pathsRequiringObservation = orderedPaths.filter((filePath) => observationsByPath.get(filePath) === null);
    primeTargetCheckBuildObservations(snapshot, {
        planIdentity: {
            platform: first.platform,
            platformInstanceId: first.platformInstanceId,
            accessRootPath: first.accessRootPath,
        },
        filePaths: orderedPaths,
        observe: async () => {
            const observed =
                pathsRequiringObservation.length === 0
                    ? { items: [] }
                    : await observeBuildArtifacts({
                          platform: first.platform,
                          platformInstanceId: first.platformInstanceId,
                          accessRootPath: first.accessRootPath,
                          filePaths: pathsRequiringObservation,
                          maximumConcurrency: Math.min(OPERATION_BUILD_WAVE_CONCURRENCY, pathsRequiringObservation.length),
                          timeoutMilliseconds: OPERATION_BUILD_WAVE_MILLISECONDS,
                      });
            const observedByPath = new Map(observed.items.map((item) => [item.filePath, item] as const));
            return orderedPaths.map((filePath) => {
                const current = observationsByPath.get(filePath);
                if (current !== null && current !== undefined) {
                    return { filePath, status: "complete" as const, observation: current };
                }
                const item = observedByPath.get(filePath);
                if (item === undefined) throw new TypeError("operation-local build observation result is incomplete");
                if (item.status === "failed") {
                    return {
                        filePath: item.filePath,
                        status: "failed" as const,
                        error: new SafeFilesystemError({
                            failureKind: item.failureKind,
                            operation: "inspect_regular_file",
                            targetPath: item.filePath,
                            systemCode: item.systemCode,
                            message: "operation-local build observation failed closed",
                        }),
                    };
                }
                return {
                    filePath: item.filePath,
                    status: "complete" as const,
                    observation: Object.freeze({
                        executable: item.executable,
                        identity: item.identity,
                        byteSize: item.byteSize,
                        buildIdentity: `sha256:${item.sha256Hex}` as Sha256Digest,
                    }),
                };
            });
        },
    });
}

function sameCurrentBuildObservation(left: StableBuildArtifactObservation, right: StableBuildArtifactObservation): boolean {
    return (
        left.executable === right.executable &&
        left.byteSize === right.byteSize &&
        left.buildIdentity === right.buildIdentity &&
        left.identity.deviceId === right.identity.deviceId &&
        left.identity.fileId === right.identity.fileId &&
        left.identity.entryKind === right.identity.entryKind
    );
}

export function platformContextBuildArtifactObserver(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    targetCandidate: ReadyObservedTargetCandidate,
    snapshot?: TargetCheckObservationSnapshot,
): (filePath: string) => StableBuildArtifactObservation {
    const context = input.probeResult.observation.platformContext;
    return operationLocalBuildArtifactObserver(input, targetCandidate, snapshot, (filePath) =>
        readPlatformContextRegularFileNoFollow({
            platform: context.platform,
            platformInstanceId: context.platformInstanceId,
            accessRootPath: context.accessRootPath,
            filePath,
        }),
    );
}

export function operationLocalBuildArtifactObserverAsync(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    targetCandidate: ReadyObservedTargetCandidate,
    snapshot?: TargetCheckObservationSnapshot,
    snapshotRegularFile: typeof snapshotPlatformContextRegularFileNoFollowBounded = snapshotPlatformContextRegularFileNoFollowBounded,
): (filePath: string) => Promise<StableBuildArtifactObservation> {
    const context = input.probeResult.observation.platformContext;
    return (filePath) => {
        const requestIdentity = buildArtifactRequestIdentity(input, targetCandidate, filePath);
        const prewarmed = prewarmedTargetCheckBuildObservation(snapshot, filePath);
        return prewarmed === undefined
            ? observeComputedBuildArtifactForTargetCheckAsync(requestIdentity, snapshot, async () => {
                  const observed = await snapshotRegularFile(
                      {
                          platform: context.platform,
                          platformInstanceId: context.platformInstanceId,
                          accessRootPath: context.accessRootPath,
                          filePath,
                      },
                      NATIVE_PROJECT_BUILD_OBSERVATION_MILLISECONDS,
                  );
                  return Object.freeze({
                      executable: observed.executable,
                      identity: Object.freeze({ ...observed.identity }),
                      byteSize: observed.byteSize,
                      buildIdentity: `sha256:${observed.sha256Hex}` as Sha256Digest,
                  });
              })
            : observeComputedBuildArtifactForTargetCheckAsync(requestIdentity, snapshot, () => prewarmed);
    };
}

export function operationLocalTestBuildArtifactObserver(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    targetCandidate: ReadyObservedTargetCandidate,
    dependencies: NativeProjectGuidanceObservationDependenciesForTest,
    snapshot?: TargetCheckObservationSnapshot,
): (filePath: string) => StableBuildArtifactObservation {
    return operationLocalBuildArtifactObserver(input, targetCandidate, snapshot, dependencies.readBuildArtifact);
}

function operationLocalBuildArtifactObserver(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    targetCandidate: ReadyObservedTargetCandidate,
    snapshot: TargetCheckObservationSnapshot | undefined,
    readFresh: (filePath: string) => StableRegularFileRead,
): (filePath: string) => StableBuildArtifactObservation {
    return (filePath) =>
        observeStableBuildArtifactForTargetCheck(buildArtifactRequestIdentity(input, targetCandidate, filePath), snapshot, () =>
            readFresh(filePath),
        );
}

function buildArtifactRequestIdentity(
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    targetCandidate: ReadyObservedTargetCandidate,
    filePath: string,
): Readonly<Record<string, unknown>> {
    const context = input.probeResult.observation.platformContext;
    return {
        adapterId: input.provider.adapterId,
        agentRuntimeId: input.agentRuntimeId,
        platform: context.platform,
        platformInstanceId: context.platformInstanceId,
        accessRootPath: context.accessRootPath,
        targetCandidateId: targetCandidate.targetCandidateId,
        targetRootPath: input.targetRootPath,
        projectRootPath: input.projectRootPath,
        buildPath: filePath,
    };
}

function compareUtf8(left: string, right: string): number {
    return Buffer.from(left).compare(Buffer.from(right));
}
