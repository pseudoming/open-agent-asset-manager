export const ENTER_PROJECTS_LIBRARY_SOURCE = `
    const enterProjectsLibrary = async (label) => {
        const entry = await waitFor(() => {
            const library = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
            const sources = document.querySelector('main[data-oaam-route="sources"][data-oaam-state="ready"]');
            return (library ?? sources) instanceof HTMLElement ? (library ?? sources) : false;
        }, label + " entry");
        if (entry.dataset.oaamRoute === "sources") {
            const back = entry.querySelector('.source-library-back');
            if (!(back instanceof HTMLButtonElement) || back.disabled) throw new Error(label + " cannot leave Sources");
            back.click();
        }
        let library = await waitFor(() => {
            const value = document.querySelector('main[data-oaam-route="library"][data-oaam-state="ready"]');
            return value instanceof HTMLElement ? value : false;
        }, label + " library");
        if (library.dataset.oaamSubject !== "projects") {
            const projects = library.querySelector('[data-oaam-subject-choice="projects"]');
            if (!(projects instanceof HTMLButtonElement) || projects.disabled) throw new Error(label + " cannot choose Projects");
            projects.click();
        }
        return waitFor(() => {
            const value = document.querySelector('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]');
            return value instanceof HTMLElement ? value : false;
        }, label + " Projects library");
    };`;

export const ENTER_GENERAL_SETTINGS_SOURCE = `
    const enterGeneralSettings = async (label) => {
        let settings = document.querySelector('main[data-oaam-route="settings"][data-oaam-state="ready"]');
        if (!(settings instanceof HTMLElement)) {
            const library = await enterProjectsLibrary(label);
            const waitLabel = label + " Settings footer control";
            let lastObservation = null;
            let entry;
            try {
                entry = await waitFor(() => {
                    const alert = library.querySelector('.library-state-panel[role="alert"]');
                    const controls = [...document.querySelectorAll('.library-settings-button')];
                    lastObservation = {
                        route: library.dataset.oaamRoute ?? null, subject: library.dataset.oaamSubject ?? null,
                        state: library.dataset.oaamState ?? null, footerRendered: library.querySelector('.library-sidebar-footer') !== null,
                        controlCount: controls.length, alert: alert?.textContent?.trim() || null,
                    };
                    if (!library.isConnected || library.dataset.oaamRoute !== "library" || library.dataset.oaamSubject !== "projects")
                        throw new Error(label + " Project library identity changed");
                    if (library.dataset.oaamState === "failed" || alert instanceof HTMLElement)
                        throw new Error(label + " Project library failed: " + (alert?.textContent?.trim() || "no ordinary detail"));
                    if (controls.length > 1) throw new Error(label + " Settings footer control is ambiguous");
                    if (controls.length === 0) {
                        if (library.querySelector('.library-sidebar-footer') !== null)
                            throw new Error(label + " rendered Settings footer has no control");
                        return false;
                    }
                    const control = controls[0];
                    if (!(control instanceof HTMLButtonElement) || control.closest('main[data-oaam-route]') !== library)
                        throw new Error(label + " Settings footer control belongs to the wrong route or subject");
                    if (control.dataset.oaamSemanticAction !== "library.open_settings" ||
                        control.dataset.oaamSemanticEntry !== "library.settings.footer")
                        throw new Error(label + " Settings footer control has the wrong semantic identity");
                    if (control.disabled) throw new Error(label + " Settings footer control is disabled");
                    return control;
                }, waitLabel);
            } catch (error) {
                if (String(error) === "Error: timed out waiting for " + waitLabel)
                    throw new Error(label + " cannot open Settings: terminal=" + JSON.stringify(lastObservation));
                throw error;
            }
            entry.click();
            settings = await waitFor(() => {
                const value = document.querySelector('main[data-oaam-route="settings"][data-oaam-state="ready"]');
                return value instanceof HTMLElement ? value : false;
            }, label + " Settings");
        }
        if (settings.dataset.settingsCategory !== "general") {
            const general = settings.querySelector('[data-oaam-settings-category="general"]');
            if (!(general instanceof HTMLButtonElement) || general.disabled) throw new Error(label + " cannot choose General Settings");
            general.click();
            settings = await waitFor(() => {
                const value = document.querySelector('main[data-oaam-route="settings"][data-oaam-state="ready"][data-settings-category="general"]');
                return value instanceof HTMLElement ? value : false;
            }, label + " General Settings");
        }
        return settings;
    };
    const leaveSettingsForProjectsLibrary = async (label) => {
        const binding = await waitFor(() => {
            const settingsRoutes = [...document.querySelectorAll('main[data-oaam-route="settings"]')];
            if (settingsRoutes.length > 1) throw new Error(label + " Settings route is ambiguous");
            const settings = settingsRoutes[0];
            if (!(settings instanceof HTMLElement)) throw new Error(label + " has no current Settings route");
            const alert = settings.querySelector('[role="alert"]');
            if (settings.dataset.oaamState === "failed" || alert instanceof HTMLElement)
                throw new Error(label + " Settings failed: " + (alert?.textContent?.trim() || "no ordinary detail"));
            if (settings.dataset.oaamState !== "ready") return false;
            const controls = [...settings.querySelectorAll('.settings-return-button')];
            if (controls.length > 1) throw new Error(label + " Settings return control is ambiguous");
            if (controls.length === 0) {
                const foreign = [...document.querySelectorAll('.settings-return-button')]
                    .some((control) => !settings.contains(control));
                if (foreign) throw new Error(label + " Settings return control belongs to the wrong route");
                throw new Error(label + " Settings return control is missing");
            }
            const control = controls[0];
            if (!(control instanceof HTMLButtonElement) || control.closest('main[data-oaam-route]') !== settings)
                throw new Error(label + " Settings return control belongs to the wrong route");
            if (control.disabled) throw new Error(label + " Settings return control is disabled");
            return { settings, control, priorLibraries: new Set(document.querySelectorAll('main[data-oaam-route="library"]')) };
        }, label + " Settings return control");
        binding.control.click();
        return waitFor(() => {
            const settingsRoutes = [...document.querySelectorAll('main[data-oaam-route="settings"]')];
            if (settingsRoutes.length > 1) throw new Error(label + " Settings route is ambiguous after return");
            if (settingsRoutes.length === 1) return false;
            const routes = [...document.querySelectorAll('main[data-oaam-route]')]
                .filter((route) => route instanceof HTMLElement && !binding.priorLibraries.has(route));
            if (routes.length > 1) throw new Error(label + " returned route is ambiguous");
            const route = routes[0];
            if (!(route instanceof HTMLElement)) return false;
            if (route.dataset.oaamRoute !== "library" || route.dataset.oaamSubject !== "projects")
                throw new Error(label + " returned to the wrong route or subject");
            if (route.dataset.oaamState === "failed") throw new Error(label + " returned Project library failed");
            return route.dataset.oaamState === "ready" ? route : false;
        }, label + " fresh Projects library");
    };`;

