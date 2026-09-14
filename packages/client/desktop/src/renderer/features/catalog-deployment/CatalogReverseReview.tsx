import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { useEffect, useMemo, useState } from "react";
import { type DesktopMessageId, ProtocolFeedbackNotice, useDesktopPresentation } from "../../presentation";
import { WorkbenchConfirmation, WorkbenchNotice, WorkbenchTechnicalFact } from "../../ui";
import { type AdapterProviderView } from "../discovery/presentation";
import { CatalogRenderDecisions } from "./CatalogRenderDecisions";
import {
    CatalogRenderOutputSummary,
    CatalogRenderPassiveSingletonSummary,
    catalogRenderReviewIsPassiveSingleton,
} from "./CatalogRenderReviewDetails";
import type { CatalogDeploymentController } from "./catalog-deployment-controller";
import {
    buildRenderSelection,
    includeSingletonRenderSelections,
    projectRenderReview,
    type RenderOptionSelection,
    type AssetSummaryView,
} from "./catalog-deployment-model";
import type { DeploymentReverseState } from "./catalog-deployment-state";

export interface CatalogReverseReviewProps {
    readonly controller: CatalogDeploymentController;
    readonly assets?: readonly AssetSummaryView[];
    readonly reverse: DeploymentReverseState;
    readonly busy: boolean;
    readonly stale: boolean;
    readonly providers: readonly AdapterProviderView[];
    readonly resultSummaryVisible?: boolean;
    readonly activityVisible?: boolean;
    readonly diagnostics?: readonly ProtocolDiagnosticV1[];
}

export function catalogReverseResultMessageId(
    reverse: Extract<DeploymentReverseState, { readonly status: "result" }>,
): DesktopMessageId {
    const result = reverse.value;
    if (result.commitState === "committed") return "catalog.reverse.result.committed";
    if (result.commitState === "recovery_required") return "catalog.reverse.result.recovery_required";
    if (result.commitState === "outcome_unavailable") return "catalog.reverse.result.outcome_unavailable";
    return result.versionPublicationState === "published_not_selected"
        ? "catalog.reverse.result.published_not_selected"
        : "catalog.reverse.result.not_published";
}

