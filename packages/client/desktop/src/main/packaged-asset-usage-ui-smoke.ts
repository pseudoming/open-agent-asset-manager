import {
    assertPackagedAssetUsageAuthorityUnchanged,
    type PackagedAssetUsageAuthorityChangeReceipt,
    type PackagedAssetUsageAuthorityDelta,
    type PackagedAssetUsageAuthoritySnapshot,
    waitForPackagedAssetUsageAuthorityQuiescence,
} from "./packaged-asset-usage-authority-proof";
import { RUN_PROJECT_ASSET_USAGE_CHECK_SCRIPT } from "./packaged-asset-usage-ui-script-support";
import { proveWindowsProjectEnvironmentChoice } from "./packaged-environment-choice-smoke";
import { importPackagedAsset, preparePackagedAssetReview } from "./packaged-import-review-ui-smoke";
import type { PackagedProjectRegistrationProof } from "./packaged-project-registration-ui-smoke";

export {
    diffPackagedAssetUsageAuthority,
    type PackagedAssetUsageAuthorityChangeReceipt,
    type PackagedAssetUsageAuthorityDelta,
    type PackagedAssetUsageAuthorityManifestEntry,
    type PackagedAssetUsageAuthoritySnapshot,
    type PackagedAssetUsageDesktopPreferencesSnapshot,
    snapshotPackagedAssetUsageAuthority,
} from "./packaged-asset-usage-authority-proof";

export interface PackagedAlreadyUsableAssetUiProof {
    readonly status: "complete";
    readonly projectId: string;
    readonly assetId: string;
    readonly assetRevision: 1;
    readonly sourcePath: string;
    readonly agentRuntimeLabel: string;
    readonly capability: "direct";
    readonly observedTargetState: "already_usable";
    readonly managedState: "none";
    readonly ordinaryStatusText: string;
    readonly ordinaryDetailText: string;
    readonly deploymentCountBefore: 0;
    readonly deploymentCountAfter: 0;
    readonly createDeploymentReviewActionCount: 0;
    readonly observedRows: readonly {
        readonly capability: string;
        readonly observedTargetState: string;
        readonly managedState: string;
        readonly hasWriteReviewAction: boolean;
    }[];
    readonly authorityBefore: PackagedAssetUsageAuthoritySnapshot;
    readonly authorityAfter: PackagedAssetUsageAuthoritySnapshot;
    readonly authorityDelta: PackagedAssetUsageAuthorityDelta;
    readonly authorityUnchanged: true;
    readonly observabilityChanged: boolean;
}

export interface PackagedAssetUsageUiSmokeWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedAssetUsageUiSmokeOptions {
    readonly capture: () => Promise<void>;
    readonly readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot;
    readonly recordAuthorityChange: (receipt: PackagedAssetUsageAuthorityChangeReceipt) => void;
    readonly recordTerminalObservation: (receipt: PackagedAssetUsageProofTerminalReceipt) => void;
    readonly authorityQuiescenceDeadlineMilliseconds?: number;
    readonly authorityQuiescencePollIntervalMilliseconds?: number;
}

export interface PackagedAssetUsageProofTerminalReceipt {
    readonly schemaVersion: 1;
    readonly status: "terminal";
    readonly stage: "project_asset_usage_relationship";
    readonly terminalKind: "deadline_exceeded" | "terminal_state";
    readonly message: string;
    readonly elapsedMilliseconds: number;
    readonly pollCount: number;
    readonly lastObservation: Readonly<Record<string, unknown>>;
}

interface ProjectImportReady {
    readonly projectId: string;
}

export interface PackagedProjectAssetReady extends ProjectImportReady {
    readonly assetId: string;
    readonly assetRevision: 1;
}

interface RelationshipReady extends PackagedProjectAssetReady {
    readonly deploymentCountBefore: 0;
}

interface RelationshipResult {
    readonly projectId: string;
    readonly assetId: string;
    readonly agentRuntimeLabel: string;
    readonly capability: "direct";
    readonly observedTargetState: "already_usable";
    readonly managedState: "none";
    readonly ordinaryStatusText: string;
    readonly ordinaryDetailText: string;
    readonly deploymentCountAfter: 0;
    readonly createDeploymentReviewActionCount: 0;
    readonly observedRows: readonly {
        readonly capability: string;
        readonly observedTargetState: string;
        readonly managedState: string;
        readonly hasWriteReviewAction: boolean;
    }[];
}

function deploymentEnvironmentFormValue(environmentIdentity: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(environmentIdentity);
    } catch {
        throw new TypeError("packaged Project environment identity is not valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((part) => typeof part === "string" && part.length > 0)) {
        throw new TypeError("packaged Project environment identity is not one exact platform and instance");
    }
    return `${parsed[0]}\0${parsed[1]}`;
}

