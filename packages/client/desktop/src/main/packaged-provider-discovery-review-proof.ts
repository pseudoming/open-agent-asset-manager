import type {
    PackagedProviderDiscoveryStageProof,
    PackagedProviderProjectSweepWebContents,
} from "./packaged-provider-project-sweep-ui-smoke";

export const PACKAGED_PROVIDER_DISCOVERY_REVIEW_DIRECTORY = "oaam-phase59-provider-discovery-review";
export const PACKAGED_PROVIDER_DISCOVERY_REVIEW_STAGES = [
    "provider-discovery-locations",
    "provider-discovery-tools",
    "provider-discovery-source-review",
] as const;

export type PackagedProviderDiscoveryReviewStage = (typeof PACKAGED_PROVIDER_DISCOVERY_REVIEW_STAGES)[number];

interface OrdinaryActionReceipt {
    readonly identity: string;
    readonly subject: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly disabledReason: string;
}

interface OrdinaryItemReceipt {
    readonly identity: string;
    readonly status: string;
    readonly reason: string;
    readonly actions: readonly OrdinaryActionReceipt[];
}

export interface PackagedProviderDiscoveryReadabilityReceipt {
    readonly contextIssues: readonly OrdinaryItemReceipt[];
    readonly projectProposals: readonly OrdinaryItemReceipt[];
    readonly sourceCards: readonly OrdinaryItemReceipt[];
}

export interface PackagedProviderDiscoveryReviewProof extends PackagedProviderDiscoveryStageProof {
    readonly readability: PackagedProviderDiscoveryReadabilityReceipt;
}

export const PACKAGED_PROVIDER_DISCOVERY_TERMINAL_OBSERVATION_RECEIPT = "provider-discovery-terminal-observation.json";

export interface PackagedProviderDiscoveryTerminalObservation {
    readonly schemaVersion: 1;
    readonly stage: "provider-discovery-source-review";
    readonly error: { readonly name: string; readonly message: string };
    readonly rawReceipt: unknown;
}

const READABILITY_SCRIPT = `(() => {
    const workspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
    if (!(workspace instanceof HTMLElement) || workspace.dataset.oaamDiscoveryActivity !== "idle") {
        throw new Error("Provider discovery review is not idle");
    }
    const text = (element) => (element?.textContent ?? "").replace(/\\s+/gu, " ").trim().slice(0, 1024);
    const accessibleLabel = (element) => {
        const visible = text(element);
        if (visible.length > 0) return visible;
        for (const attribute of ["aria-label", "data-tooltip", "title"]) {
            const value = (element?.getAttribute(attribute) ?? "").trim();
            if (value.length > 0) return value.slice(0, 1024);
        }
        return "";
    };
    const visibleCopy = (element, selector) => [...(element?.querySelectorAll(selector) ?? [])]
        .map((entry) => text(entry)).filter(Boolean).join(" ").slice(0, 1024);
    const actions = (element, itemSubject) => [...(element?.querySelectorAll('button, [role="button"]') ?? [])].map((action) => ({
        identity: action.hasAttribute("data-oaam-diagnostic-path-copy") ? "diagnostic_path.copy" :
            action.dataset.oaamSourceAction ?? action.dataset.oaamProjectDecision ??
                action.dataset.oaamSemanticEntry ?? action.dataset.oaamInteractionEntry ?? "",
        subject: action.hasAttribute("data-oaam-diagnostic-path-copy")
            ? (action.closest('[data-oaam-diagnostic-path="location"]')?.querySelector('code[title]')?.getAttribute("title") ?? "").trim().slice(0, 1024)
            : itemSubject,
        label: accessibleLabel(action),
        enabled: action instanceof HTMLButtonElement ? !action.disabled : action.getAttribute("aria-disabled") !== "true",
        disabledReason: (action.getAttribute("title") ?? action.getAttribute("aria-description") ?? "").trim().slice(0, 512),
    })).filter((action) => action.identity.length > 0);
    const contextIssues = [...workspace.querySelectorAll('.discovery-probe-issue')].map((row) => {
        const identity = (row.dataset.oaamEnvironmentIdentity ?? "") + "\\0" + (row.dataset.oaamAdapterId ?? "");
        return { identity, status: text(row.querySelector('.discovery-probe-issue-owner strong')),
            reason: text(row.querySelector('.discovery-probe-issue-paths')), actions: actions(row, identity) };
    });
    const sourceCards = [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')].map((card) => {
        const identity = JSON.stringify([card.dataset.oaamSourceEnvironmentKey ?? "", card.dataset.oaamSourcePath ?? ""]);
        return { identity, status: text(card.querySelector('.source-review-heading .workbench-badge')),
            reason: visibleCopy(card, '.source-ignored-effect, .source-read-unavailable, .source-relationship small, .source-destination-current, .source-project-proposal small, [role="alert"]'),
            actions: actions(card, identity) };
    }).sort((left, right) => left.identity.localeCompare(right.identity));
    const proposals = new Map();
    for (const element of workspace.querySelectorAll('[data-oaam-project-proposal-key]')) {
        const key = element.dataset.oaamProjectProposalKey ?? "";
        if (key.length === 0 || proposals.has(key)) continue;
        const card = element.matches('.source-review-card') ? element : element.closest('.source-review-card');
        const root = card instanceof HTMLElement ? card : element;
        proposals.set(key, {
            identity: key,
            status: text(root.querySelector('[data-oaam-project-decision="add"], small')),
            reason: visibleCopy(root, '.source-project-proposal small, .source-destination-current, [role="alert"]'),
            actions: actions(root, key),
        });
    }
    return { status: "ready", contextIssues, sourceCards, projectProposals: [...proposals.values()] };
})()`;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseItem(value: unknown): OrdinaryItemReceipt {
    if (
        !exactRecord(value, ["actions", "identity", "reason", "status"]) ||
        typeof value.identity !== "string" ||
        value.identity.length === 0 ||
        typeof value.status !== "string" ||
        typeof value.reason !== "string" ||
        !Array.isArray(value.actions) ||
        !value.actions.every(
            (action) =>
                exactRecord(action, ["disabledReason", "enabled", "identity", "label", "subject"]) &&
                typeof action.identity === "string" &&
                action.identity.length > 0 &&
                typeof action.subject === "string" &&
                action.subject.length > 0 &&
                typeof action.label === "string" &&
                action.label.length > 0 &&
                typeof action.enabled === "boolean" &&
                typeof action.disabledReason === "string",
        ) ||
        new Set(value.actions.map((action) => `${action.identity}\0${action.subject}`)).size !== value.actions.length
    ) {
        throw new TypeError("invalid packaged Provider-discovery ordinary presentation");
    }
    return Object.freeze({
        identity: value.identity,
        status: value.status,
        reason: value.reason,
        actions: Object.freeze(value.actions.map((action) => Object.freeze({ ...action }))) as readonly OrdinaryActionReceipt[],
    });
}

