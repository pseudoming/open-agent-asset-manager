import type { ProtocolOperationProgress } from "@oaam/app-server-protocol";
import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import type { EnvironmentListView } from "./discovery-model";

export interface DiscoveryProbeOwnerTiming {
    readonly adapterId: string;
    readonly environment: EnvironmentListView["environments"][number]["environment"];
    readonly outcome: "complete" | "partial" | "failed";
    readonly elapsedMilliseconds: number;
}

export interface DiscoveryProbeProgress {
    readonly completedUnits: number;
    readonly totalUnits: number;
    readonly owners: readonly DiscoveryProbeOwnerTiming[];
}

export function initialDiscoveryProbeProgress(totalUnits: number): DiscoveryProbeProgress {
    return Object.freeze({ completedUnits: 0, totalUnits, owners: Object.freeze([]) });
}

export function applyDiscoveryProbeProgress(
    current: DiscoveryProbeProgress | undefined,
    progress: ProtocolOperationProgress<"adapter.probe">,
): DiscoveryProbeProgress {
    const prior = current?.owners ?? [];
    const owners =
        "adapterId" in progress
            ? [
                  ...prior.filter(
                      (owner) =>
                          owner.adapterId !== progress.adapterId ||
                          desktopEnvironmentKey(owner.environment) !== desktopEnvironmentKey(progress.environment),
                  ),
                  {
                      adapterId: progress.adapterId,
                      environment: progress.environment,
                      outcome: progress.outcome,
                      elapsedMilliseconds: progress.elapsedMilliseconds,
                  },
              ].sort((left, right) =>
                  `${left.adapterId}\0${desktopEnvironmentKey(left.environment)}`.localeCompare(
                      `${right.adapterId}\0${desktopEnvironmentKey(right.environment)}`,
                  ),
              )
            : prior;
    return Object.freeze({
        completedUnits: progress.completedUnits,
        totalUnits: progress.totalUnits,
        owners: Object.freeze(owners),
    });
}
