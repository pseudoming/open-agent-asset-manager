import { ProtocolDiagnostics, type DesktopMessageId, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice, WorkbenchTechnicalFact } from "../../ui";
import type { InspectionDetailView, InspectionSummaryView } from "./catalog-deployment-model";

const CHANGE_MESSAGES = {
    asset_type_data_replacement: "catalog.product.inspection.change.metadata",
    file_content_replacement: "catalog.product.inspection.change.content",
    file_deletion: "catalog.product.inspection.change.deleted",
    file_executable_replacement: "catalog.product.inspection.change.executable",
    file_addition: "catalog.product.inspection.change.added",
} as const satisfies Record<string, DesktopMessageId>;

const ATTRIBUTION_MESSAGES = {
    uniquely_attributable: "catalog.product.inspection.attribution.unique",
    whole_file_adoption_required: "catalog.product.inspection.attribution.whole_file",
    conflict: "catalog.product.inspection.attribution.conflict",
} as const satisfies Record<string, DesktopMessageId>;

export function inspectionDetailLabel(
    detail: InspectionSummaryView["details"][number],
    text: (id: DesktopMessageId) => string,
): string {
    return detail.detailKind === "semantic_change" && Object.hasOwn(CHANGE_MESSAGES, detail.displayName)
        ? text(CHANGE_MESSAGES[detail.displayName as keyof typeof CHANGE_MESSAGES])
        : detail.displayName;
}

/** Combine an unambiguous file attribution/content pair while retaining both selectors. */
export function groupInspectionFileDetails(details: InspectionSummaryView["details"]): InspectionSummaryView["details"][] {
    const used = new Set<string>();
    return details.flatMap((detail) => {
        if (used.has(detail.selector)) return [];
        const matches = details.filter((candidate) => candidate.displayName === detail.displayName);
        if (matches.length === 2 && matches[0]?.detailKind !== matches[1]?.detailKind) {
            matches.forEach((candidate) => {
                used.add(candidate.selector);
            });
            return [matches.sort((left) => (left.detailKind === "semantic_change" ? -1 : 1))];
        }
        used.add(detail.selector);
        return [[detail]];
    });
}

export interface CatalogInspectionDetailProps {
    readonly detail: InspectionDetailView;
}

export function CatalogInspectionDetail({ detail }: CatalogInspectionDetailProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const technicalFields =
        detail.detailKind === "semantic_change" ? (
            <>
                <code>{text("catalog.product.technical.inspection_token", { token: detail.inspectionToken })}</code>
                <code>{text("catalog.product.technical.selector", { selector: detail.selector })}</code>
                <code>
                    {text("catalog.product.technical.change_fingerprint", {
                        fingerprint: detail.changeFingerprint,
                    })}
                </code>
            </>
        ) : (
            <>
                <code>{text("catalog.product.technical.inspection_token", { token: detail.inspectionToken })}</code>
                <code>{text("catalog.product.technical.selector", { selector: detail.selector })}</code>
                <code>
                    {text("catalog.product.technical.attribution_state", {
                        state: detail.attributionState,
                    })}
                </code>
                {detail.reasonCode === undefined ? null : (
                    <code>{text("catalog.product.technical.reason", { reason: detail.reasonCode })}</code>
                )}
            </>
        );

    if (detail.detailKind === "file_attribution") {
        return (
            <article className="inspection-detail">
                <strong>{text("catalog.product.inspection.file", { path: detail.relativePath })}</strong>
                <ProtocolDiagnostics
                    diagnostics={detail.diagnostics}
                    layout="grouped"
                    singleItemContext
                    technicalSummary={text("import.ui.technical_details")}
                />
                <WorkbenchTechnicalFact
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_inspection_detail.001"
                    fact={<p>{text(ATTRIBUTION_MESSAGES[detail.attributionState])}</p>}
                    summary={text("import.ui.technical_details")}
                >
                    {technicalFields}
                </WorkbenchTechnicalFact>
                {detail.attributionState === "whole_file_adoption_required" ? (
                    <WorkbenchNotice>{text("catalog.ui.reverse.whole_file_adoption")}</WorkbenchNotice>
                ) : null}
            </article>
        );
    }

    return (
        <article className="inspection-detail">
            <WorkbenchTechnicalFact
                data-oaam-interaction-entry="features.catalog-deployment.catalog_inspection_detail.002"
                fact={<strong>{text(CHANGE_MESSAGES[detail.changeKind])}</strong>}
                summary={text("import.ui.technical_details")}
            >
                {detail.content === undefined ? null : (
                    <>
                        <code>
                            {text("import.ui.technical.media_type", {
                                mediaType: detail.content.mediaType,
                            })}
                        </code>
                        <code>
                            {text("import.ui.technical.content_hash", {
                                contentHash: detail.content.contentHash,
                            })}
                        </code>
                    </>
                )}
                {technicalFields}
            </WorkbenchTechnicalFact>
            {detail.content?.contentKind === "text" ? (
                <>
                    <p>{text("catalog.product.inspection.text")}</p>
                    <pre>{detail.content.text.text}</pre>
                    {detail.content.text.truncated ? (
                        <WorkbenchNotice>{text("catalog.product.inspection.text_truncated")}</WorkbenchNotice>
                    ) : null}
                </>
            ) : detail.content?.contentKind === "binary" ? (
                <p>{text("catalog.product.inspection.binary", { bytes: detail.content.byteLength })}</p>
            ) : null}
        </article>
    );
}
