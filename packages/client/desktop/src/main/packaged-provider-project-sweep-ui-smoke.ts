import { physicalAccessPathContains } from "@oaam/shared/paths";
import {
    proveWindowsProjectEnvironmentChoice,
    proveWindowsWslEnvironmentChoice,
    type ResolveEnvironmentChoiceWslHome,
} from "./packaged-environment-choice-smoke";
import {
    collectPackagedProviderDiscoveryReadability,
    PACKAGED_PROVIDER_DISCOVERY_TERMINAL_OBSERVATION_RECEIPT,
    type PackagedProviderDiscoveryReviewProof,
    type PackagedProviderDiscoveryReviewStage,
    type PackagedProviderDiscoveryTerminalObservation,
} from "./packaged-provider-discovery-review-proof";
import {
    assertExactProviderProjectRegistrationResolution,
    type PackagedProviderProjectRegistrationFixture,
    type PackagedProviderProjectRegistrationStage,
    type ProviderSweepRegistration,
    registerPackagedProviderProjectProposal,
    selectExactOwnedProviderProjectProposal,
} from "./packaged-provider-project-registration-ui-smoke";
import { PackagedProviderScreenshotProof } from "./packaged-provider-screenshot-proof";
import {
    PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT,
    packagedProviderProjectSweepEnterProjectContextScript,
    packagedProviderProjectSweepProjectContextReceiptScript,
    packagedProviderProjectSweepRepeatedIgnoredPathsScript,
} from "./packaged-provider-project-sweep-ui-script-support";
import {
    PACKAGED_RETAINED_PROJECT_RECOVERY_STAGES,
    type PackagedRetainedProjectRecoveryProof,
    proveWindowsPackagedRetainedProjectRecovery,
} from "./packaged-retained-project-recovery-ui-smoke";

export const PACKAGED_PROVIDER_PROJECT_SWEEP_DIRECTORY = "oaam-phase59-provider-project-sweep";
export const PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES = [
    "provider-sweep-locations",
    "provider-sweep-tools",
    "provider-sweep-first-registration",
    "provider-sweep-sources",
    "provider-sweep-repeated-sources",
    ...PACKAGED_RETAINED_PROJECT_RECOVERY_STAGES,
    "provider-sweep-project-context",
] as const;

export type PackagedProviderProjectSweepStage = (typeof PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES)[number];

export const PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS = Object.freeze([
    "CLAUDECODE",
    "ANTIGRAVITY",
    "OPENCODE",
    "CODEX",
    "ZCODE",
    "CURSOR",
] as const);

export interface ProviderContextReceipt {
    readonly environment: string;
    readonly adapterId: string;
    readonly status: "complete" | "partial" | "failed";
    readonly installationStatus: "available" | "version_incompatible" | "needs_permission" | "unknown" | "not_found";
    readonly agentRuntimeIds: readonly string[];
    readonly versionTexts: readonly string[];
    readonly diagnostics: readonly ProviderContextDiagnostic[];
}

interface ProviderContextDiagnostic {
    readonly code: string;
    readonly causeKind: string;
    readonly path: string;
}

export interface ProviderSweepSourceCard {
    readonly environment: string;
    readonly path: string;
    readonly adapterIds: readonly string[];
    readonly claimKinds: readonly string[];
    readonly state: "included" | "ignored" | "requires_review" | "unavailable";
}

export interface ProviderSweepProjectProposal {
    readonly key: string;
    readonly path: string;
    readonly adapterIds: readonly string[];
    readonly placement: "source_card" | "detached";
    readonly state: "actionable" | "blocked" | "resolved" | "not_requested";
}

export interface ProviderSweepSnapshot {
    readonly contextReceipts: readonly ProviderContextReceipt[];
    readonly sourceCards: readonly ProviderSweepSourceCard[];
    readonly projectProposals: readonly ProviderSweepProjectProposal[];
}

export interface ProviderSweepProjectContext {
    readonly projectId: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly projectMenuInsideSelectedRow: true;
    readonly projectMenuVisibleAtMinimumWidth: true;
    readonly selectedEnvironment: string;
    readonly probedEnvironment: string;
    readonly environmentResultStatus: "complete" | "partial" | "failed";
    readonly excludedEnvironmentCount: number;
    readonly incompatibleEnvironmentsDisabled: true;
    readonly routeBoundToExactProject: true;
    readonly sourcePaths: readonly string[];
}

export interface PackagedProviderProjectSweepProof {
    readonly status: "complete";
    readonly adapterIds: readonly string[];
    readonly contextReceipts: readonly ProviderContextReceipt[];
    readonly sourceCards: readonly ProviderSweepSourceCard[];
    readonly initialProjectProposals: readonly ProviderSweepProjectProposal[];
    readonly registrations: readonly ProviderSweepRegistration[];
    readonly compactIgnoredPaths: readonly string[];
    readonly ignoredPathsRestoredOnRepeatScan: true;
    readonly finalBlockedProjectKeys: readonly [];
    readonly finalActionableProjectKeys: readonly [];
    readonly retainedProjectRecovery?: PackagedRetainedProjectRecoveryProof;
    readonly contextualProjectImport?: ProviderSweepProjectContext;
}

