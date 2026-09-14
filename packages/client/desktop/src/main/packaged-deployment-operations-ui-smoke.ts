export {
    PACKAGED_DEPLOYMENT_REPAIR_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_UI_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";
export const PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_DIRECTORY = "oaam-phase51-installed-deployment-repair";
export const PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_DIRECTORY = "oaam-phase51-installed-deployment-reverse";
export const PACKAGED_DEPLOYMENT_REPAIR_UI_LINE =
    "OAAM_DESKTOP_DEPLOYMENT_UI_SMOKE repair=reviewed+complete target=missing-to-in-sync";
export const PACKAGED_DEPLOYMENT_REVERSE_COMMIT_UI_LINE =
    "OAAM_DESKTOP_DEPLOYMENT_UI_SMOKE prewrite=managed-conflict reverse=prepared+cancelled+committed restart=pending";
export const PACKAGED_DEPLOYMENT_REVERSE_UI_LINE =
    "OAAM_DESKTOP_DEPLOYMENT_UI_SMOKE restart=fresh-core recovery=visible+complete marker=retired";

export const PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES = Object.freeze(["repair-review", "repair-complete"] as const);
export const PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES = Object.freeze([
    "prewrite-conflict",
    "conflict-inspection",
    "reverse-prepared",
    "reverse-cancelled",
    "reverse-committed",
] as const);
export const PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_SCREENSHOT_STAGES = Object.freeze([
    "restart-recovery-required",
    "recovered",
] as const);
export const PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES = Object.freeze([
    ...PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES,
    ...PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_SCREENSHOT_STAGES,
] as const);

export type PackagedDeploymentRepairScreenshotStage = (typeof PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES)[number];
export type PackagedDeploymentReverseScreenshotStage = (typeof PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES)[number];
export type PackagedDeploymentReverseCommitScreenshotStage = Exclude<
    PackagedDeploymentReverseScreenshotStage,
    "restart-recovery-required" | "recovered"
>;
export type PackagedDeploymentReverseRecoveryScreenshotStage = Extract<
    PackagedDeploymentReverseScreenshotStage,
    "restart-recovery-required" | "recovered"
>;
export type PackagedDeploymentUiMode = "deployment_repair" | "deployment_reverse_commit" | "deployment_reverse_recovery";

export interface PackagedDeploymentUiWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedDeploymentRepairUiProof {
    readonly status: "complete";
    readonly mode: "repair";
    readonly ordinaryEntry: true;
    readonly missingTargetReviewed: true;
    readonly conflictCount: number;
    readonly repairedStage: "in_sync";
}

export interface PackagedDeploymentReverseCommitUiProof {
    readonly status: "pending_restart";
    readonly mode: "reverse";
    readonly ordinaryEntry: true;
    readonly prewriteAction: "blocked_managed_conflict";
    readonly changeCount: number;
    readonly prepared: true;
    readonly cancelled: true;
    readonly committed: true;
}

export interface PackagedDeploymentReverseUiProof extends Omit<PackagedDeploymentReverseCommitUiProof, "status"> {
    readonly status: "complete";
    readonly processRestarted: true;
    readonly durableRecoveryVisible: true;
    readonly markerRetired: true;
    readonly recoveredStage: "in_sync";
}

interface PackagedDeploymentRepairUiOptions {
    readonly capture: (stage: PackagedDeploymentRepairScreenshotStage) => Promise<void>;
}

interface PackagedDeploymentReverseCommitUiOptions {
    readonly capture: (stage: PackagedDeploymentReverseCommitScreenshotStage) => Promise<void>;
}

interface PackagedDeploymentReverseRecoveryUiOptions {
    readonly commitProof: PackagedDeploymentReverseCommitUiProof;
    readonly capture: (stage: PackagedDeploymentReverseRecoveryScreenshotStage) => Promise<void>;
}

const OPEN_DEPLOYMENT_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    let expectedProjectId = "";
    while (Date.now() < deadline) {
        const onboarding = document.querySelector(
            'main[data-oaam-route="onboarding"][data-oaam-state="ready"][data-oaam-step="welcome"]'
        );
        if (onboarding instanceof HTMLElement) {
            const later = onboarding.querySelector(".onboarding-actions .library-secondary-button");
            if (!(later instanceof HTMLButtonElement) || later.disabled) {
                throw new Error("onboarding Set up later is unavailable");
            }
            later.click();
        }
        const library = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        if (library instanceof HTMLElement) {
            if (library.dataset.oaamSubject !== "projects") {
                const projects = library.querySelector('[data-oaam-subject-choice="projects"]');
                if (projects instanceof HTMLButtonElement && !projects.disabled) projects.click();
            } else {
                const projectChoices = Array.from(library.querySelectorAll('button[data-oaam-project-id]'));
                projectSearch: for (const project of projectChoices) {
                    if (project instanceof HTMLButtonElement) {
                        if (project.disabled) {
                            throw new Error("ordinary Project Deployment proof Project is unavailable");
                        }
                        const projectId = project.dataset.oaamProjectId ?? "";
                        if (projectId === "") {
                            throw new Error("ordinary Project Deployment proof Project identity is unavailable");
                        }
                        if (project.getAttribute("aria-current") !== "page" || library.dataset.oaamProjectId !== projectId) {
                            project.click();
                        }
                        const selectionDeadline = Date.now() + 5000;
                        while (Date.now() < selectionDeadline) {
                            const selectedLibrary = document.querySelector(
                                'main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]'
                            );
                            const open =
                                selectedLibrary instanceof HTMLElement && selectedLibrary.dataset.oaamProjectId === projectId
                                    ? selectedLibrary.querySelector('[data-oaam-action="open-deployments"]')
                                    : null;
                            if (open instanceof HTMLButtonElement && !open.disabled) {
                                expectedProjectId = projectId;
                                open.focus();
                                open.click();
                                break projectSearch;
                            }
                            await new Promise((resolve) => setTimeout(resolve, 25));
                        }
                    }
                }
                if (expectedProjectId !== "") break;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (expectedProjectId === "") {
        throw new Error("ordinary Project Deployment proof did not select its exact Project");
    }
    const deploymentDeadline = Date.now() + 30000;
    while (Date.now() < deploymentDeadline) {
        const route = document.querySelector(
            'main[data-oaam-route="deployment"][data-oaam-subject="project"][data-oaam-project-id="' +
                CSS.escape(expectedProjectId) +
                '"]'
        );
        const workspace = route?.querySelector(
            '.catalog-deployment-workspace[data-oaam-deployment-workspace-state="ready"][data-oaam-deployment-count="1"]'
        );
        if (route instanceof HTMLElement && workspace instanceof HTMLElement) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("ordinary Project Deployment entry did not open one current Deployment");
})`;

const SELECT_DEPLOYMENT_SCRIPT = `(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const entry = document.querySelector("[data-oaam-deployment-entry]");
        const selection = entry?.querySelector('[data-oaam-deployment-action="select"] input[type="radio"]');
        if (entry instanceof HTMLElement && selection instanceof HTMLInputElement && !selection.disabled) {
            selection.focus();
            selection.click();
            const selectedDeadline = Date.now() + 10000;
            while (Date.now() < selectedDeadline) {
                const root = document.querySelector(".catalog-deployment-workspace");
                if (
                    root instanceof HTMLElement &&
                    root.dataset.oaamSelectedDeploymentStage !== "none"
                ) {
                    entry.scrollIntoView({ block: "start" });
                    return root.dataset.oaamSelectedDeploymentStage;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("current Deployment could not be selected");
})`;

const INVOKE_ACTION_SCRIPT = `(async (actionName, label) => {
    const actionDeadline = Date.now() + 15000;
    while (Date.now() < actionDeadline) {
        const action = document.querySelector('[data-oaam-deployment-action="' + actionName + '"]');
        if (action instanceof HTMLButtonElement && !action.disabled) {
            action.focus();
            action.click();
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(label + " action was not available");
})`;

const WAIT_FOR_ACTION_SCRIPT = `(async (expectations, label, deadline) => {
    while (Date.now() < deadline) {
        const root = document.querySelector(".catalog-deployment-workspace");
        if (
            root instanceof HTMLElement &&
            Object.entries(expectations).every(([key, value]) => root.dataset[key] === value)
        ) {
            const review = root.querySelector(
                '[data-oaam-reverse-review], .inspection-summary, .render-analysis, [data-oaam-deployment-entry]'
            );
            (review instanceof HTMLElement ? review : root).scrollIntoView({ block: "center" });
            return {
                stage: root.dataset.oaamSelectedDeploymentStage ?? "",
                changeCount: Number.parseInt(root.dataset.oaamInspectionChangeCount ?? "0", 10),
                conflictCount: Number.parseInt(root.dataset.oaamInspectionConflictCount ?? "0", 10),
                preview: root.dataset.oaamDeploymentPreview ?? "",
                reverse: root.dataset.oaamDeploymentReverse ?? "",
                message: root.dataset.oaamDeploymentMessage ?? "",
                diagnosticCount: Number.parseInt(root.dataset.oaamDeploymentDiagnosticCount ?? "-1", 10),
                reconciliation: root.dataset.oaamDeploymentReconciliation ?? "",
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const root = document.querySelector(".catalog-deployment-workspace");
    const technical = Array.from(document.querySelectorAll(".protocol-technical-record"))
        .map((entry) => entry.textContent?.replace(/\\s+/gu, " ").trim() ?? "")
        .filter((entry) => entry !== "");
    throw new Error(
        "Deployment action " +
            label +
            " did not reach its exact terminal presentation: " +
            JSON.stringify({
                activity: root instanceof HTMLElement ? root.dataset.oaamDeploymentActivity : undefined,
                stage: root instanceof HTMLElement ? root.dataset.oaamSelectedDeploymentStage : undefined,
                message: root instanceof HTMLElement ? root.dataset.oaamDeploymentMessage : undefined,
                technical,
            })
    );
})`;

const SELECT_RENDER_OPTIONS_SCRIPT = `(async (selector) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const options = Array.from(document.querySelectorAll(selector + ' input[type="radio"]')).filter(
            (option) => option instanceof HTMLInputElement && !option.disabled
        );
        const automatic = Array.from(document.querySelectorAll(selector)).filter(
            (option) => option instanceof HTMLElement && option.dataset.oaamRenderOptionAutoSelected === "true"
        );
        const firstByGroup = new Map();
        for (const option of options) {
            if (option instanceof HTMLInputElement && option.name !== "" && !firstByGroup.has(option.name)) {
                firstByGroup.set(option.name, option);
            }
        }
        if (firstByGroup.size > 0) {
            for (const option of firstByGroup.values()) {
                option.focus();
                option.click();
            }
            return true;
        }
        if (automatic.length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Deployment render option is unavailable for " + selector);
})`;

const CONFIRM_REVERSE_PROMOTION_IF_REQUIRED_SCRIPT = `(() => {
    const confirmation = document.querySelector('[data-oaam-reverse-confirm] input[type="checkbox"]');
    if (confirmation instanceof HTMLInputElement && !confirmation.disabled && !confirmation.checked) {
        confirmation.focus();
        confirmation.click();
    }
    return confirmation instanceof HTMLInputElement;
})`;

const PROVE_FRESH_RESTART_RECOVERY_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const root = document.querySelector(".catalog-deployment-workspace");
        const recover = root?.querySelector('[data-oaam-deployment-action="recover"]');
        if (
            root instanceof HTMLElement &&
            root.dataset.oaamSelectedDeploymentStage === "blocked" &&
            root.dataset.oaamDeploymentStale === "false" &&
            root.dataset.oaamDeploymentReverse === "none" &&
            root.dataset.oaamDeploymentReconciliation === "none" &&
            root.dataset.oaamDeploymentDiagnosticCount === "0" &&
            recover instanceof HTMLButtonElement &&
            !recover.disabled
        ) {
            recover.scrollIntoView({ block: "center" });
            return {
                stage: root.dataset.oaamSelectedDeploymentStage,
                reverse: root.dataset.oaamDeploymentReverse,
                reconciliation: root.dataset.oaamDeploymentReconciliation,
                stale: root.dataset.oaamDeploymentStale,
                diagnosticCount: Number.parseInt(root.dataset.oaamDeploymentDiagnosticCount, 10),
                recoverAvailable: true,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const root = document.querySelector(".catalog-deployment-workspace");
    throw new Error(
        "fresh renderer did not project durable reverse recovery: " +
            JSON.stringify({
                stage: root instanceof HTMLElement ? root.dataset.oaamSelectedDeploymentStage : undefined,
                reverse: root instanceof HTMLElement ? root.dataset.oaamDeploymentReverse : undefined,
                reconciliation: root instanceof HTMLElement ? root.dataset.oaamDeploymentReconciliation : undefined,
                stale: root instanceof HTMLElement ? root.dataset.oaamDeploymentStale : undefined,
                diagnosticCount: root instanceof HTMLElement ? root.dataset.oaamDeploymentDiagnosticCount : undefined,
            })
    );
})`;

function proofRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`invalid packaged Deployment ${label} proof`);
    }
    return value as Record<string, unknown>;
}

function exactNumber(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new TypeError(`invalid packaged Deployment ${label} count`);
    }
    return value as number;
}

function executor(webContents: PackagedDeploymentUiWebContents) {
    return (script: string, ...inputs: readonly unknown[]): Promise<unknown> =>
        webContents.executeJavaScript(`(${script})(${inputs.map((value) => JSON.stringify(value)).join(",")})`);
}

function rendererNavigationInterrupted(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /execution context was destroyed|cannot find context|context.*destroyed|target.*navigat/iu.test(error.message);
}

async function runActionAndWait(
    execute: ReturnType<typeof executor>,
    actionName: string,
    expectations: Readonly<Record<string, string>>,
    label: string,
): Promise<unknown> {
    if ((await execute(INVOKE_ACTION_SCRIPT, actionName, label)) !== true) {
        throw new TypeError(`invalid packaged Deployment ${label} action proof`);
    }
    const deadline = Date.now() + 60_000;
    for (;;) {
        try {
            return await execute(WAIT_FOR_ACTION_SCRIPT, expectations, label, deadline);
        } catch (error) {
            if (!rendererNavigationInterrupted(error) || Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
}

export async function proveWindowsPackagedDeploymentRepairUi(
    webContents: PackagedDeploymentUiWebContents,
    options: PackagedDeploymentRepairUiOptions,
): Promise<PackagedDeploymentRepairUiProof> {
    const execute = executor(webContents);
    if ((await execute(OPEN_DEPLOYMENT_SCRIPT)) !== true) throw new TypeError("invalid ordinary Deployment entry proof");
    await execute(SELECT_DEPLOYMENT_SCRIPT);
    const scanned = proofRecord(
        await runActionAndWait(
            execute,
            "scan",
            { oaamDeploymentActivity: "idle", oaamSelectedDeploymentStage: "needs_repair" },
            "scan missing target",
        ),
        "missing-target scan",
    );
    if (scanned.stage !== "needs_repair") throw new TypeError("missing target did not require repair");
    const inspected = proofRecord(
        await runActionAndWait(
            execute,
            "inspect",
            { oaamDeploymentActivity: "idle", oaamDeploymentInspection: "ready" },
            "inspect missing target",
        ),
        "repair review",
    );
    const conflictCount = exactNumber(inspected.conflictCount, "repair review");
    await options.capture("repair-review");
    const repaired = proofRecord(
        await runActionAndWait(
            execute,
            "repair",
            {
                oaamDeploymentActivity: "idle",
                oaamSelectedDeploymentStage: "in_sync",
                oaamDeploymentReconciliation: "none",
            },
            "repair missing target",
        ),
        "repair result",
    );
    if (repaired.stage !== "in_sync") throw new TypeError("Deployment repair did not restore in-sync state");
    await options.capture("repair-complete");
    return Object.freeze({
        status: "complete",
        mode: "repair",
        ordinaryEntry: true,
        missingTargetReviewed: true,
        conflictCount,
        repairedStage: "in_sync",
    });
}

async function inspectExternalChange(execute: ReturnType<typeof executor>): Promise<{ readonly changeCount: number }> {
    const inspected = proofRecord(
        await runActionAndWait(
            execute,
            "inspect",
            { oaamDeploymentActivity: "idle", oaamDeploymentInspection: "ready" },
            "inspect external change",
        ),
        "external-change inspection",
    );
    return Object.freeze({ changeCount: exactNumber(inspected.changeCount, "external-change inspection") });
}

async function prepareReverse(execute: ReturnType<typeof executor>): Promise<void> {
    const prepared = proofRecord(
        await runActionAndWait(
            execute,
            "reverse.prepare",
            { oaamDeploymentActivity: "idle", oaamDeploymentReverse: "prepared" },
            "prepare reverse",
        ),
        "reverse preparation",
    );
    if (prepared.reverse !== "prepared") throw new TypeError("reverse preparation did not reach prepared state");
}

export async function proveWindowsPackagedDeploymentReverseCommitUi(
    webContents: PackagedDeploymentUiWebContents,
    options: PackagedDeploymentReverseCommitUiOptions,
): Promise<PackagedDeploymentReverseCommitUiProof> {
    const execute = executor(webContents);
    if ((await execute(OPEN_DEPLOYMENT_SCRIPT)) !== true) throw new TypeError("invalid ordinary Deployment entry proof");
    await execute(SELECT_DEPLOYMENT_SCRIPT);
    await runActionAndWait(
        execute,
        "scan",
        { oaamDeploymentActivity: "idle", oaamSelectedDeploymentStage: "conflict" },
        "scan external change",
    );
    await runActionAndWait(
        execute,
        "analyze",
        { oaamDeploymentActivity: "idle", oaamDeploymentAnalysis: "ready" },
        "analyze conflict",
    );
    if ((await execute(SELECT_RENDER_OPTIONS_SCRIPT, "[data-oaam-render-option]")) !== true) {
        throw new TypeError("invalid Deployment render selection proof");
    }
    const preview = proofRecord(
        await runActionAndWait(
            execute,
            "preview",
            { oaamDeploymentActivity: "idle", oaamDeploymentPreview: "ready:blocked_managed_conflict" },
            "preview managed conflict",
        ),
        "pre-write review",
    );
    if (preview.preview !== "ready:blocked_managed_conflict") {
        throw new TypeError("external change did not produce a managed-conflict pre-write review");
    }
    await options.capture("prewrite-conflict");
    const inspection = await inspectExternalChange(execute);
    await options.capture("conflict-inspection");
    await prepareReverse(execute);
    await options.capture("reverse-prepared");
    const cancelled = proofRecord(
        await runActionAndWait(
            execute,
            "reverse.cancel",
            {
                oaamDeploymentActivity: "idle",
                oaamDeploymentReverse: "none",
                oaamDeploymentMessage: "catalog.reverse.cancelled",
            },
            "cancel reverse",
        ),
        "reverse cancellation",
    );
    if (cancelled.message !== "catalog.reverse.cancelled") throw new TypeError("reverse cancellation was not presented");
    await options.capture("reverse-cancelled");
    await inspectExternalChange(execute);
    await prepareReverse(execute);
    if ((await execute(SELECT_RENDER_OPTIONS_SCRIPT, "[data-oaam-reverse-option]")) !== true) {
        throw new TypeError("invalid reverse render selection proof");
    }
    await execute(CONFIRM_REVERSE_PROMOTION_IF_REQUIRED_SCRIPT);
    const committed = proofRecord(
        await runActionAndWait(
            execute,
            "reverse.commit",
            {
                oaamDeploymentActivity: "idle",
                oaamDeploymentReverse: "result:committed",
                oaamDeploymentReconciliation: "terminal_result",
            },
            "commit reverse",
        ),
        "reverse commit",
    );
    if (committed.reverse !== "result:committed") throw new TypeError("reverse commit did not reach committed state");
    await options.capture("reverse-committed");
    return Object.freeze({
        status: "pending_restart",
        mode: "reverse",
        ordinaryEntry: true,
        prewriteAction: "blocked_managed_conflict",
        changeCount: inspection.changeCount,
        prepared: true,
        cancelled: true,
        committed: true,
    });
}

export async function proveWindowsPackagedDeploymentReverseRecoveryUi(
    webContents: PackagedDeploymentUiWebContents,
    options: PackagedDeploymentReverseRecoveryUiOptions,
): Promise<PackagedDeploymentReverseUiProof> {
    const commitProof = options.commitProof;
    if (
        commitProof.status !== "pending_restart" ||
        commitProof.mode !== "reverse" ||
        commitProof.ordinaryEntry !== true ||
        commitProof.prewriteAction !== "blocked_managed_conflict" ||
        !Number.isSafeInteger(commitProof.changeCount) ||
        commitProof.changeCount < 1 ||
        commitProof.prepared !== true ||
        commitProof.cancelled !== true ||
        commitProof.committed !== true
    ) {
        throw new TypeError("invalid packaged Deployment reverse commit proof");
    }
    const execute = executor(webContents);
    if ((await execute(OPEN_DEPLOYMENT_SCRIPT)) !== true) throw new TypeError("invalid ordinary Deployment entry proof");
    await execute(SELECT_DEPLOYMENT_SCRIPT);
    const restarted = proofRecord(await execute(PROVE_FRESH_RESTART_RECOVERY_SCRIPT), "fresh restart recovery");
    if (
        restarted.stage !== "blocked" ||
        restarted.reverse !== "none" ||
        restarted.reconciliation !== "none" ||
        restarted.stale !== "false" ||
        restarted.diagnosticCount !== 0 ||
        restarted.recoverAvailable !== true
    ) {
        throw new TypeError("fresh renderer did not expose only durable reverse recovery");
    }
    await options.capture("restart-recovery-required");
    const recovered = proofRecord(
        await runActionAndWait(
            execute,
            "recover",
            {
                oaamDeploymentActivity: "idle",
                oaamSelectedDeploymentStage: "in_sync",
                oaamDeploymentStale: "false",
                oaamDeploymentReverse: "none",
                oaamDeploymentReconciliation: "none",
            },
            "recover after reverse",
        ),
        "reverse recovery",
    );
    if (recovered.stage !== "in_sync") throw new TypeError("reverse recovery did not restore in-sync state");
    await options.capture("recovered");
    return Object.freeze({
        status: "complete",
        mode: commitProof.mode,
        ordinaryEntry: commitProof.ordinaryEntry,
        prewriteAction: commitProof.prewriteAction,
        changeCount: commitProof.changeCount,
        prepared: commitProof.prepared,
        cancelled: commitProof.cancelled,
        committed: commitProof.committed,
        processRestarted: true,
        durableRecoveryVisible: true,
        markerRetired: true,
        recoveredStage: "in_sync",
    });
}
