import type { DesktopEnvironmentIdentity } from "../desktop-environment-key";

export const CLAUDE_RUNTIME_ID = "CLAUDE_CODE_CLI";
export const CLAUDE_RUNTIME_VERSION = "2.1.220";
export const PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS = Object.freeze([
    "asset.file_inventory",
    "guidance.base_context",
    "guidance.content",
] as const);

export interface ProjectGuidanceSemanticSelection {
    readonly semanticKind: (typeof PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS)[number];
    readonly semanticRefFingerprint: string;
    readonly optionFingerprint: string;
}

export interface ProjectGuidanceApplySubject {
    readonly projectId: string;
    readonly rootPath: string;
    readonly assetId: string;
    readonly versionId: string;
    readonly sourceSha256: string;
    readonly environment: DesktopEnvironmentIdentity & { readonly platform: "wsl" };
    readonly environmentKey: string;
    readonly terminalDeadlineAtMillisecondsSinceEpoch: number;
}

function script(subject: ProjectGuidanceApplySubject, stage: string, body: string): string {
    return `(async () => {
    const expected = ${JSON.stringify(subject)};
    const stage = ${JSON.stringify(stage)};
    let phase = stage;
    let pollCount = 0;
    let observe = () => ({ phase });
    let lastObservation = observe();
    const detail = (value) => String(value instanceof Error ? value.message : value).replace(/\\s+/gu, " ").trim().slice(0, 240);
    const waitFor = async (predicate, label) => {
        phase = label;
        while (Date.now() < expected.terminalDeadlineAtMillisecondsSinceEpoch) {
            pollCount += 1;
            lastObservation = { ...observe(), phase, label, pollCount };
            const value = predicate();
            if (value !== undefined && value !== null && value !== false) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    try {
        ${body}
    } catch (error) {
        return { status: "terminal", stage, code: "proof_assertion_failed", lastObservation: { ...lastObservation, ...observe(), phase, detail: detail(error) } };
    }
})()`;
}

function semanticClosureScript(): string {
    return `const requiredSemanticKinds = ${JSON.stringify(PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS)};
        const collectSemanticSelections = (workspace, select, requireSelected = false) => {
            const fieldsets = [...workspace.querySelectorAll('fieldset[data-oaam-semantic-kind]')];
            if (fieldsets.length !== requiredSemanticKinds.length) throw new Error("the complete Guidance semantic group count changed");
            const byKind = new Map();
            const semanticRefs = new Set();
            const optionFingerprints = new Set();
            for (const fieldset of fieldsets) {
                if (!(fieldset instanceof HTMLFieldSetElement)) throw new Error("a Guidance semantic group has no machine fieldset");
                const semanticKind = fieldset.dataset.oaamSemanticKind ?? "";
                if (!requiredSemanticKinds.includes(semanticKind)) throw new Error("the Guidance review contains an unknown semantic group");
                if (byKind.has(semanticKind)) throw new Error("a Guidance semantic group is duplicated");
                const options = [...fieldset.querySelectorAll('.preview-detail[data-oaam-render-option-fingerprint]')].filter((candidate) => candidate.closest('fieldset') === fieldset);
                if (options.length !== 1 || !(options[0] instanceof HTMLElement)) throw new Error("a Guidance semantic group has no unique render choice");
                const option = options[0];
                if (option.dataset.oaamSubjectVersionId !== expected.versionId) throw new Error("a Guidance semantic group belongs to the wrong Asset Version or tool");
                const semanticRefFingerprint = option.dataset.oaamSemanticRefFingerprint ?? "";
                if (!/^[0-9a-f]{64}$/u.test(semanticRefFingerprint) || semanticRefs.has(semanticRefFingerprint)) throw new Error("a Guidance semantic identity is missing or duplicated");
                const optionFingerprint = option.dataset.oaamRenderOptionFingerprint ?? "";
                if (!/^[0-9a-f]{64}$/u.test(optionFingerprint) || optionFingerprints.has(optionFingerprint)) throw new Error("a Guidance render choice identity is missing or duplicated");
                if (option.dataset.oaamRenderOutcome !== "preserved" || option.dataset.oaamReversePolicy !== "can_reconcile") throw new Error("a Guidance render choice is not lossless and reversible");
                const controls = [...option.querySelectorAll('[data-oaam-render-option]')];
                if (controls.length !== 1 || !(controls[0] instanceof HTMLElement)) throw new Error("a Guidance render choice has no unique machine control");
                const choices = [...controls[0].querySelectorAll('input[type="radio"]')];
                const automaticallySelected = controls[0].dataset.oaamRenderOptionAutoSelected === "true";
                if (automaticallySelected && choices.length !== 0) throw new Error("a Guidance render choice has ambiguous automatic and explicit controls");
                if (!automaticallySelected && (choices.length !== 1 || !(choices[0] instanceof HTMLInputElement))) throw new Error("a Guidance render choice has no unique machine input");
                const choice = automaticallySelected ? null : choices[0];
                if (choice !== null) {
                    const inputSemanticRefFingerprint = choice.name.startsWith("catalog-render-") ? choice.name.slice("catalog-render-".length) : "";
                    if (inputSemanticRefFingerprint !== semanticRefFingerprint) throw new Error("a Guidance render choice belongs to the wrong semantic identity");
                    if (choice.disabled || choice.value !== optionFingerprint) throw new Error("a Guidance render choice is unavailable or has changed identity");
                }
                semanticRefs.add(semanticRefFingerprint);
                optionFingerprints.add(optionFingerprint);
                byKind.set(semanticKind, { semanticKind, semanticRefFingerprint, optionFingerprint, choice });
            }
            const selections = requiredSemanticKinds.map((semanticKind) => {
                const entry = byKind.get(semanticKind);
                if (entry === undefined) throw new Error("the complete Guidance semantic closure is missing");
                return entry;
            });
            if (select) {
                const pending = selections.find((entry) => entry.choice !== null && !entry.choice.checked);
                if (pending !== undefined) {
                    pending.choice.click();
                    return null;
                }
            }
            if (requireSelected && selections.some((entry) => entry.choice !== null && !entry.choice.checked)) return null;
            return selections.map(({ choice: _choice, ...entry }) => entry);
        };
        const sameSemanticSelections = (actual, wanted) => JSON.stringify(actual) === JSON.stringify(wanted);`;
}

