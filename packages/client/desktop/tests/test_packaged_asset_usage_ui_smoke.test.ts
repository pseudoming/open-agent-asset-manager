import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type PackagedAssetUsageAuthoritySnapshot,
    proveWindowsPackagedAlreadyUsableAssetUi,
} from "../src/main/packaged-asset-usage-ui-smoke";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_SOURCE = "C:\\proof\\project";
const WINDOWS = JSON.stringify(["win32", "desktop-local"]);
const WINDOWS_FORM_VALUE = "win32\0desktop-local";

function authoritySnapshot(
    businessAuthorityTreeFingerprint = "a".repeat(64),
    desktopPreferencesFingerprint = "b".repeat(64),
    lastSelectedProjectId: string | null = PROJECT_ID,
): PackagedAssetUsageAuthoritySnapshot {
    return {
        businessAuthorityEntryCount: 3,
        businessAuthorityTreeFingerprint,
        businessAuthorityManifest: [
            { relativePath: "oaam.sqlite", kind: "file", size: 8, sha256: "c".repeat(64) },
            { relativePath: "versions", kind: "directory", size: null, sha256: null },
            { relativePath: "versions/asset.bin", kind: "file", size: 5, sha256: "d".repeat(64) },
        ],
        observabilityEntryCount: 0,
        observabilityTreeFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        observabilityManifest: [],
        desktopPreferencesFingerprint,
        desktopPreferences: {
            schemaVersion: 4,
            onboardingCompleted: true,
            lastSelectedProjectId,
            assetLayout: "list",
        },
        coordinationPaths: ["oaam.sqlite-shm"],
    };
}

function projectRegistration() {
    return {
        status: "complete" as const,
        proposalKey: "project-proposal",
        sourcePath: PROJECT_SOURCE,
        initialDisplayName: "project",
        submittedDisplayName: "project — OAAM package proof",
        matchedSourceCard: true as const,
        dialogId: "discovery_project_registration" as const,
        dialogClosed: true as const,
        proposalResolved: true as const,
        sourceDestination: "project" as const,
        sourceReviewTimeline: [
            { sequence: 0, state: "poll_started" as const, observedAt: 1_000, elapsedMilliseconds: 0 },
            { sequence: 1, state: "source_review_visible" as const, observedAt: 1_010, elapsedMilliseconds: 10 },
            { sequence: 2, state: "actionable_project_ready" as const, observedAt: 1_020, elapsedMilliseconds: 20 },
            { sequence: 3, state: "dialog_ready" as const, observedAt: 1_030, elapsedMilliseconds: 30 },
        ],
    };
}

function successfulExecutionValues(): readonly unknown[] {
    return [
        { status: "ready", projectId: PROJECT_ID },
        {
            status: "ready",
            projectRootPath: PROJECT_SOURCE,
            selectedEnvironment: WINDOWS,
            excludedEnvironmentCount: 1,
            incompatibleEnvironmentsDisabled: true,
        },
        { status: "ready", selectedAdapterIds: ["OPENCODE"] },
        {
            status: "complete",
            projectRootPath: PROJECT_SOURCE,
            selectedEnvironment: WINDOWS,
            probedEnvironment: WINDOWS,
            environmentResultStatus: "complete",
            sourcePaths: [PROJECT_SOURCE],
        },
        { status: "ready", projectId: PROJECT_ID },
        { status: "complete", candidateCount: 1 },
        { status: "complete", importedCandidateCount: 1 },
        {
            status: "ready",
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            assetRevision: 1,
            deploymentCountBefore: 0,
        },
        {
            status: "complete",
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            agentRuntimeLabel: "OpenCode CLI",
            capability: "direct",
            observedTargetState: "already_usable",
            managedState: "none",
            ordinaryStatusText: "Already available",
            ordinaryDetailText: "This tool already reads the current Version file. No file changes are needed.",
            deploymentCountAfter: 0,
            createDeploymentReviewActionCount: 0,
            observedRows: [
                {
                    capability: "direct",
                    observedTargetState: "already_usable",
                    managedState: "none",
                    hasWriteReviewAction: false,
                },
                {
                    capability: "unavailable",
                    observedTargetState: "unknown",
                    managedState: "none",
                    hasWriteReviewAction: false,
                },
            ],
        },
        { status: "complete" },
    ];
}

function stagedExecution(values: readonly unknown[] = successfulExecutionValues()) {
    const executeJavaScript = vi.fn();
    for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
    return executeJavaScript;
}

