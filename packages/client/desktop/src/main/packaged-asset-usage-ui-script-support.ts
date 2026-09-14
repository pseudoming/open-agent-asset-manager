/** Renderer-side script kept private to the packaged already-usable Asset proof. */

export const RUN_PROJECT_ASSET_USAGE_CHECK_SCRIPT = `(async (expected) => {
    const startedAt = Date.now();
    const deadline = startedAt + 120000;
    let pollCount = 0;
    let lastObservation;
    const compactText = (value) => (value ?? "").replace(/\\s+/gu, " ").trim();
    const readDeployment = () => {
        const values = [...document.querySelectorAll(
            'main[data-oaam-route="deployment"][data-oaam-subject="project"][data-oaam-deployment-mode="create"]',
        )];
        if (values.length !== 1 || !(values[0] instanceof HTMLElement)) {
            throw new Error("the AGENTS tool-usage page is not uniquely present while checking");
        }
        const value = values[0];
        if (value.dataset.oaamProjectId !== expected.projectId || value.dataset.oaamAssetId !== expected.assetId) {
            throw new Error("the AGENTS tool-usage page changed identity while checking");
        }
        return value;
    };
    const snapshotRow = (row) => ({
        agentRuntimeLabel: compactText(row.querySelector('.asset-usage-row-title > strong')?.textContent),
        analysis: row.dataset.oaamAssetUsageAnalysis ?? "missing",
        capability: row.dataset.oaamAssetUsageCapability ?? "missing",
        observedTargetState: row.dataset.oaamAssetUsageTargetState ?? "missing",
        managedState: row.dataset.oaamAssetUsageManaged ?? "missing",
        ordinaryStatusText: compactText(row.querySelector('.asset-usage-status')?.textContent),
        ordinaryDetailText: compactText(row.querySelector('.asset-usage-row-copy > p')?.textContent),
        targetText: compactText(row.querySelector('.asset-usage-row-copy > small')?.textContent),
        hasWriteReviewAction: row.querySelector('[data-oaam-action="create_deployment_review_intent"]') !== null,
    });
    const observe = () => {
        const deployments = [...document.querySelectorAll('main[data-oaam-route="deployment"]')];
        const deployment = deployments.length === 1 && deployments[0] instanceof HTMLElement ? deployments[0] : undefined;
        const workspaces = deployment === undefined ? [] : [...deployment.querySelectorAll('.catalog-deployment-workspace')];
        const workspace = workspaces.length === 1 && workspaces[0] instanceof HTMLElement ? workspaces[0] : undefined;
        const targets = workspace === undefined ? [] : [...workspace.querySelectorAll('.deployment-target-discovery')];
        const panels = workspace === undefined ? [] : [...workspace.querySelectorAll(
            '.asset-usage-relationships[data-oaam-deployment-step="relationships"]',
        )];
        const panel = panels.length === 1 && panels[0] instanceof HTMLElement ? panels[0] : undefined;
        const rows = panel === undefined ? [] : [...panel.querySelectorAll('.asset-usage-row')]
            .filter((row) => row instanceof HTMLElement);
        const exactRuntimeRows = rows.filter((row) =>
            snapshotRow(row).agentRuntimeLabel === expected.agentRuntimeLabel,
        );
        return {
            deploymentRootCount: deployments.length,
            deployment: deployment === undefined ? null : {
                route: deployment.dataset.oaamRoute ?? "missing",
                subject: deployment.dataset.oaamSubject ?? "missing",
                state: deployment.dataset.oaamState ?? "missing",
                mode: deployment.dataset.oaamDeploymentMode ?? "missing",
                projectId: deployment.dataset.oaamProjectId ?? "missing",
                assetId: deployment.dataset.oaamAssetId ?? "missing",
            },
            workspace: workspace === undefined ? null : {
                state: workspace.dataset.oaamDeploymentWorkspaceState ?? "missing",
                deploymentCount: workspace.dataset.oaamDeploymentCount ?? "missing",
                activity: workspace.dataset.oaamDeploymentActivity ?? "missing",
                analysis: workspace.dataset.oaamDeploymentAnalysis ?? "missing",
                diagnosticCount: workspace.dataset.oaamDeploymentDiagnosticCount ?? "missing",
                message: workspace.dataset.oaamDeploymentMessage ?? "missing",
            },
            targetDiscoveryCount: targets.length,
            selectedProviderLabels: workspace === undefined ? [] :
                [...workspace.querySelectorAll('.deployment-target-providers label')]
                    .filter((label) => label.querySelector('input[type="checkbox"]')?.checked === true)
                    .map((label) => compactText(label.textContent)),
            selectedEnvironmentValues: workspace === undefined ? [] :
                [...workspace.querySelectorAll('input[name="deployment-project-environment"]')]
                    .filter((input) => input instanceof HTMLInputElement && input.checked)
                    .map((input) => input instanceof HTMLInputElement ? input.value : ""),
            relationshipPanelCount: panels.length,
            usageState: panel?.dataset.oaamAssetUsageState ?? "missing",
            alerts: deployment === undefined ? [] : [...deployment.querySelectorAll('[role="alert"]')]
                .map((entry) => compactText(entry.textContent)).filter(Boolean),
            exactRuntimeRowCount: exactRuntimeRows.length,
            exactRuntimeRow: exactRuntimeRows.length === 1 ? snapshotRow(exactRuntimeRows[0]) : null,
        };
    };
    const terminal = (terminalKind, message) => ({
        schemaVersion: 1,
        status: "terminal",
        stage: "project_asset_usage_relationship",
        terminalKind,
        message,
        elapsedMilliseconds: Date.now() - startedAt,
        pollCount,
        lastObservation: lastObservation ?? observe(),
    });
    let workspace;
    let rows;
    let exact;
    try {
        const deployment = readDeployment();
        const probe = deployment.querySelector('[data-oaam-target-action="probe"]');
        if (!(probe instanceof HTMLButtonElement) || probe.disabled) {
            throw new Error("the exact Project tool check changed before dispatch");
        }
        probe.click();
        while (Date.now() < deadline) {
            pollCount += 1;
            lastObservation = observe();
            const currentDeployment = readDeployment();
            if (lastObservation.workspace === null || lastObservation.workspace.state !== "ready") {
                throw new Error("the AGENTS tool-usage workspace disappeared");
            }
            if (lastObservation.alerts.length > 0) {
                return terminal("terminal_state", "the Project tool check reached an attributed error");
            }
            if (lastObservation.relationshipPanelCount > 1) {
                throw new Error("the Project tool check exposed multiple Asset-usage relationship panels");
            }
            if (lastObservation.relationshipPanelCount === 0 ||
                lastObservation.usageState === "none" || lastObservation.usageState === "loading") {
                await new Promise((resolve) => setTimeout(resolve, 50));
                continue;
            }
            if (lastObservation.usageState === "failed") {
                return terminal("terminal_state", "the Project Asset-usage analysis failed");
            }
            if (lastObservation.usageState !== "ready") {
                return terminal("terminal_state", "the Project Asset-usage analysis has an unknown terminal state");
            }
            if (lastObservation.exactRuntimeRowCount !== 1 || lastObservation.exactRuntimeRow === null) {
                return terminal("terminal_state", "the Project Asset-usage analysis did not retain one exact " +
                    expected.agentRuntimeLabel + " row");
            }
            if (lastObservation.exactRuntimeRow.analysis !== "complete") {
                return terminal("terminal_state", "the exact " + expected.agentRuntimeLabel +
                    " Asset-usage row did not reach a complete result");
            }
            workspace = currentDeployment.querySelector('.catalog-deployment-workspace');
            const panel = workspace?.querySelector('.asset-usage-relationships[data-oaam-deployment-step="relationships"]');
            rows = panel === null || panel === undefined ? [] : [...panel.querySelectorAll('.asset-usage-row')]
                .filter((row) => row instanceof HTMLElement);
            exact = rows.find((row) => snapshotRow(row).agentRuntimeLabel === expected.agentRuntimeLabel);
            break;
        }
        if (!(workspace instanceof HTMLElement) || !Array.isArray(rows) || !(exact instanceof HTMLElement)) {
            pollCount += 1;
            lastObservation = observe();
            return terminal("deadline_exceeded",
                "timed out waiting for the complete exact Project AGENTS tool-usage relationship");
        }
        if (exact.dataset.oaamAssetUsageCapability !== "direct" ||
            exact.dataset.oaamAssetUsageTargetState !== "already_usable" ||
            exact.dataset.oaamAssetUsageManaged !== "none") {
            throw new Error("the Project AGENTS target did not resolve to one direct already-usable unmanaged relation");
        }
        const title = compactText(exact.querySelector('.asset-usage-row-title > strong')?.textContent);
        const status = compactText(exact.querySelector('.asset-usage-status')?.textContent);
        const detail = compactText(exact.querySelector('.asset-usage-row-copy > p')?.textContent);
        if (title !== expected.agentRuntimeLabel || status.length === 0 || detail.length === 0 ||
            !/(already|已经|bereits|すでに)/iu.test(status + " " + detail) ||
            !/(no (?:file )?changes?|无需修改|keine Änderung|変更.*不要)/iu.test(detail)) {
            throw new Error("the already-usable relation has no ordinary no-change explanation");
        }
        const createDeploymentReviewActionCount = exact.querySelectorAll(
            '[data-oaam-action="create_deployment_review_intent"]',
        ).length;
        if (createDeploymentReviewActionCount !== 0 || workspace.dataset.oaamDeploymentCount !== "0") {
            throw new Error("the already-usable relation exposed or created a write review");
        }
        return {
            status: "complete",
            projectId: expected.projectId,
            assetId: expected.assetId,
            agentRuntimeLabel: title,
            capability: "direct",
            observedTargetState: "already_usable",
            managedState: "none",
            ordinaryStatusText: status,
            ordinaryDetailText: detail,
            deploymentCountAfter: 0,
            createDeploymentReviewActionCount,
            observedRows: rows.map((row) => ({
                capability: row.dataset.oaamAssetUsageCapability ?? "",
                observedTargetState: row.dataset.oaamAssetUsageTargetState ?? "",
                managedState: row.dataset.oaamAssetUsageManaged ?? "",
                hasWriteReviewAction: row.querySelector(
                    '[data-oaam-action="create_deployment_review_intent"]',
                ) !== null,
            })),
        };
    } catch (error) {
        lastObservation ??= observe();
        return terminal("terminal_state", error instanceof Error ? error.message : "unknown Asset-usage proof error");
    }
})`;
