export function inspectImportReviewLayout({ assets, route, assert }) {
    const discoveryStage = assets.querySelector(".journey-stage:not(.journey-asset-review)");
    const reviewStage = assets.querySelector(".journey-asset-review");
    const reviewMain = assets.querySelector(".import-review-main");
    assert(
        discoveryStage instanceof HTMLElement && reviewStage instanceof HTMLElement && reviewMain instanceof HTMLElement,
        `${route} source selection and import review surfaces are incomplete`,
    );
    const discoveryBounds = discoveryStage.getBoundingClientRect();
    const reviewBounds = reviewStage.getBoundingClientRect();
    assert(
        reviewBounds.top - discoveryBounds.bottom >= 8,
        `${route} source selection and import review cards have no visual separation`,
    );
    assert(
        Math.abs(reviewMain.getBoundingClientRect().width - reviewBounds.width) <= 2,
        `${route} import review card is an unintended narrow column`,
    );
    const existingCandidates = assets.querySelector(".import-existing-candidates");
    for (const actions of assets.querySelectorAll(".import-candidate-files")) {
        assert(actions.querySelectorAll("button").length === 1, `${route} candidate repeats its file-view entry`);
    }
    const existingCandidate = assets.querySelector('[data-oaam-import-candidate-id="actual-render-existing-guidance"]');
    assert(
        existingCandidates instanceof HTMLDetailsElement &&
            !existingCandidates.open &&
            existingCandidate?.closest("details") === existingCandidates,
        `${route} does not place existing Assets in one collapsed tail group`,
    );
}

export async function inspectImportPreviewSoftWrap({ inspector, route, click, waitFor, assert }) {
    const activeTab = inspector.querySelector(".import-preview-tab[data-active='true']");
    const activeTabStyle = activeTab === null ? undefined : getComputedStyle(activeTab);
    assert(
        activeTab instanceof HTMLElement &&
            Number.parseFloat(activeTabStyle?.borderRadius ?? "0") > 0 &&
            activeTab.querySelector(".workbench-icon-button") instanceof HTMLButtonElement,
        `${route} file inspector tab is not one rounded active target with its close action`,
    );
    const previewViewButtons = [...inspector.querySelectorAll(".import-preview-view-button")];
    const wrapToggle = previewViewButtons.at(-1);
    assert(previewViewButtons.length >= 2, `${route} file inspector has no format and soft-wrap choices`);
    assert(
        previewViewButtons.at(0)?.querySelector("[data-oaam-icon='render'], [data-oaam-icon='format']") instanceof SVGElement &&
            wrapToggle?.querySelector("[data-oaam-icon='wrap']") instanceof SVGElement,
        `${route} file inspector does not use the shared semantic format and wrap icons`,
    );
    click(wrapToggle, `${route} soft-wrap source`);
    await waitFor(
        () => inspector.querySelector(".import-preview-source[data-soft-wrap='true']"),
        `${route} soft-wrapped file source`,
    );
}

