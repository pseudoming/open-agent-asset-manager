import { win32 as win32Path } from "node:path";
import type {
    PackagedProviderProjectSweepWebContents,
    ProviderSweepProjectProposal,
    ProviderSweepSnapshot,
} from "./packaged-provider-project-sweep-ui-smoke";

export const PACKAGED_PROVIDER_PROJECT_REGISTRATION_DIRECTORY = "oaam-phase59-provider-project-registration";
export const PACKAGED_PROVIDER_PROJECT_REGISTRATION_STAGES = [
    "provider-registration-source-review",
    "provider-registration-dialog",
    "provider-registration-resolved",
] as const;
export type PackagedProviderProjectRegistrationStage = (typeof PACKAGED_PROVIDER_PROJECT_REGISTRATION_STAGES)[number];

export interface PackagedProviderProjectRegistrationFixture {
    readonly ownership: "current_run_exact_wsl_root";
    readonly environment: string;
    readonly rootPath: string;
    readonly projectPath: string;
}

export interface ProviderSweepRegistration {
    readonly key: string;
    readonly path: string;
    readonly placement: "source_card" | "detached";
    readonly initialDisplayName: string;
    readonly submittedDisplayName: string;
    readonly dialogClosed: true;
    readonly proposalResolved: true;
    readonly globalDestinationObserved: boolean;
    readonly projectDestinationRestored: true;
    readonly projectNameRestored: true;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function sameWindowsPath(left: string, right: string): boolean {
    return win32Path.normalize(left).toLocaleLowerCase("en-US") === win32Path.normalize(right).toLocaleLowerCase("en-US");
}

export function selectExactOwnedProviderProjectProposal(
    snapshot: ProviderSweepSnapshot,
    fixture: PackagedProviderProjectRegistrationFixture,
): ProviderSweepProjectProposal {
    const relative = win32Path.relative(fixture.rootPath, fixture.projectPath);
    if (
        fixture.ownership !== "current_run_exact_wsl_root" ||
        !/^\\\\wsl\.localhost\\[^\\]+\\/iu.test(fixture.rootPath) ||
        win32Path.normalize(fixture.rootPath) !== fixture.rootPath ||
        win32Path.normalize(fixture.projectPath) !== fixture.projectPath ||
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${win32Path.sep}`) ||
        win32Path.isAbsolute(relative)
    ) {
        throw new TypeError("packaged Project registration fixture identity is invalid");
    }
    const candidates = snapshot.projectProposals.filter(
        (proposal) =>
            win32Path.normalize(proposal.path) === proposal.path &&
            sameWindowsPath(proposal.path, fixture.projectPath) &&
            proposal.placement === "source_card" &&
            proposal.state === "actionable" &&
            JSON.stringify(proposal.adapterIds) === JSON.stringify(["OPENCODE"]),
    );
    const sources = snapshot.sourceCards.filter(
        (source) =>
            source.environment === fixture.environment &&
            win32Path.normalize(source.path) === source.path &&
            sameWindowsPath(source.path, fixture.projectPath) &&
            source.state === "included" &&
            JSON.stringify(source.adapterIds) === JSON.stringify(["OPENCODE"]),
    );
    if (candidates.length !== 1 || sources.length !== 1 || candidates[0] === undefined) {
        throw new Error(
            `packaged Project registration did not find one exact current-run OpenCode proposal ` +
                `(path=${fixture.projectPath}, candidates=${String(candidates.length)}, sources=${String(sources.length)})`,
        );
    }
    return candidates[0];
}

export function assertExactProviderProjectRegistrationResolution(
    initial: readonly ProviderSweepProjectProposal[],
    final: readonly ProviderSweepProjectProposal[],
    target: ProviderSweepProjectProposal,
): readonly string[] {
    const expected = initial.map((proposal) => (proposal.key === target.key ? { ...proposal, state: "resolved" } : proposal));
    if (JSON.stringify(final) !== JSON.stringify(expected)) {
        throw new Error("packaged Project registration did not resolve only the exact target while preserving every sibling");
    }
    return Object.freeze(initial.flatMap((proposal) => (proposal.key === target.key ? [] : [proposal.key])).sort());
}

function openRegistrationScript(proposal: ProviderSweepProjectProposal, sequence: number): string {
    return `(async () => {
    const expected = ${JSON.stringify(proposal)};
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const workspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
    if (!(workspace instanceof HTMLElement)) throw new Error("Provider sweep lost source review");
    const elements = [...workspace.querySelectorAll('[data-oaam-project-proposal-key]')]
        .filter((element) => element.dataset.oaamProjectProposalKey === expected.key);
    const buttons = [...new Set(elements.flatMap((element) =>
        [...element.querySelectorAll('[data-oaam-project-decision="add"]')]
    ))].filter((button) => button instanceof HTMLButtonElement && !button.disabled);
    if (buttons.length !== 1) throw new Error("Project proposal is not uniquely actionable: " + expected.key);
    buttons[0].click();
    const dialog = await waitFor(
        () => document.querySelector('[data-oaam-dialog="discovery_project_registration"]'),
        "the exact Provider-sweep Project dialog",
    );
    const form = dialog.querySelector('[data-oaam-project-registration-key]');
    const input = form?.querySelector('input[type="text"]');
    const shownPath = form?.querySelector('code')?.textContent?.trim() ?? "";
    const register = form?.querySelector('[data-oaam-project-registration-action="register"]');
    if (!(input instanceof HTMLInputElement) || !(register instanceof HTMLButtonElement) ||
        form?.dataset.oaamProjectRegistrationKey !== expected.key || shownPath !== expected.path) {
        throw new Error("Provider-sweep Project dialog changed identity");
    }
    const initialDisplayName = input.value.trim();
    const submittedDisplayName = (initialDisplayName + " — OAAM sweep ${sequence}").slice(0, 240);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (initialDisplayName.length === 0 || setter === undefined) throw new Error("Provider-sweep Project name is invalid");
    setter.call(input, submittedDisplayName);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: submittedDisplayName }));
    await waitFor(() => input.value === submittedDisplayName && !register.disabled, "the edited Provider-sweep Project name");
    return { initialDisplayName, submittedDisplayName };
})()`;
}

function completeRegistrationScript(
    proposal: ProviderSweepProjectProposal,
    names: { readonly initialDisplayName: string; readonly submittedDisplayName: string },
    exerciseDestinationRoundTrip: boolean,
): string {
    return `(async () => {
    const expected = ${JSON.stringify({ ...proposal, ...names })};
    const deadline = Date.now() + 30000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const dialog = document.querySelector('[data-oaam-dialog="discovery_project_registration"]');
            const alert = dialog?.querySelector('[role="alert"]');
            if (alert instanceof HTMLElement) throw new Error("Project registration failed: " + alert.textContent?.trim());
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const dialog = document.querySelector('[data-oaam-dialog="discovery_project_registration"]');
    const input = dialog?.querySelector('input[type="text"]');
    const register = dialog?.querySelector('[data-oaam-project-registration-action="register"]');
    if (!(input instanceof HTMLInputElement) || input.value !== expected.submittedDisplayName ||
        !(register instanceof HTMLButtonElement) || register.disabled) {
        throw new Error("Provider-sweep Project dialog is not ready to submit");
    }
    register.click();
    await waitFor(() => {
        if (document.querySelector('[data-oaam-dialog="discovery_project_registration"]') !== null) return false;
        const elements = [...document.querySelectorAll('[data-oaam-project-proposal-key]')]
            .filter((element) => element.dataset.oaamProjectProposalKey === expected.key);
        return elements.length > 0 && elements.every((element) =>
            element.querySelector('[data-oaam-project-decision="add"]') === null
        );
    }, "the resolved Provider-sweep Project proposal");
    if (expected.placement !== "source_card") {
        throw new Error("Provider-sweep Project proposal remained outside its exact source card");
    }
    const destinationState = () => {
        const cards = [...document.querySelectorAll('.source-review-card[data-oaam-project-proposal-key]')]
            .filter((element) => element.dataset.oaamProjectProposalKey === expected.key);
        const card = cards.length === 1 && cards[0] instanceof HTMLElement ? cards[0] : undefined;
        const globalChoice = card?.querySelector('[data-oaam-source-destination-choice="global"]');
        const projectChoice = card?.querySelector('[data-oaam-source-destination-choice="project"]');
        const globalInput = globalChoice?.querySelector('input[type="radio"]');
        const projectInput = projectChoice?.querySelector('input[type="radio"]');
        const projectName = card?.querySelector('.source-destination-current')?.textContent?.trim();
        if (!(globalInput instanceof HTMLInputElement) || !(projectInput instanceof HTMLInputElement)) return undefined;
        return { globalChoice, projectChoice, globalInput, projectInput, projectName };
    };
    const registeredState = await waitFor(() => {
        const state = destinationState();
        return state?.projectChoice?.dataset.checked === "true" &&
            state.globalChoice?.dataset.checked === "false" && state.projectName === expected.submittedDisplayName ? state : false;
    }, "the registered Project destination and name");
    ${
        exerciseDestinationRoundTrip
            ? `registeredState.globalInput.click();
    const globalState = await waitFor(() => {
        const state = destinationState();
        return state?.globalChoice?.dataset.checked === "true" &&
            state.projectChoice?.dataset.checked === "false" ? state : false;
    }, "the temporary Global destination");
    globalState.projectInput.click();
    await waitFor(() => {
        const state = destinationState();
        return state?.projectChoice?.dataset.checked === "true" &&
            state.globalChoice?.dataset.checked === "false" && state.projectName === expected.submittedDisplayName;
    }, "the restored Project destination and name");`
            : "void registeredState;"
    }
    return {
        status: "complete", key: expected.key, path: expected.path, placement: expected.placement,
        initialDisplayName: expected.initialDisplayName, submittedDisplayName: expected.submittedDisplayName,
        dialogClosed: true, proposalResolved: true,
        globalDestinationObserved: ${String(exerciseDestinationRoundTrip)},
        projectDestinationRestored: true, projectNameRestored: true,
    };
})()`;
}

function parseRegistration(value: unknown, exerciseDestinationRoundTrip: boolean): ProviderSweepRegistration {
    if (
        !exactRecord(value, [
            "dialogClosed",
            "globalDestinationObserved",
            "initialDisplayName",
            "key",
            "path",
            "placement",
            "projectDestinationRestored",
            "projectNameRestored",
            "proposalResolved",
            "status",
            "submittedDisplayName",
        ]) ||
        value.status !== "complete" ||
        value.dialogClosed !== true ||
        value.proposalResolved !== true ||
        value.globalDestinationObserved !== exerciseDestinationRoundTrip ||
        value.projectDestinationRestored !== true ||
        value.projectNameRestored !== true ||
        typeof value.key !== "string" ||
        value.key.length === 0 ||
        typeof value.path !== "string" ||
        value.path.length === 0 ||
        (value.placement !== "source_card" && value.placement !== "detached") ||
        typeof value.initialDisplayName !== "string" ||
        value.initialDisplayName.length === 0 ||
        typeof value.submittedDisplayName !== "string" ||
        value.submittedDisplayName.length === 0
    ) {
        throw new TypeError("invalid packaged Provider-sweep registration receipt");
    }
    return Object.freeze({
        key: value.key,
        path: value.path,
        placement: value.placement,
        initialDisplayName: value.initialDisplayName,
        submittedDisplayName: value.submittedDisplayName,
        dialogClosed: true,
        proposalResolved: true,
        globalDestinationObserved: exerciseDestinationRoundTrip,
        projectDestinationRestored: true,
        projectNameRestored: true,
    });
}

export async function registerPackagedProviderProjectProposal(
    webContents: PackagedProviderProjectSweepWebContents,
    proposal: ProviderSweepProjectProposal,
    options: {
        readonly sequence: number;
        readonly exerciseDestinationRoundTrip: boolean;
        readonly captureDialog?: () => Promise<void>;
    },
): Promise<ProviderSweepRegistration> {
    const names = (await webContents.executeJavaScript(openRegistrationScript(proposal, options.sequence))) as {
        readonly initialDisplayName?: unknown;
        readonly submittedDisplayName?: unknown;
    };
    if (typeof names.initialDisplayName !== "string" || typeof names.submittedDisplayName !== "string") {
        throw new TypeError("invalid packaged Provider-sweep edited name receipt");
    }
    await options.captureDialog?.();
    return parseRegistration(
        await webContents.executeJavaScript(
            completeRegistrationScript(
                proposal,
                { initialDisplayName: names.initialDisplayName, submittedDisplayName: names.submittedDisplayName },
                options.exerciseDestinationRoundTrip,
            ),
        ),
        options.exerciseDestinationRoundTrip,
    );
}
