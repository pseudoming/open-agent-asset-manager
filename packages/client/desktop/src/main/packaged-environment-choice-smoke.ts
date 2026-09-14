import { win32 } from "node:path";
import { physicalAccessPathContains, type WslHomePathResolution } from "@oaam/shared/paths";

export const PACKAGED_RUNTIME_ENVIRONMENT_LINE =
    "OAAM_DESKTOP_RUNTIME_SMOKE environment-choice=windows-default,wsl-multi-select exact-selected-set-probe=windows+wsl truthful-environment-results";

export interface EnvironmentChoiceSmokeWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export type ResolveEnvironmentChoiceWslHome = (distroName: string) => WslHomePathResolution;

export interface EnvironmentChoiceSmokeOptions {
    readonly selectedAdapterIds?: readonly string[];
    readonly deadlineAtMillisecondsSinceEpoch?: number;
    readonly onStageReady?: (stage: "locations" | "tools") => Promise<void>;
}

export interface ProjectEnvironmentChoiceProof {
    readonly status: "complete";
    readonly projectRootPath: string;
    readonly selectedEnvironment: string;
    readonly probedEnvironment: string;
    readonly environmentResultStatus: "complete" | "partial" | "failed";
    readonly sourcePaths: readonly string[];
    readonly excludedEnvironmentCount: number;
    readonly incompatibleEnvironmentsDisabled: true;
}

export interface EnvironmentChoiceProof {
    readonly status: "complete";
    readonly defaultEnvironment: string;
    readonly selectedEnvironments: readonly string[];
    readonly probedEnvironments: readonly string[];
    readonly environmentResultStatuses: readonly (readonly [string, "complete" | "partial" | "failed"])[];
    readonly selectedWslHomeSourcePath: string;
}

const WINDOWS_ENVIRONMENT_IDENTITY = JSON.stringify(["win32", "desktop-local"]);

function projectEnvironmentIdentity(projectRootPath: string): string {
    if (!win32.isAbsolute(projectRootPath) || win32.normalize(projectRootPath) !== projectRootPath) {
        throw new TypeError("packaged Project environment proof requires a canonical Windows path");
    }
    const wsl = /^\\\\wsl\.localhost\\([^\\]+)(?:\\|$)/iu.exec(projectRootPath);
    if (wsl?.[1] !== undefined) return JSON.stringify(["wsl", wsl[1]]);
    return WINDOWS_ENVIRONMENT_IDENTITY;
}

const WINDOWS_WSL_LOCATION_SELECTION_SCRIPT = `(async () => {
    const deadline = Date.now() + 15000;
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const choiceFor = (container) => {
        const choice = container.matches('input[type="checkbox"]')
            ? container
            : container.querySelector('input[type="checkbox"]');
        if (!(choice instanceof HTMLInputElement)) throw new Error("missing semantic checkbox choice");
        return choice;
    };
    const choiceSelected = (choice) => choice.checked;
    const parseStringArray = (value, label) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid " + label + " projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            throw new Error("invalid " + label + " projection");
        }
        return parsed;
    };
    const identity = (card) => JSON.stringify([
        card.dataset.oaamEnvironmentPlatform ?? "",
        card.dataset.oaamEnvironmentInstance ?? "",
    ]);
    const entry = await waitFor(
        () => document.querySelector(".discovery-workspace") ?? document.querySelector("[data-oaam-onboarding-start]"),
        "the discovery workspace or onboarding consent action",
    );
    let workspace = entry.matches(".discovery-workspace") ? entry : null;
    if (workspace === null) {
        if (!(entry instanceof HTMLButtonElement)) throw new Error("invalid onboarding consent action");
        entry.click();
        workspace = await waitFor(
            () => document.querySelector(".discovery-workspace"),
            "the discovery workspace after consent",
        );
    }
    const environmentCards = [...workspace.querySelectorAll("[data-oaam-environment-platform]")];
    const windowsCards = environmentCards.filter(
        (card) => identity(card) === ${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)},
    );
    const wslCards = environmentCards
        .filter((card) => card.dataset.oaamEnvironmentPlatform === "wsl")
        .sort((left, right) => identity(left).localeCompare(identity(right)));
    if (windowsCards.length !== 1 || wslCards.length === 0) {
        throw new Error("Windows onboarding must expose one local Windows choice and at least one WSL choice");
    }
    const windowsChoice = choiceFor(windowsCards[0]);
    const wslChoice = choiceFor(wslCards[0]);
    if (!choiceSelected(windowsChoice) || choiceSelected(wslChoice)) {
        throw new Error("Windows must be selected and WSL must be unselected before user action");
    }
    const initialSelected = parseStringArray(workspace.dataset.oaamSelectedEnvironments, "selected environments");
    if (initialSelected.length !== 1 || initialSelected[0] !== ${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}) {
        throw new Error("the selected-environments projection does not identify only local Windows");
    }
    if (parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments").length !== 0) {
        throw new Error("a WSL or Windows probe ran before explicit discovery");
    }

    const selectedWsl = identity(wslCards[0]);
    wslChoice.click();
    await waitFor(
        () => {
            const selected = parseStringArray(workspace.dataset.oaamSelectedEnvironments, "selected environments");
            return choiceSelected(windowsChoice) && choiceSelected(wslChoice) && selected.length === 2 &&
                selected.includes(${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}) && selected.includes(selectedWsl);
        },
        "combined Windows and WSL selection",
    );
    if (parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments").length !== 0) {
        throw new Error("selecting WSL performed a probe before the location Continue action");
    }
    return {
        status: "ready",
        defaultEnvironment: ${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)},
        selectedEnvironments: [${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}, selectedWsl],
    };
})()`;