const ENTER_PROJECT_IMPORT_SCRIPT = `(async (expected) => {
    const deadline = Date.now() + 45000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    let library = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        return value instanceof HTMLElement ? value : false;
    }, "the ordinary library before Project import");
    if (library.dataset.oaamSubject !== "projects") {
        const projects = library.querySelector('[data-oaam-subject-choice="projects"]');
        if (!(projects instanceof HTMLButtonElement) || projects.disabled) {
            throw new Error("the Projects library choice is unavailable");
        }
        projects.click();
    }
    library = await waitFor(() => {
        const value = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]',
        );
        return value instanceof HTMLElement ? value : false;
    }, "the Projects library");
    const projectButtons = [...library.querySelectorAll('.asset-tree-project[data-oaam-project-id]')];
    const matches = projectButtons.filter((candidate) => {
        const label = candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "";
        return candidate instanceof HTMLButtonElement && label === expected.displayName;
    });
    if (matches.length !== 1 || !(matches[0] instanceof HTMLButtonElement) || matches[0].disabled) {
        throw new Error("the exact registered Project is not uniquely selectable");
    }
    const projectId = matches[0].dataset.oaamProjectId ?? "";
    if (!/^[0-9a-f-]{36}$/iu.test(projectId)) throw new Error("the exact registered Project has no stable identity");
    if (library.dataset.oaamProjectId !== projectId) matches[0].click();
    library = await waitFor(() => {
        const value = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]',
        );
        return value instanceof HTMLElement && value.dataset.oaamProjectId === projectId ? value : false;
    }, "the exact registered Project library");
    const action = await waitFor(() => {
        const current = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]',
        );
        if (!(current instanceof HTMLElement) || current.dataset.oaamProjectId !== projectId) return false;
        const actions = [...current.querySelectorAll('[data-oaam-action="start-guided-import"]')].filter(
            (candidate) => candidate instanceof HTMLButtonElement && !candidate.disabled,
        );
        if (actions.length > 1) throw new Error("the exact registered Project has ambiguous import actions");
        return actions.length === 1 && actions[0] instanceof HTMLButtonElement ? actions[0] : false;
    }, "the exact registered Project's unique import action");
    action.click();
    const guided = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="locations"]');
        return value instanceof HTMLElement ? value : false;
    }, "the exact Project-scoped import");
    if (guided.dataset.oaamTargetProjectId !== projectId) {
        throw new Error("the Project-scoped import lost its exact Project identity");
    }
    return { status: "ready", projectId };
})`;

