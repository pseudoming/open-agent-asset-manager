import { useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton, WorkbenchNotice, WorkbenchPressedFilter } from "../../ui";
import { CatalogInspectionDetail, inspectionDetailLabel, groupInspectionFileDetails } from "./CatalogInspectionDetail";
import type { CatalogDeploymentController } from "./catalog-deployment-controller";
import { catalogDeploymentFailurePresentationState, type DeploymentInspectionState } from "./catalog-deployment-state";

export function CatalogDeploymentInspectionReview({
    controller,
    inspection: selectedInspection,
    interactionLocked,
    stale,
    canRepair,
    canReviewConflict,
}: {
    readonly controller: CatalogDeploymentController;
    readonly inspection: Extract<DeploymentInspectionState, { readonly status: "ready" }>;
    readonly interactionLocked: boolean;
    readonly stale: boolean;
    readonly canRepair: boolean;
    readonly canReviewConflict: boolean;
}): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const fileDetails = groupInspectionFileDetails(selectedInspection.value.details);
    const selectedSelector =
        selectedInspection.detail.status === "ready"
            ? selectedInspection.detail.value.selector
            : selectedInspection.detail.status === "none"
              ? undefined
              : selectedInspection.detail.selector;
    const selectedGroup = fileDetails.find((group) => group.some((detail) => detail.selector === selectedSelector));
    return (
        <div className="inspection-summary">
            <div className="inspection-summary-heading">
                <h3>{text("catalog.ui.inspection.title")}</h3>
                <p>
                    {text(
                        selectedInspection.value.changeCount === 1
                            ? "catalog.ui.inspection.change_count.one"
                            : "catalog.ui.inspection.change_count.many",
                        { count: selectedInspection.value.changeCount },
                    )}{" "}
                    ·{" "}
                    {text(
                        selectedInspection.value.conflictCount === 1
                            ? "catalog.ui.inspection.conflict_count.one"
                            : "catalog.ui.inspection.conflict_count.many",
                        { count: selectedInspection.value.conflictCount },
                    )}
                </p>
            </div>
            {selectedInspection.value.details.length === 0 ? null : (
                <section className="inspection-detail-navigation">
                    <h4>{text("catalog.ui.inspection.details_title")}</h4>
                    <ul className="inspection-detail-actions">
                        {fileDetails.map((members) => {
                            const detail = members[0]!;
                            const name = inspectionDetailLabel(detail, text);
                            const action = text(
                                detail.detailKind === "file_attribution"
                                    ? "catalog.ui.inspection.file_detail"
                                    : "catalog.ui.inspection.change_detail",
                            );
                            return (
                                <li className="inspection-detail-row" key={detail.selector}>
                                    <div>
                                        <strong className="inspection-detail-name" title={name}>
                                            {name}
                                        </strong>
                                        <small>{action}</small>
                                    </div>
                                    <WorkbenchIconButton
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.021"
                                        icon="preview"
                                        label={`${action}: ${name}`}
                                        tooltip={action}
                                        disabled={interactionLocked}
                                        aria-pressed={members.some((candidate) => candidate.selector === selectedSelector)}
                                        onClick={() => void controller.loadInspectionDetail(detail.selector)}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}
            {selectedInspection.value.detailsTruncated ? (
                <WorkbenchNotice>{text("catalog.ui.inspection.details_omitted")}</WorkbenchNotice>
            ) : null}
            {selectedInspection.detail.status === "loading" ? (
                <WorkbenchNotice surface="inline" role="status">
                    {text("catalog.ui.inspection.detail_loading")}
                </WorkbenchNotice>
            ) : null}
            {selectedInspection.detail.status === "failed" ? (
                <WorkbenchNotice
                    tone="danger"
                    role="alert"
                    data-oaam-operation-state={catalogDeploymentFailurePresentationState(selectedInspection.detail.failureKind)}
                >
                    {displayText(selectedInspection.detail.message)}
                </WorkbenchNotice>
            ) : null}
            {selectedGroup !== undefined && selectedGroup.length > 1 ? (
                <fieldset className="detail-actions" aria-label={text("catalog.ui.inspection.details_title")}>
                    {selectedGroup.map((detail) => (
                        <WorkbenchPressedFilter
                            data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_inspection_review.001"
                            key={detail.selector}
                            type="button"
                            disabled={interactionLocked}
                            pressed={detail.selector === selectedSelector}
                            onClick={() => void controller.loadInspectionDetail(detail.selector)}
                        >
                            {text(
                                detail.detailKind === "file_attribution"
                                    ? "catalog.ui.inspection.file_detail"
                                    : "catalog.ui.inspection.change_detail",
                            )}
                        </WorkbenchPressedFilter>
                    ))}
                </fieldset>
            ) : null}
            {selectedInspection.detail.status === "ready" ? (
                <CatalogInspectionDetail detail={selectedInspection.detail.value} />
            ) : null}
            {!canRepair && !canReviewConflict ? null : (
                <section className="inspection-decision-group">
                    <h4>{text("catalog.ui.inspection.actions_title")}</h4>
                    <div className="inspection-decision-list">
                        {canRepair ? (
                            <article>
                                <p>{text("catalog.ui.inspection.repair_copy")}</p>
                                <button
                                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.022"
                                    type="button"
                                    data-oaam-deployment-action="repair"
                                    disabled={interactionLocked || stale}
                                    onClick={() => void controller.repair()}
                                >
                                    {text("catalog.ui.action.repair")}
                                </button>
                            </article>
                        ) : null}
                        {canReviewConflict ? (
                            <article>
                                <p>{text("catalog.ui.inspection.reverse_copy")}</p>
                                <button
                                    data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.023"
                                    type="button"
                                    data-oaam-deployment-action="reverse.prepare"
                                    disabled={interactionLocked || stale}
                                    onClick={() => void controller.prepareReverse()}
                                >
                                    {text("catalog.ui.action.reverse_prepare")}
                                </button>
                            </article>
                        ) : null}
                    </div>
                </section>
            )}
        </div>
    );
}
