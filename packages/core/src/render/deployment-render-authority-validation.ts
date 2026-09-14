/** Strict Deployment render-authority structural and fingerprint validators. */

import type {
    AppliedRenderApprovalEvidence,
    AppliedRenderDecisionV1,
    AppliedRenderSnapshotRefV1,
    AppliedRenderSnapshotV1,
    DeploymentFileBaselineStateV1,
    DeploymentFileObservationV1,
    DeploymentResidualRenderAuthorityV1,
    DeploymentResidualAuthorityBodyV1,
    DurableAppliedPayloadRefV1,
    MaterializationSemanticCoverageProof,
    RemovalIntentFingerprintInputV1,
    RenderOutputUnit,
    RenderSemanticSubject,
    RenderedSectionBinding,
    RequiredRenderSemantic,
    ResolvedPromotionAuthorization,
    SelectedOutputUnitRenderer,
    TargetFileRenderProvenanceV1,
} from "../contracts/deployment-authority";
import type { Sha256Digest } from "../contracts/primitives";
import {
    computeDeploymentResidualAuthorityFingerprint,
    computeDeploymentResidualAuthorityId,
    computeRenderOutputUnitFingerprint,
    computeSemanticRefFingerprint,
    computeTargetFileRenderProvenanceFingerprint,
} from "../foundation/fingerprint";
import { isNonNegativeInteger } from "../foundation/validators";
import type { FinalizeDeploymentResidualAuthorityInput } from "./deployment-render-authority-codec";
import {
    requireArray,
    requireBoolean,
    requireEpoch,
    requireExactKeys,
    requireFingerprint,
    requireNonBlank,
    requireObject,
    requireOneOf,
    requirePath,
    requirePositiveInteger,
    requireSameOrderedKeys,
    requireSortedUnique,
    requireUuid,
} from "./render-validation-primitives";

export {
    prettyCanonicalJson,
    requireArray,
    requireBoolean,
    requireEpoch,
    requireExactKeys,
    requireFingerprint,
    requireNonBlank,
    requireObject,
    requireOneOf,
    requirePath,
    requirePositiveInteger,
    requireSameOrderedKeys,
    requireSortedUnique,
    requireUuid,
} from "./render-validation-primitives";

const SEMANTIC_KINDS = [
    "asset.file_inventory",
    "guidance.base_context",
    "guidance.content",
    "rule.activation",
    "rule.content",
    "workflow.activation",
    "workflow.content",
    "workflow.reference",
    "skill.discovery_metadata",
    "skill.body",
    "skill.resource",
    "subagent.delegation_metadata",
    "subagent.invoked_context",
    "subagent.resource",
    "subagent.tool_boundary",
    "subagent.model_hint",
    "memory.support",
    "memory.content",
] as const;

const STRATEGIES = [
    "native_file",
    "native_directory",
    "native_graph",
    "native_import",
    "inline",
    "reference_with_intro",
] as const;

const DEGRADATIONS = [
    "target_runtime_missing_asset_kind",
    "trigger_or_loading_level_lost",
    "workflow_trigger_lost",
    "workflow_permission_lost",
    "workflow_runtime_lost",
    "workflow_variable_lost",
    "permission_or_tool_boundary_lost",
    "folder_asset_flattened",
    "memory_semantics_lost",
    "runtime_specific_metadata_lost",
    "reverse_extract_pollution_risk",
] as const;

const REVERSE_POLICIES = ["can_reconcile", "ignore_generated_wrapper", "unsupported"] as const;