export async function inspectImportCandidateDeselect({ assets, candidateInput, route, sourceSelectionMode, waitFor, assert }) {
    if (route === "guided_import") {
        const cancellationsBeforeReturn = Number(document.documentElement.dataset.oaamPreviewCancellationCount ?? "0");
        const back = assets.querySelector("[data-oaam-interaction-entry='pages.guided_import_page.002']");
        assert(back instanceof HTMLButtonElement && !back.disabled, "return to source locations is unavailable");
        back.click();
        const sources = await waitFor(
            () => document.querySelector("[data-oaam-route='guided_import'][data-oaam-step='sources']"),
            "source-entry selection",
        );
        await waitFor(
            () => Number(document.documentElement.dataset.oaamPreviewCancellationCount) === cancellationsBeforeReturn + 1,
            "cancel previous preview when returning to sources",
        );
        const entryChoice = sources.querySelector(".source-runtime-selection [role='combobox']");
        assert(entryChoice instanceof HTMLButtonElement && !entryChoice.disabled, "observed runtime selection missing");
        entryChoice.scrollIntoView({ block: "center" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = entryChoice.getBoundingClientRect();
        assert(bounds.width >= 180 && bounds.left >= 0 && bounds.right <= innerWidth, "source-entry selector is clipped");
        entryChoice.click();
        const cli = await waitFor(
            () => [...document.querySelectorAll("[role='option']")].find((item) => item.textContent === "OpenCode CLI"),
            "OpenCode CLI option",
        );
        cli.click();
        await waitFor(() => entryChoice.textContent?.includes("OpenCode CLI"), "chosen source entry");
        const continueAction = sources.querySelector("[data-oaam-journey-continue='sources']");
        assert(continueAction instanceof HTMLButtonElement && !continueAction.disabled, "selected source entry cannot continue");
        continueAction.click();
        await waitFor(
            () =>
                document.querySelector("[data-oaam-route='guided_import'][data-oaam-step='assets'] .import-candidate-list > li"),
            "new selected-entry preview",
        );
        const request = JSON.parse(document.documentElement.dataset.oaamReadRequest ?? "{}");
        const selected = request.selections.find((item) => item.sourceRootRowIds.includes("opencode-compatible-only"));
        assert(JSON.stringify(selected?.agentRuntimeIds) === '["OPENCODE_CLI"]', "read widened the explicit source entry");
        const returnAgain = assets.querySelector("[data-oaam-interaction-entry='pages.guided_import_page.002']");
        assert(returnAgain instanceof HTMLButtonElement && !returnAgain.disabled, "new preview cannot return to sources");
        returnAgain.click();
        const retainedSources = await waitFor(
            () => document.querySelector("[data-oaam-route='guided_import'][data-oaam-step='sources']"),
            "return to retained source selection",
        );
        await waitFor(
            () => Number(document.documentElement.dataset.oaamPreviewCancellationCount) === cancellationsBeforeReturn + 2,
            "cancel selected-entry preview when returning again",
        );
        const retainedChoice = retainedSources.querySelector(".source-runtime-selection [role='combobox']");
        assert(
            retainedChoice instanceof HTMLButtonElement &&
                retainedChoice.isConnected &&
                retainedChoice.textContent?.includes("OpenCode CLI"),
            "return lost the selected source entry",
        );
        const retainedContinue = retainedSources.querySelector("[data-oaam-journey-continue='sources']");
        assert(
            retainedContinue instanceof HTMLButtonElement && retainedContinue.isConnected && !retainedContinue.disabled,
            "retained source selection cannot continue",
        );
        retainedContinue.click();
        await waitFor(
            () =>
                document.querySelector("[data-oaam-route='guided_import'][data-oaam-step='assets'] .import-candidate-list > li"),
            "retained-entry preview",
        );
        candidateInput = assets.querySelector("[data-oaam-import-candidate-id] input[type='checkbox']");
        document.documentElement.dataset.oaamSourceRuntimeSelection = "explicit_cli_retained_after_return";
    }
    const scrollOwner = assets.closest(".guided-import-shell, .onboarding-shell");
    assert(scrollOwner instanceof HTMLElement, `${route} has no journey scroll owner`);
    scrollOwner.scrollTop = scrollOwner.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    candidateInput.click();
    await waitFor(
        () =>
            assets.isConnected &&
            assets.querySelector("[data-oaam-import-candidate-id] input[type='checkbox']")?.checked === false &&
            document.querySelector("[data-oaam-renderer-failure]") === null &&
            assets.querySelector(".import-review-main"),
        `${route} stable review after deselection`,
    );
    assert(
        assets.isConnected &&
            document.querySelector("[data-oaam-renderer-failure]") === null &&
            assets.querySelector(".import-preview-inspector") === null,
        `${route} deselection escaped the review state or retained a stale file inspector`,
    );
    scrollOwner.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const heading = assets.querySelector(".workspace-heading");
    const progress = assets.querySelector(".import-journey-steps");
    const headingBounds = heading?.getBoundingClientRect();
    const progressBounds = progress?.getBoundingClientRect();
    assert(
        scrollOwner.scrollTop <= 1 &&
            heading instanceof HTMLElement &&
            progress instanceof HTMLElement &&
            headingBounds.top >= -1 &&
            progressBounds.bottom <= scrollOwner.clientHeight + 1,
        `${route} cannot scroll back to its heading and navigation after deselection ` +
            `(scrollTop=${String(scrollOwner.scrollTop)}, clientHeight=${String(scrollOwner.clientHeight)}, ` +
            `headingTop=${String(headingBounds?.top)}, progressBottom=${String(progressBounds?.bottom)})`,
    );
    scrollOwner.scrollTop = scrollOwner.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const actions = assets.querySelector(".onboarding-actions");
    assert(
        actions instanceof HTMLElement && actions.getBoundingClientRect().bottom <= scrollOwner.clientHeight + 1,
        `${route} cannot scroll to its review actions after deselection`,
    );
    const readRequestText = document.documentElement.dataset.oaamReadRequest;
    assert(readRequestText !== undefined, `${route} did not read selected source claims`);
    const selectedRootRows = JSON.parse(readRequestText)
        .selections.flatMap((selection) => selection.sourceRootRowIds)
        .sort();
    const expectedRootRows =
        sourceSelectionMode === "compatible_only"
            ? '["opencode-compatible-only"]'
            : '["claude-native","opencode-compatible-only"]';
    assert(JSON.stringify(selectedRootRows) === expectedRootRows, `${route} read the wrong source selection`);
}