export interface PackagedProviderDiscoveryStageProof extends ProviderSweepSnapshot {
    readonly status: "complete";
    readonly adapterIds: readonly string[];
    readonly defaultEnvironment: string;
    readonly selectedEnvironments: readonly string[];
    readonly probedEnvironments: readonly string[];
    readonly environmentResultStatuses: readonly (readonly [string, "complete" | "partial" | "failed"])[];
    readonly selectedWslHomeSourcePath: string;
}

export interface PackagedProviderProjectSweepWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedProviderProjectSweepOptions {
    readonly capture: (stage: PackagedProviderProjectSweepStage) => Promise<void>;
}

interface CapturedImage {
    toPNG(): Buffer;
}

export interface PackagedProviderProjectSweepScreenshotWebContents {
    capturePage(): Promise<CapturedImage>;
}

export function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? Object.freeze([...value]) : undefined;
}

function parseContextReceipt(value: unknown): ProviderContextReceipt {
    if (
        !exactRecord(value, [
            "adapterId",
            "agentRuntimeIds",
            "diagnostics",
            "environment",
            "installationStatus",
            "status",
            "versionTexts",
        ]) ||
        typeof value.environment !== "string" ||
        typeof value.adapterId !== "string" ||
        !["complete", "partial", "failed"].includes(String(value.status)) ||
        !["available", "version_incompatible", "needs_permission", "unknown", "not_found"].includes(
            String(value.installationStatus),
        )
    ) {
        throw new TypeError("invalid packaged Provider-context receipt");
    }
    const agentRuntimeIds = stringArray(value.agentRuntimeIds);
    const versionTexts = stringArray(value.versionTexts);
    const diagnostics = Array.isArray(value.diagnostics)
        ? value.diagnostics.map((diagnostic) => {
              if (
                  !exactRecord(diagnostic, ["causeKind", "code", "path"]) ||
                  typeof diagnostic.code !== "string" ||
                  diagnostic.code.length === 0 ||
                  typeof diagnostic.causeKind !== "string" ||
                  diagnostic.causeKind.length === 0 ||
                  typeof diagnostic.path !== "string"
              ) {
                  throw new TypeError("invalid packaged Provider-context diagnostic receipt");
              }
              return Object.freeze({
                  code: diagnostic.code,
                  causeKind: diagnostic.causeKind,
                  path: diagnostic.path,
              });
          })
        : undefined;
    if (agentRuntimeIds === undefined || versionTexts === undefined || diagnostics === undefined) {
        throw new TypeError("invalid packaged Provider-context runtime receipt");
    }
    const diagnosticKeys = diagnostics.map((diagnostic) => `${diagnostic.code}\0${diagnostic.causeKind}\0${diagnostic.path}`);
    if (new Set(diagnosticKeys).size !== diagnosticKeys.length) {
        throw new TypeError("duplicate packaged Provider-context diagnostic receipt");
    }
    return Object.freeze({
        environment: value.environment,
        adapterId: value.adapterId,
        status: value.status as ProviderContextReceipt["status"],
        installationStatus: value.installationStatus as ProviderContextReceipt["installationStatus"],
        agentRuntimeIds,
        versionTexts,
        diagnostics: Object.freeze(diagnostics),
    });
}

function parseSourceCard(value: unknown): ProviderSweepSourceCard {
    if (
        !exactRecord(value, ["adapterIds", "claimKinds", "environment", "path", "state"]) ||
        typeof value.environment !== "string" ||
        value.environment.length === 0 ||
        typeof value.path !== "string" ||
        value.path.length === 0 ||
        !["included", "ignored", "requires_review", "unavailable"].includes(String(value.state))
    ) {
        throw new TypeError("invalid packaged Provider-sweep source card");
    }
    const adapterIds = stringArray(value.adapterIds);
    const claimKinds = stringArray(value.claimKinds);
    if (adapterIds === undefined || adapterIds.length === 0 || claimKinds === undefined || claimKinds.length === 0) {
        throw new TypeError("invalid packaged Provider-sweep source ownership");
    }
    return Object.freeze({
        environment: value.environment,
        path: value.path,
        adapterIds,
        claimKinds,
        state: value.state as ProviderSweepSourceCard["state"],
    });
}