function renderProjectLibrary(): HTMLElement {
    document.body.innerHTML = `
        <main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready"
            data-oaam-project-id="${PROJECT_ID}">
            <button type="button" class="asset-tree-project" data-oaam-project-id="${PROJECT_ID}">
                <span class="asset-tree-project-label"><span>${projectRegistration().submittedDisplayName}</span></span>
            </button>
            <div data-import-actions></div>
        </main>`;
    const library = document.querySelector<HTMLElement>('main[data-oaam-route="library"]');
    if (library === null) throw new Error("packaged Asset-usage Project fixture is incomplete");
    return library;
}

function appendImportAction(container: Element): HTMLButtonElement {
    const action = document.createElement("button");
    action.dataset.oaamAction = "start-guided-import";
    action.addEventListener("click", () => {
        document.body.innerHTML = `<main data-oaam-route="guided_import" data-oaam-step="locations"
            data-oaam-target-project-id="${PROJECT_ID}"></main>`;
    });
    container.append(action);
    return action;
}

function appendDestinationControl(
    card: HTMLElement,
    options: { readonly projectChecked: boolean; readonly globalChecked: boolean },
): HTMLElement {
    const destination = document.createElement("div");
    destination.className = "source-watch-destination";
    destination.dataset.oaamSourceDestination = "project";
    const globalChoice = document.createElement("label");
    globalChoice.dataset.oaamSourceDestinationChoice = "global";
    globalChoice.dataset.checked = String(options.globalChecked);
    const globalInput = document.createElement("input");
    globalInput.type = "radio";
    globalInput.value = "global";
    globalInput.checked = options.globalChecked;
    globalChoice.append(globalInput);
    const projectChoice = document.createElement("label");
    projectChoice.dataset.oaamSourceDestinationChoice = "project";
    projectChoice.dataset.checked = String(options.projectChecked);
    const projectInput = document.createElement("input");
    projectInput.type = "radio";
    projectInput.value = "project";
    projectInput.checked = options.projectChecked;
    projectChoice.append(projectInput);
    destination.append(globalChoice, projectChoice);
    card.append(destination);
    return destination;
}

function renderProjectSourceReview(options: {
    readonly state: "ignored" | "included";
    readonly selected: boolean;
    readonly watchSelected?: boolean;
    readonly destination?: { readonly projectChecked: boolean; readonly globalChecked: boolean };
    readonly onRestore?: (card: HTMLElement) => void;
}): HTMLElement {
    document.body.innerHTML = `
        <main data-oaam-route="guided_import" data-oaam-step="sources"
            data-oaam-target-project-id="${PROJECT_ID}">
            <div class="discovery-workspace" data-oaam-journey-stage="sources"
                data-oaam-discovery-activity="idle" data-oaam-target-project-id="${PROJECT_ID}">
                <article class="source-review-card" data-oaam-source-path="${PROJECT_SOURCE}"
                    data-oaam-source-state="${options.state}"
                    data-oaam-source-selected="${String(options.selected)}"
                    data-oaam-source-watch-selected="${String(options.watchSelected ?? false)}">
                    <button type="button" data-oaam-source-action="restore">Restore</button>
                </article>
            </div>
        </main>`;
    const card = document.querySelector<HTMLElement>(".source-review-card[data-oaam-source-path]");
    if (card === null || card.dataset.oaamSourcePath !== PROJECT_SOURCE) {
        throw new Error("packaged Asset-usage source fixture is incomplete");
    }
    if (options.destination !== undefined) appendDestinationControl(card, options.destination);
    card.querySelector('[data-oaam-source-action="restore"]')?.addEventListener("click", () => options.onRestore?.(card));
    return card;
}

function executeEntryScript(script: string): Promise<unknown> {
    return Promise.resolve(
        runInNewContext(script, {
            Date,
            document,
            HTMLButtonElement,
            HTMLInputElement,
            HTMLElement,
            Promise,
            setTimeout,
        }) as unknown,
    );
}

function executeThroughSourceRestore(scriptExecution: (script: string) => Promise<unknown>) {
    const values = successfulExecutionValues();
    let invocationCount = 0;
    return vi.fn(async (script: string) => {
        const index = invocationCount++;
        if (index < 4) return values[index];
        if (index === 4) return scriptExecution(script);
        throw new Error("stop after the exact Project source restore");
    });
}

function executeThroughProjectAssetOpen(scriptExecution: (script: string) => Promise<unknown>) {
    const values = successfulExecutionValues();
    let invocationCount = 0;
    return vi.fn(async (script: string) => {
        const index = invocationCount++;
        if (index < 7) return values[index];
        if (index === 7) return scriptExecution(script);
        throw new Error("stop after the exact Project Asset opened");
    });
}

