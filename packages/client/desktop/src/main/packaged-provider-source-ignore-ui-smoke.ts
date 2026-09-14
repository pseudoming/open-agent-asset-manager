import { win32 as win32Path } from "node:path";
import { proveWindowsWslEnvironmentChoice, type ResolveEnvironmentChoiceWslHome } from "./packaged-environment-choice-smoke";
import {
    type PackagedProviderProjectRegistrationFixture,
    sameWindowsPath,
    selectExactOwnedProviderProjectProposal,
} from "./packaged-provider-project-registration-ui-smoke";
import {
    PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT,
    packagedProviderProjectSweepRepeatedIgnoredPathsScript,
} from "./packaged-provider-project-sweep-ui-script-support";
import {
    collectPackagedProviderSweepSnapshot,
    PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
    type PackagedProviderProjectSweepWebContents,
    type ProviderSweepSnapshot,
    type ProviderSweepSourceCard,
    packagedProviderExactSourceIgnoreScript,
    proveWindowsPackagedProviderDiscoveryStage,
} from "./packaged-provider-project-sweep-ui-smoke";

export const PACKAGED_PROVIDER_SOURCE_IGNORE_DIRECTORY = "oaam-phase59-provider-source-ignore";
export const PACKAGED_PROVIDER_SOURCE_IGNORE_STAGES = [
    "provider-source-ignore-compact",
    "provider-source-ignore-repeated",
] as const;
export type PackagedProviderSourceIgnoreStage = (typeof PACKAGED_PROVIDER_SOURCE_IGNORE_STAGES)[number];

export interface PackagedProviderSourceIgnoreFixture extends PackagedProviderProjectRegistrationFixture {
    readonly sourcePath: string;
}

