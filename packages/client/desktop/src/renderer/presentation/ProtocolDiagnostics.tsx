import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { ReactNode } from "react";
import type { DesktopDisplayText, DesktopMessageId } from "../../presentation/localization";
import { WorkbenchNotice, type WorkbenchNoticeTone, WorkbenchTechnicalFact } from "../ui";
import { useDesktopPresentation } from "./PresentationContext";
import {
    type ProtocolDiagnosticPresentation,
    presentProtocolDiagnostic,
    protocolDiagnosticIdentity,
    uniqueProtocolDiagnostics,
} from "./protocol-diagnostics";

export interface ProtocolDiagnosticsProps {
    readonly attribution?: DesktopDisplayText;
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly layout?: "individual" | "grouped" | "technical";
    readonly embedded?: boolean;
    readonly operationMessage?: DesktopDisplayText;
    /** The parent identifies one inspected item and its outcome; batch feedback leaves this false. */
    readonly singleItemContext?: boolean;
    readonly technicalSummary?: string;
}

const GENERIC_OPERATION_SUMMARIES = new Set<DesktopMessageId>([
    "discovery.product.diagnostic.internal_error",
    "discovery.product.diagnostic.unknown",
    "discovery.product.diagnostic.verification_failed",
    "discovery.product.diagnostic.partial",
]);

function isRoutineManagedSourceOmission(diagnostic: ProtocolDiagnosticV1): boolean {
    return (
        diagnostic.code === "read.managed_source_entry_ignored" &&
        diagnostic.operation === "read" &&
        diagnostic.severity === "info" &&
        !diagnostic.retryable &&
        diagnostic.suggestedActions.length === 0
    );
}

function DiagnosticSurface({
    embedded,
    tone,
    children,
}: {
    readonly embedded: boolean;
    readonly tone: WorkbenchNoticeTone;
    readonly children: ReactNode;
}): React.JSX.Element {
    return embedded || tone === "note" ? (
        <div className="protocol-diagnostic-cause">{children}</div>
    ) : (
        <WorkbenchNotice surface="inline" tone={tone}>
            {children}
        </WorkbenchNotice>
    );
}

/** One operation owns its result and causes; a cause is not a second competing alert. */
export function ProtocolFeedbackNotice({
    message,
    diagnostics,
    tone = "note",
}: {
    readonly message: DesktopDisplayText;
    readonly diagnostics: readonly ProtocolDiagnosticV1[];
    readonly tone?: WorkbenchNoticeTone;
}): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    if (tone === "note" && diagnostics.length === 0) {
        return (
            <p className="workbench-status-copy" role="status">
                {displayText(message)}
            </p>
        );
    }
    return (
        <WorkbenchNotice tone={tone} role={tone === "danger" ? "alert" : "status"}>
            <ProtocolDiagnostics
                embedded
                diagnostics={diagnostics}
                operationMessage={message}
                technicalSummary={text("import.ui.technical_details")}
            />
        </WorkbenchNotice>
    );
}

