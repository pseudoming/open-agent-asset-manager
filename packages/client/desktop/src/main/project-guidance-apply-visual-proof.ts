import {
    CLAUDE_RUNTIME_ID,
    CLAUDE_RUNTIME_VERSION,
    PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS,
    type ProjectGuidanceApplySubject,
    type ProjectGuidanceSemanticSelection,
} from "./project-guidance-apply-ui-script";

export const PROJECT_GUIDANCE_VISUAL_STAGES = Object.freeze(["relationship", "authorization", "preview", "applied"] as const);

export type ProjectGuidanceVisualStage = (typeof PROJECT_GUIDANCE_VISUAL_STAGES)[number];

export interface ProjectGuidanceVisualStageInput {
    readonly stage: ProjectGuidanceVisualStage;
    readonly subject: ProjectGuidanceApplySubject;
    readonly targetKey: string;
    readonly deploymentId: string;
    readonly semanticSelections: readonly ProjectGuidanceSemanticSelection[];
    readonly desiredSha256: string;
}

export interface ProjectGuidanceVisualStageReceipt {
    readonly status: "complete";
    readonly visualStage: ProjectGuidanceVisualStage;
    readonly route: "deployment";
    readonly subject: "project";
    readonly projectId: string;
    readonly assetId: string;
    readonly targetKey: string;
    readonly deploymentId: string;
    readonly agentRuntimeId: typeof CLAUDE_RUNTIME_ID;
    readonly runtimeVersion: typeof CLAUDE_RUNTIME_VERSION;
    readonly relationshipState: string;
    readonly targetState: string;
    readonly managedState: string;
    readonly authorizationState: string;
    readonly semanticSelections: readonly ProjectGuidanceSemanticSelection[];
    readonly previewPath: string;
    readonly previewDesiredSha256: string;
    readonly applicationState: string;
    readonly versionState: string;
    readonly deploymentStage: string;
    readonly stablePaintFrames: number;
    readonly targetRect: Readonly<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>;
    readonly viewport: Readonly<{ width: number; height: number }>;
}

export interface ProjectGuidanceVisualTerminalReceipt {
    readonly status: "terminal";
    readonly stage: string;
    readonly code: "proof_assertion_failed";
    readonly lastObservation: Readonly<Record<string, unknown>>;
}

export class ProjectGuidanceVisualTerminalError extends Error {
    public readonly receipt: ProjectGuidanceVisualTerminalReceipt;

