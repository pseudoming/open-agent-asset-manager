import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT,
    packagedProviderProjectSweepEnterProjectContextScript,
} from "../src/main/packaged-provider-project-sweep-ui-script-support";
import {
    PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
    PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES,
    PackagedProviderProjectSweepScreenshotProof,
    parsePackagedProviderSweepSnapshot,
    proveWindowsPackagedProviderDiscoveryReview,
    proveWindowsPackagedProviderProjectSweep,
} from "../src/main/packaged-provider-project-sweep-ui-smoke";
import { proveWindowsPackagedRetainedProjectRecovery } from "../src/main/packaged-retained-project-recovery-ui-smoke";
import { projectSweepContextReceipts } from "./packaged-provider-project-sweep-test-support";

const WINDOWS = JSON.stringify(["win32", "desktop-local"]);
const WSL = JSON.stringify(["wsl", "Ubuntu-24.04"]);
const FUND_LISTEN = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\wsl_code\\fund-listen";
const OPENCODE_SOURCE = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\.config\\opencode";
const CODEX_SOURCE = "C:\\Users\\Example\\.codex";
const IGNORED_PATHS = Object.freeze([OPENCODE_SOURCE, CODEX_SOURCE]);
const roots: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(projectState: "actionable" | "blocked" = "actionable") {
    return {
        status: "ready",
        contextReceipts: projectSweepContextReceipts(WINDOWS, WSL),
        sourceCards: [
            {
                environment: WSL,
                path: FUND_LISTEN,
                adapterIds: ["ANTIGRAVITY"],
                claimKinds: ["project_actual"],
                state: "included",
            },
            {
                environment: WSL,
                path: OPENCODE_SOURCE,
                adapterIds: ["OPENCODE"],
                claimKinds: ["agent_runtime_private"],
                state: "included",
            },
            {
                environment: WINDOWS,
                path: CODEX_SOURCE,
                adapterIds: ["CODEX"],
                claimKinds: ["agent_runtime_private"],
                state: "included",
            },
        ],
        projectProposals: [
            {
                key: "fund-listen-project",
                path: FUND_LISTEN,
                adapterIds: ["ANTIGRAVITY"],
                placement: "source_card",
                state: projectState,
            },
        ],
    };
}

function readability(value: ReturnType<typeof snapshot>) {
    return {
        status: "ready",
        contextIssues: value.contextReceipts
            .filter((context) => context.status !== "complete")
            .reverse()
            .map((context) => ({
                identity: `${context.environment}\0${context.adapterId}`,
                status: `${context.adapterId} · WSL`,
                reason: "This tool could only be checked in part.",
                actions: [],
            })),
        sourceCards: value.sourceCards.map((source) => ({
            identity: JSON.stringify([source.environment, source.path]),
            status: "",
            reason: "",
            actions: [],
        })),
        projectProposals: value.projectProposals.map((proposal) => ({
            identity: proposal.key,
            status: "Register as project",
            reason: proposal.state === "blocked" ? "This folder cannot be registered." : "",
            actions: [
                {
                    identity: "add",
                    subject: proposal.key,
                    label: "Register as project",
                    enabled: proposal.state === "actionable",
                    disabledReason: proposal.state === "blocked" ? "Registration is unavailable." : "",
                },
            ],
        })),
    };
}

function environmentProofValues(
    selectedAdapterIds: readonly string[] = PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
): readonly unknown[] {
    return [
        {
            status: "ready",
            defaultEnvironment: WINDOWS,
            selectedEnvironments: [WINDOWS, WSL],
        },
        {
            status: "ready",
            selectedAdapterIds,
        },
        {
            status: "complete",
            defaultEnvironment: WINDOWS,
            selectedEnvironments: [WINDOWS, WSL],
            probedEnvironments: [WINDOWS, WSL],
            environmentResultStatuses: [
                [WINDOWS, "complete"],
                [WSL, "partial"],
            ],
            selectedWslHomeSourcePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\.claude",
        },
    ];
}

function retainedRecoveryValues(): readonly unknown[] {
    const identity = {
        projectId: "99999999-9999-4999-8999-999999999999",
        displayName: "fund-listen — OAAM sweep 1",
        rootPath: FUND_LISTEN,
    };
    return [
        {
            status: "complete",
            ...identity,
            selectedProjectId: null,
            nonSelectedTargetVerified: false,
            continuedWithoutBackup: true,
            rememberChoiceFalse: true,
            rememberChoiceSwitchClickCount: 1,
            stoppedThroughReviewedLifecycle: true,
            activeTreeEntryAbsentAfterStop: true,
        },
        {
            status: "complete",
            ...identity,
            retainedHistoryCollapsed: true,
            retainedHistoryAfterPrimaryContent: true,
        },
        { status: "ready" },
        ...environmentProofValues(["ANTIGRAVITY"]),
        {
            status: "review_ready",
            ...identity,
            proposalKey: "fund-listen-project",
            exactRetainedProposalObserved: true,
            registrationDialogAbsent: true,
            restoreReviewBoundSameIdentity: true,
            restoreDialogAtDocumentBody: true,
            restoreBackdropCoversViewport: true,
            sourceScrollTopBefore: 420,
            sourceScrollTopAfterOpen: 420,
            sourceScrollPreservedOnOpen: true,
            rawRegistrationFailureAbsent: true,
        },
        {
            status: "complete",
            ...identity,
            restoredThroughReviewedLifecycle: true,
            finalActiveIdentityMatches: true,
            rawRegistrationFailureAbsent: true,
        },
    ];
}

