/** Target-built private entry. It deliberately never launches the ordinary State-owning Host. */
import { runRestrictedServiceProcess } from "@oaam/app-server-host/restricted-transport";
import {
    createRestrictedProbeService,
    createRestrictedSourceService,
    RESTRICTED_SOURCE_PROTOCOL,
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    type RestrictedSourceServiceConfiguration,
    createRestrictedTargetService,
    RESTRICTED_PROBE_PROTOCOL,
    RESTRICTED_PROBE_MAX_FRAME_BYTES,
    RESTRICTED_TARGET_PROTOCOL,
    RESTRICTED_TARGET_MAX_FRAME_BYTES,
    type RestrictedProbeSession,
    type RestrictedTargetServiceConfiguration,
} from "@oaam/core/restricted-operations";

void runRestrictedServiceProcess(async (value) => {
    const input = value as { protocol: string; configuration: unknown };
    if (input === null || typeof input !== "object" || Object.keys(input).sort().join(",") !== "configuration,protocol") {
        throw new Error("invalid restricted Bootstrap operation");
    }
    if (input.protocol === RESTRICTED_PROBE_PROTOCOL) {
        const { createBuiltinProvidersForRestrictedProbe } = await import("./builtin-providers");
        const configuration = input.configuration as RestrictedProbeSession & { deadlineAt: number };
        return {
            service: createRestrictedProbeService({
                ...configuration,
                providers: createBuiltinProvidersForRestrictedProbe(configuration.platformContext),
            }),
            session: {
                protocol: RESTRICTED_PROBE_PROTOCOL,
                hostInstanceId: configuration.hostInstanceId,
                sessionId: configuration.sessionId,
            },
            deadlineAt: configuration.deadlineAt,
            maximumFrameBytes: RESTRICTED_PROBE_MAX_FRAME_BYTES,
            maximumConcurrentRequests: 16,
        };
    }
    if (input.protocol === RESTRICTED_TARGET_PROTOCOL) {
        const configuration = input.configuration as RestrictedTargetServiceConfiguration;
        return {
            service: createRestrictedTargetService(configuration),
            session: {
                protocol: RESTRICTED_TARGET_PROTOCOL,
                hostInstanceId: configuration.hostInstanceId,
                sessionId: configuration.sessionId,
            },
            deadlineAt: configuration.deadlineAt,
            maximumFrameBytes: RESTRICTED_TARGET_MAX_FRAME_BYTES,
        };
    }
    if (input.protocol === RESTRICTED_SOURCE_PROTOCOL) {
        const { createBuiltinProvidersForRestrictedProbe } = await import("./builtin-providers");
        const configuration = input.configuration as RestrictedSourceServiceConfiguration;
        return {
            service: createRestrictedSourceService({
                ...configuration,
                providers: createBuiltinProvidersForRestrictedProbe(configuration.platformContext),
            }),
            session: {
                protocol: RESTRICTED_SOURCE_PROTOCOL,
                hostInstanceId: configuration.hostInstanceId,
                sessionId: configuration.sessionId,
            },
            deadlineAt: configuration.deadlineAt,
            maximumFrameBytes: RESTRICTED_SOURCE_MAX_FRAME_BYTES,
            maximumConcurrentRequests: 1,
        };
    }
    throw new Error("unknown restricted Bootstrap operation");
});