    public constructor(receipt: ProjectGuidanceVisualTerminalReceipt) {
        super(`packaged Project Guidance visual proof stopped at ${receipt.stage}: ${receipt.code}`);
        this.receipt = receipt;
    }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(value: unknown): value is ProjectGuidanceVisualTerminalReceipt {
    return (
        isRecord(value) &&
        exactKeys(value, ["code", "lastObservation", "stage", "status"]) &&
        value.status === "terminal" &&
        typeof value.stage === "string" &&
        value.code === "proof_assertion_failed" &&
        isRecord(value.lastObservation)
    );
}

function sameSelections(value: unknown, expected: readonly ProjectGuidanceSemanticSelection[]): boolean {
    return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function validBounds(value: unknown): boolean {
    return (
        isRecord(value) &&
        exactKeys(value, ["bottom", "height", "left", "right", "top", "width"]) &&
        Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
        Number(value.width) > 0 &&
        Number(value.height) > 0
    );
}

export function parseProjectGuidanceVisualStageReceipt(
    value: unknown,
    expected: ProjectGuidanceVisualStageInput,
): ProjectGuidanceVisualStageReceipt {
    if (isTerminal(value)) throw new ProjectGuidanceVisualTerminalError(value);
    if (
        !isRecord(value) ||
        !exactKeys(value, [
            "agentRuntimeId",
            "applicationState",
            "assetId",
            "authorizationState",
            "deploymentId",
            "deploymentStage",
            "managedState",
            "previewDesiredSha256",
            "previewPath",
            "projectId",
            "relationshipState",
            "route",
            "runtimeVersion",
            "semanticSelections",
            "stablePaintFrames",
            "status",
            "subject",
            "targetKey",
            "targetRect",
            "targetState",
            "versionState",
            "viewport",
            "visualStage",
        ]) ||
        value.status !== "complete" ||
        value.visualStage !== expected.stage ||
        value.route !== "deployment" ||
        value.subject !== "project" ||
        value.projectId !== expected.subject.projectId ||
        value.assetId !== expected.subject.assetId ||
        value.targetKey !== expected.targetKey ||
        value.deploymentId !== expected.deploymentId ||
        value.agentRuntimeId !== CLAUDE_RUNTIME_ID ||
        value.runtimeVersion !== CLAUDE_RUNTIME_VERSION ||
        value.stablePaintFrames !== 2 ||
        !validBounds(value.targetRect) ||
        !isRecord(value.viewport) ||
        !exactKeys(value.viewport, ["height", "width"]) ||
        !Number.isFinite(value.viewport.width) ||
        !Number.isFinite(value.viewport.height) ||
        !isRecord(value.targetRect) ||
        Number(value.targetRect.left) < 0 ||
        Number(value.targetRect.top) < 0 ||
        Number(value.targetRect.right) > Number(value.viewport.width) ||
        Number(value.targetRect.bottom) > Number(value.viewport.height)
    ) {
        throw new TypeError("invalid packaged Project Guidance visual stage receipt");
    }
    const identityValid =
        expected.stage === "relationship"
            ? value.relationshipState === "complete" &&
              value.targetState === "absent" &&
              value.managedState === "none" &&
              value.authorizationState === "" &&
              sameSelections(value.semanticSelections, []) &&
              value.previewPath === "" &&
              value.previewDesiredSha256 === "" &&
              value.applicationState === "" &&
              value.versionState === "" &&
              value.deploymentStage === ""
            : expected.stage === "authorization"
              ? value.relationshipState === "" &&
                value.targetState === "" &&
                value.managedState === "" &&
                value.authorizationState === "required" &&
                sameSelections(value.semanticSelections, []) &&
                value.previewPath === "" &&
                value.previewDesiredSha256 === "" &&
                value.applicationState === "" &&
                value.versionState === "" &&
                value.deploymentStage === ""
              : value.relationshipState === "" &&
                value.targetState === "" &&
                value.managedState === "" &&
                value.authorizationState === (expected.stage === "preview" ? "allowed" : "") &&
                sameSelections(value.semanticSelections, expected.semanticSelections) &&
                value.previewPath === "CLAUDE.md" &&
                value.previewDesiredSha256 === expected.desiredSha256 &&
                (expected.stage === "preview"
                    ? value.applicationState === "" && value.versionState === "" && value.deploymentStage === ""
                    : value.applicationState === "applied" &&
                      value.versionState === "current" &&
                      value.deploymentStage === "in_sync");
    if (!identityValid) {
        throw new TypeError("packaged Project Guidance visual stage identity changed");
    }
    return value as unknown as ProjectGuidanceVisualStageReceipt;
}

export function projectGuidanceVisualStageScript(input: ProjectGuidanceVisualStageInput): string {
    return `(async () => {
    const expected = ${JSON.stringify(input)};
    const requiredSemanticKinds = ${JSON.stringify(PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS)};
    let phase = "identify";
    let lastObservation = { phase };
    const detail = (value) => String(value instanceof Error ? value.message : value).replace(/\\s+/gu, " ").trim().slice(0, 240);
    const route = () => {
        const routes = [...document.querySelectorAll('main[data-oaam-route]')];
        if (routes.length !== 1 || !(routes[0] instanceof HTMLElement)) throw new Error("the visual proof route is missing or ambiguous");
        const value = routes[0];
        if (value.dataset.oaamRoute !== "deployment" || value.dataset.oaamSubject !== "project" || value.dataset.oaamState !== "ready" || value.dataset.oaamProjectId !== expected.subject.projectId || value.dataset.oaamAssetId !== expected.subject.assetId) throw new Error("the visual proof route identity changed");
        return value;
    };
    const selections = (root) => {
        const fieldsets = [...root.querySelectorAll('fieldset[data-oaam-semantic-kind]')];
        if (fieldsets.length !== requiredSemanticKinds.length) throw new Error("the visual proof semantic closure changed");
        return requiredSemanticKinds.map((semanticKind, index) => {
            const groups = fieldsets.filter((candidate) => candidate instanceof HTMLElement && candidate.dataset.oaamSemanticKind === semanticKind);
            if (groups.length !== 1 || !(groups[0] instanceof HTMLElement)) throw new Error("a visual proof semantic group is missing or duplicated");
            const wanted = expected.semanticSelections[index];
            if (wanted?.semanticKind !== semanticKind) throw new Error("the visual proof expected semantic identity changed");
            const options = [...groups[0].querySelectorAll('.preview-detail[data-oaam-render-option-fingerprint]')];
            if (options.length !== 1 || !(options[0] instanceof HTMLElement) || options[0].dataset.oaamSemanticRefFingerprint !== wanted.semanticRefFingerprint || options[0].dataset.oaamRenderOptionFingerprint !== wanted.optionFingerprint || options[0].dataset.oaamSubjectVersionId !== expected.subject.versionId || options[0].dataset.oaamRenderOutcome !== "preserved" || options[0].dataset.oaamReversePolicy !== "can_reconcile") throw new Error("a visual proof render option identity changed");
            const controls = [...options[0].querySelectorAll('[data-oaam-render-option]')];
            if (controls.length !== 1 || !(controls[0] instanceof HTMLElement)) throw new Error("a visual proof render selection changed");
            const explicit = [...controls[0].querySelectorAll('input[type="radio"]')];
            const automaticallySelected = controls[0].dataset.oaamRenderOptionAutoSelected === "true";
            if (automaticallySelected ? explicit.length !== 0 : explicit.length !== 1 || !(explicit[0] instanceof HTMLInputElement) || explicit[0].disabled || !explicit[0].checked || explicit[0].value !== wanted.optionFingerprint || explicit[0].name !== "catalog-render-" + wanted.semanticRefFingerprint) throw new Error("a visual proof render selection changed");
            return wanted;
        });
    };
    const locate = () => {
        const root = route();
        if (expected.stage === "relationship") {
            const rows = [...root.querySelectorAll('.asset-usage-row[data-oaam-agent-runtime-id="${CLAUDE_RUNTIME_ID}"][data-oaam-runtime-version="${CLAUDE_RUNTIME_VERSION}"]')];
            if (rows.length !== 1 || !(rows[0] instanceof HTMLElement)) throw new Error("the visual Claude relationship is missing or ambiguous");
            const row = rows[0];
            if (row.dataset.oaamTargetKey !== expected.targetKey || row.dataset.oaamAssetUsageAnalysis !== "complete" || row.dataset.oaamAssetUsageCapability !== "direct" || row.dataset.oaamAssetUsageTargetState !== "absent" || row.dataset.oaamAssetUsageManaged !== "none") throw new Error("the visual Claude relationship identity changed");
            return { root, target: row, authorizationState: "", semanticSelections: [], previewPath: "", previewDesiredSha256: "", applicationState: "", versionState: "", deploymentStage: "", relationshipState: "complete", targetState: "absent", managedState: "none" };
        }
        const summaries = expected.stage === "applied"
            ? [...root.querySelectorAll('.asset-usage-row')].filter(row => row instanceof HTMLElement && row.dataset.oaamAgentRuntimeId === "${CLAUDE_RUNTIME_ID}" && row.dataset.oaamDeploymentId === expected.deploymentId)
            : [...root.querySelectorAll('.deployment-create-target-summary')];
        if (summaries.length !== 1 || !(summaries[0] instanceof HTMLElement)) throw new Error("the visual Claude summary is missing or ambiguous");
        const summary = summaries[0];
        const targetReview = summary.closest(expected.stage === "applied" ? '.asset-usage-relationships[data-oaam-asset-usage-state="ready"]' : '[data-oaam-create-target-review]');
        if (!(targetReview instanceof HTMLElement)) throw new Error("the visual Claude target review has no shared scope owner");
        if (summary.dataset.oaamDeploymentId !== expected.deploymentId || summary.dataset.oaamTargetKey !== expected.targetKey || summary.dataset.oaamAgentRuntimeId !== "${CLAUDE_RUNTIME_ID}" || summary.dataset.oaamRuntimeVersion !== "${CLAUDE_RUNTIME_VERSION}") throw new Error("the visual Claude summary identity changed");
        if (expected.stage === "authorization") {
            const required = [...root.querySelectorAll('[data-oaam-promotion-authorization="required"]')];
            const allowed = [...root.querySelectorAll('[data-oaam-promotion-authorization="allowed"]')];
            const actions = [...root.querySelectorAll('[data-oaam-deployment-action="authorize-current-version"]')];
            if (required.length !== 1 || !(required[0] instanceof HTMLElement) || allowed.length !== 0 || actions.length !== 1 || !(actions[0] instanceof HTMLButtonElement) || actions[0].disabled || !required[0].contains(actions[0]) || !targetReview.contains(required[0]) || !targetReview.contains(actions[0])) throw new Error("the visual Claude authorization review changed");
            return { root, target: required[0], authorizationState: "required", semanticSelections: [], previewPath: "", previewDesiredSha256: "", applicationState: "", versionState: "", deploymentStage: "", relationshipState: "", targetState: "", managedState: "" };
        }
        if (expected.stage === "preview") {
            const allowed = [...root.querySelectorAll('[data-oaam-promotion-authorization="allowed"]')];
            if (allowed.length !== 1 || !(allowed[0] instanceof HTMLElement) || !targetReview.contains(allowed[0])) throw new Error("the visual Claude permission state changed");
            const semanticSelections = selections(root);
            const passiveSummary = root.querySelector('[data-oaam-render-passive-summary]');
            if (!(passiveSummary instanceof HTMLElement) || passiveSummary.querySelectorAll('[data-oaam-passive-semantic-kind]').length !== requiredSemanticKinds.length) throw new Error("the visual Claude semantic roles were not consolidated by Asset");
            const files = [...root.querySelectorAll('[data-oaam-preview-path]')];
            if (files.length !== 1 || !(files[0] instanceof HTMLElement) || files[0].dataset.oaamPreviewPath !== "CLAUDE.md" || files[0].dataset.oaamPreviewDesiredSha256 !== expected.desiredSha256) throw new Error("the visual CLAUDE.md preview identity changed");
            const actions = [...root.querySelectorAll('[data-oaam-deployment-action="deploy"]')];
            const decision = root.querySelector('[data-oaam-preview-decision="ready_apply"]');
            const textReview = files[0].querySelector('[data-oaam-preview-review-path="CLAUDE.md"]');
            if (actions.length !== 1 || !(actions[0] instanceof HTMLButtonElement) || actions[0].disabled || !(decision instanceof HTMLElement) || !decision.contains(actions[0]) || !(textReview instanceof HTMLButtonElement) || textReview.disabled) throw new Error("the visual Claude Apply decision is unavailable or detached from its file review");
            const target = files[0].closest('.inspection-summary');
            if (!(target instanceof HTMLElement)) throw new Error("the visual CLAUDE.md preview has no review context");
            return { root, target, authorizationState: "allowed", semanticSelections, previewPath: "CLAUDE.md", previewDesiredSha256: expected.desiredSha256, applicationState: "", versionState: "", deploymentStage: "", relationshipState: "", targetState: "", managedState: "" };
        }
        const workspace = root.querySelector('.catalog-deployment-workspace');
        const authorizationNotices = [...root.querySelectorAll('[data-oaam-promotion-authorization]')].filter(notice => notice.closest('[hidden]') === null);
        const states = [...summary.querySelectorAll('[data-oaam-application-state="applied"]')];
        const versions = [...summary.querySelectorAll('[data-oaam-application-version-state="current"]')];
        if (!(workspace instanceof HTMLElement) || workspace.dataset.oaamDeploymentActivity !== "idle" || workspace.dataset.oaamSelectedDeploymentStage !== "in_sync" || workspace.dataset.oaamDeploymentStale !== "false" || workspace.dataset.oaamDeploymentReconciliation !== "none" || authorizationNotices.length !== 0 || states.length !== 1 || versions.length !== 1) throw new Error("the visual applied Claude state changed");
        const outcomes = [...root.querySelectorAll('[data-oaam-deployment-result="deploy"]')];
        const outcome = outcomes[0];
        if (outcomes.length !== 1 || !(outcome instanceof HTMLElement) || outcome.dataset.oaamResultDeploymentId !== expected.deploymentId || outcome.dataset.oaamResultTargetKey !== expected.targetKey || outcome.dataset.oaamResultRuntimeIds !== JSON.stringify(["${CLAUDE_RUNTIME_ID}"]) || outcome.dataset.oaamResultRuntimeVersions !== JSON.stringify(["${CLAUDE_RUNTIME_VERSION}"]) || outcome.dataset.oaamResultVersionIds !== JSON.stringify([expected.subject.versionId]) || outcome.dataset.oaamResultFilePaths !== JSON.stringify(["CLAUDE.md"])) throw new Error("the visual applied outcome identity changed");
        return { root, target: outcome, authorizationState: "", semanticSelections: expected.semanticSelections, previewPath: "CLAUDE.md", previewDesiredSha256: expected.desiredSha256, applicationState: "applied", versionState: "current", deploymentStage: "in_sync", relationshipState: "", targetState: "", managedState: "" };
    };
    const nextPaint = () => new Promise((resolve) => {
        const remaining = expected.subject.terminalDeadlineAtMillisecondsSinceEpoch - Date.now();
        if (remaining <= 0) return resolve(false);
        const timeout = setTimeout(() => resolve(false), Math.min(100, remaining));
        requestAnimationFrame(() => { clearTimeout(timeout); resolve(true); });
    });
    try {
        let located = locate();
        located.target.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
        phase = "paint";
        let prior = null;
        let stablePaintFrames = 0;
        while (Date.now() < expected.subject.terminalDeadlineAtMillisecondsSinceEpoch) {
            if (!(await nextPaint())) continue;
            located = locate();
            const bounds = located.target.getBoundingClientRect();
            const targetRect = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
            const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight };
            const visible = targetRect.width > 0 && targetRect.height > 0 && targetRect.left >= 0 && targetRect.top >= 0 && targetRect.right <= viewport.width && targetRect.bottom <= viewport.height;
            stablePaintFrames = prior !== null && JSON.stringify(prior) === JSON.stringify(targetRect) ? stablePaintFrames + 1 : 1;
            prior = targetRect;
            lastObservation = { phase, visualStage: expected.stage, route: located.root.dataset.oaamRoute ?? "", projectId: located.root.dataset.oaamProjectId ?? "", targetKey: expected.targetKey, stablePaintFrames, visible, targetRect, viewport };
            if (visible && stablePaintFrames >= 2) return { status: "complete", visualStage: expected.stage, route: "deployment", subject: "project", projectId: expected.subject.projectId, assetId: expected.subject.assetId, targetKey: expected.targetKey, deploymentId: expected.deploymentId, agentRuntimeId: "${CLAUDE_RUNTIME_ID}", runtimeVersion: "${CLAUDE_RUNTIME_VERSION}", relationshipState: located.relationshipState, targetState: located.targetState, managedState: located.managedState, authorizationState: located.authorizationState, semanticSelections: located.semanticSelections, previewPath: located.previewPath, previewDesiredSha256: located.previewDesiredSha256, applicationState: located.applicationState, versionState: located.versionState, deploymentStage: located.deploymentStage, stablePaintFrames: 2, targetRect, viewport };
        }
        throw new Error("timed out waiting for a stable in-viewport visual target");
    } catch (error) {
        return { status: "terminal", stage: "visual_" + expected.stage, code: "proof_assertion_failed", lastObservation: { ...lastObservation, phase, detail: detail(error) } };
    }
})()`;
}

export async function prepareProjectGuidanceVisualStage(
    webContents: { executeJavaScript(script: string): Promise<unknown> },
    input: ProjectGuidanceVisualStageInput,
): Promise<ProjectGuidanceVisualStageReceipt> {
    return parseProjectGuidanceVisualStageReceipt(
        await webContents.executeJavaScript(projectGuidanceVisualStageScript(input)),
        input,
    );
}

export async function captureProjectGuidanceVisualStage(
    webContents: { executeJavaScript(script: string): Promise<unknown> },
    input: ProjectGuidanceVisualStageInput,
    capture: (receipt: ProjectGuidanceVisualStageReceipt) => Promise<void>,
): Promise<ProjectGuidanceVisualStageReceipt> {
    const receipt = await prepareProjectGuidanceVisualStage(webContents, input);
    await capture(receipt);
    return receipt;
}