const RESTORE_EXACT_PROJECT_SOURCE_SCRIPT = `(async (expected) => {
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const workspace = await waitFor(() => {
        const value = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
        return value instanceof HTMLElement && value.dataset.oaamDiscoveryActivity === "idle" ? value : false;
    }, "the Project source review");
    const guided = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="sources"]');
    if (!(guided instanceof HTMLElement) || workspace.dataset.oaamTargetProjectId !== expected.projectId ||
        guided.dataset.oaamTargetProjectId !== expected.projectId) {
        throw new Error("the Project source review changed Project identity");
    }
    const exactCards = () => [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
        .filter((card) => card instanceof HTMLElement && card.dataset.oaamSourcePath === expected.sourcePath);
    const exact = exactCards();
    if (exact.length !== 1 || !(exact[0] instanceof HTMLElement)) {
        throw new Error("the Project source review did not retain exactly one exact Project root");
    }
    let card = exact[0];
    if (card.dataset.oaamSourceState === "ignored") {
        const restore = card.querySelector('[data-oaam-source-action="restore"]');
        if (!(restore instanceof HTMLButtonElement) || restore.disabled) {
            throw new Error("the ignored exact Project source has no restore action");
        }
        restore.click();
    }
    const readState = () => {
        const currentWorkspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
        const currentGuided = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="sources"]');
        if (!(currentWorkspace instanceof HTMLElement) || !(currentGuided instanceof HTMLElement) ||
            currentWorkspace.dataset.oaamTargetProjectId !== expected.projectId ||
            currentGuided.dataset.oaamTargetProjectId !== expected.projectId) {
            throw new Error("the Project source review changed Project identity while restoring the exact source");
        }
        const currentCards = [...currentWorkspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
            .filter((candidate) => candidate instanceof HTMLElement &&
                candidate.dataset.oaamSourcePath === expected.sourcePath);
        if (currentCards.length > 1) {
            throw new Error("the Project source review has multiple cards for the exact Project root");
        }
        const current = currentCards.length === 1 && currentCards[0] instanceof HTMLElement ? currentCards[0] : undefined;
        if (current === undefined) {
            return {
                card: undefined,
                sourceState: "missing",
                sourceSelected: false,
                futureScanState: "missing",
                futureScanEnabled: false,
            };
        }
        const futureScanState = current.dataset.oaamSourceWatchSelected ?? "missing";
        if (futureScanState !== "true" && futureScanState !== "false") {
            throw new Error("the exact Project source does not expose an exact future-scan state");
        }
        const futureScanEnabled = futureScanState === "true";
        if (!futureScanEnabled) {
            return {
                card: current,
                sourceState: current.dataset.oaamSourceState ?? "missing",
                sourceSelected: current.dataset.oaamSourceSelected === "true",
                futureScanState,
                futureScanEnabled,
            };
        }
        const destinationControls = [...current.querySelectorAll('.source-watch-destination')];
        if (destinationControls.length > 1) {
            throw new Error("the exact Project source has multiple future-scan destination controls");
        }
        const destination = destinationControls.length === 1 && destinationControls[0] instanceof HTMLElement
            ? destinationControls[0]
            : undefined;
        const projectChoices = destination === undefined ? [] :
            [...destination.querySelectorAll('[data-oaam-source-destination-choice="project"]')];
        const globalChoices = destination === undefined ? [] :
            [...destination.querySelectorAll('[data-oaam-source-destination-choice="global"]')];
        if (projectChoices.length > 1 || globalChoices.length > 1) {
            throw new Error("the exact Project source has ambiguous Project or Global destination choices");
        }
        const projectChoice = projectChoices.length === 1 && projectChoices[0] instanceof HTMLElement
            ? projectChoices[0] : undefined;
        const globalChoice = globalChoices.length === 1 && globalChoices[0] instanceof HTMLElement
            ? globalChoices[0] : undefined;
        const projectInputs = projectChoice === undefined ? [] :
            [...projectChoice.querySelectorAll('input[type="radio"][value="project"]')];
        const globalInputs = globalChoice === undefined ? [] :
            [...globalChoice.querySelectorAll('input[type="radio"][value="global"]')];
        if (projectInputs.length > 1 || globalInputs.length > 1) {
            throw new Error("the exact Project source has ambiguous Project or Global destination inputs");
        }
        const projectInput = projectInputs.length === 1 && projectInputs[0] instanceof HTMLInputElement
            ? projectInputs[0] : undefined;
        const globalInput = globalInputs.length === 1 && globalInputs[0] instanceof HTMLInputElement
            ? globalInputs[0] : undefined;
        return {
            card: current,
            sourceState: current.dataset.oaamSourceState ?? "missing",
            sourceSelected: current.dataset.oaamSourceSelected === "true",
            futureScanState,
            futureScanEnabled,
            destination,
            projectChoice,
            globalChoice,
            projectInput,
            globalInput,
            projectChoiceState: projectChoice?.dataset.checked ?? "missing",
            globalChoiceState: globalChoice?.dataset.checked ?? "missing",
            projectInputChecked: projectInput?.checked,
            globalInputChecked: globalInput?.checked,
        };
    };
    let lastState;
    try {
        const settled = await waitFor(() => {
            const state = readState();
            lastState = state;
            return state.card instanceof HTMLElement &&
                state.sourceState === "included" &&
                state.sourceSelected &&
                (!state.futureScanEnabled ||
                    (state.destination instanceof HTMLElement &&
                        state.projectChoice instanceof HTMLElement &&
                        state.globalChoice instanceof HTMLElement &&
                        state.projectInput instanceof HTMLInputElement &&
                        state.globalInput instanceof HTMLInputElement &&
                        (state.projectChoiceState === "true" || state.projectChoiceState === "false") &&
                        (state.globalChoiceState === "true" || state.globalChoiceState === "false") &&
                        (state.projectChoiceState === "true") === state.projectInputChecked &&
                        (state.globalChoiceState === "true") === state.globalInputChecked &&
                        state.projectInputChecked !== state.globalInputChecked)) ? state.card : false;
        }, "the exact Project source selection and optional future-scan destination to settle");
        card = settled;
    } catch (error) {
        if (!(error instanceof Error) ||
            error.message !==
                "timed out waiting for the exact Project source selection and optional future-scan destination to settle") {
            throw error;
        }
        const state = lastState ?? readState();
        if (!(state.card instanceof HTMLElement)) {
            throw new Error("the exact Project source disappeared before its Project destination settled");
        }
        if (state.sourceState !== "included") {
            throw new Error("the exact Project source did not settle as included; observed=" + state.sourceState);
        }
        if (!state.sourceSelected) {
            throw new Error("the exact Project source did not remain selected after restore");
        }
        if (!state.futureScanEnabled) throw error;
        if (!(state.destination instanceof HTMLElement)) {
            throw new Error("the exact Project source enables future scans but has no unique destination control");
        }
        if (!(state.projectChoice instanceof HTMLElement) || !(state.projectInput instanceof HTMLInputElement)) {
            throw new Error("the exact Project source future-scan Project choice is incomplete");
        }
        if (!(state.globalChoice instanceof HTMLElement) || !(state.globalInput instanceof HTMLInputElement)) {
            throw new Error("the exact Project source future-scan Global choice is incomplete");
        }
        if (
            (state.projectChoiceState !== "true" && state.projectChoiceState !== "false") ||
            (state.globalChoiceState !== "true" && state.globalChoiceState !== "false") ||
            (state.projectChoiceState === "true") !== state.projectInputChecked ||
            (state.globalChoiceState === "true") !== state.globalInputChecked
        ) {
            throw new Error("the exact Project source future-scan destination state is internally inconsistent");
        }
        if (state.projectInputChecked === state.globalInputChecked) {
            throw new Error("the exact Project source future-scan destination is not uniquely selected");
        }
        throw error;
    }
    return { status: "ready", projectId: expected.projectId };
})`;

