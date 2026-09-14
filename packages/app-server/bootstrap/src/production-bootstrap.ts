import {
    createHostRenderApprovalAuthority,
    createProductionHost,
    createStateRecoveryHost,
    HostOperationalDiagnostics,
    type HostStateResilienceIntegration,
    type ProductionHost,
} from "@oaam/app-server-host";
import {
    type CoreServiceConfiguration,
    createCoreService,
    createStateRestoreService,
    reconcileStateRestoreBeforeStartup,
    StateProfileRecoveryRequiredError,
} from "@oaam/core";
import type { ProductionHostLaunchOptions } from "./types";
import { BUILTIN_PROVIDERS } from "./builtin-providers";
import { createProductionSelectedWslProbes } from "./production-selected-wsl-probes";
import { createProductionSelectedWslTargets } from "./production-selected-wsl-targets";
import { createProductionSelectedWslSources } from "./production-selected-wsl-sources";

const inspectionDoesNotQuiesce = (): Promise<void> => Promise.resolve();

export class HostStartupError extends Error {
    public readonly state = "failed" as const;
    public readonly reasonCode = "host.startup_failed" as const;

    public constructor(cause: unknown) {
        super("Production Host failed to start", { cause });
        this.name = "HostStartupError";
    }
}

export function launchProductionHost(options: ProductionHostLaunchOptions): ProductionHost {
    return launchProductionHostForTest(options, process.platform);
}

/** @internal Preserve real Core/Host composition while substituting only physical host and process ownership. */
export function launchProductionHostForTest(
    options: ProductionHostLaunchOptions,
    hostPlatform: NodeJS.Platform,
    createRestricted: typeof createProductionSelectedWslProbes = createProductionSelectedWslProbes,
    createRestrictedTargets: typeof createProductionSelectedWslTargets = createProductionSelectedWslTargets,
    createRestrictedSources: typeof createProductionSelectedWslSources = createProductionSelectedWslSources,
): ProductionHost {
    const renderApprovalAuthority = createHostRenderApprovalAuthority();
    let host: ProductionHost;
    const useRestricted = hostPlatform === "win32";
    const restricted = useRestricted
        ? createRestricted(options.platformContexts, options.oaamRoot, () => host.hostInstanceId)
        : undefined;
    const restrictedTargets = useRestricted
        ? createRestrictedTargets(options.platformContexts, options.oaamRoot, () => host.hostInstanceId)
        : undefined;
    const restrictedSources = useRestricted
        ? createRestrictedSources(options.platformContexts, options.oaamRoot, () => host.hostInstanceId)
        : undefined;
    const configuration: CoreServiceConfiguration = {
        providers: [...BUILTIN_PROVIDERS],
        platformContexts: options.platformContexts.map((context) => ({ ...context })),
        oaamRoot: options.oaamRoot,
        confirmOneTimeRenderApproval: (input) => renderApprovalAuthority.confirmOneTimeApproval(input),
        ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
        ...(restricted === undefined ? {} : { selectedWslProbeExecution: restricted.execution }),
        ...(restrictedTargets === undefined ? {} : { selectedWslTargetExecution: restrictedTargets.execution }),
        ...(restrictedSources === undefined ? {} : { selectedWslSourceExecution: restrictedSources.execution }),
    };
    const stateResilience = createStateResilienceIntegration(configuration, options);
    try {
        reconcileStateRestoreBeforeStartup({
            oaamRoot: configuration.oaamRoot,
            ...(configuration.databasePath === undefined ? {} : { databasePath: configuration.databasePath }),
        });
        const core = createCoreService(configuration);
        host = createProductionHost(
            core,
            stateResilience,
            async () => {
                const released = await Promise.allSettled([
                    restricted?.close(),
                    restrictedTargets?.close(),
                    restrictedSources?.close(),
                ]);
                const failures = released.filter((result): result is PromiseRejectedResult => result.status === "rejected");
                if (failures.length === 1) throw failures[0]!.reason;
                if (failures.length > 0)
                    throw new AggregateError(
                        failures.map((failure) => failure.reason),
                        "restricted process cleanup was not confirmed",
                    );
                core.shutdownProcessState();
            },
            new HostOperationalDiagnostics(configuration.oaamRoot),
            renderApprovalAuthority,
        );
        return host;
    } catch (error) {
        if (error instanceof StateProfileRecoveryRequiredError) {
            return createStateRecoveryHost(stateResilience, error.reason, new HostOperationalDiagnostics(configuration.oaamRoot));
        }
        throw new HostStartupError(error);
    }
}

function createStateResilienceIntegration(
    configuration: CoreServiceConfiguration,
    options: ProductionHostLaunchOptions,
): HostStateResilienceIntegration {
    const restoreService = (quiesceMutations: () => Promise<void>) =>
        createStateRestoreService({
            oaamRoot: configuration.oaamRoot,
            ...(configuration.databasePath === undefined ? {} : { databasePath: configuration.databasePath }),
            quiesceMutations,
        });
    return {
        readDesktopPreferences: async () => options.desktopPreferences?.read(),
        inspectStateRestore: (input) => restoreService(inspectionDoesNotQuiesce).inspectStateRestore(input),
        activateStateRestore: (input, control) => restoreService(() => control.quiesceMutations()).activateStateRestore(input),
        async applyRestoredDesktopPreferences(bytes, restoreTransactionPath) {
            if (options.desktopPreferences === undefined) {
                throw new Error("This Host has no Desktop preference owner");
            }
            await options.desktopPreferences.applyRestored(bytes, restoreTransactionPath);
        },
        restoreRequiresHostReplacement: options.restoreRequiresHostReplacement ?? (() => undefined),
    };
}

/** @internal Exact production composition evidence; not exported from the package barrel. */
export function listProductionProviderIdsForTest(): readonly string[] {
    return Object.freeze(BUILTIN_PROVIDERS.map((provider) => provider.adapterId));
}
