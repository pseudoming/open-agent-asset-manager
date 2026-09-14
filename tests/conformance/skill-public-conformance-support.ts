/** Offline target facts and explicit expected-loss checks for the existing public Skill journeys. */
import { expect } from "vitest";
import { computeTargetApplicabilityFingerprint } from "../../packages/core/src/foundation/fingerprint-render";
import type {
    AdapterProvider,
    AgentRuntimeId,
    RenderAnalysisView,
    RenderSelectionRequest,
    RenderDegradationKind,
} from "../../packages/core/src/types";

export function fixtureProjectSkillTargetContext(provider: AdapterProvider, agentRuntimeId: AgentRuntimeId) {
    const declaration = provider.renderContractDeclarations.find(
        (d) =>
            d.declarationKind === "native_project_exact_graph_v1" &&
            d.agentRuntimeId === agentRuntimeId &&
            d.assetKind === "Skill",
    );
    if (!declaration || declaration.declarationKind !== "native_project_exact_graph_v1")
        throw new Error("Missing Skill declaration");
    const build = declaration.verifiedBuilds.find((b) => b.platform === "wsl")!;
    const schema = provider.targetContextSchemas.find(
        (s) => s.targetContextSchemaId === declaration.target.targetContextSchemaId,
    )!;
    const descriptor = provider.agentRuntimes.find((d) => d.agentRuntimeId === agentRuntimeId)!;
    const renderFacts = [
        { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" as const },
        ...Object.entries(declaration.target.requiredFacts).map(([key, value]) => ({
            key,
            value,
            evidenceLevel: "agent_runtime_verified" as const,
        })),
    ].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const preimage = {
        schemaVersion: 1 as const,
        agentRuntimeId: build.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts,
    };
    return {
        ...preimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: preimage,
            entryClass: descriptor.entryClass,
        }),
    };
}
export function approvedSkillSelection(
    analysis: RenderAnalysisView,
    expectedLosses: readonly RenderDegradationKind[],
): RenderSelectionRequest {
    const options = analysis.analyses.flatMap((item) => item.semanticOptions);
    return {
        schemaVersion: 1,
        renderInputFingerprint: analysis.renderInputFingerprint,
        semanticOptions: analysis.requiredSemantics.map((semantic) => {
            const matches = options.filter((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint);
            if (matches.length !== 1) throw new Error("Expected one disclosed canonical conversion option");
            const option = matches[0]!;
            expect(option.outcome).toBe(expectedLosses.length ? "degraded" : "preserved");
            if (option.outcome === "degraded") expect(option.degradationKinds).toEqual(expectedLosses);
            expect(option.approvalRequirement.approvalState).toBe(expectedLosses.length ? "required" : "not_required");
            return {
                optionFingerprint: option.optionFingerprint,
                approvalRequest:
                    matches[0]!.outcome === "degraded"
                        ? { approvalAction: "approve_once" as const, userActionId: "approve-disclosed-foreign-conversion" }
                        : { approvalAction: "none" as const },
            };
        }),
    };
}
export function requireComplete<T extends { status: string; diagnostics: unknown[] }>(
    result: T,
    label: string,
): asserts result is T & { status: "complete" } {
    expect(result.status, `${label}: ${JSON.stringify(result.diagnostics)}`).toBe("complete");
}
