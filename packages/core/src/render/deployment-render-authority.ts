/** Stable Deployment render-authority facade. */

export type {
    FinalizeDeploymentResidualAuthorityInput,
    FinalizeTargetFileRenderProvenanceInput,
} from "./deployment-render-authority-codec";
export {
    finalizeDeploymentResidualAuthority,
    finalizeTargetFileRenderProvenance,
    makeRemovalIntentFingerprint,
    parseAppliedInputsSnapshot,
    parseAppliedRenderSnapshot,
    parseAppliedRenderSnapshotRef,
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthority,
    parseDeploymentResidualAuthorityRow,
    projectDeploymentFileAuthority,
    serializeAppliedInputsSnapshot,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
    serializeDeploymentResidualAuthority,
    serializeDeploymentResidualAuthorityBody,
    validateAppliedInputsSnapshot,
} from "./deployment-render-authority-codec";
export {
    validateAppliedRenderSnapshot,
    validateAppliedRenderSnapshotRef,
    validateDeploymentFileBaselineState,
    validateDeploymentResidualAuthority,
    validateTargetFileRenderProvenance,
} from "./deployment-render-authority-validation";