function projectLocationSelectionScript(projectRootPath: string, expectedEnvironment: string, deadlineAt: number): string {
    return `(async () => {
    const deadline = ${String(deadlineAt)};
    const expectedProjectRootPath = ${JSON.stringify(projectRootPath)};
    const expectedEnvironment = ${JSON.stringify(expectedEnvironment)};
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const parseStringArray = (value, label) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid " + label + " projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            throw new Error("invalid " + label + " projection");
        }
        return parsed;
    };
    const identity = (card) => JSON.stringify([
        card.dataset.oaamEnvironmentPlatform ?? "",
        card.dataset.oaamEnvironmentInstance ?? "",
    ]);
    const choiceFor = (card) => {
        const choice = card.matches('input[type="radio"]')
            ? card
            : card.querySelector('input[type="radio"]');
        if (!(choice instanceof HTMLInputElement)) throw new Error("missing semantic single-select choice");
        return choice;
    };
    const workspace = await waitFor(
        () => document.querySelector('.discovery-workspace[data-oaam-journey-stage="locations"]'),
        "the Project-scoped location stage",
    );
    if ((workspace.dataset.oaamTargetProjectId ?? "").length === 0) {
        throw new Error("the Project-scoped location stage lost its exact Project identity");
    }
    const environmentCards = [...workspace.querySelectorAll('[data-oaam-environment-platform]')];
    const matchingCards = environmentCards.filter((card) => identity(card) === expectedEnvironment);
    if (matchingCards.length !== 1 || !(matchingCards[0] instanceof HTMLElement)) {
        throw new Error("the Project root does not map to exactly one available environment");
    }
    const selectedChoice = choiceFor(matchingCards[0]);
    const excludedChoices = environmentCards
        .filter((card) => card !== matchingCards[0])
        .map(choiceFor);
    const selectionNames = new Set([selectedChoice, ...excludedChoices].map((choice) => choice.name));
    if (selectionNames.size !== 1 || selectedChoice.name.length === 0) {
        throw new Error("Project environments are not one semantic single-select group");
    }
    if (!selectedChoice.checked || selectedChoice.disabled) {
        throw new Error("the exact Project environment is not the enabled default");
    }
    if (excludedChoices.some((choice) => choice.checked || !choice.disabled)) {
        throw new Error("an environment outside the exact Project root remains selectable");
    }
    const selected = parseStringArray(workspace.dataset.oaamSelectedEnvironments, "selected environments");
    if (selected.length !== 1 || selected[0] !== expectedEnvironment) {
        throw new Error("the Project-scoped selection does not identify only the exact Project environment");
    }
    if (parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments").length !== 0) {
        throw new Error("a Project environment probe ran before explicit discovery");
    }
    return {
        status: "ready",
        projectRootPath: expectedProjectRootPath,
        selectedEnvironment: expectedEnvironment,
        excludedEnvironmentCount: excludedChoices.length,
        incompatibleEnvironmentsDisabled: true,
    };
})()`;
}