function executeThroughRelationshipCheck(scriptExecution: (script: string) => Promise<unknown>) {
    const values = successfulExecutionValues();
    let invocationCount = 0;
    return vi.fn(async (script: string) => {
        const index = invocationCount++;
        if (index < 7) return values[index];
        if (index === 7 || index === 8) return scriptExecution(script);
        throw new Error("stop after the exact Asset-usage relationship");
    });
}

function renderCompletedProjectImport(onProjectLibrary: (library: HTMLElement) => void): void {
    document.body.innerHTML = `
        <main data-oaam-route="guided_import" data-oaam-step="complete">
            <div class="onboarding-completion">
                <div class="onboarding-actions"><button type="button">Done</button></div>
            </div>
        </main>`;
    const done = document.querySelector<HTMLButtonElement>(".onboarding-completion .onboarding-actions button");
    if (done === null) throw new Error("packaged Asset-usage completion fixture is incomplete");
    done.addEventListener("click", () => {
        document.body.innerHTML = `
            <main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready"
                data-oaam-project-id="${PROJECT_ID}"></main>`;
        const library = document.querySelector<HTMLElement>('main[data-oaam-route="library"]');
        if (library === null) throw new Error("packaged Project library fixture is incomplete");
        onProjectLibrary(library);
    });
}

function renderProjectGuidanceCollection(
    library: HTMLElement,
    options: {
        readonly state: "loading" | "ready";
        readonly revision?: number;
        readonly includeAsset?: boolean;
        readonly targetState?: "failed" | "loading" | "ready";
        readonly onTargetRendered?: (workspace: HTMLElement) => void;
    },
): void {
    library.innerHTML = `
        <section class="asset-collection" data-oaam-collection-id="project" data-oaam-total-count="${
            options.includeAsset === false ? 0 : 1
        }">
            ${
                options.includeAsset === false
                    ? ""
                    : `<section class="asset-kind-group" data-oaam-asset-kind="Guidance">
                        ${
                            options.state === "loading"
                                ? '<div class="library-empty-inline" role="status" aria-busy="true">Loading</div>'
                                : `<div class="asset-library-item" data-oaam-asset-id="${ASSET_ID}"
                                    data-status="complete" data-oaam-revision="${options.revision ?? 1}">
                                    <span class="asset-library-main"><strong>AGENTS.md</strong></span>
                                    <button type="button"
                                        data-oaam-semantic-action="library.open_asset_deployment">Use</button>
                                </div>`
                        }
                    </section>`
            }
        </section>`;
    const open = library.querySelector<HTMLButtonElement>('[data-oaam-semantic-action="library.open_asset_deployment"]');
    open?.addEventListener("click", () => {
        const targetState = options.targetState ?? "ready";
        document.body.innerHTML = `
            <main data-oaam-route="deployment" data-oaam-subject="project" data-oaam-state="${targetState}"
                data-oaam-deployment-mode="create"
                data-oaam-project-id="${PROJECT_ID}" data-oaam-asset-id="${ASSET_ID}">
                <div class="catalog-deployment-workspace" data-oaam-deployment-workspace-state="ready"
                    data-oaam-deployment-count="0"></div>
            </main>`;
        const workspace = document.querySelector<HTMLElement>(
            '.catalog-deployment-workspace[data-oaam-deployment-workspace-state="ready"]',
        );
        if (workspace === null) throw new Error("packaged Project tool-check fixture is incomplete");
        renderProjectToolCheck(workspace, targetState);
        options.onTargetRendered?.(workspace);
    });
}