export function ProtocolDiagnostics({
    attribution,
    diagnostics,
    layout = "individual",
    embedded = false,
    operationMessage,
    singleItemContext = false,
    technicalSummary,
}: ProtocolDiagnosticsProps): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    if (diagnostics.length === 0) return operationMessage === undefined ? null : <p>{displayText(operationMessage)}</p>;
    const unique = uniqueProtocolDiagnostics(diagnostics);
    const diagnosticPresentations = unique.map((diagnostic) => ({
        diagnostic,
        presentation: presentProtocolDiagnostic(diagnostic),
    }));
    const technicalDetails = (diagnostic: ProtocolDiagnosticV1, presentation: ProtocolDiagnosticPresentation) => (
        <div className="protocol-technical-record" key={protocolDiagnosticIdentity(diagnostic)}>
            <code>
                {text("discovery.product.technical.code", {
                    identity: presentation.technicalIdentity,
                })}
            </code>
            {diagnostic.path === undefined ? null : (
                <code>
                    {text("discovery.product.technical.path", {
                        path: diagnostic.path,
                    })}
                </code>
            )}
            {diagnostic.traceId === undefined ? null : (
                <code>
                    {text("discovery.product.technical.trace", {
                        trace: diagnostic.traceId,
                    })}
                </code>
            )}
            <p>
                {text("discovery.product.technical.raw_message", {
                    message: presentation.rawMessage,
                })}
            </p>
        </div>
    );

    if (layout === "technical") {
        return (
            <WorkbenchTechnicalFact
                data-oaam-interaction-entry="presentation.protocol_diagnostics.003"
                fact={null}
                summary={technicalSummary ?? text("import.ui.technical_details")}
            >
                {diagnosticPresentations.map(({ diagnostic, presentation }) => technicalDetails(diagnostic, presentation))}
            </WorkbenchTechnicalFact>
        );
    }
    if (layout === "grouped" || operationMessage !== undefined) {
        // An operation already states what failed. Generic fallbacks add no cause or usable action;
        // retain their full records in the same disclosure instead of restating the failure.
        const visiblePresentations = diagnosticPresentations
            .map(({ diagnostic, presentation }) => {
                const routineManagedOmission = isRoutineManagedSourceOmission(diagnostic);
                const summaryAlreadyStated =
                    operationMessage !== undefined &&
                    (JSON.stringify(presentation.summary) === JSON.stringify(operationMessage) ||
                        (presentation.summary.kind === "localized" &&
                            (presentation.summary.id === "discovery.product.diagnostic.internal_error" ||
                                presentation.summary.id === "discovery.product.diagnostic.unknown" ||
                                presentation.summary.id === "discovery.product.diagnostic.verification_failed")));
                const partialExplainedBySpecificCause =
                    singleItemContext &&
                    presentation.summary.kind === "localized" &&
                    presentation.summary.id === "discovery.product.diagnostic.partial" &&
                    diagnosticPresentations.some(
                        ({ diagnostic: other, presentation: otherPresentation }) =>
                            !isRoutineManagedSourceOmission(other) &&
                            other.operation === diagnostic.operation &&
                            (other.path === undefined || diagnostic.path === undefined || other.path === diagnostic.path) &&
                            (other.traceId === undefined ||
                                diagnostic.traceId === undefined ||
                                other.traceId === diagnostic.traceId) &&
                            otherPresentation.summary.kind === "localized" &&
                            !GENERIC_OPERATION_SUMMARIES.has(otherPresentation.summary.id),
                    );
                const buildExplainedByInstallation =
                    singleItemContext &&
                    (diagnostic.code.endsWith("_app_target_build_evidence_unavailable") ||
                        diagnostic.code.endsWith("_cli_target_build_evidence_unavailable")) &&
                    diagnostic.causeKind === "partial" &&
                    diagnostic.severity !== "error" &&
                    unique.some(
                        (other) =>
                            other.code ===
                                diagnostic.code.replace(
                                    /_target_build_evidence_unavailable$/u,
                                    diagnostic.code.endsWith("_cli_target_build_evidence_unavailable")
                                        ? "_version_not_observed"
                                        : "_install_environment_unobserved",
                                ) &&
                            other.causeKind === "partial" &&
                            other.operation === diagnostic.operation &&
                            (other.path === undefined || diagnostic.path === undefined || other.path === diagnostic.path) &&
                            (other.traceId === undefined ||
                                diagnostic.traceId === undefined ||
                                other.traceId === diagnostic.traceId),
                    );
                const absenceExplainedByInstallation =
                    singleItemContext &&
                    operationMessage?.kind === "localized" &&
                    operationMessage.id === "catalog.ui.usage.detail.not_installed" &&
                    diagnostic.causeKind === "not_found" &&
                    presentation.summary.kind === "localized" &&
                    presentation.summary.id === "discovery.product.diagnostic.not_found";
                const conversionReviewAlreadyExplained =
                    singleItemContext &&
                    diagnostic.code === "render.canonical_conversion_review_required" &&
                    (unique.some((other) => other.operation === "render" && other.severity === "error") ||
                        (operationMessage?.kind === "localized" &&
                            [
                                "catalog.ui.usage.detail.transformed_absent",
                                "catalog.ui.usage.detail.transformed_different",
                                "catalog.ui.usage.detail.substitute_absent",
                                "catalog.ui.usage.detail.substitute_different",
                            ].includes(operationMessage.id)));
                return {
                    summary:
                        routineManagedOmission ||
                        summaryAlreadyStated ||
                        partialExplainedBySpecificCause ||
                        buildExplainedByInstallation ||
                        absenceExplainedByInstallation ||
                        conversionReviewAlreadyExplained
                            ? undefined
                            : presentation.summary,
                    nextAction:
                        routineManagedOmission ||
                        conversionReviewAlreadyExplained ||
                        (operationMessage !== undefined &&
                            presentation.nextAction?.kind === "localized" &&
                            presentation.nextAction.id === "discovery.product.action.review_again")
                            ? undefined
                            : presentation.nextAction,
                };
            })
            .filter((presentation) => presentation.summary !== undefined || presentation.nextAction !== undefined);
        const uniquePresentations = [
            ...new Map(
                visiblePresentations.map((presentation) => [
                    JSON.stringify([presentation.summary, presentation.nextAction]),
                    presentation,
                ]),
            ).values(),
        ];
        const summaryPresentations = uniquePresentations.filter((presentation) => presentation.summary !== undefined);
        const inlineActions = [
            ...new Map(
                uniquePresentations
                    .filter(
                        (presentation) =>
                            presentation.summary === undefined &&
                            presentation.nextAction !== undefined &&
                            !summaryPresentations.some(
                                (summary) => JSON.stringify(summary.nextAction) === JSON.stringify(presentation.nextAction),
                            ),
                    )
                    .map((presentation) => [JSON.stringify(presentation.nextAction), presentation.nextAction]),
            ).values(),
        ].filter((action): action is DesktopDisplayText => action !== undefined);
        const displayedAttribution =
            attribution ??
            (operationMessage === undefined && !singleItemContext
                ? diagnosticPresentations[0]?.presentation.attribution
                : undefined);
        const tone = diagnosticPresentations.some(({ presentation }) => presentation.tone === "warning") ? "warning" : "note";
        const nextActions = new Map<string, number>();
        summaryPresentations.forEach((presentation, index) => {
            if (presentation.nextAction === undefined) return;
            const identity = JSON.stringify(presentation.nextAction);
            if (!nextActions.has(identity)) nextActions.set(identity, index);
        });
        return (
            <div className="protocol-diagnostic-list" data-oaam-diagnostic-layout="grouped">
                <DiagnosticSurface embedded={embedded} tone={tone}>
                    {displayedAttribution === undefined ? null : (
                        <strong className="protocol-diagnostic-attribution">{displayText(displayedAttribution)}</strong>
                    )}
                    <WorkbenchTechnicalFact
                        data-oaam-interaction-entry="presentation.protocol_diagnostics.001"
                        disclosureClassName="protocol-technical-disclosure"
                        fact={
                            <>
                                {operationMessage === undefined && inlineActions.length === 0 ? null : (
                                    <p>
                                        {[
                                            ...(operationMessage === undefined ? [] : [displayText(operationMessage)]),
                                            ...inlineActions.map((action) => displayText(action)),
                                        ].join(" ")}
                                    </p>
                                )}
                                {summaryPresentations.length === 0 ? null : (
                                    <ul className="protocol-diagnostic-summary-list">
                                        {summaryPresentations.map((presentation, index) => (
                                            <li key={JSON.stringify([presentation.summary, presentation.nextAction])}>
                                                {presentation.summary === undefined ? null : (
                                                    <span>{displayText(presentation.summary)}</span>
                                                )}
                                                {presentation.nextAction === undefined ||
                                                nextActions.get(JSON.stringify(presentation.nextAction)) !== index ? null : (
                                                    <small>{displayText(presentation.nextAction)}</small>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </>
                        }
                        summary={technicalSummary ?? text("discovery.product.source.details")}
                    >
                        {diagnosticPresentations.map(({ diagnostic, presentation }) =>
                            technicalDetails(diagnostic, presentation),
                        )}
                    </WorkbenchTechnicalFact>
                </DiagnosticSurface>
            </div>
        );
    }
    const presentationGroups = new Map<
        string,
        { identity: string; presentation: ProtocolDiagnosticPresentation; records: typeof diagnosticPresentations }
    >();
    for (const entry of diagnosticPresentations) {
        const presentation = entry.presentation;
        const identity = JSON.stringify([
            displayText(attribution ?? presentation.attribution),
            displayText(presentation.summary),
            presentation.nextAction === undefined ? "" : displayText(presentation.nextAction),
            presentation.tone,
        ]);
        const existing = presentationGroups.get(identity);
        if (existing === undefined) presentationGroups.set(identity, { identity, presentation, records: [entry] });
        else existing.records.push(entry);
    }
    return (
        <div className="protocol-diagnostic-list" data-oaam-diagnostic-layout="individual">
            {[...presentationGroups.values()].map(({ identity, presentation, records }) => {
                const displayedAttribution = attribution ?? presentation.attribution;
                return (
                    <DiagnosticSurface embedded={embedded} key={identity} tone={presentation.tone}>
                        <strong className="protocol-diagnostic-attribution">{displayText(displayedAttribution)}</strong>
                        <WorkbenchTechnicalFact
                            data-oaam-interaction-entry="presentation.protocol_diagnostics.002"
                            disclosureClassName="protocol-technical-disclosure"
                            fact={
                                <>
                                    <p>{displayText(presentation.summary)}</p>
                                    {presentation.nextAction === undefined ? null : (
                                        <small>{displayText(presentation.nextAction)}</small>
                                    )}
                                </>
                            }
                            summary={technicalSummary ?? text("discovery.product.source.details")}
                        >
                            {records.map(({ diagnostic, presentation: recordPresentation }) =>
                                technicalDetails(diagnostic, recordPresentation),
                            )}
                        </WorkbenchTechnicalFact>
                    </DiagnosticSurface>
                );
            })}
        </div>
    );
}
