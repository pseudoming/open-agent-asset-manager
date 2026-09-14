/** Applied render-contract classification for scope-bound Rule reverse staging. */

import type { AdapterRenderContractDeclarationV1 } from "../contracts/source-import";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";

type AppliedRuleReverseDeclaration = Extract<
    AdapterRenderContractDeclarationV1,
    { declarationKind: "native_project_rule_v1" | "native_global_rule_v1" | "native_project_exact_file_v1" }
>;

export function appliedRuleReverseContractKind(
    inspected: DeploymentInspectionAuthorityV1,
    decision: DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"][number],
): "native_project_rule_v1" | "native_global_rule_v1" | "native_project_exact_file_v1" | "unknown" {
    if (
        !Array.isArray(inspected.appliedRenderSnapshot.outputUnits) ||
        !Array.isArray(inspected.appliedRenderSnapshot.outputUnitRenderers) ||
        !Array.isArray(decision.outputUnitFingerprints)
    ) {
        return "unknown";
    }
    const outputUnits = inspected.appliedRenderSnapshot.outputUnits.filter((unit) =>
        decision.outputUnitFingerprints.includes(unit.outputUnitFingerprint),
    );
    if (outputUnits.length !== 1) return "unknown";
    const outputUnit = outputUnits[0] as (typeof outputUnits)[number];
    const renderers = inspected.appliedRenderSnapshot.outputUnitRenderers.filter(
        (renderer) => renderer.outputUnitFingerprint === outputUnit.outputUnitFingerprint,
    );
    if (renderers.length !== 1) return "unknown";
    const renderer = renderers[0] as (typeof renderers)[number];
    const owner = inspected.operation.registry.getProvider(decision.consumerOwnerAdapterId);
    const outputContract = inspected.operation.registry.getOutputContract(outputUnit.outputContractId);
    if (
        owner === null ||
        owner.version !== decision.consumerOwnerAdapterVersion ||
        renderer.rendererAdapterId !== owner.adapterId ||
        renderer.rendererAdapterVersion !== owner.version ||
        outputContract === null ||
        outputContract.outputContractFingerprint !== outputUnit.outputContractFingerprint ||
        !outputContract.materializationProfiles.some(
            (profile) =>
                profile.materializationProfileId === renderer.materializationProfileId &&
                profile.profileConstraintFingerprint === renderer.profileConstraintFingerprint,
        )
    ) {
        return "unknown";
    }
    const declarations = owner.renderContractDeclarations.filter(
        (declaration): declaration is AppliedRuleReverseDeclaration =>
            declaration.agentRuntimeId === decision.semanticRef.consumerAgentRuntimeId &&
            declaration.outputContractId === outputUnit.outputContractId &&
            declaration.materializationProfileId === renderer.materializationProfileId &&
            (declaration.declarationKind === "native_project_rule_v1" ||
                declaration.declarationKind === "native_global_rule_v1" ||
                (declaration.declarationKind === "native_project_exact_file_v1" && declaration.assetKind === "Rule")),
    );
    if (declarations.length !== 1) return "unknown";
    const [declaration] = declarations as [AppliedRuleReverseDeclaration];
    return declaration.declarationKind;
}