const OPEN_IMPORTED_PROJECT_ASSET_SCRIPT = `(async (expected) => {
    const deadline = expected.deadlineAtMillisecondsSinceEpoch ?? Date.now() + 45000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const guided = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="complete"]');
        return value instanceof HTMLElement ? value : false;
    }, "the completed Project import");
    const done = guided.querySelector('.onboarding-completion .onboarding-actions button:not(.library-secondary-button)');
    if (!(done instanceof HTMLButtonElement) || done.disabled) {
        throw new Error("the Project import return action is unavailable");
    }
    done.click();
    await waitFor(() => {
        const value = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]',
        );
        return value instanceof HTMLElement && value.dataset.oaamProjectId === expected.projectId ? value : false;
    }, "the exact Project library after import");
    const asset = await waitFor(() => {
        const current = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]',
        );
        if (!(current instanceof HTMLElement) || current.dataset.oaamProjectId !== expected.projectId) {
            throw new Error("the exact Project library changed identity while loading its assets");
        }
        const browserFailure = current.querySelector('.asset-browser > [role="alert"]');
        if (browserFailure instanceof HTMLElement) {
            const detail = (browserFailure.textContent ?? "").replace(/\\s+/gu, " ").trim();
            throw new Error("the exact Project Asset library failed to load" + (detail === "" ? "" : ": " + detail));
        }
        const collections = [...current.querySelectorAll('.asset-collection[data-oaam-collection-id="project"]')];
        if (collections.length > 1) throw new Error("the exact Project library exposed multiple Project collections");
        if (collections.length === 0 || !(collections[0] instanceof HTMLElement)) return false;
        const totalCount = Number.parseInt(collections[0].dataset.oaamTotalCount ?? "", 10);
        if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
            throw new Error("the exact Project collection has no trustworthy total count");
        }
        const guidanceGroups = [
            ...collections[0].querySelectorAll('.asset-kind-group[data-oaam-asset-kind="Guidance"]'),
        ];
        if (guidanceGroups.length > 1) {
            throw new Error("the exact Project collection exposed multiple Guidance groups");
        }
        if (guidanceGroups.length === 0 || !(guidanceGroups[0] instanceof HTMLElement)) {
            throw new Error("the completed Project collection contains no Guidance assets");
        }
        const failure = guidanceGroups[0].querySelector('.library-empty-inline[role="alert"]');
        if (failure instanceof HTMLElement) {
            const detail = (failure.textContent ?? "").replace(/\\s+/gu, " ").trim();
            throw new Error("the Project Guidance collection failed to load" + (detail === "" ? "" : ": " + detail));
        }
        const pending = guidanceGroups[0].querySelector('.library-empty-inline[aria-busy="true"]');
        if (pending instanceof HTMLElement) return false;
        const projectAssets = [...guidanceGroups[0].querySelectorAll('.asset-library-item[data-oaam-asset-id]')].filter(
            (candidate) => candidate instanceof HTMLElement && candidate.dataset.status === "complete",
        );
        if (projectAssets.length !== 1 || !(projectAssets[0] instanceof HTMLElement)) {
            throw new Error("the completed Project Guidance collection does not contain exactly one complete AGENTS.md");
        }
        if (projectAssets[0].dataset.oaamRevision !== "1") {
            throw new Error("the imported AGENTS Asset is not at exact revision 1");
        }
        return projectAssets[0];
    }, "the complete Project Guidance collection containing revision 1");
    const assetId = asset.dataset.oaamAssetId ?? "";
    if (!/^[0-9a-f-]{36}$/iu.test(assetId)) throw new Error("the imported AGENTS Asset has no stable identity");
    const open = asset.querySelector('[data-oaam-semantic-action="library.open_asset_deployment"]');
    if (!(open instanceof HTMLButtonElement) || open.disabled) {
        throw new Error("the imported AGENTS Asset has no tool-usage action");
    }
    open.click();
    const deployment = await waitFor(() => {
        const value = document.querySelector(
            'main[data-oaam-route="deployment"][data-oaam-subject="project"][data-oaam-deployment-mode="create"]',
        );
        return value instanceof HTMLElement && value.dataset.oaamProjectId === expected.projectId &&
            value.dataset.oaamAssetId === assetId ? value : false;
    }, "the exact AGENTS tool-usage page");
    const workspace = await waitFor(() => {
        const value = deployment.querySelector(
            '.catalog-deployment-workspace[data-oaam-deployment-workspace-state="ready"]',
        );
        return value instanceof HTMLElement ? value : false;
    }, "the ready AGENTS tool-usage workspace");
    if (workspace.dataset.oaamDeploymentCount !== "0") {
        throw new Error("the fresh Project unexpectedly has a retained Deployment");
    }
    const target = await waitFor(() => {
        const currentDeployment = document.querySelector(
            'main[data-oaam-route="deployment"][data-oaam-subject="project"][data-oaam-deployment-mode="create"]',
        );
        if (!(currentDeployment instanceof HTMLElement) || currentDeployment.dataset.oaamProjectId !== expected.projectId ||
            currentDeployment.dataset.oaamAssetId !== assetId) {
            throw new Error("the exact AGENTS tool-usage page changed identity while loading its Project tool check");
        }
        if (currentDeployment.dataset.oaamState === "loading") return false;
        if (currentDeployment.dataset.oaamState === "failed") {
            const detail = (currentDeployment.querySelector('[role="alert"]')?.textContent ?? "")
                .replace(/\\s+/gu, " ")
                .trim();
            throw new Error("the Project tool check failed to load" + (detail === "" ? "" : ": " + detail));
        }
        if (currentDeployment.dataset.oaamState !== "ready") {
            throw new Error("the exact AGENTS tool-usage page has an unknown Project tool-check state");
        }
        const workspaces = [
            ...currentDeployment.querySelectorAll(
                '.catalog-deployment-workspace[data-oaam-deployment-workspace-state="ready"]',
            ),
        ];
        if (workspaces.length > 1) throw new Error("the exact AGENTS tool-usage page exposed multiple ready workspaces");
        if (workspaces.length === 0 || !(workspaces[0] instanceof HTMLElement)) return false;
        if (workspaces[0].dataset.oaamDeploymentCount !== "0") {
            throw new Error("the fresh Project unexpectedly gained a retained Deployment while loading its tool check");
        }
        const panels = [...workspaces[0].querySelectorAll('.deployment-target-discovery')];
        if (panels.length > 1) throw new Error("the exact Project tool check exposed multiple discovery panels");
        if (panels.length === 0 || !(panels[0] instanceof HTMLElement)) return false;
        const panel = panels[0];
        if (panel.dataset.oaamState === "loading") return false;
        if (panel.dataset.oaamState === "failed") {
            const detail = (panel.querySelector('[role="alert"]')?.textContent ?? "").replace(/\\s+/gu, " ").trim();
            throw new Error("the Project tool check failed to load" + (detail === "" ? "" : ": " + detail));
        }
        if (panel.dataset.oaamState !== undefined || !panel.matches('section.workbench-panel')) {
            throw new Error("the Project tool check does not match the ready product surface");
        }
        const providerChoices = [
            ...panel.querySelectorAll(
                '.deployment-target-providers label.workbench-check-button[data-oaam-interaction-entry="pages.deployment_page.002"]',
            ),
        ].filter((choice) => choice instanceof HTMLElement);
        if (providerChoices.length === 0) return false;
        const providerRows = providerChoices.map((choice) => ({
            choice,
            input: choice.querySelector('input.workbench-semantic-input[type="checkbox"]'),
            label: (choice.textContent ?? "").replace(/\\s+/gu, " ").trim(),
        }));
        if (providerRows.some((row) => !(row.input instanceof HTMLInputElement))) {
            throw new Error("the Project tool check exposed a Provider without a semantic checkbox");
        }
        if (providerRows.some((row) => row.label === "") || new Set(providerRows.map((row) => row.label)).size !== providerRows.length) {
            throw new Error("the Project tool check exposed ambiguous Provider labels");
        }
        const expectedProviders = providerRows.filter((row) => row.label === expected.providerLabel);
        if (expectedProviders.length !== 1) {
            throw new Error("the Project tool check did not expose one exact " + expected.providerLabel + " Provider");
        }
        const environmentChoices = [
            ...panel.querySelectorAll(
                'label.workbench-radio-button[data-oaam-interaction-entry="pages.deployment_page.003"] ' +
                    'input.workbench-semantic-input[type="radio"][name="deployment-project-environment"]',
            ),
        ].filter((choice) => choice instanceof HTMLInputElement);
        if (environmentChoices.length === 0) return false;
        const selectedEnvironments = environmentChoices.filter((choice) => choice.checked);
        if (selectedEnvironments.length !== 1 || selectedEnvironments[0].value !== expected.selectedEnvironment ||
            selectedEnvironments[0].disabled || selectedEnvironments[0].closest('label')?.dataset.checked !== "true") {
            throw new Error("the Project tool check does not retain the exact Project environment");
        }
        const probes = [...panel.querySelectorAll('button[data-oaam-target-action="probe"]')];
        if (probes.length > 1) throw new Error("the exact Project tool check exposed multiple probe actions");
        if (probes.length === 0 || !(probes[0] instanceof HTMLButtonElement) || probes[0].disabled) return false;
        return panel;
    }, "the ready Project tool check");
    const readProviderRows = () => {
        const currentDeployment = document.querySelector(
            'main[data-oaam-route="deployment"][data-oaam-subject="project"][data-oaam-deployment-mode="create"]',
        );
        if (!(currentDeployment instanceof HTMLElement) || currentDeployment.dataset.oaamProjectId !== expected.projectId ||
            currentDeployment.dataset.oaamAssetId !== assetId || currentDeployment.dataset.oaamState !== "ready") {
            throw new Error("the exact AGENTS tool-usage page changed identity while selecting its Provider");
        }
        const panels = [...currentDeployment.querySelectorAll(
            '.catalog-deployment-workspace[data-oaam-deployment-workspace-state="ready"] ' +
                'section.workbench-panel.deployment-target-discovery:not([data-oaam-state])',
        )];
        if (panels.length !== 1 || !(panels[0] instanceof HTMLElement)) {
            throw new Error("the exact Project tool check changed while selecting its Provider");
        }
        const rows = [...panels[0].querySelectorAll(
            '.deployment-target-providers label.workbench-check-button[data-oaam-interaction-entry="pages.deployment_page.002"]',
        )].map((choice) => ({
            choice,
            input: choice.querySelector('input.workbench-semantic-input[type="checkbox"]'),
            label: (choice.textContent ?? "").replace(/\\s+/gu, " ").trim(),
        }));
        if (rows.length === 0 || rows.some((row) => !(row.choice instanceof HTMLElement) ||
            !(row.input instanceof HTMLInputElement) || row.label === "") ||
            new Set(rows.map((row) => row.label)).size !== rows.length) {
            throw new Error("the exact Project tool check lost unambiguous semantic Provider choices");
        }
        if (rows.filter((row) => row.label === expected.providerLabel).length !== 1) {
            throw new Error("the exact Project tool check lost the exact " + expected.providerLabel + " Provider");
        }
        return rows;
    };
    let providerRows = readProviderRows();
    while (true) {
        const unexpected = providerRows.find((row) => row.label !== expected.providerLabel &&
            row.input instanceof HTMLInputElement && row.input.checked);
        if (unexpected === undefined) break;
        if (!(unexpected.input instanceof HTMLInputElement) || unexpected.input.disabled) {
            throw new Error("the selected " + unexpected.label + " Provider cannot be cleared for the exact check");
        }
        unexpected.input.click();
        providerRows = await waitFor(() => {
            const rows = readProviderRows();
            const current = rows.find((row) => row.label === unexpected.label);
            return current !== undefined && current.input instanceof HTMLInputElement && !current.input.checked ? rows : false;
        }, "the selected " + unexpected.label + " Provider to clear");
    }
    let expectedProvider = providerRows.find((row) => row.label === expected.providerLabel);
    if (expectedProvider === undefined || !(expectedProvider.input instanceof HTMLInputElement)) {
        throw new Error("the exact Project tool check lost the expected Provider before selection");
    }
    if (!expectedProvider.input.checked) {
        if (expectedProvider.input.disabled) {
            throw new Error("the exact " + expected.providerLabel + " Provider cannot be selected");
        }
        expectedProvider.input.click();
        providerRows = await waitFor(() => {
            const rows = readProviderRows();
            const current = rows.find((row) => row.label === expected.providerLabel);
            return current !== undefined && current.input instanceof HTMLInputElement && current.input.checked ? rows : false;
        }, "the exact " + expected.providerLabel + " Provider selection");
        expectedProvider = providerRows.find((row) => row.label === expected.providerLabel);
    }
    const selectedProviders = providerRows.filter((row) => row.input instanceof HTMLInputElement && row.input.checked);
    if (expectedProvider === undefined || selectedProviders.length !== 1 || selectedProviders[0] !== expectedProvider ||
        expectedProvider.choice.dataset.checked !== "true") {
        throw new Error("the Project tool check did not retain only the exact " + expected.providerLabel + " Provider");
    }
    const probe = target.querySelector('[data-oaam-target-action="probe"]');
    if (!(probe instanceof HTMLButtonElement) || probe.disabled) {
        throw new Error("the exact Project tool check is unavailable");
    }
    return { status: "ready", projectId: expected.projectId, assetId, assetRevision: 1, deploymentCountBefore: 0 };
})`;

