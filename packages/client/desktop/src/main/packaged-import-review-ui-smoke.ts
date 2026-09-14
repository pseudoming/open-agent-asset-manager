export type PackagedImportJourneyRoute = "onboarding" | "guided_import";

export interface PackagedImportReviewWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedImportReviewTerminalReceipt {
    readonly status: "terminal";
    readonly stage: string;
    readonly code: string;
    readonly lastObservation: Record<string, unknown>;
}

export class PackagedImportReviewTerminalError extends Error {
    public readonly proofTerminalReceipt: PackagedImportReviewTerminalReceipt;

    public constructor(receipt: PackagedImportReviewTerminalReceipt) {
        super(`packaged import review stopped at ${receipt.stage}: ${String(receipt.lastObservation.detail ?? receipt.code)}`);
        this.proofTerminalReceipt = receipt;
    }
}

function prepareAssetReviewScript(route: PackagedImportJourneyRoute, deadlineAt: number): string {
    return `(async () => {
    const deadline = Math.min(Date.now() + 15000, ${String(deadlineAt)});
    const route = ${JSON.stringify(route)};
    let phase = "source_review";
    const bounded = (value, limit = 240) => String(value ?? "").replace(/\\s+/gu, " ").trim().slice(0, limit);
    const observe = (detail = "") => {
        const journey = document.querySelector('main[data-oaam-route="' + route + '"]');
        const workspace = document.querySelector('.discovery-workspace');
        return {
            phase,
            detail: bounded(detail),
            route: journey instanceof HTMLElement ? bounded(journey.dataset.oaamRoute) : "",
            step: journey instanceof HTMLElement ? bounded(journey.dataset.oaamStep) : "",
            discoveryActivity: workspace instanceof HTMLElement ? bounded(workspace.dataset.oaamDiscoveryActivity) : "",
            candidateCount: journey instanceof HTMLElement ? journey.querySelectorAll('[data-oaam-import-candidate-id]').length : 0,
            importActionCount: journey instanceof HTMLElement ? journey.querySelectorAll('[data-oaam-import-commit]').length : 0,
        };
    };
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    try {
    const workspace = await waitFor(
        () => document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]'),
        "the selected source review",
    );
    const continueSources = workspace.querySelector('[data-oaam-journey-continue="sources"]');
    if (!(continueSources instanceof HTMLButtonElement)) {
        throw new Error("source-stage Asset review action is unavailable");
    }
    const skippedProjectKeys = new Set();
    for (let index = 0; index < 100; index += 1) {
        const projectResolution = await waitFor(() => {
            if (!continueSources.disabled) return { status: "resolved" };
            const skipProject = workspace.querySelector('[data-oaam-project-decision="skip"]:not([disabled])');
            return skipProject instanceof HTMLButtonElement ? { status: "skip", skipProject } : false;
        }, "an actionable or resolved Project suggestion");
        if (projectResolution.status === "resolved") break;
        const skipProject = projectResolution.skipProject;
        const project = skipProject.closest("[data-oaam-project-proposal-key]");
        const projectKey = project instanceof HTMLElement ? project.dataset.oaamProjectProposalKey : undefined;
        if (projectKey === undefined || projectKey.length === 0 || skippedProjectKeys.has(projectKey)) {
            throw new Error("packaged Asset review cannot identify one pending Project suggestion");
        }
        skippedProjectKeys.add(projectKey);
        skipProject.click();
        phase = "project_resolution";
        const skipOutcome = await waitFor(() => {
            if (!skipProject.isConnected || skipProject.disabled) return { status: "resolved" };
            const confirm = project.querySelector('[data-oaam-source-action="confirm-ignore"]');
            return confirm instanceof HTMLButtonElement ? { status: "confirmation", confirm } : false;
        }, "the Project source ignore confirmation");
        if (skipOutcome.status === "confirmation") skipOutcome.confirm.click();
        await waitFor(
            () => !skipProject.isConnected || skipProject.disabled,
            "the explicit Project suggestion skip",
        );
    }
    if (workspace.querySelector('[data-oaam-project-decision="skip"]:not([disabled])') !== null) {
        throw new Error("packaged Asset review exceeded the bounded Project suggestion count");
    }
    await waitFor(() => !continueSources.disabled, "resolved Project suggestions");
    continueSources.click();
    phase = "candidate_review";
    const journey = await waitFor(
        () => document.querySelector('main[data-oaam-route="' + route + '"][data-oaam-step="assets"]'),
        "the Asset review stage",
    );
    const readOutcome = await waitFor(() => {
        const values = [...journey.querySelectorAll("[data-oaam-import-candidate-id]")];
        if (values.length > 0) return { status: "candidates", values };
        const attention = journey.querySelector("[data-oaam-import-read-attention]");
        if (attention instanceof HTMLElement) {
            return {
                status: "read_attention",
                issues: [...attention.querySelectorAll("[data-oaam-import-read-issue]")].map((issue) => ({
                    status: issue.getAttribute("data-oaam-import-read-issue") ?? "",
                    text: (issue.textContent ?? "").replace(/\\s+/gu, " ").trim(),
                })),
            };
        }
        if (journey.dataset.oaamStep === "complete") {
            return {
                status: "completed_without_candidates",
                completion: journey.dataset.oaamCompletion ?? "",
            };
        }
        const alert = journey.querySelector('[role="alert"]');
        return alert instanceof HTMLElement
            ? { status: "failed", text: (alert.textContent ?? "").replace(/\\s+/gu, " ").trim() }
            : false;
    }, "the deterministic imported Asset read outcome");
    if (readOutcome.status !== "candidates") {
        throw new Error("the selected source did not reach Asset review; outcome=" + JSON.stringify(readOutcome));
    }
    const candidates = readOutcome.values;
    const review = journey.querySelector("[data-oaam-import-navigation-owner='journey']");
    const skip = journey.querySelector("[data-oaam-journey-skip-import]");
    const commit = journey.querySelector("[data-oaam-import-commit]");
    if (
        !(review instanceof HTMLElement) ||
        review.querySelector("[data-oaam-import-review-close]") !== null ||
        !(skip instanceof HTMLButtonElement) ||
        !skip.classList.contains("library-secondary-button") ||
        !(commit instanceof HTMLButtonElement) ||
        commit.classList.contains("library-secondary-button")
    ) {
        throw new Error("Asset review does not have one journey navigation owner and one primary import action");
    }
    if (candidates.length !== 1) {
        throw new Error("the exact selected source did not produce one deterministic Asset candidate");
    }
    const candidate = candidates[0];
    const choice = candidate.querySelector('input[type="checkbox"]');
    if (!(choice instanceof HTMLInputElement) || choice.disabled) {
        throw new Error(
            "the deterministic Asset candidate is not selectable; candidate=" +
            JSON.stringify({
                attributes: Object.fromEntries([...candidate.attributes].map((attribute) => [
                    attribute.name,
                    attribute.value,
                ])),
                choice: choice instanceof HTMLInputElement
                    ? { checked: choice.checked, disabled: choice.disabled }
                    : null,
                text: (candidate.textContent ?? "").replace(/\\s+/gu, " ").trim(),
            }),
        );
    }
    if (!choice.checked) {
        throw new Error("the fresh Asset candidate was not selected by default");
    }
    if (candidate.querySelector('.workbench-select-trigger[role="combobox"]') !== null) {
        throw new Error("a fresh Asset candidate exposed a destination choice without an existing Version target");
    }
    await waitFor(() => {
        const action = journey.querySelector("[data-oaam-import-commit]");
        return action instanceof HTMLButtonElement && !action.disabled;
    }, "the reviewed Asset import action");
    return { status: "complete", candidateCount: candidates.length };
    } catch (error) {
        return { status: "terminal", stage: phase, code: "proof_assertion_failed", lastObservation: observe(error instanceof Error ? error.message : error) };
    }
})()`;
}