export const PROJECT_RESTORE_SHARED_SOURCE = `
    const assertRestoreSubject = (dialog, expected, label) => {
        const dialogs = [...document.querySelectorAll('[data-oaam-dialog="project_lifecycle"]')];
        const values = [...dialog.querySelectorAll('.project-lifecycle-subject dd')].map((entry) => entry.textContent?.trim() ?? "");
        if (dialogs.length !== 1 || dialogs[0] !== dialog || values.length !== 2 ||
            values[0] !== expected.displayName || values[1] !== expected.rootPath) {
            throw new Error(label + " changed the exact Project identity");
        }
    };
    const openRestoreReview = async (dialog, expected, label) => {
        assertRestoreSubject(dialog, expected, label);
        const actions = [...dialog.querySelectorAll('[data-oaam-project-action="restore"]')]
            .filter((entry) => entry instanceof HTMLButtonElement && !entry.disabled);
        if (actions.length !== 1) throw new Error(label + " restore action is ambiguous");
        actions[0].click();
        const review = await waitFor(() => dialog.querySelector('.project-lifecycle-review[data-oaam-project-lifecycle-action="restore"]'), label + " review");
        assertRestoreSubject(dialog, expected, label);
        return review;
    };
    const commitRestoreReview = async (dialog, expected, label) => {
        assertRestoreSubject(dialog, expected, label);
        const review = dialog.querySelector('.project-lifecycle-review[data-oaam-project-lifecycle-action="restore"]');
        const commits = review instanceof HTMLElement
            ? [...review.querySelectorAll('.detail-actions button[data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.010"]')]
                .filter((entry) => entry instanceof HTMLButtonElement && !entry.disabled)
            : [];
        if (review?.querySelector('.project-lifecycle-backup-gate') !== null || commits.length !== 1) {
            throw new Error(label + " commit is ambiguous or requested an unrelated backup choice");
        }
        commits[0].click();
        await waitFor(() => document.querySelector('[data-oaam-dialog="project_lifecycle"]') === null, label + " commit");
    };
    const currentProjectsLibrary = (expected, label) => {
        const libraries = [...document.querySelectorAll('main[data-oaam-route="library"][data-oaam-subject="projects"][data-oaam-state="ready"]')];
        if (libraries.length > 1) throw new Error(label + " Projects library is ambiguous");
        const library = libraries[0];
        if (!(library instanceof HTMLElement)) return false;
        if (typeof expected.selectedProjectId === "string" && library.dataset.oaamProjectId !== expected.selectedProjectId)
            throw new Error(label + " did not preserve the selected Project");
        return library;
    };
    const verifyRestoredProject = async (expected, label) => {
        await leaveSettingsForProjectsLibrary(label);
        await waitFor(() => {
            const library = currentProjectsLibrary(expected, label);
            if (!library) return false;
            const rows = [...library.querySelectorAll('.asset-tree-project[data-oaam-project-id]')];
            const candidates = rows.filter((candidate) => candidate.dataset.oaamProjectId === expected.projectId ||
                candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() === expected.displayName);
            if (candidates.length > 1) throw new Error(label + " active Project is ambiguous");
            if (candidates.length === 0) return false;
            const candidate = candidates[0];
            const name = candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "";
            if (!(candidate instanceof HTMLButtonElement) || candidate.dataset.oaamProjectId !== expected.projectId ||
                name !== expected.displayName) throw new Error(label + " active Project identity changed");
            return candidate;
        }, label + " exact active Project");
        const settings = await enterGeneralSettings(label);
        await waitFor(() => {
            const panel = settings.querySelector('.retained-project-settings');
            if (!(panel instanceof HTMLElement) || panel.querySelector('[aria-busy="true"]') !== null) return false;
            const retained = [...panel.querySelectorAll('li[data-oaam-project-id]')].filter((row) =>
                row.dataset.oaamProjectId === expected.projectId || row.querySelector('strong')?.textContent?.trim() === expected.displayName ||
                row.querySelector('small')?.textContent?.trim() === expected.rootPath);
            return retained.length === 0;
        }, label + " removed retained history");
        await leaveSettingsForProjectsLibrary(label);
        const manage = await waitFor(() => {
            const library = currentProjectsLibrary(expected, label);
            if (!library) return false;
            const rows = [...library.querySelectorAll('.asset-tree-project[data-oaam-project-id]')];
            const candidates = rows.filter((candidate) => candidate.dataset.oaamProjectId === expected.projectId ||
                candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() === expected.displayName);
            if (candidates.length > 1) throw new Error(label + " active Project is ambiguous");
            if (candidates.length === 0) return false;
            const candidate = candidates[0];
            const name = candidate.querySelector('.asset-tree-project-label > span')?.textContent?.trim() ?? "";
            if (!(candidate instanceof HTMLButtonElement) || candidate.dataset.oaamProjectId !== expected.projectId ||
                name !== expected.displayName) throw new Error(label + " active Project identity changed");
            const matches = [...library.querySelectorAll('[data-oaam-action="manage-project"][data-oaam-project-id]')]
                .filter((entry) => entry instanceof HTMLButtonElement && entry.dataset.oaamProjectId === expected.projectId && !entry.disabled);
            if (matches.length > 1) throw new Error(label + " active Project action is ambiguous");
            return matches[0] ?? false;
        }, label + " active Project action");
        manage.click();
        const reopened = await waitFor(() => document.querySelector('[data-oaam-dialog="project_lifecycle"]'), label + " reopen dialog");
        assertRestoreSubject(reopened, expected, label + " reopened Project");
        reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await waitFor(() => document.querySelector('[data-oaam-dialog="project_lifecycle"]') === null, label + " closed reopen dialog");
        return true;
    };`;