const RETURN_TO_PROJECT_LIBRARY_SCRIPT = `(async (expected) => {
    const startedAt = Date.now();
    const deadline = startedAt + 15000;
    let pollCount = 0;
    let lastObservation;
    const back = document.querySelector('[data-oaam-semantic-action="deployment.open_library"]');
    if (!(back instanceof HTMLButtonElement) || back.disabled) {
        throw new Error("the tool-usage page has no safe return to the Project library");
    }
    back.click();
    while (Date.now() < deadline) {
        pollCount += 1;
        const roots = [...document.querySelectorAll('main[data-oaam-route]')];
        const root = roots.length === 1 && roots[0] instanceof HTMLElement ? roots[0] : undefined;
        lastObservation = {
            routeRootCount: roots.length,
            route: root?.dataset.oaamRoute ?? "missing",
            subject: root?.dataset.oaamSubject ?? "missing",
            state: root?.dataset.oaamState ?? "missing",
            projectId: root?.dataset.oaamProjectId ?? "missing",
        };
        if (lastObservation.routeRootCount === 1 && lastObservation.route === "library" &&
            lastObservation.subject === "projects" && lastObservation.state === "ready" &&
            lastObservation.projectId === expected.projectId) {
            return { status: "complete" };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out returning to the exact Project library: " + JSON.stringify({
        elapsedMilliseconds: Date.now() - startedAt,
        pollCount,
        lastObservation,
    }));
})`;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseTerminalReceipt(value: unknown): PackagedAssetUsageProofTerminalReceipt | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("status" in value)) return undefined;
    if (value.status !== "terminal") return undefined;
    if (
        !exactRecord(value, [
            "elapsedMilliseconds",
            "lastObservation",
            "message",
            "pollCount",
            "schemaVersion",
            "stage",
            "status",
            "terminalKind",
        ])
    )
        throw new TypeError("invalid packaged Asset-usage terminal observation");
    const record = value as Record<string, unknown>;
    const observation = record.lastObservation;
    if (
        record.schemaVersion !== 1 ||
        record.stage !== "project_asset_usage_relationship" ||
        (record.terminalKind !== "deadline_exceeded" && record.terminalKind !== "terminal_state") ||
        typeof record.message !== "string" ||
        record.message.length === 0 ||
        record.message.length > 4_096 ||
        !Number.isSafeInteger(record.elapsedMilliseconds) ||
        (record.elapsedMilliseconds as number) < 0 ||
        !Number.isSafeInteger(record.pollCount) ||
        (record.pollCount as number) < 0 ||
        typeof observation !== "object" ||
        observation === null ||
        Array.isArray(observation)
    )
        throw new TypeError("invalid packaged Asset-usage terminal observation");
    const required =
        "alerts,deployment,deploymentRootCount,exactRuntimeRow,exactRuntimeRowCount,relationshipPanelCount,selectedEnvironmentValues,selectedProviderLabels,targetDiscoveryCount,usageState,workspace".split(
            ",",
        );
    if (!required.every((key) => key in (observation as Record<string, unknown>)))
        throw new TypeError("incomplete packaged Asset-usage terminal observation");
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 65_536) throw new TypeError("oversized packaged Asset-usage terminal observation");
    return Object.freeze(JSON.parse(encoded) as PackagedAssetUsageProofTerminalReceipt);
}

