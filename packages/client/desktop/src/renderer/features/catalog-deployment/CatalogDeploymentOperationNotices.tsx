import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopDisplayText } from "../../presentation";
import { ProtocolDiagnostics, ProtocolFeedbackNotice, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice } from "../../ui";
import { CatalogDeploymentActivityNotice } from "./CatalogAssetUsageRelationships";
import type { CatalogDeploymentActivity, DeploymentReverseState } from "./catalog-deployment-state";

export interface CatalogDeploymentOperationNoticesProps {
    readonly activity: CatalogDeploymentActivity;
    readonly creation: boolean;
    readonly message: DesktopDisplayText | undefined;
    readonly needsSupport: boolean;
    readonly requiresReconciliation: boolean;
    readonly canRecover?: boolean;
    readonly reverse: DeploymentReverseState;
    readonly diagnostics?: readonly ProtocolDiagnosticV1[];
    readonly preparedPlanConsumerAgentRuntimeIds?: readonly string[];
}

export function catalogDeploymentReconciliationPresentation(
    requiresReconciliation: boolean,
    reverse: DeploymentReverseState,
): "none" | "terminal_result" | "outcome_unknown" {
    if (!requiresReconciliation) return "none";
    return reverse.status === "result" ? "terminal_result" : "outcome_unknown";
}

export function CatalogDeploymentOperationNotices({
    activity,
    creation,
    message,
    needsSupport,
    requiresReconciliation,
    canRecover = false,
    reverse,
    diagnostics = [],
    preparedPlanConsumerAgentRuntimeIds,
}: CatalogDeploymentOperationNoticesProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const duplicated =
        message?.kind === "localized" &&
        [
            "catalog.operation.finished",
            "catalog.render.choose_strategies",
            "catalog.preview.ready",
            "catalog.reverse.prepared",
        ].includes(message.id);
    const repeatedReconciliation =
        requiresReconciliation &&
        message?.kind === "localized" &&
        ["catalog.operation.interrupted", "catalog.operation.lost_terminal"].includes(message.id);
    const visibleMessage = creation || duplicated || repeatedReconciliation ? undefined : message;
    const completedReverse =
        reverse.status === "result" && !["recovery_required", "outcome_unavailable"].includes(reverse.value.commitState);
    const unrelatedInstallationAbsences = diagnostics.filter(
        (diagnostic) =>
            preparedPlanConsumerAgentRuntimeIds !== undefined &&
            !preparedPlanConsumerAgentRuntimeIds.includes("CLAUDE_CODE_APP") &&
            diagnostic.code === "claudecode_app_linux_not_found" &&
            diagnostic.operation === "probe" &&
            diagnostic.causeKind === "not_found" &&
            diagnostic.severity !== "error" &&
            !diagnostic.retryable &&
            diagnostic.suggestedActions.length === 0,
    );
    const operationDiagnostics = diagnostics.filter((diagnostic) => !unrelatedInstallationAbsences.includes(diagnostic));
    return (
        <>
            {needsSupport ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {text("catalog.ui.support_required")}
                </WorkbenchNotice>
            ) : null}
            <CatalogDeploymentActivityNotice activity={activity} creation={creation} />
            {canRecover && !requiresReconciliation ? (
                <WorkbenchNotice tone="warning" role="status" data-oaam-recovery-explanation>
                    {text("catalog.ui.outcome.recovery_explanation")}
                </WorkbenchNotice>
            ) : null}
            {requiresReconciliation ? (
                <WorkbenchNotice tone={completedReverse ? "warning" : "danger"} role="alert">
                    <p>
                        {text(
                            reverse.status === "result"
                                ? "catalog.ui.reverse.finish_recovery"
                                : "catalog.ui.reconciliation_required",
                        )}
                    </p>
                    {visibleMessage === undefined ? null : <p>{displayText(visibleMessage)}</p>}
                    <ProtocolDiagnostics embedded diagnostics={operationDiagnostics} />
                </WorkbenchNotice>
            ) : null}
            {requiresReconciliation ? null : visibleMessage === undefined ? (
                <ProtocolDiagnostics diagnostics={operationDiagnostics} />
            ) : (
                <ProtocolFeedbackNotice
                    message={visibleMessage}
                    diagnostics={operationDiagnostics}
                    tone={
                        operationDiagnostics.some((entry) => entry.severity === "error")
                            ? "danger"
                            : operationDiagnostics.some((entry) => entry.severity === "warning")
                              ? "warning"
                              : "note"
                    }
                />
            )}
            <ProtocolDiagnostics diagnostics={unrelatedInstallationAbsences} layout="technical" />
        </>
    );
}