function projectContextValues(): readonly unknown[] {
    return [
        {
            status: "ready",
            projectMenuInsideSelectedRow: true,
            projectMenuVisibleAtMinimumWidth: true,
        },
        {
            status: "ready",
            projectRootPath: FUND_LISTEN,
            selectedEnvironment: WSL,
            excludedEnvironmentCount: 1,
            incompatibleEnvironmentsDisabled: true,
        },
        {
            status: "ready",
            selectedAdapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
        },
        {
            status: "complete",
            projectRootPath: FUND_LISTEN,
            selectedEnvironment: WSL,
            probedEnvironment: WSL,
            environmentResultStatus: "partial",
            sourcePaths: [FUND_LISTEN],
        },
        {
            status: "complete",
            projectId: "99999999-9999-4999-8999-999999999999",
            displayName: "fund-listen — OAAM sweep 1",
            rootPath: FUND_LISTEN,
            projectMenuInsideSelectedRow: true,
            projectMenuVisibleAtMinimumWidth: true,
            selectedEnvironment: WSL,
            probedEnvironment: WSL,
            environmentResultStatus: "partial",
            excludedEnvironmentCount: 1,
            incompatibleEnvironmentsDisabled: true,
            routeBoundToExactProject: true,
            sourcePaths: [FUND_LISTEN],
        },
    ];
}

function successfulSweepValues(): unknown[] {
    return [
        { status: "ready" },
        ...environmentProofValues(),
        snapshot(),
        { initialDisplayName: "fund-listen", submittedDisplayName: "fund-listen — OAAM sweep 1" },
        {
            status: "complete",
            key: "fund-listen-project",
            path: FUND_LISTEN,
            placement: "source_card",
            initialDisplayName: "fund-listen",
            submittedDisplayName: "fund-listen — OAAM sweep 1",
            dialogClosed: true,
            proposalResolved: true,
            globalDestinationObserved: true,
            projectDestinationRestored: true,
            projectNameRestored: true,
        },
        {
            status: "complete",
            paths: IGNORED_PATHS,
        },
        { status: "complete", blocked: [], actionable: [] },
        { status: "complete", paths: IGNORED_PATHS },
        { status: "ready" },
        ...environmentProofValues(),
        {
            status: "complete",
            paths: IGNORED_PATHS,
        },
        { status: "complete", paths: IGNORED_PATHS },
        ...retainedRecoveryValues(),
        ...projectContextValues(),
    ];
}

function pngFixture(): Buffer {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(1_600, 16);
    bytes.writeUInt32BE(1_000, 20);
    return bytes;
}

function installGlobalLibraryEntry(onSelected: (library: HTMLElement) => void): HTMLElement {
    document.body.innerHTML = `
        <main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready">
            <button type="button" data-oaam-subject-choice="global" aria-selected="false">Global</button>
        </main>`;
    const library = document.querySelector<HTMLElement>("main");
    const globalChoice = document.querySelector<HTMLButtonElement>('[data-oaam-subject-choice="global"]');
    if (library === null || globalChoice === null) throw new Error("Global entry fixture is incomplete");
    globalChoice.addEventListener("click", () => {
        library.dataset.oaamSubject = "global";
        globalChoice.setAttribute("aria-selected", "true");
        onSelected(library);
    });
    return library;
}

function runProviderSweepEntry(overrides: Record<string, unknown> = {}): unknown {
    return runInNewContext(PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT, {
        document,
        Date,
        HTMLButtonElement,
        HTMLElement,
        Promise,
        setTimeout,
        ...overrides,
    });
}

