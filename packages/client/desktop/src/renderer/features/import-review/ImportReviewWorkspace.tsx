import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopImportPreviewFileReference, ImportPreviewFileRevealResult } from "../../../bridge/desktop-bridge";
import {
    type DesktopMessageId,
    localizedText,
    ProtocolDiagnostics,
    ProtocolFeedbackNotice,
    presentProtocolDiagnostic,
    protocolDiagnosticIdentity,
    useDesktopPresentation,
} from "../../presentation";
import {
    DesktopIcon,
    StatusPanel,
    WorkbenchBadge,
    WorkbenchCheckButton,
    WorkbenchDisclosure,
    WorkbenchIconButton,
    WorkbenchNotice,
    WorkbenchPanel,
    WorkbenchSelect,
    WorkbenchTechnicalFact,
} from "../../ui";
import { ImportPreviewInspector, type ImportPreviewTab } from "./ImportPreviewInspector";
import type { ImportReadIssueView, ImportReviewController, ImportReviewState } from "./import-review-controller";
import { callableBindingSubjectKey, canTargetBinding, canTargetExistingAsset } from "./import-review-model";
import {
    importAssetKindMessage,
    importAssetScopeMessage,
    importCandidateIncompleteHelpMessage,
    importCandidateStatusMessage,
    importCandidateStatusTone,
} from "./import-review-presentation";

export interface ImportReviewWorkspaceProps {
    readonly controller: ImportReviewController;
    readonly navigationOwner?: "review" | "journey";
    readonly embeddedResult?: boolean;
    readonly revealImportPreviewFile?: (reference: DesktopImportPreviewFileReference) => Promise<ImportPreviewFileRevealResult>;
    readonly onReturnToSources: () => void | Promise<void>;
    readonly onOpenImportedAsset?: (assetId: string, versionId: string) => Promise<void>;
}

function ImportRefreshRequiredState({ onReturnToSources }: { readonly onReturnToSources: () => void | Promise<void> }) {
    const { text } = useDesktopPresentation();
    return (
        <div
            data-oaam-visible-state="import_review_stale_preview"
            data-oaam-state-presentation="action_required"
            data-oaam-state-blocking-scope="current_step"
            data-oaam-state-persistence="transient"
        >
            <WorkbenchNotice tone="danger" role="alert">
                {text("import.ui.refresh_required")}
            </WorkbenchNotice>
            <div className="status-card-actions">
                <button
                    data-oaam-interaction-entry="features.import-review.import_review_workspace.018"
                    data-oaam-visible-state-action="return_to_sources"
                    type="button"
                    onClick={() => void onReturnToSources()}
                >
                    {text("import.ui.return_to_sources")}
                </button>
            </div>
        </div>
    );
}

function importResultMessage(status: "complete" | "failed" | "dependency_failed"): DesktopMessageId {
    switch (status) {
        case "complete":
            return "import.ui.result.imported";
        case "failed":
            return "import.ui.result.failed";
        case "dependency_failed":
            return "import.ui.result.dependency_failed";
    }
}

function ImportReadIssueList({ issues }: { readonly issues: readonly ImportReadIssueView[] }): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    return (
        <ul className="import-read-issue-list">
            {issues.map((issue) => (
                <li data-oaam-import-read-issue={issue.status} key={`${issue.probeResultRowId}\0${issue.sourceRootRowId}`}>
                    <div>
                        <strong>
                            {displayText(issue.toolLabel)} · {displayText(issue.environmentLabel)}
                        </strong>
                        <code>{issue.displayPath}</code>
                    </div>
                    {issue.diagnostics.length === 0 ? (
                        <span>{text(`import.ui.read_attention.status.${issue.status}`)}</span>
                    ) : (
                        <WorkbenchTechnicalFact
                            data-oaam-interaction-entry="features.import-review.import_review_workspace.001"
                            fact={<span>{text(`import.ui.read_attention.status.${issue.status}`)}</span>}
                            summary={text("import.ui.technical_details")}
                        >
                            {issue.diagnostics.map((diagnostic) => (
                                <div key={protocolDiagnosticIdentity(diagnostic)}>
                                    <code>{presentProtocolDiagnostic(diagnostic).technicalIdentity}</code>
                                    <small>
                                        {text("discovery.product.technical.raw_message", {
                                            message: presentProtocolDiagnostic(diagnostic).rawMessage,
                                        })}
                                    </small>
                                </div>
                            ))}
                        </WorkbenchTechnicalFact>
                    )}
                </li>
            ))}
        </ul>
    );
}

