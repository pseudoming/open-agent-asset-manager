/** Internal deployment-inspection failure taxonomy shared by capture and orchestration. */

export class DeploymentInspectionFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: "not_found" | "unavailable" | "conflict" | "unsupported" | "invalid_schema",
        readonly retryable: boolean,
    ) {
        super(message);
    }
}

export function deploymentInspectionFailure(
    code: string,
    message: string,
    causeKind: DeploymentInspectionFailure["causeKind"],
    retryable: boolean,
): DeploymentInspectionFailure {
    return new DeploymentInspectionFailure(code, message, causeKind, retryable);
}
