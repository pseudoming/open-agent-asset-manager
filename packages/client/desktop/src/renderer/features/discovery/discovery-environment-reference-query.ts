import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import type { ProbeEnvironmentReferenceView } from "./discovery-model";

export interface DiscoveryEnvironmentReferenceQuery {
    readonly references: readonly ProbeEnvironmentReferenceView[];
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
}

export function clearEnvironmentReferenceReview<T extends object>(state: T) {
    return {
        ...state,
        probeReview: undefined,
        probeProgress: undefined,
        environmentReferences: Object.freeze([] as ProbeEnvironmentReferenceView[]),
    };
}

export async function queryEnvironmentReferences(
    client: DesktopApplicationClientApi,
    probeToken: string,
): Promise<DiscoveryEnvironmentReferenceQuery> {
    if (!client.supportsOperation("probe_environment_reference.list")) {
        return { references: Object.freeze([]), diagnostics: Object.freeze([]) };
    }
    const outcome = await client.listProbeEnvironmentReferences({ probeToken });
    return {
        references: Object.freeze(outcome.status === "failed" ? [] : [...outcome.value.references]),
        diagnostics: Object.freeze([...outcome.diagnostics]),
    };
}
