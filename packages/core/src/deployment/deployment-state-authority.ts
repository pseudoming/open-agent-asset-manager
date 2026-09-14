/** Stable Deployment database-state authority facade. */

export type {
    CanonicalDeploymentPreCommitDatabaseStateV1,
    CommitReverseAcceptSuccessCrashDurableInput,
    CommitReverseAcceptSuccessCrashDurableResult,
    CommitReverseAcceptVersionSelectionSuccessCrashDurableInput,
    DeploymentFileBaselinePostconditionEntryV1,
    DeploymentSuccessPostconditionV1,
    PreparedDeploymentSuccessAuthorityV1,
    ReverseAcceptDeploymentAssetVersionTransitionV1,
} from "./deployment-state-authority-model";
export {
    readCanonicalDeploymentPreCommitDatabaseState,
    readCanonicalDeploymentPreCommitDatabaseStateFromConnection,
    readDeploymentSuccessPostcondition,
} from "./deployment-state-authority-projection";
export {
    commitReverseAcceptSuccessCrashDurable,
    commitReverseAcceptSuccessCrashDurableForTest,
    commitReverseAcceptVersionSelectionSuccessCrashDurable,
    commitReverseAcceptVersionSelectionSuccessCrashDurableForTest,
    prepareDeploymentSuccessAuthority,
    prepareReverseAcceptDeploymentSuccessAuthority,
} from "./deployment-state-authority-commit";
export {
    validateCanonicalDeploymentPreCommitDatabaseStateForTest,
    validateDeploymentCommitReceiptReadbackForTest,
    validateDeploymentSuccessPostcondition,
} from "./deployment-state-authority-validation";