export function projectGuidanceRelationshipScript(subject: ProjectGuidanceApplySubject): string {
    return script(
        subject,
        "relationship",
        `let sawProbeBusy = false;
        observe = () => {
            const active = document.querySelector('main[data-oaam-route]');
            const discovery = active?.querySelector('.deployment-target-discovery');
            const probes = discovery === null || discovery === undefined ? [] : [...discovery.querySelectorAll('[data-oaam-target-action="probe"]')];
            const alerts = discovery === null || discovery === undefined ? [] : [...discovery.querySelectorAll('[role="alert"]')];
            const relationship = active?.querySelector('.asset-usage-relationships');
            const rows = [...document.querySelectorAll('.asset-usage-row[data-oaam-agent-runtime-id="${CLAUDE_RUNTIME_ID}"]')];
            return { phase, route: active instanceof HTMLElement ? active.dataset.oaamRoute ?? "" : "", routeState: active instanceof HTMLElement ? active.dataset.oaamState ?? "" : "", subject: active instanceof HTMLElement ? active.dataset.oaamSubject ?? "" : "", exactProjectId: active instanceof HTMLElement ? active.dataset.oaamProjectId ?? "" : "", projectLocationState: discovery instanceof HTMLElement && discovery.dataset.oaamState === "loading" ? "loading" : alerts.length > 0 ? "failed" : probes.length === 1 && probes[0] instanceof HTMLButtonElement ? probes[0].disabled ? "pending" : "ready" : "unknown", probeCount: probes.length, probeEnabledCount: probes.filter((probe) => probe instanceof HTMLButtonElement && !probe.disabled).length, sawProbeBusy, relationshipState: relationship instanceof HTMLElement ? relationship.dataset.oaamAssetUsageState ?? "unknown" : "missing", alertCount: alerts.length, claudeRowCount: rows.length, claudeRows: rows.slice(0, 2).map((row) => ({ targetKey: row instanceof HTMLElement ? row.dataset.oaamTargetKey ?? "" : "", version: row instanceof HTMLElement ? row.dataset.oaamRuntimeVersion ?? "" : "", analysis: row instanceof HTMLElement ? row.dataset.oaamAssetUsageAnalysis ?? "" : "", targetState: row instanceof HTMLElement ? row.dataset.oaamAssetUsageTargetState ?? "" : "" })) };
        };
        await waitFor(() => {
            const values = [...document.querySelectorAll('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]')];
            if (values.length > 1) throw new Error("the Projects library is ambiguous");
            const value = values[0];
            if (!(value instanceof HTMLElement) || value.dataset.oaamProjectId !== expected.projectId) return false;
            const rows = [...value.querySelectorAll('.asset-tree-project[data-oaam-project-id="' + expected.projectId + '"]')];
            if (rows.length > 1) throw new Error("the exact Project row is ambiguous");
            return rows.length === 1 ? value : false;
        }, "exact_project_library");
        const open = await waitFor(() => {
            const libraries = [...document.querySelectorAll('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]')];
            if (libraries.length !== 1 || !(libraries[0] instanceof HTMLElement) || libraries[0].dataset.oaamProjectId !== expected.projectId) throw new Error("the exact Project library identity changed");
            const assets = [...libraries[0].querySelectorAll('.asset-library-item[data-oaam-asset-id="' + expected.assetId + '"]')];
            if (assets.length > 1) throw new Error("the exact Asset row is ambiguous");
            const asset = assets[0];
            if (!(asset instanceof HTMLElement)) return false;
            if (asset.dataset.status !== "complete" || asset.dataset.oaamRevision !== "1") throw new Error("the exact Asset is not complete revision 1");
            const actions = [...asset.querySelectorAll('[data-oaam-semantic-action="library.open_asset_deployment"]')];
            if (actions.length > 1) throw new Error("the exact Asset apply action is ambiguous");
            const action = actions[0];
            if (!(action instanceof HTMLButtonElement)) throw new Error("the exact Asset apply action is missing");
            return action.disabled ? false : action;
        }, "exact_asset_revision");
        open.click();
        await waitFor(() => {
            const values = [...document.querySelectorAll('main[data-oaam-route="deployment"][data-oaam-subject="project"][data-oaam-deployment-mode="create"]')];
            if (values.length > 1) throw new Error("the exact Asset apply route is ambiguous");
            const value = values[0];
            return value instanceof HTMLElement && value.dataset.oaamProjectId === expected.projectId && value.dataset.oaamAssetId === expected.assetId ? value : false;
        }, "exact_asset_apply_route");
        const currentRoute = () => {
            const active = [...document.querySelectorAll('main[data-oaam-route]')];
            if (active.length !== 1 || !(active[0] instanceof HTMLElement) || active[0].dataset.oaamRoute !== "deployment" || active[0].dataset.oaamSubject !== "project" || active[0].dataset.oaamDeploymentMode !== "create" || active[0].dataset.oaamProjectId !== expected.projectId || active[0].dataset.oaamAssetId !== expected.assetId) throw new Error("the exact Asset apply route identity changed");
            return active[0];
        };
        await waitFor(() => {
            const route = currentRoute();
            const discovery = route.querySelector('.deployment-target-discovery');
            if (!(discovery instanceof HTMLElement)) return false;
            if (discovery.dataset.oaamState === "failed") throw new Error("tool discovery failed");
            return discovery.dataset.oaamState === undefined ? discovery : false;
        }, "tool_choices_ready");
        const providerChoices = [...currentRoute().querySelectorAll('[data-oaam-provider-id]')];
        const claudeChoices = providerChoices.filter((choice) => choice instanceof HTMLElement && choice.dataset.oaamProviderId === "CLAUDECODE");
        if (claudeChoices.length !== 1) throw new Error("Claude Code provider choice is ambiguous");
        for (const choice of providerChoices) {
            if (!(choice instanceof HTMLElement)) throw new Error("provider choice has no machine identity");
            const input = choice.querySelector('input[type="checkbox"]');
            if (!(input instanceof HTMLInputElement)) throw new Error("provider choice has no machine control");
            const selected = choice.dataset.oaamProviderId === "CLAUDECODE";
            if (selected && input.disabled) throw new Error("Claude Code provider choice is unavailable");
            if (input.checked !== selected && !input.disabled) input.click();
        }
        await waitFor(() => {
            const route = currentRoute();
            const values = [...route.querySelectorAll('[data-oaam-provider-id] input[type="checkbox"]')];
            const selected = values.filter((value) => value instanceof HTMLInputElement && value.checked);
            return selected.length === 1 && selected[0]?.closest('[data-oaam-provider-id]')?.getAttribute('data-oaam-provider-id') === "CLAUDECODE";
        }, "exact_provider_selection");
        const environments = [...currentRoute().querySelectorAll('input[name="deployment-project-environment"]')];
        const exactEnvironment = environments.filter((value) => value instanceof HTMLInputElement && value.value === expected.environmentKey);
        if (exactEnvironment.length !== 1 || !(exactEnvironment[0] instanceof HTMLInputElement) || exactEnvironment[0].disabled) throw new Error("the exact WSL environment is unavailable");
        if (!exactEnvironment[0].checked) exactEnvironment[0].click();
        await waitFor(() => {
            const values = [...currentRoute().querySelectorAll('input[name="deployment-project-environment"]')];
            const exact = values.filter((value) => value instanceof HTMLInputElement && value.value === expected.environmentKey);
            if (exact.length !== 1 || !(exact[0] instanceof HTMLInputElement)) throw new Error("the exact WSL environment identity changed");
            const selected = values.filter((value) => value instanceof HTMLInputElement && value.checked);
            if (selected.length > 1) throw new Error("the selected Project environment is ambiguous");
            return exact[0].checked && selected.length === 1 ? exact[0] : false;
        }, "exact_environment_selection");
        const probe = await waitFor(() => {
            const route = currentRoute();
            const discovery = route.querySelector('.deployment-target-discovery');
            if (!(discovery instanceof HTMLElement)) throw new Error("the Project tool search panel disappeared");
            if (discovery.dataset.oaamState === "failed" || discovery.querySelectorAll('[role="alert"]').length > 0) throw new Error("the Project tool search failed");
            if (discovery.dataset.oaamState === "loading") return false;
            const selectedProviders = [...discovery.querySelectorAll('[data-oaam-provider-id] input[type="checkbox"]')].filter((value) => value instanceof HTMLInputElement && value.checked);
            if (selectedProviders.length !== 1 || selectedProviders[0]?.closest('[data-oaam-provider-id]')?.getAttribute('data-oaam-provider-id') !== "CLAUDECODE") throw new Error("the selected Claude Code provider identity changed");
            const selectedEnvironments = [...discovery.querySelectorAll('input[name="deployment-project-environment"]')].filter((value) => value instanceof HTMLInputElement && value.checked);
            if (selectedEnvironments.length !== 1 || !(selectedEnvironments[0] instanceof HTMLInputElement) || selectedEnvironments[0].value !== expected.environmentKey) throw new Error("the selected Project environment identity changed");
            const probes = [...discovery.querySelectorAll('[data-oaam-target-action="probe"]')];
            if (probes.length > 1) throw new Error("the exact Project tool search action is ambiguous");
            const candidate = probes[0];
            if (!(candidate instanceof HTMLButtonElement)) throw new Error("the exact Project tool search action is missing");
            return candidate.disabled ? false : candidate;
        }, "project_tool_search_ready");
        probe.click();
        const row = await waitFor(() => {
            const route = currentRoute();
            const discovery = route.querySelector('.deployment-target-discovery');
            if (!(discovery instanceof HTMLElement)) throw new Error("the Project tool search panel disappeared");
            if (discovery.dataset.oaamState === "failed" || discovery.querySelectorAll('[role="alert"]').length > 0) throw new Error("the Project tool search failed");
            const panel = route.querySelector('.asset-usage-relationships');
            if (!(panel instanceof HTMLElement)) {
                const controls = [...discovery.querySelectorAll('[data-oaam-provider-id] input[type="checkbox"], input[name="deployment-project-environment"], [data-oaam-target-action="probe"]')];
                const busy = controls.some((control) =>
                    control instanceof HTMLInputElement || control instanceof HTMLButtonElement ? control.disabled : false,
                );
                if (busy) sawProbeBusy = true;
                if (!sawProbeBusy || busy) return false;
                throw new Error("the Asset relationship result is missing after the Project tool search completed");
            }
            if (panel.dataset.oaamAssetUsageState === "failed") throw new Error("the Asset relationship analysis failed");
            if (panel.dataset.oaamAssetUsageState === "none" || panel.dataset.oaamAssetUsageState === "loading") return false;
            if (panel.dataset.oaamAssetUsageState !== "ready") throw new Error("the Asset relationship state is unknown");
            const values = [...panel.querySelectorAll('.asset-usage-row[data-oaam-agent-runtime-id="${CLAUDE_RUNTIME_ID}"][data-oaam-runtime-version="${CLAUDE_RUNTIME_VERSION}"]')];
            if (values.length > 1) throw new Error("the exact Claude Code CLI target is ambiguous");
            const value = values[0];
            if (!(value instanceof HTMLElement)) throw new Error("the exact Claude Code CLI target is missing");
            if (value.dataset.oaamAssetUsageAnalysis !== "complete" || value.dataset.oaamAssetUsageCapability !== "direct" || value.dataset.oaamAssetUsageTargetState !== "absent" || value.dataset.oaamAssetUsageManaged !== "none") throw new Error("the exact Claude Code CLI target has an unexpected terminal state");
            if (!value.dataset.oaamTargetKey) throw new Error("the exact Claude target has no identity");
            const actions = [...value.querySelectorAll('[data-oaam-action="create_deployment_review_intent"]')];
            if (actions.length > 1) throw new Error("the Claude apply review action is ambiguous");
            const action = actions[0];
            if (!(action instanceof HTMLButtonElement)) throw new Error("the Claude apply review action is missing");
            if (action.disabled) {
                const workspace = route.querySelector('.catalog-deployment-workspace');
                if (workspace instanceof HTMLElement && workspace.dataset.oaamDeploymentActivity !== "idle") return false;
                throw new Error("the Claude apply review action is unavailable");
            }
            return value;
        }, "exact_claude_relationship");
        const statusLabel = (row.querySelector('.asset-usage-status')?.textContent ?? "").replace(/\\s+/gu, " ").trim();
        if (statusLabel.length === 0) throw new Error("the Claude relationship has no ordinary status");
        return { status: "complete", projectId: expected.projectId, assetId: expected.assetId, targetKey: row.dataset.oaamTargetKey, agentRuntimeId: "${CLAUDE_RUNTIME_ID}", runtimeVersion: "${CLAUDE_RUNTIME_VERSION}", capability: "direct", targetState: "absent", managedState: "none", statusLabel };
        `,
    );
}

