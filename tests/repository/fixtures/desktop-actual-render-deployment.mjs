import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";

export async function observeDeploymentTargetLayout(surface) {
    const owner = surface.querySelector(".deployment-page");
    const context = surface.querySelector(".deployment-target-context");
    const inspector = surface.querySelector(".catalog-asset-version-inspector");
    const probe = surface.querySelector('[data-oaam-target-action="authorize_local_check"], [data-oaam-target-action="probe"]');
    const box = (element) => element.getBoundingClientRect().toJSON();
    const lineCount = (range) =>
        new Set(
            [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => Math.round(rect.top)),
        ).size;
    const splitWords = [];
    const walker = document.createTreeWalker(context, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        for (const match of node.textContent.matchAll(/\p{Script=Latin}{2,}/gu)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            if (lineCount(range) > 1) splitWords.push(match[0]);
        }
    }
    const wrappedSelectionActions = [...context.querySelectorAll(".deployment-target-selection-actions button")]
        .filter((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            return lineCount(range) > 1;
        })
        .map((button) => button.textContent);
    const main = {
        ...box(owner),
        clientWidth: owner.clientWidth,
        scrollWidth: owner.scrollWidth,
        clientHeight: owner.clientHeight,
        scrollHeight: owner.scrollHeight,
    };
    const groups = [...context.querySelectorAll(':scope > [role="group"]')].map((group) => ({
        className: group.className,
        ...box(group),
    }));
    let primaryActionReachability = null;
    if (inspector === null || getComputedStyle(inspector).position !== "absolute") {
        const previous = { top: owner.scrollTop, left: owner.scrollLeft };
        probe.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = box(probe),
            ownerBounds = box(owner);
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        primaryActionReachability = {
            bounds,
            scrolledTo: owner.scrollTop,
            visible:
                bounds.top >= Math.max(0, ownerBounds.top) - 1 &&
                bounds.bottom <= Math.min(innerHeight, ownerBounds.bottom) + 1 &&
                bounds.left >= ownerBounds.left - 1 &&
                bounds.right <= ownerBounds.right + 1,
            hit: hit !== null && probe.contains(hit),
        };
        owner.scrollTo({ ...previous, behavior: "instant" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return { main, groups, splitWords, wrappedSelectionActions, primaryActionReachability };
}

export async function inspectDeploymentCase(webContents, entry) {
    const result = await webContents.executeJavaScript(
        `(${async function inspectDeployment(
            entryValue,
            assertOrdinarySurfaceLanguage,
            ordinarySurfaceLanguageLexicon,
            observeTargetLayout,
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
            const click = (element) => {
                assert(element instanceof HTMLButtonElement, "Deployment entry action is not a button");
                assert(
                    !element.disabled && element.getAttribute("aria-disabled") !== "true",
                    "Deployment entry action is disabled",
                );
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };

            await waitFor(
                () => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"),
                "ready Project library",
            );
            let action = document.querySelector("[data-oaam-action='open-deployments']");
            if (!(action instanceof HTMLButtonElement)) {
                const assetItem = await waitFor(
                    () => document.querySelector(".asset-library-item-button"),
                    "Project Asset primary action",
                );
                click(assetItem);
                try {
                    action = await waitFor(
                        () => document.querySelector(".asset-inspector [data-oaam-action='open-deployments']"),
                        "Project Deployment action",
                    );
                } catch (error) {
                    const library = document.querySelector("[data-oaam-route='library']");
                    const inspector = document.querySelector(".asset-inspector");
                    throw new Error(
                        `${error instanceof Error ? error.message : String(error)}; ` +
                            `routeAsset=${JSON.stringify(
                                library
                                    ?.querySelector(".asset-library-item[data-selected='true']")
                                    ?.getAttribute("data-oaam-asset-id"),
                            )}; ` +
                            `inspector=${JSON.stringify((inspector?.textContent ?? "missing").slice(-800))}`,
                    );
                }
            }
            const selectedAssetId = action.closest("[data-oaam-asset-id]")?.getAttribute("data-oaam-asset-id");
            assert(typeof selectedAssetId === "string" && selectedAssetId !== "", "selected Asset identity is missing");
            click(action);
            let surface = await waitFor(
                () => document.querySelector("[data-oaam-route='deployment'][data-oaam-state='ready']"),
                "ready Deployment route",
            );
            assert(surface instanceof HTMLElement, "Deployment route has the wrong element type");
            assert(surface.dataset.oaamDeploymentMode === "create", "selected Asset did not open the create journey");
            assert(surface.dataset.oaamAssetId === selectedAssetId, "selected Asset identity changed during navigation");
            await waitFor(() => surface.querySelector("#deployment-asset-title"), "selected Asset step");
            assert(
                surface.querySelector(".asset-usage-relationships") === null,
                "an empty relationship section precedes the first check",
            );
            await waitFor(
                () =>
                    surface.textContent?.includes("Open Agent Asset Manager") &&
                    surface.textContent?.includes(
                        "/a/very/long/project/root/used/to/prove/the/sidebar/never/creates/a/horizontal/scrollbar",
                    ),
                "registered Project identity and root",
            );

            assertOrdinarySurfaceLanguage(surface, "Deployment", entryValue.id, ordinarySurfaceLanguageLexicon);
            assert(
                ![...surface.querySelectorAll("button")].some((button) =>
                    /(?:choose|select).+folder/iu.test(button.textContent ?? ""),
                ),
                "registered Project route still asks the user to choose another folder",
            );
            const deploymentSidebar = surface.querySelector(".deployment-sidebar");
            const deploymentReturn = surface.querySelector(".deployment-library-back");
            const deploymentSeparator = surface.querySelector(":scope > .workbench-resize-separator");
            assert(
                deploymentSidebar instanceof HTMLElement &&
                    deploymentReturn instanceof HTMLButtonElement &&
                    deploymentSidebar.contains(deploymentReturn) &&
                    surface.querySelector(".deployment-target-discovery .deployment-library-back") === null,
                "Deployment return action is not owned by its sidebar",
            );
            assert(deploymentSeparator instanceof HTMLHRElement, "Deployment sidebar resize separator is missing");
            const targetHeading = surface.querySelector("#deployment-target-title");
            const assetHeading = surface.querySelector("#deployment-asset-title");
            const deploymentScrollOwner = surface.querySelector(".deployment-page");
            const deploymentWorkspace = surface.querySelector(".catalog-deployment-workspace");
            const deploymentHeading = surface.querySelector(".deployment-workspace-heading h1");
            assert(targetHeading instanceof HTMLElement, "Deployment target heading is missing");
            assert(assetHeading instanceof HTMLElement, "selected Asset heading is missing");
            assert(deploymentScrollOwner instanceof HTMLElement, "Deployment scroll owner is missing");
            assert(deploymentWorkspace instanceof HTMLElement, "Deployment content owner is missing");
            assert(deploymentHeading instanceof HTMLElement, "Deployment page heading is missing");
            const targetContext = surface.querySelector(".deployment-target-context");
            const providerGroup = targetContext?.querySelector(":scope > .deployment-target-providers");
            const environmentGroup = targetContext?.querySelector(":scope > .deployment-target-environments");
            const targetCopy = surface.querySelector(".deployment-target-copy");
            const targetStatus = surface.querySelector(".deployment-target-status");
            assert(
                targetContext instanceof HTMLElement &&
                    providerGroup instanceof HTMLFieldSetElement &&
                    providerGroup.getAttribute("aria-labelledby") === "deployment-target-provider-label" &&
                    environmentGroup instanceof HTMLFieldSetElement &&
                    environmentGroup.getAttribute("aria-labelledby") === "deployment-target-environment-label" &&
                    targetCopy instanceof HTMLParagraphElement &&
                    targetStatus instanceof HTMLElement,
                "Deployment target selection hierarchy is incomplete",
            );
            const providerBounds = providerGroup.getBoundingClientRect();
            const environmentBounds = environmentGroup.getBoundingClientRect();
            const alongside = environmentBounds.left >= providerBounds.right - 1;
            assert(
                alongside
                    ? providerBounds.width > environmentBounds.width &&
                          environmentBounds.width <= 289 &&
                          Math.abs(providerBounds.top - environmentBounds.top) <= 1 &&
                          Math.abs(providerBounds.bottom - environmentBounds.bottom) <= 1
                    : environmentBounds.top >= providerBounds.bottom - 1 &&
                          Math.abs(providerBounds.left - environmentBounds.left) <= 1 &&
                          Math.abs(providerBounds.right - environmentBounds.right) <= 1,
                `tool/environment groups overlap, lose their flexible tool space or exceed the Environment bound (${JSON.stringify({ providerBounds, environmentBounds })})`,
            );
            assert(
                targetStatus.querySelector(".deployment-target-project-context") instanceof HTMLElement &&
                    targetStatus.querySelector(".deployment-target-actions") instanceof HTMLElement,
                "Project identity and target actions are not grouped under the target result owner",
            );
            for (const [label, heading] of [
                ["asset", assetHeading],
                ["target", targetHeading],
            ]) {
                const rect = heading.getBoundingClientRect();
                assert(rect.left >= 0 && rect.right <= innerWidth, `${label} heading is clipped horizontally`);
                if (rect.bottom > innerHeight) {
                    const scrollStyle = getComputedStyle(deploymentScrollOwner);
                    assert(
                        ["auto", "scroll"].includes(scrollStyle.overflowY) &&
                            deploymentScrollOwner.scrollHeight > deploymentScrollOwner.clientHeight,
                        `${label} heading is below the viewport without a scrollable owner`,
                    );
                }
            }
            assert(
                surface.scrollWidth <= surface.clientWidth + 1,
                `Deployment surface overflows horizontally (${surface.scrollWidth} > ${surface.clientWidth})`,
            );
            assert(
                deploymentScrollOwner.scrollWidth <= deploymentScrollOwner.clientWidth + 1,
                `Deployment content scrolls horizontally (${deploymentScrollOwner.scrollWidth} > ${deploymentScrollOwner.clientWidth})`,
            );
            if (entryValue.deploymentProviderCount === 6) {
                const options = [...surface.querySelectorAll(".deployment-target-providers [data-oaam-provider-id]")];
                assert(options.length === 6, "dense tool selection does not show all six choices");
                const rows = new Set(options.map((option) => Math.round(option.getBoundingClientRect().top)));
                assert(rows.size <= 3, `six tool choices still form an unbalanced single column (${rows.size} rows)`);
                for (const option of options) {
                    const bounds = option.getBoundingClientRect();
                    assert(bounds.width > 0 && bounds.height > 0, "a dense tool choice is not visible");
                }
            }
            if (entryValue.reviewScreenshot === true) {
                const contentRect = deploymentWorkspace.getBoundingClientRect();
                const headingRect = deploymentHeading.getBoundingClientRect();
                const probeAction = surface.querySelector(
                    '[data-oaam-target-action="authorize_local_check"], [data-oaam-target-action="probe"]',
                );
                const workbenchRect = deploymentScrollOwner.getBoundingClientRect();
                assert(contentRect.width <= 1537, `Deployment content exceeds its bounded reading width (${contentRect.width})`);
                if (workbenchRect.width > contentRect.width + 4) {
                    const leftInset = contentRect.left - workbenchRect.left;
                    const rightInset = workbenchRect.right - contentRect.right;
                    assert(
                        Math.abs(leftInset - rightInset) <= 2,
                        `Deployment bounded column is not centered (${leftInset}/${rightInset})`,
                    );
                }
                if (innerWidth >= 2560) {
                    assert(
                        contentRect.width >= 1400,
                        `Deployment bounded column is too narrow for structured desktop content (${contentRect.width})`,
                    );
                }
                if (innerWidth >= 3840) {
                    assert(
                        contentRect.width < workbenchRect.width - 400,
                        `Deployment 4K content incorrectly stretches across the workbench (${contentRect.width}/${workbenchRect.width})`,
                    );
                }
                if (innerWidth <= 1024) {
                    const sidebarRect = deploymentSidebar.getBoundingClientRect();
                    assert(
                        sidebarRect.width <= 218,
                        `Deployment compact sidebar consumes too much workbench width (${sidebarRect.width}/${innerWidth})`,
                    );
                }
                assert(
                    headingRect.top >= contentRect.top && headingRect.top - contentRect.top <= 48,
                    `Deployment heading has excessive internal top spacing (${headingRect.top - contentRect.top})`,
                );
                assert(probeAction instanceof HTMLButtonElement, "Deployment primary action is missing");
                assert(
                    matchMedia("(prefers-contrast: more)").matches === Boolean(entryValue.highContrast),
                    "Deployment high-contrast media state does not match the review case",
                );
                const targetPanel = targetHeading.closest("[data-oaam-surface]");
                assert(
                    targetPanel?.getAttribute("data-oaam-surface") === "section" &&
                        getComputedStyle(targetPanel).borderTopWidth === "0px",
                    "Deployment passive target section regained a card boundary",
                );
                const probeRect = probeAction.getBoundingClientRect();
                assert(
                    probeRect.top >= 0 && probeRect.bottom <= innerHeight,
                    `Deployment primary action is outside the first viewport (${probeRect.top}, ${probeRect.bottom}, ${innerHeight})`,
                );
            }
            const versionAction = await waitFor(
                () => surface.querySelector(".catalog-asset-version-button"),
                "compact current-Version action",
            );
            click(versionAction);
            const versionInspector = await waitFor(
                () => surface.querySelector(".catalog-asset-version-inspector"),
                "current-Version right inspector",
            );
            const deploymentWorkbench = surface.querySelector(".deployment-workbench");
            const selectedAssetRow = versionAction.closest(".deployment-selected-asset-row");
            assert(
                deploymentWorkbench instanceof HTMLElement &&
                    versionInspector instanceof HTMLElement &&
                    versionInspector.parentElement === deploymentWorkbench &&
                    deploymentWorkbench.lastElementChild === versionInspector &&
                    surface.querySelector(".deployment-page .catalog-asset-version-inspector") === null,
                "current Version is not owned by the native workbench right rail",
            );
            assert(
                selectedAssetRow instanceof HTMLElement &&
                    selectedAssetRow.querySelector("[data-oaam-icon='preview']") instanceof SVGElement,
                "selected current Version is not represented by the preview action",
            );
            await waitFor(
                () => versionInspector.querySelector(".asset-file-preview-document .import-preview-line-number"),
                "saved current-Version file content",
            );
            const assertInspectorHeader = () => {
                const header = versionInspector.querySelector(".asset-inspector-header");
                const title = header?.querySelector("h2");
                const modes = header?.querySelector(".asset-inspector-modes");
                assert(
                    header instanceof HTMLElement && title instanceof HTMLElement && modes instanceof HTMLElement,
                    "Version/source inspector header owners are missing",
                );
                const headerBox = header.getBoundingClientRect();
                const titleBox = title.getBoundingClientRect();
                const modesBox = modes.getBoundingClientRect();
                assert(title.scrollWidth <= title.clientWidth + 1, "Version/source controls compress the fixture Asset title");
                assert(
                    modesBox.top >= titleBox.bottom && modesBox.bottom <= headerBox.bottom + 1,
                    "Version/source controls collide with the Asset heading or escape its header",
                );
                for (const control of modes.querySelectorAll("button")) {
                    const box = control.getBoundingClientRect();
                    assert(
                        box.left >= headerBox.left && box.right <= headerBox.right + 1,
                        "localized Version/source controls overflow the inspector header",
                    );
                }
            };
            assertInspectorHeader();
            assert(
                versionInspector.textContent?.includes("Portable guide content") &&
                    versionInspector.querySelector(".compact-list") === null,
                "current-Version inspector still exposes only the old nested metadata list",
            );
            const sourceViewAction = versionInspector.querySelector(
                '[data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.004"]',
            );
            sourceViewAction.focus();
            assert(document.activeElement === sourceViewAction, "source view cannot receive keyboard focus");
            click(sourceViewAction);
            const sourceDetails = await waitFor(
                () => versionInspector.querySelector('.catalog-source-detail-list[data-oaam-source-adapter-id="CLAUDECODE"]'),
                "same-inspector Asset source details",
            );
            assert(
                sourceViewAction.getAttribute("aria-pressed") === "true" &&
                    versionInspector.getAttribute("data-oaam-inspector-view") === "source" &&
                    sourceDetails
                        .querySelector('[data-oaam-source-relative-path="AGENTS.md"]')
                        ?.getAttribute("data-oaam-source-full-path") ===
                        "/a/very/long/project/root/used/to/prove/the/sidebar/never/creates/a/horizontal/scrollbar/AGENTS.md" &&
                    surface.querySelector("[data-oaam-route='sources']") === null,
                "Asset source did not remain in the exact Deployment right inspector",
            );
            assertInspectorHeader();
            if (entryValue.reviewScreenshot === true) {
                const inspectorRect = versionInspector.getBoundingClientRect();
                const sourceAction = sourceDetails.querySelector(
                    '[data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_source_inspector.002"]',
                );
                assert(
                    inspectorRect.left >= 0 && inspectorRect.right <= innerWidth,
                    `Deployment right inspector is not clamped inside the viewport (${JSON.stringify(inspectorRect.toJSON())})`,
                );
                assert(sourceAction instanceof HTMLButtonElement, "Asset source copy/reveal action is missing");
                const actionRect = sourceAction.getBoundingClientRect();
                assert(
                    actionRect.width >= 34 && actionRect.height >= 34,
                    `Asset source action hit target is too small (${actionRect.width}x${actionRect.height})`,
                );
                const targetLayout = await observeTargetLayout(surface);
                if (entryValue.id === "deployment-layout-1180x760-zh-light") {
                    const options = [...surface.querySelectorAll(".deployment-target-providers [data-oaam-provider-id]")];
                    const rows = new Map();
                    for (const option of options) {
                        const top = Math.round(option.getBoundingClientRect().top);
                        rows.set(top, (rows.get(top) ?? 0) + 1);
                    }
                    assert(
                        options.length === 6 && rows.size === 3 && [...rows.values()].every((count) => count === 2),
                        "six tools must retain two columns beside the open source inspector at 1180 pixels",
                    );
                }
                assert(
                    targetLayout.splitWords.length === 0 && targetLayout.wrappedSelectionActions.length === 0,
                    `Deployment tool/environment controls crush their text (${JSON.stringify(targetLayout)})`,
                );
                assert(
                    targetLayout.primaryActionReachability === null ||
                        (targetLayout.primaryActionReachability.visible && targetLayout.primaryActionReachability.hit),
                    `Deployment primary action cannot be reached beside the docked inspector (${JSON.stringify(targetLayout)})`,
                );
                assert(
                    deploymentScrollOwner.scrollWidth <= deploymentScrollOwner.clientWidth + 1,
                    `Asset source details introduce page-level horizontal overflow (${deploymentScrollOwner.scrollWidth} > ${deploymentScrollOwner.clientWidth}); ` +
                        Array.from(deploymentScrollOwner.querySelectorAll("*"))
                            .filter((node) => {
                                if (!(node instanceof HTMLElement)) return false;
                                const ownerRect = deploymentScrollOwner.getBoundingClientRect();
                                const nodeRect = node.getBoundingClientRect();
                                return (
                                    node.scrollWidth > node.clientWidth + 1 ||
                                    nodeRect.left < ownerRect.left - 1 ||
                                    nodeRect.right > ownerRect.right + 1
                                );
                            })
                            .slice(0, 6)
                            .map((node) => {
                                const nodeRect = node.getBoundingClientRect();
                                return `${node.tagName.toLowerCase()}.${node.className}:${node.scrollWidth}>${node.clientWidth}@${nodeRect.left}-${nodeRect.right}`;
                            })
                            .join(","),
                );
            }
            const versionViewAction = versionInspector.querySelector(
                '[data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.003"]',
            );
            click(versionViewAction);
            await waitFor(
                () =>
                    versionViewAction.getAttribute("aria-pressed") === "true" &&
                    versionInspector.getAttribute("data-oaam-inspector-view") === "version" &&
                    versionInspector.querySelector(".asset-file-preview-document .import-preview-line-number"),
                "current-Version content after source details",
            );
            const selectedEnvironmentKeys = [...surface.querySelectorAll(".deployment-target-context input:checked")].map(
                (input) => input.value,
            );
            click(
                versionInspector.querySelector(
                    '[data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.001"]',
                ),
            );
            await waitFor(
                () =>
                    surface.querySelector(".catalog-asset-version-inspector") === null &&
                    surface.querySelectorAll(".deployment-selected-asset-row").length === 1,
                "closed current-Version inspector with Deployment context retained",
            );
            assert(
                JSON.stringify(
                    [...surface.querySelectorAll(".deployment-target-context input:checked")].map((input) => input.value),
                ) === JSON.stringify(selectedEnvironmentKeys),
                "closing the Asset inspector changed the selected environment",
            );
            assert(
                surface.querySelectorAll(".deployment-selected-asset-row").length === 1,
                "selected Asset is repeated in the create journey",
            );
            assert(
                surface.querySelector(".deployment-asset-choice") === null,
                "create journey still asks the user to reselect an Asset",
            );
            if (entryValue.deploymentProviderCount === 6) {
                // The extra four choices exercise production layout only. Keep the existing
                // two-tool read-only fixture journey and its exact result assertions unchanged.
                for (const option of surface.querySelectorAll(".deployment-target-providers [data-oaam-provider-id]")) {
                    if (["CLAUDECODE", "OPENCODE"].includes(option.getAttribute("data-oaam-provider-id"))) continue;
                    const input = option.querySelector("input[type='checkbox']");
                    assert(input instanceof HTMLInputElement && input.checked, "dense tool choice lost its initial selection");
                    input.click();
                }
                await waitFor(
                    () => surface.querySelectorAll(".deployment-target-providers input:checked").length === 2,
                    "explicit return to the two-tool read-only fixture selection",
                );
            }
            const authorizeProbe = surface.querySelector('[data-oaam-target-action="authorize_local_check"]');
            if (authorizeProbe !== null) {
                authorizeProbe.focus();
                assert(document.activeElement === authorizeProbe, "tool enablement action cannot receive keyboard focus");
                click(authorizeProbe);
                let expectedFocus = authorizeProbe;
                try {
                    await waitFor(
                        () =>
                            document.documentElement.dataset.oaamTargetEnablementWaiting === "true" &&
                            authorizeProbe.getAttribute("aria-disabled") === "true",
                        "pending tool enablement response",
                    );
                    assert(document.activeElement === authorizeProbe, "pending tool enablement lost keyboard focus");
                    for (const key of [" ", "Enter"]) {
                        const press = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
                        authorizeProbe.dispatchEvent(press);
                        assert(press.defaultPrevented, "busy activation key can carry into the next action");
                    }
                    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
                    authorizeProbe.dispatchEvent(tab);
                    assert(!tab.defaultPrevented, "busy action prevents keyboard focus navigation");
                    if (entryValue.id === "deployment-layout-1180x760-zh-light") {
                        expectedFocus = surface.querySelector(".deployment-library-back");
                        expectedFocus.focus();
                        assert(document.activeElement === expectedFocus, "cannot move focus away during enablement");
                    }
                } finally {
                    document.dispatchEvent(new Event("oaam-actual-render-release-enablement"));
                }
                surface = await waitFor(() => {
                    const candidates = [
                        ...document.querySelectorAll("[data-oaam-route='deployment'][data-oaam-state='ready']"),
                    ].filter((candidate) => candidate.getAttribute("data-oaam-asset-id") === selectedAssetId);
                    assert(candidates.length <= 1, "authorized Deployment route is ambiguous");
                    const current = candidates[0];
                    return current?.querySelector('[data-oaam-target-action="authorize_local_check"]') === null &&
                        current?.querySelector('[data-oaam-target-action="probe"]')?.disabled === false
                        ? current
                        : undefined;
                }, "separately authorized target check");
                const check = surface.querySelector('[data-oaam-target-action="probe"]');
                assert(check === authorizeProbe, "tool enablement replaced the focused primary action");
                assert(document.activeElement === expectedFocus, "tool enablement changed the user's keyboard focus");
                for (const key of [" ", "Enter"]) {
                    const held = new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true });
                    check.dispatchEvent(held);
                    assert(held.defaultPrevented, "held activation key can trigger the changed primary action");
                    const fresh = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
                    check.dispatchEvent(fresh);
                    assert(!fresh.defaultPrevented, "fresh activation key remains blocked after enablement");
                }
            }
            click(surface.querySelector('[data-oaam-target-action="probe"]'));
            const journeyStates = ["deployment_and_reverse:ready"];
            if (entryValue.deploymentAssetChoiceCount === 15) {
                let relationshipPanel;
                try {
                    relationshipPanel = await waitFor(
                        () =>
                            document.querySelector(
                                "[data-oaam-route='deployment'][data-oaam-state='ready'] " +
                                    '[data-oaam-asset-usage-state="ready"]',
                            ),
                        "ready Asset usage relationships",
                    );
                    surface = relationshipPanel.closest("[data-oaam-route='deployment']");
                    assert(surface instanceof HTMLElement, "current Deployment route is missing after Asset usage analysis");
                } catch (error) {
                    const current = document.querySelector("[data-oaam-asset-usage-state]");
                    const rendererFailure = document.querySelector("[data-oaam-renderer-failure]");
                    throw new Error(
                        `${error instanceof Error ? error.message : String(error)}; ` +
                            `probe=${JSON.stringify(document.documentElement.dataset.oaamTargetProbeAdapterIds)}; ` +
                            `usage=${JSON.stringify(document.documentElement.dataset.oaamAssetUsageRequest)}; ` +
                            `state=${JSON.stringify(current?.getAttribute("data-oaam-asset-usage-state"))}; ` +
                            `rendererFailure=${JSON.stringify(rendererFailure?.getAttribute("data-oaam-renderer-failure-kind"))}; ` +
                            `routes=${JSON.stringify(
                                [...document.querySelectorAll("[data-oaam-route]")].map((node) => [
                                    node.getAttribute("data-oaam-route"),
                                    node.getAttribute("data-oaam-state"),
                                    node.getAttribute("data-oaam-asset-id"),
                                ]),
                            )}; ` +
                            `alerts=${JSON.stringify([...document.querySelectorAll("[role='alert']")].map((node) => node.textContent))}`,
                    );
                }
                const toolSummaries = relationshipPanel.querySelectorAll(".asset-usage-group-summary");
                assert(toolSummaries.length === 2, "exact target relationships do not have two tool summaries");
                const directRowSelector =
                    '[data-oaam-asset-usage-capability="direct"][data-oaam-asset-usage-target-state="absent"]' +
                    '[data-oaam-asset-usage-managed="none"]';
                for (const summary of toolSummaries) {
                    assert(summary instanceof HTMLButtonElement, "tool summary cannot be manually folded");
                    const group = summary.closest(".asset-usage-group");
                    assert(
                        summary.getAttribute("aria-expanded") === "true" &&
                            group?.querySelectorAll(directRowSelector).length === 1,
                        "tool group with an available preparation action is not initially expanded",
                    );
                    const title = summary.querySelector(".asset-usage-group-copy strong");
                    assert(title instanceof HTMLElement, "tool summary title is missing");
                    assert(
                        getComputedStyle(title).color ===
                            getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary").trim() ||
                            getComputedStyle(title).color === getComputedStyle(summary).color,
                        "tool summary title does not retain the primary text color",
                    );
                    assert(
                        summary.querySelector('[data-oaam-icon="chevron_down"]') instanceof SVGElement,
                        "expanded tool summary has no visible folding affordance",
                    );
                    click(summary);
                    await waitFor(
                        () =>
                            summary.getAttribute("aria-expanded") === "false" &&
                            group?.querySelectorAll(".asset-usage-row").length === 0 &&
                            summary.querySelector('[data-oaam-icon="chevron_right"]') instanceof SVGElement,
                        "manually collapsed tool group",
                    );
                }
                for (let expandedCount = 1; expandedCount <= toolSummaries.length; expandedCount += 1) {
                    const summary = await waitFor(
                        () =>
                            [...relationshipPanel.querySelectorAll(".asset-usage-group-summary")].find(
                                (candidate) => candidate.getAttribute("aria-expanded") === "false",
                            ),
                        `collapsed tool summary ${String(expandedCount)}`,
                    );
                    click(summary);
                    await waitFor(
                        () => relationshipPanel.querySelectorAll(directRowSelector).length === expandedCount,
                        `expanded tool group ${String(expandedCount)}`,
                    );
                }
                const directRows = relationshipPanel.querySelectorAll(directRowSelector);
                assert(directRows.length === 2, "expanded tool groups do not show the two exact absent direct rows");
                if (entryValue.reviewScreenshot === true) {
                    const rowHeights = [...directRows].map((row) => row.getBoundingClientRect().height);
                    assert(
                        rowHeights.every((height) => height <= 112),
                        `ready runtime rows are not compact (${JSON.stringify(rowHeights)})`,
                    );
                }
                assert(
                    relationshipPanel.querySelectorAll('[data-oaam-action="create_deployment_review_intent"]').length === 2,
                    "absent direct rows do not expose one preview action per exact target",
                );
                assert(
                    relationshipPanel.querySelector("[role='combobox']") === null &&
                        document.documentElement.dataset.oaamAssetUsageRequest?.includes(selectedAssetId),
                    "read-only Asset relationship projection fell back to the old manual target form",
                );
                assert(
                    relationshipPanel.getAttribute("data-oaam-asset-usage-view") === "adapter" &&
                        relationshipPanel.querySelectorAll(".asset-usage-group").length === 2,
                    "Asset relationships are not initially grouped into two compact tool sections",
                );
                if (entryValue.reviewScreenshot === true && innerWidth >= 1920) {
                    const groups = relationshipPanel.querySelector(".asset-usage-groups");
                    assert(groups instanceof HTMLElement, "Asset relationship grid is missing");
                    const columns = getComputedStyle(groups)
                        .gridTemplateColumns.split(" ")
                        .filter((value) => Number.parseFloat(value) > 0);
                    assert(
                        columns.length === 2,
                        `wide Asset relationships do not use two structured columns (${JSON.stringify(columns)})`,
                    );
                }
                const projectView = relationshipPanel.querySelector('[data-oaam-asset-usage-view-choice="project"]');
                click(projectView);
                await waitFor(
                    () => relationshipPanel.getAttribute("data-oaam-asset-usage-view") === "project",
                    "Project-grouped Asset relationships",
                );
                const projectGroups = relationshipPanel.querySelectorAll(".asset-usage-group");
                assert(
                    projectGroups.length === 1,
                    "Project view does not compact both exact tool relationships under one Project",
                );
                const projectGroup = projectGroups[0];
                const projectSummary = projectGroup?.querySelector(".asset-usage-group-summary");
                assert(projectSummary instanceof HTMLButtonElement, "Project relationship disclosure is missing");
                assert(
                    projectSummary.getAttribute("aria-expanded") === "true" &&
                        projectGroup?.querySelectorAll(directRowSelector).length === 2,
                    "Project group with available preparation actions is not initially expanded",
                );
                click(projectSummary);
                await waitFor(
                    () =>
                        projectSummary.getAttribute("aria-expanded") === "false" &&
                        projectGroup?.querySelectorAll(".asset-usage-row").length === 0,
                    "manually collapsed Project relationship rows",
                );
                click(projectSummary);
                await waitFor(
                    () =>
                        projectSummary.getAttribute("aria-expanded") === "true" &&
                        projectGroup?.querySelectorAll(".asset-usage-row").length === 2,
                    "expanded Project relationship rows",
                );
                click(projectSummary);
                await waitFor(
                    () =>
                        relationshipPanel.querySelector(".asset-usage-group-summary")?.getAttribute("aria-expanded") === "false",
                    "collapsed Project relationship rows",
                );
                journeyStates.push("deployment_and_reverse:asset_usage_ready");
            } else {
                const unavailableTargets = await waitFor(() => {
                    const panel = document.querySelector(
                        "[data-oaam-route='deployment'][data-oaam-state='ready'] " + '[data-oaam-asset-usage-state="none"]',
                    );
                    const rows = panel?.querySelectorAll(".asset-usage-row");
                    return rows?.length === 2 &&
                        panel?.querySelector(
                            '[data-oaam-agent-runtime-id="CLAUDE_CODE_CLI"]' +
                                '[data-oaam-target-observation-state="current_observation_failed"]',
                        ) !== null &&
                        panel?.querySelector(
                            '[data-oaam-agent-runtime-id="OPENCODE_CLI"]' +
                                '[data-oaam-target-observation-state="not_installed"]',
                        ) !== null
                        ? panel
                        : undefined;
                }, "stable unavailable target observations");
                surface = unavailableTargets.closest("[data-oaam-route='deployment']");
                assert(surface instanceof HTMLElement, "current Deployment route is missing after the no-target result");
                const targetRows = unavailableTargets.querySelectorAll(".asset-usage-row");
                const targetRowFacts = [...targetRows].map((row) => ({
                    runtime: row.getAttribute("data-oaam-agent-runtime-id"),
                    state: row.getAttribute("data-oaam-target-observation-state"),
                    targetKey: row.getAttribute("data-oaam-target-key"),
                }));
                assert(
                    targetRows.length === 2 &&
                        unavailableTargets.querySelector(
                            '[data-oaam-agent-runtime-id="CLAUDE_CODE_CLI"]' +
                                '[data-oaam-target-observation-state="current_observation_failed"]',
                        ) !== null &&
                        unavailableTargets.querySelector(
                            '[data-oaam-agent-runtime-id="OPENCODE_CLI"]' +
                                '[data-oaam-target-observation-state="not_installed"]',
                        ) !== null &&
                        [...targetRows].every((row) => row.getAttribute("data-oaam-target-key") === null),
                    `no-target result does not preserve the two exact checked-tool observation states: ${JSON.stringify(targetRowFacts)}`,
                );
                assert(
                    unavailableTargets.querySelector('[data-oaam-action="create_deployment_review_intent"]') === null,
                    "an unavailable target observation exposes a Deployment review action",
                );
                journeyStates.push("deployment_and_reverse:target_empty");
            }
            assert(
                document.documentElement.dataset.oaamTargetEnablementIds === '["CLAUDECODE","OPENCODE"]' &&
                    document.documentElement.dataset.oaamTargetProbeAdapterIds === '["CLAUDECODE","OPENCODE"]',
                "target scan did not persist and probe the exact selected Provider set",
            );
            if (entryValue.id === "deployment-layout-1180x760-zh-light") {
                const previousScroll = deploymentScrollOwner.scrollTop;
                const identity = selectedAssetRow.textContent;
                click(
                    versionInspector.querySelector(
                        '[data-oaam-interaction-entry="features.catalog-deployment.catalog_asset_version_inspector.001"]',
                    ),
                );
                await waitFor(
                    () => surface.querySelector(".catalog-asset-version-inspector") === null,
                    "closed inspector for context focus checks",
                );
                const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                deploymentScrollOwner.scrollTop = deploymentScrollOwner.scrollHeight;
                await frame();
                const contextBounds = selectedAssetRow.getBoundingClientRect();
                const pageBounds = deploymentScrollOwner.getBoundingClientRect();
                assert(
                    contextBounds.top >= pageBounds.top - 1 && contextBounds.bottom <= pageBounds.bottom + 1,
                    "selected Asset context leaves the result viewport",
                );
                assert(selectedAssetRow.textContent === identity, "scrolling changes the reviewed Asset identity");
                const controls = [
                    ...surface.querySelectorAll(
                        '.deployment-target-context button:not(:disabled), .deployment-target-context input:not(:disabled), [data-oaam-target-action="probe"], .asset-usage-row button:not(:disabled), .asset-usage-row summary',
                    ),
                ]
                    .filter((control) => control.getClientRects().length > 0)
                    .reverse();
                assert(controls.length >= 5, "context focus check lacks actual result and selection controls");
                for (const control of controls) {
                    control.focus();
                    await frame();
                    const visible = control.matches(".workbench-semantic-input") ? control.closest("label") : control;
                    const bounds = visible.getBoundingClientRect();
                    const retained = selectedAssetRow.getBoundingClientRect();
                    const ownerBounds = deploymentScrollOwner.getBoundingClientRect();
                    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
                    assert(document.activeElement === control, "context traversal loses the focused control");
                    assert(
                        bounds.top >= retained.bottom - 1 &&
                            bounds.bottom <= ownerBounds.bottom + 1 &&
                            hit !== null &&
                            visible.contains(hit),
                        `retained Asset context obscures the focused control: ${visible.textContent}`,
                    );
                }
                click(versionAction);
                await waitFor(
                    () => surface.querySelector(".catalog-asset-version-inspector .asset-file-preview"),
                    "restored Version inspector after context checks",
                );
                deploymentScrollOwner.scrollTop = previousScroll;
                await frame();
            }
            const surfaceRect = surface.getBoundingClientRect();
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates,
                routeStates: ["library:ready", "deployment:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
                scrollProbe: {
                    x: Math.floor(surfaceRect.left + surfaceRect.width / 2),
                    y: Math.floor(surfaceRect.top + Math.min(surfaceRect.height / 2, 80)),
                    scrollHeight: surface.scrollHeight,
                    clientHeight: surface.clientHeight,
                },
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()}, ${observeDeploymentTargetLayout.toString()})`,
        true,
    );
    return result;
}