const RETAINED_SETTINGS_SOURCE = `
    const findRetainedRow = async (expected, label) => {
        const settings = await enterGeneralSettings(label);
        const panel = await waitFor(() => {
            const value = settings.querySelector('.retained-project-settings');
            const failed = value?.querySelector('[role="alert"]');
            if (failed instanceof HTMLElement) throw new Error(label + " failed: " + (failed.textContent?.trim() || "no ordinary detail"));
            return value instanceof HTMLElement && value.querySelector('[aria-busy="true"]') === null ? value : false;
        }, label + " Project management");
        const details = panel.querySelector('details.retained-projects');
        if (!(details instanceof HTMLDetailsElement)) throw new Error(label + " has no retained Project history");
        if (!details.open) details.querySelector('summary')?.click();
        await waitFor(() => details.open, label + " expanded history");
        const candidates = [...details.querySelectorAll('li[data-oaam-project-id]')].filter((row) =>
            row.dataset.oaamProjectId === expected.projectId ||
            row.querySelector('strong')?.textContent?.trim() === expected.displayName ||
            row.querySelector('small')?.textContent?.trim() === expected.rootPath);
        if (candidates.length !== 1) throw new Error(label + " retained Project row is missing or ambiguous");
        const row = candidates[0];
        if (row.dataset.oaamProjectId !== expected.projectId || row.querySelector('strong')?.textContent?.trim() !== expected.displayName ||
            row.querySelector('small')?.textContent?.trim() !== expected.rootPath) throw new Error(label + " retained Project identity changed");
        return row;
    };`;