function renderProjectToolCheck(workspace: HTMLElement, state: "failed" | "loading" | "ready"): void {
    const deployment = workspace.closest<HTMLElement>('main[data-oaam-route="deployment"]');
    if (deployment === null) throw new Error("packaged Project tool-check fixture lost its deployment page");
    deployment.dataset.oaamState = state;
    if (state !== "ready") {
        workspace.innerHTML = `<div class="deployment-target-discovery" data-oaam-state="${state}">
            ${state === "failed" ? '<div role="alert">Project tool check unavailable</div>' : ""}
        </div>`;
        return;
    }
    workspace.innerHTML = `
        <section class="workbench-panel deployment-target-discovery" aria-labelledby="deployment-target-title">
            <fieldset class="deployment-target-providers">
                <legend>Tools</legend>
                <label class="workbench-check-button" data-checked="true"
                    data-oaam-interaction-entry="pages.deployment_page.002">
                    <input class="workbench-semantic-input" type="checkbox" checked>
                    <span class="workbench-selection-indicator" aria-hidden="true"></span>
                    <span>OpenCode</span>
                </label>
                <label class="workbench-check-button" data-checked="true"
                    data-oaam-interaction-entry="pages.deployment_page.002">
                    <input class="workbench-semantic-input" type="checkbox" checked>
                    <span class="workbench-selection-indicator" aria-hidden="true"></span>
                    <span>Codex</span>
                </label>
            </fieldset>
            <fieldset>
                <legend>Environment</legend>
                <label class="workbench-radio-button" data-checked="true"
                    data-oaam-interaction-entry="pages.deployment_page.003">
                    <input class="workbench-semantic-input" type="radio" name="deployment-project-environment"
                        checked>
                    <span class="workbench-radio-indicator" aria-hidden="true"></span>
                    <span>Windows</span>
                </label>
            </fieldset>
            <div class="deployment-target-actions">
                <button type="button" data-oaam-target-action="probe">Check</button>
            </div>
        </section>`;
    const environment = workspace.querySelector<HTMLInputElement>('input[name="deployment-project-environment"]');
    if (environment === null) throw new Error("packaged Project tool-check fixture lost its environment choice");
    environment.value = WINDOWS_FORM_VALUE;
    for (const input of workspace.querySelectorAll<HTMLInputElement>(
        '.deployment-target-providers input.workbench-semantic-input[type="checkbox"]',
    )) {
        input.addEventListener("change", () => {
            const label = input.closest<HTMLElement>("label.workbench-check-button");
            if (label !== null) label.dataset.checked = String(input.checked);
        });
    }
}

function renderProjectAssetUsageRelationships(
    workspace: HTMLElement,
    state: "loading" | "ready",
    options: { readonly includeExactRuntime?: boolean } = {},
): void {
    workspace.querySelector(".asset-usage-relationships")?.remove();
    const panel = document.createElement("section");
    panel.className = "workbench-panel deployment-journey-step asset-usage-relationships";
    panel.dataset.oaamDeploymentStep = "relationships";
    panel.dataset.oaamAssetUsageState = state;
    const exactRuntime =
        options.includeExactRuntime === false
            ? ""
            : `
        <li class="asset-usage-row" data-oaam-asset-usage-analysis="${state === "ready" ? "complete" : "checking"}"
            data-oaam-asset-usage-capability="${state === "ready" ? "direct" : "unavailable"}"
            data-oaam-asset-usage-target-state="${state === "ready" ? "already_usable" : "unknown"}"
            data-oaam-asset-usage-managed="none">
            <div class="asset-usage-row-copy">
                <div class="asset-usage-row-title"><strong>OpenCode CLI</strong>
                    <span class="asset-usage-status">${state === "ready" ? "Already available" : "Checking"}</span>
                </div>
                <p>${
                    state === "ready"
                        ? "This tool already reads the current Version file. No file changes are needed."
                        : "Checking the current file."
                }</p>
            </div>
        </li>`;
    panel.innerHTML = `
        <ul class="asset-usage-list">
            <li class="asset-usage-row" data-oaam-asset-usage-analysis="complete"
                data-oaam-asset-usage-capability="unavailable"
                data-oaam-asset-usage-target-state="unknown" data-oaam-asset-usage-managed="none">
                <div class="asset-usage-row-copy">
                    <div class="asset-usage-row-title"><strong>OpenCode App</strong>
                        <span class="asset-usage-status">Unavailable</span>
                    </div>
                    <p>No verified App entry is available.</p>
                </div>
            </li>
            ${exactRuntime}
        </ul>`;
    workspace.append(panel);
}