function importAssetScript(route: PackagedImportJourneyRoute, deadlineAt: number, expectedCandidateId: string): string {
    return `(async () => {
    const deadline = ${String(deadlineAt)};
    const route = ${JSON.stringify(route)};
    const expectedCandidateId = ${JSON.stringify(expectedCandidateId)};
    let phase = "candidate_validation";
    const bounded = (value, limit = 240) => String(value ?? "").replace(/\\s+/gu, " ").trim().slice(0, limit);
    const observe = (detail = "") => {
        const journey = document.querySelector('main[data-oaam-route="' + route + '"]');
        const candidates = journey instanceof HTMLElement ? [...journey.querySelectorAll('[data-oaam-import-candidate-id]')] : [];
        return {
            phase,
            detail: bounded(detail),
            route: journey instanceof HTMLElement ? bounded(journey.dataset.oaamRoute) : "",
            step: journey instanceof HTMLElement ? bounded(journey.dataset.oaamStep) : "",
            candidateIds: candidates.slice(0, 2).map((candidate) => bounded(candidate.getAttribute('data-oaam-import-candidate-id'))),
            importActionCount: journey instanceof HTMLElement ? journey.querySelectorAll('[data-oaam-import-commit]').length : 0,
        };
    };
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    try {
    const journey = await waitFor(
        () => document.querySelector('main[data-oaam-route="' + route + '"][data-oaam-step="assets"]'),
        "the Asset review stage",
    );
    const candidates = [...journey.querySelectorAll("[data-oaam-import-candidate-id]")];
    if (candidates.length !== 1) throw new Error("Asset import lost its deterministic candidate");
    const candidate = candidates[0];
    const choice = candidate.querySelector('input[type="checkbox"]');
    const candidateId = candidate.getAttribute("data-oaam-import-candidate-id") ?? "";
    if (!(choice instanceof HTMLInputElement) || choice.disabled || !choice.checked ||
        (expectedCandidateId.length > 0 && candidateId !== expectedCandidateId)) {
        throw new Error("Asset import lost the reviewed candidate identity or selection");
    }
    const importAction = await waitFor(() => {
        const actions = [...journey.querySelectorAll("[data-oaam-import-commit]")];
        if (actions.length > 1) throw new Error("Asset import has ambiguous commit actions");
        const action = actions[0];
        return action instanceof HTMLButtonElement && !action.disabled ? action : false;
    }, "the reviewed Asset import action");
    phase = "import_action";
    importAction.click();
    phase = "import_completion";
    await waitFor(() => journey.dataset.oaamStep === "complete", "the completed import journey");
    const results = [...journey.querySelectorAll("[data-oaam-import-result-status]")];
    if (results.length !== 1 || results[0].dataset.oaamImportResultStatus !== "complete") {
        throw new Error("the reviewed Asset import did not complete exactly once");
    }
    return { status: "complete", importedCandidateCount: results.length };
    } catch (error) {
        return { status: "terminal", stage: phase, code: "proof_assertion_failed", lastObservation: observe(error instanceof Error ? error.message : error) };
    }
})()`;
}