function windowsWslToolSelectionScript(selectedAdapterIds: readonly string[], deadlineAt = Date.now() + 15_000): string {
    return `(async () => {
    const deadline = ${String(deadlineAt)};
    const requiredAdapterIds = ${JSON.stringify(selectedAdapterIds)};
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const parseStringArray = (value, label) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid " + label + " projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            throw new Error("invalid " + label + " projection");
        }
        return parsed;
    };
    const workspace = await waitFor(
        () => document.querySelector('.discovery-workspace[data-oaam-journey-stage="locations"]'),
        "the selected location stage",
    );
    if (parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments").length !== 0) {
        throw new Error("a probe ran before the location Continue action");
    }
    const continueLocations = workspace.querySelector('[data-oaam-journey-continue="locations"]');
    if (!(continueLocations instanceof HTMLButtonElement)) throw new Error("location Continue action is missing");
    continueLocations.click();
    const providerCards = await waitFor(
        () => {
            if (workspace.dataset.oaamJourneyStage !== "tools") return false;
            const cards = [...workspace.querySelectorAll("[data-oaam-provider-id]")];
            return requiredAdapterIds.every((adapterId) =>
                cards.some((card) => card.dataset.oaamProviderId === adapterId)
            ) ? cards : false;
        },
        "AI coding tool choices",
    );
    for (const card of providerCards) {
        const choice = card.matches('input[type="checkbox"]')
            ? card
            : card.querySelector('input[type="checkbox"]');
        if (!(choice instanceof HTMLInputElement)) throw new Error("missing semantic tool checkbox choice");
        const shouldSelect = requiredAdapterIds.includes(card.dataset.oaamProviderId ?? "");
        if (choice.checked !== shouldSelect) choice.click();
    }
    await waitFor(() => providerCards.every((card) => {
        const choice = card.matches('input[type="checkbox"]')
            ? card
            : card.querySelector('input[type="checkbox"]');
        return choice instanceof HTMLInputElement &&
            choice.checked === requiredAdapterIds.includes(card.dataset.oaamProviderId ?? "");
    }), "the exact AI coding tool selection");
    if (parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments").length !== 0) {
        throw new Error("opening the tool step performed a probe before explicit user action");
    }
    return { status: "ready", selectedAdapterIds: requiredAdapterIds };
})()`;
}

