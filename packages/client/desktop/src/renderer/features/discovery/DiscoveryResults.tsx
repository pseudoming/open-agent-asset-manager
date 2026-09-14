import { useState } from "react";
import { desktopEnvironmentKey } from "../../../desktop-environment-key";
import {
    type DesktopDisplayText,
    ProtocolDiagnostics,
    presentProtocolDiagnostic,
    protocolDiagnosticIdentity,
    technicalText,
    uniqueProtocolDiagnostics,
    useDesktopPresentation,
} from "../../presentation";
import { WorkbenchBadge, WorkbenchDisclosure, WorkbenchIconButton, WorkbenchNotice, WorkbenchTechnicalFact } from "../../ui";
import type { DiscoveryActivity } from "./discovery-controller";
import type { AdapterProviderView, DiscoveryEnvironmentProbeOutcome } from "./discovery-model";
import {
    discoveryProbeStatusMessage,
    discoveryProbeStatusTone,
    discoveryInstallationStatusMessage,
    discoveryInstallationStatusTone,
    discoveryToolOutcomeMessage,
    discoveryToolOutcomeTone,
    presentDiscoveryAgentRuntime,
    presentDiscoveryEnvironment,
    presentDiscoveryPath,
    presentDiscoveryTool,
} from "./discovery-presentation";

export interface DiscoveryResultsProps {
    readonly completedAt: number | undefined;
    readonly outcomes: readonly DiscoveryEnvironmentProbeOutcome[];
    readonly providers: readonly AdapterProviderView[];
    readonly sourceCount: number;
    readonly showEnvironmentDetails?: boolean;
}

export interface DiscoveryProbeIssuesProps {
    readonly outcomes: readonly DiscoveryEnvironmentProbeOutcome[];
    readonly providers: readonly AdapterProviderView[];
    readonly summaryCopy?: string;
}

/** Source-review feedback stays beside the attributed probe results it summarizes. */
export function DiscoverySourceFeedback({
    activity,
    message,
    hasAttributedProbeIssues,
}: {
    readonly activity: DiscoveryActivity;
    readonly message: DesktopDisplayText | undefined;
    readonly hasAttributedProbeIssues: boolean;
}): React.JSX.Element | null {
    const { displayText } = useDesktopPresentation();
    if (activity === "watch_failed") {
        return (
            <WorkbenchNotice tone="danger" role="alert">
                {message === undefined ? "" : displayText(message)}
            </WorkbenchNotice>
        );
    }
    if (
        activity !== "idle" ||
        message === undefined ||
        (hasAttributedProbeIssues && message.kind === "localized" && message.id === "discovery.complete_with_warnings")
    ) {
        return null;
    }
    return (
        <p className="workbench-status-copy" role="status">
            {displayText(message)}
        </p>
    );
}

const ENVIRONMENT_NOTE_SUFFIXES = Object.freeze([
    "_wsl_environment_unobserved",
    "_install_environment_unobserved",
    "_home_path_invalid",
    "_executable_discovery_incomplete",
    "_install_discovery_incomplete",
]);

function isEnvironmentNote(code: string): boolean {
    return ENVIRONMENT_NOTE_SUFFIXES.some((suffix) => code.endsWith(suffix));
}