function terminalReceipt(value: unknown): PackagedImportReviewTerminalReceipt | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== "code,lastObservation,stage,status" ||
        record.status !== "terminal" ||
        typeof record.stage !== "string" ||
        record.stage.length === 0 ||
        typeof record.code !== "string" ||
        record.code.length === 0 ||
        typeof record.lastObservation !== "object" ||
        record.lastObservation === null ||
        Array.isArray(record.lastObservation)
    )
        return undefined;
    return record as unknown as PackagedImportReviewTerminalReceipt;
}

function parseCountProof(value: unknown, key: "candidateCount" | "importedCandidateCount"): 1 {
    const terminal = terminalReceipt(value);
    if (terminal !== undefined) throw new PackagedImportReviewTerminalError(terminal);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`invalid packaged ${key} proof`);
    }
    const record = value as Record<string, unknown>;
    const actual = Object.keys(record).sort();
    const expected = [key, "status"].sort();
    if (
        actual.length !== expected.length ||
        actual.some((name, index) => name !== expected[index]) ||
        record.status !== "complete" ||
        record[key] !== 1
    ) {
        throw new TypeError(`invalid packaged ${key} proof`);
    }
    return 1;
}

export async function preparePackagedAssetReview(
    webContents: PackagedImportReviewWebContents,
    route: PackagedImportJourneyRoute,
    deadlineAt = Number.MAX_SAFE_INTEGER,
): Promise<1> {
    return parseCountProof(await webContents.executeJavaScript(prepareAssetReviewScript(route, deadlineAt)), "candidateCount");
}

export async function importPackagedAsset(
    webContents: PackagedImportReviewWebContents,
    route: PackagedImportJourneyRoute,
    deadlineAt = Number.MAX_SAFE_INTEGER,
    expectedCandidateId = "",
): Promise<1> {
    const absoluteDeadline = deadlineAt === Number.MAX_SAFE_INTEGER ? Date.now() + 15_000 : deadlineAt;
    return parseCountProof(
        await webContents.executeJavaScript(importAssetScript(route, absoluteDeadline, expectedCandidateId)),
        "importedCandidateCount",
    );
}
