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
import { DiscoveryController, type DiscoveryJourneyStage, DiscoveryWorkspace } from "../features/discovery";
import { ImportJourneyProgress, type ImportJourneyStep, isDiscoveryJourneyStep } from "../features/import-journey";
import { ImportReviewController, type ImportReviewState, ImportReviewWorkspace } from "../features/import-review";
import { useDesktopPresentation } from "../presentation";
import { WorkbenchNotice, WorkbenchPanel } from "../ui";

export interface OnboardingPageProps {
    readonly client: DesktopApplicationClientApi;
    readonly assetCount: number;
    readonly preferredProjectId?: string;
    readonly authorizeObservedProjectRoot?: (
        reference: DesktopObservedProjectRootReference,
    ) => Promise<ObservedProjectRootAuthorizationResult>;
    readonly revealObservedProjectRoot?: (
        reference: DesktopObservedProjectRootReference,
    ) => Promise<ObservedProjectRootRevealResult>;
    readonly authorizeRegisteredProjectRoot?: (projectId: string) => Promise<RegisteredProjectRootAuthorizationResult>;
    readonly revealImportPreviewFile?: (reference: DesktopImportPreviewFileReference) => Promise<ImportPreviewFileRevealResult>;
    readonly onCatalogChanged?: () => Promise<void>;
    readonly onComplete?: () => void;
    readonly onOpenImportedAsset?: (assetId: string, versionId: string) => Promise<void>;
}

type OnboardingStep = "welcome" | ImportJourneyStep;
type OnboardingCompletion = "imported" | "no_content" | "no_selection" | "reviewed";
type OnboardingReturnStep = "tools" | "sources";

