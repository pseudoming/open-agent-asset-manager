import type { AdapterProbeResult, OperationDiagnostic, SourceRoot } from "@oaam/core";
import * as crypto from "node:crypto";

export interface OpenCodeInstallationCandidate {
    readonly path: string;
    readonly source: "user_selected" | "explicit_override" | "path" | "home_default";
}

export function emptyObservation(item: OperationDiagnostic): AdapterProbeResult["observation"] {
    return {
        observedAgentRuntimes: [runtimeUnknown("OPENCODE_CLI", item), runtimeUnknown("OPENCODE_APP", item)],
        sourceRoots: [],
        agentRuntimeResources: [],
        observedProjects: [],
        targetCandidates: [],
    };
}

function runtimeUnknown(
    agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP",
    item: OperationDiagnostic,
): AdapterProbeResult["observation"]["observedAgentRuntimes"][number] {
    return {
        agentRuntimeId,
        versionText: "",
        installationEvidence: [],
        sourceRootIds: [],
        agentRuntimeResourceIds: [],
        observedProjectIds: [],
        installationStatus: "unknown",
        projectDiscoveryStatus: "unknown",
        diagnostics: [item],
    };
}

export function addSourceRoot(roots: Map<string, SourceRoot>, root: SourceRoot): string {
    roots.set(root.sourceRootId, root);
    return root.sourceRootId;
}

export function deduplicateCandidates(values: OpenCodeInstallationCandidate[]): OpenCodeInstallationCandidate[] {
    const seen = new Set<string>();
    return values.filter((value) => {
        if (seen.has(value.path)) return false;
        seen.add(value.path);
        return true;
    });
}

export function stableId(namespace: string, value: string): string {
    return `${namespace}:${crypto.createHash("sha256").update(`${namespace}\0${value}`, "utf8").digest("hex")}`;
}