function parseProjectProposal(value: unknown): ProviderSweepProjectProposal {
    if (
        !exactRecord(value, ["adapterIds", "key", "path", "placement", "state"]) ||
        typeof value.key !== "string" ||
        value.key.length === 0 ||
        typeof value.path !== "string" ||
        (value.placement !== "source_card" && value.placement !== "detached") ||
        !["actionable", "blocked", "resolved", "not_requested"].includes(String(value.state))
    ) {
        throw new TypeError("invalid packaged Provider-sweep Project proposal");
    }
    const adapterIds = stringArray(value.adapterIds);
    if (adapterIds === undefined || adapterIds.length === 0) {
        throw new TypeError("invalid packaged Provider-sweep Project ownership");
    }
    return Object.freeze({
        key: value.key,
        path: value.path,
        adapterIds,
        placement: value.placement,
        state: value.state as ProviderSweepProjectProposal["state"],
    });
}

export function parsePackagedProviderSweepSnapshot(value: unknown): ProviderSweepSnapshot {
    if (!exactRecord(value, ["contextReceipts", "projectProposals", "sourceCards", "status"]) || value.status !== "ready") {
        throw new TypeError("invalid packaged Provider-sweep snapshot");
    }
    if (!Array.isArray(value.contextReceipts) || !Array.isArray(value.sourceCards) || !Array.isArray(value.projectProposals)) {
        throw new TypeError("invalid packaged Provider-sweep snapshot inventories");
    }
    const contextReceipts = Object.freeze(value.contextReceipts.map(parseContextReceipt));
    const sourceCards = Object.freeze(value.sourceCards.map(parseSourceCard));
    const projectProposals = Object.freeze(value.projectProposals.map(parseProjectProposal));
    const contextKeys = contextReceipts.map((entry) => `${entry.environment}\0${entry.adapterId}`);
    const environments = [...new Set(contextReceipts.map((entry) => entry.environment))];
    const windowsEnvironment = JSON.stringify(["win32", "desktop-local"]);
    const wslEnvironments = environments.filter((environment) => {
        try {
            const parsed = JSON.parse(environment) as unknown;
            return (
                Array.isArray(parsed) &&
                parsed.length === 2 &&
                parsed[0] === "wsl" &&
                typeof parsed[1] === "string" &&
                parsed[1].length > 0
            );
        } catch {
            return false;
        }
    });
    const expectedContextKeys = [windowsEnvironment, ...(wslEnvironments.length === 1 ? wslEnvironments : [])]
        .flatMap((environment) => PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS.map((adapterId) => `${environment}\0${adapterId}`))
        .sort();
    if (
        environments.length !== 2 ||
        !environments.includes(windowsEnvironment) ||
        wslEnvironments.length !== 1 ||
        contextReceipts.length !== 12 ||
        new Set(contextKeys).size !== contextKeys.length ||
        JSON.stringify([...contextKeys].sort()) !== JSON.stringify(expectedContextKeys) ||
        sourceCards.length === 0 ||
        new Set(sourceCards.map((entry) => `${entry.environment}\0${entry.path}`)).size !== sourceCards.length ||
        new Set(projectProposals.map((entry) => entry.key)).size !== projectProposals.length
    ) {
        throw new TypeError("packaged Provider sweep does not cover the exact six-Provider Windows/WSL matrix");
    }
    return Object.freeze({ contextReceipts, sourceCards, projectProposals });
}

function parseStringListReceipt(value: unknown, label: string): readonly string[] {
    if (!exactRecord(value, ["paths", "status"]) || value.status !== "complete") {
        throw new TypeError(`invalid packaged ${label} receipt`);
    }
    const paths = stringArray(value.paths);
    if (paths === undefined) throw new TypeError(`invalid packaged ${label} paths`);
    return paths;
}

export function parsePackagedProviderProjectContext(value: unknown): ProviderSweepProjectContext {
    if (
        !exactRecord(value, [
            "displayName",
            "environmentResultStatus",
            "excludedEnvironmentCount",
            "incompatibleEnvironmentsDisabled",
            "probedEnvironment",
            "projectId",
            "projectMenuInsideSelectedRow",
            "projectMenuVisibleAtMinimumWidth",
            "rootPath",
            "routeBoundToExactProject",
            "selectedEnvironment",
            "sourcePaths",
            "status",
        ]) ||
        value.status !== "complete" ||
        typeof value.projectId !== "string" ||
        !/^[0-9a-f-]{36}$/iu.test(value.projectId) ||
        typeof value.displayName !== "string" ||
        value.displayName.length === 0 ||
        typeof value.rootPath !== "string" ||
        value.rootPath.length === 0 ||
        value.projectMenuInsideSelectedRow !== true ||
        value.projectMenuVisibleAtMinimumWidth !== true ||
        typeof value.selectedEnvironment !== "string" ||
        value.selectedEnvironment.length === 0 ||
        value.probedEnvironment !== value.selectedEnvironment ||
        (value.environmentResultStatus !== "complete" &&
            value.environmentResultStatus !== "partial" &&
            value.environmentResultStatus !== "failed") ||
        typeof value.excludedEnvironmentCount !== "number" ||
        !Number.isInteger(value.excludedEnvironmentCount) ||
        value.excludedEnvironmentCount < 0 ||
        value.incompatibleEnvironmentsDisabled !== true ||
        value.routeBoundToExactProject !== true
    ) {
        throw new TypeError("invalid packaged Provider-sweep Project-context receipt");
    }
    const sourcePaths = stringArray(value.sourcePaths);
    if (sourcePaths === undefined || sourcePaths.length === 0 || new Set(sourcePaths).size !== sourcePaths.length) {
        throw new TypeError("invalid packaged Provider-sweep Project-context source paths");
    }
    return Object.freeze({
        projectId: value.projectId,
        displayName: value.displayName,
        rootPath: value.rootPath,
        projectMenuInsideSelectedRow: true,
        projectMenuVisibleAtMinimumWidth: true,
        selectedEnvironment: value.selectedEnvironment,
        probedEnvironment: value.probedEnvironment,
        environmentResultStatus: value.environmentResultStatus,
        excludedEnvironmentCount: value.excludedEnvironmentCount,
        incompatibleEnvironmentsDisabled: true,
        routeBoundToExactProject: true,
        sourcePaths,
    });
}