export function projectGuidanceCreateReviewScript(subject: ProjectGuidanceApplySubject, targetKey: string): string {
    return script(
        subject,
        "create_review",
        `observe = () => {
            const active = document.querySelector('main[data-oaam-route]');
            const root = document.querySelector('.catalog-deployment-workspace');
            const summary = document.querySelector('.deployment-create-target-summary');
            return { phase, route: active instanceof HTMLElement ? active.dataset.oaamRoute ?? "" : "", exactProjectId: active instanceof HTMLElement ? active.dataset.oaamProjectId ?? "" : "", analysis: root instanceof HTMLElement ? root.dataset.oaamDeploymentAnalysis ?? "" : "", activity: root instanceof HTMLElement ? root.dataset.oaamDeploymentActivity ?? "" : "", message: root instanceof HTMLElement ? root.dataset.oaamDeploymentMessage ?? "" : "", deploymentCount: root instanceof HTMLElement ? root.dataset.oaamDeploymentCount ?? "" : "", targetKey: summary instanceof HTMLElement ? summary.dataset.oaamTargetKey ?? "" : "", deploymentId: summary instanceof HTMLElement ? summary.dataset.oaamDeploymentId ?? "" : "", authorization: document.querySelector('[data-oaam-promotion-authorization]')?.getAttribute('data-oaam-promotion-authorization') ?? "", alertCount: document.querySelectorAll('.catalog-deployment-workspace [role="alert"]').length };
        };
        const currentRoute = () => {
            const active = [...document.querySelectorAll('main[data-oaam-route]')];
            if (active.length !== 1 || !(active[0] instanceof HTMLElement) || active[0].dataset.oaamRoute !== "deployment" || active[0].dataset.oaamSubject !== "project" || active[0].dataset.oaamDeploymentMode !== "create" || active[0].dataset.oaamProjectId !== expected.projectId || active[0].dataset.oaamAssetId !== expected.assetId) throw new Error("the exact Asset apply route identity changed");
            return active[0];
        };
        const action = await waitFor(() => {
            const route = currentRoute();
            const panel = route.querySelector('.asset-usage-relationships');
            if (!(panel instanceof HTMLElement)) throw new Error("the Asset relationship result disappeared");
            if (panel.dataset.oaamAssetUsageState === "failed") throw new Error("the Asset relationship analysis failed");
            if (panel.dataset.oaamAssetUsageState === "none" || panel.dataset.oaamAssetUsageState === "loading") return false;
            if (panel.dataset.oaamAssetUsageState !== "ready") throw new Error("the Asset relationship state is unknown");
            const values = [...panel.querySelectorAll('.asset-usage-row[data-oaam-agent-runtime-id="${CLAUDE_RUNTIME_ID}"][data-oaam-runtime-version="${CLAUDE_RUNTIME_VERSION}"]')].filter((value) => value instanceof HTMLElement && value.dataset.oaamTargetKey === ${JSON.stringify(targetKey)});
            if (values.length > 1) throw new Error("the exact Claude target changed");
            const row = values[0];
            if (!(row instanceof HTMLElement)) throw new Error("the exact Claude target disappeared");
            const actions = [...row.querySelectorAll('[data-oaam-action="create_deployment_review_intent"]')];
            if (actions.length > 1) throw new Error("the Claude apply review action changed ambiguously");
            const candidate = actions[0];
            if (!(candidate instanceof HTMLButtonElement)) throw new Error("the Claude apply review action disappeared");
            if (candidate.disabled) {
                const workspace = route.querySelector('.catalog-deployment-workspace');
                if (workspace instanceof HTMLElement && workspace.dataset.oaamDeploymentActivity !== "idle") return false;
                throw new Error("the Claude apply review action changed");
            }
            return candidate;
        }, "exact_claude_relationship_revalidation");
        action.click();
        const summary = await waitFor(() => {
            const route = currentRoute();
            const workspace = route.querySelector('.catalog-deployment-workspace');
            if (!(workspace instanceof HTMLElement)) return false;
            if (workspace.dataset.oaamDeploymentAnalysis === "failed") throw new Error("the Claude apply review failed");
            if (["catalog.deployment.creation_failed", "catalog.authorization.create_failed"].includes(workspace.dataset.oaamDeploymentMessage ?? "")) throw new Error("the Claude apply review operation failed");
            const values = [...workspace.querySelectorAll('.deployment-create-target-summary[data-oaam-agent-runtime-id="${CLAUDE_RUNTIME_ID}"][data-oaam-runtime-version="${CLAUDE_RUNTIME_VERSION}"]')].filter((value) => value instanceof HTMLElement && value.dataset.oaamTargetKey === ${JSON.stringify(targetKey)});
            if (values.length > 1) throw new Error("the exact Claude review is ambiguous");
            const value = values[0];
            if (!(value instanceof HTMLElement) || !value.dataset.oaamDeploymentId) return false;
            const authorization = workspace.querySelectorAll('[data-oaam-promotion-authorization="required"]');
            if (authorization.length > 1) throw new Error("the current-Project permission is ambiguous");
            if (workspace.querySelectorAll('[data-oaam-promotion-authorization="allowed"]').length > 0) throw new Error("the current-Project permission was already granted unexpectedly");
            if (authorization.length === 0) return false;
            const allow = [...workspace.querySelectorAll('[data-oaam-deployment-action="authorize-current-version"]')];
            if (allow.length !== 1 || !(allow[0] instanceof HTMLButtonElement) || allow[0].disabled) return false;
            const warnings = workspace.querySelectorAll('[data-oaam-build-compatibility="newer-compatible"]');
            if (warnings.length !== 1 || (warnings[0].textContent ?? "").trim().length === 0) throw new Error("the compatible newer-build explanation is missing");
            return value;
        }, "current_project_permission_review");
        return { status: "complete", targetKey: ${JSON.stringify(targetKey)}, deploymentId: summary.dataset.oaamDeploymentId, agentRuntimeId: "${CLAUDE_RUNTIME_ID}", runtimeVersion: "${CLAUDE_RUNTIME_VERSION}", authorization: "required", compatibility: "newer-compatible" };
        `,
    );
}

