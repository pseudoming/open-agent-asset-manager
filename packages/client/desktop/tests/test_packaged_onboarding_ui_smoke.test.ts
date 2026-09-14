import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePackagedAssetReview } from "../src/main/packaged-import-review-ui-smoke";
import {
    PACKAGED_ASSET_USAGE_AUTHORITY_CHANGE_RECEIPT,
    PackagedOnboardingScreenshotProof,
    type PackagedOnboardingScreenshotWebContents,
} from "../src/main/packaged-onboarding-screenshot-proof";
import {
    PACKAGED_ONBOARDING_SCREENSHOT_STAGES,
    type PackagedOnboardingUiProof,
    proveWindowsPackagedOnboardingUi,
} from "../src/main/packaged-onboarding-ui-smoke";
import {
    completePackagedProjectRegistration,
    openPackagedProjectRegistration,
} from "../src/main/packaged-project-registration-ui-smoke";
import { reviewPackagedPhysicalSources } from "../src/main/packaged-source-review-ui-smoke";

const WINDOWS = JSON.stringify(["win32", "desktop-local"]);
const WSL = JSON.stringify(["wsl", "Ubuntu"]);
const WSL_SOURCE = "\\\\wsl.localhost\\Ubuntu\\home\\example\\.claude";
const NATIVE_SOURCE = "C:\\proof\\home\\.claude";
const COMPATIBLE_SOURCE = "C:\\proof\\home\\.agents\\skills";
const PROJECT_SOURCE = "C:\\proof\\home\\project";
const PROJECT_NAME = "project";
const SUBMITTED_PROJECT_NAME = `${PROJECT_NAME} — OAAM package proof`;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function authoritySnapshot() {
    return {
        businessAuthorityEntryCount: 3,
        businessAuthorityTreeFingerprint: "a".repeat(64),
        businessAuthorityManifest: [
            { relativePath: "oaam.sqlite", kind: "file", size: 8, sha256: "c".repeat(64) },
            { relativePath: "versions", kind: "directory", size: null, sha256: null },
            { relativePath: "versions/asset.bin", kind: "file", size: 5, sha256: "d".repeat(64) },
        ],
        observabilityEntryCount: 0,
        observabilityTreeFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        observabilityManifest: [],
        desktopPreferencesFingerprint: "b".repeat(64),
        desktopPreferences: {
            schemaVersion: 4,
            onboardingCompleted: true,
            lastSelectedProjectId: PROJECT_ID,
            assetLayout: "list",
        },
        coordinationPaths: ["oaam.sqlite-shm"],
    } as const;
}

function authorityDelta() {
    return {
        authorityChanged: false,
        businessAuthorityChanged: false,
        preferencesChanged: false,
        coordinationChanged: false,
        observabilityChanged: false,
        businessAuthority: { fingerprintChanged: false, added: [], removed: [], changed: [] },
        preferences: { fingerprintChanged: false, changedFields: [] },
        coordination: { added: [], removed: [] },
        observability: {
            fingerprintChanged: false,
            added: [],
            removed: [],
            changed: [],
            validDurableReplacementGrowth: false,
            durableReplacement: null,
        },
    } as const;
}

function assetUsageProof() {
    return {
        status: "complete" as const,
        projectId: PROJECT_ID,
        assetId: ASSET_ID,
        assetRevision: 1 as const,
        sourcePath: PROJECT_SOURCE,
        agentRuntimeLabel: "OpenCode CLI",
        capability: "direct" as const,
        observedTargetState: "already_usable" as const,
        managedState: "none" as const,
        ordinaryStatusText: "Already available",
        ordinaryDetailText: "This tool already reads the current Version file. No file changes are needed.",
        deploymentCountBefore: 0 as const,
        deploymentCountAfter: 0 as const,
        createDeploymentReviewActionCount: 0 as const,
        observedRows: [
            {
                capability: "direct",
                observedTargetState: "already_usable",
                managedState: "none",
                hasWriteReviewAction: false,
            },
        ],
        authorityBefore: authoritySnapshot(),
        authorityAfter: authoritySnapshot(),
        authorityDelta: authorityDelta(),
        authorityUnchanged: true as const,
        observabilityChanged: false,
    };
}

function projectRegistrationTimeline() {
    return [
        { sequence: 0, state: "poll_started", observedAt: 1_000, elapsedMilliseconds: 0 },
        { sequence: 1, state: "source_review_visible", observedAt: 1_010, elapsedMilliseconds: 10 },
        { sequence: 2, state: "actionable_project_ready", observedAt: 1_020, elapsedMilliseconds: 20 },
        { sequence: 3, state: "dialog_ready", observedAt: 1_030, elapsedMilliseconds: 30 },
    ] as const;
}