export function validateAppliedRenderSnapshot(value: unknown): asserts value is AppliedRenderSnapshotV1 {
    const object = requireObject(value, "AppliedRenderSnapshot");
    if (object.snapshotState === "never") {
        requireExactKeys(object, ["schemaVersion", "snapshotState"], "AppliedRenderSnapshot.never");
        if (object.schemaVersion !== 1) throw new Error("snapshot schemaVersion must be 1");
        return;
    }
    if (object.snapshotState !== "applied") {
        throw new Error("snapshotState must be never|applied");
    }
    requireExactKeys(
        object,
        [
            "schemaVersion",
            "snapshotState",
            "renderInputFingerprint",
            "compilerPolicyVersion",
            "selectionFingerprint",
            "compilationFingerprint",
            "promotionAuthorizations",
            "decisions",
            "outputUnits",
            "outputUnitRenderers",
            "semanticCoverageProofs",
        ],
        "AppliedRenderSnapshot.applied",
    );
    if (object.schemaVersion !== 1) throw new Error("snapshot schemaVersion must be 1");
    requireFingerprint(object.renderInputFingerprint, "renderInputFingerprint");
    if (object.compilerPolicyVersion !== "core_render_policy_v1") {
        throw new Error("compilerPolicyVersion is invalid");
    }
    requireFingerprint(object.selectionFingerprint, "selectionFingerprint");
    requireFingerprint(object.compilationFingerprint, "compilationFingerprint");

    const authorizations = requireArray(object.promotionAuthorizations, "promotionAuthorizations");
    authorizations.forEach(validatePromotionAuthorization);
    requireSortedUnique(authorizations, promotionAuthorizationKey, "promotionAuthorizations");

    const decisions = requireArray(object.decisions, "decisions");
    decisions.forEach(validateAppliedRenderDecision);
    requireSortedUnique(decisions, (item) => (item as AppliedRenderDecisionV1).semanticRef.semanticRefFingerprint, "decisions");

    const outputUnits = requireArray(object.outputUnits, "outputUnits");
    outputUnits.forEach(validateRenderOutputUnit);
    requireSortedUnique(outputUnits, (item) => (item as RenderOutputUnit).outputUnitFingerprint, "outputUnits");

    const renderers = requireArray(object.outputUnitRenderers, "outputUnitRenderers");
    renderers.forEach(validateSelectedRenderer);
    requireSortedUnique(renderers, (item) => (item as SelectedOutputUnitRenderer).outputUnitFingerprint, "outputUnitRenderers");

    const proofs = requireArray(object.semanticCoverageProofs, "semanticCoverageProofs");
    proofs.forEach(validateCoverageProof);
    requireSortedUnique(
        proofs,
        (item) => (item as MaterializationSemanticCoverageProof).outputUnitFingerprint,
        "semanticCoverageProofs",
    );

    const unitIds = outputUnits.map((item) => (item as RenderOutputUnit).outputUnitFingerprint);
    requireSameOrderedKeys(
        unitIds,
        renderers.map((item) => (item as SelectedOutputUnitRenderer).outputUnitFingerprint),
        "output unit renderer closure",
    );
    requireSameOrderedKeys(
        unitIds,
        proofs.map((item) => (item as MaterializationSemanticCoverageProof).outputUnitFingerprint),
        "semantic coverage closure",
    );
    const unitSet = new Set(unitIds);
    for (const decision of decisions as AppliedRenderDecisionV1[]) {
        if (decision.outputUnitFingerprints.some((fingerprint) => !unitSet.has(fingerprint))) {
            throw new Error("decision references an unknown output unit");
        }
    }
}

export function validateAppliedRenderSnapshotRef(value: unknown): asserts value is AppliedRenderSnapshotRefV1 {
    const object = requireObject(value, "AppliedRenderSnapshotRef");
    if (object.snapshotState === "never") {
        requireExactKeys(object, ["snapshotState"], "AppliedRenderSnapshotRef.never");
        return;
    }
    if (object.snapshotState === "applied") {
        requireExactKeys(object, ["snapshotState", "snapshotFingerprint"], "AppliedRenderSnapshotRef.applied");
        requireFingerprint(object.snapshotFingerprint, "snapshotFingerprint");
        return;
    }
    throw new Error("snapshot reference state must be never|applied");
}