const SNAPSHOT_SCRIPT = `(async () => {
    const workspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
    if (!(workspace instanceof HTMLElement)) throw new Error("Provider sweep is not at source review");
    const parseArray = (value, label) => {
        let parsed;
        try { parsed = JSON.parse(value ?? ""); } catch { throw new Error("invalid " + label); }
        if (!Array.isArray(parsed)) throw new Error("invalid " + label);
        return parsed;
    };
    const contextReceipts = parseArray(workspace.dataset.oaamProviderContextReceipts, "Provider-context receipts")
        .map(([environment, adapterId, status, installationStatus, agentRuntimeIds, versionTexts, diagnostics]) => ({
            environment, adapterId, status, installationStatus, agentRuntimeIds, versionTexts, diagnostics,
        }));
    const sourceCards = [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
        .map((card) => ({
            environment: card.dataset.oaamSourceEnvironmentKey ?? "",
            path: card.dataset.oaamSourcePath ?? "",
            adapterIds: parseArray(card.dataset.oaamSourceAdapterIds, "source Adapter identities"),
            claimKinds: parseArray(card.dataset.oaamSourceClaimKinds, "source claim kinds"),
            state: card.dataset.oaamSourceState ?? "",
        }))
        .sort((left, right) => (left.environment + "\\0" + left.path).localeCompare(right.environment + "\\0" + right.path));
    const proposals = new Map();
    for (const element of workspace.querySelectorAll('[data-oaam-project-proposal-key]')) {
        const key = element.dataset.oaamProjectProposalKey ?? "";
        if (key.length === 0) continue;
        const card = element.matches('.source-review-card') ? element : element.closest('.source-review-card');
        const placement = card instanceof HTMLElement ? "source_card" : "detached";
        const path = card instanceof HTMLElement
            ? card.dataset.oaamSourcePath ?? ""
            : element.querySelector('code')?.textContent?.trim() ?? "";
        const rawAdapterIds = element.dataset.oaamProjectAdapterIds ??
            (card instanceof HTMLElement ? card.dataset.oaamProjectAdapterIds : undefined);
        const adapterIds = parseArray(rawAdapterIds, "Project Adapter identities");
        const buttons = [...element.querySelectorAll('[data-oaam-project-decision="add"]')];
        const actionable = buttons.some((button) => button instanceof HTMLButtonElement && !button.disabled);
        const blocked = buttons.some((button) => button instanceof HTMLButtonElement && button.disabled);
        const projectDestination = card?.querySelector('[data-oaam-source-destination-choice="project"]');
        const state = actionable ? "actionable" : blocked ? "blocked" :
            projectDestination instanceof HTMLElement && projectDestination.dataset.checked === "true" ? "resolved" : "not_requested";
        const existing = proposals.get(key);
        const candidate = { key, path, adapterIds, placement, state };
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(candidate)) {
            throw new Error("Project proposal has conflicting UI identities: " + key);
        }
        proposals.set(key, candidate);
    }
    return {
        status: "ready",
        contextReceipts,
        sourceCards,
        projectProposals: [...proposals.values()].sort((left, right) => left.key.localeCompare(right.key)),
    };
})()`;

export async function collectPackagedProviderSweepSnapshot(
    webContents: PackagedProviderProjectSweepWebContents,
): Promise<ProviderSweepSnapshot> {
    return parsePackagedProviderSweepSnapshot(await webContents.executeJavaScript(SNAPSHOT_SCRIPT));
}

export const PACKAGED_PROVIDER_SOURCE_DESTINATION_IDENTITY_SCRIPT = `(card) => {
    const checkedChoices = [...card.querySelectorAll('[data-oaam-source-destination-choice]')]
        .filter((choice) => choice.querySelector('input[type="radio"]:checked') !== null);
    if (checkedChoices.length !== 1) {
        throw new Error("default watched Provider source does not have one checked machine destination");
    }
    const destination = checkedChoices[0].getAttribute("data-oaam-source-destination-choice");
    if (destination !== "global" && destination !== "project") {
        throw new Error("default watched Provider source has an invalid machine destination");
    }
    return destination;
}`;