export function DiscoveryProbeIssues({ outcomes, providers, summaryCopy }: DiscoveryProbeIssuesProps): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    const [pathCopyState, setPathCopyState] = useState<
        { readonly path: string; readonly status: "copied" | "failed" } | undefined
    >();
    async function copyPath(path: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(path);
            setPathCopyState({ path, status: "copied" });
        } catch {
            setPathCopyState({ path, status: "failed" });
        }
    }
    const rows = outcomes.flatMap((outcome) =>
        outcome.tools.flatMap((tool) => {
            const scopes = [
                { key: "tool", agentRuntimeId: undefined, diagnostics: tool.unscopedDiagnostics },
                ...tool.runtimeOutcomes.map((runtime) => ({
                    key: runtime.agentRuntimeId,
                    agentRuntimeId: runtime.agentRuntimeId,
                    diagnostics: runtime.diagnostics,
                })),
            ];
            return scopes.flatMap((scope) => {
                const diagnostics = uniqueProtocolDiagnostics(scope.diagnostics);
                const visibleIssues = [
                    ...new Map(
                        diagnostics.map((diagnostic) => {
                            const presentation = presentProtocolDiagnostic(diagnostic);
                            const path =
                                diagnostic.path === undefined || isEnvironmentNote(diagnostic.code)
                                    ? undefined
                                    : presentDiscoveryPath(diagnostic.path, outcome.environment);
                            const identity = JSON.stringify([
                                path ?? "",
                                path === undefined && presentation.subject !== undefined ? displayText(presentation.subject) : "",
                                displayText(presentation.summary),
                                presentation.nextAction === undefined ? "" : displayText(presentation.nextAction),
                                presentation.tone,
                            ]);
                            return [identity, { diagnostic, path, presentation, identity }] as const;
                        }),
                    ).values(),
                ];
                const explanationGroups = new Map<string, typeof visibleIssues>();
                for (const issue of visibleIssues) {
                    const key = JSON.stringify([
                        issue.path === undefined && issue.presentation.subject !== undefined
                            ? displayText(issue.presentation.subject)
                            : "",
                        displayText(issue.presentation.summary),
                        issue.presentation.nextAction === undefined ? "" : displayText(issue.presentation.nextAction),
                    ]);
                    explanationGroups.set(key, [...(explanationGroups.get(key) ?? []), issue]);
                }
                const groupedIssues = [...explanationGroups.values()].flatMap((group) =>
                    group.map((issue, index) => ({ ...issue, showExplanation: index === 0 })),
                );
                return visibleIssues.length === 0
                    ? []
                    : [
                          {
                              environment: outcome.environment,
                              tool,
                              scopeKey: scope.key,
                              agentRuntimeId: scope.agentRuntimeId,
                              diagnostics,
                              visibleIssues: groupedIssues,
                          },
                      ];
            });
        }),
    );
    if (rows.length === 0) return null;
    const issueCount = rows.reduce((count, row) => count + row.visibleIssues.length, 0);

    return (
        <WorkbenchDisclosure
            data-oaam-interaction-entry="features.discovery.discovery_results.001"
            aria-label={text("discovery.product.scan.issue_title")}
            className="discovery-probe-issues"
            data-oaam-probe-issue-count={issueCount}
            role="region"
            summary={
                <span className="discovery-probe-issue-summary">
                    <span>{text("discovery.product.scan.issue_summary", { count: issueCount })}</span>
                    <small>
                        {summaryCopy ??
                            text(
                                outcomes.some((outcome) => outcome.status !== "complete")
                                    ? "discovery.complete_with_warnings"
                                    : "discovery.product.scan.issue_copy",
                            )}
                    </small>
                </span>
            }
        >
            <ul className="discovery-probe-issue-list">
                {rows.map(({ environment, tool, scopeKey, agentRuntimeId, diagnostics, visibleIssues }) => {
                    const environmentLabel = presentDiscoveryEnvironment(environment);
                    const toolLabel = presentDiscoveryTool(tool.adapterId, providers).label;
                    const scopeLabel =
                        agentRuntimeId === undefined ? toolLabel : presentDiscoveryAgentRuntime(agentRuntimeId, providers).label;
                    return (
                        <li
                            className="discovery-probe-issue"
                            data-oaam-adapter-id={tool.adapterId}
                            data-oaam-agent-runtime-id={agentRuntimeId}
                            data-oaam-environment-identity={JSON.stringify([
                                environment.platform,
                                environment.platformInstanceId,
                            ])}
                            key={`${desktopEnvironmentKey(environment)}\0${tool.adapterId}\0${scopeKey}`}
                        >
                            <WorkbenchTechnicalFact
                                data-oaam-interaction-entry="features.discovery.discovery_results.003"
                                className="discovery-probe-issue-owner"
                                disclosureClassName="discovery-technical-disclosure"
                                fact={
                                    <>
                                        <div className="discovery-probe-issue-scope">
                                            <strong>
                                                {displayText(scopeLabel)} · {displayText(environmentLabel)}
                                            </strong>
                                            {agentRuntimeId === undefined ? null : (
                                                <small>{text("discovery.product.scan.entry_scope")}</small>
                                            )}
                                        </div>
                                        <ul className="discovery-probe-issue-paths">
                                            {visibleIssues.map(({ identity, path, presentation, showExplanation }) =>
                                                path === undefined ? (
                                                    <li data-oaam-diagnostic-path="overall" key={identity}>
                                                        <span className="discovery-probe-overall-issue">
                                                            <strong>
                                                                {displayText(
                                                                    presentation.subject ??
                                                                        ({
                                                                            kind: "localized",
                                                                            id: "discovery.product.scan.tool_check",
                                                                            values: { tool: scopeLabel },
                                                                        } as const),
                                                                )}
                                                            </strong>
                                                            <span>{displayText(presentation.summary)}</span>
                                                            {presentation.nextAction === undefined ? null : (
                                                                <small>{displayText(presentation.nextAction)}</small>
                                                            )}
                                                        </span>
                                                    </li>
                                                ) : (
                                                    <li
                                                        data-oaam-diagnostic-path="location"
                                                        data-oaam-diagnostic-group-start={showExplanation}
                                                        key={identity}
                                                    >
                                                        {showExplanation ? (
                                                            <>
                                                                <span>{displayText(presentation.summary)}</span>
                                                                {presentation.nextAction === undefined ? null : (
                                                                    <small>{displayText(presentation.nextAction)}</small>
                                                                )}
                                                            </>
                                                        ) : null}
                                                        <span className="discovery-probe-issue-path">
                                                            <code title={path}>{path}</code>
                                                            <WorkbenchIconButton
                                                                data-oaam-interaction-entry="features.discovery.discovery_results.002"
                                                                icon="copy"
                                                                label={text(
                                                                    pathCopyState?.path === path
                                                                        ? pathCopyState.status === "copied"
                                                                            ? "discovery.product.scan.path_copied"
                                                                            : "discovery.product.scan.path_copy_failed"
                                                                        : "discovery.product.scan.path_copy",
                                                                )}
                                                                data-oaam-diagnostic-path-copy={
                                                                    pathCopyState?.path === path ? pathCopyState.status : "idle"
                                                                }
                                                                onClick={() => void copyPath(path)}
                                                            />
                                                        </span>
                                                    </li>
                                                ),
                                            )}
                                        </ul>
                                    </>
                                }
                                summary={text("discovery.product.source.details")}
                            >
                                {diagnostics.map((diagnostic) => {
                                    const presentation = presentProtocolDiagnostic(diagnostic);
                                    return (
                                        <div className="protocol-technical-record" key={protocolDiagnosticIdentity(diagnostic)}>
                                            <code>{presentation.technicalIdentity}</code>
                                            {diagnostic.path === undefined ? null : <code>{diagnostic.path}</code>}
                                            <p>{presentation.rawMessage}</p>
                                        </div>
                                    );
                                })}
                            </WorkbenchTechnicalFact>
                        </li>
                    );
                })}
            </ul>
        </WorkbenchDisclosure>
    );
}