export function validateTargetFileRenderProvenance(value: unknown): asserts value is TargetFileRenderProvenanceV1 {
    const object = requireObject(value, "TargetFileRenderProvenance");
    requireExactKeys(
        object,
        [
            "schemaVersion",
            "provenanceFingerprint",
            "appliedRenderSnapshotFingerprint",
            "outputUnitFingerprint",
            "materializationFingerprint",
            "semanticRefFingerprints",
            "sectionBindings",
        ],
        "TargetFileRenderProvenance",
    );
    if (object.schemaVersion !== 1) throw new Error("provenance schemaVersion must be 1");
    requireFingerprint(object.provenanceFingerprint, "provenanceFingerprint");
    requireFingerprint(object.appliedRenderSnapshotFingerprint, "appliedRenderSnapshotFingerprint");
    requireFingerprint(object.outputUnitFingerprint, "outputUnitFingerprint");
    requireFingerprint(object.materializationFingerprint, "materializationFingerprint");
    const semanticRefs = requireArray(object.semanticRefFingerprints, "semanticRefFingerprints");
    semanticRefs.forEach((item) => {
        requireFingerprint(item, "semanticRefFingerprint");
    });
    requireSortedUnique(semanticRefs, (item) => item as string, "semanticRefFingerprints");
    const bindings = requireArray(object.sectionBindings, "sectionBindings");
    bindings.forEach(validateSectionBinding);
    requireSortedUnique(bindings, (item) => (item as RenderedSectionBinding).sectionHandle, "sectionBindings");
    const semanticSet = new Set(semanticRefs as Sha256Digest[]);
    for (const binding of bindings as RenderedSectionBinding[]) {
        if (binding.semanticRefFingerprints.some((fingerprint) => !semanticSet.has(fingerprint))) {
            throw new Error("section binding references a semantic outside file provenance");
        }
    }
    const { provenanceFingerprint: _stored, ...preimage } = object as unknown as TargetFileRenderProvenanceV1;
    if (computeTargetFileRenderProvenanceFingerprint(preimage) !== object.provenanceFingerprint) {
        throw new Error("file provenance fingerprint mismatch");
    }
}

export function validateDeploymentResidualAuthority(value: unknown): asserts value is DeploymentResidualRenderAuthorityV1 {
    const object = requireObject(value, "DeploymentResidualRenderAuthority");
    requireExactKeys(
        object,
        [
            "schemaVersion",
            "residualAuthorityId",
            "residualAuthorityFingerprint",
            "deploymentId",
            "relativePath",
            "appliedPayload",
            "appliedExecutable",
            "previousProvenance",
            "removalIntentFingerprint",
        ],
        "DeploymentResidualRenderAuthority",
    );
    validateResidualPreimage(object as unknown as FinalizeDeploymentResidualAuthorityInput);
    requireFingerprint(object.residualAuthorityId, "residualAuthorityId");
    requireFingerprint(object.residualAuthorityFingerprint, "residualAuthorityFingerprint");
    const {
        residualAuthorityId: _id,
        residualAuthorityFingerprint: _fingerprint,
        ...preimage
    } = object as unknown as DeploymentResidualRenderAuthorityV1;
    if (computeDeploymentResidualAuthorityId(preimage) !== object.residualAuthorityId) {
        throw new Error("residual authority ID mismatch");
    }
    const withId = { ...preimage, residualAuthorityId: object.residualAuthorityId };
    if (computeDeploymentResidualAuthorityFingerprint(withId) !== object.residualAuthorityFingerprint) {
        throw new Error("residual authority fingerprint mismatch");
    }
}

export function validateDeploymentFileBaselineState(value: unknown): asserts value is DeploymentFileBaselineStateV1 {
    const object = requireObject(value, "DeploymentFileBaselineState");
    if (object.rowState === "active") {
        requireExactKeys(
            object,
            ["rowState", "appliedPayload", "appliedExecutable", "provenance"],
            "DeploymentFileBaselineState.active",
        );
        validatePayloadRef(object.appliedPayload);
        requireBoolean(object.appliedExecutable, "appliedExecutable");
        validateTargetFileRenderProvenance(object.provenance);
        return;
    }
    if (object.rowState === "removed") {
        requireExactKeys(object, ["rowState", "latestResidualAuthorityId"], "DeploymentFileBaselineState.removed");
        requireFingerprint(object.latestResidualAuthorityId, "latestResidualAuthorityId");
        return;
    }
    throw new Error("baseline rowState must be active|removed");
}

