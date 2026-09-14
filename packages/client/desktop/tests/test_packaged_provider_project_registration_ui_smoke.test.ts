import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
    assertExactProviderProjectRegistrationResolution,
    PACKAGED_PROVIDER_PROJECT_REGISTRATION_STAGES,
    selectExactOwnedProviderProjectProposal,
} from "../src/main/packaged-provider-project-registration-ui-smoke";
import {
    PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
    PACKAGED_PROVIDER_SOURCE_DESTINATION_IDENTITY_SCRIPT,
    proveWindowsPackagedProviderProjectRegistration,
} from "../src/main/packaged-provider-project-sweep-ui-smoke";
import {
    packagedProviderIgnoredSourceCaptureScript,
    proveWindowsPackagedProviderSourceIgnore,
    selectExactOwnedProviderSourceCard,
} from "../src/main/packaged-provider-source-ignore-ui-smoke";

const WINDOWS = JSON.stringify(["win32", "desktop-local"]);
const WSL = JSON.stringify(["wsl", "Ubuntu"]);
const ENVIRONMENTS = [WINDOWS, WSL];
const ROOT = "\\\\wsl.localhost\\Ubuntu\\tmp\\oaam-current";
const PROJECT = `${ROOT}\\projects\\onboarding-project`;
const SOURCE = `${ROOT}\\.config\\opencode`;
const NAMES = { initialDisplayName: "onboarding-project", submittedDisplayName: "onboarding-project — OAAM sweep 1" };
const fixture = Object.freeze({
    ownership: "current_run_exact_wsl_root" as const,
    environment: WSL,
    rootPath: ROOT,
    projectPath: PROJECT,
});
function snapshot() {
    return {
        contextReceipts: ENVIRONMENTS.flatMap((environment) =>
            PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS.map((adapterId) => ({
                environment,
                adapterId,
                status: "complete",
                installationStatus: "available",
                agentRuntimeIds: [`${adapterId}_ENTRY`],
                versionTexts: ["current"],
                diagnostics: [],
            })),
        ),
        sourceCards: [
            { environment: WSL, path: PROJECT, adapterIds: ["OPENCODE"], claimKinds: ["project_actual"], state: "included" },
            { environment: WSL, path: SOURCE, adapterIds: ["OPENCODE"], claimKinds: ["native"], state: "included" },
        ],
        projectProposals: [
            { key: "current-opencode", path: PROJECT, adapterIds: ["OPENCODE"], placement: "source_card", state: "actionable" },
            { key: "w1", path: "C:\\w1", adapterIds: ["CODEX"], placement: "source_card", state: "actionable" },
            { key: "w2", path: "C:\\w2", adapterIds: ["CURSOR"], placement: "source_card", state: "blocked" },
        ],
    } as const;
}

const discoveryValues = [
    { status: "ready", defaultEnvironment: WINDOWS, selectedEnvironments: ENVIRONMENTS },
    { status: "ready", selectedAdapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS },
    {
        status: "complete",
        defaultEnvironment: WINDOWS,
        selectedEnvironments: ENVIRONMENTS,
        probedEnvironments: ENVIRONMENTS,
        environmentResultStatuses: ENVIRONMENTS.map((environment) => [environment, "complete"]),
        selectedWslHomeSourcePath: SOURCE,
    },
] as const;