export function projectGuidanceAuthorizeScript(
    subject: ProjectGuidanceApplySubject,
    targetKey: string,
    deploymentId: string,
): string {
    return script(
        subject,
        "authorize",
        `${semanticClosureScript()}
        observe = () => {
            const active = document.querySelector('main[data-oaam-route]');
            const root = document.querySelector('.catalog-deployment-workspace');
            const summary = document.querySelector('.deployment-create-target-summary');
            return { phase, route: active instanceof HTMLElement ? active.dataset.oaamRoute ?? "" : "", exactProjectId: active instanceof HTMLElement ? active.dataset.oaamProjectId ?? "" : "", analysis: root instanceof HTMLElement ? root.dataset.oaamDeploymentAnalysis ?? "" : "", activity: root instanceof HTMLElement ? root.dataset.oaamDeploymentActivity ?? "" : "", message: root instanceof HTMLElement ? root.dataset.oaamDeploymentMessage ?? "" : "", targetKey: summary instanceof HTMLElement ? summary.dataset.oaamTargetKey ?? "" : "", deploymentId: summary instanceof HTMLElement ? summary.dataset.oaamDeploymentId ?? "" : "", authorization: document.querySelector('[data-oaam-promotion-authorization]')?.getAttribute('data-oaam-promotion-authorization') ?? "", optionCount: document.querySelectorAll('.preview-detail[data-oaam-render-option-fingerprint]').length, alertCount: document.querySelectorAll('.catalog-deployment-workspace [role="alert"]').length };
        };
        const currentRoute = () => {
            const active = [...document.querySelectorAll('main[data-oaam-route]')];
            if (active.length !== 1 || !(active[0] instanceof HTMLElement) || active[0].dataset.oaamRoute !== "deployment" || active[0].dataset.oaamSubject !== "project" || active[0].dataset.oaamDeploymentMode !== "create" || active[0].dataset.oaamProjectId !== expected.projectId || active[0].dataset.oaamAssetId !== expected.assetId) throw new Error("the exact Asset apply route identity changed");
            return active[0];
        };
        const allow = await waitFor(() => {
            const route = currentRoute();
            const summary = route.querySelector('.deployment-create-target-summary');
            if (!(summary instanceof HTMLElement) || summary.dataset.oaamDeploymentId !== ${JSON.stringify(deploymentId)} || summary.dataset.oaamTargetKey !== ${JSON.stringify(targetKey)} || summary.dataset.oaamAgentRuntimeId !== "${CLAUDE_RUNTIME_ID}" || summary.dataset.oaamRuntimeVersion !== "${CLAUDE_RUNTIME_VERSION}") throw new Error("the exact Claude review identity changed");
            const required = route.querySelectorAll('[data-oaam-promotion-authorization="required"]');
            if (required.length !== 1) throw new Error("the current-Project permission state changed");
            const actions = [...route.querySelectorAll('[data-oaam-deployment-action="authorize-current-version"]')];
            if (actions.length !== 1 || !(actions[0] instanceof HTMLButtonElement)) throw new Error("the current-Project permission action is unavailable");
            return actions[0].disabled ? false : actions[0];
        }, "current_project_permission_action_ready");
        allow.click();
        const semanticSelections = await waitFor(() => {
            const route = currentRoute();
            const current = route.querySelector('.deployment-create-target-summary');
            if (!(current instanceof HTMLElement) || current.dataset.oaamDeploymentId !== ${JSON.stringify(deploymentId)} || current.dataset.oaamTargetKey !== ${JSON.stringify(targetKey)}) throw new Error("the Claude target changed while saving permission");
            const workspace = route.querySelector('.catalog-deployment-workspace');
            if (!(workspace instanceof HTMLElement)) return false;
            if (workspace.dataset.oaamDeploymentAnalysis === "failed") throw new Error("the current-Project permission or review analysis failed");
            if (workspace.dataset.oaamDeploymentMessage === "catalog.authorization.create_failed") throw new Error("the current-Project permission could not be saved");
            const allowed = workspace.querySelectorAll('[data-oaam-promotion-authorization="allowed"]');
            if (allowed.length > 1) throw new Error("the allowed state is ambiguous");
            if (workspace.querySelectorAll('[data-oaam-promotion-authorization="required"]').length > 0 || allowed.length === 0 || workspace.dataset.oaamDeploymentAnalysis === "loading" || workspace.dataset.oaamDeploymentActivity !== "idle") return false;
            if (workspace.dataset.oaamDeploymentAnalysis !== "ready") throw new Error("the authorized Claude review state is unknown");
            return collectSemanticSelections(workspace, false);
        }, "permission_saved_and_review_ready");
        return { status: "complete", targetKey: ${JSON.stringify(targetKey)}, deploymentId: ${JSON.stringify(deploymentId)}, authorization: "allowed", semanticSelections };
        `,
    );
}

