export type PackagedProjectRegistrationTimelineState =
    | "poll_started"
    | "source_review_visible"
    | "source_scan_in_progress"
    | "awaiting_actionable_project"
    | "actionable_project_ready"
    | "dialog_ready"
    | "terminal_deadline_exceeded"
    | "terminal_dialog_identity_invalid"
    | "terminal_source_identity_invalid"
    | "terminal_source_probe_failed"
    | "terminal_source_review_replaced";

export interface PackagedProjectRegistrationTimelineEntry {
    readonly sequence: number;
    readonly state: PackagedProjectRegistrationTimelineState;
    readonly observedAt: number;
    readonly elapsedMilliseconds: number;
}

export interface PackagedProjectRegistrationReady {
    readonly status: "ready";
    readonly proposalKey: string;
    readonly sourcePath: string;
    readonly initialDisplayName: string;
    readonly submittedDisplayName: string;
    readonly matchedSourceCard: true;
    readonly dialogId: "discovery_project_registration";
    readonly timeline: readonly PackagedProjectRegistrationTimelineEntry[];
}

export interface PackagedProjectRegistrationProof {
    readonly status: "complete";
    readonly proposalKey: string;
    readonly sourcePath: string;
    readonly initialDisplayName: string;
    readonly submittedDisplayName: string;
    readonly matchedSourceCard: true;
    readonly dialogId: "discovery_project_registration";
    readonly dialogClosed: true;
    readonly proposalResolved: true;
    readonly sourceDestination: "project";
    readonly sourceReviewTimeline: readonly PackagedProjectRegistrationTimelineEntry[];
}

export interface PackagedProjectRegistrationWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const TIMELINE_STATES = new Set<PackagedProjectRegistrationTimelineState>([
    "poll_started",
    "source_review_visible",
    "source_scan_in_progress",
    "awaiting_actionable_project",
    "actionable_project_ready",
    "dialog_ready",
    "terminal_deadline_exceeded",
    "terminal_dialog_identity_invalid",
    "terminal_source_identity_invalid",
    "terminal_source_probe_failed",
    "terminal_source_review_replaced",
]);

function parseTimeline(value: unknown, terminalState: PackagedProjectRegistrationTimelineState) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 16) {
        throw new TypeError("invalid packaged Project-registration timeline");
    }
    let startedAt: number | undefined;
    let priorObservedAt = -1;
    let priorElapsed = -1;
    const timeline = [...value].map((entry, sequence): PackagedProjectRegistrationTimelineEntry => {
        if (
            !exactRecord(entry, ["elapsedMilliseconds", "observedAt", "sequence", "state"]) ||
            entry.sequence !== sequence ||
            typeof entry.state !== "string" ||
            !TIMELINE_STATES.has(entry.state as PackagedProjectRegistrationTimelineState) ||
            !Number.isSafeInteger(entry.observedAt) ||
            (entry.observedAt as number) < 0 ||
            !Number.isSafeInteger(entry.elapsedMilliseconds) ||
            (entry.elapsedMilliseconds as number) < 0 ||
            (entry.observedAt as number) < priorObservedAt ||
            (entry.elapsedMilliseconds as number) < priorElapsed
        ) {
            throw new TypeError("invalid packaged Project-registration timeline");
        }
        startedAt ??= (entry.observedAt as number) - (entry.elapsedMilliseconds as number);
        if ((entry.observedAt as number) - (entry.elapsedMilliseconds as number) !== startedAt) {
            throw new TypeError("invalid packaged Project-registration timeline clock");
        }
        priorObservedAt = entry.observedAt as number;
        priorElapsed = entry.elapsedMilliseconds as number;
        return Object.freeze({
            sequence,
            state: entry.state as PackagedProjectRegistrationTimelineState,
            observedAt: entry.observedAt as number,
            elapsedMilliseconds: entry.elapsedMilliseconds as number,
        });
    });
    if (timeline[0]?.state !== "poll_started" || timeline.at(-1)?.state !== terminalState) {
        throw new TypeError("invalid packaged Project-registration timeline boundary");
    }
    return Object.freeze(timeline);
}