describe("packaged exact Provider Project registration", () => {
    it("reads the checked machine destination from the exact source card, independent of localized copy", () => {
        const collect = () =>
            runInNewContext(`(${PACKAGED_PROVIDER_SOURCE_DESTINATION_IDENTITY_SCRIPT})(card)`, {
                card: document.querySelector("#target"),
            });
        const render = (targetChoices: string, siblingChoices = "") => {
            document.body.innerHTML = `
                <article id="target" class="source-review-card">
                    <div class="source-watch-destination" data-oaam-source-destination="任意变化的展示文案">
                        ${targetChoices}
                    </div>
                </article>
                <article id="sibling" class="source-review-card">${siblingChoices}</article>`;
        };
        const choice = (identity: string, checked = false, name = "destination") =>
            `<label data-oaam-source-destination-choice="${identity}">
                <input type="radio" name="${name}" ${checked ? "checked" : ""}>localized label
            </label>`;

        render(choice("global", true) + choice("project"));
        expect(collect()).toBe("global");
        document.querySelector(".source-watch-destination")?.setAttribute("data-oaam-source-destination", "changed copy");
        expect(collect()).toBe("global");

        render(choice("global") + choice("project"));
        expect(collect).toThrow(/one checked machine destination/u);
        render(choice("global", true, "global") + choice("project", true, "project"));
        expect(collect).toThrow(/one checked machine destination/u);
        render(choice("elsewhere", true));
        expect(collect).toThrow(/invalid machine destination/u);
        render(choice("global"), choice("project", true));
        expect(collect).toThrow(/one checked machine destination/u);
    });

    it("scrolls and re-identifies the exact compact ignored card before capture", async () => {
        const target = snapshot().sourceCards[1];
        const render = (bounds: Partial<DOMRect> = {}) => {
            document.body.innerHTML = `<article class="source-review-card" data-oaam-source-environment-key='${WSL}'
                data-oaam-source-path="${SOURCE}" data-oaam-source-adapter-ids='["OPENCODE"]'
                data-oaam-source-state="ignored" data-oaam-source-selected="false"
                data-oaam-source-watch-selected="false"><button data-oaam-source-action="restore">恢复</button></article>`;
            const card = document.querySelector<HTMLElement>(".source-review-card");
            if (card === null) throw new Error("ignored-card fixture is missing");
            card.scrollIntoView = vi.fn();
            card.getBoundingClientRect = () => ({ width: 400, height: 80, top: 100, bottom: 180, ...bounds }) as DOMRect;
            return card;
        };
        const run = () =>
            runInNewContext(packagedProviderIgnoredSourceCaptureScript(target), {
                document,
                window: { innerHeight: 600 },
                HTMLElement,
                HTMLButtonElement,
                Promise,
                requestAnimationFrame: (callback: FrameRequestCallback) => callback(0),
            });
        render();
        expect(await run()).toMatchObject({ status: "ready", path: SOURCE, restoreActionCount: 1 });
        render().scrollIntoView = function (this: HTMLElement) {
            this.dataset.oaamSourcePath = `${SOURCE}-wrong`;
        };
        await expect(run()).rejects.toThrow(/re-identify the exact target/u);
        render({ top: 700, bottom: 780 });
        await expect(run()).rejects.toThrow(/not fully visible/u);
    });

    it("selects only the current-run OpenCode proposal and resolves it without a destination round trip", async () => {
        const before = snapshot();
        const after = structuredClone(before);
        after.projectProposals[0] = { ...after.projectProposals[0], state: "resolved" };
        const executionValues = [
            { status: "ready" },
            ...discoveryValues,
            { status: "ready", ...before },
            NAMES,
            {
                status: "complete",
                key: "current-opencode",
                path: PROJECT,
                placement: "source_card",
                ...NAMES,
                dialogClosed: true,
                proposalResolved: true,
                globalDestinationObserved: false,
                projectDestinationRestored: true,
                projectNameRestored: true,
            },
            { status: "ready", ...after },
        ];
        const executeJavaScript = vi.fn();
        for (const value of executionValues) executeJavaScript.mockResolvedValueOnce(value);
        const capture = vi.fn(async () => undefined);

        const proof = await proveWindowsPackagedProviderProjectRegistration(
            { executeJavaScript },
            () => ({ status: "available", homePath: ROOT }),
            fixture,
            { capture },
        );
        expect(proof).toMatchObject({
            status: "complete",
            registration: { key: "current-opencode", globalDestinationObserved: false },
            untouchedProposalKeys: ["w1", "w2"],
        });
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_PROVIDER_PROJECT_REGISTRATION_STAGES);
        expect(String(executeJavaScript.mock.calls[6]?.[0])).not.toContain("the temporary Global destination");
    });

    it("ignores one exact OpenCode source and preserves every sibling on repeat", async () => {
        const before = snapshot();
        const after = structuredClone(before);
        after.sourceCards[1] = { ...after.sourceCards[1], state: "ignored" };
        const visual = { status: "ready", environment: WSL, path: SOURCE, adapterIds: ["OPENCODE"], restoreActionCount: 1 };
        const values = [
            { status: "ready" },
            ...discoveryValues,
            { status: "ready", ...before },
            {
                status: "complete",
                target: after.sourceCards[1],
                canonicalDefaultIncludes: [{ environment: WSL, path: SOURCE, adapterIds: ["OPENCODE"], destination: "global" }],
            },
            { status: "ready", ...after },
            visual,
            { status: "ready" },
            ...discoveryValues,
            { status: "complete", paths: [SOURCE] },
            { status: "ready", ...after },
            visual,
        ];
        const executeJavaScript = vi.fn();
        for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
        const capture = vi.fn(async () => undefined);
        const onReadyToIgnore = vi.fn(async () => undefined);
        const onIgnored = vi.fn();
        await expect(
            proveWindowsPackagedProviderSourceIgnore(
                { executeJavaScript },
                () => ({ status: "available", homePath: ROOT }),
                { ...fixture, sourcePath: SOURCE },
                { capture, onReadyToIgnore, onIgnored },
            ),
        ).resolves.toMatchObject({ status: "complete", target: before.sourceCards[1] });
        expect(onReadyToIgnore).toHaveBeenCalledOnce();
        expect(onIgnored).toHaveBeenCalledOnce();
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual([
            "provider-source-ignore-compact",
            "provider-source-ignore-repeated",
        ]);
        const defaultInclude = values[5].canonicalDefaultIncludes[0];
        for (const [index, value, error] of [
            [5, null, /source-ignore receipt/u],
            [5, {}, /source-ignore receipt/u],
            [5, { ...values[5], canonicalDefaultIncludes: [{}] }, /default selection/u],
            [5, { ...values[5], canonicalDefaultIncludes: [defaultInclude, defaultInclude] }, /duplicate/u],
            [5, { ...values[5], target: { ...after.sourceCards[1], path: `${SOURCE}-stale` } }, /changed the exact target/u],
            [6, { status: "ready", ...before }, /changed a sibling source/u],
            [7, { status: "wrong" }, /ignored-source visual receipt/u],
            [8, { status: "wrong" }, /repeated packaged Provider source-ignore entry/u],
            [12, { status: "complete", paths: [] }, /did not retain the exact ignored source/u],
            [13, { status: "ready", ...before }, /changed source or proposal identities/u],
            [14, { status: "wrong" }, /ignored-source visual receipt/u],
        ] as const) {
            const failed = [...values];
            failed[index] = value;
            const executeFailure = vi.fn();
            for (const result of failed) executeFailure.mockResolvedValueOnce(result);
            await expect(
                proveWindowsPackagedProviderSourceIgnore(
                    { executeJavaScript: executeFailure },
                    () => ({ status: "available", homePath: ROOT }),
                    { ...fixture, sourcePath: SOURCE },
                    { capture: vi.fn(async () => undefined), onReadyToIgnore: vi.fn(async () => undefined), onIgnored: vi.fn() },
                ),
            ).rejects.toThrow(error);
        }
    });

    it("rejects stale or ambiguous fixture identity and any sibling proposal mutation", () => {
        const initial = snapshot();
        expect(() => selectExactOwnedProviderProjectProposal(initial, { ...fixture, rootPath: "C:\\" })).toThrow();
        expect(() =>
            selectExactOwnedProviderProjectProposal(
                { ...initial, projectProposals: [...initial.projectProposals, initial.projectProposals[0]] },
                fixture,
            ),
        ).toThrow(/did not find one exact current-run OpenCode proposal/u);
        expect(() =>
            selectExactOwnedProviderProjectProposal(
                { ...initial, sourceCards: [{ ...initial.sourceCards[0], environment: WINDOWS }] },
                fixture,
            ),
        ).toThrow(/candidates=1, sources=0/u);
        const target = selectExactOwnedProviderProjectProposal(initial, fixture);
        const final = structuredClone(initial.projectProposals);
        final[0] = { ...final[0], state: "resolved" };
        final[1] = { ...final[1], state: "resolved" };
        expect(() => assertExactProviderProjectRegistrationResolution(initial.projectProposals, final, target)).toThrow(
            /preserving every sibling/u,
        );
        const sourceFixture = { ...fixture, sourcePath: SOURCE };
        expect(selectExactOwnedProviderSourceCard(initial, sourceFixture)).toEqual(initial.sourceCards[1]);
        expect(() => selectExactOwnedProviderSourceCard(initial, { ...sourceFixture, sourcePath: ROOT })).toThrow(
            /fixture identity/u,
        );
        expect(() =>
            selectExactOwnedProviderSourceCard(
                {
                    ...initial,
                    projectProposals: [
                        ...initial.projectProposals,
                        { ...initial.projectProposals[0], key: "overlap", path: SOURCE },
                    ],
                },
                sourceFixture,
            ),
        ).toThrow(/overlappingProjects=1/u);
    });
});