function recordAndThrowTerminal(value: unknown, record: (receipt: PackagedAssetUsageProofTerminalReceipt) => void): void {
    const terminal = parseTerminalReceipt(value);
    if (terminal === undefined) return;
    record(terminal);
    throw new Error(terminal.message);
}

function parseReady(value: unknown): ProjectImportReady {
    if (
        !exactRecord(value, ["projectId", "status"]) ||
        value.status !== "ready" ||
        typeof value.projectId !== "string" ||
        !/^[0-9a-f-]{36}$/iu.test(value.projectId)
    ) {
        throw new TypeError("invalid packaged Project import entry proof");
    }
    return Object.freeze({ projectId: value.projectId });
}

function parseProjectAssetReady(value: unknown): PackagedProjectAssetReady & { readonly deploymentCountBefore: 0 } {
    if (
        !exactRecord(value, ["assetId", "assetRevision", "deploymentCountBefore", "projectId", "status"]) ||
        value.status !== "ready" ||
        typeof value.projectId !== "string" ||
        !/^[0-9a-f-]{36}$/iu.test(value.projectId) ||
        typeof value.assetId !== "string" ||
        !/^[0-9a-f-]{36}$/iu.test(value.assetId) ||
        value.assetRevision !== 1 ||
        value.deploymentCountBefore !== 0
    ) {
        throw new TypeError("invalid packaged Project AGENTS entry proof");
    }
    return Object.freeze({
        projectId: value.projectId,
        assetId: value.assetId,
        assetRevision: 1,
        deploymentCountBefore: 0,
    });
}