export function validateResidualPreimage(value: FinalizeDeploymentResidualAuthorityInput): void {
    if (value.schemaVersion !== 1) throw new Error("residual schemaVersion must be 1");
    requireUuid(value.deploymentId, "deploymentId");
    requirePath(value.relativePath, "relativePath");
    validatePayloadRef(value.appliedPayload);
    requireBoolean(value.appliedExecutable, "appliedExecutable");
    validateTargetFileRenderProvenance(value.previousProvenance);
    requireFingerprint(value.removalIntentFingerprint, "removalIntentFingerprint");
}

export function validateResidualBody(value: unknown): asserts value is DeploymentResidualAuthorityBodyV1 {
    const object = requireObject(value, "DeploymentResidualAuthorityBody");
    requireExactKeys(
        object,
        ["schemaVersion", "appliedPayload", "appliedExecutable", "previousProvenance", "removalIntentFingerprint"],
        "DeploymentResidualAuthorityBody",
    );
    if (object.schemaVersion !== 1) throw new Error("residual body schemaVersion must be 1");
    validatePayloadRef(object.appliedPayload);
    requireBoolean(object.appliedExecutable, "appliedExecutable");
    validateTargetFileRenderProvenance(object.previousProvenance);
    requireFingerprint(object.removalIntentFingerprint, "removalIntentFingerprint");
}

export function validateRemovalIntent(value: RemovalIntentFingerprintInputV1): void {
    requireExactKeys(
        value as unknown as Record<string, unknown>,
        ["deploymentId", "relativePath", "previousProvenanceFingerprint", "nextCompilationFingerprint", "reason"],
        "RemovalIntent",
    );
    requireUuid(value.deploymentId, "deploymentId");
    requirePath(value.relativePath, "relativePath");
    requireFingerprint(value.previousProvenanceFingerprint, "previousProvenanceFingerprint");
    requireFingerprint(value.nextCompilationFingerprint, "nextCompilationFingerprint");
    if (value.reason !== "absent_from_new_desired_set") {
        throw new Error("removal intent reason is invalid");
    }
}

export function validateRequiredSemantic(value: unknown): asserts value is RequiredRenderSemantic {
    const object = requireObject(value, "RequiredRenderSemantic");
    requireExactKeys(
        object,
        ["semanticRefFingerprint", "consumerAgentRuntimeId", "subject", "semanticKind"],
        "RequiredRenderSemantic",
    );
    requireFingerprint(object.semanticRefFingerprint, "semanticRefFingerprint");
    requireNonBlank(object.consumerAgentRuntimeId, "consumerAgentRuntimeId");
    validateSemanticSubject(object.subject);
    requireOneOf(object.semanticKind, SEMANTIC_KINDS, "semanticKind");
    const { semanticRefFingerprint: _stored, ...preimage } = object as unknown as RequiredRenderSemantic;
    if (computeSemanticRefFingerprint(preimage) !== object.semanticRefFingerprint) {
        throw new Error("semantic ref fingerprint mismatch");
    }
}

export function validateSemanticSubject(value: unknown): asserts value is RenderSemanticSubject {
    const object = requireObject(value, "RenderSemanticSubject");
    if (object.subjectKind === "asset") {
        requireExactKeys(object, ["subjectKind", "assetId", "versionId"], "semantic asset subject");
        requireUuid(object.assetId, "subject.assetId");
        requireUuid(object.versionId, "subject.versionId");
        return;
    }
    if (object.subjectKind === "file") {
        requireExactKeys(object, ["subjectKind", "assetId", "versionId", "fileId"], "semantic file subject");
        requireUuid(object.assetId, "subject.assetId");
        requireUuid(object.versionId, "subject.versionId");
        requireUuid(object.fileId, "subject.fileId");
        return;
    }
    if (object.subjectKind === "missing_required_file_role") {
        requireExactKeys(object, ["subjectKind", "assetId", "versionId", "fileRole"], "semantic missing-file subject");
        requireUuid(object.assetId, "subject.assetId");
        requireUuid(object.versionId, "subject.versionId");
        if (object.fileRole !== "entry") throw new Error("missing required file role must be entry");
        return;
    }
    throw new Error("semantic subjectKind is invalid");
}

