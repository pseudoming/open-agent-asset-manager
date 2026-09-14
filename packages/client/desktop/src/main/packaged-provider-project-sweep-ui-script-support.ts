export const PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const guided = document.querySelector('main[data-oaam-route="guided_import"]');
    if (guided instanceof HTMLElement) {
        const close = guided.querySelector('.guided-import-heading button.library-secondary-button');
        if (!(close instanceof HTMLButtonElement) || close.disabled) {
            throw new Error("Provider sweep cannot leave the current guided import");
        }
        close.click();
    }
    const entry = await waitFor(() => {
        const library = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
        const sources = document.querySelector('main[data-oaam-route="sources"][data-oaam-state="ready"]');
        return (library ?? sources) instanceof HTMLElement ? (library ?? sources) : false;
    }, "the library or Sources workspace before the Provider sweep");
    if (entry.dataset.oaamRoute === "sources") {
        const start = [...entry.querySelectorAll('.library-toolbar-actions > [data-oaam-action="start-guided-import"]')]
            .filter((button) => button instanceof HTMLButtonElement && !button.disabled);
        if (start.length !== 1 || !(start[0] instanceof HTMLButtonElement)) {
            throw new Error("Provider sweep has no unique guided-import action in the current Sources workspace");
        }
        start[0].click();
    } else {
        const library = entry;
        const globalChoice = library.querySelector('[data-oaam-subject-choice="global"]');
        if (!(globalChoice instanceof HTMLButtonElement) || globalChoice.disabled) {
            throw new Error("Provider sweep cannot choose the Global library");
        }
        if (globalChoice.getAttribute("aria-selected") !== "true") globalChoice.click();
        let globalAction;
        const globalActionStartedAt = Date.now();
        let globalActionPollCount = 0;
        let lastGlobalActionState = {
            elapsedMilliseconds: 0,
            pollCount: 0,
            route: null,
            subject: null,
            shellState: null,
            collectionIds: [],
            globalCollectionTotalCount: null,
            emptyStatePresent: false,
            actions: [],
            alerts: [],
        };
        while (Date.now() < deadline && !(globalAction instanceof HTMLButtonElement)) {
            globalActionPollCount += 1;
            const current = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="global"]');
            if (!(current instanceof HTMLElement)) {
                await new Promise((resolve) => setTimeout(resolve, 25));
                continue;
            }
            const collections = [...current.querySelectorAll('.asset-collection[data-oaam-collection-id]')]
                .filter((candidate) => candidate instanceof HTMLElement);
            const globalCollections = collections.filter((candidate) => candidate.dataset.oaamCollectionId === "global");
            const toolbarEntries = [...current.querySelectorAll(
                '.library-toolbar-actions > [data-oaam-semantic-entry="library.guided_import.toolbar"]',
            )];
            const emptyEntries = [...current.querySelectorAll(
                '.library-empty-actions > [data-oaam-semantic-entry="library.guided_import.empty_collection"]',
            )];
            const actionState = [...toolbarEntries, ...emptyEntries].map((candidate) => ({
                tagName: candidate.tagName.toLowerCase(),
                action: candidate.getAttribute("data-oaam-action"),
                semanticAction: candidate.getAttribute("data-oaam-semantic-action"),
                semanticEntry: candidate.getAttribute("data-oaam-semantic-entry"),
                disabled: candidate instanceof HTMLButtonElement ? candidate.disabled : null,
            }));
            const emptyStatePresent = current.querySelector('.library-empty-state') instanceof HTMLElement;
            const totalCountText = globalCollections[0]?.dataset.oaamTotalCount;
            const globalCollectionTotalCount = totalCountText === undefined ? null : Number.parseInt(totalCountText, 10);
            lastGlobalActionState = {
                elapsedMilliseconds: Date.now() - globalActionStartedAt,
                pollCount: globalActionPollCount,
                route: current.dataset.oaamRoute ?? null,
                subject: current.dataset.oaamSubject ?? null,
                shellState: current.dataset.oaamState ?? null,
                collectionIds: collections.map((candidate) => candidate.dataset.oaamCollectionId ?? ""),
                globalCollectionTotalCount: Number.isSafeInteger(globalCollectionTotalCount)
                    ? globalCollectionTotalCount
                    : null,
                emptyStatePresent,
                actions: actionState,
                alerts: [...current.querySelectorAll('[role="alert"]')]
                    .map((alert) => (alert.textContent ?? "").trim().slice(0, 160))
                    .filter((text) => text.length > 0)
                    .slice(0, 3),
            };
            const stateReceipt = JSON.stringify(lastGlobalActionState);
            if (
                current.dataset.oaamRoute !== "library" ||
                current.dataset.oaamSubject !== "global" ||
                current.dataset.oaamState !== "ready" ||
                collections.length > 1 ||
                collections.some((candidate) => candidate.dataset.oaamCollectionId !== "global") ||
                globalCollections.length > 1 ||
                (globalCollections.length === 1 &&
                    (!Number.isSafeInteger(globalCollectionTotalCount) || globalCollectionTotalCount <= 0))
            ) {
                throw new Error("Provider sweep Global collection identity is inconsistent: " + stateReceipt);
            }
            if (toolbarEntries.length > 1 || emptyEntries.length > 1 ||
                (toolbarEntries.length > 0 && emptyEntries.length > 0)) {
                throw new Error("Provider sweep Global guided-import action is ambiguous: " + stateReceipt);
            }
            const candidate = toolbarEntries[0] ?? emptyEntries[0];
            if (candidate !== undefined &&
                (!(candidate instanceof HTMLButtonElement) ||
                    candidate.dataset.oaamAction !== "start-guided-import" ||
                    candidate.dataset.oaamSemanticAction !== "library.start_guided_import")) {
                throw new Error("Provider sweep Global guided-import action identity is inconsistent: " + stateReceipt);
            }
            if (globalCollections.length === 1) {
                if (emptyStatePresent || emptyEntries.length > 0) {
                    throw new Error("Provider sweep nonempty Global collection exposed an empty action: " + stateReceipt);
                }
                if (toolbarEntries[0] instanceof HTMLButtonElement && !toolbarEntries[0].disabled) {
                    globalAction = toolbarEntries[0];
                }
            } else if (emptyStatePresent) {
                if (toolbarEntries.length > 0) {
                    throw new Error("Provider sweep empty Global collection exposed a toolbar action: " + stateReceipt);
                }
                if (emptyEntries[0] instanceof HTMLButtonElement && !emptyEntries[0].disabled) {
                    globalAction = emptyEntries[0];
                }
            } else if (toolbarEntries.length > 0 || emptyEntries.length > 0) {
                throw new Error("Provider sweep Global action appeared before its collection state: " + stateReceipt);
            }
            if (!(globalAction instanceof HTMLButtonElement)) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        if (!(globalAction instanceof HTMLButtonElement)) {
            throw new Error(
                "timed out waiting for the contextual Global guided-import action: " +
                    JSON.stringify(lastGlobalActionState),
            );
        }
        globalAction.click();
    }
    const next = await waitFor(
        () => document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="locations"]'),
        "the Provider-sweep location stage",
    );
    if (!(next instanceof HTMLElement) || next.dataset.oaamTargetProjectId !== undefined) {
        throw new Error("the all-Provider sweep was incorrectly restricted to one Project");
    }
    return { status: "ready" };
})()`;

export function packagedProviderProjectSweepRepeatedIgnoredPathsScript(expectedPaths: readonly string[]): string {
    return `(async () => {
    const expectedPaths = ${JSON.stringify(expectedPaths)};
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const workspace = await waitFor(() => {
        const value = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
        return value instanceof HTMLElement && value.dataset.oaamDiscoveryActivity === "idle" ? value : false;
    }, "the repeated Provider-sweep source review");
    const restoredPaths = [];
    for (const expectedPath of expectedPaths) {
        const cards = [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
            .filter((card) => card instanceof HTMLElement && card.dataset.oaamSourcePath === expectedPath);
        if (cards.length !== 1 || !(cards[0] instanceof HTMLElement)) {
            throw new Error("the repeated scan did not return the exact ignored location: " + expectedPath);
        }
        const card = cards[0];
        if (card.dataset.oaamSourceState !== "ignored" || card.querySelector('details') !== null ||
            card.querySelector('.source-review-decisions') !== null ||
            card.querySelectorAll('[data-oaam-source-action="restore"]').length !== 1) {
            throw new Error("the repeated scan expanded or re-enabled the ignored location: " + expectedPath);
        }
        restoredPaths.push(expectedPath);
    }
    return { status: "complete", paths: restoredPaths };
})()`;
}

interface ProjectContextSubject {
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
}

export function packagedProviderProjectSweepEnterProjectContextScript(
    subject: ProjectContextSubject,
    options: {
        readonly deadlineMilliseconds?: number;
        readonly deadlineAtMillisecondsSinceEpoch?: number;
        readonly retainTerminalObservation?: boolean;
    } = {},
): string {
    const deadlineMilliseconds = options.deadlineMilliseconds ?? 120_000;
    if (!Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds < 1 || deadlineMilliseconds > 120_000)
        throw new TypeError("invalid packaged Project entry deadline");
    const deadlineAt = options.deadlineAtMillisecondsSinceEpoch ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 1)
        throw new TypeError("invalid packaged Project entry absolute deadline");
    return `(async () => {
    const expected = ${JSON.stringify(subject)};
    const deadline = Math.min(Date.now() + ${String(deadlineMilliseconds)}, ${String(deadlineAt)});
    let phase = "projects_library";
    let lastObservation;
    const accessibleLabel = (value) => (value.textContent ?? "").replace(/\\s+/gu, " ").trim() ||
        value.getAttribute("aria-label")?.trim() || value.dataset.tooltip?.trim() || value.title.trim();
    const observe = (label) => {
        const active = document.querySelector('main[data-oaam-route]');
        const library = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="projects"]');
        const rows = library instanceof HTMLElement ? [...library.querySelectorAll('.asset-tree-project[data-oaam-project-id]')]
            .filter((row) => row instanceof HTMLButtonElement && row.dataset.oaamProjectId === expected.projectId) : [];
        const actions = library instanceof HTMLElement ? [...library.querySelectorAll('[data-oaam-action="start-guided-import"]')] : [];
        return { phase, label, route: active instanceof HTMLElement ? active.dataset.oaamRoute ?? "" : "", subject: active instanceof HTMLElement ? active.dataset.oaamSubject ?? "" : "",
            libraryState: library instanceof HTMLElement ? library.dataset.oaamState ?? "" : "", exactProjectRowCount: rows.length,
            exactProjectRows: rows.slice(0, 2).map((row) => ({ projectId: row.dataset.oaamProjectId ?? "", label: accessibleLabel(row), enabled: !row.disabled })),
            importActionCount: actions.length, importActions: actions.slice(0, 2).map((action) => ({ identity: action instanceof HTMLElement ? action.dataset.oaamSemanticAction ?? action.dataset.oaamAction ?? "" : "", label: action instanceof HTMLElement ? accessibleLabel(action) : "", enabled: action instanceof HTMLButtonElement && !action.disabled })) };
    };
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            lastObservation = observe(label);
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    try {
    let library = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]');
        return value instanceof HTMLElement ? value : false;
    }, "the Projects library containing the restored Project");
    const restoredEntries = [...library.querySelectorAll('.asset-tree-project[data-oaam-project-id]')].filter((candidate) => {
        const label = candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "";
        return candidate instanceof HTMLButtonElement && candidate.dataset.oaamProjectId === expected.projectId &&
            label === expected.displayName;
    });
    if (restoredEntries.length !== 1 || !(restoredEntries[0] instanceof HTMLButtonElement) || restoredEntries[0].disabled) {
        throw new Error("the exact restored Project is not uniquely selectable");
    }
    if (library.dataset.oaamProjectId !== expected.projectId) restoredEntries[0].click();
    phase = "selected_project_library";
    library = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]');
        return value instanceof HTMLElement && value.dataset.oaamProjectId === expected.projectId ? value : false;
    }, "the explicitly selected restored Project library");
    library.style.setProperty("--oaam-left-pane-width", "224px");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const selectedRows = [...library.querySelectorAll('.asset-tree-project-item[data-selected="true"] > .asset-tree-project-row')];
    if (selectedRows.length !== 1 || !(selectedRows[0] instanceof HTMLElement)) {
        throw new Error("the exact Project has no unique selected navigation row");
    }
    const row = selectedRows[0];
    const selected = row.querySelector('.asset-tree-project[data-oaam-project-id]');
    const menu = row.querySelector('[data-oaam-action="manage-project"][data-oaam-project-id]');
    if (!(selected instanceof HTMLButtonElement) || selected.dataset.oaamProjectId !== expected.projectId ||
        !(menu instanceof HTMLButtonElement) || menu.dataset.oaamProjectId !== expected.projectId) {
        throw new Error("the selected Project navigation row changed identity");
    }
    menu.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rowBounds = row.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    const menuStyle = getComputedStyle(menu);
    const projectMenuInsideSelectedRow = menu.parentElement === row && menuBounds.left >= rowBounds.left &&
        menuBounds.right <= rowBounds.right && menuBounds.top >= rowBounds.top && menuBounds.bottom <= rowBounds.bottom;
    const tooltip = menu.dataset.tooltip?.trim() ?? "";
    const projectMenuVisibleAtMinimumWidth = document.activeElement === menu && menuStyle.visibility !== "hidden" &&
        menuStyle.display !== "none" && Number.parseFloat(menuStyle.opacity) > 0 && menuStyle.pointerEvents === "auto" &&
        menuBounds.width >= 24 && menuBounds.height >= 24 && tooltip.length > 0 && tooltip.length <= 32;
    if (!projectMenuInsideSelectedRow || !projectMenuVisibleAtMinimumWidth) {
        throw new Error("the Project management menu is clipped outside the selected narrow navigation row");
    }
    phase = "project_import_action";
    const action = await waitFor(() => {
        const current = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]');
        if (!(current instanceof HTMLElement) || current.dataset.oaamProjectId !== expected.projectId) return false;
        const actions = [...current.querySelectorAll('[data-oaam-action="start-guided-import"]')]
            .filter((button) => button instanceof HTMLButtonElement && !button.disabled);
        if (actions.length > 1) throw new Error("the empty Project has ambiguous scoped import actions");
        return actions.length === 1 && actions[0] instanceof HTMLButtonElement ? actions[0] : false;
    }, "the empty Project's unique scoped import action");
    action.click();
    phase = "guided_import_locations";
    const guided = await waitFor(() => {
        const value = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="locations"]');
        return value instanceof HTMLElement ? value : false;
    }, "the exact Project-scoped location stage");
    if (guided.dataset.oaamTargetProjectId !== expected.projectId) {
        throw new Error("the Project import route lost its exact Project identity");
    }
    return { status: "ready", projectMenuInsideSelectedRow, projectMenuVisibleAtMinimumWidth };
    } catch (error) {
        if (!${String(options.retainTerminalObservation === true)}) throw error;
        return { status: "terminal", error: error instanceof Error ? error.message : String(error), lastObservation: lastObservation ?? observe("entry") };
    }
})()`;
}

export function packagedProviderProjectSweepProjectContextReceiptScript(
    subject: ProjectContextSubject & {
        readonly projectMenuInsideSelectedRow: true;
        readonly projectMenuVisibleAtMinimumWidth: true;
        readonly selectedEnvironment: string;
        readonly probedEnvironment: string;
        readonly environmentResultStatus: "complete" | "partial" | "failed";
        readonly excludedEnvironmentCount: number;
        readonly incompatibleEnvironmentsDisabled: true;
    },
): string {
    return `(async () => {
    const expected = ${JSON.stringify(subject)};
    try {
    const workspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
    const guided = document.querySelector('main[data-oaam-route="guided_import"][data-oaam-step="sources"]');
    if (!(workspace instanceof HTMLElement) || !(guided instanceof HTMLElement) ||
        workspace.dataset.oaamDiscoveryActivity !== "idle" ||
        workspace.dataset.oaamTargetProjectId !== expected.projectId ||
        guided.dataset.oaamTargetProjectId !== expected.projectId) {
        throw new Error("the scoped source review lost its exact Project route");
    }
    const sourcePaths = [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
        .map((card) => card instanceof HTMLElement ? card.dataset.oaamSourcePath ?? "" : "")
        .filter(Boolean)
        .sort();
    if (sourcePaths.length === 0 || new Set(sourcePaths).size !== sourcePaths.length) {
        throw new Error("the scoped source review did not expose unique concrete source locations");
    }
    return {
        status: "complete",
        projectId: expected.projectId,
        displayName: expected.displayName,
        rootPath: expected.rootPath,
        projectMenuInsideSelectedRow: expected.projectMenuInsideSelectedRow,
        projectMenuVisibleAtMinimumWidth: expected.projectMenuVisibleAtMinimumWidth,
        selectedEnvironment: expected.selectedEnvironment,
        probedEnvironment: expected.probedEnvironment,
        environmentResultStatus: expected.environmentResultStatus,
        excludedEnvironmentCount: expected.excludedEnvironmentCount,
        incompatibleEnvironmentsDisabled: expected.incompatibleEnvironmentsDisabled,
        routeBoundToExactProject: true,
        sourcePaths,
    };
    } catch (error) {
        const workspace = document.querySelector('.discovery-workspace');
        const guided = document.querySelector('main[data-oaam-route="guided_import"]');
        return { status: "terminal", stage: "project_context", code: "proof_assertion_failed", lastObservation: {
            detail: String(error instanceof Error ? error.message : error).replace(/\\s+/gu, " ").trim().slice(0, 240),
            journeyStage: workspace instanceof HTMLElement ? workspace.dataset.oaamJourneyStage ?? "" : "",
            discoveryActivity: workspace instanceof HTMLElement ? workspace.dataset.oaamDiscoveryActivity ?? "" : "",
            route: guided instanceof HTMLElement ? guided.dataset.oaamRoute ?? "" : "",
            step: guided instanceof HTMLElement ? guided.dataset.oaamStep ?? "" : "",
        } };
    }
})()`;
}