function sourceIgnoreScript(exactTarget: ProviderSweepSourceCard | null, protectedProjectPaths: readonly string[]): string {
    return `(async () => {
    const exactTarget = ${JSON.stringify(exactTarget)};
    const protectedProjectPaths = new Set(${JSON.stringify(protectedProjectPaths)});
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
    if (!(workspace instanceof HTMLElement)) throw new Error("Provider sweep lost source review before ignore");
    const adapters = (card) => {
        let value;
        try { value = JSON.parse(card.dataset.oaamSourceAdapterIds ?? ""); } catch { value = undefined; }
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error("Provider source ignore found invalid Adapter identity");
        return value;
    };
    const candidates = [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
        .filter((card) => card.dataset.oaamSourceState === "included" && (exactTarget === null
            ? !protectedProjectPaths.has(card.dataset.oaamSourcePath ?? "")
            : card.dataset.oaamSourceEnvironmentKey === exactTarget.environment && card.dataset.oaamSourcePath === exactTarget.path &&
                JSON.stringify(adapters(card)) === JSON.stringify(exactTarget.adapterIds)))
        .sort((left, right) => (left.dataset.oaamSourcePath ?? "").localeCompare(right.dataset.oaamSourcePath ?? ""));
    if ((exactTarget === null && candidates.length < 2) || (exactTarget !== null && (candidates.length !== 1 ||
        candidates[0].dataset.oaamSourceWatchSelected !== "true"))) throw new Error("Provider source ignore did not find its exact included default watched card");
    const sourceDestinationIdentity = ${PACKAGED_PROVIDER_SOURCE_DESTINATION_IDENTITY_SCRIPT};
    const canonicalDefaultIncludes = exactTarget === null ? [] :
        [...workspace.querySelectorAll('.source-review-card[data-oaam-source-watch-selected="true"]')].map((card) => {
            if (card.dataset.oaamSourceState !== "included")
                throw new Error("default watched Provider source is not included");
            const destination = sourceDestinationIdentity(card);
            return { environment: card.dataset.oaamSourceEnvironmentKey ?? "", path: card.dataset.oaamSourcePath ?? "",
                adapterIds: adapters(card), destination };
        }).sort((left, right) => (left.environment + "\\0" + left.path).localeCompare(right.environment + "\\0" + right.path));
    const paths = [];
    for (const original of candidates.slice(0, exactTarget === null ? 2 : 1)) {
        const path = original.dataset.oaamSourcePath ?? "";
        const current = () => [...workspace.querySelectorAll('.source-review-card[data-oaam-source-path]')]
            .filter((card) => card.dataset.oaamSourcePath === path && (exactTarget === null ||
                card.dataset.oaamSourceEnvironmentKey === exactTarget.environment &&
                JSON.stringify(adapters(card)) === JSON.stringify(exactTarget.adapterIds)));
        const ignore = current().flatMap((card) => [...card.querySelectorAll('[data-oaam-source-action="ignore"]')])
            .filter((button) => button instanceof HTMLButtonElement && !button.disabled);
        if (ignore.length !== 1) throw new Error("Provider sweep location cannot be uniquely ignored: " + path);
        ignore[0].click();
        const confirm = await waitFor(
            () => {
                const buttons = current().flatMap((card) => [...card.querySelectorAll('[data-oaam-source-action="confirm-ignore"]')])
                    .filter((button) => button instanceof HTMLButtonElement && !button.disabled);
                if (buttons.length > 1) throw new Error("Provider sweep ignore confirmation is ambiguous");
                return buttons.length === 1 ? buttons[0] : false;
            },
            "the exact ignore confirmation",
        );
        confirm.click();
        const ignored = await waitFor(() => {
            const cards = current();
            const card = cards.length === 1 ? cards[0] : undefined;
            return card instanceof HTMLElement && card.dataset.oaamSourceState === "ignored" &&
                workspace.dataset.oaamDiscoveryActivity === "idle" && (exactTarget === null ||
                    card.dataset.oaamSourceSelected === "false" && card.dataset.oaamSourceWatchSelected === "false") ? card : false;
        }, "the saved compact ignored card");
        if (ignored.querySelector('details') !== null || ignored.querySelector('.source-review-decisions') !== null ||
            [...ignored.querySelectorAll('[data-oaam-source-action="restore"]')]
                .filter((button) => button instanceof HTMLButtonElement && !button.disabled).length !== 1) {
            throw new Error("ignored Provider-sweep card retained expanded controls: " + path);
        }
        paths.push(path);
    }
    return exactTarget === null ? { status: "complete", paths } :
        { status: "complete", target: { ...exactTarget, state: "ignored" }, canonicalDefaultIncludes };
})()`;
}