export function validatePromotionAuthorization(value: unknown): asserts value is ResolvedPromotionAuthorization {
    const object = requireObject(value, "ResolvedPromotionAuthorization");
    const common = ["promotionAuthorizationState", "assetId", "versionId", "target", "versionOriginAuthorityFingerprint"];
    if (object.promotionAuthorizationState === "not_required") {
        requireExactKeys(object, common, "promotion authorization not_required");
    } else if (object.promotionAuthorizationState === "authorized") {
        requireExactKeys(
            object,
            [...common, "authorizationSource", "authorityId", "authorityRevision", "authorityFingerprint"],
            "promotion authorization authorized",
        );
        requireOneOf(
            object.authorizationSource,
            ["version_target_grant", "asset_all_versions_target_grant", "restricted_source_full_access"] as const,
            "authorizationSource",
        );
        requireNonBlank(object.authorityId, "authorityId");
        requirePositiveInteger(object.authorityRevision, "authorityRevision");
        requireFingerprint(object.authorityFingerprint, "authorityFingerprint");
    } else {
        throw new Error("promotionAuthorizationState is invalid");
    }
    requireUuid(object.assetId, "authorization.assetId");
    requireUuid(object.versionId, "authorization.versionId");
    validatePromotionTarget(object.target);
    requireFingerprint(object.versionOriginAuthorityFingerprint, "versionOriginAuthorityFingerprint");
}

export function validatePromotionTarget(value: unknown): void {
    const object = requireObject(value, "PromotionGrantTarget");
    if (object.targetKind === "project") {
        requireExactKeys(object, ["targetKind", "projectId"], "project target");
        requireUuid(object.projectId, "target.projectId");
        return;
    }
    if (object.targetKind === "global_target") {
        requireExactKeys(object, ["targetKind", "targetAuthorityFingerprint"], "global target");
        requireFingerprint(object.targetAuthorityFingerprint, "targetAuthorityFingerprint");
        return;
    }
    throw new Error("promotion targetKind is invalid");
}

export function validateAppliedRenderDecision(value: unknown): asserts value is AppliedRenderDecisionV1 {
    const object = requireObject(value, "AppliedRenderDecision");
    const base = [
        "semanticRef",
        "consumerOwnerAdapterId",
        "consumerOwnerAdapterVersion",
        "optionFingerprint",
        "renderStrategy",
        "approval",
        "actualReverseExtractPolicy",
        "outputUnitFingerprints",
        "outcome",
    ];
    if (object.outcome === "preserved") {
        requireExactKeys(object, base, "preserved render decision");
    } else if (object.outcome === "degraded") {
        requireExactKeys(object, [...base, "degradationKinds", "degradationFingerprint"], "degraded render decision");
        const kinds = requireArray(object.degradationKinds, "degradationKinds");
        if (kinds.length === 0) throw new Error("degradationKinds must be non-empty");
        kinds.forEach((item) => {
            requireOneOf(item, DEGRADATIONS, "degradationKind");
        });
        requireSortedUnique(kinds, (item) => item as string, "degradationKinds");
        requireFingerprint(object.degradationFingerprint, "degradationFingerprint");
    } else {
        throw new Error("render decision outcome must be preserved|degraded");
    }
    validateRequiredSemantic(object.semanticRef);
    requireNonBlank(object.consumerOwnerAdapterId, "consumerOwnerAdapterId");
    requireNonBlank(object.consumerOwnerAdapterVersion, "consumerOwnerAdapterVersion");
    requireFingerprint(object.optionFingerprint, "optionFingerprint");
    requireOneOf(object.renderStrategy, STRATEGIES, "renderStrategy");
    validateApproval(object.approval);
    requireOneOf(object.actualReverseExtractPolicy, REVERSE_POLICIES, "actualReverseExtractPolicy");
    const unitFingerprints = requireArray(object.outputUnitFingerprints, "outputUnitFingerprints");
    unitFingerprints.forEach((item) => {
        requireFingerprint(item, "outputUnitFingerprint");
    });
    requireSortedUnique(unitFingerprints, (item) => item as string, "outputUnitFingerprints");
}