export function projectGuidancePreviewScript(
    subject: ProjectGuidanceApplySubject,
    targetKey: string,
    deploymentId: string,
    expectedSemanticSelections: readonly ProjectGuidanceSemanticSelection[],
): string {
    return script(
        subject,
        "preview",
        `${semanticClosureScript()}
        const expectedSemanticSelections = ${JSON.stringify(expectedSemanticSelections)};
        observe = () => {
            const active = document.querySelector('main[data-oaam-route]');
            const root = document.querySelector('.catalog-deployment-workspace');
            const files = [...document.querySelectorAll('[data-oaam-preview-path]')];
            return { phase, route: active instanceof HTMLElement ? active.dataset.oaamRoute ?? "" : "", exactProjectId: active instanceof HTMLElement ? active.dataset.oaamProjectId ?? "" : "", activity: root instanceof HTMLElement ? root.dataset.oaamDeploymentActivity ?? "" : "", analysis: root instanceof HTMLElement ? root.dataset.oaamDeploymentAnalysis ?? "" : "", preview: root instanceof HTMLElement ? root.dataset.oaamDeploymentPreview ?? "" : "", targetKey: document.querySelector('.deployment-create-target-summary')?.getAttribute('data-oaam-target-key') ?? "", renderOptionCount: document.querySelectorAll('.preview-detail[data-oaam-render-option-fingerprint]').length, previewActionCount: document.querySelectorAll('[data-oaam-deployment-action="preview"]').length, previewFileCount: files.length, previewFiles: files.slice(0, 2).map((file) => ({ path: file instanceof HTMLElement ? file.dataset.oaamPreviewPath ?? "" : "", current: file instanceof HTMLElement ? file.dataset.oaamPreviewCurrentState ?? "" : "", desired: file instanceof HTMLElement ? file.dataset.oaamPreviewDesiredState ?? "" : "" })) };
        };
        const currentRoute = () => {
            const active = [...document.querySelectorAll('main[data-oaam-route]')];
            if (active.length !== 1 || !(active[0] instanceof HTMLElement) || active[0].dataset.oaamRoute !== "deployment" || active[0].dataset.oaamSubject !== "project" || active[0].dataset.oaamDeploymentMode !== "create" || active[0].dataset.oaamProjectId !== expected.projectId || active[0].dataset.oaamAssetId !== expected.assetId) throw new Error("the exact Asset apply route identity changed");
            return active[0];
        };
        const semanticSelections = await waitFor(() => {
            const route = currentRoute();
            const summary = route.querySelector('.deployment-create-target-summary');
            if (!(summary instanceof HTMLElement) || summary.dataset.oaamDeploymentId !== ${JSON.stringify(deploymentId)} || summary.dataset.oaamTargetKey !== ${JSON.stringify(targetKey)}) throw new Error("the exact Claude review identity changed");
            if (route.querySelectorAll('[data-oaam-promotion-authorization="allowed"]').length !== 1) throw new Error("the current-Project permission is not preserved");
            const workspace = route.querySelector('.catalog-deployment-workspace');
            if (!(workspace instanceof HTMLElement)) return false;
            const selections = collectSemanticSelections(workspace, true);
            if (selections === null) return false;
            if (!sameSemanticSelections(selections, expectedSemanticSelections)) throw new Error("the Guidance render choice fingerprints changed after permission");
            return selections;
        }, "exact_render_choices_selected");
        const previewAction = await waitFor(() => {
            const route = currentRoute();
            const workspace = route.querySelector('.catalog-deployment-workspace');
            if (!(workspace instanceof HTMLElement)) return false;
            if (workspace.dataset.oaamDeploymentAnalysis === "failed" || workspace.querySelectorAll('[role="alert"]').length > 0) throw new Error("the Claude review changed before preview");
            const selections = collectSemanticSelections(workspace, false, true);
            if (selections === null || !sameSemanticSelections(selections, expectedSemanticSelections)) throw new Error("the Guidance render choice fingerprints changed before preview");
            const actions = [...workspace.querySelectorAll('[data-oaam-deployment-action="preview"]')];
            if (actions.length > 1) throw new Error("the Claude preview action is ambiguous");
            const action = actions[0];
            if (!(action instanceof HTMLButtonElement)) return false;
            if (action.disabled) {
                if (workspace.dataset.oaamDeploymentActivity !== "idle") return false;
                throw new Error("the Claude preview action is unavailable");
            }
            return action;
        }, "preview_action_ready");
        previewAction.click();
        const file = await waitFor(() => {
            const route = currentRoute();
            const summary = route.querySelector('.deployment-create-target-summary');
            if (!(summary instanceof HTMLElement) || summary.dataset.oaamDeploymentId !== ${JSON.stringify(deploymentId)} || summary.dataset.oaamTargetKey !== ${JSON.stringify(targetKey)}) throw new Error("the exact Claude review identity changed while preparing preview");
            const workspace = route.querySelector('.catalog-deployment-workspace');
            if (!(workspace instanceof HTMLElement)) return false;
            if (workspace.dataset.oaamDeploymentPreview === "failed") throw new Error("the Claude file preview failed");
            if (workspace.dataset.oaamDeploymentPreview !== "ready:ready_apply") return false;
            const selections = collectSemanticSelections(workspace, false, true);
            if (selections === null || !sameSemanticSelections(selections, expectedSemanticSelections)) throw new Error("the Guidance render choice fingerprints changed while preparing preview");
            const files = [...workspace.querySelectorAll('[data-oaam-preview-path]')];
            if (files.length !== 1 || !(files[0] instanceof HTMLElement) || files[0].dataset.oaamPreviewPath !== "CLAUDE.md") throw new Error("the complete Guidance preview is not one exact CLAUDE.md");
            const value = files[0];
            const apply = [...workspace.querySelectorAll('[data-oaam-deployment-action="deploy"]')];
            if (apply.length !== 1 || !(apply[0] instanceof HTMLButtonElement) || apply[0].disabled || (apply[0].textContent ?? "").trim().length === 0) throw new Error("the Claude apply action is unavailable");
            return value;
        }, "exact_claude_file_preview");
        if (!(file instanceof HTMLElement) || file.dataset.oaamPreviewChangeKind !== "create" || file.dataset.oaamPreviewCurrentState !== "missing" || file.dataset.oaamPreviewDesiredState !== "present" || !/^[0-9a-f]{64}$/u.test(file.dataset.oaamPreviewDesiredSha256 ?? "") || !/^[1-9][0-9]*$/u.test(file.dataset.oaamPreviewDesiredByteSize ?? "")) throw new Error("the CLAUDE.md preview is not missing-to-desired");
        const apply = currentRoute().querySelector('[data-oaam-deployment-action="deploy"]');
        return { status: "complete", targetKey: ${JSON.stringify(targetKey)}, deploymentId: ${JSON.stringify(deploymentId)}, semanticSelections, relativePath: "CLAUDE.md", changeKind: "create", currentState: "missing", desiredState: "present", desiredSha256: file.dataset.oaamPreviewDesiredSha256, desiredByteSize: Number(file.dataset.oaamPreviewDesiredByteSize), reversePolicy: "can_reconcile", applyLabel: apply instanceof HTMLButtonElement ? (apply.textContent ?? "").replace(/\\s+/gu, " ").trim() : "" };
        `,
    );
}