async function openPackagedImportedProjectAssetUsage(
    webContents: PackagedAssetUsageUiSmokeWebContents,
    projectId: string,
    selectedEnvironment: string,
): Promise<PackagedProjectAssetReady & { readonly deploymentCountBefore: 0 }> {
    return parseProjectAssetReady(
        await webContents.executeJavaScript(
            `(${OPEN_IMPORTED_PROJECT_ASSET_SCRIPT})(${JSON.stringify({
                projectId,
                providerLabel: "OpenCode",
                selectedEnvironment,
            })})`,
        ),
    );
}

function parseRelationshipResult(value: unknown, expected: RelationshipReady): RelationshipResult {
    if (
        !exactRecord(value, [
            "agentRuntimeLabel",
            "assetId",
            "capability",
            "createDeploymentReviewActionCount",
            "deploymentCountAfter",
            "managedState",
            "observedRows",
            "observedTargetState",
            "ordinaryDetailText",
            "ordinaryStatusText",
            "projectId",
            "status",
        ]) ||
        value.status !== "complete" ||
        value.projectId !== expected.projectId ||
        value.assetId !== expected.assetId ||
        typeof value.agentRuntimeLabel !== "string" ||
        value.agentRuntimeLabel.length === 0 ||
        value.capability !== "direct" ||
        value.observedTargetState !== "already_usable" ||
        value.managedState !== "none" ||
        typeof value.ordinaryStatusText !== "string" ||
        value.ordinaryStatusText.length === 0 ||
        typeof value.ordinaryDetailText !== "string" ||
        value.ordinaryDetailText.length === 0 ||
        value.deploymentCountAfter !== 0 ||
        value.createDeploymentReviewActionCount !== 0 ||
        !Array.isArray(value.observedRows) ||
        value.observedRows.length === 0
    ) {
        throw new TypeError("invalid packaged already-usable Asset relationship proof");
    }
    const observedRows = value.observedRows.map((row) => {
        if (
            !exactRecord(row, ["capability", "hasWriteReviewAction", "managedState", "observedTargetState"]) ||
            typeof row.capability !== "string" ||
            typeof row.observedTargetState !== "string" ||
            typeof row.managedState !== "string" ||
            typeof row.hasWriteReviewAction !== "boolean"
        ) {
            throw new TypeError("invalid packaged Asset relationship row receipt");
        }
        return Object.freeze({
            capability: row.capability,
            observedTargetState: row.observedTargetState,
            managedState: row.managedState,
            hasWriteReviewAction: row.hasWriteReviewAction,
        });
    });
    return Object.freeze({
        projectId: value.projectId,
        assetId: value.assetId,
        agentRuntimeLabel: value.agentRuntimeLabel,
        capability: "direct",
        observedTargetState: "already_usable",
        managedState: "none",
        ordinaryStatusText: value.ordinaryStatusText,
        ordinaryDetailText: value.ordinaryDetailText,
        deploymentCountAfter: 0,
        createDeploymentReviewActionCount: 0,
        observedRows: Object.freeze(observedRows),
    });
}

