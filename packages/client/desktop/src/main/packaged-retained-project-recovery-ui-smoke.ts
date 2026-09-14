import fs from "node:fs";
import path from "node:path";
import {
    diffPackagedAssetUsageAuthority,
    isPackagedAssetUsageObservabilitySnapshotComparable,
    type PackagedAssetUsageAuthoritySnapshot,
    waitForPackagedAssetUsageAuthorityQuiescence,
} from "./packaged-asset-usage-authority-proof";
import type { ResolveEnvironmentChoiceWslHome } from "./packaged-environment-choice-smoke";
import { proveWindowsWslEnvironmentChoice } from "./packaged-environment-choice-smoke";
import { PACKAGED_PROJECT_RESTORE_SMOKE_SWITCH, PACKAGED_PROJECT_STOP_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
import { PackagedProviderScreenshotProof } from "./packaged-provider-screenshot-proof";
import {
    commitSettingsRestoreScript,
    ENTER_GENERAL_SETTINGS_SOURCE,
    ENTER_PROJECTS_LIBRARY_SOURCE,
    openSettingsRestoreReviewScript,
    PROJECT_RESTORE_SHARED_SOURCE,
    retainedSettingsReadyScript,
} from "./packaged-retained-project-recovery-ui-script-support";

export const PACKAGED_RETAINED_PROJECT_RECOVERY_STAGES = [
    "provider-sweep-retained-library",
    "provider-sweep-retained-restore-review",
    "provider-sweep-restored-project",
] as const;

export type PackagedRetainedProjectRecoveryStage = (typeof PACKAGED_RETAINED_PROJECT_RECOVERY_STAGES)[number];

export const PACKAGED_PROJECT_STOP_DIRECTORY = "oaam-phase59-project-stop";
export const PACKAGED_PROJECT_STOP_STAGES = ["project-stop-active", "project-stop-retained"] as const;
export const PACKAGED_PROJECT_STOP_SUBJECT_FILE_NAME = ".oaam-packaged-project-stop-subject.json";
export type PackagedProjectStopStage = (typeof PACKAGED_PROJECT_STOP_STAGES)[number];
export const PACKAGED_PROJECT_RESTORE_DIRECTORY = "oaam-phase59-project-restore";
export const PACKAGED_PROJECT_RESTORE_STAGES = [
    "project-restore-retained",
    "project-restore-review",
    "project-restore-active",
] as const;
export const PACKAGED_PROJECT_RESTORE_SUBJECT_FILE_NAME = ".oaam-packaged-project-restore-subject.json";
export type PackagedProjectRestoreStage = (typeof PACKAGED_PROJECT_RESTORE_STAGES)[number];

export interface PackagedRetainedProjectRecoverySubject {
    readonly displayName: string;
    readonly rootPath: string;
    readonly adapterIds: readonly string[];
}

export interface PackagedProjectStopSubject {
    readonly projectId: string;
    readonly selectedProjectId: string;
    readonly displayName: string;
    readonly rootPath: string;
}

export interface PackagedProjectStopProof extends PackagedProjectStopSubject {
    readonly status: "complete";
    readonly nonSelectedTargetVerified: true;
    readonly rememberChoiceSwitchClickCount: 0 | 1;
    readonly rememberChoiceFalse: true;
    readonly continuedWithoutBackup: true;
    readonly activeTreeEntryAbsentAfterStop: true;
    readonly retainedHistoryCollapsed: true;
    readonly retainedHistoryAfterPrimaryContent: true;
}

export interface PackagedProjectRestoreProof extends PackagedProjectStopSubject {
    readonly status: "complete";
    readonly retainedRowMatchedExactIdentity: true;
    readonly restoredThroughReviewedLifecycle: true;
    readonly finalActiveIdentityMatches: true;
    readonly selectedProjectPreserved: true;
}

export interface PackagedRetainedProjectRecoveryProof {
    readonly status: "complete";
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly stoppedThroughReviewedLifecycle: true;
    readonly activeTreeEntryAbsentAfterStop: true;
    readonly retainedHistoryCollapsed: true;
    readonly retainedHistoryAfterPrimaryContent: true;
    readonly exactRetainedProposalObserved: true;
    readonly registrationDialogAbsent: true;
    readonly restoreReviewBoundSameIdentity: true;
    readonly restoreDialogAtDocumentBody: true;
    readonly restoreBackdropCoversViewport: true;
    readonly sourceScrollTopBefore: number;
    readonly sourceScrollTopAfterOpen: number;
    readonly sourceScrollPreservedOnOpen: true;
    readonly restoredThroughReviewedLifecycle: true;
    readonly finalActiveIdentityMatches: true;
    readonly rawRegistrationFailureAbsent: true;
}

export interface PackagedRetainedProjectRecoveryWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

interface PackagedProjectStopWebContents extends PackagedRetainedProjectRecoveryWebContents {
    capturePage(): Promise<{ toPNG(): Buffer }>;
}

export interface PackagedRetainedProjectRecoveryOptions {
    readonly capture: (stage: PackagedRetainedProjectRecoveryStage) => Promise<void>;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stopRetainedProjectScript(subject: PackagedRetainedProjectRecoverySubject | PackagedProjectStopSubject): string {
    return `(async () => {
    const expected = ${JSON.stringify(subject)};
    const deadline = Date.now() + 60000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}
    const guided = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="sources"]');
    if (guided instanceof HTMLElement) {
        const close = guided.querySelector('.guided-import-heading button.library-secondary-button');
        if (!(close instanceof HTMLButtonElement) || close.disabled) {
            throw new Error("Provider sweep cannot leave source review before retained-Project proof");
        }
        close.click();
    }
    const library = await enterProjectsLibrary("before stop managing");
    const exactProjectId = typeof expected.projectId === "string" ? expected.projectId : undefined;
    let projectTreeTerminal = { controllerState: "loading", rowCount: 0, rows: [] };
    let exactProject;
    try {
        exactProject = await waitFor(() => {
            const failed = library.querySelector('.library-state-panel[data-oaam-tone="danger"][role="alert"]');
            if (failed instanceof HTMLElement) {
                throw new Error("Project library failed: " + (failed.textContent?.trim() || "no ordinary detail"));
            }
            const rows = [...library.querySelectorAll('.asset-tree-project[data-oaam-project-id]')]
                .filter((candidate) => candidate instanceof HTMLButtonElement);
            projectTreeTerminal = {
                controllerState: library.querySelector('.library-state-panel[aria-busy="true"]') === null ? "rendered" : "loading",
                rowCount: rows.length,
                rows: rows.slice(0, 8).map((candidate) => ({
                    projectId: candidate.dataset.oaamProjectId ?? "",
                    name: candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "",
                    disabled: candidate.disabled,
                })),
            };
            const candidates = rows.filter((candidate) => {
                const name = candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "";
                return candidate.dataset.oaamProjectId === exactProjectId || name === expected.displayName;
            });
            if (candidates.length > 1) throw new Error("the exact registered Project row is ambiguous");
            if (candidates.length === 0) return false;
            const candidate = candidates[0];
            const name = candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "";
            if (candidate.dataset.oaamProjectId !== exactProjectId || name !== expected.displayName) {
                throw new Error("the exact registered Project row changed identity");
            }
            if (candidate.disabled) throw new Error("the exact registered Project row is disabled");
            return candidate;
        }, "the exact registered Project row");
    } catch (error) {
        if (error instanceof Error && error.message === "timed out waiting for the exact registered Project row") {
            throw new Error(error.message + "; terminal=" + JSON.stringify(projectTreeTerminal));
        }
        throw error;
    }
    const projectId = exactProject.dataset.oaamProjectId ?? "";
    if (!/^[0-9a-f-]{36}$/iu.test(projectId)) throw new Error("the exact registered Project has no stable identity");
    const selectedProjectId = typeof expected.selectedProjectId === "string" ? expected.selectedProjectId : undefined;
    if (selectedProjectId === undefined) {
        exactProject.click();
        await waitFor(() => library.dataset.oaamProjectId === projectId, "the exact registered Project selection");
    } else if (selectedProjectId === projectId || library.dataset.oaamProjectId !== selectedProjectId) {
        throw new Error("the stop target is not mechanically distinct from the selected Project");
    }
    const manageMatches = [...library.querySelectorAll('[data-oaam-action="manage-project"][data-oaam-project-id]')]
        .filter((candidate) => candidate instanceof HTMLButtonElement && candidate.dataset.oaamProjectId === projectId);
    if (manageMatches.length !== 1 || !(manageMatches[0] instanceof HTMLButtonElement) || manageMatches[0].disabled) {
        throw new Error("the exact registered Project cannot be managed");
    }
    manageMatches[0].click();
    const dialog = await waitFor(
        () => document.querySelector('[data-oaam-dialog="project_lifecycle"]'),
        "the exact Project lifecycle dialog",
    );
    const subjectValues = [...dialog.querySelectorAll('.project-lifecycle-subject dd')]
        .map((entry) => entry.textContent?.trim() ?? "");
    if (subjectValues.length !== 2 || subjectValues[0] !== expected.displayName || subjectValues[1] !== expected.rootPath) {
        throw new Error("the Project lifecycle dialog changed the registered Project identity");
    }
    const stop = dialog.querySelector('[data-oaam-project-action="stop_managing"]');
    if (!(stop instanceof HTMLButtonElement) || stop.disabled) throw new Error("stop managing is unavailable");
    stop.click();
    const review = await waitFor(
        () => dialog.querySelector('.project-lifecycle-review[data-oaam-project-lifecycle-action="stop_managing"]'),
        "the reviewed stop-managing action",
    );
    const readRememberChoice = () => {
        const dialogs = [...document.querySelectorAll('[data-oaam-dialog="project_lifecycle"]')];
        const currentSubject = [...dialog.querySelectorAll('.project-lifecycle-subject dd')]
            .map((entry) => entry.textContent?.trim() ?? "");
        if (dialogs.length !== 1 || dialogs[0] !== dialog || review.closest('[data-oaam-dialog="project_lifecycle"]') !== dialog ||
            currentSubject.length !== 2 || currentSubject[0] !== expected.displayName || currentSubject[1] !== expected.rootPath) {
            throw new Error("the exact stop review changed dialog or Project identity");
        }
        const matches = [...review.querySelectorAll(
            '.project-lifecycle-backup-gate [data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.007"][role="switch"]'
        )].filter((candidate) => candidate instanceof HTMLButtonElement);
        if (matches.length !== 1) throw new Error("the exact stop review remember-choice switch is ambiguous");
        return matches[0];
    };
    let remember = readRememberChoice();
    let checked = remember.getAttribute('aria-checked');
    if (checked !== 'true' && checked !== 'false') throw new Error("the remember-choice switch has invalid aria-checked");
    let rememberChoiceSwitchClickCount = 0;
    if (checked === 'true') {
        remember.click();
        rememberChoiceSwitchClickCount = 1;
        remember = await waitFor(() => {
            const current = readRememberChoice();
            const value = current.getAttribute('aria-checked');
            if (value !== 'true' && value !== 'false') throw new Error("the remember-choice switch has invalid aria-checked");
            return value === 'false' ? current : false;
        }, "remember choice to turn off");
        checked = remember.getAttribute('aria-checked');
    }
    const rememberChoiceFalse = checked === 'false';
    const continueButtons = [...review.querySelectorAll(
        '.detail-actions button.library-secondary-button[data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.009"]'
    )].filter((candidate) => candidate instanceof HTMLButtonElement);
    const continuedWithoutBackup = continueButtons.length === 1 && !continueButtons[0].disabled;
    if (!rememberChoiceFalse || !continuedWithoutBackup) {
        throw new Error("the exact stop review did not preserve continue-without-backup and remember=false");
    }
    const commit = continueButtons[0];
    commit.click();
    const currentLibrary = await waitFor(() => {
        if (document.querySelector('[data-oaam-dialog="project_lifecycle"]') !== null) return false;
        const value = document.querySelector(
            'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]'
        );
        return value instanceof HTMLElement ? value : false;
    }, "the Projects library after stop managing");
    const activeEntryAbsent = [...currentLibrary.querySelectorAll('.asset-tree-project[data-oaam-project-id]')]
        .every((candidate) => candidate instanceof HTMLElement && candidate.dataset.oaamProjectId !== projectId);
    if (!activeEntryAbsent || currentLibrary.querySelector('details.retained-projects') !== null) {
        throw new Error("the stopped Project remained in the active Projects library");
    }
    if (selectedProjectId !== undefined && currentLibrary.dataset.oaamProjectId !== selectedProjectId) {
        throw new Error("stopping the non-selected Project changed the selected Project");
    }
    return {
        status: "complete", projectId, displayName: expected.displayName, rootPath: expected.rootPath,
        selectedProjectId: selectedProjectId ?? null,
        nonSelectedTargetVerified: selectedProjectId !== undefined,
        continuedWithoutBackup, rememberChoiceFalse, rememberChoiceSwitchClickCount,
        stoppedThroughReviewedLifecycle: true, activeTreeEntryAbsentAfterStop: true,
    };
})()`;
}

function retainedProjectHistoryScript(stopped: {
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
}): string {
    return `(async () => {
    const expected = ${JSON.stringify(stopped)};
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}
    ${ENTER_GENERAL_SETTINGS_SOURCE}
    const settings = await enterGeneralSettings("the stopped Project");
    const retained = await waitFor(() => {
        const value = settings.querySelector('.retained-project-settings details.retained-projects');
        return value instanceof HTMLDetailsElement ? value : false;
    }, "the collapsed stopped-Project history in Project management Settings");
    const retainedRows = [...retained.querySelectorAll('li')].filter((row) => {
        const name = row.querySelector('strong')?.textContent?.trim() ?? "";
        const root = row.querySelector('small')?.textContent?.trim() ?? "";
        return name === expected.displayName && root === expected.rootPath;
    });
    const retainedPanel = retained.closest('.retained-project-settings');
    const settingsContent = retainedPanel?.parentElement;
    const settingsSections = settingsContent === null || settingsContent === undefined ? [] : [...settingsContent.children];
    const retainedIndex = retainedPanel === null ? -1 : settingsSections.indexOf(retainedPanel);
    const primaryBefore = retainedIndex > 0 && settingsSections.slice(0, retainedIndex).some((entry) => {
        return entry instanceof HTMLElement && entry.matches('.settings-section') && !entry.hidden;
    });
    if (retainedRows.length !== 1 || retained.open || !primaryBefore) {
        throw new Error("the stopped Project did not become compact secondary history in Project management Settings");
    }
    return {
        status: "complete", projectId: expected.projectId, displayName: expected.displayName, rootPath: expected.rootPath,
        retainedHistoryCollapsed: true, retainedHistoryAfterPrimaryContent: true,
    };
})()`;
}

const ENTER_REDISCOVERY_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}
    ${ENTER_GENERAL_SETTINGS_SOURCE}
    let library = await leaveSettingsForProjectsLibrary("before retained-Project rediscovery");
    const globalChoice = library.querySelector('[data-oaam-subject-choice="global"]');
    if (!(globalChoice instanceof HTMLButtonElement) || globalChoice.disabled) {
        throw new Error("retained Project rediscovery cannot choose the Global library");
    }
    if (globalChoice.getAttribute("aria-selected") !== "true") globalChoice.click();
    library = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="global"][data-oaam-state="ready"]');
        return value instanceof HTMLElement ? value : false;
    }, "the Global library before retained-Project rediscovery");
    const entry = await waitFor(() => {
        const current = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="global"][data-oaam-state="ready"]');
        if (!(current instanceof HTMLElement)) return false;
        const direct = [...current.querySelectorAll('[data-oaam-action="start-guided-import"]')]
            .filter((button) => button instanceof HTMLButtonElement && !button.disabled);
        if (direct.length > 1) {
            throw new Error("the retained Project library has ambiguous import actions");
        }
        if (direct.length === 1 && direct[0] instanceof HTMLButtonElement) return direct[0];
        return false;
    }, "a unique retained-Project rediscovery entry");
    entry.click();
    const guided = await waitFor(
        () => document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="locations"]'),
        "the retained-Project rediscovery location stage",
    );
    if (!(guided instanceof HTMLElement) || guided.dataset.oaamTargetProjectId !== undefined) {
        throw new Error("retained Project rediscovery was incorrectly restricted to one Project");
    }
    return { status: "ready" };
})()`;

function openRestoreReviewScript(
    subject: PackagedRetainedProjectRecoverySubject,
    stopped: { readonly projectId: string },
): string {
    return `(async () => {
    const expected = ${JSON.stringify({ ...subject, projectId: stopped.projectId })};
    const deadline = Date.now() + 60000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    ${PROJECT_RESTORE_SHARED_SOURCE}
    const workspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
    if (!(workspace instanceof HTMLElement)) throw new Error("retained-Project rediscovery did not reach source review");
    const matching = [...workspace.querySelectorAll('[data-oaam-project-proposal-key]')].filter((element) => {
        const card = element.matches('.source-review-card') ? element : element.closest('.source-review-card');
        const root = card instanceof HTMLElement
            ? card.dataset.oaamSourcePath ?? ""
            : element.querySelector('code')?.textContent?.trim() ?? "";
        return root === expected.rootPath;
    });
    const keys = [...new Set(matching.map((entry) => entry.dataset.oaamProjectProposalKey ?? "").filter(Boolean))];
    const restoreButtons = [...new Set(matching.flatMap((entry) =>
        [...entry.querySelectorAll('[data-oaam-project-lifecycle-action="restore"]')]
    ))].filter((button) => button instanceof HTMLButtonElement && !button.disabled);
    if (keys.length !== 1 || restoreButtons.length !== 1 || !(restoreButtons[0] instanceof HTMLButtonElement)) {
        throw new Error("the exact retained Project is not uniquely restorable from source review");
    }
    if (document.querySelector('[data-oaam-dialog="discovery_project_registration"]') !== null) {
        throw new Error("retained Project rediscovery incorrectly opened registration before user action");
    }
    const shell = document.querySelector('.guided-import-shell');
    if (!(shell instanceof HTMLElement)) throw new Error("retained Project rediscovery has no guided-import scroll owner");
    restoreButtons[0].scrollIntoView({ block: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sourceScrollTopBefore = shell.scrollTop;
    if (!Number.isFinite(sourceScrollTopBefore) || sourceScrollTopBefore <= 0) {
        throw new Error("retained Project restore was not exercised from a scrolled source list");
    }
    restoreButtons[0].click();
    const dialog = await waitFor(
        () => document.querySelector('[data-oaam-dialog="project_lifecycle"]'),
        "the retained Project lifecycle dialog",
    );
    if (document.querySelector('[data-oaam-dialog="discovery_project_registration"]') !== null) {
        throw new Error("retained Project rediscovery opened the registration dialog");
    }
    const sourceScrollTopAfterOpen = shell.scrollTop;
    if (Math.abs(sourceScrollTopAfterOpen - sourceScrollTopBefore) > 1) {
        throw new Error("opening retained Project restore moved the guided-import source list");
    }
    const backdrop = dialog.parentElement;
    if (!(backdrop instanceof HTMLElement) || backdrop.parentElement !== document.body ||
        !backdrop.matches('[data-oaam-dialog-backdrop]')) {
        throw new Error("retained Project restore is not mounted at the application window level");
    }
    const backdropStyle = getComputedStyle(backdrop);
    const backdropBounds = backdrop.getBoundingClientRect();
    const restoreBackdropCoversViewport = backdropStyle.position === "fixed" &&
        backdropBounds.left <= 1 && backdropBounds.top <= 1 &&
        backdropBounds.right >= window.innerWidth - 1 && backdropBounds.bottom >= window.innerHeight - 1;
    if (!restoreBackdropCoversViewport) {
        throw new Error("retained Project restore backdrop does not cover the application viewport");
    }
    await openRestoreReview(dialog, expected, "the exact retained Project");
    const ordinaryText = workspace.textContent ?? "";
    if (ordinaryText.includes("registered Project is deleted") || ordinaryText.includes("project.operation_failed")) {
        throw new Error("retained Project rediscovery exposed the obsolete registration failure");
    }
    return {
        status: "review_ready",
        projectId: expected.projectId,
        displayName: expected.displayName,
        rootPath: expected.rootPath,
        proposalKey: keys[0],
        exactRetainedProposalObserved: true,
        registrationDialogAbsent: true,
        restoreReviewBoundSameIdentity: true,
        restoreDialogAtDocumentBody: true,
        restoreBackdropCoversViewport: true,
        sourceScrollTopBefore,
        sourceScrollTopAfterOpen,
        sourceScrollPreservedOnOpen: true,
        rawRegistrationFailureAbsent: true,
    };
})()`;
}

function commitRestoreScript(review: {
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly proposalKey: string;
}): string {
    return `(async () => {
    const expected = ${JSON.stringify(review)};
    const deadline = Date.now() + 60000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}
    ${ENTER_GENERAL_SETTINGS_SOURCE}
    ${PROJECT_RESTORE_SHARED_SOURCE}
    const dialog = document.querySelector('[data-oaam-dialog="project_lifecycle"]');
    if (!(dialog instanceof HTMLElement)) {
        throw new Error("the retained Project restore review disappeared before commit");
    }
    await commitRestoreReview(dialog, expected, "the retained Project");
    const workspace = await waitFor(() => {
        const value = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
        return value instanceof HTMLElement ? value : false;
    }, "the restored Project source review");
    const proposalElements = [...workspace.querySelectorAll('[data-oaam-project-proposal-key]')]
        .filter((element) => element.dataset.oaamProjectProposalKey === expected.proposalKey);
    if (proposalElements.length === 0 || proposalElements.some((element) =>
        element.querySelector('[data-oaam-project-decision="add"]') !== null
    )) {
        throw new Error("the exact retained Project proposal did not resolve after restore");
    }
    const ordinaryText = workspace.textContent ?? "";
    if (ordinaryText.includes("registered Project is deleted") || ordinaryText.includes("project.operation_failed")) {
        throw new Error("the restored Project source review exposed a registration failure");
    }
    const guided = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="sources"]');
    const close = guided?.querySelector('.guided-import-heading button.library-secondary-button');
    if (!(close instanceof HTMLButtonElement) || close.disabled) throw new Error("cannot leave restored Project source review");
    close.click();
    await verifyRestoredProject(expected, "the restored Project");
    return {
        status: "complete",
        projectId: expected.projectId,
        displayName: expected.displayName,
        rootPath: expected.rootPath,
        restoredThroughReviewedLifecycle: true,
        finalActiveIdentityMatches: true,
        rawRegistrationFailureAbsent: true,
    };
})()`;
}

interface StoppedProjectReceipt {
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly selectedProjectId: string | null;
    readonly nonSelectedTargetVerified: boolean;
    readonly continuedWithoutBackup: boolean;
    readonly rememberChoiceFalse: boolean;
    readonly rememberChoiceSwitchClickCount: 0 | 1;
}

function parseStopped(value: unknown): StoppedProjectReceipt {
    if (
        !exactRecord(value, [
            "activeTreeEntryAbsentAfterStop",
            "continuedWithoutBackup",
            "displayName",
            "nonSelectedTargetVerified",
            "projectId",
            "rootPath",
            "rememberChoiceFalse",
            "rememberChoiceSwitchClickCount",
            "selectedProjectId",
            "status",
            "stoppedThroughReviewedLifecycle",
        ]) ||
        value.status !== "complete" ||
        typeof value.projectId !== "string" ||
        typeof value.displayName !== "string" ||
        typeof value.rootPath !== "string" ||
        (value.selectedProjectId !== null && typeof value.selectedProjectId !== "string") ||
        typeof value.nonSelectedTargetVerified !== "boolean" ||
        typeof value.continuedWithoutBackup !== "boolean" ||
        typeof value.rememberChoiceFalse !== "boolean" ||
        (value.rememberChoiceSwitchClickCount !== 0 && value.rememberChoiceSwitchClickCount !== 1) ||
        value.stoppedThroughReviewedLifecycle !== true ||
        value.activeTreeEntryAbsentAfterStop !== true
    ) {
        throw new TypeError("invalid packaged stopped-Project receipt");
    }
    return Object.freeze({
        projectId: value.projectId,
        displayName: value.displayName,
        rootPath: value.rootPath,
        selectedProjectId: value.selectedProjectId,
        nonSelectedTargetVerified: value.nonSelectedTargetVerified,
        continuedWithoutBackup: value.continuedWithoutBackup,
        rememberChoiceFalse: value.rememberChoiceFalse,
        rememberChoiceSwitchClickCount: value.rememberChoiceSwitchClickCount,
    });
}

function parseRetainedHistory(value: unknown, stopped: StoppedProjectReceipt): void {
    if (
        !exactRecord(value, [
            "displayName",
            "projectId",
            "retainedHistoryAfterPrimaryContent",
            "retainedHistoryCollapsed",
            "rootPath",
            "status",
        ]) ||
        value.status !== "complete" ||
        value.projectId !== stopped.projectId ||
        value.displayName !== stopped.displayName ||
        value.rootPath !== stopped.rootPath ||
        value.retainedHistoryCollapsed !== true ||
        value.retainedHistoryAfterPrimaryContent !== true
    ) {
        throw new TypeError("invalid packaged retained-Project history receipt");
    }
}

function parseReview(value: unknown): {
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly proposalKey: string;
    readonly sourceScrollTopBefore: number;
    readonly sourceScrollTopAfterOpen: number;
} {
    if (
        !exactRecord(value, [
            "displayName",
            "exactRetainedProposalObserved",
            "projectId",
            "proposalKey",
            "rawRegistrationFailureAbsent",
            "registrationDialogAbsent",
            "restoreBackdropCoversViewport",
            "restoreDialogAtDocumentBody",
            "restoreReviewBoundSameIdentity",
            "rootPath",
            "sourceScrollPreservedOnOpen",
            "sourceScrollTopAfterOpen",
            "sourceScrollTopBefore",
            "status",
        ]) ||
        value.status !== "review_ready" ||
        typeof value.projectId !== "string" ||
        typeof value.displayName !== "string" ||
        typeof value.rootPath !== "string" ||
        typeof value.proposalKey !== "string" ||
        value.exactRetainedProposalObserved !== true ||
        value.registrationDialogAbsent !== true ||
        value.restoreDialogAtDocumentBody !== true ||
        value.restoreBackdropCoversViewport !== true ||
        value.restoreReviewBoundSameIdentity !== true ||
        typeof value.sourceScrollTopBefore !== "number" ||
        !Number.isFinite(value.sourceScrollTopBefore) ||
        value.sourceScrollTopBefore <= 0 ||
        typeof value.sourceScrollTopAfterOpen !== "number" ||
        !Number.isFinite(value.sourceScrollTopAfterOpen) ||
        Math.abs(value.sourceScrollTopAfterOpen - value.sourceScrollTopBefore) > 1 ||
        value.sourceScrollPreservedOnOpen !== true ||
        value.rawRegistrationFailureAbsent !== true
    ) {
        throw new TypeError("invalid packaged retained-Project restore review receipt");
    }
    return Object.freeze({
        projectId: value.projectId,
        displayName: value.displayName,
        rootPath: value.rootPath,
        proposalKey: value.proposalKey,
        sourceScrollTopBefore: value.sourceScrollTopBefore,
        sourceScrollTopAfterOpen: value.sourceScrollTopAfterOpen,
    });
}

function parseFinal(value: unknown): { readonly projectId: string; readonly displayName: string; readonly rootPath: string } {
    if (
        !exactRecord(value, [
            "displayName",
            "finalActiveIdentityMatches",
            "projectId",
            "rawRegistrationFailureAbsent",
            "restoredThroughReviewedLifecycle",
            "rootPath",
            "status",
        ]) ||
        value.status !== "complete" ||
        typeof value.projectId !== "string" ||
        typeof value.displayName !== "string" ||
        typeof value.rootPath !== "string" ||
        value.restoredThroughReviewedLifecycle !== true ||
        value.finalActiveIdentityMatches !== true ||
        value.rawRegistrationFailureAbsent !== true
    ) {
        throw new TypeError("invalid packaged restored-Project receipt");
    }
    return Object.freeze({ projectId: value.projectId, displayName: value.displayName, rootPath: value.rootPath });
}

function parseSettingsRestore(
    value: unknown,
    status: "retained_ready" | "review_ready" | "complete",
    subject: PackagedProjectStopSubject,
): void {
    if (
        !exactRecord(value, ["displayName", "projectId", "rootPath", "selectedProjectId", "status"]) ||
        value.status !== status ||
        value.projectId !== subject.projectId ||
        value.displayName !== subject.displayName ||
        value.rootPath !== subject.rootPath ||
        value.selectedProjectId !== subject.selectedProjectId
    ) {
        throw new TypeError(`invalid packaged Settings Project-restore ${status} receipt`);
    }
}

async function stopProjectToRetainedHistory(
    webContents: PackagedRetainedProjectRecoveryWebContents,
    subject: PackagedRetainedProjectRecoverySubject | PackagedProjectStopSubject,
    options: { readonly onActiveAbsent?: () => Promise<void>; readonly onRetainedReady?: () => Promise<void> },
): Promise<StoppedProjectReceipt> {
    const stopped = parseStopped(await webContents.executeJavaScript(stopRetainedProjectScript(subject)));
    if (stopped.displayName !== subject.displayName || stopped.rootPath !== subject.rootPath) {
        throw new TypeError("packaged stopped-Project receipt changed the requested subject");
    }
    if (
        "projectId" in subject &&
        (stopped.projectId !== subject.projectId ||
            stopped.selectedProjectId !== subject.selectedProjectId ||
            !stopped.nonSelectedTargetVerified ||
            !stopped.continuedWithoutBackup ||
            !stopped.rememberChoiceFalse)
    ) {
        throw new TypeError("packaged stopped-Project receipt changed the non-selected Project identity");
    }
    await options.onActiveAbsent?.();
    parseRetainedHistory(await webContents.executeJavaScript(retainedProjectHistoryScript(stopped)), stopped);
    await options.onRetainedReady?.();
    return stopped;
}

export function readPackagedProjectStopSubject(profileRootPath: string): PackagedProjectStopSubject {
    return readPackagedProjectSubject(profileRootPath, PACKAGED_PROJECT_STOP_SUBJECT_FILE_NAME);
}

export function readPackagedProjectRestoreSubject(profileRootPath: string): PackagedProjectStopSubject {
    return readPackagedProjectSubject(profileRootPath, PACKAGED_PROJECT_RESTORE_SUBJECT_FILE_NAME);
}

function readPackagedProjectSubject(profileRootPath: string, fileName: string): PackagedProjectStopSubject {
    const filePath = path.join(profileRootPath, fileName);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 4_096) {
        throw new TypeError("packaged Project-stop subject must be one bounded direct file");
    }
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (
        !exactRecord(value, ["displayName", "projectId", "rootPath", "schemaVersion", "selectedProjectId"]) ||
        value.schemaVersion !== 1 ||
        typeof value.projectId !== "string" ||
        typeof value.selectedProjectId !== "string" ||
        value.projectId === value.selectedProjectId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.projectId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.selectedProjectId) ||
        typeof value.displayName !== "string" ||
        value.displayName.length < 1 ||
        value.displayName.length > 240 ||
        value.displayName.trim() !== value.displayName ||
        typeof value.rootPath !== "string" ||
        !/^\\\\wsl\.localhost\\[^\\]+\\/iu.test(value.rootPath) ||
        path.win32.normalize(value.rootPath) !== value.rootPath
    ) {
        throw new TypeError("invalid packaged Project-stop subject");
    }
    return Object.freeze({
        projectId: value.projectId,
        selectedProjectId: value.selectedProjectId,
        displayName: value.displayName,
        rootPath: value.rootPath,
    });
}

export function packagedRetainedProjectProofMode(argv: readonly string[]): "stop" | "restore" | undefined {
    if (argv.includes(PACKAGED_PROJECT_RESTORE_SMOKE_SWITCH)) return "restore";
    return argv.includes(PACKAGED_PROJECT_STOP_SMOKE_SWITCH) ? "stop" : undefined;
}

export function packagedRetainedProjectProofText(mode: "stop" | "restore", kind: "line" | "label"): string {
    const identity = `OAAM_DESKTOP_PROJECT_${mode.toUpperCase()}`;
    return kind === "line" ? `${identity} passed` : `${identity}_SMOKE`;
}

export async function proveWindowsPackagedProjectStopStage(
    webContents: PackagedProjectStopWebContents,
    temporaryRootPath: string,
    readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    subject: PackagedProjectStopSubject,
): Promise<PackagedProjectStopProof> {
    const screenshots = new PackagedProviderScreenshotProof<PackagedProjectStopStage, unknown>(
        path.join(temporaryRootPath, PACKAGED_PROJECT_STOP_DIRECTORY),
        PACKAGED_PROJECT_STOP_STAGES,
        "Project-stop",
    );
    const before = await waitForPackagedAssetUsageAuthorityQuiescence(readAuthoritySnapshot, subject.selectedProjectId);
    const stopped = await stopProjectToRetainedHistory(webContents, subject, {
        onActiveAbsent: () => screenshots.capture("project-stop-active", webContents),
        onRetainedReady: () => screenshots.capture("project-stop-retained", webContents),
    });
    const after = await waitForPackagedAssetUsageAuthorityQuiescence(readAuthoritySnapshot, subject.selectedProjectId);
    const delta = diffPackagedAssetUsageAuthority(before, after);
    if (
        delta.preferencesChanged ||
        !isPackagedAssetUsageObservabilitySnapshotComparable(after) ||
        (delta.observabilityChanged && !delta.observability.validDurableReplacementGrowth)
    ) {
        screenshots.recordAuthorityChange({ schemaVersion: 1, before, after, delta });
        throw new Error("packaged Project stop changed preferences or emitted invalid observability");
    }
    const proof: PackagedProjectStopProof = Object.freeze({
        status: "complete",
        projectId: stopped.projectId,
        selectedProjectId: subject.selectedProjectId,
        displayName: stopped.displayName,
        rootPath: stopped.rootPath,
        nonSelectedTargetVerified: true,
        rememberChoiceSwitchClickCount: stopped.rememberChoiceSwitchClickCount,
        rememberChoiceFalse: true,
        continuedWithoutBackup: true,
        activeTreeEntryAbsentAfterStop: true,
        retainedHistoryCollapsed: true,
        retainedHistoryAfterPrimaryContent: true,
    });
    screenshots.finalize({ status: "complete", proof, authority: { before, after, delta } });
    return proof;
}

export async function proveWindowsPackagedProjectRestoreStage(
    webContents: PackagedProjectStopWebContents,
    temporaryRootPath: string,
    readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    subject: PackagedProjectStopSubject,
): Promise<PackagedProjectRestoreProof> {
    const screenshots = new PackagedProviderScreenshotProof<PackagedProjectRestoreStage, unknown>(
        path.join(temporaryRootPath, PACKAGED_PROJECT_RESTORE_DIRECTORY),
        PACKAGED_PROJECT_RESTORE_STAGES,
        "Project-restore",
    );
    const before = await waitForPackagedAssetUsageAuthorityQuiescence(readAuthoritySnapshot, subject.selectedProjectId);
    const structuralCoordination = ["transactions", "transactions/authority-locks", "transactions/authority-locks/projects"];
    if (structuralCoordination.some((entry) => !before.coordinationPaths.includes(entry))) {
        throw new Error("packaged Project restore baseline did not establish its Core lock namespace");
    }
    parseSettingsRestore(await webContents.executeJavaScript(retainedSettingsReadyScript(subject)), "retained_ready", subject);
    await screenshots.capture("project-restore-retained", webContents);
    parseSettingsRestore(await webContents.executeJavaScript(openSettingsRestoreReviewScript(subject)), "review_ready", subject);
    await screenshots.capture("project-restore-review", webContents);
    parseSettingsRestore(await webContents.executeJavaScript(commitSettingsRestoreScript(subject)), "complete", subject);
    await screenshots.capture("project-restore-active", webContents);
    const after = await waitForPackagedAssetUsageAuthorityQuiescence(readAuthoritySnapshot, subject.selectedProjectId);
    const delta = diffPackagedAssetUsageAuthority(before, after);
    const expectedAnchors = [
        `transactions/authority-locks/projects/${subject.projectId}.lock`,
        "transactions/authority-locks/projects/catalog.lock",
    ].sort();
    const expectedAdded = expectedAnchors.filter((entry) => !before.coordinationPaths.includes(entry));
    const transactionBusinessChanged = [
        ...delta.businessAuthority.added.map((entry) => entry.relativePath),
        ...delta.businessAuthority.removed.map((entry) => entry.relativePath),
        ...delta.businessAuthority.changed.map((entry) => entry.relativePath),
    ].some((entry) => entry === "transactions" || entry.startsWith("transactions/"));
    if (
        !delta.businessAuthorityChanged ||
        delta.preferencesChanged ||
        JSON.stringify(delta.coordination.added) !== JSON.stringify(expectedAdded) ||
        delta.coordination.removed.length !== 0 ||
        expectedAnchors.some((entry) => !after.coordinationPaths.includes(entry)) ||
        transactionBusinessChanged ||
        !isPackagedAssetUsageObservabilitySnapshotComparable(after) ||
        (delta.observabilityChanged && !delta.observability.validDurableReplacementGrowth)
    ) {
        screenshots.recordAuthorityChange({ schemaVersion: 1, before, after, delta });
        throw new Error("packaged Project restore escaped its exact catalog or coordination boundary");
    }
    const proof: PackagedProjectRestoreProof = Object.freeze({
        status: "complete",
        ...subject,
        retainedRowMatchedExactIdentity: true,
        restoredThroughReviewedLifecycle: true,
        finalActiveIdentityMatches: true,
        selectedProjectPreserved: true,
    });
    screenshots.finalize({ status: "complete", proof, authority: { before, after, delta } });
    return proof;
}

export function proveWindowsPackagedRetainedProjectStage(
    mode: "stop" | "restore",
    webContents: PackagedProjectStopWebContents,
    temporaryRootPath: string,
    readAuthoritySnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    profileRootPath: string,
): Promise<PackagedProjectStopProof | PackagedProjectRestoreProof> {
    return mode === "stop"
        ? proveWindowsPackagedProjectStopStage(
              webContents,
              temporaryRootPath,
              readAuthoritySnapshot,
              readPackagedProjectStopSubject(profileRootPath),
          )
        : proveWindowsPackagedProjectRestoreStage(
              webContents,
              temporaryRootPath,
              readAuthoritySnapshot,
              readPackagedProjectRestoreSubject(profileRootPath),
          );
}

export async function proveWindowsPackagedRetainedProjectRecovery(
    webContents: PackagedRetainedProjectRecoveryWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    subject: PackagedRetainedProjectRecoverySubject,
    options: PackagedRetainedProjectRecoveryOptions,
): Promise<PackagedRetainedProjectRecoveryProof> {
    const stopped = await stopProjectToRetainedHistory(webContents, subject, {
        onRetainedReady: () => options.capture("provider-sweep-retained-library"),
    });
    const entered = await webContents.executeJavaScript(ENTER_REDISCOVERY_SCRIPT);
    if (!exactRecord(entered, ["status"]) || entered.status !== "ready") {
        throw new TypeError("invalid packaged retained-Project rediscovery entry receipt");
    }
    await proveWindowsWslEnvironmentChoice(webContents, resolveWslHomePath, { selectedAdapterIds: subject.adapterIds });
    const review = parseReview(await webContents.executeJavaScript(openRestoreReviewScript(subject, stopped)));
    if (
        review.projectId !== stopped.projectId ||
        review.displayName !== subject.displayName ||
        review.rootPath !== subject.rootPath
    ) {
        throw new TypeError("packaged retained-Project review changed the stopped identity");
    }
    await options.capture("provider-sweep-retained-restore-review");
    const final = parseFinal(await webContents.executeJavaScript(commitRestoreScript(review)));
    if (
        final.projectId !== stopped.projectId ||
        final.displayName !== subject.displayName ||
        final.rootPath !== subject.rootPath
    ) {
        throw new TypeError("packaged restored-Project receipt changed the reviewed identity");
    }
    await options.capture("provider-sweep-restored-project");
    return Object.freeze({
        status: "complete",
        projectId: stopped.projectId,
        displayName: stopped.displayName,
        rootPath: stopped.rootPath,
        stoppedThroughReviewedLifecycle: true,
        activeTreeEntryAbsentAfterStop: true,
        retainedHistoryCollapsed: true,
        retainedHistoryAfterPrimaryContent: true,
        exactRetainedProposalObserved: true,
        registrationDialogAbsent: true,
        restoreReviewBoundSameIdentity: true,
        restoreDialogAtDocumentBody: true,
        restoreBackdropCoversViewport: true,
        sourceScrollTopBefore: review.sourceScrollTopBefore,
        sourceScrollTopAfterOpen: review.sourceScrollTopAfterOpen,
        sourceScrollPreservedOnOpen: true,
        restoredThroughReviewedLifecycle: true,
        finalActiveIdentityMatches: true,
        rawRegistrationFailureAbsent: true,
    });
}