function windowsWslDiscoveryScript(selectedAdapterIds: readonly string[]): string {
    return `(async () => {
    const deadline = Date.now() + 15000;
    const requiredAdapterIds = ${JSON.stringify(selectedAdapterIds)};
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const parseStringArray = (value, label) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid " + label + " projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            throw new Error("invalid " + label + " projection");
        }
        return parsed;
    };
    const parseEnvironmentResults = (value) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid environment-result projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) =>
            Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" &&
            ["complete", "partial", "failed"].includes(entry[1])
        )) {
            throw new Error("invalid environment-result projection");
        }
        return parsed;
    };
    const workspace = await waitFor(
        () => document.querySelector('.discovery-workspace[data-oaam-journey-stage="tools"]'),
        "the selected AI coding tool stage",
    );
    if (parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments").length !== 0) {
        throw new Error("a probe ran before the tool-stage scan action");
    }
    const run = workspace.querySelector('[data-oaam-journey-continue="tools"]');
    if (!(run instanceof HTMLButtonElement)) throw new Error("tool-stage scan action is missing");
    await waitFor(() => !run.disabled, "enabled tool-stage scan action");
    run.click();
    await waitFor(() => {
        if (workspace.dataset.oaamDiscoveryActivity === "probe_failed") {
            throw new Error("selected environment-set probe failed");
        }
        if (workspace.dataset.oaamDiscoveryActivity !== "idle") return false;
        const enabled = parseStringArray(workspace.dataset.oaamEnabledAdapterIds, "enabled adapters");
        if (
            enabled.length !== requiredAdapterIds.length ||
            !requiredAdapterIds.every((adapterId) => enabled.includes(adapterId))
        ) return false;
        const probed = parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments");
        return probed.length > 0 ? probed : false;
    }, "persisted tool selection and selected WSL probe result");
    const probed = parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments");
    const selected = parseStringArray(workspace.dataset.oaamSelectedEnvironments, "selected environments");
    const selectedWsl = selected.find((environment) => {
        try {
            const parsed = JSON.parse(environment);
            return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === "wsl" &&
                typeof parsed[1] === "string" && parsed[1].length > 0;
        } catch {
            return false;
        }
    });
    if (selectedWsl === undefined) throw new Error("the selected WSL identity disappeared before discovery");
    if (
        probed.length !== 2 ||
        !probed.includes(${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}) ||
        !probed.includes(selectedWsl)
    ) {
        throw new Error("discovery did not match the exact selected Windows and WSL set");
    }
    const environmentResultStatuses = parseEnvironmentResults(workspace.dataset.oaamEnvironmentResultStatuses);
    const resultEnvironments = environmentResultStatuses.map((entry) => entry[0]);
    if (
        environmentResultStatuses.length !== 2 || new Set(resultEnvironments).size !== 2 ||
        !resultEnvironments.includes(${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}) ||
        !resultEnvironments.includes(selectedWsl)
    ) {
        throw new Error("discovery did not present one truthful result for each selected environment");
    }
    const enabled = parseStringArray(workspace.dataset.oaamEnabledAdapterIds, "enabled adapters");
    if (
        enabled.length !== requiredAdapterIds.length ||
        new Set(enabled).size !== enabled.length ||
        !requiredAdapterIds.every((adapterId) => enabled.includes(adapterId)) ||
        selected.length !== 2 ||
        new Set(selected).size !== selected.length
    ) {
        throw new Error("discovery did not preserve the exact distinct tools and selected locations");
    }
    await waitFor(
        () => workspace.dataset.oaamJourneyStage === "sources",
        "the source-review transition after successful discovery",
    );
    if (workspace.querySelector(".discovery-snapshot-summary") !== null) {
        throw new Error("successful discovery still exposes the retired scan-results page");
    }
    const sourcePaths = parseStringArray(workspace.dataset.oaamProbedSourcePaths, "probe source paths");
    const selectedIdentity = JSON.parse(selectedWsl);
    const selectedShareRoot = ${JSON.stringify("\\\\wsl.localhost\\")} + selectedIdentity[1] + ${JSON.stringify("\\")};
    const selectedShareRootLower = selectedShareRoot.toLowerCase();
    const selectedWslHomeSourcePath = sourcePaths.find((sourcePath) => {
        if (!sourcePath.toLowerCase().startsWith(selectedShareRootLower)) return false;
        const segments = sourcePath
            .slice(selectedShareRoot.length)
            .split(${JSON.stringify("\\")})
            .filter((segment) => segment.length > 0);
        return segments.length >= 2 && !segments[0].startsWith(".");
    });
    if (selectedWslHomeSourcePath === undefined) {
        throw new Error("selected WSL probe did not resolve a user HOME before deriving source roots");
    }
    return {
        status: "complete",
        defaultEnvironment: ${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)},
        selectedEnvironments: [${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}, selectedWsl],
        probedEnvironments: [${JSON.stringify(WINDOWS_ENVIRONMENT_IDENTITY)}, selectedWsl],
        environmentResultStatuses,
        selectedWslHomeSourcePath,
    };
})()`;
}