export function validateApproval(
    value: unknown,
): asserts value is AppliedRenderApprovalEvidence | { approvalState: "not_required" } {
    const object = requireObject(value, "AppliedRenderApprovalEvidence");
    if (object.approvalState === "not_required") {
        requireExactKeys(object, ["approvalState"], "approval not_required");
        return;
    }
    if (object.approvalState !== "approved") throw new Error("approvalState is invalid");
    if (object.approvalSource === "one_time_user_approval") {
        requireExactKeys(
            object,
            ["approvalState", "approvalSource", "userActionEvidenceId", "resolvedAt", "approvalFingerprint"],
            "one-time approval",
        );
        requireNonBlank(object.userActionEvidenceId, "userActionEvidenceId");
    } else if (object.approvalSource === "saved_user_policy") {
        requireExactKeys(
            object,
            ["approvalState", "approvalSource", "policyId", "policyRevision", "resolvedAt", "approvalFingerprint"],
            "saved-policy approval",
        );
        requireNonBlank(object.policyId, "policyId");
        requirePositiveInteger(object.policyRevision, "policyRevision");
    } else {
        throw new Error("approvalSource is invalid");
    }
    requireEpoch(object.resolvedAt, "resolvedAt");
    requireFingerprint(object.approvalFingerprint, "approvalFingerprint");
}

export function validateRenderOutputUnit(value: unknown): asserts value is RenderOutputUnit {
    const object = requireObject(value, "RenderOutputUnit");
    requireExactKeys(
        object,
        ["outputUnitFingerprint", "outputContractId", "outputContractFingerprint", "claims", "managedDirectoryBoundaries"],
        "RenderOutputUnit",
    );
    requireFingerprint(object.outputUnitFingerprint, "outputUnitFingerprint");
    requireNonBlank(object.outputContractId, "outputContractId");
    requireFingerprint(object.outputContractFingerprint, "outputContractFingerprint");
    const claims = requireArray(object.claims, "claims");
    claims.forEach((claim) => {
        const item = requireObject(claim, "RenderOutputClaim");
        requireExactKeys(item, ["relativePath", "contentKind", "executable"], "RenderOutputClaim");
        requirePath(item.relativePath, "claim.relativePath");
        requireOneOf(item.contentKind, ["text", "binary"] as const, "contentKind");
        requireBoolean(item.executable, "claim.executable");
    });
    requireSortedUnique(claims, (item) => (item as { relativePath: string }).relativePath, "claims");
    const boundaries = requireArray(object.managedDirectoryBoundaries, "managedDirectoryBoundaries");
    boundaries.forEach((boundary) => {
        const item = requireObject(boundary, "RenderManagedDirectoryBoundary");
        if (item.schemaVersion === 2) {
            requireExactKeys(
                item,
                ["schemaVersion", "relativePath", "boundaryKind", "desiredDirectoryPaths"],
                "RenderManagedDirectoryBoundaryV2",
            );
            const desired = requireArray(item.desiredDirectoryPaths, "desiredDirectoryPaths");
            desired.forEach((path) => {
                requirePath(path, "desiredDirectoryPath");
            });
            requireSortedUnique(desired, (path) => path as string, "desiredDirectoryPaths");
            if (
                !desired.includes(item.relativePath) ||
                desired.some(
                    (path) => path !== item.relativePath && !(path as string).startsWith(`${String(item.relativePath)}/`),
                )
            ) {
                throw new Error("desiredDirectoryPaths must be the exact graph below its managed boundary");
            }
        } else {
            requireExactKeys(item, ["relativePath", "boundaryKind"], "RenderManagedDirectoryBoundary");
        }
        requirePath(item.relativePath, "boundary.relativePath");
        if (item.boundaryKind !== "directory_inventory") throw new Error("boundaryKind is invalid");
    });
    requireSortedUnique(boundaries, (item) => (item as { relativePath: string }).relativePath, "managedDirectoryBoundaries");
    const { outputUnitFingerprint: _stored, ...preimage } = object as unknown as RenderOutputUnit;
    if (computeRenderOutputUnitFingerprint(preimage) !== object.outputUnitFingerprint) {
        throw new Error("output unit fingerprint mismatch");
    }
}

