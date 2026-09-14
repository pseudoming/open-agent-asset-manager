import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";
import { operationRendererArguments } from "./desktop-actual-render-operation-layout.mjs";
import { inspectPreviewFileInspector } from "./desktop-actual-render-file-inspector.mjs";

export async function inspectDeploymentOperationsCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspectDeploymentOperations(
            entryValue,
            assertOrdinarySurfaceLanguage,
            ordinarySurfaceLanguageLexicon,
            formatOperationMessage,
            assertOperationLayout,
            inspectFileInspector,
        ) {
            const waitFor = async (predicate, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(
                    `timed out waiting for ${label}; route=${JSON.stringify(
                        document.querySelector(".deployment-page")?.getAttribute("data-oaam-state"),
                    )}; deployment tail=${JSON.stringify(
                        (document.querySelector(".deployment-page")?.textContent ?? "").slice(-1_200),
                    )}`,
                );
            };
            const assert = (condition, message) => {
                if (!condition) throw new Error(`${entryValue.id}: ${message}`);
            };
            const ordinaryText = (root) => {
                const copy = root.cloneNode(true);
                for (const hidden of copy.querySelectorAll("[hidden], [data-oaam-technical-detail]")) hidden.remove();
                return copy.textContent ?? "";
            };
            const assertOrdinaryLanguage = (root, label) =>
                assertOrdinarySurfaceLanguage(root, label, entryValue.id, ordinarySurfaceLanguageLexicon);
            const operationMessageTemplates = JSON.parse(document.documentElement.dataset.oaamOperationMessageTemplates ?? "{}");
            const message = (messageId, values) => formatOperationMessage(operationMessageTemplates, messageId, values);
            const assertLayout = (root, label) => assertOperationLayout(root, label, entryValue.id);
            const click = (element, label) => {
                assert(element instanceof HTMLButtonElement, `${label} is not a button`);
                assert(!element.disabled, `${label} is disabled`);
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };
            const buttonNamed = (root, label) =>
                [...root.querySelectorAll("button")].find(
                    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
                );
            const radioContaining = (root, label) =>
                [...root.querySelectorAll(".workbench-radio-button")].find((radio) => radio.textContent?.includes(label));
            const nativeRenderOption = (root) => root.querySelector(`[data-oaam-render-option-fingerprint='${"b".repeat(64)}']`);
            const chooseRadio = (element, label) => {
                assert(element instanceof HTMLLabelElement, `${label} is not a radio label`);
                const input = element.querySelector("input[type='radio']");
                assert(input instanceof HTMLInputElement, `${label} has no radio input`);
                assert(!input.disabled, `${label} is disabled`);
                input.click();
            };
            const chooseRenderOption = (element, label) => {
                assert(element instanceof HTMLElement, `${label} is not a render option`);
                if (
                    element.matches('[data-oaam-render-option-auto-selected="true"]') ||
                    element.querySelector('[data-oaam-render-option-auto-selected="true"]') !== null
                ) {
                    assert(element.querySelector("input[type='radio']") === null, `${label} retains a singleton radio`);
                    return;
                }
                const input = element.querySelector("input[type='radio']");
                assert(input instanceof HTMLInputElement, `${label} has no radio input or implicit selection`);
                assert(!input.disabled, `${label} is disabled`);
                input.click();
            };
            const observedJourneyStates = [];
            const assertOutcome = async (kind, label, versionId = "33333333-3333-4333-8333-333333333333") => {
                const outcome = await waitFor(
                    () => workspace.querySelector(`[data-oaam-deployment-result='${kind}']`),
                    `${label} outcome summary`,
                );
                assert(outcome instanceof HTMLElement, `${label} outcome summary has the wrong element type`);
                assert(
                    outcome.dataset.oaamResultDeploymentId === "44444444-4444-4444-8444-444444444444",
                    `${label} outcome summary lost the exact Deployment identity`,
                );
                assert(
                    outcome.dataset.oaamResultRuntimeIds === '["CLAUDE_CODE_CLI"]',
                    `${label} outcome summary lost the exact runtime identity`,
                );
                assert(
                    outcome.dataset.oaamResultVersionIds === JSON.stringify([versionId]),
                    `${label} outcome summary lost the exact Asset Version identity`,
                );
                assert(
                    outcome.dataset.oaamResultFilePaths === '[".claude/commands/oaam-release.md"]',
                    `${label} outcome summary lost the reviewed runtime file`,
                );
                const visibleOutcome = ordinaryText(outcome);
                if (kind === "reverse_committed") {
                    assert(
                        visibleOutcome.includes(message("catalog.ui.outcome.revision", { revision: 3 })),
                        `${label} lost the refreshed revision`,
                    );
                } else if (versionId !== "33333333-3333-4333-8333-333333333333") {
                    assert(
                        visibleOutcome.includes(message("catalog.ui.outcome.new_version")),
                        `${label} invented a cached revision`,
                    );
                }
                assert(visibleOutcome.includes("Release workflow"), `${label} outcome summary omitted the Asset identity`);
                assert(
                    visibleOutcome.includes("Claude Code CLI") || visibleOutcome.includes("CLAUDE_CODE_CLI"),
                    `${label} outcome summary omitted the runtime identity`,
                );
                assert(
                    visibleOutcome.includes(".claude/commands/oaam-release.md"),
                    `${label} outcome summary omitted the reviewed runtime file`,
                );
                assertLayout(outcome, `${label} outcome summary`);
            };

            await waitFor(
                () => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"),
                "ready Project library",
            );
            click(
                await waitFor(() => document.querySelector(".asset-library-item-button"), "Project Asset inspect action"),
                "Project Asset primary action",
            );
            const createAction = await waitFor(
                () => document.querySelector(".asset-inspector [data-oaam-action='open-deployments']"),
                "selected Asset add-to-tool action",
            );
            click(createAction, "selected Asset add-to-tool action");

            const targetLoading = await waitFor(
                () => document.querySelector(".deployment-target-discovery[data-oaam-state='loading']"),
                "Deployment target loading",
            );
            assert(targetLoading instanceof HTMLElement, "Deployment target loading has the wrong element type");
            observedJourneyStates.push("deployment_and_reverse:target_loading");
            document.dispatchEvent(new Event("oaam-fixture-release-deployment-target-load"));

            const targetFailed = await waitFor(
                () => document.querySelector(".deployment-target-discovery[data-oaam-state='failed']"),
                "Deployment target failure",
            );
            assert(targetFailed instanceof HTMLElement, "Deployment target failure has the wrong element type");
            assert(
                !ordinaryText(targetFailed).includes("fixture raw target-loading failure"),
                "target failure leaks raw diagnostics into ordinary copy",
            );
            assert(
                targetFailed.textContent?.includes("fixture raw target-loading failure") === true,
                "target failure discarded attributed technical evidence",
            );
            assertOrdinaryLanguage(targetFailed, "Deployment target failure");
            assertLayout(targetFailed, "Deployment target failure");
            observedJourneyStates.push("deployment_and_reverse:target_failed");
            click(buttonNamed(targetFailed, message("common.retry")), "Deployment target retry");

            const createSurface = await waitFor(
                () => document.querySelector("[data-oaam-route='deployment'][data-oaam-state='ready']"),
                "ready selected-Asset create journey",
            );
            assert(
                createSurface instanceof HTMLElement && createSurface.dataset.oaamDeploymentMode === "create",
                "target retry did not recover the selected-Asset create journey",
            );
            click(buttonNamed(createSurface, message("catalog.ui.workspace.back")), "return from create journey");
            const library = await waitFor(
                () => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"),
                "Project library after create review",
            );
            const manageAction = await waitFor(
                () => library.querySelector(".library-toolbar-actions [data-oaam-action='open-deployments']"),
                "manage existing tool locations action",
            );
            click(manageAction, "manage existing tool locations action");

            const surface = await waitFor(
                () => document.querySelector("[data-oaam-route='deployment'][data-oaam-state='ready']"),
                "ready Deployment route",
            );
            assert(
                surface instanceof HTMLElement && surface.dataset.oaamDeploymentMode === "manage",
                "existing tool location did not open the management journey",
            );
            let workspace = await waitFor(() => surface.querySelector(".catalog-deployment-workspace"), "Deployment workspace");
            assert(workspace instanceof HTMLElement, "Deployment workspace has the wrong element type");
            await waitFor(() => radioContaining(workspace, message("catalog.ui.status.first_deployment")), "initial Deployment");
            assertOrdinaryLanguage(surface, "ready Deployment route");
            assertLayout(surface, "ready Deployment route");
            observedJourneyStates.push("deployment_and_reverse:ready");
            chooseRadio(radioContaining(workspace, message("catalog.ui.status.first_deployment")), "initial Deployment");
            const selectedDeploymentEntry = workspace.querySelector("[data-oaam-deployment-entry]");
            const selectedDeploymentMetadata = selectedDeploymentEntry?.querySelector(".deployment-list-metadata");
            assert(
                selectedDeploymentMetadata instanceof HTMLElement &&
                    selectedDeploymentMetadata.querySelector(".deployment-list-freshness") instanceof HTMLElement,
                "Deployment identity and freshness do not share one responsive metadata row",
            );

            click(buttonNamed(workspace, message("catalog.ui.action.analyze")), "first render analysis");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running render analysis");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.analyze")),
                "render-analysis progress",
            );
            assertLayout(workspace, "render-analysis progress");
            observedJourneyStates.push("deployment_and_reverse:analyzing");
            document.dispatchEvent(new Event("oaam-fixture-release-deployment-analysis"));

            const blocked = await waitFor(
                () =>
                    [...workspace.querySelectorAll("[role='alert']")].find((item) =>
                        ordinaryText(item).includes(message("catalog.ui.render.blocked")),
                    ),
                "blocked render",
            );
            assert(blocked instanceof HTMLElement, "blocked render has the wrong element type");
            assert(
                !ordinaryText(blocked).includes("fixture raw blocked-render diagnostic"),
                "blocked render leaks raw diagnostics into ordinary copy",
            );
            assert(
                blocked.textContent?.includes("fixture raw blocked-render diagnostic") === true,
                "blocked render discarded attributed technical evidence",
            );
            assert(
                ordinaryText(blocked).includes(message("catalog.ui.render.claude.title.blocked")) &&
                    ordinaryText(blocked).includes(message("catalog.ui.render.claude.blocked.workflow")),
                "blocked Claude Workflow did not disclose the ordinary preservation boundary",
            );
            observedJourneyStates.push("deployment_and_reverse:blocked");
            assertLayout(workspace, "blocked render analysis");

            const refreshAnalysis = async (label) => {
                assert(
                    buttonNamed(workspace, message("catalog.ui.action.analyze")) === undefined,
                    "current analysis retains a redundant review action",
                );
                const previousWorkspace = workspace;
                click(buttonNamed(workspace, message("catalog.ui.outcome.reload_saved")), `${label} refresh`);
                await waitFor(() => !previousWorkspace.isConnected, `${label} previous review removal`);
                workspace = await waitFor(
                    () => document.querySelector(".catalog-deployment-workspace"),
                    `${label} refreshed review`,
                );
                chooseRadio(
                    await waitFor(
                        () => radioContaining(workspace, message("catalog.ui.status.first_deployment")),
                        `${label} exact Deployment`,
                    ),
                    `${label} exact Deployment`,
                );
            };
            await refreshAnalysis("second analysis");
            click(buttonNamed(workspace, message("catalog.ui.action.analyze")), "second render analysis");
            await waitFor(() => nativeRenderOption(workspace), "second render analysis result");
            await refreshAnalysis("uncertain analysis");
            click(buttonNamed(workspace, message("catalog.ui.action.analyze")), "uncertain render analysis");
            await waitFor(
                () => workspace.querySelector("[data-oaam-operation-state='analysis_outcome_unavailable']"),
                "uncertain render-analysis outcome",
            );
            observedJourneyStates.push("deployment_and_reverse:analysis_outcome_unavailable");
            assertLayout(workspace, "uncertain render-analysis outcome");
            click(buttonNamed(workspace, message("catalog.ui.action.analyze")), "render analysis retry");
            const nativeOption = await waitFor(() => nativeRenderOption(workspace), "native render option");
            const preservedDisposition = await waitFor(
                () => workspace.querySelector("[data-oaam-render-disposition='preserved']"),
                "preserved Claude Workflow disclosure",
            );
            assert(
                nativeOption.dataset.oaamSemanticRefFingerprint === "a".repeat(64) &&
                    nativeOption.dataset.oaamSubjectVersionId === "33333333-3333-4333-8333-333333333333" &&
                    nativeOption.dataset.oaamRenderOutcome === "preserved" &&
                    nativeOption.dataset.oaamReversePolicy === "can_reconcile",
                "native render option lost its exact semantic, Version or preservation policy",
            );
            assert(
                ordinaryText(preservedDisposition).includes(message("catalog.ui.render.claude.title.preserved")) &&
                    ordinaryText(preservedDisposition).includes(message("catalog.ui.render.claude.preserved.workflow")) &&
                    ordinaryText(preservedDisposition).includes(message("catalog.ui.render.claude.no_silent_degradation")),
                "preserved Claude Workflow did not disclose retained settings and the no-silent-degradation boundary",
            );
            chooseRenderOption(nativeOption, "native render option");
            click(buttonNamed(workspace, message("catalog.ui.action.preview")), "uncertain target preview");
            await waitFor(
                () => workspace.querySelector("[data-oaam-operation-state='preview_outcome_unavailable']"),
                "uncertain target-preview outcome",
            );
            observedJourneyStates.push("deployment_and_reverse:preview_outcome_unavailable");
            assertLayout(workspace, "uncertain target-preview outcome");
            click(buttonNamed(workspace, message("catalog.ui.action.preview")), "target preview retry");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running target preview");
            await waitFor(() => ordinaryText(workspace).includes(message("catalog.activity.preview")), "target-preview progress");
            assertLayout(workspace, "target-preview progress");
            observedJourneyStates.push("deployment_and_reverse:previewing");
            document.dispatchEvent(new Event("oaam-fixture-release-deployment-preview"));
            await waitFor(() => ordinaryText(workspace).includes(message("catalog.ui.preview.title")), "target preview");
            assert(
                document.documentElement.dataset.oaamDeploymentPreviewCount === "2",
                "target preview did not invoke the uncertain operation and exact retry",
            );
            observedJourneyStates.push("deployment_and_reverse:preview");
            assertLayout(workspace, "exact target preview");
            await inspectFileInspector({
                workspace,
                graph: workspace.querySelector('[data-oaam-preview-graph="complete"]'),
                assert,
                click,
                waitFor,
            });

            click(buttonNamed(workspace, message("catalog.ui.action.apply")), "Deployment apply");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running Deployment apply");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.deploy")),
                "Deployment apply progress",
            );
            observedJourneyStates.push("deployment_and_reverse:deploying");
            document.dispatchEvent(new Event("oaam-fixture-release-deployment-deploy"));
            await waitFor(() => radioContaining(workspace, message("catalog.ui.status.up_to_date")), "deployed result");
            assert(
                document.documentElement.dataset.oaamDeploymentDeployCount === "1",
                "Deployment apply did not invoke the fixture operation",
            );
            observedJourneyStates.push("deployment_and_reverse:deployed");
            await assertOutcome("deploy", "deployed");

            click(buttonNamed(workspace, message("catalog.ui.action.scan")), "conflict scan");
            await waitFor(() => radioContaining(workspace, message("catalog.ui.status.external_changes")), "conflict Deployment");
            observedJourneyStates.push("deployment_and_reverse:conflict");

            click(buttonNamed(workspace, message("catalog.ui.action.scan")), "repair scan");
            await waitFor(
                () => radioContaining(workspace, message("catalog.ui.status.repair_available")),
                "repairable Deployment",
            );
            click(buttonNamed(workspace, message("catalog.ui.action.inspect")), "uncertain repair inspection");
            await waitFor(
                () => workspace.querySelector("[data-oaam-operation-state='inspection_outcome_unavailable']"),
                "uncertain target-inspection outcome",
            );
            observedJourneyStates.push("deployment_and_reverse:inspection_outcome_unavailable");
            assertLayout(workspace, "uncertain target-inspection outcome");
            click(buttonNamed(workspace, message("catalog.ui.action.inspect")), "repair inspection retry");
            const inspectionSummary = `${message("catalog.ui.inspection.change_count.one", { count: 1 })} · ${message(
                "catalog.ui.inspection.conflict_count.one",
                { count: 1 },
            )}`;
            await waitFor(() => ordinaryText(workspace).includes(inspectionSummary), "repair inspection result");
            assert(
                document.documentElement.dataset.oaamDeploymentInspectionCount === "2",
                "inspection did not invoke the uncertain operation and exact retry",
            );
            observedJourneyStates.push("deployment_and_reverse:inspection");
            assertLayout(workspace, "repair inspection result");

            const inspectionNavigation = workspace.querySelector(".inspection-detail-navigation");
            const inspectionDecisions = workspace.querySelector(".inspection-decision-group");
            const repairAction = buttonNamed(workspace, message("catalog.ui.action.repair"));
            assert(
                inspectionNavigation instanceof HTMLElement &&
                    inspectionNavigation.querySelector(".inspection-detail-actions button") instanceof HTMLButtonElement,
                "inspection change navigation has no distinct detail group",
            );
            assert(
                inspectionDecisions instanceof HTMLElement &&
                    repairAction instanceof HTMLButtonElement &&
                    inspectionDecisions.contains(repairAction) &&
                    !inspectionNavigation.contains(repairAction),
                "inspection repair is not attached to the distinct decision group",
            );
            click(repairAction, "Deployment repair");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running Deployment repair");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.repair")),
                "Deployment repair progress",
            );
            observedJourneyStates.push("deployment_and_reverse:repairing");
            document.dispatchEvent(new Event("oaam-fixture-release-deployment-repair"));
            await waitFor(() => radioContaining(workspace, message("catalog.ui.status.up_to_date")), "repaired Deployment");
            assert(
                document.documentElement.dataset.oaamDeploymentRepairCount === "1",
                "repair did not invoke the fixture operation",
            );
            observedJourneyStates.push("deployment_and_reverse:repaired");
            await assertOutcome("repair", "repaired");

            click(buttonNamed(workspace, message("catalog.ui.action.scan")), "recovery scan");
            await waitFor(
                () => radioContaining(workspace, message("catalog.ui.status.paused_for_safety")),
                "recovery-required Deployment",
            );
            observedJourneyStates.push("deployment_and_reverse:recovery_required");
            click(buttonNamed(workspace, message("catalog.ui.action.recover")), "Deployment recovery");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running Deployment recovery");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.recover")),
                "Deployment recovery progress",
            );
            observedJourneyStates.push("deployment_and_reverse:recovering");
            document.dispatchEvent(new Event("oaam-fixture-release-deployment-recover"));
            await waitFor(() => radioContaining(workspace, message("catalog.ui.status.up_to_date")), "recovered Deployment");
            assert(
                document.documentElement.dataset.oaamDeploymentRecoverCount === "1",
                "recovery did not invoke the fixture operation",
            );
            observedJourneyStates.push("deployment_and_reverse:recovered");
            await assertOutcome("recover", "recovered");

            click(buttonNamed(workspace, message("catalog.ui.action.scan")), "failing Deployment scan");
            const operationFailure = await waitFor(
                () =>
                    [...workspace.querySelectorAll("[role='alert']")].find((item) =>
                        ordinaryText(item).includes(
                            message("catalog.operation.failed", {
                                operation: message("catalog.activity.scan"),
                            }),
                        ),
                    ),
                "failed Deployment operation",
            );
            assert(operationFailure instanceof HTMLElement, "failed Deployment operation has the wrong element type");
            assert(
                !ordinaryText(workspace).includes("fixture raw Deployment scan failure"),
                "Deployment failure leaks raw diagnostics into ordinary copy",
            );
            assert(
                workspace.textContent?.includes("fixture raw Deployment scan failure") === true,
                "Deployment failure discarded attributed technical evidence",
            );
            assertOrdinaryLanguage(surface, "Deployment operation states");
            assertLayout(surface, "failed Deployment operation");
            assert(
                document.documentElement.dataset.oaamDeploymentScanCount === "4",
                "Deployment scan sequence did not invoke four exact operations",
            );
            observedJourneyStates.push("deployment_and_reverse:failed");

            const refreshConflictInspection = async (label) => {
                const previousWorkspace = workspace;
                click(buttonNamed(workspace, message("catalog.ui.outcome.reload_saved")), `${label} refresh`);
                await waitFor(() => !previousWorkspace.isConnected, `${label} previous Deployment workspace removal`);
                workspace = await waitFor(
                    () => document.querySelector(".catalog-deployment-workspace"),
                    `${label} refreshed Deployment workspace`,
                );
                await waitFor(() => workspace.getAttribute("aria-busy") !== "true", `${label} refreshed Deployment catalog`);
                const conflictDeployment = await waitFor(
                    () => radioContaining(workspace, message("catalog.ui.status.external_changes")),
                    `${label} conflict Deployment`,
                );
                chooseRadio(conflictDeployment, `${label} conflict Deployment`);
                click(buttonNamed(workspace, message("catalog.ui.action.inspect")), `${label} inspection`);
                await waitFor(() => ordinaryText(workspace).includes(inspectionSummary), `${label} inspection result`);
            };
            const prepareReviewedChanges = async (label) => {
                click(buttonNamed(workspace, message("catalog.ui.action.reverse_prepare")), `${label} prepare`);
                await waitFor(
                    () => ordinaryText(workspace).includes(message("catalog.ui.reverse.title")),
                    `${label} prepared review`,
                );
                assertLayout(workspace, `${label} prepared review`);
            };
            const selectPreparedChange = async (label) => {
                await assertSingletonReverse(label);
                const confirmation = [...workspace.querySelectorAll(".workbench-confirmation")].find((item) =>
                    item.textContent?.includes(message("catalog.ui.reverse.confirm_promotion")),
                );
                assert(confirmation instanceof HTMLLabelElement, `${label} promotion confirmation is missing`);
                const input = confirmation.querySelector("input[type='checkbox']");
                assert(input instanceof HTMLInputElement, `${label} promotion confirmation has no checkbox`);
                assert(!input.disabled, `${label} promotion confirmation is disabled`);
                assert(!input.checked, `${label} promotion confirmation was selected implicitly`);
                input.click();
                await waitFor(
                    () => !buttonNamed(workspace, message("catalog.ui.action.reverse_commit")).disabled,
                    `${label} enabled reverse commit`,
                );
            };
            const assertSingletonReverse = async (label) => {
                const prepared = await waitFor(
                    () => workspace.querySelector("[data-oaam-reverse-review='prepared']"),
                    `${label} prepared singleton review`,
                );
                const automatic = prepared.querySelectorAll("[data-oaam-reverse-option-auto-selected]");
                assert(automatic.length === 1, `${label} must show its one available strategy without a radio`);
                assert(
                    automatic[0].textContent === message("catalog.ui.render.strategy.native_file"),
                    `${label} does not retain the native-file strategy`,
                );
                assert(prepared.querySelector("input[type='radio']") === null, `${label} retains a singleton radio`);
                assert(
                    prepared.querySelectorAll("[data-oaam-render-output-summary] li").length === 1,
                    `${label} does not show its physical output exactly once`,
                );
            };
            const prepareCommitCycle = async (label) => {
                await refreshConflictInspection(label);
                await prepareReviewedChanges(label);
                await selectPreparedChange(label);
            };

            click(buttonNamed(workspace, message("catalog.ui.action.scan")), "reverse conflict scan");
            await waitFor(
                () => radioContaining(workspace, message("catalog.ui.status.external_changes")),
                "reverse conflict Deployment",
            );
            chooseRadio(radioContaining(workspace, message("catalog.ui.status.external_changes")), "reverse conflict Deployment");
            click(buttonNamed(workspace, message("catalog.ui.action.inspect")), "reverse inspection");
            await waitFor(() => ordinaryText(workspace).includes(inspectionSummary), "reverse inspection result");

            click(buttonNamed(workspace, message("catalog.ui.action.reverse_prepare")), "first reverse preparation");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running reverse preparation");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.reverse_prepare")),
                "reverse preparation progress",
            );
            assertLayout(workspace, "reverse preparation progress");
            observedJourneyStates.push("deployment_and_reverse:reverse_preparing");
            document.dispatchEvent(new Event("oaam-fixture-release-reverse-prepare"));
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.reverse.not_prepared")),
                "not-prepared reverse result",
            );
            assert(
                !ordinaryText(workspace).includes("fixture raw reverse preparation warning"),
                "not-prepared reverse result leaks raw diagnostics into ordinary copy",
            );
            assert(
                workspace.textContent?.includes("fixture raw reverse preparation warning") === true,
                "not-prepared reverse result discarded attributed technical evidence",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_not_prepared");
            assertLayout(workspace, "not-prepared reverse result");

            click(buttonNamed(workspace, message("catalog.ui.action.reverse_prepare")), "rejected reverse preparation");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.reverse.prepare_failed")),
                "failed reverse preparation",
            );
            assert(
                !ordinaryText(workspace).includes("fixture raw reverse preparation failure"),
                "failed reverse preparation leaks raw diagnostics into ordinary copy",
            );
            assert(
                workspace.textContent?.includes("fixture raw reverse preparation failure") === true,
                "failed reverse preparation discarded attributed technical evidence",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_prepare_failed");

            await refreshConflictInspection("reverse cancellation");
            await prepareReviewedChanges("reverse cancellation");
            observedJourneyStates.push("deployment_and_reverse:reverse_prepared");
            await assertSingletonReverse("reverse cancellation");
            const unconfirmedCommit = buttonNamed(workspace, message("catalog.ui.action.reverse_commit"));
            assert(unconfirmedCommit instanceof HTMLButtonElement, "unconfirmed reverse commit action is missing");
            assert(unconfirmedCommit.disabled, "reverse commit does not require explicit promotion confirmation");
            observedJourneyStates.push("deployment_and_reverse:reverse_confirmation_required");

            click(buttonNamed(workspace, message("catalog.ui.action.reverse_cancel")), "first reverse cancellation");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running reverse cancellation");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.reverse_cancel")),
                "reverse cancellation progress",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_cancelling");
            document.dispatchEvent(new Event("oaam-fixture-release-reverse-cancel"));
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.reverse.cancel_failed")),
                "failed reverse cancellation",
            );
            assert(
                !ordinaryText(workspace).includes("fixture raw reverse cancellation failure"),
                "failed reverse cancellation leaks raw diagnostics into ordinary copy",
            );
            assert(
                workspace.textContent?.includes("fixture raw reverse cancellation failure") === true,
                "failed reverse cancellation discarded attributed technical evidence",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_cancel_failed");
            assertLayout(workspace, "failed reverse cancellation");
            click(buttonNamed(workspace, message("catalog.ui.action.reverse_cancel")), "second reverse cancellation");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.reverse.cancelled")),
                "completed reverse cancellation",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_cancelled");

            await prepareCommitCycle("committed reverse");
            click(buttonNamed(workspace, message("catalog.ui.action.reverse_commit")), "committed reverse action");
            await waitFor(() => workspace.getAttribute("aria-busy") === "true", "running reverse commit");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.reverse_commit")),
                "reverse commit progress",
            );
            assertLayout(workspace, "reverse commit progress");
            observedJourneyStates.push("deployment_and_reverse:reverse_committing");
            document.dispatchEvent(new Event("oaam-fixture-release-reverse-commit"));
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.activity.reverse_refresh")),
                "refreshing saved reverse state",
            );
            assert(workspace.getAttribute("aria-busy") === "true", "reverse refresh released the busy boundary early");
            assert(
                workspace.querySelector("[data-oaam-deployment-result='reverse_committed']") !== null,
                "reverse refresh lost the committed outcome",
            );
            assertLayout(workspace, "refreshing saved reverse state");
            document.dispatchEvent(new Event("oaam-fixture-release-reverse-refresh"));
            await waitFor(() => workspace.getAttribute("aria-busy") !== "true", "completed reverse display refresh");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.reverse.result.committed")),
                "committed reverse result",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_committed");
            await assertOutcome("reverse_committed", "committed reverse", "70000000-0000-4000-8000-000000000001");
            assert(
                buttonNamed(workspace, message("catalog.ui.action.recover")) === undefined,
                "completed acceptance still requires Recover",
            );
            assert(document.documentElement.dataset.oaamDeploymentRecoverCount === "1", "acceptance invoked generic recovery");
            assert(
                radioContaining(workspace, message("catalog.ui.status.up_to_date")) !== undefined,
                "completed acceptance did not refresh the relationship",
            );
            // A later external edit starts the independent non-committed scenarios.
            click(buttonNamed(workspace, message("catalog.ui.action.scan")), "later external change scan");
            await waitFor(
                () => radioContaining(workspace, message("catalog.ui.status.external_changes")),
                "later external change",
            );

            const commitTerminal = async (label, expectedText, stateName) => {
                await prepareCommitCycle(label);
                click(buttonNamed(workspace, message("catalog.ui.action.reverse_commit")), `${label} action`);
                await waitFor(() => ordinaryText(workspace).includes(expectedText), `${label} result`);
                observedJourneyStates.push(`deployment_and_reverse:${stateName}`);
                assertLayout(workspace, `${label} result`);
            };
            await commitTerminal(
                "published-not-selected reverse",
                message("catalog.reverse.result.published_not_selected"),
                "reverse_published_not_selected",
            );
            await assertOutcome(
                "reverse_not_committed",
                "published-not-selected reverse",
                "70000000-0000-4000-8000-000000000002",
            );
            await commitTerminal(
                "not-published reverse",
                message("catalog.reverse.result.not_published"),
                "reverse_not_published",
            );
            await commitTerminal(
                "recovery-required reverse",
                message("catalog.reverse.result.recovery_required"),
                "reverse_recovery_required",
            );
            await commitTerminal(
                "outcome-unavailable reverse",
                message("catalog.reverse.result.outcome_unavailable"),
                "reverse_outcome_unavailable",
            );
            await prepareCommitCycle("failed reverse");
            click(buttonNamed(workspace, message("catalog.ui.action.reverse_commit")), "failed reverse action");
            await waitFor(
                () => ordinaryText(workspace).includes(message("catalog.reverse.commit_failed")),
                "failed reverse commit",
            );
            assert(
                !ordinaryText(workspace).includes("fixture raw reverse commit failure"),
                "failed reverse commit leaks raw diagnostics into ordinary copy",
            );
            assert(
                workspace.textContent?.includes("fixture raw reverse commit failure") === true,
                "failed reverse commit discarded attributed technical evidence",
            );
            observedJourneyStates.push("deployment_and_reverse:reverse_commit_failed");
            assertOrdinaryLanguage(surface, "reverse operation states");
            assertLayout(surface, "failed reverse commit");
            assert(
                document.documentElement.dataset.oaamReversePrepareCount === "9",
                "reverse preparation sequence did not invoke nine exact operations",
            );
            assert(
                document.documentElement.dataset.oaamReverseCancelCount === "2",
                "reverse cancellation sequence did not invoke two exact operations",
            );
            assert(
                document.documentElement.dataset.oaamReverseCommitCount === "6",
                "reverse commit sequence did not invoke six exact operations",
            );

            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: observedJourneyStates,
                routeStates: ["library:ready", "deployment:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()}, ${operationRendererArguments()}, ${inspectPreviewFileInspector.toString()})`,
        true,
    );
}