function parseReady(value: unknown): PackagedProjectRegistrationReady {
    if (
        !exactRecord(value, [
            "dialogId",
            "initialDisplayName",
            "matchedSourceCard",
            "proposalKey",
            "sourcePath",
            "status",
            "submittedDisplayName",
            "timeline",
        ]) ||
        value.status !== "ready" ||
        value.dialogId !== "discovery_project_registration" ||
        value.matchedSourceCard !== true ||
        typeof value.proposalKey !== "string" ||
        value.proposalKey.length === 0 ||
        typeof value.sourcePath !== "string" ||
        value.sourcePath.length === 0 ||
        typeof value.initialDisplayName !== "string" ||
        value.initialDisplayName.length === 0 ||
        typeof value.submittedDisplayName !== "string" ||
        value.submittedDisplayName.length === 0 ||
        value.initialDisplayName === value.submittedDisplayName
    ) {
        throw new TypeError("invalid packaged Project-registration ready proof");
    }
    return Object.freeze({
        ...(value as unknown as Omit<PackagedProjectRegistrationReady, "timeline">),
        timeline: parseTimeline(value.timeline, "dialog_ready"),
    });
}

function parseComplete(value: unknown): PackagedProjectRegistrationProof {
    if (
        !exactRecord(value, [
            "dialogClosed",
            "dialogId",
            "initialDisplayName",
            "matchedSourceCard",
            "proposalKey",
            "proposalResolved",
            "sourceDestination",
            "sourcePath",
            "status",
            "submittedDisplayName",
            "sourceReviewTimeline",
        ]) ||
        value.status !== "complete" ||
        value.dialogId !== "discovery_project_registration" ||
        value.matchedSourceCard !== true ||
        value.dialogClosed !== true ||
        value.proposalResolved !== true ||
        value.sourceDestination !== "project" ||
        typeof value.proposalKey !== "string" ||
        value.proposalKey.length === 0 ||
        typeof value.sourcePath !== "string" ||
        value.sourcePath.length === 0 ||
        typeof value.initialDisplayName !== "string" ||
        value.initialDisplayName.length === 0 ||
        typeof value.submittedDisplayName !== "string" ||
        value.submittedDisplayName.length === 0
    ) {
        throw new TypeError("invalid packaged Project-registration completion proof");
    }
    return Object.freeze({
        ...(value as unknown as Omit<PackagedProjectRegistrationProof, "sourceReviewTimeline">),
        sourceReviewTimeline: parseTimeline(value.sourceReviewTimeline, "dialog_ready"),
    });
}