function projectRegistrationReady() {
    return {
        status: "ready",
        proposalKey: "project-proposal",
        sourcePath: PROJECT_SOURCE,
        initialDisplayName: PROJECT_NAME,
        submittedDisplayName: SUBMITTED_PROJECT_NAME,
        matchedSourceCard: true,
        dialogId: "discovery_project_registration",
        timeline: projectRegistrationTimeline(),
    };
}

function projectRegistrationProof() {
    return {
        status: "complete",
        proposalKey: "project-proposal",
        sourcePath: PROJECT_SOURCE,
        initialDisplayName: PROJECT_NAME,
        submittedDisplayName: SUBMITTED_PROJECT_NAME,
        matchedSourceCard: true,
        dialogId: "discovery_project_registration",
        dialogClosed: true,
        proposalResolved: true,
        sourceDestination: "project",
        sourceReviewTimeline: projectRegistrationTimeline(),
    };
}

function environmentProof() {
    return {
        status: "complete",
        defaultEnvironment: WINDOWS,
        selectedEnvironments: [WINDOWS, WSL],
        probedEnvironments: [WINDOWS, WSL],
        environmentResultStatuses: [
            [WINDOWS, "complete"],
            [WSL, "partial"],
        ],
        selectedWslHomeSourcePath: WSL_SOURCE,
    };
}

function locationProof() {
    return {
        status: "ready",
        defaultEnvironment: WINDOWS,
        selectedEnvironments: [WINDOWS, WSL],
    };
}

function toolProof() {
    return {
        status: "ready",
        selectedAdapterIds: ["CLAUDECODE", "OPENCODE"],
    };
}

function sourceProof(selectionMode: "native_primary" | "compatible_only", selectedSourcePath: string) {
    return {
        status: "complete",
        selectionMode,
        selectedSourcePath,
        sourceCardCount: 2,
        nativeSourcePath: NATIVE_SOURCE,
        nativeRelationshipKinds: ["native", "compatible_shared"],
        compatibleOnlySourcePath: COMPATIBLE_SOURCE,
        compatibleOnlyRelationshipKinds: ["compatible_shared"],
        compatibleOnlyInitialState: selectionMode === "native_primary" ? "included" : "ignored",
        restoredSelectedSource: selectionMode === "compatible_only",
        checkboxCount: 0,
        confirmationObserved: true,
        ignoredCardCount: 1,
        usesConfirmedIgnore: true,
    };
}

function exactUiProof(): PackagedOnboardingUiProof {
    return {
        status: "complete",
        firstRun: {
            projectRegistration: projectRegistrationProof(),
            source: {
                selectionMode: "native_primary",
                selectedSourcePath: NATIVE_SOURCE,
                sourceCardCount: 2,
                nativeSourcePath: NATIVE_SOURCE,
                nativeRelationshipKinds: ["native", "compatible_shared"],
                compatibleOnlySourcePath: COMPATIBLE_SOURCE,
                compatibleOnlyRelationshipKinds: ["compatible_shared"],
                compatibleOnlyInitialState: "included",
                restoredSelectedSource: false,
                checkboxCount: 0,
                confirmationObserved: true,
                ignoredCardCount: 1,
                usesConfirmedIgnore: true,
            },
            candidateCount: 1,
            importedCandidateCount: 1,
            finalAssetCount: 1,
            visibleGlobalAssetCount: 1,
        },
        guidedImport: {
            source: {
                selectionMode: "compatible_only",
                selectedSourcePath: COMPATIBLE_SOURCE,
                sourceCardCount: 2,
                nativeSourcePath: NATIVE_SOURCE,
                nativeRelationshipKinds: ["native", "compatible_shared"],
                compatibleOnlySourcePath: COMPATIBLE_SOURCE,
                compatibleOnlyRelationshipKinds: ["compatible_shared"],
                compatibleOnlyInitialState: "ignored",
                restoredSelectedSource: true,
                checkboxCount: 0,
                confirmationObserved: true,
                ignoredCardCount: 1,
                usesConfirmedIgnore: true,
            },
            candidateCount: 1,
            importedCandidateCount: 1,
            finalAssetCount: 2,
        },
        assetUsage: assetUsageProof(),
    };
}