export function DiscoveryResults({
    completedAt,
    outcomes,
    providers,
    sourceCount,
    showEnvironmentDetails = true,
}: DiscoveryResultsProps): React.JSX.Element | null {
    const { displayText, snapshot, text } = useDesktopPresentation();
    if (outcomes.length === 0) return null;
    const toolCount = new Set(outcomes.flatMap((outcome) => outcome.tools.map((tool) => tool.adapterId))).size;
    const hasScanNotes = outcomes.some((outcome) => outcome.status !== "complete");
    return (
        <section className="discovery-snapshot" aria-label={text("discovery.ui.environment_results")}>
            <div
                className="discovery-snapshot-summary"
                data-oaam-discovery-location-count={outcomes.length}
                data-oaam-discovery-tool-count={toolCount}
                role="status"
            >
                <strong>
                    {text("discovery.product.snapshot.summary", {
                        locations: outcomes.length,
                        sources: sourceCount,
                        tools: toolCount,
                    })}
                </strong>
                {hasScanNotes ? (
                    <WorkbenchBadge data-oaam-scan-notes="true" tone="warning">
                        {text(
                            discoveryProbeStatusMessage(
                                outcomes.every((outcome) => outcome.status === "failed") ? "failed" : "partial",
                            ),
                        )}
                    </WorkbenchBadge>
                ) : null}
                {completedAt === undefined ? null : (
                    <small>
                        {text("discovery.ui.snapshot.completed_at", {
                            time: new Intl.DateTimeFormat(snapshot.resolvedLocale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                            }).format(completedAt),
                        })}
                    </small>
                )}
            </div>
            {!showEnvironmentDetails ? <DiscoveryProbeIssues outcomes={outcomes} providers={providers} /> : null}
            {showEnvironmentDetails ? (
                <div className="environment-result-list">
                    {outcomes.map((outcome) => {
                        const environmentLabel = presentDiscoveryEnvironment(outcome.environment);
                        return (
                            <WorkbenchDisclosure
                                data-oaam-interaction-entry="features.discovery.discovery_results.004"
                                data-oaam-environment-result-instance={outcome.environment.platformInstanceId}
                                data-oaam-environment-result-platform={outcome.environment.platform}
                                data-oaam-environment-result-status={outcome.status}
                                key={desktopEnvironmentKey(outcome.environment)}
                                summary={
                                    <>
                                        <strong>{displayText(environmentLabel)}</strong>
                                        <WorkbenchBadge tone={discoveryProbeStatusTone(outcome.status)}>
                                            {text(discoveryProbeStatusMessage(outcome.status))}
                                        </WorkbenchBadge>
                                    </>
                                }
                            >
                                <ul className="discovery-tool-result-list">
                                    {outcome.tools.map((tool) => {
                                        const toolPresentation = presentDiscoveryTool(tool.adapterId, providers);
                                        return (
                                            <li key={tool.adapterId}>
                                                <div className="source-row-heading">
                                                    <strong>{displayText(toolPresentation.label)}</strong>
                                                    <WorkbenchBadge
                                                        tone={discoveryToolOutcomeTone(tool.status, tool.installationStatus)}
                                                    >
                                                        {text(discoveryToolOutcomeMessage(tool.status, tool.installationStatus))}
                                                    </WorkbenchBadge>
                                                </div>
                                                <div className="discovery-tool-meta-line">
                                                    <WorkbenchTechnicalFact
                                                        data-oaam-interaction-entry="features.discovery.discovery_results.005"
                                                        disclosureClassName="discovery-technical-disclosure"
                                                        fact={
                                                            <small>
                                                                {tool.versionTexts.length === 0
                                                                    ? displayText(toolPresentation.label)
                                                                    : text("discovery.product.installation.versions", {
                                                                          versions: tool.versionTexts.join(", "),
                                                                      })}
                                                            </small>
                                                        }
                                                        summary={text("discovery.product.source.details")}
                                                    >
                                                        <code>
                                                            {text("discovery.product.technical.identity", {
                                                                identity: toolPresentation.technicalIdentity,
                                                            })}
                                                        </code>
                                                        <code>
                                                            {text("discovery.product.technical.runtime_identities", {
                                                                identities: tool.agentRuntimeIds.join(", "),
                                                            })}
                                                        </code>
                                                        <small>{displayText(technicalText(tool.status))}</small>
                                                    </WorkbenchTechnicalFact>
                                                </div>
                                                <ProtocolDiagnostics
                                                    attribution={toolPresentation.label}
                                                    diagnostics={tool.unscopedDiagnostics}
                                                    layout="grouped"
                                                />
                                                {tool.runtimeOutcomes
                                                    .filter(
                                                        (runtime) =>
                                                            tool.runtimeOutcomes.length > 1 || runtime.diagnostics.length > 0,
                                                    )
                                                    .map((runtime) => {
                                                        const runtimePresentation = presentDiscoveryAgentRuntime(
                                                            runtime.agentRuntimeId,
                                                            providers,
                                                        );
                                                        return (
                                                            <div
                                                                className="discovery-runtime-diagnostic-scope"
                                                                data-oaam-agent-runtime-id={runtime.agentRuntimeId}
                                                                key={runtime.agentRuntimeId}
                                                            >
                                                                <div className="source-row-heading">
                                                                    <div className="discovery-probe-issue-scope">
                                                                        <strong>{displayText(runtimePresentation.label)}</strong>
                                                                        <small>
                                                                            {text("discovery.product.scan.entry_scope")}
                                                                        </small>
                                                                    </div>
                                                                    <WorkbenchBadge
                                                                        tone={discoveryInstallationStatusTone(
                                                                            runtime.installationStatus,
                                                                        )}
                                                                    >
                                                                        {text(
                                                                            discoveryInstallationStatusMessage(
                                                                                runtime.installationStatus,
                                                                            ),
                                                                        )}
                                                                    </WorkbenchBadge>
                                                                </div>
                                                                <ProtocolDiagnostics
                                                                    attribution={runtimePresentation.label}
                                                                    diagnostics={runtime.diagnostics}
                                                                    layout="grouped"
                                                                />
                                                            </div>
                                                        );
                                                    })}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </WorkbenchDisclosure>
                        );
                    })}
                </div>
            ) : null}
        </section>
    );
}