export function packagedProviderExactSourceIgnoreScript(target: ProviderSweepSourceCard): string {
    return sourceIgnoreScript(target, []);
}

function compactIgnoreScript(protectedProjectPaths: readonly string[]): string {
    return sourceIgnoreScript(null, protectedProjectPaths);
}

const FINAL_PROJECT_STATE_SCRIPT = `(async () => {
    const workspace = document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]');
    if (!(workspace instanceof HTMLElement)) throw new Error("Provider sweep lost final source review");
    const keys = (selector) => [...workspace.querySelectorAll('[data-oaam-project-proposal-key]')]
        .filter((element) => element.querySelector(selector) !== null)
        .map((element) => element.dataset.oaamProjectProposalKey ?? "")
        .filter((key, index, values) => key.length > 0 && values.indexOf(key) === index)
        .sort();
    return {
        status: "complete",
        blocked: keys('[data-oaam-project-decision="add"]:disabled'),
        actionable: keys('[data-oaam-project-decision="add"]:not(:disabled)'),
    };
})()`;

function parseFinalProjectState(value: unknown): { readonly blocked: readonly string[]; readonly actionable: readonly string[] } {
    if (!exactRecord(value, ["actionable", "blocked", "status"]) || value.status !== "complete") {
        throw new TypeError("invalid packaged Provider-sweep final Project state");
    }
    const blocked = stringArray(value.blocked);
    const actionable = stringArray(value.actionable);
    if (blocked === undefined || actionable === undefined) {
        throw new TypeError("invalid packaged Provider-sweep final Project keys");
    }
    return Object.freeze({ blocked, actionable });
}

export async function proveWindowsPackagedProviderDiscoveryStage(
    webContents: PackagedProviderProjectSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    capture: (stage: "locations" | "tools") => Promise<void>,
): Promise<PackagedProviderDiscoveryStageProof> {
    const entered = await webContents.executeJavaScript(PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT);
    if (!exactRecord(entered, ["status"]) || entered.status !== "ready") {
        throw new TypeError("invalid packaged Provider-sweep entry receipt");
    }
    const environment = await proveWindowsWslEnvironmentChoice(webContents, resolveWslHomePath, {
        selectedAdapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
        onStageReady: capture,
    });
    const snapshot = await collectPackagedProviderSweepSnapshot(webContents);
    return Object.freeze({
        adapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
        ...environment,
        ...snapshot,
    });
}

export async function proveWindowsPackagedProviderProjectRegistration(
    webContents: PackagedProviderProjectSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    fixture: PackagedProviderProjectRegistrationFixture,
    options: { readonly capture: (stage: PackagedProviderProjectRegistrationStage) => Promise<void> },
) {
    const discovery = await proveWindowsPackagedProviderDiscoveryStage(webContents, resolveWslHomePath, async () => undefined);
    if (discovery.contextReceipts.some((context) => context.status === "failed")) {
        throw new Error("packaged Project registration found a failed Provider context");
    }
    await options.capture("provider-registration-source-review");
    const proposal = selectExactOwnedProviderProjectProposal(discovery, fixture);
    const registration = await registerPackagedProviderProjectProposal(webContents, proposal, {
        sequence: 1,
        exerciseDestinationRoundTrip: false,
        captureDialog: () => options.capture("provider-registration-dialog"),
    });
    const finalSnapshot = await collectPackagedProviderSweepSnapshot(webContents);
    if (
        JSON.stringify(finalSnapshot.contextReceipts) !== JSON.stringify(discovery.contextReceipts) ||
        JSON.stringify(finalSnapshot.sourceCards) !== JSON.stringify(discovery.sourceCards)
    ) {
        throw new Error("packaged Project registration changed discovery sources or Provider contexts");
    }
    const untouchedProposalKeys = assertExactProviderProjectRegistrationResolution(
        discovery.projectProposals,
        finalSnapshot.projectProposals,
        proposal,
    );
    await options.capture("provider-registration-resolved");
    return Object.freeze({
        status: "complete",
        fixture,
        discovery,
        registration,
        untouchedProposalKeys,
    });
}

export async function proveWindowsPackagedProviderDiscoveryReview(
    webContents: PackagedProviderProjectSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    options: {
        readonly capture: (stage: PackagedProviderDiscoveryReviewStage) => Promise<void>;
        readonly recordTerminalObservation: (receipt: PackagedProviderDiscoveryTerminalObservation) => void;
    },
): Promise<PackagedProviderDiscoveryReviewProof> {
    const stage = await proveWindowsPackagedProviderDiscoveryStage(webContents, resolveWslHomePath, (step) =>
        options.capture(`provider-discovery-${step}`),
    );
    const readability = await collectPackagedProviderDiscoveryReadability(webContents, stage, options.recordTerminalObservation);
    await options.capture("provider-discovery-source-review");
    return Object.freeze({
        ...stage,
        readability,
    });
}