function openProjectRegistrationScript(deadlineMilliseconds: number, pollIntervalMilliseconds: number): string {
    return `(async () => {
    const startedAt = Date.now();
    const deadline = startedAt + ${String(deadlineMilliseconds)};
    const pollIntervalMilliseconds = ${String(pollIntervalMilliseconds)};
    const timeline = [];
    const observe = (state) => {
        if (timeline.at(-1)?.state === state) return;
        const observedAt = Date.now();
        timeline.push({ sequence: timeline.length, state, observedAt, elapsedMilliseconds: observedAt - startedAt });
    };
    const terminal = (terminalState, detail) => {
        observe("terminal_" + terminalState);
        return { status: "terminal", terminalState, detail, timeline };
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
    observe("poll_started");
    let workspace;
    while (Date.now() < deadline) {
        const candidate = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
        if (candidate instanceof HTMLElement) {
            workspace = candidate;
            observe("source_review_visible");
            break;
        }
        await pause();
    }
    if (!(workspace instanceof HTMLElement)) {
        return terminal("deadline_exceeded", "source_review_not_visible");
    }
    let selected;
    while (Date.now() < deadline) {
        if (!workspace.isConnected || workspace.dataset.oaamJourneyStage !== "sources") {
            return terminal("source_review_replaced", "source_review_identity_changed");
        }
        const candidates = [...workspace.querySelectorAll(
            '.source-review-card[data-oaam-source-path] [data-oaam-project-decision="add"]:not([disabled])',
        )].map((button) => ({
            button,
            card: button.closest('.source-review-card[data-oaam-source-path]'),
        })).filter((entry) => entry.button instanceof HTMLButtonElement && entry.card instanceof HTMLElement)
            .sort((left, right) =>
                (left.card.dataset.oaamSourcePath ?? "").localeCompare(right.card.dataset.oaamSourcePath ?? ""),
            );
        selected = candidates[0];
        if (selected !== undefined) {
            observe("actionable_project_ready");
            break;
        }
        let resultStatuses = [];
        try {
            const parsed = JSON.parse(workspace.dataset.oaamEnvironmentResultStatuses ?? "[]");
            if (Array.isArray(parsed)) resultStatuses = parsed.map((entry) => Array.isArray(entry) ? entry[1] : entry);
        } catch {}
        const activity = workspace.dataset.oaamDiscoveryActivity ?? "unknown";
        if (activity === "idle" && resultStatuses.length > 0 && resultStatuses.every((status) => status === "failed")) {
            return terminal("source_probe_failed", JSON.stringify({ activity, resultStatuses }));
        }
        observe(activity === "probing" ? "source_scan_in_progress" : "awaiting_actionable_project");
        await pause();
    }
    if (selected === undefined) return terminal("deadline_exceeded", "actionable_project_not_visible");
    const proposal = selected.button.closest('[data-oaam-project-proposal-key]');
    const proposalKey = proposal instanceof HTMLElement ? proposal.dataset.oaamProjectProposalKey ?? "" : "";
    const sourcePath = selected.card.dataset.oaamSourcePath ?? "";
    if (proposalKey.length === 0 || sourcePath.length === 0) {
        return terminal("source_identity_invalid", "actionable_project_lost_exact_identity");
    }
    selected.button.click();
    let dialog;
    while (Date.now() < deadline) {
        const candidate = document.querySelector('[data-oaam-dialog="discovery_project_registration"]');
        if (candidate instanceof HTMLElement) {
            dialog = candidate;
            break;
        }
        await pause();
    }
    if (!(dialog instanceof HTMLElement)) return terminal("deadline_exceeded", "registration_dialog_not_visible");
    const form = dialog.querySelector('[data-oaam-project-registration-key]');
    const input = form?.querySelector('input[type="text"]');
    const path = form?.querySelector('code')?.textContent?.trim() ?? "";
    const register = form?.querySelector('[data-oaam-project-registration-action="register"]');
    if (
        !(dialog instanceof HTMLElement) ||
        dialog.getAttribute("aria-modal") !== "true" ||
        !(form instanceof HTMLFormElement) ||
        form.dataset.oaamProjectRegistrationKey !== proposalKey ||
        !(input instanceof HTMLInputElement) ||
        !(register instanceof HTMLButtonElement) ||
        path !== sourcePath
    ) {
        return terminal("dialog_identity_invalid", "registration_dialog_not_bound_to_source");
    }
    const initialDisplayName = input.value.trim();
    const submittedDisplayName = (initialDisplayName + " — OAAM package proof").slice(0, 240);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (initialDisplayName.length === 0 || submittedDisplayName === initialDisplayName || setter === undefined) {
        throw new Error("packaged Project-registration name cannot be edited safely");
    }
    setter.call(input, submittedDisplayName);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: submittedDisplayName }));
    while (Date.now() < deadline && (input.value !== submittedDisplayName || register.disabled)) await pause();
    if (input.value !== submittedDisplayName || register.disabled) {
        return terminal("deadline_exceeded", "edited_registration_action_not_ready");
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!dialog.isConnected || document.querySelector('[data-oaam-dialog="discovery_project_registration"]') !== dialog) {
        return terminal("dialog_identity_invalid", "registration_dialog_changed_before_screenshot");
    }
    observe("dialog_ready");
    return {
        status: "ready",
        proposalKey,
        sourcePath,
        initialDisplayName,
        submittedDisplayName,
        matchedSourceCard: true,
        dialogId: "discovery_project_registration",
        timeline,
    };
})()`;
}