describe("packaged Provider/Project sweep", () => {
    it("stops the standalone journey at readable source review and joins issues by exact context identity", async () => {
        const reviewed = snapshot("blocked");
        const run = (ordinary: unknown, full = false) => {
            const executeJavaScript = vi.fn();
            for (const value of [{ status: "ready" }, ...environmentProofValues(), reviewed, ordinary]) {
                executeJavaScript.mockResolvedValueOnce(value);
            }
            return {
                executeJavaScript,
                result: (full ? proveWindowsPackagedProviderProjectSweep : proveWindowsPackagedProviderDiscoveryReview)(
                    { executeJavaScript },
                    () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                    { capture: vi.fn(async () => undefined), recordTerminalObservation: vi.fn() },
                ),
            };
        };
        const success = run(readability(reviewed));
        await expect(success.result).resolves.toMatchObject({
            status: "complete",
            readability: { contextIssues: { length: 6 } },
        });
        expect(success.executeJavaScript).toHaveBeenCalledTimes(6);
        expect(await success.result).not.toHaveProperty("actionCounts");

        const duplicate = readability(reviewed);
        duplicate.contextIssues.push(duplicate.contextIssues[0]!);
        await expect(run(duplicate).result).rejects.toThrow(/duplicate packaged Provider-discovery ordinary identity/u);

        const contradictory = readability(reviewed);
        contradictory.projectProposals[0]!.reason = "";
        contradictory.projectProposals[0]!.actions[0]!.disabledReason = "";
        await expect(run(contradictory).result).rejects.toThrow(/contradicts its state/u);
        await expect(run({}).result).rejects.toThrow(/readability receipt/u);
        const malformed = readability(reviewed);
        malformed.sourceCards[0] = { ...malformed.sourceCards[0]!, identity: "" };
        await expect(run(malformed).result).rejects.toThrow(/ordinary presentation/u);
        reviewed.contextReceipts[0]!.status = "failed";
        await expect(run(readability(reviewed), true).result).rejects.toThrow(/failed Provider contexts/u);
    });

    it("re-enters a generic scan from the Sources workspace returned by the previous guided import", async () => {
        document.body.innerHTML = `
            <main data-oaam-route="sources" data-oaam-state="ready">
                <div class="library-toolbar-actions">
                    <button type="button" data-oaam-action="start-guided-import">Find assets</button>
                </div>
            </main>`;
        const start = document.querySelector<HTMLButtonElement>('[data-oaam-action="start-guided-import"]');
        if (start === null) throw new Error("Sources re-entry fixture is incomplete");
        start.addEventListener("click", () => {
            document.body.innerHTML = '<main data-oaam-route="guided_import" data-oaam-step="locations"></main>';
        });

        await expect(
            runInNewContext(PACKAGED_PROVIDER_PROJECT_SWEEP_ENTER_GENERIC_SCRIPT, {
                document,
                HTMLButtonElement,
                HTMLElement,
                Promise,
                setTimeout,
            }),
        ).resolves.toEqual({ status: "ready" });
    });

    it("waits for the delayed nonempty Global collection and its exact toolbar action", async () => {
        installGlobalLibraryEntry((library) => {
            setTimeout(() => {
                library.insertAdjacentHTML(
                    "beforeend",
                    `<section class="asset-collection" data-oaam-collection-id="global" data-oaam-total-count="2"></section>
                     <div class="library-toolbar-actions">
                         <button type="button" data-oaam-action="start-guided-import"
                             data-oaam-semantic-action="library.start_guided_import"
                             data-oaam-semantic-entry="library.guided_import.toolbar">Import</button>
                     </div>`,
                );
                library
                    .querySelector<HTMLButtonElement>('[data-oaam-semantic-entry="library.guided_import.toolbar"]')
                    ?.addEventListener("click", () => {
                        document.body.innerHTML = '<main data-oaam-route="guided_import" data-oaam-step="locations"></main>';
                    });
            }, 10);
        });

        await expect(runProviderSweepEntry()).resolves.toEqual({ status: "ready" });
    });

    it("uses the exact empty-collection action after the Global collection reaches its empty state", async () => {
        installGlobalLibraryEntry((library) => {
            setTimeout(() => {
                library.insertAdjacentHTML(
                    "beforeend",
                    `<section class="library-empty-state">
                         <div class="library-empty-actions">
                             <button type="button" data-oaam-action="start-guided-import"
                                 data-oaam-semantic-action="library.start_guided_import"
                                 data-oaam-semantic-entry="library.guided_import.empty_collection">Import</button>
                         </div>
                     </section>`,
                );
                library
                    .querySelector<HTMLButtonElement>('[data-oaam-semantic-entry="library.guided_import.empty_collection"]')
                    ?.addEventListener("click", () => {
                        document.body.innerHTML = '<main data-oaam-route="guided_import" data-oaam-step="locations"></main>';
                    });
            }, 10);
        });

        await expect(runProviderSweepEntry()).resolves.toEqual({ status: "ready" });
    });

    it.each([
        {
            label: "duplicate toolbar actions",
            body: `<section class="asset-collection" data-oaam-collection-id="global" data-oaam-total-count="2"></section>
                   <div class="library-toolbar-actions">
                       <button data-oaam-action="start-guided-import" data-oaam-semantic-action="library.start_guided_import"
                           data-oaam-semantic-entry="library.guided_import.toolbar">One</button>
                       <button data-oaam-action="start-guided-import" data-oaam-semantic-action="library.start_guided_import"
                           data-oaam-semantic-entry="library.guided_import.toolbar">Two</button>
                   </div>`,
        },
        {
            label: "toolbar and empty actions together",
            body: `<section class="asset-collection" data-oaam-collection-id="global" data-oaam-total-count="2"></section>
                   <div class="library-toolbar-actions">
                       <button data-oaam-action="start-guided-import" data-oaam-semantic-action="library.start_guided_import"
                           data-oaam-semantic-entry="library.guided_import.toolbar">Toolbar</button>
                   </div>
                   <section class="library-empty-state"><div class="library-empty-actions">
                       <button data-oaam-action="start-guided-import" data-oaam-semantic-action="library.start_guided_import"
                           data-oaam-semantic-entry="library.guided_import.empty_collection">Empty</button>
                   </div></section>`,
        },
    ])("rejects an ambiguous Global entry before input: $label", async ({ body }) => {
        installGlobalLibraryEntry((library) => library.insertAdjacentHTML("beforeend", body));

        await expect(runProviderSweepEntry()).rejects.toThrow(
            /Provider sweep Global guided-import action is ambiguous: .*"actions":\[/u,
        );
    });

    it("times out with the compact terminal state when a ready Global collection never exposes its action", async () => {
        installGlobalLibraryEntry((library) => {
            library.insertAdjacentHTML(
                "beforeend",
                '<section class="asset-collection" data-oaam-collection-id="global" data-oaam-total-count="2"></section>',
            );
        });
        let now = 0;
        const immediateTimeout = (resolve: () => void, milliseconds: number): number => {
            now += milliseconds;
            resolve();
            return 0;
        };

        await expect(runProviderSweepEntry({ Date: { now: () => now }, setTimeout: immediateTimeout })).rejects.toThrow(
            /timed out waiting for the contextual Global guided-import action: .*"pollCount":1200.*"globalCollectionTotalCount":2.*"actions":\[\]/u,
        );
    });

    it("explicitly selects the restored Project before opening its scoped import", async () => {
        const projectId = "99999999-9999-4999-8999-999999999999";
        const displayName = "fund-listen — OAAM sweep 1";
        document.body.innerHTML = `
            <main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready"
                data-oaam-project-id="11111111-1111-4111-8111-111111111111">
                <div class="asset-tree-project-item" data-selected="false">
                    <div class="asset-tree-project-row">
                        <button class="asset-tree-project" data-oaam-project-id="${projectId}">
                            <span class="asset-tree-project-label"><span>${displayName}</span></span>
                        </button>
                        <button data-oaam-action="manage-project" data-oaam-project-id="${projectId}"
                            data-tooltip="More actions" style="display:block;visibility:visible;opacity:1">…</button>
                    </div>
                </div>
                <div class="library-empty-actions"></div>
            </main>`;
        const library = document.querySelector<HTMLElement>("main");
        const project = document.querySelector<HTMLButtonElement>(".asset-tree-project");
        const menu = document.querySelector<HTMLButtonElement>('[data-oaam-action="manage-project"]');
        const emptyActions = document.querySelector<HTMLElement>(".library-empty-actions");
        if (library === null || project === null || menu === null || emptyActions === null) {
            throw new Error("restored Project selection fixture is incomplete");
        }
        project.addEventListener("click", () => {
            library.dataset.oaamProjectId = projectId;
            project.closest<HTMLElement>(".asset-tree-project-item")?.setAttribute("data-selected", "true");
            setTimeout(() => {
                const start = document.createElement("button");
                start.dataset.oaamAction = "start-guided-import";
                start.textContent = "Find this Project's assets";
                start.addEventListener("click", () => {
                    document.body.innerHTML = `<main data-oaam-route="guided_import" data-oaam-step="locations"
                        data-oaam-target-project-id="${projectId}"></main>`;
                });
                emptyActions.append(start);
            }, 10);
        });
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            return this === menu
                ? ({ left: 180, right: 212, top: 10, bottom: 42, width: 32, height: 32 } as DOMRect)
                : ({ left: 0, right: 224, top: 0, bottom: 52, width: 224, height: 52 } as DOMRect);
        });

        await expect(
            runInNewContext(
                packagedProviderProjectSweepEnterProjectContextScript({ projectId, displayName, rootPath: FUND_LISTEN }),
                {
                    document,
                    getComputedStyle,
                    HTMLButtonElement,
                    HTMLElement,
                    Promise,
                    requestAnimationFrame: (callback: FrameRequestCallback) => callback(0),
                    setTimeout,
                },
            ),
        ).resolves.toEqual({ status: "ready", projectMenuInsideSelectedRow: true, projectMenuVisibleAtMinimumWidth: true });
    });

    it("runs all six Providers across exact Windows and WSL, registers every proposal and compacts two ignored cards", async () => {
        const values = successfulSweepValues();
        const executeJavaScript = vi.fn();
        for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
        const capture = vi.fn(async () => undefined);

        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture },
            ),
        ).resolves.toMatchObject({
            status: "complete",
            adapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
            contextReceipts: { length: 12 },
            registrations: [{ key: "fund-listen-project", path: FUND_LISTEN }],
            compactIgnoredPaths: { length: 2 },
            ignoredPathsRestoredOnRepeatScan: true,
            finalBlockedProjectKeys: [],
            finalActionableProjectKeys: [],
            retainedProjectRecovery: {
                projectId: "99999999-9999-4999-8999-999999999999",
                rootPath: FUND_LISTEN,
                retainedHistoryCollapsed: true,
                finalActiveIdentityMatches: true,
            },
            contextualProjectImport: {
                projectId: "99999999-9999-4999-8999-999999999999",
                rootPath: FUND_LISTEN,
                selectedEnvironment: WSL,
                probedEnvironment: WSL,
                environmentResultStatus: "partial",
                excludedEnvironmentCount: 1,
                incompatibleEnvironmentsDisabled: true,
                sourcePaths: [FUND_LISTEN],
            },
        });
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES);
        expect(executeJavaScript).toHaveBeenCalledTimes(values.length);
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain("oaamProviderContextReceipts");
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("Project proposal is not uniquely actionable");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain("ignored Provider-sweep card retained expanded controls");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain(JSON.stringify([FUND_LISTEN]));
        expect(String(executeJavaScript.mock.calls[10]?.[0])).toContain("all-Provider sweep was incorrectly restricted");
        expect(String(executeJavaScript.mock.calls[10]?.[0])).toContain(
            "the library or Sources workspace before the Provider sweep",
        );
        expect(String(executeJavaScript.mock.calls[10]?.[0])).toContain(
            "Provider sweep has no unique guided-import action in the current Sources workspace",
        );
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("repeated scan did not return");
        expect(String(executeJavaScript.mock.calls[14]?.[0])).toContain("repeated scan did not return");
        expect(String(executeJavaScript.mock.calls[15]?.[0])).toContain("repeated scan did not return");
        expect(String(executeJavaScript.mock.calls[16]?.[0])).toContain("currentLibrary");
        expect(String(executeJavaScript.mock.calls[16]?.[0])).toContain(".source-library-back");
        expect(String(executeJavaScript.mock.calls[16]?.[0])).toContain('data-oaam-subject-choice="projects"');
        expect(String(executeJavaScript.mock.calls[17]?.[0])).toContain(".library-settings-button");
        expect(String(executeJavaScript.mock.calls[17]?.[0])).toContain(".retained-project-settings details.retained-projects");
        expect(String(executeJavaScript.mock.calls[17]?.[0])).toContain("Project management Settings");
        expect(String(executeJavaScript.mock.calls[16]?.[0])).toContain(
            "currentLibrary.querySelector('details.retained-projects') !== null",
        );
        expect(String(executeJavaScript.mock.calls[18]?.[0])).toContain('[data-oaam-action="start-guided-import"]');
        expect(String(executeJavaScript.mock.calls[18]?.[0])).toContain(".settings-return-button");
        expect(String(executeJavaScript.mock.calls[23]?.[0])).toContain(".retained-project-settings");
        expect(String(executeJavaScript.mock.calls[23]?.[0])).toContain("li[data-oaam-project-id]");
        expect(String(executeJavaScript.mock.calls[23]?.[0])).toContain("removed retained history");
        expect(String(executeJavaScript.mock.calls[24]?.[0])).toContain("Project management menu is clipped");
        expect(String(executeJavaScript.mock.calls[23]?.[0])).toContain(".source-library-back");
        expect(String(executeJavaScript.mock.calls[23]?.[0])).toContain('data-oaam-subject-choice="projects"');
        expect(String(executeJavaScript.mock.calls[28]?.[0])).toContain("unique concrete source locations");
        expect(String(executeJavaScript.mock.calls[28]?.[0])).not.toContain("sourcePath !== expected.rootPath");
    });

    it("fails closed when repeated-scan or Project-context receipts lose their exact identity", async () => {
        const run = (values: readonly unknown[]) => {
            const executeJavaScript = vi.fn();
            for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
            return proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture: vi.fn(async () => undefined) },
            );
        };
        const changed = (index: number, value: unknown): readonly unknown[] => {
            const values = successfulSweepValues();
            values[index] = value;
            return values;
        };
        const context = successfulSweepValues()[28] as Record<string, unknown>;

        await expect(run(changed(10, { status: "wrong" }))).rejects.toThrow("repeated packaged Provider-sweep entry");
        await expect(run(changed(14, { status: "complete", paths: [FUND_LISTEN] }))).rejects.toThrow(
            "changed the exact ignored locations",
        );
        await expect(run(changed(9, { status: "complete", paths: [FUND_LISTEN] }))).rejects.toThrow("first screenshot");
        await expect(run(changed(15, { status: "complete", paths: [FUND_LISTEN] }))).rejects.toThrow("repeated-scan screenshot");
        await expect(run(changed(7, { status: "complete", paths: [FUND_LISTEN, OPENCODE_SOURCE] }))).rejects.toThrow(
            "did not close every actionable Project",
        );
        await expect(run(changed(24, { status: "wrong" }))).rejects.toThrow("Project-context entry receipt");
        await expect(run(changed(28, { ...context, routeBoundToExactProject: false }))).rejects.toThrow(
            "Project-context receipt",
        );
        await expect(run(changed(28, { ...context, sourcePaths: [] }))).rejects.toThrow("Project-context source paths");
        await expect(run(changed(28, { ...context, sourcePaths: [`${FUND_LISTEN}\\AGENTS.md`] }))).resolves.toMatchObject({
            contextualProjectImport: {
                rootPath: FUND_LISTEN,
                sourcePaths: [`${FUND_LISTEN}\\AGENTS.md`],
            },
        });
        await expect(run(changed(28, { ...context, sourcePaths: [`${FUND_LISTEN}-sibling\\AGENTS.md`] }))).rejects.toThrow(
            "changed the exact registered Project identity",
        );
    });

    it("rejects an incomplete context matrix and a blocked Project before any registration input", async () => {
        const incomplete = snapshot();
        incomplete.contextReceipts.pop();
        expect(() => parsePackagedProviderSweepSnapshot(incomplete)).toThrow(
            "does not cover the exact six-Provider Windows/WSL matrix",
        );

        const executeJavaScript = vi.fn();
        for (const value of [{ status: "ready" }, ...environmentProofValues(), snapshot("blocked")]) {
            executeJavaScript.mockResolvedValueOnce(value);
        }
        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("blocked Project proposals");
        expect(executeJavaScript).toHaveBeenCalledTimes(5);

        const detached = snapshot();
        const detachedProposal = detached.projectProposals[0];
        if (detachedProposal === undefined) throw new Error("detached fixture proposal missing");
        detachedProposal.placement = "detached";
        const detachedExecution = vi.fn();
        for (const value of [{ status: "ready" }, ...environmentProofValues(), detached]) {
            detachedExecution.mockResolvedValueOnce(value);
        }
        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript: detachedExecution },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("detached actionable Project proposals");
    });

    it("rejects malformed nested receipts instead of trusting the packaged renderer", () => {
        const valid = snapshot();
        const malformed: unknown[] = [
            null,
            { ...valid, sourceCards: null },
            { ...valid, contextReceipts: [{ ...valid.contextReceipts[0], status: "surprise" }] },
            { ...valid, contextReceipts: [{ ...valid.contextReceipts[0], agentRuntimeIds: [1] }] },
            { ...valid, contextReceipts: [{ ...valid.contextReceipts[0], diagnostics: [{ code: "only" }] }] },
            {
                ...valid,
                contextReceipts: [
                    {
                        ...valid.contextReceipts[0],
                        diagnostics: [
                            { code: "probe.failed", causeKind: "partial", path: "C:\\fixture" },
                            { code: "probe.failed", causeKind: "partial", path: "C:\\fixture" },
                        ],
                    },
                ],
            },
            { ...valid, sourceCards: [{ ...valid.sourceCards[0], state: "surprise" }] },
            { ...valid, sourceCards: [{ ...valid.sourceCards[0], claimKinds: [] }] },
            { ...valid, projectProposals: [{ ...valid.projectProposals[0], placement: "elsewhere" }] },
            { ...valid, projectProposals: [{ ...valid.projectProposals[0], adapterIds: [] }] },
            {
                ...valid,
                contextReceipts: valid.contextReceipts.map((entry) => ({
                    ...entry,
                    environment: entry.environment === WSL ? "not-json" : entry.environment,
                })),
            },
        ];

        for (const value of malformed) expect(() => parsePackagedProviderSweepSnapshot(value)).toThrow();
    });

    it("captures the first-registration stage even when the exact matrix has no Project proposal", async () => {
        const noProjects = snapshot();
        noProjects.projectProposals = [];
        const values: unknown[] = [
            { status: "ready" },
            ...environmentProofValues(),
            noProjects,
            { status: "complete", paths: noProjects.sourceCards.slice(0, 2).map((card) => card.path) },
            { status: "complete", blocked: [], actionable: [] },
            { status: "complete", paths: noProjects.sourceCards.slice(0, 2).map((card) => card.path) },
            { status: "ready" },
            ...environmentProofValues(),
            { status: "complete", paths: noProjects.sourceCards.slice(0, 2).map((card) => card.path) },
            { status: "complete", paths: noProjects.sourceCards.slice(0, 2).map((card) => card.path) },
        ];
        const executeJavaScript = vi.fn();
        for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
        const capture = vi.fn(async () => undefined);

        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture },
            ),
        ).resolves.toMatchObject({ registrations: [] });
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES.slice(0, 5));
    });

    it("fails closed for invalid entry, edited-name, and final-closure receipts", async () => {
        const invalidEntry = vi.fn().mockResolvedValueOnce({ status: "wrong" });
        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript: invalidEntry },
                () => ({ status: "unavailable", reason: "not_found" }),
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("entry receipt");

        const invalidName = vi.fn();
        for (const value of [
            { status: "ready" },
            ...environmentProofValues(),
            snapshot(),
            { initialDisplayName: 42, submittedDisplayName: "fund-listen" },
        ]) {
            invalidName.mockResolvedValueOnce(value);
        }
        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript: invalidName },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("edited name receipt");

        const incompleteClosure = vi.fn();
        for (const value of [
            { status: "ready" },
            ...environmentProofValues(),
            snapshot(),
            { initialDisplayName: "fund-listen", submittedDisplayName: "fund-listen — OAAM sweep 1" },
            {
                status: "complete",
                key: "fund-listen-project",
                path: FUND_LISTEN,
                placement: "source_card",
                initialDisplayName: "fund-listen",
                submittedDisplayName: "fund-listen — OAAM sweep 1",
                dialogClosed: true,
                proposalResolved: true,
                globalDestinationObserved: true,
                projectDestinationRestored: true,
                projectNameRestored: true,
            },
            { status: "complete", paths: [FUND_LISTEN] },
            { status: "complete", blocked: [], actionable: [] },
        ]) {
            incompleteClosure.mockResolvedValueOnce(value);
        }
        await expect(
            proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript: incompleteClosure },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("did not close every actionable Project");
    });

    it("rejects malformed registration, compact-ignore, and final Project inventories", async () => {
        const names = { initialDisplayName: "fund-listen", submittedDisplayName: "fund-listen — OAAM sweep 1" };
        const registration = {
            status: "complete",
            key: "fund-listen-project",
            path: FUND_LISTEN,
            placement: "source_card",
            ...names,
            dialogClosed: true,
            proposalResolved: true,
            globalDestinationObserved: true,
            projectDestinationRestored: true,
            projectNameRestored: true,
        };
        const prefix = [{ status: "ready" }, ...environmentProofValues(), snapshot(), names];
        const run = (values: readonly unknown[]) => {
            const executeJavaScript = vi.fn();
            for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
            return proveWindowsPackagedProviderProjectSweep(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                { capture: vi.fn(async () => undefined) },
            );
        };

        await expect(run([...prefix, { ...registration, dialogClosed: false }])).rejects.toThrow("registration receipt");
        await expect(run([...prefix, { ...registration, projectNameRestored: false }])).rejects.toThrow("registration receipt");
        await expect(run([...prefix, registration, { status: "wrong", paths: [] }])).rejects.toThrow("compact ignore receipt");
        await expect(
            run([
                ...prefix,
                registration,
                { status: "complete", paths: IGNORED_PATHS },
                { status: "wrong", blocked: [], actionable: [] },
            ]),
        ).rejects.toThrow("final Project state");
        await expect(
            run([
                ...prefix,
                registration,
                { status: "complete", paths: IGNORED_PATHS },
                { status: "complete", blocked: [1], actionable: [] },
            ]),
        ).rejects.toThrow("final Project keys");
    });

    it("fails closed when any retained-Project lifecycle receipt changes shape or exact identity", async () => {
        const subject = {
            displayName: "fund-listen — OAAM sweep 1",
            rootPath: FUND_LISTEN,
            adapterIds: ["ANTIGRAVITY"],
        } as const;
        const run = (values: readonly unknown[]) => {
            const executeJavaScript = vi.fn();
            for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
            return proveWindowsPackagedRetainedProjectRecovery(
                { executeJavaScript },
                () => ({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example" }),
                subject,
                { capture: vi.fn(async () => undefined) },
            );
        };
        const changed = (index: number, value: unknown): readonly unknown[] => {
            const values = [...retainedRecoveryValues()];
            values[index] = value;
            return values;
        };
        const stopped = retainedRecoveryValues()[0] as Record<string, unknown>;
        const review = retainedRecoveryValues()[6] as Record<string, unknown>;
        const final = retainedRecoveryValues()[7] as Record<string, unknown>;

        await expect(run([{ status: "wrong" }])).rejects.toThrow("stopped-Project receipt");
        await expect(
            run(changed(0, { ...stopped, rootPath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\other" })),
        ).rejects.toThrow("changed the requested subject");
        await expect(run(changed(1, { status: "wrong" }))).rejects.toThrow("retained-Project history receipt");
        await expect(run(changed(2, { status: "wrong" }))).rejects.toThrow("rediscovery entry receipt");
        await expect(run(changed(6, { status: "wrong" }))).rejects.toThrow("restore review receipt");
        await expect(run(changed(6, { ...review, restoreBackdropCoversViewport: false }))).rejects.toThrow(
            "restore review receipt",
        );
        await expect(run(changed(6, { ...review, sourceScrollTopAfterOpen: 680 }))).rejects.toThrow("restore review receipt");
        await expect(run(changed(6, { ...review, projectId: "88888888-8888-4888-8888-888888888888" }))).rejects.toThrow(
            "changed the stopped identity",
        );
        await expect(run(changed(7, { status: "wrong" }))).rejects.toThrow("restored-Project receipt");
        await expect(
            run(changed(7, { ...final, rootPath: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\other" })),
        ).rejects.toThrow("changed the reviewed identity");
    });

    it("writes only the exact immutable screenshot inventory and nested proof", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-provider-project-sweep-"));
        roots.push(parent);
        const root = path.join(parent, "proof");
        const screenshots = new PackagedProviderProjectSweepScreenshotProof(root);
        const capturePage = vi.fn(async () => ({ toPNG: () => pngFixture() }));
        for (const stage of PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES) {
            await screenshots.capture(stage, { capturePage });
        }
        const proof = {
            status: "complete" as const,
            adapterIds: PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS,
            contextReceipts: projectSweepContextReceipts(WINDOWS, WSL),
            sourceCards: snapshot().sourceCards,
            initialProjectProposals: snapshot().projectProposals,
            registrations: [
                {
                    key: "fund-listen-project",
                    path: FUND_LISTEN,
                    placement: "source_card" as const,
                    initialDisplayName: "fund-listen",
                    submittedDisplayName: "fund-listen — OAAM sweep 1",
                    dialogClosed: true as const,
                    proposalResolved: true as const,
                    globalDestinationObserved: true as const,
                    projectDestinationRestored: true as const,
                    projectNameRestored: true as const,
                },
            ],
            compactIgnoredPaths: IGNORED_PATHS,
            ignoredPathsRestoredOnRepeatScan: true as const,
            finalBlockedProjectKeys: [] as const,
            finalActionableProjectKeys: [] as const,
            retainedProjectRecovery: {
                status: "complete" as const,
                projectId: "99999999-9999-4999-8999-999999999999",
                displayName: "fund-listen — OAAM sweep 1",
                rootPath: FUND_LISTEN,
                stoppedThroughReviewedLifecycle: true as const,
                activeTreeEntryAbsentAfterStop: true as const,
                retainedHistoryCollapsed: true as const,
                retainedHistoryAfterPrimaryContent: true as const,
                exactRetainedProposalObserved: true as const,
                registrationDialogAbsent: true as const,
                restoreReviewBoundSameIdentity: true as const,
                restoreDialogAtDocumentBody: true as const,
                restoreBackdropCoversViewport: true as const,
                sourceScrollTopBefore: 420,
                sourceScrollTopAfterOpen: 420,
                sourceScrollPreservedOnOpen: true as const,
                restoredThroughReviewedLifecycle: true as const,
                finalActiveIdentityMatches: true as const,
                rawRegistrationFailureAbsent: true as const,
            },
            contextualProjectImport: {
                projectId: "99999999-9999-4999-8999-999999999999",
                displayName: "fund-listen — OAAM sweep 1",
                rootPath: FUND_LISTEN,
                projectMenuInsideSelectedRow: true as const,
                projectMenuVisibleAtMinimumWidth: true as const,
                selectedEnvironment: WSL,
                probedEnvironment: WSL,
                environmentResultStatus: "partial" as const,
                excludedEnvironmentCount: 1,
                incompatibleEnvironmentsDisabled: true as const,
                routeBoundToExactProject: true as const,
                sourcePaths: [FUND_LISTEN],
            },
        };
        screenshots.finalize(proof);

        expect(fs.readdirSync(root).sort()).toEqual(
            [...PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES.map((stage) => `${stage}.png`), "manifest.json"].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))).toEqual({
            schemaVersion: 1,
            stages: PACKAGED_PROVIDER_PROJECT_SWEEP_STAGES.map((stage) => ({ stage, fileName: `${stage}.png` })),
            proof,
        });
        await expect(screenshots.capture("provider-sweep-locations", { capturePage })).rejects.toThrow("captured twice");
    });

    it("rejects non-PNG and incomplete screenshot evidence", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-provider-project-sweep-negative-"));
        roots.push(parent);
        const screenshots = new PackagedProviderProjectSweepScreenshotProof(path.join(parent, "proof"));
        await expect(
            screenshots.capture("provider-sweep-locations", {
                capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(24) })),
            }),
        ).rejects.toThrow("is not a PNG");
        screenshots.recordAuthorityChange({ changed: true });
        expect(fs.existsSync(path.join(parent, "proof", "authority-change.json"))).toBe(true);
        expect(() => screenshots.finalize({} as never)).toThrow("screenshots are incomplete");
    });
});