export function validateSelectedRenderer(value: unknown): asserts value is SelectedOutputUnitRenderer {
    const object = requireObject(value, "SelectedOutputUnitRenderer");
    requireExactKeys(
        object,
        [
            "outputUnitFingerprint",
            "rendererAdapterId",
            "rendererAdapterVersion",
            "materializerCapabilityKey",
            "materializationProfileId",
            "profileConstraintFingerprint",
        ],
        "SelectedOutputUnitRenderer",
    );
    requireFingerprint(object.outputUnitFingerprint, "outputUnitFingerprint");
    requireNonBlank(object.rendererAdapterId, "rendererAdapterId");
    requireNonBlank(object.rendererAdapterVersion, "rendererAdapterVersion");
    requireNonBlank(object.materializerCapabilityKey, "materializerCapabilityKey");
    requireNonBlank(object.materializationProfileId, "materializationProfileId");
    requireFingerprint(object.profileConstraintFingerprint, "profileConstraintFingerprint");
}

export function validateCoverageProof(value: unknown): asserts value is MaterializationSemanticCoverageProof {
    const object = requireObject(value, "MaterializationSemanticCoverageProof");
    requireExactKeys(
        object,
        ["outputUnitFingerprint", "coveredSemanticRefFingerprints", "coverageFingerprint"],
        "MaterializationSemanticCoverageProof",
    );
    requireFingerprint(object.outputUnitFingerprint, "outputUnitFingerprint");
    const refs = requireArray(object.coveredSemanticRefFingerprints, "coveredSemanticRefFingerprints");
    refs.forEach((item) => {
        requireFingerprint(item, "coveredSemanticRefFingerprint");
    });
    requireSortedUnique(refs, (item) => item as string, "coveredSemanticRefFingerprints");
    requireFingerprint(object.coverageFingerprint, "coverageFingerprint");
}

export function validateSectionBinding(value: unknown): asserts value is RenderedSectionBinding {
    const object = requireObject(value, "RenderedSectionBinding");
    requireExactKeys(object, ["sectionHandle", "semanticRefFingerprints"], "RenderedSectionBinding");
    requireNonBlank(object.sectionHandle, "sectionHandle");
    const refs = requireArray(object.semanticRefFingerprints, "section semantic refs");
    refs.forEach((item) => {
        requireFingerprint(item, "section semantic ref");
    });
    requireSortedUnique(refs, (item) => item as string, "section semantic refs");
}

export function validatePayloadRef(value: unknown): asserts value is DurableAppliedPayloadRefV1 {
    const object = requireObject(value, "DurableAppliedPayloadRef");
    requireExactKeys(object, ["contentKind", "contentHash", "byteSize"], "DurableAppliedPayloadRef");
    requireOneOf(object.contentKind, ["text", "binary"] as const, "payload contentKind");
    requireFingerprint(object.contentHash, "payload contentHash");
    if (!isNonNegativeInteger(object.byteSize)) throw new Error("payload byteSize must be non-negative integer");
}

export function validateObservation(value: unknown): asserts value is DeploymentFileObservationV1 {
    const object = requireObject(value, "DeploymentFileObservation");
    if (object.observedState === "missing") {
        requireExactKeys(object, ["observedState"], "missing observation");
        return;
    }
    if (object.observedState === "present") {
        requireExactKeys(object, ["observedState", "observedContentHash", "observedExecutable"], "present observation");
        requireFingerprint(object.observedContentHash, "observedContentHash");
        requireBoolean(object.observedExecutable, "observedExecutable");
        return;
    }
    throw new Error("observedState must be present|missing");
}

export function promotionAuthorizationKey(value: unknown): string {
    const authorization = value as ResolvedPromotionAuthorization;
    const targetKey =
        authorization.target.targetKind === "project"
            ? `project:${authorization.target.projectId}`
            : `global:${authorization.target.targetAuthorityFingerprint}`;
    return `${authorization.assetId}\0${authorization.versionId}\0${targetKey}`;
}