export function projectGuidanceApplyScript(
    subject: ProjectGuidanceApplySubject,
    targetKey: string,
    deploymentId: string,
    desiredSha256: string,
    expectedSemanticSelections: readonly ProjectGuidanceSemanticSelection[],
): string {
    return script(
        subject,
        "apply",
        `${semanticClosureScript()}
        const expectedSemanticSelections = ${JSON.stringify(expectedSemanticSelections)};
        const applicationSummary = (root) => {
            const review = root.querySelector('.deployment-create-target-summary');
            if (review instanceof HTMLElement && review.closest('[hidden]') === null) return review;
            const rows = [...root.querySelectorAll('.asset-usage-row')].filter(row => row instanceof HTMLElement && row.dataset.oaamDeploymentId === ${JSON.stringify(deploymentId)} && row.dataset.oaamTargetKey === ${JSON.stringify(targetKey)} && row.dataset.oaamAgentRuntimeId === "${CLAUDE_RUNTIME_ID}");
            return rows.length === 1 ? rows[0] : undefined;
        };
        observe = () => {
            const active = document.querySelector('main[data-oaam-route]');
            const root = document.querySelector('.catalog-deployment-workspace');
            const summary = applicationSummary(document);
            return { phase, route: active instanceof HTMLElement ? active.dataset.oaamRoute ?? "" : "", exactProjectId: active instanceof HTMLElement ? active.dataset.oaamProjectId ?? "" : "", activity: root instanceof HTMLElement ? root.dataset.oaamDeploymentActivity ?? "" : "", stage: root instanceof HTMLElement ? root.dataset.oaamSelectedDeploymentStage ?? "" : "", stale: root instanceof HTMLElement ? root.dataset.oaamDeploymentStale ?? "" : "", reconciliation: root instanceof HTMLElement ? root.dataset.oaamDeploymentReconciliation ?? "" : "", message: root instanceof HTMLElement ? root.dataset.oaamDeploymentMessage ?? "" : "", deploymentId: summary instanceof HTMLElement ? summary.dataset.oaamDeploymentId ?? "" : "", application: summary?.querySelector('[data-oaam-application-state]')?.getAttribute('data-oaam-application-state') ?? "", versionState: summary?.querySelector('[data-oaam-application-version-state]')?.getAttribute('data-oaam-application-version-state') ?? "" };
        };
        const currentRoute = () => {
            const active = [...document.querySelectorAll('main[data-oaam-route]')];
            if (active.length !== 1 || !(active[0] instanceof HTMLElement) || active[0].dataset.oaamRoute !== "deployment" || active[0].dataset.oaamSubject !== "project" || active[0].dataset.oaamDeploymentMode !== "create" || active[0].dataset.oaamProjectId !== expected.projectId || active[0].dataset.oaamAssetId !== expected.assetId) throw new Error("the exact Asset apply route identity changed");
            return active[0];
        };
        const route = currentRoute();
        const summary = route.querySelector('.deployment-create-target-summary');
        if (!(summary instanceof HTMLElement) || summary.dataset.oaamDeploymentId !== ${JSON.stringify(deploymentId)} || summary.dataset.oaamTargetKey !== ${JSON.stringify(targetKey)}) throw new Error("the exact Claude review identity changed");
        const workspace = route.querySelector('.catalog-deployment-workspace');
        if (!(workspace instanceof HTMLElement)) throw new Error("the Claude apply workspace is missing");
        const semanticSelections = collectSemanticSelections(workspace, false, true);
        if (semanticSelections === null || !sameSemanticSelections(semanticSelections, expectedSemanticSelections)) throw new Error("the complete Guidance render choices changed before Apply");
        const files = [...route.querySelectorAll('[data-oaam-preview-path]')];
        if (files.length !== 1 || !(files[0] instanceof HTMLElement) || files[0].dataset.oaamPreviewPath !== "CLAUDE.md" || files[0].dataset.oaamPreviewDesiredSha256 !== ${JSON.stringify(desiredSha256)}) throw new Error("the exact CLAUDE.md preview changed");
        const apply = [...route.querySelectorAll('[data-oaam-deployment-action="deploy"]')];
        if (apply.length !== 1 || !(apply[0] instanceof HTMLButtonElement) || apply[0].disabled) throw new Error("the Claude apply action is unavailable");
        apply[0].click();
        let sawApplyProgress = false;
        let idleAfterProgressPollCount = 0;
        const applied = await waitFor(() => {
            const currentRouteValue = currentRoute();
            const current = applicationSummary(currentRouteValue);
            const workspace = currentRouteValue.querySelector('.catalog-deployment-workspace');
            if (!(workspace instanceof HTMLElement)) return false;
            const activity = workspace.dataset.oaamDeploymentActivity ?? "";
            if (activity.startsWith("deploy:")) sawApplyProgress = true;
            if (activity !== "idle") {
                idleAfterProgressPollCount = 0;
                return false;
            }
            if (workspace.dataset.oaamDeploymentMessage === "catalog.operation.failed") throw new Error("the Claude apply operation failed");
            if (workspace.dataset.oaamDeploymentStale === "true" || (workspace.dataset.oaamDeploymentReconciliation ?? "none") !== "none") throw new Error("the Claude apply result requires recovery");
            if (workspace.dataset.oaamSelectedDeploymentStage !== "in_sync") {
                if (sawApplyProgress) {
                    idleAfterProgressPollCount += 1;
                    if (idleAfterProgressPollCount >= 2) throw new Error("the Claude apply operation failed");
                } else {
                    idleAfterProgressPollCount = 0;
                }
                return false;
            }
            if (current === undefined) return false;
            if (!(current instanceof HTMLElement) || current.dataset.oaamDeploymentId !== ${JSON.stringify(deploymentId)} || current.dataset.oaamTargetKey !== ${JSON.stringify(targetKey)} || current.dataset.oaamAgentRuntimeId !== "${CLAUDE_RUNTIME_ID}" || current.dataset.oaamRuntimeVersion !== "${CLAUDE_RUNTIME_VERSION}") throw new Error("the Claude target changed while applying files");
            const statuses = [...current.querySelectorAll('[data-oaam-application-state]')];
            const versions = [...current.querySelectorAll('[data-oaam-application-version-state]')];
            if (statuses.length > 1 || versions.length > 1) throw new Error("the applied Claude state is ambiguous");
            const status = statuses[0];
            const version = versions[0];
            if (!(status instanceof HTMLElement)) return false;
            if (status.dataset.oaamApplicationState === "pending" && version === undefined) return false;
            if (status.dataset.oaamApplicationState !== "applied" || !(version instanceof HTMLElement) || version.dataset.oaamApplicationVersionState !== "current") throw new Error("the applied Claude state is incomplete");
            return { status, version };
        }, "claude_files_applied");
        return { status: "complete", targetKey: ${JSON.stringify(targetKey)}, deploymentId: ${JSON.stringify(deploymentId)}, semanticSelections, applicationState: "applied", versionState: "current", statusLabel: (applied.status.textContent ?? "").replace(/\\s+/gu, " ").trim(), detail: (applied.version.textContent ?? "").replace(/\\s+/gu, " ").trim() };
        `,
    );
}