function successfulExecutionValues(): readonly unknown[] {
    return [
        locationProof(),
        toolProof(),
        environmentProof(),
        projectRegistrationReady(),
        projectRegistrationProof(),
        sourceProof("native_primary", NATIVE_SOURCE),
        { status: "complete", candidateCount: 1 },
        { status: "complete", importedCandidateCount: 1 },
        { status: "complete", finalAssetCount: 1, visibleGlobalAssetCount: 1 },
        { status: "ready" },
        locationProof(),
        toolProof(),
        environmentProof(),
        sourceProof("compatible_only", COMPATIBLE_SOURCE),
        { status: "complete", candidateCount: 1 },
        { status: "complete", importedCandidateCount: 1 },
        { status: "complete", finalAssetCount: 2 },
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

function smokeOptions(capture: (stage: (typeof PACKAGED_ONBOARDING_SCREENSHOT_STAGES)[number]) => Promise<void>) {
    return {
        capture,
        readAssetUsageAuthoritySnapshot: () => authoritySnapshot(),
        recordAssetUsageAuthorityChange: vi.fn(),
        recordAssetUsageTerminalObservation: vi.fn(),
    };
}

function pngFixture(): Buffer {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(1_280, 16);
    bytes.writeUInt32BE(720, 20);
    return bytes;
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    document.body.replaceChildren();
});

describe("packaged onboarding and ordinary guided-import UI smoke", () => {
    it("keeps safe locations included without checkboxes and uses one confirmed whole-location ignore", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace" data-oaam-journey-stage="sources">
                <div data-oaam-diagnostic-layout="grouped">
                    <div class="workbench-notice"></div>
                    <div class="protocol-technical-record"></div>
                </div>
                <details class="discovery-probe-issues">
                    <summary>Skipped scan information</summary>
                    <div class="workbench-disclosure-content">
                        <ul class="discovery-probe-issue-list"><li class="discovery-probe-issue">
                            <div class="discovery-probe-issue-owner"><strong>Claude Code · Local Windows</strong></div>
                            <ul class="discovery-probe-issue-paths"><li>One location was skipped</li></ul>
                            <div class="protocol-technical-record"></div>
                        </li></ul>
                    </div>
                </details>
                <article class="source-review-card"
                    data-oaam-source-environment="win32:desktop-local"
                    data-oaam-source-path="${NATIVE_SOURCE}"
                    data-oaam-source-claim-kinds='["native","compatible_shared"]'
                    data-oaam-source-default-included="true"
                    data-oaam-source-selected="true"
                    data-oaam-source-watch-selected="true"
                    data-oaam-source-state="included">
                    <button type="button" data-oaam-source-action="ignore">Ignore</button>
                </article>
                <article class="source-review-card"
                    data-oaam-source-environment="win32:desktop-local"
                    data-oaam-source-path="${COMPATIBLE_SOURCE}"
                    data-oaam-source-claim-kinds='["compatible_shared"]'
                    data-oaam-source-default-included="false"
                    data-oaam-source-selected="false"
                    data-oaam-source-watch-selected="false"
                    data-oaam-source-state="ignored">
                    <button type="button" data-oaam-source-action="restore">Restore</button>
                </article>
                <article class="source-review-card"
                    data-oaam-source-environment="wsl:Ubuntu"
                    data-oaam-source-path="${WSL_SOURCE}"
                    data-oaam-source-claim-kinds='["observed"]'
                    data-oaam-source-default-included="false"
                    data-oaam-source-selected="false"
                    data-oaam-source-watch-selected="false"
                    data-oaam-source-state="requires_review">
                </article>
            </div>`;
        for (const card of document.querySelectorAll<HTMLElement>(".source-review-card")) {
            card.querySelector<HTMLButtonElement>('[data-oaam-source-action="ignore"]')?.addEventListener("click", () => {
                const confirmation = document.createElement("div");
                confirmation.dataset.oaamSourceIgnoreConfirmation = "true";
                const confirm = document.createElement("button");
                confirm.dataset.oaamSourceAction = "confirm-ignore";
                confirm.addEventListener("click", () => {
                    card.dataset.oaamSourceSelected = "false";
                    card.dataset.oaamSourceWatchSelected = "false";
                    card.dataset.oaamSourceState = "ignored";
                    confirmation.remove();
                });
                confirmation.append(confirm);
                card.append(confirmation);
            });
            card.querySelector<HTMLButtonElement>('[data-oaam-source-action="restore"]')?.addEventListener("click", () => {
                card.dataset.oaamSourceSelected = "true";
                card.dataset.oaamSourceWatchSelected = "true";
                card.dataset.oaamSourceState = "included";
            });
        }
        const nativeIgnore = [...document.querySelectorAll<HTMLElement>("[data-oaam-source-path]")]
            .find((card) => card.dataset.oaamSourcePath === NATIVE_SOURCE)
            ?.querySelector<HTMLButtonElement>('[data-oaam-source-action="ignore"]');
        if (nativeIgnore === null) throw new Error("native source ignore fixture is missing");
        nativeIgnore.disabled = true;
        setTimeout(() => {
            nativeIgnore.disabled = false;
        }, 20);
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLDetailsElement,
                    HTMLElement,
                    JSON,
                    Promise,
                    setTimeout,
                }) as unknown,
        );

        await expect(reviewPackagedPhysicalSources({ executeJavaScript }, "compatible_only")).resolves.toMatchObject({
            selectedSourcePath: COMPATIBLE_SOURCE,
            sourceCardCount: 3,
        });
        const cardFor = (sourcePath: string) =>
            [...document.querySelectorAll<HTMLElement>("[data-oaam-source-path]")].find(
                (card) => card.dataset.oaamSourcePath === sourcePath,
            );
        const nativeRead = cardFor(NATIVE_SOURCE)?.querySelector<HTMLInputElement>('[data-oaam-source-choice="read"] input');
        expect(nativeRead).toBeNull();
        expect(cardFor(NATIVE_SOURCE)?.dataset.oaamSourceState).toBe("ignored");
        expect(cardFor(NATIVE_SOURCE)?.dataset.oaamSourceWatchSelected).toBe("false");
        expect(cardFor(COMPATIBLE_SOURCE)?.dataset.oaamSourceState).toBe("included");
        expect(cardFor(COMPATIBLE_SOURCE)?.dataset.oaamSourceSelected).toBe("true");
    });

    it("opens and completes one exact observed Project registration before source review", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace" data-oaam-journey-stage="sources">
                <article class="source-review-card"
                    data-oaam-source-path="${PROJECT_SOURCE}"
                    data-oaam-source-selected="true">
                    <div data-oaam-project-proposal-key="project-proposal">
                        <button type="button" data-oaam-project-decision="add">Register Project</button>
                    </div>
                </article>
            </div>`;
        const card = document.querySelector<HTMLElement>(".source-review-card");
        const add = document.querySelector<HTMLButtonElement>('[data-oaam-project-decision="add"]');
        if (card === null || add === null) throw new Error("packaged Project-registration fixture is incomplete");
        add.addEventListener("click", () => {
            const dialog = document.createElement("div");
            dialog.dataset.oaamDialog = "discovery_project_registration";
            dialog.setAttribute("aria-modal", "true");
            dialog.innerHTML = `
                <form data-oaam-project-registration-key="project-proposal">
                    <input type="text" value="${PROJECT_NAME}">
                    <code>${PROJECT_SOURCE}</code>
                    <button type="button" data-oaam-project-registration-action="register">Register</button>
                </form>`;
            const register = dialog.querySelector<HTMLButtonElement>('[data-oaam-project-registration-action="register"]');
            const input = dialog.querySelector<HTMLInputElement>('input[type="text"]');
            if (register === null || input === null) throw new Error("Project-registration dialog fixture is incomplete");
            register.addEventListener("click", () => {
                dialog.remove();
                card.querySelector('[data-oaam-project-proposal-key="project-proposal"]')?.remove();
                const destination = document.createElement("label");
                destination.dataset.oaamSourceDestinationChoice = "project";
                destination.dataset.checked = "true";
                const destinationInput = document.createElement("input");
                destinationInput.type = "radio";
                destinationInput.value = "project";
                destinationInput.checked = true;
                destination.append(destinationInput);
                const current = document.createElement("small");
                current.className = "source-destination-current";
                current.textContent = input.value;
                card.append(destination, current);
            });
            document.body.append(dialog);
        });
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLFormElement,
                    HTMLInputElement,
                    HTMLElement,
                    InputEvent,
                    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
                    setTimeout,
                }) as unknown,
        );

        const ready = await openPackagedProjectRegistration({ executeJavaScript });
        expect(ready).toMatchObject({ ...projectRegistrationReady(), timeline: expect.any(Array) });
        expect(ready.timeline.map((entry) => entry.state)).toEqual([
            "poll_started",
            "source_review_visible",
            "actionable_project_ready",
            "dialog_ready",
        ]);
        await expect(completePackagedProjectRegistration({ executeJavaScript }, ready)).resolves.toMatchObject({
            ...projectRegistrationProof(),
            sourceReviewTimeline: ready.timeline,
        });
        expect(document.querySelector('[data-oaam-dialog="discovery_project_registration"]')).toBeNull();
        expect(card.querySelector<HTMLInputElement>('[data-oaam-source-destination-choice="project"] input')?.checked).toBe(true);
        expect(card.querySelector(".source-destination-current")?.textContent).toBe(SUBMITTED_PROJECT_NAME);
    });

    it("polls a delayed actionable Project against one deadline and retains the transition timeline", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace"
                data-oaam-journey-stage="sources"
                data-oaam-discovery-activity="probing"
                data-oaam-environment-result-statuses='[["wsl:Ubuntu","complete"]]'>
                <article class="source-review-card"
                    data-oaam-source-path="${PROJECT_SOURCE}"
                    data-oaam-source-selected="true">
                    <div data-oaam-project-proposal-key="project-proposal"></div>
                </article>
            </div>`;
        const workspace = document.querySelector<HTMLElement>(".discovery-workspace");
        const proposal = document.querySelector<HTMLElement>('[data-oaam-project-proposal-key="project-proposal"]');
        if (workspace === null || proposal === null) throw new Error("delayed Project-registration fixture is incomplete");
        setTimeout(() => {
            const add = document.createElement("button");
            add.type = "button";
            add.dataset.oaamProjectDecision = "add";
            add.textContent = "Register Project";
            add.addEventListener("click", () => {
                const dialog = document.createElement("div");
                dialog.dataset.oaamDialog = "discovery_project_registration";
                dialog.setAttribute("aria-modal", "true");
                dialog.innerHTML = `
                    <form data-oaam-project-registration-key="project-proposal">
                        <input type="text" value="${PROJECT_NAME}">
                        <code>${PROJECT_SOURCE}</code>
                        <button type="button" data-oaam-project-registration-action="register">Register</button>
                    </form>`;
                document.body.append(dialog);
            });
            proposal.append(add);
            workspace.dataset.oaamDiscoveryActivity = "idle";
        }, 20);
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLFormElement,
                    HTMLInputElement,
                    HTMLElement,
                    InputEvent,
                    JSON,
                    Promise,
                    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
                    setTimeout,
                }) as unknown,
        );

        const ready = await openPackagedProjectRegistration(
            { executeJavaScript },
            { deadlineMilliseconds: 500, pollIntervalMilliseconds: 5 },
        );
        expect(ready.timeline.map((entry) => entry.state)).toEqual([
            "poll_started",
            "source_review_visible",
            "source_scan_in_progress",
            "actionable_project_ready",
            "dialog_ready",
        ]);
        expect(ready.timeline.every((entry, index) => entry.sequence === index)).toBe(true);
        expect(ready.timeline.at(-1)?.elapsedMilliseconds).toBeLessThan(500);
    });

    it("retains an attributable terminal receipt instead of sampling an empty source review once", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace"
                data-oaam-journey-stage="sources"
                data-oaam-discovery-activity="idle"
                data-oaam-environment-result-statuses='[["wsl:Ubuntu","failed"]]'></div>`;
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLElement,
                    JSON,
                    Promise,
                    setTimeout,
                }) as unknown,
        );

        await expect(
            openPackagedProjectRegistration({ executeJavaScript }, { deadlineMilliseconds: 100, pollIntervalMilliseconds: 5 }),
        ).rejects.toThrow(/source_probe_failed.*terminal_source_probe_failed/u);
    });

    it("expires the same bounded deadline with a retained polling timeline when no terminal state appears", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace"
                data-oaam-journey-stage="sources"
                data-oaam-discovery-activity="idle"
                data-oaam-environment-result-statuses='[["wsl:Ubuntu","complete"]]'></div>`;
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLElement,
                    JSON,
                    Promise,
                    setTimeout,
                }) as unknown,
        );

        await expect(
            openPackagedProjectRegistration({ executeJavaScript }, { deadlineMilliseconds: 20, pollIntervalMilliseconds: 5 }),
        ).rejects.toThrow(/deadline_exceeded.*terminal_deadline_exceeded/u);
    });

    it("rejects malformed or identity-changing packaged Project-registration receipts", async () => {
        await expect(
            openPackagedProjectRegistration(
                { executeJavaScript: vi.fn() },
                { deadlineMilliseconds: 0, pollIntervalMilliseconds: 1 },
            ),
        ).rejects.toThrow("invalid packaged Project-registration polling bounds");

        await expect(
            openPackagedProjectRegistration({
                executeJavaScript: vi.fn(async () => ({ status: "ready" })),
            }),
        ).rejects.toThrow("invalid packaged Project-registration ready proof");

        await expect(
            openPackagedProjectRegistration({
                executeJavaScript: vi.fn(async () => ({
                    ...projectRegistrationReady(),
                    timeline: projectRegistrationTimeline().map((entry, index) =>
                        index === 2 ? { ...entry, sequence: 7 } : entry,
                    ),
                })),
            }),
        ).rejects.toThrow("invalid packaged Project-registration timeline");

        const ready = await openPackagedProjectRegistration({
            executeJavaScript: vi.fn(async () => projectRegistrationReady()),
        });
        await expect(
            completePackagedProjectRegistration({ executeJavaScript: vi.fn(async () => ({ status: "complete" })) }, ready),
        ).rejects.toThrow("invalid packaged Project-registration completion proof");

        await expect(
            completePackagedProjectRegistration(
                {
                    executeJavaScript: vi.fn(async () => ({
                        ...projectRegistrationProof(),
                        sourcePath: "C:\\proof\\different-project",
                    })),
                },
                ready,
            ),
        ).rejects.toThrow("packaged Project-registration completion changed its reviewed identity");
    });

    it("reviews the native path once, then explicitly reviews a compatible-only path in ordinary guided import", async () => {
        const executeJavaScript = stagedExecution();
        const capture = vi.fn(async () => undefined);

        await expect(
            proveWindowsPackagedOnboardingUi(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example" }),
                smokeOptions(capture),
            ),
        ).resolves.toEqual(exactUiProof());

        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_ONBOARDING_SCREENSHOT_STAGES);
        expect(executeJavaScript).toHaveBeenCalledTimes(27);
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain("awaiting_actionable_project");
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain('terminal("deadline_exceeded"');
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain("discovery_project_registration");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain("the immediate registered Project source reconciliation");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain('data-oaam-source-destination-choice="project"');
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("group each exact environment and physical path once");
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("discovery-probe-issue-owner");
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("source review exposes an unattributed probe issue");
        expect(String(executeJavaScript.mock.calls[5]?.[0])).not.toContain(
            "source review does not retain one bounded grouped diagnostic",
        );
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain('JSON.stringify(["native", "compatible_shared"])');
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain('JSON.stringify(["compatible_shared"])');
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain(
            "compatible-only source did not preserve the expected default-or-prior-ignore state",
        );
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain(
            "source review did not preserve and restore the prior whole-location ignore decision",
        );
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain('data-oaam-source-action="confirm-ignore"');
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain("oaamSourceSelected");
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain("the confirmed source ignore state for ");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain('data-oaam-journey-continue="sources"');
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain('data-oaam-project-decision="skip"');
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain("resolved Project suggestions");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain("index < 100");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain("the fresh Asset candidate was not selected by default");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain(
            "a fresh Asset candidate exposed a destination choice without an existing Version target",
        );
        expect(String(executeJavaScript.mock.calls[6]?.[0])).not.toContain('data-option-index="1"');
        expect(String(executeJavaScript.mock.calls[8]?.[0])).toContain(
            "the Asset library exposed a source Environment as an Asset filter",
        );
        expect(String(executeJavaScript.mock.calls[8]?.[0])).toContain("asset-tree-global");
        expect(String(executeJavaScript.mock.calls[8]?.[0])).not.toContain("environmentFilter");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain('data-oaam-route="guided_import"');
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain('data-oaam-action="start-guided-import"');
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain(
            '.library-toolbar-actions > [data-oaam-action="start-guided-import"]',
        );
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain(
            "ordinary guided import was incorrectly restricted to one Project",
        );
        expect(String(executeJavaScript.mock.calls[9]?.[0])).not.toContain(
            ".library-empty-actions button:not(.library-secondary-button)",
        );
        expect(String(executeJavaScript.mock.calls[16]?.[0])).toContain("exactly two final Assets");
        expect(String(executeJavaScript.mock.calls[16]?.[0])).toContain("the contextual Global workbench after guided import");
        expect(String(executeJavaScript.mock.calls[14]?.[0])).toContain('data-oaam-project-decision="skip"');
        expect(String(executeJavaScript.mock.calls[17]?.[0])).toContain("the exact registered Project library");
        expect(String(executeJavaScript.mock.calls[18]?.[0])).toContain(
            "Project environments are not one semantic single-select group",
        );
        expect(String(executeJavaScript.mock.calls[19]?.[0])).toContain("the exact AI coding tool selection");
        expect(String(executeJavaScript.mock.calls[20]?.[0])).toContain(
            "Project discovery escaped the exact registered Project environment",
        );
        expect(String(executeJavaScript.mock.calls[21]?.[0])).toContain("current.dataset.oaamSourceWatchSelected");
        expect(String(executeJavaScript.mock.calls[21]?.[0])).toContain("optional future-scan destination");
        expect(String(executeJavaScript.mock.calls[21]?.[0])).toContain("the exact Project source did not settle as included");
        expect(String(executeJavaScript.mock.calls[24]?.[0])).toContain("the imported AGENTS Asset has no tool-usage action");
        expect(String(executeJavaScript.mock.calls[25]?.[0])).toContain("direct already-usable unmanaged relation");
        expect(String(executeJavaScript.mock.calls[26]?.[0])).toContain("safe return to the Project library");
    });

    it("rejects a selected physical path that produces more than one Asset candidate", async () => {
        const values = [...successfulExecutionValues()];
        values[6] = { status: "complete", candidateCount: 2 };

        await expect(
            proveWindowsPackagedOnboardingUi(
                { executeJavaScript: stagedExecution(values) },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example" }),
                smokeOptions(vi.fn(async () => undefined)),
            ),
        ).rejects.toThrow("invalid packaged candidateCount proof");
    });

    it("rejects malformed source-review evidence instead of promoting an installed journey", async () => {
        const values = [...successfulExecutionValues()];
        values[5] = {
            ...sourceProof("native_primary", NATIVE_SOURCE),
            nativeRelationshipKinds: ["compatible_shared"],
        };

        await expect(
            proveWindowsPackagedOnboardingUi(
                { executeJavaScript: stagedExecution(values) },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example" }),
                smokeOptions(vi.fn(async () => undefined)),
            ),
        ).rejects.toThrow("invalid packaged source-review proof");
    });

    it("explicitly skips a bounded set of unrelated discovered Projects before reviewing the selected global source", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace" data-oaam-journey-stage="sources">
                <ul>
                    <li data-oaam-project-proposal-key="project-a">
                        <button type="button" data-oaam-project-decision="skip" disabled>Not now</button>
                    </li>
                    <li data-oaam-project-proposal-key="project-b">
                        <button type="button" data-oaam-project-decision="skip" disabled>Not now</button>
                        <fieldset hidden data-confirmation>
                            <button type="button" data-oaam-source-action="confirm-ignore">Ignore</button>
                        </fieldset>
                    </li>
                </ul>
                <button type="button" data-oaam-journey-continue="sources" disabled>Review Assets</button>
            </div>
            <main data-oaam-route="onboarding" data-oaam-step="assets">
                <div data-oaam-import-navigation-owner="journey"></div>
                <button type="button" class="library-secondary-button" data-oaam-journey-skip-import>Skip</button>
                <button type="button" data-oaam-import-commit>Import</button>
                <article data-oaam-import-candidate-id="candidate-1">
                    <input type="checkbox" checked>
                </article>
                <div class="import-actions"><button type="button">Import selected</button></div>
            </main>`;
        const workspace = document.querySelector<HTMLElement>(".discovery-workspace");
        const continueSources = document.querySelector<HTMLButtonElement>('[data-oaam-journey-continue="sources"]');
        const importAction = document.querySelector<HTMLButtonElement>(".import-actions button");
        if (workspace === null || continueSources === null || importAction === null) {
            throw new Error("packaged Project-decision fixture is incomplete");
        }
        for (const [index, skip] of [
            ...workspace.querySelectorAll<HTMLButtonElement>('[data-oaam-project-decision="skip"]'),
        ].entries()) {
            skip.addEventListener("click", () => {
                if (index === 0) {
                    skip.remove();
                    return;
                }
                const confirmation = skip.parentElement?.querySelector<HTMLElement>("[data-confirmation]");
                if (confirmation !== null && confirmation !== undefined) confirmation.hidden = false;
            });
        }
        setTimeout(() => {
            for (const skip of workspace.querySelectorAll<HTMLButtonElement>('[data-oaam-project-decision="skip"]')) {
                skip.disabled = false;
            }
        }, 50);
        const confirmIgnore = workspace.querySelector<HTMLButtonElement>('[data-oaam-source-action="confirm-ignore"]');
        if (confirmIgnore === null) throw new Error("packaged Project ignore confirmation is missing");
        confirmIgnore.addEventListener("click", () => {
            const card = confirmIgnore.closest("[data-oaam-project-proposal-key]");
            card?.querySelector('[data-oaam-project-decision="skip"]')?.remove();
            confirmIgnore.closest("[data-confirmation]")?.remove();
            if (workspace.querySelector('[data-oaam-project-decision="skip"]') === null) continueSources.disabled = false;
        });
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLInputElement,
                    HTMLElement,
                    setTimeout,
                }) as unknown,
        );

        await expect(preparePackagedAssetReview({ executeJavaScript }, "onboarding")).resolves.toBe(1);
        expect(workspace.querySelector('[data-oaam-project-decision="skip"]')).toBeNull();
        expect(continueSources.disabled).toBe(false);
        expect(importAction.disabled).toBe(false);
    });

    it("reports a terminal partial read instead of waiting for a nonexistent Asset candidate", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace" data-oaam-journey-stage="sources">
                <button data-oaam-journey-continue="sources">Continue</button>
            </div>
            <main data-oaam-route="guided_import" data-oaam-step="assets">
                <section data-oaam-import-read-attention>
                    <div data-oaam-import-read-issue="partial">OpenCode · Local Windows C:\\proof\\.agents\\skills Partly read</div>
                </section>
            </main>`;
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLInputElement,
                    HTMLElement,
                    setTimeout,
                }) as unknown,
        );

        await expect(preparePackagedAssetReview({ executeJavaScript }, "guided_import")).rejects.toThrow(
            'outcome={"status":"read_attention","issues":[{"status":"partial"',
        );
    });

    it("rejects a screenshot artifact that is not a PNG", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-invalid-screenshot-"));
        roots.push(parent);
        const screenshots = new PackagedOnboardingScreenshotProof(path.join(parent, "proof"));
        const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.alloc(24) }));

        await expect(screenshots.capture("onboarding-welcome", { capturePage })).rejects.toThrow(
            "packaged onboarding screenshot onboarding-welcome is not a PNG",
        );
        expect(capturePage).toHaveBeenCalledTimes(1);
    });

    it("recovers from one exact UnknownVizError capture transient", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-transient-screenshot-"));
        roots.push(parent);
        const screenshots = new PackagedOnboardingScreenshotProof(path.join(parent, "proof"));
        const transient = new Error("UnknownVizError");
        const capturePage = vi
            .fn<PackagedOnboardingScreenshotWebContents["capturePage"]>()
            .mockRejectedValueOnce(transient)
            .mockResolvedValueOnce({ toPNG: () => pngFixture() });

        await expect(screenshots.capture("onboarding-welcome", { capturePage })).resolves.toBeUndefined();
        expect(capturePage).toHaveBeenCalledTimes(2);
    });

    it("does not retry a non-UnknownVizError capture failure", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-terminal-screenshot-"));
        roots.push(parent);
        const screenshots = new PackagedOnboardingScreenshotProof(path.join(parent, "proof"));
        const terminal = new Error("renderer destroyed");
        const capturePage = vi.fn<PackagedOnboardingScreenshotWebContents["capturePage"]>().mockRejectedValue(terminal);

        await expect(screenshots.capture("onboarding-welcome", { capturePage })).rejects.toBe(terminal);
        expect(capturePage).toHaveBeenCalledTimes(1);
    });

    it("does not retry an UnknownVizError message with a nonexact error identity", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-misshaped-screenshot-"));
        roots.push(parent);
        const screenshots = new PackagedOnboardingScreenshotProof(path.join(parent, "proof"));
        const terminal = Object.assign(new Error("UnknownVizError"), { name: "UnknownVizError" });
        const capturePage = vi.fn<PackagedOnboardingScreenshotWebContents["capturePage"]>().mockRejectedValue(terminal);

        await expect(screenshots.capture("onboarding-welcome", { capturePage })).rejects.toBe(terminal);
        expect(capturePage).toHaveBeenCalledTimes(1);
    });

    it("fails with the exact fourth UnknownVizError after four capture attempts", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-exhausted-screenshot-"));
        roots.push(parent);
        const screenshots = new PackagedOnboardingScreenshotProof(path.join(parent, "proof"));
        const transient = new Error("UnknownVizError");
        const capturePage = vi.fn<PackagedOnboardingScreenshotWebContents["capturePage"]>().mockRejectedValue(transient);

        await expect(screenshots.capture("onboarding-welcome", { capturePage })).rejects.toBe(transient);
        expect(capturePage).toHaveBeenCalledTimes(4);
    });

    it("persists the exact Asset-usage authority change receipt before failed-profile cleanup", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-authority-change-"));
        roots.push(parent);
        const root = path.join(parent, "proof");
        const screenshots = new PackagedOnboardingScreenshotProof(root);
        const receipt = {
            schemaVersion: 2 as const,
            before: authoritySnapshot(),
            after: { ...authoritySnapshot(), businessAuthorityTreeFingerprint: "e".repeat(64) },
            delta: { ...authorityDelta(), authorityChanged: true, businessAuthorityChanged: true },
        };

        screenshots.recordAssetUsageAuthorityChange(receipt);

        expect(JSON.parse(fs.readFileSync(path.join(root, PACKAGED_ASSET_USAGE_AUTHORITY_CHANGE_RECEIPT), "utf8"))).toEqual(
            receipt,
        );
        expect(() => screenshots.recordAssetUsageAuthorityChange(receipt)).toThrow();
    });

    it("writes one immutable PNG per first-run and guided-import stage with the nested proof", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-screenshots-"));
        roots.push(parent);
        const root = path.join(parent, "proof");
        const screenshots = new PackagedOnboardingScreenshotProof(root);
        const capturePage = vi.fn(async () => ({ toPNG: () => pngFixture() }));

        for (const stage of PACKAGED_ONBOARDING_SCREENSHOT_STAGES) {
            await screenshots.capture(stage, { capturePage });
        }
        screenshots.finalize(exactUiProof());

        expect(fs.readdirSync(root).sort()).toEqual(
            [...PACKAGED_ONBOARDING_SCREENSHOT_STAGES.map((stage) => `${stage}.png`), "manifest.json"].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))).toEqual({
            schemaVersion: 10,
            stages: PACKAGED_ONBOARDING_SCREENSHOT_STAGES.map((stage) => ({ stage, fileName: `${stage}.png` })),
            proof: exactUiProof(),
        });
        expect(capturePage).toHaveBeenCalledTimes(PACKAGED_ONBOARDING_SCREENSHOT_STAGES.length);
    });
});