export async function proveWindowsPackagedProviderProjectSweep(
    webContents: PackagedProviderProjectSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    options: PackagedProviderProjectSweepOptions,
): Promise<PackagedProviderProjectSweepProof> {
    const snapshot = await proveWindowsPackagedProviderDiscoveryStage(webContents, resolveWslHomePath, (stage) =>
        options.capture(`provider-sweep-${stage}`),
    );
    if (snapshot.contextReceipts.some((context) => context.status === "failed")) {
        throw new Error("Provider sweep found failed Provider contexts before mutation");
    }
    const blocked = snapshot.projectProposals.filter((proposal) => proposal.state === "blocked");
    if (blocked.length > 0) {
        throw new Error(`Provider sweep found blocked Project proposals: ${JSON.stringify(blocked)}`);
    }
    const actionable = snapshot.projectProposals.filter((proposal) => proposal.state === "actionable");
    if (actionable.some((proposal) => proposal.placement !== "source_card")) {
        throw new Error(`Provider sweep found detached actionable Project proposals: ${JSON.stringify(actionable)}`);
    }
    const registrations: ProviderSweepRegistration[] = [];
    for (const [index, proposal] of actionable.entries()) {
        registrations.push(
            await registerPackagedProviderProjectProposal(webContents, proposal, {
                sequence: index + 1,
                exerciseDestinationRoundTrip: true,
                ...(index === 0 ? { captureDialog: () => options.capture("provider-sweep-first-registration") } : {}),
            }),
        );
    }
    if (actionable.length === 0) await options.capture("provider-sweep-first-registration");
    const compactIgnoredPaths = parseStringListReceipt(
        await webContents.executeJavaScript(compactIgnoreScript(registrations.map((registration) => registration.path))),
        "Provider-sweep compact ignore",
    );
    const finalProjectState = parseFinalProjectState(await webContents.executeJavaScript(FINAL_PROJECT_STATE_SCRIPT));
    const scannedSourcePaths = new Set(snapshot.sourceCards.map((source) => source.path));
    const registeredProjectPaths = new Set(registrations.map((registration) => registration.path));
    if (
        compactIgnoredPaths.length !== 2 ||
        compactIgnoredPaths.some((sourcePath) => !scannedSourcePaths.has(sourcePath) || registeredProjectPaths.has(sourcePath)) ||
        finalProjectState.blocked.length > 0 ||
        finalProjectState.actionable.length > 0
    ) {
        throw new Error("Provider sweep did not close every actionable Project and two compact ignore interactions");
    }
    await options.capture("provider-sweep-sources");
    const ignoredPathsAfterFirstCapture = parseStringListReceipt(
        await webContents.executeJavaScript(packagedProviderProjectSweepRepeatedIgnoredPathsScript(compactIgnoredPaths)),
        "Provider-sweep ignored state after its first screenshot",
    );
    if (JSON.stringify(ignoredPathsAfterFirstCapture) !== JSON.stringify(compactIgnoredPaths)) {
        throw new Error("Provider sweep changed the ignored locations while capturing their first screenshot");
    }
    const repeatedEntry = await webContents.executeJavaScript(PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT);
    if (!exactRecord(repeatedEntry, ["status"]) || repeatedEntry.status !== "ready") {
        throw new TypeError("invalid repeated packaged Provider-sweep entry receipt");
    }
    await proveWindowsWslEnvironmentChoice(webContents, resolveWslHomePath, {
        selectedAdapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
    });
    const repeatedIgnoredPaths = parseStringListReceipt(
        await webContents.executeJavaScript(packagedProviderProjectSweepRepeatedIgnoredPathsScript(compactIgnoredPaths)),
        "Provider-sweep repeated ignored state",
    );
    if (JSON.stringify(repeatedIgnoredPaths) !== JSON.stringify(compactIgnoredPaths)) {
        throw new Error("Provider sweep changed the exact ignored locations on repeated scan");
    }
    await options.capture("provider-sweep-repeated-sources");
    const ignoredPathsAfterRepeatedCapture = parseStringListReceipt(
        await webContents.executeJavaScript(packagedProviderProjectSweepRepeatedIgnoredPathsScript(compactIgnoredPaths)),
        "Provider-sweep ignored state after its repeated-scan screenshot",
    );
    if (JSON.stringify(ignoredPathsAfterRepeatedCapture) !== JSON.stringify(compactIgnoredPaths)) {
        throw new Error("Provider sweep changed the ignored locations while capturing their repeated-scan screenshot");
    }
    const recoveryRegistration = registrations.find((registration) =>
        registration.path.replaceAll("/", "\\").toLocaleLowerCase("en-US").endsWith("\\fund-listen"),
    );
    const recoveryProposal =
        recoveryRegistration === undefined
            ? undefined
            : actionable.find(
                  (proposal) => proposal.key === recoveryRegistration.key && proposal.path === recoveryRegistration.path,
              );
    const retainedProjectRecovery =
        recoveryRegistration === undefined || recoveryProposal === undefined
            ? undefined
            : await proveWindowsPackagedRetainedProjectRecovery(
                  webContents,
                  resolveWslHomePath,
                  {
                      displayName: recoveryRegistration.submittedDisplayName,
                      rootPath: recoveryRegistration.path,
                      adapterIds: recoveryProposal.adapterIds,
                  },
                  { capture: options.capture },
              );
    let contextualProjectImport: ProviderSweepProjectContext | undefined;
    if (retainedProjectRecovery !== undefined) {
        const projectEntry = await webContents.executeJavaScript(
            packagedProviderProjectSweepEnterProjectContextScript(retainedProjectRecovery),
        );
        if (
            !exactRecord(projectEntry, ["projectMenuInsideSelectedRow", "projectMenuVisibleAtMinimumWidth", "status"]) ||
            projectEntry.status !== "ready" ||
            projectEntry.projectMenuInsideSelectedRow !== true ||
            projectEntry.projectMenuVisibleAtMinimumWidth !== true
        ) {
            throw new TypeError("invalid packaged Provider-sweep Project-context entry receipt");
        }
        const projectEnvironment = await proveWindowsProjectEnvironmentChoice(webContents, retainedProjectRecovery.rootPath, {
            selectedAdapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
        });
        contextualProjectImport = parsePackagedProviderProjectContext(
            await webContents.executeJavaScript(
                packagedProviderProjectSweepProjectContextReceiptScript({
                    projectId: retainedProjectRecovery.projectId,
                    displayName: retainedProjectRecovery.displayName,
                    rootPath: retainedProjectRecovery.rootPath,
                    projectMenuInsideSelectedRow: true,
                    projectMenuVisibleAtMinimumWidth: true,
                    selectedEnvironment: projectEnvironment.selectedEnvironment,
                    probedEnvironment: projectEnvironment.probedEnvironment,
                    environmentResultStatus: projectEnvironment.environmentResultStatus,
                    excludedEnvironmentCount: projectEnvironment.excludedEnvironmentCount,
                    incompatibleEnvironmentsDisabled: projectEnvironment.incompatibleEnvironmentsDisabled,
                }),
            ),
        );
        if (
            contextualProjectImport.projectId !== retainedProjectRecovery.projectId ||
            contextualProjectImport.displayName !== retainedProjectRecovery.displayName ||
            contextualProjectImport.rootPath !== retainedProjectRecovery.rootPath ||
            contextualProjectImport.selectedEnvironment !== projectEnvironment.selectedEnvironment ||
            contextualProjectImport.probedEnvironment !== projectEnvironment.probedEnvironment ||
            contextualProjectImport.environmentResultStatus !== projectEnvironment.environmentResultStatus ||
            contextualProjectImport.excludedEnvironmentCount !== projectEnvironment.excludedEnvironmentCount ||
            contextualProjectImport.incompatibleEnvironmentsDisabled !== true ||
            contextualProjectImport.sourcePaths.some(
                (sourcePath) => !physicalAccessPathContains(retainedProjectRecovery.rootPath, sourcePath),
            )
        ) {
            throw new TypeError("packaged Project-context import changed the exact registered Project identity");
        }
        await options.capture("provider-sweep-project-context");
    }
    return Object.freeze({
        status: "complete",
        adapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
        contextReceipts: snapshot.contextReceipts,
        sourceCards: snapshot.sourceCards,
        initialProjectProposals: snapshot.projectProposals,
        registrations: Object.freeze(registrations),
        compactIgnoredPaths,
        ignoredPathsRestoredOnRepeatScan: true,
        finalBlockedProjectKeys: Object.freeze([]) as readonly [],
        finalActionableProjectKeys: Object.freeze([]) as readonly [],
        ...(retainedProjectRecovery === undefined ? {} : { retainedProjectRecovery }),
        ...(contextualProjectImport === undefined ? {} : { contextualProjectImport }),
    });
}

export class PackagedProviderProjectSweepScreenshotProof<
    Stage extends string = PackagedProviderProjectSweepStage,
    Proof = PackagedProviderProjectSweepProof,
> extends PackagedProviderScreenshotProof<Stage, Proof> {
    public constructor(
        rootPath: string,
        stages = PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES as unknown as readonly Stage[],
        label = "Provider-sweep",
    ) {
        super(rootPath, stages, label);
    }

    public recordProviderDiscoveryTerminalObservation(receipt: PackagedProviderDiscoveryTerminalObservation): void {
        this.writeBoundedEvidence(PACKAGED_PROVIDER_DISCOVERY_TERMINAL_OBSERVATION_RECEIPT, receipt, 262_144);
    }
}

import fs from "node:fs";
import path from "node:path";
