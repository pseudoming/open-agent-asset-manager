import { computeSourceCapabilityFingerprint } from "../../../src/adapters/adapter-contract-validator";
import type { AdapterId, AdapterProbeResult, AdapterProvider, AgentRuntimeId, PlatformContext, UuidV4 } from "../../../src/types";
import { makeContractProvider } from "../../adapters/fixtures/adapter-contract-fixtures";

export const WATCHED_ADAPTER_ID = "WATCHED_SERVICE" as AdapterId;
export const WATCHED_RUNTIME_ID = "WATCHED_SERVICE_CLI" as AgentRuntimeId;
export const WATCHED_LINUX_CONTEXT: PlatformContext = {
    platform: "linux",
    platformInstanceId: "local",
    accessRootPath: "/",
};
export const WATCHED_PROJECT_ID = "00000000-0000-4000-8000-000000000321" as UuidV4;

export function availableWatchedProbe(
    overrides: Partial<AdapterProbeResult["observation"]["sourceRoots"][number]> = {},
): AdapterProbeResult {
    const root = {
        sourceRootId: "watched-root",
        rootRole: "source" as const,
        sourceDomain: "agent_runtime_private" as const,
        path: "/home/user/.watched",
        accessStatus: "available" as const,
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule" as const,
                locatorKey: "watched-default",
                evidenceLevel: "agent_runtime_verified" as const,
            },
        ],
        diagnostics: [],
        ...overrides,
    };
    return {
        status: "complete",
        observation: {
            observedAgentRuntimes: [
                {
                    agentRuntimeId: WATCHED_RUNTIME_ID,
                    versionText: "1.0.0",
                    installationEvidence: [
                        {
                            kind: "executable",
                            path: "/usr/bin/watched",
                            evidenceLevel: "agent_runtime_verified",
                            diagnostics: [],
                        },
                    ],
                    sourceRootIds: [root.sourceRootId],
                    agentRuntimeResourceIds: [],
                    observedProjectIds: [],
                    installationStatus: "available",
                    projectDiscoveryStatus: "not_found",
                    diagnostics: [],
                },
            ],
            sourceRoots: [root],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [],
    };
}

export function makeWatchedProvider(
    probeResult = availableWatchedProbe(),
    userSelectedSupport = true,
    readPolicy: "user_selected_root_only" | "auto_read" = "user_selected_root_only",
): AdapterProvider {
    const candidate = makeContractProvider(WATCHED_ADAPTER_ID, probeResult);
    if (userSelectedSupport) {
        const guidance = candidate.assetSourceCapabilities.find((row) => row.assetKind === "Guidance");
        if (guidance === undefined) throw new Error("watched fixture requires the Guidance source capability");
        Object.assign(guidance, {
            entrySupportStatus: "supported",
            rootLocatorKind: "user_provided_path",
            rootRole: "source",
            sourceDomain: "external_managed",
            sourcePathMechanism: "directory_entry",
            evidenceLevel: "agent_runtime_verified",
            readPolicy,
            diagnostics: [],
        });
        guidance.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(candidate, guidance) as string;
    }
    return candidate;
}
