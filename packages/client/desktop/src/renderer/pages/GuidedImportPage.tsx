import { projectDisplayName } from "../presentation/project-label";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
    DesktopImportPreviewFileReference,
    DesktopObservedProjectRootReference,
    ImportPreviewFileRevealResult,
    ObservedProjectRootAuthorizationResult,
    ObservedProjectRootRevealResult,
    RegisteredProjectRootAuthorizationResult,
} from "../../bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../client";
import { DiscoveryController, type DiscoveryJourneyStage, type DiscoveryState, DiscoveryWorkspace } from "../features/discovery";
import { ImportJourneyProgress, type ImportJourneyStep, isDiscoveryJourneyStep } from "../features/import-journey";
import { ImportReviewController, type ImportReviewState, ImportReviewWorkspace } from "../features/import-review";
import { useDesktopPresentation } from "../presentation";
import { WorkbenchNotice, WorkbenchPanel } from "../ui";

type GuidedImportCompletion = "imported" | "no_content" | "no_selection" | "reviewed";
type GuidedImportReturnStep = "tools" | "sources";

export interface GuidedImportPageProps {
    readonly client: DesktopApplicationClientApi;
    readonly assetCount: number;
    readonly targetProjectId?: string;
    readonly authorizeObservedProjectRoot?: (
        reference: DesktopObservedProjectRootReference,
    ) => Promise<ObservedProjectRootAuthorizationResult>;
    readonly revealObservedProjectRoot?: (
        reference: DesktopObservedProjectRootReference,
    ) => Promise<ObservedProjectRootRevealResult>;
    readonly authorizeRegisteredProjectRoot?: (projectId: string) => Promise<RegisteredProjectRootAuthorizationResult>;
    readonly revealImportPreviewFile?: (reference: DesktopImportPreviewFileReference) => Promise<ImportPreviewFileRevealResult>;
    readonly onClose: () => void;
    readonly onOpenImportedAsset?: (assetId: string, versionId: string) => Promise<void>;
    readonly onCatalogChanged?: () => Promise<void>;
    readonly onLeaveGuardChange?: (leaveGuard: (() => Promise<boolean>) | undefined) => void;
}