function completeProjectRegistrationScript(ready: PackagedProjectRegistrationReady): string {
    return `(async () => {
    const deadline = Date.now() + 30000;
    const expected = ${JSON.stringify(ready)};
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const dialog = document.querySelector('[data-oaam-dialog="discovery_project_registration"]');
    const form = dialog?.querySelector('[data-oaam-project-registration-key]');
    const input = form?.querySelector('input[type="text"]');
    const register = form?.querySelector('[data-oaam-project-registration-action="register"]');
    if (
        !(dialog instanceof HTMLElement) ||
        !(form instanceof HTMLFormElement) ||
        form.dataset.oaamProjectRegistrationKey !== expected.proposalKey ||
        !(input instanceof HTMLInputElement) ||
        input.value !== expected.submittedDisplayName ||
        !(register instanceof HTMLButtonElement) ||
        register.disabled
    ) {
        throw new Error("packaged Project-registration dialog changed before submit");
    }
    register.click();
    const card = await waitFor(() => {
        if (document.querySelector('[data-oaam-dialog="discovery_project_registration"]') !== null) return false;
        const exact = [...document.querySelectorAll('.source-review-card[data-oaam-source-path]')]
            .find((candidate) => candidate.dataset.oaamSourcePath === expected.sourcePath);
        if (!(exact instanceof HTMLElement)) return false;
        if (exact.querySelector('[data-oaam-project-decision="add"]') !== null) return false;
        const destination = exact.querySelector('[data-oaam-source-destination-choice="project"]');
        const destinationInput = destination?.querySelector('input[type="radio"][value="project"]');
        const current = exact.querySelector('.source-destination-current');
        return destination instanceof HTMLElement && destination.dataset.checked === "true" &&
            destinationInput instanceof HTMLInputElement && destinationInput.checked &&
            current?.textContent?.trim() === expected.submittedDisplayName
            ? exact
            : false;
    }, "the immediate registered Project source reconciliation");
    if (card.dataset.oaamSourceSelected !== "true") {
        throw new Error("registered Project source stopped participating in this review");
    }
    return {
        status: "complete",
        proposalKey: expected.proposalKey,
        sourcePath: expected.sourcePath,
        initialDisplayName: expected.initialDisplayName,
        submittedDisplayName: expected.submittedDisplayName,
        matchedSourceCard: true,
        dialogId: "discovery_project_registration",
        dialogClosed: true,
        proposalResolved: true,
        sourceDestination: "project",
        sourceReviewTimeline: expected.timeline,
    };
})()`;
}

interface PackagedProjectRegistrationTerminal {
    readonly status: "terminal";
    readonly terminalState:
        | "deadline_exceeded"
        | "dialog_identity_invalid"
        | "source_identity_invalid"
        | "source_probe_failed"
        | "source_review_replaced";
    readonly detail: string;
    readonly timeline: readonly PackagedProjectRegistrationTimelineEntry[];
}

function parseOpenResult(value: unknown): PackagedProjectRegistrationReady {
    if (
        exactRecord(value, ["detail", "status", "terminalState", "timeline"]) &&
        value.status === "terminal" &&
        typeof value.terminalState === "string" &&
        [
            "deadline_exceeded",
            "dialog_identity_invalid",
            "source_identity_invalid",
            "source_probe_failed",
            "source_review_replaced",
        ].includes(value.terminalState) &&
        typeof value.detail === "string" &&
        value.detail.length > 0
    ) {
        const terminal = Object.freeze({
            status: "terminal",
            terminalState: value.terminalState,
            detail: value.detail,
            timeline: parseTimeline(
                value.timeline,
                `terminal_${value.terminalState}` as PackagedProjectRegistrationTimelineState,
            ),
        }) as PackagedProjectRegistrationTerminal;
        throw new Error(`packaged Project-registration polling reached a terminal state: ${JSON.stringify(terminal)}`);
    }
    return parseReady(value);
}

export async function openPackagedProjectRegistration(
    webContents: PackagedProjectRegistrationWebContents,
    options: { readonly deadlineMilliseconds?: number; readonly pollIntervalMilliseconds?: number } = {},
): Promise<PackagedProjectRegistrationReady> {
    const deadlineMilliseconds = options.deadlineMilliseconds ?? 30_000;
    const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 25;
    if (
        !Number.isSafeInteger(deadlineMilliseconds) ||
        deadlineMilliseconds < 1 ||
        deadlineMilliseconds > 120_000 ||
        !Number.isSafeInteger(pollIntervalMilliseconds) ||
        pollIntervalMilliseconds < 1 ||
        pollIntervalMilliseconds > deadlineMilliseconds
    ) {
        throw new TypeError("invalid packaged Project-registration polling bounds");
    }
    return parseOpenResult(
        await webContents.executeJavaScript(openProjectRegistrationScript(deadlineMilliseconds, pollIntervalMilliseconds)),
    );
}

export async function completePackagedProjectRegistration(
    webContents: PackagedProjectRegistrationWebContents,
    ready: PackagedProjectRegistrationReady,
): Promise<PackagedProjectRegistrationProof> {
    const proof = parseComplete(await webContents.executeJavaScript(completeProjectRegistrationScript(ready)));
    if (
        proof.proposalKey !== ready.proposalKey ||
        proof.sourcePath !== ready.sourcePath ||
        proof.initialDisplayName !== ready.initialDisplayName ||
        proof.submittedDisplayName !== ready.submittedDisplayName
    ) {
        throw new TypeError("packaged Project-registration completion changed its reviewed identity");
    }
    return proof;
}