export function ImportReviewWorkspace({
    controller,
    navigationOwner = "review",
    embeddedResult = false,
    revealImportPreviewFile,
    onReturnToSources,
    onOpenImportedAsset,
}: ImportReviewWorkspaceProps): React.JSX.Element {
    const { displayText, snapshot, text } = useDesktopPresentation();
    const [state, setState] = useState<ImportReviewState>(controller.state);
    const [openingResult, setOpeningResult] = useState(false);
    const [openResultFailed, setOpenResultFailed] = useState(false);
    async function openResultAsset(assetId: string, versionId: string): Promise<void> {
        if (openingResult || onOpenImportedAsset === undefined) return;
        setOpeningResult(true);
        setOpenResultFailed(false);
        try {
            await onOpenImportedAsset(assetId, versionId);
        } catch {
            setOpenResultFailed(true);
        } finally {
            setOpeningResult(false);
        }
    }
    const existingAssets = state.status === "review" ? state.existingAssets : [];
    const [previewTabs, setPreviewTabs] = useState<readonly ImportPreviewTab[]>([]);
    const [activePreviewTabKey, setActivePreviewTabKey] = useState<string>();
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [fileListVisible, setFileListVisible] = useState(false);
    const [previewRailWidth, setPreviewRailWidth] = useState(() =>
        Math.max(336, Math.min(1440, Math.round(globalThis.innerWidth * 0.36))),
    );
    const workspaceRef = useRef<HTMLDivElement>(null);
    const pendingScrollTop = useRef<number | undefined>(undefined);
    const previewToken = state.status === "review" ? state.preview.previewToken : undefined;
    const previewTokenRef = useRef(previewToken);
    useEffect(() => controller.subscribe(setState), [controller]);
    useEffect(() => {
        if (previewTokenRef.current === previewToken) return;
        previewTokenRef.current = previewToken;
        setPreviewTabs([]);
        setActivePreviewTabKey(undefined);
        setInspectorOpen(false);
        setFileListVisible(false);
    }, [previewToken]);
    useLayoutEffect(() => {
        if (pendingScrollTop.current === undefined) return;
        const scrollOwner = workspaceRef.current?.closest<HTMLElement>(".guided-import-shell, .onboarding-shell");
        if (scrollOwner === undefined || scrollOwner === null) return;
        const requestedScrollTop = pendingScrollTop.current;
        pendingScrollTop.current = undefined;
        scrollOwner.scrollTop = Math.min(requestedScrollTop, Math.max(0, scrollOwner.scrollHeight - scrollOwner.clientHeight));
    });

    if (state.status === "idle") {
        return (
            <StatusPanel
                eyebrow={text("import.ui.eyebrow")}
                title={text("import.ui.no_preview")}
                message={displayText(state.message)}
                className="import-review-status"
            />
        );
    }
    if (state.status === "preparing") {
        return (
            <StatusPanel
                eyebrow={text("import.ui.eyebrow")}
                title={text(state.phase === "reading" ? "import.ui.reading" : "import.ui.preparing")}
                message={displayText(state.message)}
                busy
                compact
                className="import-review-progress"
            />
        );
    }
    if (state.status === "read_attention") {
        return (
            <WorkbenchPanel aria-labelledby="import-read-attention-title" data-oaam-import-read-attention>
                <div className="section-heading">
                    <div>
                        <p className="eyebrow">{text("import.ui.read_attention.eyebrow")}</p>
                        <h2 id="import-read-attention-title">{text("import.ui.read_attention.title")}</h2>
                    </div>
                </div>
                <p className="section-copy">{text("import.ui.read_attention.copy")}</p>
                <ImportReadIssueList issues={state.issues} />
                <p className="section-copy">{text("import.ui.read_attention.action_copy")}</p>
                <div className="import-actions">
                    <button
                        data-oaam-interaction-entry="features.import-review.import_review_workspace.002"
                        type="button"
                        className="library-secondary-button"
                        onClick={() => void controller.retryRead()}
                    >
                        {text("common.retry")}
                    </button>
                    {state.completeSourcePreparation === undefined ? null : (
                        <button
                            data-oaam-interaction-entry="features.import-review.import_review_workspace.003"
                            type="button"
                            onClick={() => void controller.continueWithCompleteSources()}
                        >
                            {text("import.ui.read_attention.continue")}
                        </button>
                    )}
                </div>
            </WorkbenchPanel>
        );
    }
    if (state.status === "failed") {
        return (
            <div className="import-review-failure">
                <StatusPanel
                    eyebrow={text("import.ui.eyebrow")}
                    title={text(state.refreshRequired ? "import.ui.failed.refresh_title" : "import.ui.failed.title")}
                    tone="danger"
                    className="import-review-status"
                >
                    <ProtocolDiagnostics
                        embedded
                        operationMessage={state.message}
                        diagnostics={state.diagnostics}
                        technicalSummary={text("import.ui.technical_details")}
                    />
                    {state.refreshRequired ? (
                        <ImportRefreshRequiredState onReturnToSources={onReturnToSources} />
                    ) : (
                        <div className="status-card-actions">
                            <button
                                data-oaam-interaction-entry="features.import-review.import_review_workspace.004"
                                type="button"
                                onClick={() => void controller.retryFailed()}
                            >
                                {text("common.retry")}
                            </button>
                        </div>
                    )}
                </StatusPanel>
            </div>
        );
    }
    if (state.status === "result") {
        const displayNameFor = (candidateId: string): string =>
            state.reviewedAssets.find((asset) => asset.candidateId === candidateId)?.displayName ??
            text("import.ui.result.unknown_asset");
        const listFormatter = new Intl.ListFormat(snapshot.resolvedLocale, {
            style: "long",
            type: "conjunction",
        });
        const resultContent = (
            <div className="import-result-content">
                <div className="section-heading">
                    <h2 id="import-result-title">{text("import.ui.result.batch_outcomes")}</h2>
                </div>
                <ProtocolDiagnostics
                    embedded
                    operationMessage={
                        state.result.items.every((item) => item.status === "complete")
                            ? state.message
                            : localizedText("import.ui.result.copy", { message: displayText(state.message) })
                    }
                    diagnostics={state.diagnostics}
                    technicalSummary={text("import.ui.technical_details")}
                />
                <ul className="import-result-list">
                    {state.result.items.map((item) => {
                        const displayName = displayNameFor(item.candidateId);
                        return (
                            <li data-oaam-import-result-status={item.status} key={item.candidateId}>
                                <WorkbenchTechnicalFact
                                    data-oaam-interaction-entry="features.import-review.import_review_workspace.005"
                                    fact={<strong>{displayName}</strong>}
                                    summary={text("import.ui.technical_details")}
                                >
                                    <code>
                                        {text("import.ui.technical.candidate_id", {
                                            candidateId: item.candidateId,
                                        })}
                                    </code>
                                    {item.status === "complete" ? (
                                        <>
                                            <code>
                                                {text("import.ui.technical.asset_id", {
                                                    assetId: item.version.assetId,
                                                })}
                                            </code>
                                            <code>
                                                {text("import.ui.technical.version_id", {
                                                    versionId: item.version.versionId,
                                                })}
                                            </code>
                                        </>
                                    ) : null}
                                </WorkbenchTechnicalFact>
                                <ProtocolDiagnostics
                                    embedded
                                    operationMessage={localizedText(
                                        item.status === "complete"
                                            ? state.reviewedAssets.find((asset) => asset.candidateId === item.candidateId)
                                                  ?.action === "create_version"
                                                ? "import.ui.result.version_saved"
                                                : "import.ui.result.asset_saved"
                                            : importResultMessage(item.status),
                                    )}
                                    diagnostics={item.diagnostics}
                                    technicalSummary={text("import.ui.technical_details")}
                                />
                                {item.status === "complete" && onOpenImportedAsset !== undefined ? (
                                    <button
                                        type="button"
                                        className="library-secondary-button"
                                        data-oaam-interaction-entry="features.import-review.import_review_workspace.019"
                                        data-oaam-open-imported-asset={item.version.assetId}
                                        data-oaam-open-imported-version={item.version.versionId}
                                        disabled={openingResult}
                                        onClick={() => void openResultAsset(item.version.assetId, item.version.versionId)}
                                    >
                                        {text("import.ui.result.open")}
                                    </button>
                                ) : null}
                                {item.status === "dependency_failed" ? (
                                    <small>
                                        {text("import.ui.result.failed_dependencies", {
                                            assets: listFormatter.format(
                                                item.failedDependencyCandidateIds.map((candidateId) =>
                                                    displayNameFor(candidateId),
                                                ),
                                            ),
                                        })}
                                    </small>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
                {openResultFailed ? (
                    <WorkbenchNotice tone="danger" role="alert">
                        {text("import.ui.result.open_failed")}
                    </WorkbenchNotice>
                ) : null}
                {navigationOwner === "journey" && state.result.items.some((item) => item.status !== "complete") ? (
                    <p className="section-copy">{text("import.ui.result.retry_failed")}</p>
                ) : null}
            </div>
        );
        return embeddedResult ? (
            resultContent
        ) : (
            <WorkbenchPanel aria-labelledby="import-result-title">{resultContent}</WorkbenchPanel>
        );
    }

    const selected = new Set(state.selectedCandidateIds);
    const busy = state.activity === "accepting" || state.activity === "cancelling";
    const reviewCandidates = state.preview.candidates;

    function previewTabKey(candidateId: string, logicalPath: string | undefined): string {
        return `${candidateId}\0${logicalPath ?? ""}`;
    }

    function previewTabLabel(candidateId: string, logicalPath: string | undefined): string {
        if (logicalPath !== undefined) return logicalPath.split("/").at(-1) ?? logicalPath;
        return reviewCandidates.find((candidate) => candidate.candidateId === candidateId)?.displayName ?? candidateId;
    }

    function previewTabTitle(candidateId: string, logicalPath: string | undefined): string {
        const candidate = reviewCandidates.find((entry) => entry.candidateId === candidateId);
        if (logicalPath === undefined) return candidate?.displayName ?? candidateId;
        return `${candidate?.displayName ?? candidateId}/${logicalPath}`;
    }

    function openPreviewFile(candidateId: string, logicalPath?: string): void {
        const tabKey = previewTabKey(candidateId, logicalPath);
        setPreviewTabs((current) =>
            current.some((tab) => tab.tabKey === tabKey)
                ? current
                : [
                      ...current,
                      Object.freeze({
                          tabKey,
                          candidateId,
                          ...(logicalPath === undefined ? {} : { logicalPath }),
                          label: previewTabLabel(candidateId, logicalPath),
                          title: previewTabTitle(candidateId, logicalPath),
                      }),
                  ],
        );
        setActivePreviewTabKey(tabKey);
        setInspectorOpen(true);
        void controller.loadDetail(candidateId, logicalPath);
    }

    function selectPreviewTab(tab: ImportPreviewTab): void {
        setActivePreviewTabKey(tab.tabKey);
        setInspectorOpen(true);
        void controller.loadDetail(tab.candidateId, tab.logicalPath);
    }

    function closePreviewTab(tabKey: string): void {
        const tabIndex = previewTabs.findIndex((tab) => tab.tabKey === tabKey);
        const remaining = previewTabs.filter((tab) => tab.tabKey !== tabKey);
        setPreviewTabs(remaining);
        if (activePreviewTabKey !== tabKey) return;
        const nextTab = remaining[Math.min(Math.max(tabIndex, 0), remaining.length - 1)];
        setActivePreviewTabKey(nextTab?.tabKey);
        setInspectorOpen(nextTab !== undefined);
        if (nextTab !== undefined) void controller.loadDetail(nextTab.candidateId, nextTab.logicalPath);
    }

    function toggleCandidate(candidateId: string, checked: boolean): void {
        const scrollOwner = workspaceRef.current?.closest<HTMLElement>(".guided-import-shell, .onboarding-shell");
        if (scrollOwner !== undefined && scrollOwner !== null) pendingScrollTop.current = scrollOwner.scrollTop;
        if (!checked) {
            const removedTabIndex = previewTabs.findIndex(
                (tab) => tab.candidateId === candidateId && tab.tabKey === activePreviewTabKey,
            );
            const remaining = previewTabs.filter((tab) => tab.candidateId !== candidateId);
            setPreviewTabs(remaining);
            if (removedTabIndex >= 0) {
                const nextTab = remaining[Math.min(removedTabIndex, remaining.length - 1)];
                setActivePreviewTabKey(nextTab?.tabKey);
                setInspectorOpen(nextTab !== undefined);
                if (nextTab !== undefined) void controller.loadDetail(nextTab.candidateId, nextTab.logicalPath);
            }
        }
        controller.toggleCandidate(candidateId);
    }

    const actionableCandidates = state.preview.candidates.filter((candidate) => candidate.status !== "duplicate");
    const existingCandidates = state.preview.candidates.filter((candidate) => candidate.status === "duplicate");

    return (
        <div className="import-review-workbench" data-inspector-open={inspectorOpen && previewTabs.length > 0} ref={workspaceRef}>
            <WorkbenchPanel
                className="import-review-main"
                aria-labelledby="import-review-title"
                data-oaam-import-navigation-owner={navigationOwner}
            >
                <div className="section-heading">
                    <div>
                        <p className="eyebrow">{text("import.ui.eyebrow")}</p>
                        <h2 id="import-review-title">{text("import.ui.title")}</h2>
                    </div>
                    <div className="section-heading-actions">
                        <WorkbenchIconButton
                            data-oaam-interaction-entry="features.import-review.import_review_workspace.006"
                            icon="inspector"
                            label={text(inspectorOpen ? "import.ui.inspector.hide" : "import.ui.inspector.show")}
                            aria-pressed={inspectorOpen && previewTabs.length > 0}
                            disabled={previewTabs.length === 0}
                            onClick={() => setInspectorOpen((current) => !current)}
                        />
                        {navigationOwner === "review" ? (
                            <button
                                data-oaam-interaction-entry="features.import-review.import_review_workspace.007"
                                type="button"
                                data-oaam-import-review-close
                                disabled={busy}
                                onClick={() => void controller.cancel()}
                            >
                                {text(
                                    state.activity === "cancelling" ? "import.ui.action.cancelling" : "import.ui.action.cancel",
                                )}
                            </button>
                        ) : null}
                    </div>
                </div>
                <p className="section-copy">{text("import.ui.copy")}</p>
                {state.refreshRequired ? <ImportRefreshRequiredState onReturnToSources={onReturnToSources} /> : null}
                {state.readIssues.length === 0 ? null : (
                    <WorkbenchDisclosure
                        data-oaam-interaction-entry="features.import-review.import_review_workspace.008"
                        className="import-read-notes"
                        summary={text("import.ui.read_notes.summary", { count: state.readIssues.length })}
                    >
                        <p>{text("import.ui.read_notes.copy")}</p>
                        <ImportReadIssueList issues={state.readIssues} />
                    </WorkbenchDisclosure>
                )}
                {state.preview.candidates.length === 0 ? (
                    <WorkbenchNotice tone="empty">{text("import.ui.no_candidates")}</WorkbenchNotice>
                ) : (
                    <ul className="import-candidate-list">
                        {actionableCandidates.map((candidate) => {
                            const selectable =
                                candidate.status === "importable" &&
                                candidate.freshness === "fresh" &&
                                !candidate.callableBindingRequestsTruncated;
                            const candidateSelected = selected.has(candidate.candidateId);
                            const destination = state.destinationSelections.find(
                                (selection) => selection.candidateId === candidate.candidateId,
                            );
                            const compatibleDestinations = existingAssets.filter(
                                (asset) => !asset.deleted && asset.kind === candidate.kind,
                            );
                            const incompleteFile = candidate.logicalPaths[0];
                            return (
                                <li data-oaam-import-candidate-id={candidate.candidateId} key={candidate.candidateId}>
                                    <div className="source-row-heading">
                                        <WorkbenchCheckButton
                                            data-oaam-interaction-entry="features.import-review.import_review_workspace.009"
                                            inputLabel={text("import.ui.candidate.select", {
                                                candidate: candidate.displayName,
                                            })}
                                            checked={candidateSelected}
                                            disabled={!selectable || busy || state.refreshRequired}
                                            onCheckedChange={(checked) => toggleCandidate(candidate.candidateId, checked)}
                                        >
                                            <strong>{candidate.displayName}</strong>
                                        </WorkbenchCheckButton>
                                        <WorkbenchBadge tone={importCandidateStatusTone(candidate)}>
                                            {text(importCandidateStatusMessage(candidate))}
                                        </WorkbenchBadge>
                                    </div>
                                    <small className="import-candidate-meta">
                                        {text(importAssetKindMessage(candidate.kind))} ·{" "}
                                        {text(importAssetScopeMessage(candidate.scope))} ·{" "}
                                        {text(
                                            candidate.fileCount === 1
                                                ? "import.ui.candidate.file_count.one"
                                                : "import.ui.candidate.file_count.many",
                                            { count: candidate.fileCount },
                                        )}
                                    </small>
                                    {candidate.displayDescription === "" ? null : <p>{candidate.displayDescription}</p>}
                                    {candidate.status === "incomplete" ? (
                                        <WorkbenchNotice className="import-candidate-incomplete-help" tone="warning">
                                            {text(importCandidateIncompleteHelpMessage(candidate, incompleteFile !== undefined), {
                                                path: incompleteFile ?? "",
                                            })}
                                        </WorkbenchNotice>
                                    ) : null}
                                    {candidateSelected && compatibleDestinations.length > 0 ? (
                                        <div className="import-select-field">
                                            <span>{text("import.ui.destination.save_as")}</span>
                                            <WorkbenchSelect
                                                data-oaam-interaction-entry="features.import-review.import_review_workspace.010"
                                                label={text("import.ui.destination.label", {
                                                    candidate: candidate.displayName,
                                                })}
                                                value={
                                                    destination?.action === "create_version"
                                                        ? `asset:${destination.assetId}`
                                                        : "create_asset"
                                                }
                                                disabled={busy || state.refreshRequired}
                                                options={[
                                                    {
                                                        value: "create_asset",
                                                        label: text("import.ui.destination.create_asset"),
                                                    },
                                                    ...compatibleDestinations.map((asset) => ({
                                                        value: `asset:${asset.assetId}`,
                                                        label: text("import.ui.destination.add_version", {
                                                            asset: asset.displayName,
                                                            revision: asset.currentRevision,
                                                        }),
                                                    })),
                                                ]}
                                                onChange={(value) => {
                                                    if (value === "create_asset") {
                                                        controller.setDestination(candidate.candidateId, "create_asset");
                                                    } else {
                                                        controller.setDestination(
                                                            candidate.candidateId,
                                                            compatibleDestinations.find(
                                                                (asset) => `asset:${asset.assetId}` === value,
                                                            ),
                                                        );
                                                    }
                                                }}
                                            />
                                        </div>
                                    ) : null}
                                    <div className="detail-actions import-candidate-files">
                                        {candidate.fileCount > 0 ? (
                                            <WorkbenchIconButton
                                                data-oaam-interaction-entry="features.import-review.import_review_workspace.012"
                                                icon="preview"
                                                label={text("import.ui.detail.view", { path: candidate.displayName })}
                                                disabled={busy || state.refreshRequired}
                                                onClick={() => {
                                                    setFileListVisible(candidate.fileCount > 1);
                                                    openPreviewFile(candidate.candidateId, candidate.logicalPaths[0]);
                                                }}
                                            />
                                        ) : null}
                                    </div>
                                    {candidate.logicalPathsTruncated ? <small>{text("import.ui.files_omitted")}</small> : null}
                                    {candidate.callableBindingRequestsTruncated ? (
                                        <small>
                                            {text("import.ui.dependencies_too_many", {
                                                count: candidate.callableBindingRequestCount,
                                            })}
                                        </small>
                                    ) : null}
                                    {candidateSelected && candidate.callableBindingRequests.length > 0 ? (
                                        <div className="binding-list">
                                            {candidate.callableBindingRequests.map((request) => {
                                                const subjectKey = callableBindingSubjectKey(request.subject);
                                                const selection = state.bindingSelections.find(
                                                    (binding) =>
                                                        binding.candidateId === candidate.candidateId &&
                                                        binding.subjectKey === subjectKey,
                                                );
                                                const targets = state.preview.candidates.filter(
                                                    (target) =>
                                                        selected.has(target.candidateId) &&
                                                        target.candidateId !== candidate.candidateId &&
                                                        canTargetBinding(request, target),
                                                );
                                                const existingTargets = existingAssets.filter((asset) =>
                                                    canTargetExistingAsset(request, asset),
                                                );
                                                const selectionValue =
                                                    selection === undefined
                                                        ? ""
                                                        : selection.targetKind === "candidate"
                                                          ? `candidate:${selection.targetCandidateId}`
                                                          : `asset_version:${selection.targetAssetVersionId}`;
                                                const bindingLabel = text("import.ui.binding.target_label", {
                                                    candidate: candidate.displayName,
                                                    target: request.rawTarget,
                                                });
                                                return (
                                                    <div className="import-select-field" key={subjectKey}>
                                                        <span>
                                                            {text(
                                                                request.required
                                                                    ? "import.ui.binding.required"
                                                                    : "import.ui.binding.optional",
                                                                { target: request.rawTarget },
                                                            )}
                                                        </span>
                                                        <WorkbenchSelect
                                                            data-oaam-interaction-entry="features.import-review.import_review_workspace.013"
                                                            label={bindingLabel}
                                                            value={selectionValue}
                                                            disabled={busy || state.refreshRequired}
                                                            options={[
                                                                {
                                                                    value: "",
                                                                    label: text(
                                                                        request.required
                                                                            ? "import.ui.binding.choose_exact"
                                                                            : "import.ui.binding.leave_unbound",
                                                                    ),
                                                                },
                                                                ...targets.map((target) => ({
                                                                    value: `candidate:${target.candidateId}`,
                                                                    label: `${target.displayName} (${target.kind})`,
                                                                    description: text("import.ui.binding.selected_candidates"),
                                                                })),
                                                                ...existingTargets.map((asset) => ({
                                                                    value: `asset_version:${asset.currentVersionId}`,
                                                                    label: text("import.ui.destination.add_version", {
                                                                        asset: asset.displayName,
                                                                        revision: asset.currentRevision,
                                                                    }),
                                                                    description: text("import.ui.binding.existing_versions"),
                                                                })),
                                                            ]}
                                                            onChange={(value) => {
                                                                if (value === "") {
                                                                    controller.clearBindingTarget(
                                                                        candidate.candidateId,
                                                                        subjectKey,
                                                                    );
                                                                } else if (value.startsWith("candidate:")) {
                                                                    controller.setBindingCandidateTarget(
                                                                        candidate.candidateId,
                                                                        subjectKey,
                                                                        value.slice("candidate:".length),
                                                                    );
                                                                } else {
                                                                    const asset = existingTargets.find(
                                                                        (candidateAsset) =>
                                                                            `asset_version:${candidateAsset.currentVersionId}` ===
                                                                            value,
                                                                    );
                                                                    if (asset !== undefined) {
                                                                        controller.setBindingExistingVersionTarget(
                                                                            candidate.candidateId,
                                                                            subjectKey,
                                                                            asset,
                                                                        );
                                                                    }
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                )}
                {existingCandidates.length === 0 ? null : (
                    <WorkbenchDisclosure
                        data-oaam-interaction-entry="features.import-review.import_review_workspace.014"
                        className="import-existing-candidates"
                        summary={text("import.ui.existing_candidates.summary", {
                            count: existingCandidates.length,
                        })}
                    >
                        <ul className="import-candidate-list">
                            {existingCandidates.map((candidate) => (
                                <li data-oaam-import-candidate-id={candidate.candidateId} key={candidate.candidateId}>
                                    <div className="source-row-heading">
                                        <strong>{candidate.displayName}</strong>
                                        <WorkbenchBadge tone={importCandidateStatusTone(candidate)}>
                                            {text(importCandidateStatusMessage(candidate))}
                                        </WorkbenchBadge>
                                    </div>
                                    <small>
                                        {text(importAssetKindMessage(candidate.kind))} ·{" "}
                                        {text(importAssetScopeMessage(candidate.scope))} ·{" "}
                                        {text(
                                            candidate.fileCount === 1
                                                ? "import.ui.candidate.file_count.one"
                                                : "import.ui.candidate.file_count.many",
                                            { count: candidate.fileCount },
                                        )}
                                    </small>
                                    <div className="detail-actions import-candidate-files">
                                        {candidate.fileCount > 0 ? (
                                            <WorkbenchIconButton
                                                data-oaam-interaction-entry="features.import-review.import_review_workspace.016"
                                                icon="preview"
                                                label={text("import.ui.detail.view", { path: candidate.displayName })}
                                                disabled={busy || state.refreshRequired}
                                                onClick={() => {
                                                    setFileListVisible(candidate.fileCount > 1);
                                                    openPreviewFile(candidate.candidateId, candidate.logicalPaths[0]);
                                                }}
                                            />
                                        ) : null}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </WorkbenchDisclosure>
                )}
                {state.message === undefined ? (
                    <ProtocolDiagnostics
                        attribution={localizedText("import.ui.diagnostics.attribution")}
                        diagnostics={state.diagnostics}
                        technicalSummary={text("import.ui.technical_details")}
                    />
                ) : busy ? (
                    <p className="workbench-status-copy import-review-activity" role="status" aria-live="polite">
                        <span className="status-card-spinner" data-oaam-loading-indicator>
                            <DesktopIcon name="loading" size={18} />
                        </span>
                        {displayText(state.message)}
                    </p>
                ) : (
                    <ProtocolFeedbackNotice
                        message={state.message}
                        diagnostics={state.diagnostics}
                        tone={state.activity === "accept_failed" || state.activity === "cancel_failed" ? "danger" : "note"}
                    />
                )}
                <div className="import-actions">
                    <p>{text("import.ui.safe_import_copy")}</p>
                    <button
                        data-oaam-interaction-entry="features.import-review.import_review_workspace.017"
                        type="button"
                        data-oaam-import-commit
                        disabled={selected.size === 0 || busy || state.refreshRequired}
                        onClick={() => void controller.accept()}
                    >
                        {text(state.activity === "accepting" ? "import.ui.action.importing" : "import.ui.action.import")}
                    </button>
                </div>
            </WorkbenchPanel>
            {inspectorOpen && previewTabs.length > 0 ? (
                <ImportPreviewInspector
                    key={state.preview.previewToken}
                    previewToken={state.preview.previewToken}
                    candidates={state.preview.candidates}
                    tabs={previewTabs}
                    activeTabKey={activePreviewTabKey}
                    detail={state.detail}
                    fileListVisible={fileListVisible}
                    busy={busy || state.refreshRequired}
                    railWidth={previewRailWidth}
                    revealImportPreviewFile={revealImportPreviewFile}
                    onSelectTab={selectPreviewTab}
                    onCloseTab={closePreviewTab}
                    onOpenFile={openPreviewFile}
                    onToggleFileList={() => setFileListVisible((current) => !current)}
                    onResizeRail={setPreviewRailWidth}
                    onClose={() => setInspectorOpen(false)}
                />
            ) : null}
        </div>
    );
}