export function retainedSettingsReadyScript(subject: unknown): string {
    return `(async () => { const expected = ${JSON.stringify(subject)}; const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => { while (Date.now() < deadline) { const value = predicate(); if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error("timed out waiting for " + label); };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}${ENTER_GENERAL_SETTINGS_SOURCE}${RETAINED_SETTINGS_SOURCE}
    await findRetainedRow(expected, "restore target");
    return { status: "retained_ready", projectId: expected.projectId, displayName: expected.displayName, rootPath: expected.rootPath,
        selectedProjectId: expected.selectedProjectId }; })()`;
}

export function openSettingsRestoreReviewScript(subject: unknown): string {
    return `(async () => { const expected = ${JSON.stringify(subject)}; const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => { while (Date.now() < deadline) { const value = predicate(); if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error("timed out waiting for " + label); };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}${ENTER_GENERAL_SETTINGS_SOURCE}${RETAINED_SETTINGS_SOURCE}${PROJECT_RESTORE_SHARED_SOURCE}
    const row = await findRetainedRow(expected, "restore target");
    const actions = [...row.querySelectorAll('button[data-oaam-interaction-entry="features.project-library.retained_project_settings.002"]')]
        .filter((entry) => entry instanceof HTMLButtonElement && !entry.disabled);
    if (actions.length !== 1) throw new Error("restore target action is ambiguous");
    actions[0].click();
    const dialog = await waitFor(() => document.querySelector('[data-oaam-dialog="project_lifecycle"]'), "restore target dialog");
    await openRestoreReview(dialog, expected, "restore target");
    return { status: "review_ready", projectId: expected.projectId, displayName: expected.displayName, rootPath: expected.rootPath,
        selectedProjectId: expected.selectedProjectId }; })()`;
}

export function commitSettingsRestoreScript(subject: unknown): string {
    return `(async () => { const expected = ${JSON.stringify(subject)}; const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => { while (Date.now() < deadline) { const value = predicate(); if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error("timed out waiting for " + label); };
    ${ENTER_PROJECTS_LIBRARY_SOURCE}${ENTER_GENERAL_SETTINGS_SOURCE}${PROJECT_RESTORE_SHARED_SOURCE}
    const dialog = document.querySelector('[data-oaam-dialog="project_lifecycle"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("restore target review disappeared before commit");
    await commitRestoreReview(dialog, expected, "restore target");
    await verifyRestoredProject(expected, "restored Project");
    return { status: "complete", projectId: expected.projectId, displayName: expected.displayName, rootPath: expected.rootPath,
        selectedProjectId: expected.selectedProjectId }; })()`;
}