function projectEnvironmentDiscoveryScript(
    selectedAdapterIds: readonly string[],
    projectRootPath: string,
    expectedEnvironment: string,
    deadlineAt: number,
): string {
    return `(async () => {
    const deadline = ${String(deadlineAt)};
    const requiredAdapterIds = ${JSON.stringify(selectedAdapterIds)};
    const expectedProjectRootPath = ${JSON.stringify(projectRootPath)};
    const expectedEnvironment = ${JSON.stringify(expectedEnvironment)};
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const parseStringArray = (value, label) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid " + label + " projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            throw new Error("invalid " + label + " projection");
        }
        return parsed;
    };
    const parseEnvironmentResults = (value) => {
        let parsed;
        try {
            parsed = JSON.parse(value ?? "");
        } catch {
            throw new Error("invalid environment-result projection");
        }
        if (!Array.isArray(parsed) || !parsed.every((entry) =>
            Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" &&
            ["complete", "partial", "failed"].includes(entry[1])
        )) {
            throw new Error("invalid environment-result projection");
        }
        return parsed;
    };
    const workspace = await waitFor(
        () => document.querySelector('.discovery-workspace[data-oaam-journey-stage="tools"]'),
        "the Project-scoped AI coding tool stage",
    );
    if ((workspace.dataset.oaamTargetProjectId ?? "").length === 0) {
        throw new Error("the Project-scoped tool stage lost its exact Project identity");
    }
    const run = workspace.querySelector('[data-oaam-journey-continue="tools"]');
    if (!(run instanceof HTMLButtonElement)) throw new Error("tool-stage scan action is missing");
    await waitFor(() => !run.disabled, "enabled Project-scoped scan action");
    run.click();
    await waitFor(() => {
        if (workspace.dataset.oaamDiscoveryActivity === "probe_failed") {
            throw new Error("the exact Project environment probe failed");
        }
        if (workspace.dataset.oaamDiscoveryActivity !== "idle") return false;
        const enabled = parseStringArray(workspace.dataset.oaamEnabledAdapterIds, "enabled adapters");
        if (enabled.length !== requiredAdapterIds.length ||
            !requiredAdapterIds.every((adapterId) => enabled.includes(adapterId))) return false;
        const probed = parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments");
        return probed.length > 0 ? probed : false;
    }, "the exact Project environment result");
    const selected = parseStringArray(workspace.dataset.oaamSelectedEnvironments, "selected environments");
    const probed = parseStringArray(workspace.dataset.oaamProbedEnvironments, "probe environments");
    if (selected.length !== 1 || selected[0] !== expectedEnvironment ||
        probed.length !== 1 || probed[0] !== expectedEnvironment) {
        throw new Error("Project discovery escaped the exact registered Project environment");
    }
    const environmentResults = parseEnvironmentResults(workspace.dataset.oaamEnvironmentResultStatuses);
    if (environmentResults.length !== 1 || environmentResults[0][0] !== expectedEnvironment) {
        throw new Error("Project discovery did not return one result for the exact Project environment");
    }
    await waitFor(
        () => workspace.dataset.oaamJourneyStage === "sources",
        "the Project source-review transition",
    );
    const sourcePaths = parseStringArray(workspace.dataset.oaamProbedSourcePaths, "probe source paths");
    if (sourcePaths.length === 0 || new Set(sourcePaths).size !== sourcePaths.length) {
        throw new Error("Project discovery did not include a unique concrete source location");
    }
    return {
        status: "complete",
        projectRootPath: expectedProjectRootPath,
        selectedEnvironment: expectedEnvironment,
        probedEnvironment: expectedEnvironment,
        environmentResultStatus: environmentResults[0][1],
        sourcePaths,
    };
})()`;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isWslIdentity(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        const parsed: unknown = JSON.parse(value);
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
}

function isSelectedWslHomeSourcePath(value: unknown, selectedEnvironment: string): value is string {
    if (typeof value !== "string") return false;
    const parsed = JSON.parse(selectedEnvironment) as ["wsl", string];
    const root = `\\\\wsl.localhost\\${parsed[1]}\\`;
    return win32.isAbsolute(value) && win32.normalize(value) === value && isStrictDescendant(root, value);
}

function isEnvironmentResultStatus(value: unknown): value is readonly [string, "complete" | "partial" | "failed"] {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === "string" &&
        (value[1] === "complete" || value[1] === "partial" || value[1] === "failed")
    );
}

function selectedAdapterIds(options: EnvironmentChoiceSmokeOptions): readonly string[] {
    const values = options.selectedAdapterIds ?? ["CLAUDECODE"];
    if (
        values.length === 0 ||
        new Set(values).size !== values.length ||
        values.some((value) => !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value))
    ) {
        throw new TypeError("packaged environment-choice proof requires unique provider identities");
    }
    return Object.freeze([...values]);
}

function parseLocationSelectionProof(value: unknown): void {
    if (
        !isExactRecord(value, ["defaultEnvironment", "selectedEnvironments", "status"]) ||
        value.status !== "ready" ||
        value.defaultEnvironment !== WINDOWS_ENVIRONMENT_IDENTITY ||
        !Array.isArray(value.selectedEnvironments)
    ) {
        throw new TypeError("invalid packaged Windows/WSL location-selection proof");
    }
    const selected = value.selectedEnvironments.filter((entry): entry is string => typeof entry === "string");
    if (
        selected.length !== 2 ||
        !selected.includes(WINDOWS_ENVIRONMENT_IDENTITY) ||
        selected.find(isWslIdentity) === undefined ||
        new Set(selected).size !== 2
    ) {
        throw new TypeError("invalid packaged Windows/WSL location-selection proof");
    }
}