function parseReadability(value: unknown): PackagedProviderDiscoveryReadabilityReceipt {
    if (
        !exactRecord(value, ["contextIssues", "projectProposals", "sourceCards", "status"]) ||
        value.status !== "ready" ||
        !Array.isArray(value.contextIssues) ||
        !Array.isArray(value.projectProposals) ||
        !Array.isArray(value.sourceCards)
    ) {
        throw new TypeError("invalid packaged Provider-discovery readability receipt");
    }
    const receipt = Object.freeze({
        contextIssues: Object.freeze(value.contextIssues.map(parseItem)),
        projectProposals: Object.freeze(value.projectProposals.map(parseItem)),
        sourceCards: Object.freeze(value.sourceCards.map(parseItem)),
    });
    for (const items of [receipt.contextIssues, receipt.projectProposals, receipt.sourceCards]) {
        if (new Set(items.map((item) => item.identity)).size !== items.length) {
            throw new TypeError("duplicate packaged Provider-discovery ordinary identity");
        }
    }
    return receipt;
}

export async function collectPackagedProviderDiscoveryReadability(
    webContents: PackagedProviderProjectSweepWebContents,
    stage: PackagedProviderDiscoveryStageProof,
    recordTerminalObservation: (receipt: PackagedProviderDiscoveryTerminalObservation) => void,
): Promise<PackagedProviderDiscoveryReadabilityReceipt> {
    const rawReceipt = await webContents.executeJavaScript(READABILITY_SCRIPT);
    try {
        const receipt = parseReadability(rawReceipt);
        const sourceByIdentity = new Map(receipt.sourceCards.map((item) => [item.identity, item]));
        const sourcesUnderstandable =
            sourceByIdentity.size === stage.sourceCards.length &&
            stage.sourceCards.every((source) => {
                const item = sourceByIdentity.get(JSON.stringify([source.environment, source.path]));
                return (
                    item !== undefined &&
                    (source.state === "included" || item.status.length > 0 || item.reason.length > 0) &&
                    (source.state !== "requires_review" || item.actions.some((action) => action.enabled)) &&
                    (source.state !== "unavailable" ||
                        !item.actions.some((action) => action.identity === "include" && action.enabled))
                );
            });
        const proposalByKey = new Map(receipt.projectProposals.map((item) => [item.identity, item]));
        const proposalsUnderstandable =
            proposalByKey.size === stage.projectProposals.length &&
            stage.projectProposals.every((proposal) => {
                const item = proposalByKey.get(proposal.key);
                const add = item?.actions.filter((action) => action.identity === "add") ?? [];
                return (
                    item !== undefined &&
                    (proposal.state !== "actionable" || (add.length === 1 && add[0]?.enabled === true)) &&
                    (proposal.state !== "blocked" ||
                        (!add.some((action) => action.enabled) &&
                            (item.reason.length > 0 || add.some((action) => action.disabledReason.length > 0)))) &&
                    (!(["resolved", "not_requested"] as const).includes(proposal.state as "resolved" | "not_requested") ||
                        !add.some((action) => action.enabled))
                );
            });
        const issueByIdentity = new Map(receipt.contextIssues.map((issue) => [issue.identity, issue]));
        const contextIdentities = new Set(stage.contextReceipts.map((context) => `${context.environment}\0${context.adapterId}`));
        const contextsUnderstandable = stage.contextReceipts
            .filter((context) => context.status !== "complete")
            .every((context) => {
                const issue = issueByIdentity.get(`${context.environment}\0${context.adapterId}`);
                return issue !== undefined && issue.status.length > 0 && issue.reason.length > 0;
            });
        if (
            !sourcesUnderstandable ||
            !proposalsUnderstandable ||
            !contextsUnderstandable ||
            receipt.contextIssues.length !== issueByIdentity.size ||
            receipt.contextIssues.some((issue) => !contextIdentities.has(issue.identity)) ||
            stage.contextReceipts.every((context) => context.status === "failed") ||
            (!stage.sourceCards.some((source) => source.state === "included" || source.state === "requires_review") &&
                stage.projectProposals.length === 0)
        ) {
            throw new Error("Provider discovery ordinary result is missing, unexplained, or contradicts its state");
        }
        return receipt;
    } catch (error) {
        recordTerminalObservation({
            schemaVersion: 1,
            stage: "provider-discovery-source-review",
            error: {
                name: (error instanceof Error ? error.name : "UnknownError").slice(0, 128),
                message: (error instanceof Error ? error.message : String(error)).slice(0, 4_096),
            },
            rawReceipt,
        });
        throw error;
    }
}
