/** Trusted App Server composition port for one selected Windows→WSL probe branch. */
import { getCanonicalPhysicalAccessPathKind } from "@oaam/shared/paths";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import type { AdapterId, AdapterProbeContext, PlatformContext, ProbeResult } from "../types";
import type { PlatformContextBuildObservationResult } from "@oaam/shared/paths";
import type { RestrictedBuildObservationSelection } from "./restricted-build-observation";
import { type probeAdapters, probeAdaptersWithExecution } from "./adapter-registry";

export interface SelectedWslProbeExecution {
    probe(adapterId: AdapterId, context: AdapterProbeContext): Promise<ProbeResult>;
    /** Optional for probe-only compositions; selected render operations fail closed when this owner is absent. */
    observeBuildArtifacts?(selection: RestrictedBuildObservationSelection): Promise<PlatformContextBuildObservationResult>;
}

/** Keep selection inside each registry call so a channel failure cannot discard sibling results. */
export function bindSelectedWslProbeExecution(
    contexts: readonly PlatformContext[],
    execution: SelectedWslProbeExecution | undefined,
    localProbe: typeof probeAdapters,
): typeof probeAdapters {
    const selected = structuredClone(contexts);
    return (input, observer) => {
        if (
            execution === undefined &&
            input.contexts.every(
                (context) => context.platform !== "wsl" || getCanonicalPhysicalAccessPathKind(context.accessRootPath) !== "win32",
            )
        )
            return localProbe(input, observer);
        return probeAdaptersWithExecution(input, observer, (adapterId, context) => {
            const requested = context.platformContext;
            if (requested.platform !== "wsl" || getCanonicalPhysicalAccessPathKind(requested.accessRootPath) !== "win32") {
                return undefined;
            }
            if (!selected.some((candidate) => sameProbePlatformContext(candidate, requested))) {
                throw new Error("restricted probe context is outside this App Server's selected Environments");
            }
            if (execution === undefined) throw new Error("selected WSL probe execution is unavailable");
            return execution.probe(adapterId, structuredClone(context));
        });
    };
}
