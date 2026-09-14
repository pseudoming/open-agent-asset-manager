import type { ProbeResult } from "@oaam/core";

type ProbeEnvironmentReferenceProjection = {
    readonly adapterId: ProbeResult["observation"]["adapterId"];
    readonly agentRuntimeId: NonNullable<ProbeResult["observation"]["environmentReferences"]>[number]["agentRuntimeId"];
    readonly originEnvironment: {
        readonly platform: ProbeResult["observation"]["platformContext"]["platform"];
        readonly platformInstanceId: string;
    };
    readonly referencedEnvironment: { readonly platform: "wsl"; readonly platformInstanceId: string };
    readonly referenceKind: "project";
    readonly validationState: "not_checked";
};

export function projectProbeEnvironmentReferences(results: readonly ProbeResult[]): ProbeEnvironmentReferenceProjection[] {
    const checkedWslNames = new Map<string, Set<string>>();
    for (const result of results) {
        const { adapterId, platformContext } = result.observation;
        if (platformContext.platform !== "wsl") continue;
        const key = environmentIdentity(adapterId, "wsl", platformContext.platformInstanceId.toLowerCase());
        const names = checkedWslNames.get(key) ?? new Set<string>();
        names.add(platformContext.platformInstanceId);
        checkedWslNames.set(key, names);
    }
    return results
        .flatMap((result) =>
            (result.observation.environmentReferences ?? [])
                .filter(
                    (reference) =>
                        checkedWslNames.get(
                            environmentIdentity(
                                result.observation.adapterId,
                                reference.referencedEnvironment.platform,
                                reference.referencedEnvironment.platformInstanceId.toLowerCase(),
                            ),
                        )?.size !== 1,
                )
                .map((reference) => ({
                    adapterId: result.observation.adapterId,
                    agentRuntimeId: reference.agentRuntimeId,
                    originEnvironment: {
                        platform: result.observation.platformContext.platform,
                        platformInstanceId: result.observation.platformContext.platformInstanceId,
                    },
                    referencedEnvironment: { ...reference.referencedEnvironment },
                    referenceKind: reference.referenceKind,
                    validationState: reference.validationState,
                })),
        )
        .sort((left, right) => projectionIdentity(left).localeCompare(projectionIdentity(right)));
}

function environmentIdentity(adapterId: string, platform: string, platformInstanceId: string): string {
    return [adapterId, platform, platformInstanceId].join("\0");
}

function projectionIdentity(reference: ProbeEnvironmentReferenceProjection): string {
    return [
        reference.adapterId,
        reference.agentRuntimeId,
        reference.originEnvironment.platform,
        reference.originEnvironment.platformInstanceId,
        reference.referencedEnvironment.platformInstanceId,
    ].join("\0");
}