export function CatalogReverseResult({
    reverse,
    compact = false,
}: {
    readonly reverse: Extract<DeploymentReverseState, { readonly status: "result" }>;
    readonly compact?: boolean;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const message = <p>{text(catalogReverseResultMessageId(reverse))}</p>;
    return (
        <article
            className={compact ? "reverse-result-details" : "inspection-summary"}
            aria-label={text("catalog.ui.reverse.result_title")}
            data-oaam-reverse-review={`result:${reverse.value.commitState}`}
        >
            {compact ? null : <h3>{text("catalog.ui.reverse.result_title")}</h3>}
            {reverse.value.commitState === "committed" ||
            (reverse.value.commitState === "not_committed" &&
                reverse.value.versionPublicationState === "published_not_selected") ? (
                <WorkbenchTechnicalFact
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_reverse_review.001"
                    fact={message}
                    summary={text("import.ui.technical_details")}
                >
                    <code>{text("import.ui.technical.asset_id", { assetId: reverse.value.version.assetId })}</code>
                    <code>{text("import.ui.technical.version_id", { versionId: reverse.value.version.versionId })}</code>
                </WorkbenchTechnicalFact>
            ) : reverse.value.commitState === "recovery_required" ? (
                <WorkbenchTechnicalFact
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_reverse_review.002"
                    fact={message}
                    summary={text("import.ui.technical_details")}
                >
                    <code>{text("catalog.product.technical.reason", { reason: reverse.value.reasonCode })}</code>
                </WorkbenchTechnicalFact>
            ) : (
                message
            )}
        </article>
    );
}

export function CatalogReverseReview({
    controller,
    assets = [],
    reverse,
    busy,
    stale,
    providers,
    resultSummaryVisible = false,
    activityVisible = false,
    diagnostics = [],
}: CatalogReverseReviewProps): React.JSX.Element | null {
    const { displayText, snapshot, text } = useDesktopPresentation();
    const [selections, setSelections] = useState<readonly RenderOptionSelection[]>([]);
    const [confirmPromotion, setConfirmPromotion] = useState(false);
    const preparationId = reverse.status === "prepared" ? reverse.value.preparationId : "";
    useEffect(() => {
        if (preparationId === "") return;
        setSelections([]);
        setConfirmPromotion(false);
    }, [preparationId]);
    const review = useMemo(
        () => (reverse.status === "prepared" ? projectRenderReview(reverse.value.renderAnalysis) : undefined),
        [reverse],
    );
    const effectiveSelections = review?.status === "ready" ? includeSingletonRenderSelections(review, selections) : selections;
    const validation =
        reverse.status === "prepared"
            ? buildRenderSelection(reverse.value.renderAnalysis, effectiveSelections, "validation-only")
            : undefined;

    if (reverse.status === "none") return null;
    if (reverse.status === "preparing") {
        if (activityVisible) return null;
        return <WorkbenchNotice role="status">{text("catalog.ui.reverse.preparing")}</WorkbenchNotice>;
    }
    if (reverse.status === "not_prepared" || reverse.status === "failed") {
        return <ProtocolFeedbackNotice message={reverse.message} diagnostics={diagnostics} tone="danger" />;
    }
    if (reverse.status === "result") {
        return resultSummaryVisible ? null : <CatalogReverseResult reverse={reverse} />;
    }

    const expiresAt = new Intl.DateTimeFormat(snapshot.resolvedLocale, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(reverse.value.expiresAt);
    const promotionRequired = reverse.value.promotionState === "user_confirmation_required";

    function updateOptions(updates: readonly RenderOptionSelection[]): void {
        const refs = new Set(updates.map((selection) => selection.semanticRefFingerprint));
        setSelections((current) => [...current.filter((selection) => !refs.has(selection.semanticRefFingerprint)), ...updates]);
    }

    return (
        <article className="render-analysis" aria-label={text("catalog.ui.reverse.title")} data-oaam-reverse-review="prepared">
            <h3>{text("catalog.ui.reverse.title")}</h3>
            <p>{text("catalog.ui.reverse.expires", { time: expiresAt })}</p>
            {reverse.message === undefined ? null : (
                <ProtocolFeedbackNotice message={reverse.message} diagnostics={diagnostics} tone="danger" />
            )}
            {review?.status === "invalid" ? (
                <WorkbenchNotice tone="danger" role="alert">
                    {displayText(review.message)}
                </WorkbenchNotice>
            ) : null}
            {review?.status === "ready" ? <CatalogRenderOutputSummary review={review} selections={effectiveSelections} /> : null}
            {review?.status === "ready" && catalogRenderReviewIsPassiveSingleton(review) ? (
                <CatalogRenderPassiveSingletonSummary review={review} target={undefined} providers={providers} />
            ) : review?.status === "ready" ? (
                <CatalogRenderDecisions
                    reverse
                    review={review}
                    assets={assets}
                    selections={effectiveSelections}
                    target={undefined}
                    providers={providers}
                    disabled={busy || stale}
                    onChange={updateOptions}
                />
            ) : null}
            {promotionRequired ? (
                <WorkbenchConfirmation
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_reverse_review.006"
                    data-oaam-reverse-confirm
                    checked={confirmPromotion}
                    disabled={busy || stale}
                    onCheckedChange={setConfirmPromotion}
                >
                    {text("catalog.ui.reverse.confirm_promotion")}
                </WorkbenchConfirmation>
            ) : null}
            {validation?.status === "invalid" ? <WorkbenchNotice>{displayText(validation.message)}</WorkbenchNotice> : null}
            <div className="detail-actions">
                <button
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_reverse_review.007"
                    type="button"
                    data-oaam-deployment-action="reverse.commit"
                    disabled={busy || stale || validation?.status !== "ready" || (promotionRequired && !confirmPromotion)}
                    onClick={() => void controller.commitReverse(effectiveSelections, confirmPromotion)}
                >
                    {text("catalog.ui.action.reverse_commit")}
                </button>
                <button
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_reverse_review.008"
                    type="button"
                    data-oaam-deployment-action="reverse.cancel"
                    disabled={busy}
                    onClick={() => void controller.cancelReverse()}
                >
                    {text("catalog.ui.action.reverse_cancel")}
                </button>
            </div>
        </article>
    );
}