export function OnboardingPage({
    client,
    assetCount,
    preferredProjectId,
    authorizeObservedProjectRoot,
    revealObservedProjectRoot,
    authorizeRegisteredProjectRoot,
    revealImportPreviewFile,
    onCatalogChanged,
    onComplete,
    onOpenImportedAsset,
}: OnboardingPageProps): React.JSX.Element {
    const { completeOnboarding, snapshot, text } = useDesktopPresentation();
    const [step, setStep] = useState<OnboardingStep>("welcome");
    const [assetReviewStarted, setAssetReviewStarted] = useState(false);
    const [importState, setImportState] = useState<ImportReviewState>();
    const [completion, setCompletion] = useState<OnboardingCompletion>("reviewed");
    const [completionReturnStep, setCompletionReturnStep] = useState<OnboardingReturnStep>("sources");
    const [completionState, setCompletionState] = useState<"idle" | "saving" | "failed">("idle");
    const discoveryController = useMemo(
        () =>
            new DiscoveryController(client, {
                createUserActionId: () => globalThis.crypto.randomUUID(),
                autoProbeWatched: false,
            }),
        [client],
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
    const discoveryStep: DiscoveryJourneyStage = step !== "welcome" && isDiscoveryJourneyStep(step) ? step : "sources";

    async function leaveOnboarding(assetId?: string, versionId?: string): Promise<void> {
        if (completionState === "saving") return;
        if (!(await cancelRetainedPreview())) return;
        setCompletionState("saving");
        const openingImportedAsset = assetId !== undefined && versionId !== undefined && onOpenImportedAsset !== undefined;
        try {
            if (imported) await onCatalogChanged?.();
            if (openingImportedAsset) await onOpenImportedAsset(assetId, versionId);
        } catch (error) {
            setCompletionState(openingImportedAsset ? "idle" : "failed");
            if (openingImportedAsset) throw error;
            return;
        }
        try {
            if (!snapshot.preferences.onboardingCompleted) await completeOnboarding();
            if (!openingImportedAsset) onComplete?.();
        } catch {
            setCompletionState("failed");
        }
    }

    async function cancelRetainedPreview(): Promise<boolean> {
        if (importReviewController.state.status !== "review") return !importBusy;
        if (importBusy) return false;
        await importReviewController.cancel();
        return (importReviewController.state as ImportReviewState).status === "idle";
    }

    async function returnToSources(): Promise<void> {
        if (await cancelRetainedPreview()) setStep("sources");
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
        if (await cancelRetainedPreview()) {
            setCompletion("reviewed");
            setCompletionReturnStep("sources");
            setStep("complete");
        }
    }

    const completionTitle =
        completion === "imported"
            ? "onboarding.completion.imported_title"
            : completion === "no_selection"
              ? "guided_import.completion.no_selection_title"
              : completion === "no_content"
                ? "guided_import.completion.no_content_title"
                : "onboarding.completion.safe_title";
    const completionCopy =
        completion === "imported"
            ? "onboarding.completion.imported_copy"
            : completion === "no_selection"
              ? "guided_import.completion.no_selection_copy"
              : completion === "no_content"
                ? "guided_import.completion.no_content_copy"
                : "onboarding.completion.safe_copy";

    return (
        <main
            className="onboarding-shell"
            data-oaam-state="ready"
            data-oaam-route="onboarding"
            data-oaam-step={step}
            data-oaam-completion={step === "complete" ? completion : undefined}
            data-oaam-asset-count={assetCount}
        >
            <div className="onboarding-content">
                <section className="workspace-heading" aria-labelledby="onboarding-title">
                    <div>
                        <p className="eyebrow">{text("onboarding.eyebrow")}</p>
                        <h1 id="onboarding-title">{text("onboarding.title")}</h1>
                        <p>{text("onboarding.copy")}</p>
                    </div>
                </section>

                {step === "welcome" ? null : <ImportJourneyProgress step={step} label={text("onboarding.steps.label")} />}

                {step === "welcome" ? (
                    <WorkbenchPanel className="onboarding-welcome journey-stage" aria-labelledby="onboarding-welcome-title">
                        <div>
                            <p className="eyebrow">{text("onboarding.welcome.eyebrow")}</p>
                            <h2 id="onboarding-welcome-title">{text("onboarding.welcome.title")}</h2>
                            <p>{text("onboarding.welcome.copy")}</p>
                            <ul>
                                <li>{text("onboarding.welcome.inspect")}</li>
                                <li>{text("onboarding.welcome.no_write")}</li>
                                <li>{text("onboarding.welcome.choose")}</li>
                            </ul>
                        </div>
                        <div className="onboarding-actions">
                            <button
                                type="button"
                                className="library-secondary-button"
                                data-oaam-semantic-action="onboarding.open_library"
                                data-oaam-semantic-entry="onboarding.library.later"
                                onClick={() => void leaveOnboarding()}
                            >
                                {text("onboarding.welcome.later")}
                            </button>
                            <button
                                data-oaam-interaction-entry="pages.onboarding_page.002"
                                type="button"
                                data-oaam-onboarding-start
                                onClick={() => setStep("locations")}
                            >
                                {text("onboarding.welcome.start")}
                            </button>
                        </div>
                        {completionState === "failed" ? (
                            <WorkbenchNotice tone="danger" role="alert">
                                {text("onboarding.completion.failed")}
                            </WorkbenchNotice>
                        ) : null}
                    </WorkbenchPanel>
                ) : null}

                {step === "welcome" ? null : (
                    <div className="journey-stage" hidden={!isDiscoveryJourneyStep(step)}>
                        <DiscoveryWorkspace
                            client={client}
                            controller={discoveryController}
                            preferredProjectId={preferredProjectId}
                            authorizeObservedProjectRoot={authorizeObservedProjectRoot}
                            revealObservedProjectRoot={revealObservedProjectRoot}
                            authorizeRegisteredProjectRoot={authorizeRegisteredProjectRoot}
                            journey={{
                                stage: discoveryStep,
                                readOnly: step === "assets" && importState?.status !== "read_attention",
                                navigationLabel: text("onboarding.navigation.label"),
                                onStageChange: setStep,
                                onBackFromLocations: () => setStep("welcome"),
                                onNoContentFound: finishEmptyDiscovery,
                                onReviewAssets: reviewAssets,
                            }}
                        />
                    </div>
                )}

                {assetReviewStarted && importState?.status !== "result" ? (
                    <div className="journey-stage journey-asset-review" hidden={step !== "assets"}>
                        <ImportReviewWorkspace
                            controller={importReviewController}
                            navigationOwner="journey"
                            revealImportPreviewFile={revealImportPreviewFile}
                            onReturnToSources={returnToSources}
                        />
                        <nav className="onboarding-actions" aria-label={text("onboarding.navigation.label")}>
                            <button
                                data-oaam-interaction-entry="pages.onboarding_page.003"
                                type="button"
                                className="library-secondary-button"
                                disabled={importBusy}
                                onClick={() => void returnToSources()}
                            >
                                {text("common.back")}
                            </button>
                            <button
                                data-oaam-interaction-entry="pages.onboarding_page.004"
                                type="button"
                                className="library-secondary-button"
                                data-oaam-journey-skip-import
                                disabled={importBusy}
                                onClick={() => void finishWithoutImport()}
                            >
                                {text("onboarding.discovery.continue_without_import")}
                            </button>
                        </nav>
                    </div>
                ) : null}

                {step === "complete" ? (
                    <WorkbenchPanel
                        className="onboarding-completion journey-stage"
                        data-import-result={importState?.status === "result"}
                        aria-labelledby={importState?.status === "result" ? "import-result-title" : "onboarding-completion-title"}
                    >
                        {importState?.status === "result" ? (
                            <ImportReviewWorkspace
                                controller={importReviewController}
                                navigationOwner="journey"
                                embeddedResult
                                onOpenImportedAsset={onOpenImportedAsset === undefined ? undefined : leaveOnboarding}
                                onReturnToSources={returnToSources}
                            />
                        ) : (
                            <div>
                                <p className="eyebrow">{text("onboarding.completion.eyebrow")}</p>
                                <h2 id="onboarding-completion-title">{text(completionTitle)}</h2>
                                <p className="section-copy">{text(completionCopy)}</p>
                            </div>
                        )}
                        <div className="onboarding-actions">
                            <button
                                data-oaam-interaction-entry="pages.onboarding_page.005"
                                type="button"
                                className="library-secondary-button"
                                onClick={() => void returnFromCompletion()}
                            >
                                {text("common.back")}
                            </button>
                            <button
                                type="button"
                                data-oaam-semantic-action="onboarding.open_library"
                                data-oaam-semantic-entry="onboarding.library.completion"
                                disabled={completionState === "saving"}
                                onClick={() => void leaveOnboarding()}
                            >
                                {text(
                                    completionState === "saving"
                                        ? "onboarding.completion.saving"
                                        : imported
                                          ? "onboarding.completion.open_workspace"
                                          : "onboarding.completion.finish_without_import",
                                )}
                            </button>
                        </div>
                        {completionState === "failed" ? (
                            <WorkbenchNotice className="onboarding-completion-alert" tone="danger" role="alert">
                                {text("onboarding.completion.failed")}
                            </WorkbenchNotice>
                        ) : null}
                    </WorkbenchPanel>
                ) : null}
            </div>
        </main>
    );
}