function parseProjectLocationSelectionProof(value: unknown, projectRootPath: string, expectedEnvironment: string): number {
    if (
        !isExactRecord(value, [
            "excludedEnvironmentCount",
            "incompatibleEnvironmentsDisabled",
            "projectRootPath",
            "selectedEnvironment",
            "status",
        ]) ||
        value.status !== "ready" ||
        value.projectRootPath !== projectRootPath ||
        value.selectedEnvironment !== expectedEnvironment ||
        value.incompatibleEnvironmentsDisabled !== true ||
        typeof value.excludedEnvironmentCount !== "number" ||
        !Number.isInteger(value.excludedEnvironmentCount) ||
        value.excludedEnvironmentCount < 0
    ) {
        throw new TypeError("invalid packaged Project environment location-selection proof");
    }
    return value.excludedEnvironmentCount;
}

function parseToolSelectionProof(value: unknown, expectedAdapterIds: readonly string[]): void {
    if (
        !isExactRecord(value, ["selectedAdapterIds", "status"]) ||
        value.status !== "ready" ||
        !Array.isArray(value.selectedAdapterIds)
    ) {
        throw new TypeError("invalid packaged AI coding tool selection proof");
    }
    const actual = value.selectedAdapterIds.filter((entry): entry is string => typeof entry === "string");
    if (
        actual.length !== expectedAdapterIds.length ||
        new Set(actual).size !== actual.length ||
        !expectedAdapterIds.every((adapterId) => actual.includes(adapterId))
    ) {
        throw new TypeError("invalid packaged AI coding tool selection proof");
    }
}

function parseEnvironmentChoiceProof(value: unknown): EnvironmentChoiceProof {
    if (
        !isExactRecord(value, [
            "defaultEnvironment",
            "environmentResultStatuses",
            "probedEnvironments",
            "selectedEnvironments",
            "selectedWslHomeSourcePath",
            "status",
        ]) ||
        value.status !== "complete" ||
        value.defaultEnvironment !== WINDOWS_ENVIRONMENT_IDENTITY ||
        !Array.isArray(value.selectedEnvironments) ||
        !Array.isArray(value.probedEnvironments) ||
        !Array.isArray(value.environmentResultStatuses)
    ) {
        throw new TypeError("invalid packaged Windows/WSL environment-choice proof");
    }
    const selectedEnvironments = value.selectedEnvironments.filter(
        (environment): environment is string => typeof environment === "string",
    );
    const probedEnvironments = value.probedEnvironments.filter(
        (environment): environment is string => typeof environment === "string",
    );
    const environmentResultStatuses = value.environmentResultStatuses.filter(isEnvironmentResultStatus);
    const resultEnvironments = environmentResultStatuses.map(([environment]) => environment);
    const selectedWsl = selectedEnvironments.find(isWslIdentity);
    if (
        selectedEnvironments.length !== 2 ||
        probedEnvironments.length !== 2 ||
        !selectedEnvironments.includes(WINDOWS_ENVIRONMENT_IDENTITY) ||
        selectedWsl === undefined ||
        new Set(selectedEnvironments).size !== 2 ||
        new Set(probedEnvironments).size !== 2 ||
        !selectedEnvironments.every((environment) => probedEnvironments.includes(environment)) ||
        environmentResultStatuses.length !== 2 ||
        new Set(resultEnvironments).size !== 2 ||
        !selectedEnvironments.every((environment) => resultEnvironments.includes(environment)) ||
        !isSelectedWslHomeSourcePath(value.selectedWslHomeSourcePath, selectedWsl)
    ) {
        throw new TypeError("invalid packaged Windows/WSL environment-choice proof");
    }
    return Object.freeze({
        status: "complete",
        defaultEnvironment: WINDOWS_ENVIRONMENT_IDENTITY,
        selectedEnvironments: Object.freeze([...selectedEnvironments]),
        probedEnvironments: Object.freeze([...probedEnvironments]),
        environmentResultStatuses: Object.freeze(
            environmentResultStatuses.map(
                (entry) => Object.freeze([...entry]) as readonly [string, "complete" | "partial" | "failed"],
            ),
        ),
        selectedWslHomeSourcePath: value.selectedWslHomeSourcePath,
    });
}

