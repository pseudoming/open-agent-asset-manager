import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";
import { operationRendererArguments } from "./desktop-actual-render-operation-layout.mjs";

export async function inspectProjectAssetOperationsCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspectProjectAssetOperations(
            entryValue,
            assertOrdinarySurfaceLanguage,
            ordinarySurfaceLanguageLexicon,
            formatOperationMessage,
            assertOperationLayout,
        ) {
            const waitFor = async (predicate, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(`timed out waiting for ${label}`);
            };
            const assert = (condition, message) => {
                if (!condition) throw new Error(`${entryValue.id}: ${message}`);
            };
            const click = (element, label) => {
                assert(element instanceof HTMLButtonElement, `${label} is not a button`);
                assert(!element.disabled, `${label} is disabled`);
                assert(element.isConnected, `${label} is detached`);
                element.click();
            };
            const clickWhenReady = async (query, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const element = query();
                    if (element instanceof HTMLButtonElement && element.isConnected && !element.disabled) {
                        element.click();
                        return element;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(`timed out waiting to click ${label}`);
            };
            const replaceInput = (input, value) => {
                assert(input instanceof HTMLInputElement, "input control is missing");
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                if (setter === undefined) throw new Error("HTML input value setter is unavailable");
                setter.call(input, value);
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
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
            const observedJourneyStates = [];
            const observedDialogs = [];

            let library = await waitFor(() => document.querySelector(".project-library-shell"), "Project library");
            assert(library instanceof HTMLElement, "Project library has the wrong element type");
            assert(
                library.querySelector("details.retained-projects") === null,
                "stopped Projects still dominate the active Project workspace",
            );
            const settingsButton = library.querySelector(".library-settings-button");
            click(settingsButton, "Settings navigation");
            const settingsShell = await waitFor(
                () => document.querySelector(".settings-workbench-shell[data-settings-category='general']"),
                "General Settings",
            );
            assert(settingsShell instanceof HTMLElement, "Settings has the wrong element type");
            const returnButton = settingsShell.querySelector(".settings-return-button");
            const settingsSearchLabel = settingsShell.querySelector(".settings-search > span");
            const settingsSearchInput = settingsShell.querySelector(".settings-search input");
            assert(returnButton instanceof HTMLButtonElement, "Settings return action is missing");
            assert(settingsSearchLabel instanceof HTMLElement, "Settings search label is missing");
            assert(settingsSearchInput instanceof HTMLInputElement, "Settings search input is missing");
            const returnBounds = returnButton.getBoundingClientRect();
            const settingsSearchBounds = settingsSearchInput.getBoundingClientRect();
            const searchLabelBounds = settingsSearchLabel.getBoundingClientRect();
            assert(
                Math.abs(returnBounds.width - settingsSearchBounds.width) <= 1,
                "Settings return action does not own its full navigation row",
            );
            assert(
                searchLabelBounds.width <= 2 && searchLabelBounds.height <= 2,
                "Settings repeats a visible search heading above the search input",
            );
            const retainedDisclosure = await waitFor(
                () => settingsShell.querySelector(".retained-project-settings details.retained-projects"),
                "stopped Projects in Project management Settings",
            );
            assert(retainedDisclosure instanceof HTMLDetailsElement, "stopped-Project disclosure has the wrong element type");
            assert(!retainedDisclosure.open, "stopped Projects should not dominate Settings before the user expands them");
            retainedDisclosure.querySelector("summary")?.click();
            await waitFor(() => settingsShell.querySelector(".retained-projects li"), "retained Project row");
            observedJourneyStates.push("project_management:retained");
            assertOrdinaryLanguage(settingsShell, "Project management Settings");
            assertLayout(settingsShell, "Project management Settings");

            const retainedRestore = settingsShell.querySelector(".retained-projects li button");
            click(retainedRestore, "retained Project restore");
            const restoreDialog = await waitFor(
                () => document.querySelector("[data-oaam-dialog='project_lifecycle']"),
                "retained Project review",
            );
            assert(restoreDialog instanceof HTMLElement, "retained Project dialog has the wrong element type");
            click(restoreDialog.querySelector(".project-lifecycle-action button"), "retained Project restore review");
            await waitFor(() => restoreDialog.querySelector(".project-lifecycle-review"), "retained Project review body");
            assert(
                ordinaryText(restoreDialog).includes(message("project_lifecycle.restore.unavailable")) &&
                    ordinaryText(restoreDialog).includes("C:\\Unavailable\\retained-workspace"),
                "retained Project review does not preserve the unavailable root fact",
            );
            assert(
                document.documentElement.dataset.oaamProjectInspectionCount === "1",
                "retained Project review did not call the fixture operation",
            );
            assertOrdinaryLanguage(restoreDialog, "retained Project review");
            assertLayout(restoreDialog, "retained Project review");
            observedJourneyStates.push("project_management:review", "project_management:unavailable_root");
            observedDialogs.push("project_lifecycle");
            restoreDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await waitFor(
                () => document.querySelector("[data-oaam-dialog='project_lifecycle']") === null,
                "closed retained Project review",
            );
            click(returnButton, "return from Settings");
            library = await waitFor(
                () => document.querySelector(".project-library-shell[data-oaam-state='ready']"),
                "returned Project library",
            );
            assertOrdinaryLanguage(library, "Project and Asset library");
            assertLayout(library, "Project and Asset library");

            const manageProject = document.querySelector("[data-oaam-action='manage-project']");
            click(manageProject, "Project management");
            const manageDialog = await waitFor(
                () => document.querySelector("[data-oaam-dialog='project_lifecycle']"),
                "Project management dialog",
            );
            assert(manageDialog instanceof HTMLElement, "Project management dialog has the wrong element type");
            const renameInput = manageDialog.querySelector(".project-lifecycle-action input[type='text']");
            replaceInput(renameInput, "Renamed Project");
            const renameAction = renameInput?.closest(".project-lifecycle-action")?.querySelector("button");
            await waitFor(
                () => (renameAction instanceof HTMLButtonElement && !renameAction.disabled ? renameAction : undefined),
                "enabled Project rename review",
            );
            click(renameAction, "Project rename review");
            await waitFor(
                () =>
                    document.documentElement.dataset.oaamProjectInspectionCount === "2"
                        ? document.documentElement.dataset.oaamLastProjectInspectionAction
                        : undefined,
                "second Project inspection",
            );
            assert(
                document.documentElement.dataset.oaamLastProjectInspectionAction === "rename",
                `Project inspection used ${String(document.documentElement.dataset.oaamLastProjectInspectionAction)}`,
            );
            const projectState = await waitFor(
                () => manageDialog.querySelector("[role='alert'], .project-lifecycle-review"),
                "terminal Project inspection presentation",
            );
            assert(
                projectState instanceof HTMLElement && projectState.getAttribute("role") === "alert",
                `Project inspection rendered a non-failure state: ${JSON.stringify(ordinaryText(manageDialog))}`,
            );
            const projectFailure = projectState;
            assert(projectFailure instanceof HTMLElement, "Project failure has the wrong element type");
            assert(
                !ordinaryText(manageDialog).includes("fixture raw Project inspection failure"),
                "Project failure leaks raw fixture diagnostics into ordinary copy",
            );
            assert(
                document.documentElement.dataset.oaamProjectInspectionCount === "2",
                "Project failure did not call the second fixture operation",
            );
            assertOrdinaryLanguage(manageDialog, "Project failure");
            assertLayout(manageDialog, "Project failure");
            observedJourneyStates.push("project_management:failed");
            manageDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await waitFor(
                () => document.querySelector("[data-oaam-dialog='project_lifecycle']") === null,
                "closed Project failure",
            );

            const projectCollectionNavigation = await waitFor(
                () => document.querySelector("button.asset-tree-project[aria-current='page']"),
                "Project Asset collection navigation",
            );
            click(projectCollectionNavigation, "Project Asset collection navigation");
            await waitFor(
                () => document.querySelector(".asset-collection[data-oaam-collection-id='project']"),
                "Project Asset collection",
            );
            const queryGuidanceGroup = () => {
                const collection = document.querySelector(".asset-collection[data-oaam-collection-id='project']");
                if (!(collection instanceof HTMLElement)) return undefined;
                return [...collection.querySelectorAll(".asset-kind-group")].find(
                    (group) => group.querySelector("h4")?.textContent?.trim() === message("library.kind.guidance"),
                );
            };
            await waitFor(() => queryGuidanceGroup(), "Project Guidance group");
            await waitFor(
                () => (queryGuidanceGroup()?.querySelectorAll(".asset-library-item").length === 1 ? true : undefined),
                "bounded Project Asset page",
            );
            observedJourneyStates.push("asset_library_lifecycle:bounded_page");
            const assetItem = await clickWhenReady(
                () =>
                    [...(queryGuidanceGroup()?.querySelectorAll(".asset-library-row-actions button") ?? [])].find(
                        (button) => button.getAttribute("aria-label") === message("library.metadata.open"),
                    ),
                "Project Asset metadata shortcut",
            );

            let inspector;
            try {
                inspector = await waitFor(() => document.querySelector(".asset-inspector"), "Asset inspector", 30_000);
            } catch (error) {
                const shell = document.querySelector(".project-library-shell");
                throw new Error(
                    `${error instanceof Error ? error.message : String(error)}; ` +
                        `route=${shell?.getAttribute("data-oaam-route") ?? "missing"}; ` +
                        `subject=${shell?.getAttribute("data-oaam-subject") ?? "missing"}; ` +
                        `inspectorOpen=${shell?.getAttribute("data-inspector-open") ?? "missing"}; ` +
                        `selected=${assetItem.closest(".asset-library-item")?.getAttribute("data-selected") ?? "missing"}; ` +
                        `connected=${String(assetItem.isConnected)}; ` +
                        `disabled=${String(assetItem.disabled)}`,
                );
            }
            assert(inspector instanceof HTMLElement, "Asset inspector has the wrong element type");
            await waitFor(() => inspector.querySelector(".asset-inspector-scroll"), "ready Asset inspector");
            const orientedMetadataForm = await waitFor(
                () => inspector.querySelector(".asset-action-form[data-oaam-action-attention='true']"),
                "oriented Asset metadata editor",
            );
            const orientedScroll = inspector.querySelector(".asset-inspector-scroll");
            const orientedFormBounds = orientedMetadataForm.getBoundingClientRect();
            const orientedScrollBounds = orientedScroll?.getBoundingClientRect();
            assert(
                orientedScroll instanceof HTMLElement &&
                    orientedFormBounds.top >= orientedScrollBounds.top - 1 &&
                    orientedFormBounds.bottom <= orientedScrollBounds.bottom + 1 &&
                    getComputedStyle(orientedMetadataForm).animationName === "asset-action-attention",
                "metadata shortcut did not scroll and highlight the exact action form",
            );
            const initialMetadataClose = [...orientedMetadataForm.querySelectorAll("button")].find((button) =>
                button.classList.contains("library-secondary-button"),
            );
            click(initialMetadataClose, "close shortcut-opened Asset metadata editor");
            await waitFor(
                () => (inspector.querySelector(".asset-action-form") === null ? true : undefined),
                "closed shortcut-opened Asset metadata editor",
            );
            const inspectorModes = inspector.querySelector(".asset-inspector-modes");
            assert(inspectorModes instanceof HTMLElement, "Asset inspector view choices are missing");
            const metadataMode = inspectorModes.querySelector(
                '[data-oaam-interaction-entry="features.project-library.asset_inspector.001"]',
            );
            const previewMode = inspectorModes.querySelector(
                '[data-oaam-interaction-entry="features.project-library.asset_inspector.002"]',
            );
            assert(
                metadataMode instanceof HTMLButtonElement &&
                    metadataMode.getAttribute("aria-pressed") === "true" &&
                    previewMode instanceof HTMLButtonElement &&
                    previewMode.getAttribute("aria-pressed") === "false",
                "Asset inspector does not open in the Metadata view",
            );
            click(previewMode, "Asset file preview view");
            const filePreview = await waitFor(
                () =>
                    inspector.querySelector(".asset-file-preview .import-preview-source")?.textContent?.includes("Keep facts.")
                        ? inspector.querySelector(".asset-file-preview")
                        : undefined,
                "first-class Asset file preview",
            );
            assert(filePreview instanceof HTMLElement, "Asset file preview has the wrong element type");
            assert(
                filePreview.querySelectorAll(".import-preview-line-number").length === 3,
                "Asset file preview does not expose exact source line numbers",
            );
            assert(
                inspector.querySelector(".asset-inspector-preview-pane > .asset-file-preview") === filePreview &&
                    inspector.querySelector(".asset-inspector-scroll") === null,
                "Asset file preview remains crammed into the Metadata scroll view",
            );
            const previewPane = inspector.querySelector(".asset-inspector-preview-pane");
            const previewDocument = filePreview.querySelector(".asset-file-preview-document");
            const previewHeader = filePreview.querySelector(".asset-file-preview-header");
            const previewIdentity = previewHeader?.querySelector(".asset-file-preview-identity");
            const previewActions = previewHeader?.querySelector(".asset-file-preview-actions");
            const previewPaneRect = previewPane?.getBoundingClientRect();
            const previewDocumentRect = previewDocument?.getBoundingClientRect();
            const previewHeaderRect = previewHeader?.getBoundingClientRect();
            const previewIdentityRect = previewIdentity?.getBoundingClientRect();
            const previewActionsRect = previewActions?.getBoundingClientRect();
            assert(
                previewPane instanceof HTMLElement &&
                    previewDocument instanceof HTMLElement &&
                    previewHeader instanceof HTMLElement &&
                    previewIdentity instanceof HTMLElement &&
                    previewActions instanceof HTMLElement &&
                    Math.abs(previewDocumentRect.bottom - previewPaneRect.bottom) <= 2 &&
                    previewIdentity.textContent.includes(message("library.assets.revision", { revision: 2 })) &&
                    previewIdentityRect.right <= previewActionsRect.left &&
                    previewActionsRect.top >= previewHeaderRect.top &&
                    previewActionsRect.bottom <= previewHeaderRect.bottom &&
                    Math.abs(
                        previewIdentityRect.top +
                            previewIdentityRect.height / 2 -
                            (previewActionsRect.top + previewActionsRect.height / 2),
                    ) <= 2,
                "Asset file preview does not fill its owned pane or keeps its actions on a second row",
            );
            const previewButtons = [...filePreview.querySelectorAll(".import-preview-view-button")];
            const markdownToggle = previewButtons.at(0);
            const wrapToggle = previewButtons.at(1);
            assert(markdownToggle instanceof HTMLButtonElement, "Asset Markdown preview choice is missing");
            assert(wrapToggle instanceof HTMLButtonElement, "Asset soft-wrap choice is missing");
            const markdownToggleRect = markdownToggle.getBoundingClientRect();
            const wrapToggleRect = wrapToggle.getBoundingClientRect();
            assert(
                Math.abs(
                    markdownToggleRect.top + markdownToggleRect.height / 2 - (wrapToggleRect.top + wrapToggleRect.height / 2),
                ) <= 2 &&
                    markdownToggleRect.right <= wrapToggleRect.left &&
                    [markdownToggleRect, wrapToggleRect].every(
                        (rect) => rect.left >= previewHeaderRect.left && rect.right <= previewHeaderRect.right,
                    ),
                "Asset preview action buttons wrap or escape the header",
            );
            assert(
                markdownToggle.querySelector("[data-oaam-icon='render']") instanceof SVGElement &&
                    wrapToggle.querySelector("[data-oaam-icon='wrap']") instanceof SVGElement,
                "Asset file preview does not use the shared semantic render and wrap icons",
            );
            click(wrapToggle, "Asset soft wrap");
            await waitFor(
                () => filePreview.querySelector(".import-preview-source[data-soft-wrap='true']"),
                "soft-wrapped Asset source",
            );
            click(markdownToggle, "Asset Markdown preview");
            await waitFor(
                () => filePreview.querySelector(".import-preview-markdown[data-oaam-markdown-rendered]"),
                "rendered Asset Markdown preview",
            );
            click(markdownToggle, "Asset Markdown source");
            await waitFor(
                () => filePreview.querySelector(".import-preview-source[data-soft-wrap='true']"),
                "soft-wrapped Asset source after switching views",
            );
            const resizeSeparator = document.querySelector(".library-workbench > .workbench-resize-separator");
            assert(resizeSeparator instanceof HTMLHRElement, "Asset inspector resize separator is missing");
            const inspectorWidthBefore = inspector.getBoundingClientRect().width;
            const maximumInspectorWidth = Number(resizeSeparator.getAttribute("aria-valuemax"));
            if (getComputedStyle(resizeSeparator).display === "none") {
                assert(
                    innerWidth <= 1024 && inspectorWidthBefore <= innerWidth * 0.9 + 1,
                    "minimum viewport does not use the bounded overlay Asset inspector",
                );
            } else {
                assert(maximumInspectorWidth > 448, "Asset inspector retains the old narrow maximum width");
                resizeSeparator.focus();
                resizeSeparator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const inspectorWidthAfter = inspector.getBoundingClientRect().width;
                assert(
                    inspectorWidthAfter > Math.max(448, inspectorWidthBefore + 40),
                    `Asset inspector did not widen (before=${String(inspectorWidthBefore)}, after=${String(inspectorWidthAfter)}, ` +
                        `value=${String(resizeSeparator.getAttribute("aria-valuenow"))}, ` +
                        `max=${String(maximumInspectorWidth)}, innerWidth=${String(innerWidth)}, ` +
                        `documentWidth=${String(document.documentElement.clientWidth)})`,
                );
            }
            click(metadataMode, "Asset metadata view");
            await waitFor(() => inspector.querySelector(".asset-inspector-scroll"), "restored Asset metadata");
            assert(inspector.querySelector(".asset-file-preview") === null, "Asset preview remains mixed into Metadata");
            assert(inspector.querySelectorAll(".inspector-file-list li").length === 1, "Asset file page is not bounded");
            assert(inspector.querySelectorAll(".inspector-select-field").length >= 2, "Asset Version choices are missing");
            assert(
                ordinaryText(inspector).includes(message("library.assets.revision", { revision: 2 })),
                "Asset Version sequence still uses an internal revision label",
            );
            const compactTechnical = inspector.querySelector("details[data-oaam-technical-detail='true']");
            const compactTechnicalSummary = compactTechnical?.querySelector("summary");
            assert(
                compactTechnical instanceof HTMLDetailsElement &&
                    compactTechnicalSummary instanceof HTMLElement &&
                    compactTechnicalSummary.querySelector("[data-oaam-icon='info']") instanceof SVGElement &&
                    compactTechnicalSummary.getBoundingClientRect().width <= 40,
                "technical evidence still occupies a full ordinary row",
            );
            assertOrdinaryLanguage(inspector, "Asset inspector");
            observedJourneyStates.push("asset_library_lifecycle:inspector");

            const findAction = (label) =>
                [...inspector.querySelectorAll(".asset-action-section button")].find(
                    (button) => button.textContent?.trim() === label,
                );
            click(findAction(message("library.metadata.open")), "open Asset metadata editor");
            await waitFor(() => inspector.querySelector(".asset-action-form"), "Asset metadata editor");
            click(findAction(message("library.metadata.close")), "close unchanged Asset metadata editor");
            await waitFor(
                () => (inspector.querySelector(".asset-action-form") === null ? true : undefined),
                "closed unchanged Asset metadata editor",
            );
            click(findAction(message("library.metadata.open")), "reopen Asset metadata editor");
            const metadataForm = await waitFor(
                () => inspector.querySelector(".asset-action-form"),
                "reopened Asset metadata editor",
            );
            replaceInput(metadataForm.querySelector("label input"), "Unsaved Project guidance");
            click(findAction(message("library.metadata.close")), "review dirty Asset metadata editor");
            const metadataReview = await waitFor(
                () => inspector.querySelector(".asset-metadata-close-review[role='alert']"),
                "dirty Asset metadata review",
            );
            assert(
                metadataForm.querySelector("label input").getBoundingClientRect().bottom <=
                    metadataReview.getBoundingClientRect().top,
                "dirty review must follow the values being reviewed",
            );
            click(
                [...metadataReview.querySelectorAll("button")].find(
                    (button) => button.textContent?.trim() === message("library.metadata.discard_changes"),
                ),
                "discard dirty Asset metadata",
            );
            await waitFor(
                () => (inspector.querySelector(".asset-action-form") === null ? true : undefined),
                "discarded Asset metadata editor",
            );
            observedJourneyStates.push("asset_library_lifecycle:metadata_toggle");

            const compareButton = [...inspector.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === message("library.compare.action"),
            );
            click(compareButton, "Asset Version comparison");
            const comparison = await waitFor(() => inspector.querySelector(".asset-diff-result"), "Asset comparison result");
            assert(comparison instanceof HTMLElement, "Asset comparison result has the wrong element type");
            assert(
                document.documentElement.dataset.oaamAssetComparisonCount === "1",
                "Asset comparison did not call the fixture operation",
            );
            assertOrdinaryLanguage(comparison, "Asset comparison");
            const diffLine = comparison.querySelector(".asset-diff-line");
            assert(diffLine instanceof HTMLTableRowElement, "unified text diff line is missing");
            assert(diffLine.cells[0].getBoundingClientRect().width <= 40, "diff marker is separated from its line content");
            assertLayout(inspector, "Asset inspector comparison");
            observedJourneyStates.push("asset_library_lifecycle:comparison");

            click(inspector.querySelector("[data-oaam-journey-action='asset.delete_open']"), "Asset delete review");
            const deleteConfirmation = await waitFor(
                () => inspector.querySelector(".workbench-confirmation input[type='checkbox']"),
                "Asset delete confirmation",
            );
            assert(deleteConfirmation instanceof HTMLInputElement, "Asset delete confirmation has the wrong element type");
            const deleteForm = deleteConfirmation.closest(".asset-delete-form");
            const deleteLabel = deleteConfirmation.closest("label");
            const deleteCopy = deleteLabel?.querySelector("span");
            assert(
                deleteForm instanceof HTMLElement &&
                    deleteLabel instanceof HTMLLabelElement &&
                    deleteCopy instanceof HTMLElement &&
                    getComputedStyle(deleteLabel).display === "flex" &&
                    deleteConfirmation.getBoundingClientRect().width <= 32 &&
                    deleteCopy.getBoundingClientRect().left - deleteConfirmation.getBoundingClientRect().right <= 12 &&
                    deleteConfirmation.getBoundingClientRect().right <= deleteCopy.getBoundingClientRect().left,
                "Asset delete confirmation is not aligned as one ordinary horizontal control",
            );
            assertOrdinaryLanguage(deleteForm, "Asset delete review");
            assertLayout(deleteForm, "Asset delete review");
            deleteConfirmation.click();
            const deleteCommit = inspector.querySelector("[data-oaam-journey-action='asset.delete_commit']");
            await waitFor(
                () => (deleteCommit instanceof HTMLButtonElement && !deleteCommit.disabled ? deleteCommit : undefined),
                "enabled Asset delete",
            );
            click(deleteCommit, "Asset delete");
            await waitFor(
                () =>
                    document.documentElement.dataset.oaamAssetDeleteCount === "1" &&
                    inspector.querySelector("[data-oaam-journey-action='asset.purge_review']"),
                "deleted Asset presentation",
            );
            assert(ordinaryText(inspector).includes(message("library.assets.deleted")), "deleted Asset state is not visible");
            observedJourneyStates.push("asset_library_lifecycle:deleted");

            click(inspector.querySelector("[data-oaam-journey-action='asset.purge_review']"), "Asset purge review");
            const purgeForm = await waitFor(
                () =>
                    document.documentElement.dataset.oaamAssetPurgeInspectionCount === "1"
                        ? inspector.querySelector(".asset-action-form")
                        : undefined,
                "Asset purge inventory",
            );
            assert(purgeForm instanceof HTMLElement, "Asset purge form has the wrong element type");
            assert(
                ordinaryText(purgeForm).includes(
                    message("library.purge.inventory", {
                        versions: message("library.purge.versions.many", { count: 2 }),
                        grants: message("library.purge.grants.one", { count: 1 }),
                    }),
                ),
                "Asset purge review omits its exact inventory",
            );
            assertOrdinaryLanguage(purgeForm, "Asset purge review");
            assertLayout(inspector, "Asset purge review");
            observedJourneyStates.push("asset_library_lifecycle:purge_review");

            replaceInput(purgeForm.querySelector("label input"), "Project guidance");
            const purgeWithoutBackup = [...purgeForm.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === message("library.purge.without_backup"),
            );
            await waitFor(
                () =>
                    purgeWithoutBackup instanceof HTMLButtonElement && !purgeWithoutBackup.disabled
                        ? purgeWithoutBackup
                        : undefined,
                "enabled no-backup purge",
            );
            click(purgeWithoutBackup, "no-backup Asset purge");
            const assetFailure = await waitFor(
                () =>
                    document.documentElement.dataset.oaamAssetPurgeCommitCount === "1"
                        ? inspector.querySelector(".asset-action-section [role='alert']")
                        : undefined,
                "localized Asset purge failure",
            );
            assert(assetFailure instanceof HTMLElement, "Asset purge failure has the wrong element type");
            const refreshPurgeReview = inspector.querySelector("[data-oaam-visible-state-action='refresh_asset_purge_review']");
            assert(
                refreshPurgeReview instanceof HTMLButtonElement && !refreshPurgeReview.disabled,
                "failed purge has no explicit fresh-review action",
            );
            assert(purgeForm.querySelector("label input")?.value === "", "failed purge retained destructive typed consent");
            assert(purgeWithoutBackup.disabled, "failed purge can reuse the consumed preparation");
            assert(
                !ordinaryText(inspector).includes("fixture raw Asset purge failure"),
                "Asset failure leaks raw fixture diagnostics into ordinary copy",
            );
            assertOrdinaryLanguage(inspector, "Asset failure");
            assertLayout(inspector, "Asset failure");
            observedJourneyStates.push("asset_library_lifecycle:failed");

            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: observedDialogs,
                journeyStates: observedJourneyStates,
                routeStates: ["library:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()}, ${operationRendererArguments()})`,
        true,
    );
}
