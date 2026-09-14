/** One physical adapter for the original Core build wave and single-file fallback. */
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import {
    getCanonicalPhysicalAccessPathKind,
    type observePlatformContextBuildArtifactsBounded,
    type snapshotPlatformContextRegularFileNoFollowBounded,
} from "@oaam/shared/paths";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import {
    NATIVE_PROJECT_BUILD_OBSERVATION_MILLISECONDS,
    OPERATION_BUILD_WAVE_CONCURRENCY,
    OPERATION_BUILD_WAVE_MILLISECONDS,
} from "../render/native-project-target-build-observation";
import type { PlatformContext, ProbeResult } from "../types";
import type { SelectedWslProbeExecution } from "./selected-wsl-probe-execution";
import { compileRestrictedBuildObservation } from "./restricted-build-observation";

export function selectedWslBuildObservation(
    contexts: readonly PlatformContext[],
    execution: SelectedWslProbeExecution | undefined,
    currentProbeResults: readonly ProbeResult[],
):
    | {
          observeBuildArtifacts: typeof observePlatformContextBuildArtifactsBounded;
          snapshotRegularFile: typeof snapshotPlatformContextRegularFileNoFollowBounded;
      }
    | undefined {
    const context = currentProbeResults[0]?.observation.platformContext;
    if (
        execution === undefined ||
        context === undefined ||
        context.platform !== "wsl" ||
        getCanonicalPhysicalAccessPathKind(context.accessRootPath) !== "win32"
    )
        return undefined;
    if (
        !contexts.some((candidate) => sameProbePlatformContext(candidate, context)) ||
        currentProbeResults.some((result) => !sameProbePlatformContext(result.observation.platformContext, context))
    ) {
        throw new Error("restricted build observation is outside the exact selected Environment");
    }
    const selected = structuredClone(context);
    const probeResults = structuredClone([...currentProbeResults]);
    function owner() {
        if (execution?.observeBuildArtifacts === undefined) throw new Error("restricted build observation owner is unavailable");
        return execution.observeBuildArtifacts.bind(execution);
    }
    return {
        observeBuildArtifacts(input) {
            if (
                !sameProbePlatformContext(input, selected) ||
                input.maximumConcurrency !== Math.min(OPERATION_BUILD_WAVE_CONCURRENCY, input.filePaths.length) ||
                input.timeoutMilliseconds !== OPERATION_BUILD_WAVE_MILLISECONDS
            ) {
                throw new Error("restricted build wave changed its original physical request");
            }
            return owner()(compileRestrictedBuildObservation(probeResults, "wave", input.filePaths));
        },
        async snapshotRegularFile(input, timeoutMilliseconds) {
            if (
                !sameProbePlatformContext(input, selected) ||
                timeoutMilliseconds !== NATIVE_PROJECT_BUILD_OBSERVATION_MILLISECONDS
            ) {
                throw new Error("restricted build snapshot changed its original physical request");
            }
            const result = await owner()(compileRestrictedBuildObservation(probeResults, "single", [input.filePath]));
            const item = result.items[0]!;
            if (item.status === "failed")
                throw new SafeFilesystemError({
                    failureKind: item.failureKind,
                    operation: "inspect_regular_file",
                    targetPath: item.filePath,
                    systemCode: item.systemCode,
                    message: "operation-local build observation failed closed",
                });
            return { executable: item.executable, identity: item.identity, byteSize: item.byteSize, sha256Hex: item.sha256Hex };
        },
    };
}