export async function proveWindowsPackagedAlreadyUsableAssetUi(
    webContents: PackagedAssetUsageUiSmokeWebContents,
    projectRegistration: PackagedProjectRegistrationProof,
    options: PackagedAssetUsageUiSmokeOptions,
): Promise<PackagedAlreadyUsableAssetUiProof> {
    const execute = (script: string, input: unknown): Promise<unknown> =>
        webContents.executeJavaScript(`(${script})(${JSON.stringify(input)})`);
    const project = parseReady(
        await execute(ENTER_PROJECT_IMPORT_SCRIPT, {
            displayName: projectRegistration.submittedDisplayName,
            sourcePath: projectRegistration.sourcePath,
        }),
    );
    const projectEnvironment = await proveWindowsProjectEnvironmentChoice(webContents, projectRegistration.sourcePath, {
        selectedAdapterIds: ["OPENCODE"],
    });
    const restored = parseReady(
        await execute(RESTORE_EXACT_PROJECT_SOURCE_SCRIPT, {
            projectId: project.projectId,
            sourcePath: projectRegistration.sourcePath,
        }),
    );
    if (restored.projectId !== project.projectId) throw new TypeError("packaged Project source review changed identity");
    await preparePackagedAssetReview(webContents, "guided_import");
    await importPackagedAsset(webContents, "guided_import");
    const ready = await openPackagedImportedProjectAssetUsage(
        webContents,
        project.projectId,
        deploymentEnvironmentFormValue(projectEnvironment.selectedEnvironment),
    );
    const authorityBefore = await waitForPackagedAssetUsageAuthorityQuiescence(options.readAuthoritySnapshot, ready.projectId, {
        ...(options.authorityQuiescenceDeadlineMilliseconds === undefined
            ? {}
            : { deadlineMilliseconds: options.authorityQuiescenceDeadlineMilliseconds }),
        ...(options.authorityQuiescencePollIntervalMilliseconds === undefined
            ? {}
            : { pollIntervalMilliseconds: options.authorityQuiescencePollIntervalMilliseconds }),
    });
    const relationshipValue = await execute(RUN_PROJECT_ASSET_USAGE_CHECK_SCRIPT, {
        projectId: ready.projectId,
        assetId: ready.assetId,
        agentRuntimeLabel: "OpenCode CLI",
    });
    recordAndThrowTerminal(relationshipValue, options.recordTerminalObservation);
    const relationship = parseRelationshipResult(relationshipValue, ready);
    const authorityAfter = options.readAuthoritySnapshot();
    const authorityDelta = assertPackagedAssetUsageAuthorityUnchanged(
        authorityBefore,
        authorityAfter,
        options.recordAuthorityChange,
    );
    await options.capture();
    const returned = await execute(RETURN_TO_PROJECT_LIBRARY_SCRIPT, { projectId: ready.projectId });
    if (!exactRecord(returned, ["status"]) || returned.status !== "complete") {
        throw new TypeError("invalid packaged Project library return proof");
    }
    return Object.freeze({
        status: "complete",
        projectId: ready.projectId,
        assetId: ready.assetId,
        assetRevision: 1,
        sourcePath: projectRegistration.sourcePath,
        agentRuntimeLabel: relationship.agentRuntimeLabel,
        capability: "direct",
        observedTargetState: "already_usable",
        managedState: "none",
        ordinaryStatusText: relationship.ordinaryStatusText,
        ordinaryDetailText: relationship.ordinaryDetailText,
        deploymentCountBefore: 0,
        deploymentCountAfter: 0,
        createDeploymentReviewActionCount: 0,
        observedRows: relationship.observedRows,
        authorityBefore,
        authorityAfter,
        authorityDelta,
        authorityUnchanged: true,
        observabilityChanged: authorityDelta.observabilityChanged,
    });
}