function startAssetUsageEntryProof(
    executeJavaScript: (script: string) => Promise<unknown>,
    recordTerminalObservation: (receipt: unknown) => void = () => undefined,
) {
    return proveWindowsPackagedAlreadyUsableAssetUi({ executeJavaScript }, projectRegistration(), {
        capture: async () => undefined,
        readAuthoritySnapshot: authoritySnapshot,
        recordAuthorityChange: () => undefined,
        recordTerminalObservation,
        authorityQuiescenceDeadlineMilliseconds: 100,
        authorityQuiescencePollIntervalMilliseconds: 1,
    });
}

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe("packaged already-usable Asset relationship proof", () => {
    it("proves one exact OpenCode relationship without creating Deployment authority", async () => {
        const executeJavaScript = stagedExecution();
        const capture = vi.fn(async () => undefined);
        const readAuthoritySnapshot = vi.fn(() => authoritySnapshot());

        await expect(
            proveWindowsPackagedAlreadyUsableAssetUi({ executeJavaScript }, projectRegistration(), {
                capture,
                readAuthoritySnapshot,
                recordAuthorityChange: vi.fn(),
                recordTerminalObservation: vi.fn(),
                authorityQuiescenceDeadlineMilliseconds: 100,
                authorityQuiescencePollIntervalMilliseconds: 1,
            }),
        ).resolves.toMatchObject({
            status: "complete",
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            sourcePath: PROJECT_SOURCE,
            agentRuntimeLabel: "OpenCode CLI",
            capability: "direct",
            observedTargetState: "already_usable",
            managedState: "none",
            deploymentCountBefore: 0,
            deploymentCountAfter: 0,
            createDeploymentReviewActionCount: 0,
            authorityUnchanged: true,
            observabilityChanged: false,
            authorityDelta: {
                authorityChanged: false,
                businessAuthorityChanged: false,
                preferencesChanged: false,
                coordinationChanged: false,
                observabilityChanged: false,
            },
        });

        expect(executeJavaScript).toHaveBeenCalledTimes(10);
        expect(capture).toHaveBeenCalledTimes(1);
        expect(readAuthoritySnapshot).toHaveBeenCalledTimes(3);
        expect(String(executeJavaScript.mock.calls[0]?.[0])).toContain("the exact registered Project library");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain("oaamSourceWatchSelected");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain("optional future-scan destination");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).not.toContain("card.dataset.oaamSourceDestination");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain("the imported AGENTS Asset has no tool-usage action");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain('data-oaam-asset-kind="Guidance"');
        expect(String(executeJavaScript.mock.calls[7]?.[0])).not.toContain("toLocaleLowerCase");
        expect(String(executeJavaScript.mock.calls[8]?.[0])).toContain("direct already-usable unmanaged relation");
        expect(String(executeJavaScript.mock.calls[8]?.[0])).toContain(".replace(/\\s+/gu");
        expect(String(executeJavaScript.mock.calls[8]?.[0])).toContain("create_deployment_review_intent");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("safe return to the Project library");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("lastObservation");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("elapsedMilliseconds");
    });

    it("takes the post-check authority snapshot before writing the screenshot", async () => {
        const order: string[] = [];
        const readAuthoritySnapshot = vi.fn(() => {
            order.push("snapshot");
            return authoritySnapshot();
        });
        const capture = vi.fn(async () => {
            order.push("capture");
        });

        await proveWindowsPackagedAlreadyUsableAssetUi({ executeJavaScript: stagedExecution() }, projectRegistration(), {
            capture,
            readAuthoritySnapshot,
            recordAuthorityChange: vi.fn(),
            recordTerminalObservation: vi.fn(),
            authorityQuiescenceDeadlineMilliseconds: 100,
            authorityQuiescencePollIntervalMilliseconds: 1,
        });

        expect(order).toEqual(["snapshot", "snapshot", "snapshot", "capture"]);
    });

    it("rejects malformed target and relationship receipts", async () => {
        const malformedTarget = [...successfulExecutionValues()];
        malformedTarget[7] = { status: "ready", projectId: PROJECT_ID, assetId: ASSET_ID, assetRevision: 2 };
        await expect(
            proveWindowsPackagedAlreadyUsableAssetUi(
                { executeJavaScript: stagedExecution(malformedTarget) },
                projectRegistration(),
                {
                    capture: vi.fn(async () => undefined),
                    readAuthoritySnapshot: () => authoritySnapshot(),
                    recordAuthorityChange: vi.fn(),
                    recordTerminalObservation: vi.fn(),
                },
            ),
        ).rejects.toThrow("invalid packaged Project AGENTS entry proof");

        const malformedRelationship = [...successfulExecutionValues()];
        malformedRelationship[8] = {
            ...(malformedRelationship[8] as Record<string, unknown>),
            createDeploymentReviewActionCount: 1,
        };
        await expect(
            proveWindowsPackagedAlreadyUsableAssetUi(
                { executeJavaScript: stagedExecution(malformedRelationship) },
                projectRegistration(),
                {
                    capture: vi.fn(async () => undefined),
                    readAuthoritySnapshot: () => authoritySnapshot(),
                    recordAuthorityChange: vi.fn(),
                    recordTerminalObservation: vi.fn(),
                },
            ),
        ).rejects.toThrow("invalid packaged already-usable Asset relationship proof");

        const malformedReturn = [...successfulExecutionValues()];
        malformedReturn[9] = { status: "ready" };
        await expect(
            proveWindowsPackagedAlreadyUsableAssetUi(
                { executeJavaScript: stagedExecution(malformedReturn) },
                projectRegistration(),
                {
                    capture: vi.fn(async () => undefined),
                    readAuthoritySnapshot: () => authoritySnapshot(),
                    recordAuthorityChange: vi.fn(),
                    recordTerminalObservation: vi.fn(),
                },
            ),
        ).rejects.toThrow("invalid packaged Project library return proof");

        const observation = {
            alerts: [],
            deployment: null,
            deploymentRootCount: 1,
            exactRuntimeRow: null,
            exactRuntimeRowCount: 0,
            relationshipPanelCount: 0,
            selectedEnvironmentValues: [],
            selectedProviderLabels: [],
            targetDiscoveryCount: 1,
            usageState: "loading",
            workspace: null,
        };
        const terminal = {
            schemaVersion: 1,
            status: "terminal",
            stage: "project_asset_usage_relationship",
            terminalKind: "deadline_exceeded",
            message: "relationship stayed loading",
            elapsedMilliseconds: 120_000,
            pollCount: 2_401,
            lastObservation: observation,
        };
        const { alerts: _alerts, ...incompleteObservation } = observation;
        const malformedTerminals = [
            [{ ...terminal, unexpected: true }, "invalid packaged Asset-usage terminal observation"],
            [{ ...terminal, lastObservation: [] }, "invalid packaged Asset-usage terminal observation"],
            [{ ...terminal, lastObservation: incompleteObservation }, "incomplete packaged Asset-usage terminal observation"],
        ] as const;
        for (const [receipt, message] of malformedTerminals) {
            const values = [...successfulExecutionValues()];
            values[8] = receipt;
            const error = await startAssetUsageEntryProof(stagedExecution(values)).then(
                () => undefined,
                (failure: unknown) => failure,
            );
            expect(error).toBeInstanceOf(TypeError);
            expect(error).toHaveProperty("message", message);
        }
    });
});