function strictWindowsChild(rootPath: string, candidatePath: string): boolean {
    const relative = win32Path.relative(rootPath, candidatePath);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${win32Path.sep}`) && !win32Path.isAbsolute(relative);
}

function windowsPathsOverlap(left: string, right: string): boolean {
    return sameWindowsPath(left, right) || strictWindowsChild(left, right) || strictWindowsChild(right, left);
}

export function selectExactOwnedProviderSourceCard(
    snapshot: ProviderSweepSnapshot,
    fixture: PackagedProviderSourceIgnoreFixture,
): ProviderSweepSourceCard {
    selectExactOwnedProviderProjectProposal(snapshot, fixture);
    if (
        win32Path.normalize(fixture.sourcePath) !== fixture.sourcePath ||
        !strictWindowsChild(fixture.rootPath, fixture.sourcePath) ||
        windowsPathsOverlap(fixture.sourcePath, fixture.projectPath)
    ) {
        throw new TypeError("packaged Provider source-ignore fixture identity is invalid");
    }
    const candidates = snapshot.sourceCards.filter(
        (source) =>
            source.environment === fixture.environment &&
            win32Path.normalize(source.path) === source.path &&
            sameWindowsPath(source.path, fixture.sourcePath) &&
            source.state === "included" &&
            JSON.stringify(source.adapterIds) === JSON.stringify(["OPENCODE"]),
    );
    const overlappingProjects = snapshot.projectProposals.filter((proposal) =>
        windowsPathsOverlap(proposal.path, fixture.sourcePath),
    );
    if (candidates.length !== 1 || candidates[0] === undefined || overlappingProjects.length > 0) {
        throw new Error(
            `packaged Provider source ignore did not find one exact current-run OpenCode source ` +
                `(path=${fixture.sourcePath}, candidates=${String(candidates.length)}, overlappingProjects=${String(overlappingProjects.length)})`,
        );
    }
    return candidates[0];
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseIgnoreReceipt(value: unknown) {
    if (
        !exactRecord(value, ["canonicalDefaultIncludes", "status", "target"]) ||
        value.status !== "complete" ||
        !Array.isArray(value.canonicalDefaultIncludes) ||
        !exactRecord(value.target, ["adapterIds", "claimKinds", "environment", "path", "state"]) ||
        value.target.state !== "ignored"
    ) {
        throw new TypeError("invalid packaged Provider source-ignore receipt");
    }
    const target = value.target;
    const includes = value.canonicalDefaultIncludes.map((entry) => {
        if (
            !exactRecord(entry, ["adapterIds", "destination", "environment", "path"]) ||
            typeof entry.environment !== "string" ||
            typeof entry.path !== "string" ||
            (entry.destination !== "global" && entry.destination !== "project") ||
            !Array.isArray(entry.adapterIds) ||
            entry.adapterIds.length === 0 ||
            !entry.adapterIds.every((adapterId) => typeof adapterId === "string")
        ) {
            throw new TypeError("invalid packaged Provider source-ignore default selection");
        }
        return Object.freeze({
            environment: entry.environment,
            path: entry.path,
            adapterIds: Object.freeze([...entry.adapterIds]),
            destination: entry.destination,
        });
    });
    if (new Set(includes.map((entry) => `${entry.environment}\0${entry.path}`)).size !== includes.length) {
        throw new TypeError("duplicate packaged Provider source-ignore default selection");
    }
    return Object.freeze({ target: target as unknown as ProviderSweepSourceCard, includes: Object.freeze(includes) });
}

export function packagedProviderIgnoredSourceCaptureScript(target: ProviderSweepSourceCard): string {
    return `(async () => {
    const expected = ${JSON.stringify(target)};
    const find = () => [...document.querySelectorAll('.source-review-card[data-oaam-source-path]')].filter((card) => {
        let adapters;
        try { adapters = JSON.parse(card.dataset.oaamSourceAdapterIds ?? ""); } catch { adapters = undefined; }
        return card instanceof HTMLElement && card.dataset.oaamSourceEnvironmentKey === expected.environment &&
            card.dataset.oaamSourcePath === expected.path && JSON.stringify(adapters) === JSON.stringify(expected.adapterIds);
    });
    const verify = () => {
        const cards = find();
        if (cards.length !== 1 || !(cards[0] instanceof HTMLElement)) throw new Error("ignored source capture did not re-identify the exact target card");
        const card = cards[0];
        const restore = [...card.querySelectorAll('[data-oaam-source-action="restore"]')];
        if (card.dataset.oaamSourceState !== "ignored" || card.dataset.oaamSourceSelected !== "false" ||
            card.dataset.oaamSourceWatchSelected !== "false" || card.querySelector('details') !== null ||
            card.querySelector('.source-review-decisions') !== null || restore.length !== 1 ||
            !(restore[0] instanceof HTMLButtonElement) || restore[0].disabled) {
            throw new Error("ignored source capture target is not compact with one enabled restore action");
        }
        return card;
    };
    verify().scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const card = verify();
    const bounds = card.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.top < 0 || bounds.bottom > viewportHeight) {
        throw new Error("ignored source capture target is not fully visible in the viewport");
    }
    return { status: "ready", environment: expected.environment, path: expected.path, adapterIds: expected.adapterIds, restoreActionCount: 1 };
})()`;
}

function parseVisibleTargetReceipt(value: unknown, target: ProviderSweepSourceCard) {
    if (
        !exactRecord(value, ["adapterIds", "environment", "path", "restoreActionCount", "status"]) ||
        value.status !== "ready" ||
        value.environment !== target.environment ||
        value.path !== target.path ||
        value.restoreActionCount !== 1 ||
        JSON.stringify(value.adapterIds) !== JSON.stringify(target.adapterIds)
    ) {
        throw new TypeError("invalid packaged Provider ignored-source visual receipt");
    }
    return value;
}

export async function proveWindowsPackagedProviderSourceIgnore(
    webContents: PackagedProviderProjectSweepWebContents,
    resolveWslHomePath: ResolveEnvironmentChoiceWslHome,
    fixture: PackagedProviderSourceIgnoreFixture,
    options: {
        readonly capture: (stage: PackagedProviderSourceIgnoreStage) => Promise<void>;
        readonly onReadyToIgnore: () => Promise<void>;
        readonly onIgnored: () => void;
    },
) {
    const discovery = await proveWindowsPackagedProviderDiscoveryStage(webContents, resolveWslHomePath, async () => undefined);
    const target = selectExactOwnedProviderSourceCard(discovery, fixture);
    await options.onReadyToIgnore();
    const ignored = parseIgnoreReceipt(await webContents.executeJavaScript(packagedProviderExactSourceIgnoreScript(target)));
    if (
        ignored.target.environment !== target.environment ||
        !sameWindowsPath(ignored.target.path, target.path) ||
        JSON.stringify(ignored.target.adapterIds) !== JSON.stringify(target.adapterIds) ||
        !ignored.includes.some(
            (selection) =>
                selection.environment === target.environment &&
                sameWindowsPath(selection.path, target.path) &&
                JSON.stringify(selection.adapterIds) === JSON.stringify(target.adapterIds),
        )
    ) {
        throw new Error("packaged Provider source ignore changed the exact target identity or omitted its default selection");
    }
    options.onIgnored();
    const postIgnore = await collectPackagedProviderSweepSnapshot(webContents);
    const expectedSources = discovery.sourceCards.map((source) =>
        source === target ? { ...source, state: "ignored" as const } : source,
    );
    if (
        JSON.stringify(postIgnore.contextReceipts) !== JSON.stringify(discovery.contextReceipts) ||
        JSON.stringify(postIgnore.sourceCards) !== JSON.stringify(expectedSources) ||
        JSON.stringify(postIgnore.projectProposals) !== JSON.stringify(discovery.projectProposals)
    ) {
        throw new Error("packaged Provider source ignore changed a sibling source, proposal, or Provider context");
    }
    const compactVisual = parseVisibleTargetReceipt(
        await webContents.executeJavaScript(packagedProviderIgnoredSourceCaptureScript(target)),
        target,
    );
    await options.capture("provider-source-ignore-compact");
    const entry = await webContents.executeJavaScript(PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT);
    if (!exactRecord(entry, ["status"]) || entry.status !== "ready")
        throw new TypeError("invalid repeated packaged Provider source-ignore entry receipt");
    await proveWindowsWslEnvironmentChoice(webContents, resolveWslHomePath, {
        selectedAdapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
    });
    const repeatedIgnored = await webContents.executeJavaScript(
        packagedProviderProjectSweepRepeatedIgnoredPathsScript([target.path]),
    );
    if (
        !exactRecord(repeatedIgnored, ["paths", "status"]) ||
        repeatedIgnored.status !== "complete" ||
        !Array.isArray(repeatedIgnored.paths) ||
        repeatedIgnored.paths.length !== 1 ||
        typeof repeatedIgnored.paths[0] !== "string" ||
        !sameWindowsPath(repeatedIgnored.paths[0], target.path)
    ) {
        throw new Error("packaged Provider source ignore did not retain the exact ignored source on repeated scan");
    }
    const repeated = await collectPackagedProviderSweepSnapshot(webContents);
    if (
        JSON.stringify(repeated.sourceCards) !== JSON.stringify(postIgnore.sourceCards) ||
        JSON.stringify(repeated.projectProposals) !== JSON.stringify(postIgnore.projectProposals)
    ) {
        throw new Error("packaged Provider source ignore changed source or proposal identities on repeated scan");
    }
    const repeatedVisual = parseVisibleTargetReceipt(
        await webContents.executeJavaScript(packagedProviderIgnoredSourceCaptureScript(target)),
        target,
    );
    await options.capture("provider-source-ignore-repeated");
    return Object.freeze({
        status: "complete" as const,
        fixture,
        discovery,
        target,
        canonicalDefaultIncludes: ignored.includes,
        postIgnore,
        repeated,
        visualReceipts: Object.freeze([compactVisual, repeatedVisual]),
    });
}