function parseProjectEnvironmentChoiceProof(
    value: unknown,
    projectRootPath: string,
    expectedEnvironment: string,
    excludedEnvironmentCount: number,
): ProjectEnvironmentChoiceProof {
    if (
        !isExactRecord(value, [
            "environmentResultStatus",
            "probedEnvironment",
            "projectRootPath",
            "selectedEnvironment",
            "sourcePaths",
            "status",
        ]) ||
        value.status !== "complete" ||
        value.projectRootPath !== projectRootPath ||
        value.selectedEnvironment !== expectedEnvironment ||
        value.probedEnvironment !== expectedEnvironment ||
        (value.environmentResultStatus !== "complete" &&
            value.environmentResultStatus !== "partial" &&
            value.environmentResultStatus !== "failed") ||
        !Array.isArray(value.sourcePaths)
    ) {
        throw new TypeError("invalid packaged Project environment-choice proof");
    }
    const sourcePaths = value.sourcePaths.filter((entry): entry is string => typeof entry === "string");
    if (
        sourcePaths.length !== value.sourcePaths.length ||
        sourcePaths.length === 0 ||
        new Set(sourcePaths).size !== sourcePaths.length ||
        sourcePaths.some((sourcePath) => !physicalAccessPathContains(projectRootPath, sourcePath))
    ) {
        throw new TypeError("invalid packaged Project environment-choice proof");
    }
    return Object.freeze({
        status: "complete",
        projectRootPath,
        selectedEnvironment: expectedEnvironment,
        probedEnvironment: expectedEnvironment,
        environmentResultStatus: value.environmentResultStatus,
        sourcePaths: Object.freeze([...sourcePaths]),
        excludedEnvironmentCount,
        incompatibleEnvironmentsDisabled: true,
    });
}

export async function proveWindowsWslEnvironmentChoice(
    webContents: EnvironmentChoiceSmokeWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    options: EnvironmentChoiceSmokeOptions = {},
): Promise<EnvironmentChoiceProof> {
    const adapterIds = selectedAdapterIds(options);
    parseLocationSelectionProof(await webContents.executeJavaScript(WINDOWS_WSL_LOCATION_SELECTION_SCRIPT));
    await options.onStageReady?.("locations");
    parseToolSelectionProof(await webContents.executeJavaScript(windowsWslToolSelectionScript(adapterIds)), adapterIds);
    await options.onStageReady?.("tools");
    const proof = parseEnvironmentChoiceProof(await webContents.executeJavaScript(windowsWslDiscoveryScript(adapterIds)));
    const selectedWsl = proof.selectedEnvironments.find(isWslIdentity);
    if (selectedWsl === undefined) throw new TypeError("packaged Windows/WSL environment-choice proof omitted WSL");
    const selected = JSON.parse(selectedWsl) as ["wsl", string];
    const resolution = resolveWslHomePath(selected[1]);
    if (
        resolution.status !== "available" ||
        !win32.isAbsolute(resolution.homePath) ||
        win32.normalize(resolution.homePath) !== resolution.homePath ||
        !isStrictDescendant(resolution.homePath, proof.selectedWslHomeSourcePath)
    ) {
        throw new TypeError("packaged Windows/WSL environment-choice proof did not stay below the selected WSL HOME");
    }
    return proof;
}

export async function proveWindowsProjectEnvironmentChoice(
    webContents: EnvironmentChoiceSmokeWebContents,
    projectRootPath: string,
    options: EnvironmentChoiceSmokeOptions = {},
): Promise<ProjectEnvironmentChoiceProof> {
    const adapterIds = selectedAdapterIds(options);
    const expectedEnvironment = projectEnvironmentIdentity(projectRootPath);
    const deadlineAt = options.deadlineAtMillisecondsSinceEpoch ?? Date.now() + 15_000;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 1) throw new TypeError("invalid Project environment deadline");
    const excludedEnvironmentCount = parseProjectLocationSelectionProof(
        await webContents.executeJavaScript(projectLocationSelectionScript(projectRootPath, expectedEnvironment, deadlineAt)),
        projectRootPath,
        expectedEnvironment,
    );
    await options.onStageReady?.("locations");
    parseToolSelectionProof(
        await webContents.executeJavaScript(windowsWslToolSelectionScript(adapterIds, deadlineAt)),
        adapterIds,
    );
    await options.onStageReady?.("tools");
    return parseProjectEnvironmentChoiceProof(
        await webContents.executeJavaScript(
            projectEnvironmentDiscoveryScript(adapterIds, projectRootPath, expectedEnvironment, deadlineAt),
        ),
        projectRootPath,
        expectedEnvironment,
        excludedEnvironmentCount,
    );
}

function isStrictDescendant(rootPath: string, candidatePath: string): boolean {
    const relative = win32.relative(rootPath, candidatePath);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative);
}