describe("packaged Asset-usage Project import entry", () => {
    it("waits for the exact Project import action to appear asynchronously", async () => {
        const library = renderProjectLibrary();
        const actions = library.querySelector("[data-import-actions]");
        if (actions === null) throw new Error("packaged Asset-usage action fixture is missing");
        setTimeout(() => appendImportAction(actions), 10);
        let invocationCount = 0;
        const executeJavaScript = vi.fn(async (script: string) => {
            invocationCount += 1;
            if (invocationCount === 1) return executeEntryScript(script);
            throw new Error("stop after the Project import entry");
        });

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow("stop after the Project import entry");

        expect(executeJavaScript).toHaveBeenCalledTimes(2);
        expect(
            document.querySelector(
                `main[data-oaam-route="guided_import"][data-oaam-step="locations"]` +
                    `[data-oaam-target-project-id="${PROJECT_ID}"]`,
            ),
        ).toBeInstanceOf(HTMLElement);
    });

    it("rejects multiple enabled import actions without waiting", async () => {
        vi.useFakeTimers();
        const library = renderProjectLibrary();
        const actions = library.querySelector("[data-import-actions]");
        if (actions === null) throw new Error("packaged Asset-usage action fixture is missing");
        appendImportAction(actions);
        appendImportAction(actions);
        const executeJavaScript = vi.fn(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the exact registered Project has ambiguous import actions",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("times out within the shared bound when the import action never appears", async () => {
        vi.useFakeTimers();
        renderProjectLibrary();
        const executeJavaScript = vi.fn(executeEntryScript);
        const pending = startAssetUsageEntryProof(executeJavaScript);
        const rejection = expect(pending).rejects.toThrow(
            "timed out waiting for the exact registered Project's unique import action",
        );

        await vi.advanceTimersByTimeAsync(45_050);
        await rejection;

        expect(executeJavaScript).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("packaged Asset-usage exact Project source restore", () => {
    it("waits for a restored current-scan source without requiring future-scan controls", async () => {
        const card = renderProjectSourceReview({
            state: "ignored",
            selected: false,
            onRestore(current) {
                setTimeout(() => {
                    current.dataset.oaamSourceState = "included";
                    current.dataset.oaamSourceSelected = "true";
                }, 5);
            },
        });
        const executeJavaScript = executeThroughSourceRestore(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow("stop after the exact Project source restore");

        expect(executeJavaScript).toHaveBeenCalledTimes(6);
        expect(card.dataset.oaamSourceState).toBe("included");
        expect(card.dataset.oaamSourceSelected).toBe("true");
        expect(card.querySelector(".source-watch-destination")).toBeNull();
    });

    it("waits for a future-scan destination to become internally coherent", async () => {
        const card = renderProjectSourceReview({
            state: "ignored",
            selected: false,
            watchSelected: true,
            onRestore(current) {
                setTimeout(() => {
                    current.dataset.oaamSourceState = "included";
                    current.dataset.oaamSourceSelected = "true";
                }, 5);
                setTimeout(() => appendDestinationControl(current, { projectChecked: true, globalChecked: false }), 10);
            },
        });
        const executeJavaScript = executeThroughSourceRestore(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow("stop after the exact Project source restore");

        expect(card.querySelector('[data-oaam-source-destination-choice="project"] input[type="radio"]')).toHaveProperty(
            "checked",
            true,
        );
        expect(card.querySelector('[data-oaam-source-destination-choice="global"] input[type="radio"]')).toHaveProperty(
            "checked",
            false,
        );
    });

    it("accepts a Global future-scan binding without confusing it with the current Project import", async () => {
        renderProjectSourceReview({
            state: "included",
            selected: true,
            watchSelected: true,
            destination: { projectChecked: false, globalChecked: true },
        });
        const executeJavaScript = executeThroughSourceRestore(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow("stop after the exact Project source restore");

        expect(executeJavaScript).toHaveBeenCalledTimes(6);
    });

    it("rejects ambiguous enabled future-scan destination controls immediately", async () => {
        vi.useFakeTimers();
        const card = renderProjectSourceReview({
            state: "included",
            selected: true,
            watchSelected: true,
            destination: { projectChecked: true, globalChecked: false },
        });
        appendDestinationControl(card, { projectChecked: true, globalChecked: false });
        const executeJavaScript = executeThroughSourceRestore(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the exact Project source has multiple future-scan destination controls",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(5);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects a missing destination control only when future scanning is enabled", async () => {
        vi.useFakeTimers();
        renderProjectSourceReview({ state: "included", selected: true, watchSelected: true });
        const executeJavaScript = executeThroughSourceRestore(executeEntryScript);
        const pending = startAssetUsageEntryProof(executeJavaScript);
        const rejection = expect(pending).rejects.toThrow(
            "the exact Project source enables future scans but has no unique destination control",
        );

        await vi.advanceTimersByTimeAsync(30_050);
        await rejection;

        expect(executeJavaScript).toHaveBeenCalledTimes(5);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("packaged Asset-usage Project collection readiness", () => {
    it("waits through a missing route collection and delayed Guidance kind load", async () => {
        renderCompletedProjectImport((library) => {
            setTimeout(() => renderProjectGuidanceCollection(library, { state: "loading" }), 10);
            setTimeout(() => renderProjectGuidanceCollection(library, { state: "ready", revision: 1 }), 40);
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow("stop after the exact Project Asset opened");

        expect(executeJavaScript).toHaveBeenCalledTimes(9);
        expect(
            document.querySelector(
                `main[data-oaam-route="deployment"][data-oaam-project-id="${PROJECT_ID}"]` + `[data-oaam-asset-id="${ASSET_ID}"]`,
            ),
        ).toBeInstanceOf(HTMLElement);
        const target = document.querySelector<HTMLElement>("section.workbench-panel.deployment-target-discovery");
        expect(target).toBeInstanceOf(HTMLElement);
        expect(target?.hasAttribute("data-oaam-state")).toBe(false);
        const providerRows = [...document.querySelectorAll<HTMLLabelElement>(".deployment-target-providers label")];
        expect(providerRows.map((row) => ({ label: row.textContent?.trim(), checked: row.dataset.checked }))).toEqual([
            { label: "OpenCode", checked: "true" },
            { label: "Codex", checked: "false" },
        ]);
    });

    it("waits through the production loading Project tool check before accepting its ready structure", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, {
                state: "ready",
                targetState: "loading",
                onTargetRendered(workspace) {
                    setTimeout(() => renderProjectToolCheck(workspace, "ready"), 10);
                },
            });
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow("stop after the exact Project Asset opened");

        expect(document.querySelector(".deployment-target-discovery[data-oaam-state]")).toBeNull();
        expect(document.querySelector("section.workbench-panel.deployment-target-discovery")).toBeInstanceOf(HTMLElement);
    });

    it("rejects the production failed Project tool check instead of treating it as ready", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, { state: "ready", targetState: "failed" });
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the Project tool check failed to load: Project tool check unavailable",
        );
    });

    it("rejects a ready-looking Project tool check without the exact OpenCode selection", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, {
                state: "ready",
                onTargetRendered(workspace) {
                    const label = workspace.querySelector(
                        ".deployment-target-providers .workbench-check-button > span:last-child",
                    );
                    if (label !== null) label.textContent = "Claude Code";
                },
            });
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the Project tool check did not expose one exact OpenCode Provider",
        );
    });

    it("rejects a ready-looking Project tool check bound to a different environment", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, {
                state: "ready",
                onTargetRendered(workspace) {
                    const environment = workspace.querySelector<HTMLInputElement>('input[name="deployment-project-environment"]');
                    if (environment !== null) environment.value = "wsl\0Ubuntu";
                },
            });
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the Project tool check does not retain the exact Project environment",
        );
    });

    it("rejects a genuinely complete Project collection without Guidance", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, { state: "ready", includeAsset: false });
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the completed Project collection contains no Guidance assets",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(8);
    });

    it("stops immediately when the exact Project Asset browser reports a failure", async () => {
        renderCompletedProjectImport((library) => {
            library.innerHTML = `
                <section class="asset-browser"><div role="alert">Project assets unavailable</div></section>`;
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the exact Project Asset library failed to load: Project assets unavailable",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(8);
    });

    it("rejects AGENTS.md at the wrong imported revision after Guidance is ready", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, { state: "ready", revision: 2 });
        });
        const executeJavaScript = executeThroughProjectAssetOpen(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the imported AGENTS Asset is not at exact revision 1",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(8);
    });

    it("waits for the exact OpenCode CLI relationship instead of failing on an earlier unavailable App row", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, {
                state: "ready",
                onTargetRendered(workspace) {
                    const probe = workspace.querySelector<HTMLButtonElement>('[data-oaam-target-action="probe"]');
                    probe?.addEventListener("click", () => {
                        renderProjectAssetUsageRelationships(workspace, "loading");
                        setTimeout(() => renderProjectAssetUsageRelationships(workspace, "ready"), 20);
                    });
                },
            });
        });
        const executeJavaScript = executeThroughRelationshipCheck(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "stop after the exact Asset-usage relationship",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(10);
        expect(
            document.querySelector(
                '.asset-usage-row[data-oaam-asset-usage-analysis="complete"]' +
                    '[data-oaam-asset-usage-target-state="already_usable"]',
            ),
        ).toBeInstanceOf(HTMLElement);
    });

    it("rejects a ready relationship surface without the exact OpenCode CLI row", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, {
                state: "ready",
                onTargetRendered(workspace) {
                    const probe = workspace.querySelector<HTMLButtonElement>('[data-oaam-target-action="probe"]');
                    probe?.addEventListener("click", () =>
                        renderProjectAssetUsageRelationships(workspace, "ready", { includeExactRuntime: false }),
                    );
                },
            });
        });
        const executeJavaScript = executeThroughRelationshipCheck(executeEntryScript);

        await expect(startAssetUsageEntryProof(executeJavaScript)).rejects.toThrow(
            "the Project Asset-usage analysis did not retain one exact OpenCode CLI row",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(9);
    });

    it("preserves the exact raw row state when a relationship reaches a non-complete terminal", async () => {
        renderCompletedProjectImport((library) => {
            renderProjectGuidanceCollection(library, {
                state: "ready",
                onTargetRendered(workspace) {
                    const probe = workspace.querySelector<HTMLButtonElement>('[data-oaam-target-action="probe"]');
                    probe?.addEventListener("click", () => {
                        renderProjectAssetUsageRelationships(workspace, "ready");
                        const exact = [...workspace.querySelectorAll<HTMLElement>(".asset-usage-row")].find(
                            (row) => row.querySelector(".asset-usage-row-title > strong")?.textContent === "OpenCode CLI",
                        );
                        if (exact === undefined) throw new Error("packaged terminal-state fixture lost OpenCode CLI");
                        exact.dataset.oaamAssetUsageAnalysis = "verification_failed";
                        exact.dataset.oaamAssetUsageCapability = "unavailable";
                        exact.dataset.oaamAssetUsageTargetState = "unknown";
                        const status = exact.querySelector(".asset-usage-status");
                        const detail = exact.querySelector(".asset-usage-row-copy > p");
                        if (status !== null) status.textContent = "Could not verify";
                        if (detail !== null) detail.textContent = "The exact target could not be verified.";
                    });
                },
            });
        });
        const executeJavaScript = executeThroughRelationshipCheck(executeEntryScript);
        const recordTerminalObservation = vi.fn();

        await expect(startAssetUsageEntryProof(executeJavaScript, recordTerminalObservation)).rejects.toThrow(
            "the exact OpenCode CLI Asset-usage row did not reach a complete result",
        );

        expect(executeJavaScript).toHaveBeenCalledTimes(9);
        expect(recordTerminalObservation).toHaveBeenCalledWith(
            expect.objectContaining({
                stage: "project_asset_usage_relationship",
                terminalKind: "terminal_state",
                lastObservation: expect.objectContaining({
                    relationshipPanelCount: 1,
                    usageState: "ready",
                    exactRuntimeRow: expect.objectContaining({
                        agentRuntimeLabel: "OpenCode CLI",
                        analysis: "verification_failed",
                        capability: "unavailable",
                        observedTargetState: "unknown",
                    }),
                }),
            }),
        );
    });
});