export function GuidedImportPage({
    client,
    assetCount,
    targetProjectId,
    authorizeObservedProjectRoot,
    revealObservedProjectRoot,
    authorizeRegisteredProjectRoot,
    revealImportPreviewFile,
    onClose,
    onOpenImportedAsset,
    onCatalogChanged,
    onLeaveGuardChange,
}: GuidedImportPageProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const [step, setStep] = useState<ImportJourneyStep>("locations");
    const [assetReviewStarted, setAssetReviewStarted] = useState(false);
    const [importState, setImportState] = useState<ImportReviewState>();
    const [completion, setCompletion] = useState<GuidedImportCompletion>("reviewed");
    const [completionReturnStep, setCompletionReturnStep] = useState<GuidedImportReturnStep>("sources");
    const [closeFailed, setCloseFailed] = useState(false);
    const [targetProjectName, setTargetProjectName] = useState<string>();
    const discoveryController = useMemo(
        () =>
            new DiscoveryController(client, {
                createUserActionId: () => globalThis.crypto.randomUUID(),
                autoProbeWatched: false,
                ...(targetProjectId === undefined ? {} : { targetProjectId }),
            }),
        [client, targetProjectId],
    );
    const importReviewController = useMemo(
        () =>
            new ImportReviewController(client, {
                createUserActionId: () => globalThis.crypto.randomUUID(),
            }),
        [client],
    );
    useEffect(() => importReviewController.subscribe((state) => setImportState(state)), [importReviewController]);
    const reviewAssets = useCallback(
        (request: Parameters<ImportReviewController["prepare"]>[0]) => {
            setAssetReviewStarted(true);
            setStep("assets");
            void importReviewController.prepare(request);
        },
        [importReviewController],
    );
    const observeDiscoveryState = useCallback(
        (next: DiscoveryState): void => {
            if (targetProjectId === undefined || next.status !== "ready") return;
            setTargetProjectName(projectDisplayName(next.projects.find((project) => project.projectId === targetProjectId)));
        },
        [targetProjectId],
    );

    useEffect(() => {
        if (importState?.status === "result") {
            setCompletion(importState.result.items.some((item) => item.status === "complete") ? "imported" : "reviewed");
            setCompletionReturnStep("sources");
            setStep("complete");
        } else if (
            importState?.status === "review" &&
            importState.preview.candidates.length === 0 &&
            importState.readIssues.length === 0
        ) {
            setCompletion("no_content");
            setCompletionReturnStep("sources");
            setStep("complete");
        }
    }, [importState]);

    const imported = importState?.status === "result" && importState.result.items.some((item) => item.status === "complete");
    const importBusy =
        importState?.status === "preparing" ||
        (importState?.status === "review" && (importState.activity === "accepting" || importState.activity === "cancelling"));
    const discoveryStep: DiscoveryJourneyStage = isDiscoveryJourneyStep(step) ? step : "sources";

    const cancelRetainedPreview = useCallback(async (): Promise<boolean> => {
        if (importReviewController.state.status !== "review") return !importBusy;
        if (importBusy) return false;
        await importReviewController.cancel();
        return (importReviewController.state as ImportReviewState).status === "idle";
    }, [importBusy, importReviewController]);

    const requestLeave = useCallback(async (): Promise<boolean> => {
        setCloseFailed(false);
        if (!(await cancelRetainedPreview())) {
            setCloseFailed(true);
            return false;
        }
        return true;
    }, [cancelRetainedPreview]);

    useEffect(() => {
        onLeaveGuardChange?.(requestLeave);
        return () => onLeaveGuardChange?.(undefined);
    }, [onLeaveGuardChange, requestLeave]);

    async function closeGuidedImport(assetId?: string, versionId?: string): Promise<void> {
        if (!(await requestLeave())) return;
        try {
            if (imported) await onCatalogChanged?.();
            if (assetId !== undefined && versionId !== undefined && onOpenImportedAsset !== undefined)
                await onOpenImportedAsset(assetId, versionId);
            else onClose();
        } catch (error) {
            if (assetId !== undefined && versionId !== undefined && onOpenImportedAsset !== undefined) throw error;
            setCloseFailed(true);
        }
    }

    async function returnToSources(): Promise<void> {
        if (await requestLeave()) setStep("sources");
    }

    function finishEmptyDiscovery(reason: "no_sources_found" | "no_sources_selected"): void {
        setCompletion(reason === "no_sources_selected" ? "no_selection" : "no_content");
        setCompletionReturnStep(reason === "no_sources_selected" ? "sources" : "tools");
        setStep("complete");
    }

    async function returnFromCompletion(): Promise<void> {
        if (completionReturnStep === "tools") {
            setStep("tools");
            return;
        }
        await returnToSources();
    }

    async function finishWithoutImport(): Promise<void> {
        if (await requestLeave()) {
            setCompletion("reviewed");
            setCompletionReturnStep("sources");
            setStep("complete");
        }
    }

    const completionTitle =
        completion === "imported"
            ? "guided_import.completion.imported_title"
            : completion === "no_selection"
              ? "guided_import.completion.no_selection_title"
              : completion === "no_content"
                ? "guided_import.completion.no_content_title"
                : "guided_import.completion.safe_title";
    const completionCopy =
        completion === "imported"
            ? "guided_import.completion.imported_copy"
            : completion === "no_selection"
              ? "guided_import.completion.no_selection_copy"
              : completion === "no_content"
                ? "guided_import.completion.no_content_copy"
                : "guided_import.completion.safe_copy";

    return (
        <main
            className="guided-import-shell"
            data-oaam-state="ready"
            data-oaam-route="guided_import"
            data-oaam-step={step}
            data-oaam-completion={step === "complete" ? completion : undefined}
            data-oaam-asset-count={assetCount}
            data-oaam-target-project-id={targetProjectId}
        >
            <div className="guided-import-content">
                <section className="workspace-heading guided-import-heading" aria-labelledby="guided-import-title">
                    <div>
                        <p className="eyebrow">{text("guided_import.eyebrow")}</p>
                        <h1 id="guided-import-title">
                            {text(targetProjectId === undefined ? "guided_import.title" : "guided_import.project_title", {
                                project: targetProjectName ?? text("guided_import.project_fallback"),
                            })}
                        </h1>
                        <p>
                            {text(
                                targetProjectId === undefined ? "guided_import.copy" : "guided_import.project_copy",
                                targetProjectName === undefined ? {} : { project: targetProjectName },
                            )}
                        </p>
                    </div>
                    <button
                        type="button"
                        className="library-secondary-button"
                        data-oaam-semantic-action="guided_import.open_previous"
                        data-oaam-semantic-entry="guided_import.previous.header"
                        disabled={importBusy}
                        onClick={() => void closeGuidedImport()}
                    >
                        {text("guided_import.close")}
                    </button>
                </section>
                <ImportJourneyProgress step={step} label={text("guided_import.steps.label")} />

                <div className="journey-stage" hidden={!isDiscoveryJourneyStep(step)}>
                    <DiscoveryWorkspace
                        client={client}
                        controller={discoveryController}
                        targetProjectId={targetProjectId}
                        authorizeObservedProjectRoot={authorizeObservedProjectRoot}
                        revealObservedProjectRoot={revealObservedProjectRoot}
                        authorizeRegisteredProjectRoot={authorizeRegisteredProjectRoot}
                        onStateChange={observeDiscoveryState}
                        journey={{
                            stage: discoveryStep,
                            readOnly: step === "assets" && importState?.status !== "read_attention",
                            navigationLabel: text("guided_import.navigation.label"),
                            onStageChange: setStep,
                            onBackFromLocations: () => void closeGuidedImport(),
                            onNoContentFound: finishEmptyDiscovery,
                            onReviewAssets: reviewAssets,
                        }}
                    />
                </div>

                {assetReviewStarted && importState?.status !== "result" ? (
                    <div className="journey-stage journey-asset-review" hidden={step !== "assets"}>
                        <ImportReviewWorkspace
                            controller={importReviewController}
                            navigationOwner="journey"
                            revealImportPreviewFile={revealImportPreviewFile}
                            onReturnToSources={returnToSources}
                        />
                        <nav className="onboarding-actions" aria-label={text("guided_import.navigation.label")}>
                            <button
                                data-oaam-interaction-entry="pages.guided_import_page.002"
                                type="button"
                                className="library-secondary-button"
                                disabled={importBusy}
                                onClick={() => void returnToSources()}
                            >
                                {text("common.back")}
                            </button>
                            <button
                                data-oaam-interaction-entry="pages.guided_import_page.003"
                                type="button"
                                className="library-secondary-button"
                                data-oaam-journey-skip-import
                                disabled={importBusy}
                                onClick={() => void finishWithoutImport()}
                            >
                                {text("guided_import.finish_without_import")}
                            </button>
                        </nav>
                    </div>
                ) : null}

                {step === "complete" ? (
                    <WorkbenchPanel
                        className="onboarding-completion journey-stage"
                        data-import-result={importState?.status === "result"}
                        aria-labelledby={
                            importState?.status === "result" ? "import-result-title" : "guided-import-completion-title"
                        }
                    >
                        {importState?.status === "result" ? (
                            <ImportReviewWorkspace
                                controller={importReviewController}
                                navigationOwner="journey"
                                embeddedResult
                                onOpenImportedAsset={onOpenImportedAsset === undefined ? undefined : closeGuidedImport}
                                onReturnToSources={returnToSources}
                            />
                        ) : (
                            <div>
                                <p className="eyebrow">{text("guided_import.completion.eyebrow")}</p>
                                <h2 id="guided-import-completion-title">{text(completionTitle)}</h2>
                                <p className="section-copy">{text(completionCopy)}</p>
                            </div>
                        )}
                        <div className="onboarding-actions">
                            <button
                                data-oaam-interaction-entry="pages.guided_import_page.004"
                                type="button"
                                className="library-secondary-button"
                                onClick={() => void returnFromCompletion()}
                            >
                                {text(
                                    completionReturnStep === "tools"
                                        ? "guided_import.change_selection"
                                        : "guided_import.back_to_sources",
                                )}
                            </button>
                            <button
                                type="button"
                                data-oaam-semantic-action="guided_import.open_previous"
                                data-oaam-semantic-entry="guided_import.previous.completion"
                                onClick={() => void closeGuidedImport()}
                            >
                                {text("guided_import.completion.done")}
                            </button>
                        </div>
                    </WorkbenchPanel>
                ) : null}
                {closeFailed ? (
                    <WorkbenchNotice tone="danger" role="alert">
                        {text("guided_import.close_failed")}
                    </WorkbenchNotice>
                ) : null}
            </div>
        </main>
    );
}
