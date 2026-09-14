import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoverySourceReview } from "../src/renderer/features/discovery/DiscoverySourceReview";
import {
    classifyDiscoverySources,
    defaultDiscoveryReadSourceKeys,
    defaultDiscoveryWatchSelections,
    deriveDiscoveryProjectProposals,
    groupDiscoverySourceClaims,
    type ProbeReviewView,
    type WatchedScanIntentView,
} from "../src/renderer/features/discovery/discovery-model";
import { toggleInteractionDisclosure } from "./desktop-interaction-test-harness";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { EMPTY_WATCHED, ENVIRONMENT, PROBE, PROVIDERS, probeSource, required, watchedSelector } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Desktop discovery source review", () => {
    it("keeps Global and Project ownership plus ignore in one compact decision row", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const path = "/home/user/shared-assets";
        const probe: ProbeReviewView = {
            probeToken: "shared-source-destination",
            results: [
                {
                    ...baseResult,
                    rowId: "shared-result",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["shared-root"] }],
                    sources: [
                        {
                            ...probeSource("shared-root", "shared-assets", path),
                            sourceDomain: "family_shared",
                        },
                    ],
                },
            ],
        };
        const projects = [
            {
                projectId: "11111111-1111-4111-8111-111111111111",
                displayName: "Example Project",
                rootPath: "/home/user/example-project",
                deleted: false,
                createdAt: 1,
                updatedAt: 1,
            },
            {
                projectId: "22222222-2222-4222-8222-222222222222",
                displayName: "Second Project",
                rootPath: "/home/user/second-project",
                deleted: false,
                createdAt: 2,
                updatedAt: 2,
            },
        ];
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);
        const onWatchSelectionsChange = vi.fn();

        const view = renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects,
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: defaultDiscoveryWatchSelections(sources, projects),
                onSelectedSourceKeysChange: vi.fn(),
                onWatchSelectionsChange,
            }),
        );

        const card = required(screen.getByText(path, { selector: "code" }).closest("li"), "shared source card");
        expect(card.dataset.oaamSourceEnvironmentKey).toBe(
            JSON.stringify([ENVIRONMENT.platform, ENVIRONMENT.platformInstanceId]),
        );
        const decisionRow = required(
            card.querySelector<HTMLElement>('[data-oaam-source-control-layout="destination_and_ignore"]'),
            "compact decision row",
        );
        const destination = within(decisionRow).getByRole("radiogroup", { name: "Store in library" });
        const globalChoice = within(destination).getByRole<HTMLInputElement>("radio", { name: "Global" });
        const projectChoice = within(destination).getByRole<HTMLInputElement>("radio", { name: "Project" });

        expect(globalChoice.checked).toBe(true);
        expect(projectChoice.checked).toBe(false);
        expect(within(decisionRow).getByRole("button", { name: "Ignore this location" })).not.toBeNull();
        expect(
            required(within(card).getByText("Technical details").closest("details"), "technical details").classList.contains(
                "source-technical-details",
            ),
        ).toBe(true);
        expect(card.querySelector(".source-review-owner")).toBeNull();
        expect((within(card).getByRole("radio", { name: "Global" }) as HTMLInputElement).checked).toBe(true);

        fireEvent.click(projectChoice);
        expect(projectChoice.checked).toBe(true);
        expect(globalChoice.checked).toBe(false);
        fireEvent.click(screen.getByRole("combobox", { name: "Choose a Project" }));
        fireEvent.click(screen.getByRole("option", { name: /Example Project/u }));
        expect(onWatchSelectionsChange).toHaveBeenCalledWith([
            {
                sourceKey: "fresh:shared-result:shared-root",
                binding: { assetScope: "project", projectId: required(projects[0], "Example Project").projectId },
            },
        ]);

        onWatchSelectionsChange.mockClear();
        view.rerender(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects: projects.slice(0, 1),
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: defaultDiscoveryWatchSelections(sources, projects.slice(0, 1)),
                onSelectedSourceKeysChange: vi.fn(),
                onWatchSelectionsChange,
            }),
        );
        fireEvent.click(screen.getByRole("radio", { name: "Project" }));
        expect(onWatchSelectionsChange).toHaveBeenCalledWith([
            {
                sourceKey: "fresh:shared-result:shared-root",
                binding: { assetScope: "project", projectId: required(projects[0], "Example Project").projectId },
            },
        ]);
        fireEvent.click(screen.getByRole("button", { name: "Ignore this location" }));
        fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
        expect(screen.queryByText("Ignore this location?")).toBeNull();

        view.rerender(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects,
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: [
                    {
                        sourceKey: "fresh:shared-result:shared-root",
                        binding: {
                            assetScope: "project",
                            projectId: required(projects[0], "Example Project").projectId,
                        },
                    },
                ],
                onSelectedSourceKeysChange: vi.fn(),
                onWatchSelectionsChange,
            }),
        );
        expect(screen.getByRole("combobox", { name: "Choose a Project" }).textContent).toContain("Example Project");
        expect(screen.queryByText("Example Project", { selector: "small" })).toBeNull();

        view.rerender(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: defaultDiscoveryWatchSelections(sources),
                onSelectedSourceKeysChange: vi.fn(),
                onWatchSelectionsChange,
            }),
        );
        expect(screen.getByRole<HTMLInputElement>("radio", { name: "Project" }).disabled).toBe(true);
        expect(screen.getByText("Register a Project in OAAM before choosing the Project library.")).not.toBeNull();
    });

    it("selects the sole available Project without entering an empty chooser", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const path = "/home/user/one-project-source";
        const probe: ProbeReviewView = {
            probeToken: "sole-project-destination",
            results: [
                {
                    ...baseResult,
                    rowId: "sole-project-result",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["sole-project-source"] }],
                    sources: [
                        {
                            ...probeSource("sole-project-source", "sole-project-source", path),
                            sourceDomain: "family_shared",
                        },
                    ],
                },
            ],
        };
        const project = {
            projectId: "33333333-3333-4333-8333-333333333333",
            displayName: "Only Project",
            rootPath: "/home/user/only-project",
            deleted: false,
            createdAt: 1,
            updatedAt: 1,
        };
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);
        const onWatchSelectionsChange = vi.fn();
        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects: [project],
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: defaultDiscoveryWatchSelections(sources, [project]),
                onSelectedSourceKeysChange: vi.fn(),
                onWatchSelectionsChange,
            }),
        );

        fireEvent.click(screen.getByRole("radio", { name: "Project" }));
        expect(onWatchSelectionsChange).toHaveBeenCalledWith([
            {
                sourceKey: "fresh:sole-project-result:sole-project-source",
                binding: { assetScope: "project", projectId: project.projectId },
            },
        ]);
        expect(screen.queryByRole("combobox", { name: "Choose a Project" })).toBeNull();
    });

    it("joins an exact observed Project proposal to its source card without a name or Provider heuristic", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const path = "/work/arbitrary-folder-7";
        const projectRoot = {
            ...probeSource("arbitrary-root", "arbitrary-project-root", path),
            rootRole: "project_actual" as const,
        };
        const probe: ProbeReviewView = {
            probeToken: "exact-project-card",
            results: [
                {
                    ...baseResult,
                    rowId: "project-result",
                    adapterId: "OPENCODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: [projectRoot.rowId] }],
                    sources: [projectRoot],
                    projects: [
                        {
                            rowId: "observed-project-row",
                            observedProjectId: "runtime-project-key",
                            displayName: "Unrelated display label",
                            workspaceSourceRowIds: [projectRoot.rowId],
                            containedSourceRootRowIds: [projectRoot.rowId],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);
        const proposal = required(deriveDiscoveryProjectProposals(probe, [])[0], "exact Project proposal");
        const onAddProjectProposal = vi.fn();
        const onProjectProposalSkippedChange = vi.fn();
        const onSelectedSourceKeysChange = vi.fn();
        const onWatchSelectionsChange = vi.fn();

        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projectDecisions: new Map(),
                projectProposals: [proposal],
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: defaultDiscoveryWatchSelections(sources),
                onAddProjectProposal,
                onProjectProposalSkippedChange,
                onSelectedSourceKeysChange,
                onWatchSelectionsChange,
            }),
        );

        const card = required(screen.getByText(path, { selector: "code" }).closest("li"), "exact Project source card");
        expect(card.dataset.oaamProjectProposalKey).toBe(proposal.key);
        const destination = within(card).getByRole("radiogroup", { name: "Store in library" });
        expect(within(destination).getByRole<HTMLInputElement>("radio", { name: "Project" }).checked).toBe(true);
        expect(within(destination).getByRole<HTMLInputElement>("radio", { name: "Project" }).disabled).toBe(false);
        const globalChoice = within(destination).getByRole<HTMLInputElement>("radio", { name: "Global" });
        expect(globalChoice.disabled).toBe(false);
        expect(within(card).getAllByText("Unrelated display label")).toHaveLength(1);
        expect(within(card).getByText("Unrelated display label", { selector: ".source-destination-current" })).not.toBeNull();

        fireEvent.click(globalChoice);
        expect(onWatchSelectionsChange).toHaveBeenCalledWith([
            {
                sourceKey: "fresh:project-result:arbitrary-root",
                binding: { assetScope: "global" },
            },
        ]);

        fireEvent.click(within(card).getByRole("button", { name: "Register as Project" }));
        expect(onAddProjectProposal).toHaveBeenCalledWith(proposal);
        fireEvent.click(within(card).getByRole("button", { name: "Ignore this location" }));
        fireEvent.click(within(card).getByRole("button", { name: "Ignore" }));
        expect(onSelectedSourceKeysChange).toHaveBeenCalledWith([]);
        expect(onWatchSelectionsChange).toHaveBeenCalledWith([]);
        expect(onProjectProposalSkippedChange).toHaveBeenCalledWith(proposal, true);
        fireEvent.click(within(card).getByRole("button", { name: "Include again" }));
        expect(onProjectProposalSkippedChange).toHaveBeenLastCalledWith(proposal, false);
    });

    it("keeps Project registration progress local to the active source card", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const firstRoot = {
            ...probeSource("first-project-root", "first-project-root", "/work/first-project"),
            rootRole: "project_actual" as const,
        };
        const secondRoot = {
            ...probeSource("second-project-root", "second-project-root", "/work/second-project"),
            rootRole: "project_actual" as const,
        };
        const probe: ProbeReviewView = {
            probeToken: "project-card-busy-state",
            results: [
                {
                    ...baseResult,
                    rowId: "project-result",
                    runtimes: [
                        {
                            ...baseRuntime,
                            sourceRootRowIds: [firstRoot.rowId, secondRoot.rowId],
                        },
                    ],
                    sources: [firstRoot, secondRoot],
                    projects: [
                        {
                            rowId: "first-project-row",
                            observedProjectId: "first-project",
                            displayName: "First project",
                            workspaceSourceRowIds: [firstRoot.rowId],
                            containedSourceRootRowIds: [firstRoot.rowId],
                            diagnostics: [],
                        },
                        {
                            rowId: "second-project-row",
                            observedProjectId: "second-project",
                            displayName: "Second project",
                            workspaceSourceRowIds: [secondRoot.rowId],
                            containedSourceRootRowIds: [secondRoot.rowId],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);
        const proposals = deriveDiscoveryProjectProposals(probe, []);
        const firstProposal = required(
            proposals.find((proposal) => proposal.rootPath === firstRoot.displayPath),
            "first Project proposal",
        );

        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projectDecisions: new Map(),
                projectPendingKey: firstProposal.key,
                projectProposals: proposals,
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys: defaultDiscoveryReadSourceKeys(groups),
                watchSelections: defaultDiscoveryWatchSelections(sources),
                onAddProjectProposal: vi.fn(),
                onSelectedSourceKeysChange: vi.fn(),
                onWatchSelectionsChange: vi.fn(),
            }),
        );

        const firstCard = required(screen.getByText(firstRoot.displayPath, { selector: "code" }).closest("li"), "first card");
        const secondCard = required(screen.getByText(secondRoot.displayPath, { selector: "code" }).closest("li"), "second card");
        const activeButton = within(firstCard).getByRole<HTMLButtonElement>("button", { name: "Registering…" });
        const blockedButton = within(secondCard).getByRole<HTMLButtonElement>("button", { name: "Register as Project" });

        expect(firstCard.querySelector("[aria-busy='true']")).not.toBeNull();
        expect(secondCard.querySelector("[aria-busy='true']")).toBeNull();
        expect(activeButton.dataset.oaamProjectRegistrationState).toBe("pending");
        expect(blockedButton.dataset.oaamProjectRegistrationState).toBe("blocked_by_other");
        expect(activeButton.disabled).toBe(true);
        expect(blockedButton.disabled).toBe(true);
        expect(blockedButton.title).toBe("Finish registering the other Project first.");
    });

    it("keeps an ambiguous source out of the current read even when a prior future-scan binding exists", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const path = "/home/user/shared-private";
        const probe: ProbeReviewView = {
            probeToken: "ambiguous-with-watch",
            results: [
                {
                    ...baseResult,
                    rowId: "claude-private",
                    adapterId: "CLAUDECODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["claude-root"] }],
                    sources: [
                        {
                            ...probeSource("claude-root", "claude-private", path),
                            sourceDomain: "agent_runtime_private",
                        },
                    ],
                },
                {
                    ...baseResult,
                    rowId: "opencode-private",
                    adapterId: "OPENCODE",
                    runtimes: [
                        {
                            ...baseRuntime,
                            rowId: "opencode-runtime",
                            agentRuntimeId: "OPENCODE_CLI",
                            sourceRootRowIds: ["opencode-root"],
                        },
                    ],
                    sources: [
                        {
                            ...probeSource("opencode-root", "opencode-private", path),
                            sourceDomain: "agent_runtime_private",
                        },
                    ],
                },
            ],
        };
        const priorSelector = watchedSelector("claude-private", path);
        const watched: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        {
                            ...priorSelector,
                            source: { ...priorSelector.source, sourceDomain: "agent_runtime_private" },
                        },
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources(watched, probe);
        const onSelectedSourceKeysChange = vi.fn();
        const onWatchSelectionsChange = vi.fn();

        const view = renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups: groupDiscoverySourceClaims(sources, probe),
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys: [],
                watchSelections: defaultDiscoveryWatchSelections(sources),
                onSelectedSourceKeysChange,
                onWatchSelectionsChange,
            }),
        );

        const card = required(screen.getByText(path, { selector: "code" }).closest("li"), "ambiguous source card");
        expect(card.dataset.oaamSourceState).toBe("requires_review");
        expect(card.dataset.oaamSourceWatchSelected).toBe("true");
        toggleInteractionDisclosure("features.discovery.discovery_source_review.011", view.container);
        fireEvent.click(within(card).getByRole("button", { name: "Use for this scan" }));
        expect(onSelectedSourceKeysChange).toHaveBeenCalledWith([
            "fresh:claude-private:claude-root",
            "fresh:opencode-private:opencode-root",
        ]);
        fireEvent.click(within(card).getByRole("button", { name: "Ignore this location" }));
        expect(within(card).getByText("Ignore this location?")).not.toBeNull();
    });

    it("rolls back an ignored card when its immediate follow-location save fails", async () => {
        const sources = classifyDiscoverySources(EMPTY_WATCHED, PROBE);
        const groups = groupDiscoverySourceClaims(sources, PROBE);
        const selectedSourceKeys = defaultDiscoveryReadSourceKeys(groups);
        const watchSelections = defaultDiscoveryWatchSelections(sources);
        const onSelectedSourceKeysChange = vi.fn();
        const onWatchSelectionsChange = vi.fn();
        const onPersistWatchSelections = vi.fn(async () => false);
        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys,
                watchSelections,
                onPersistWatchSelections,
                onSelectedSourceKeysChange,
                onWatchSelectionsChange,
            }),
        );

        const card = required(screen.getByText("/brand-new", { selector: "code" }).closest("li"), "source card");
        fireEvent.click(within(card).getByRole("button", { name: "Ignore this location" }));
        fireEvent.click(within(card).getByRole("button", { name: "Ignore" }));

        await vi.waitFor(() => expect(onPersistWatchSelections).toHaveBeenCalledOnce());
        expect(onPersistWatchSelections).toHaveBeenCalledWith([], ["fresh:result-1:source-new"]);
        await vi.waitFor(() => expect(card.dataset.oaamSourceState).toBe("included"));
        expect(onSelectedSourceKeysChange).toHaveBeenLastCalledWith(selectedSourceKeys);
        expect(onWatchSelectionsChange).toHaveBeenLastCalledWith(watchSelections);
        expect(within(card).getByText("Ignore this location?")).not.toBeNull();
    });

    it("keeps an ignored card collapsed when restoring its follow-location save fails", async () => {
        const sources = classifyDiscoverySources(EMPTY_WATCHED, PROBE);
        const groups = groupDiscoverySourceClaims(sources, PROBE);
        const selectedSourceKeys = defaultDiscoveryReadSourceKeys(groups);
        const watchSelections = defaultDiscoveryWatchSelections(sources);
        const onSelectedSourceKeysChange = vi.fn();
        const onWatchSelectionsChange = vi.fn();
        const onPersistWatchSelections = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys,
                watchSelections,
                onPersistWatchSelections,
                onSelectedSourceKeysChange,
                onWatchSelectionsChange,
            }),
        );

        const card = required(screen.getByText("/brand-new", { selector: "code" }).closest("li"), "source card");
        fireEvent.click(within(card).getByRole("button", { name: "Ignore this location" }));
        fireEvent.click(within(card).getByRole("button", { name: "Ignore" }));
        await vi.waitFor(() => expect(onPersistWatchSelections).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(card.dataset.oaamSourceState).toBe("ignored"));
        expect(within(card).getByText("Claude Code", { selector: ".source-metadata-tags .workbench-badge" })).not.toBeNull();
        expect(within(card).getByText("Local Linux", { selector: ".source-metadata-tags .workbench-badge" })).not.toBeNull();

        fireEvent.click(within(card).getByRole("button", { name: "Include again" }));
        await vi.waitFor(() => expect(onPersistWatchSelections).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(card.dataset.oaamSourceState).toBe("ignored"));
        expect(onSelectedSourceKeysChange).toHaveBeenLastCalledWith(selectedSourceKeys);
        expect(onWatchSelectionsChange).toHaveBeenLastCalledWith(watchSelections);
    });

    it("uses the saved scan binding as Settings truth after restoring an exact registered Project location", async () => {
        const project = {
            projectId: "44444444-4444-4444-8444-444444444444",
            displayName: "Brand new Project",
            rootPath: "/brand-new",
            deleted: false,
            createdAt: 1,
            updatedAt: 1,
        };
        const prior = watchedSelector("new", project.rootPath);
        const watched: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [{ ...prior, disposition: "excluded" }],
                },
            ],
        };
        const sources = classifyDiscoverySources(watched, PROBE);
        const groups = groupDiscoverySourceClaims(sources, PROBE);
        const onPersistWatchSelections = vi.fn(async () => true);
        const onWatchSelectionsChange = vi.fn();
        const view = renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                purpose: "manage_locations",
                projects: [project],
                providers: PROVIDERS,
                selectedSourceKeys: [],
                watchSelections: [],
                onPersistWatchSelections,
                onWatchSelectionsChange,
            }),
        );

        const card = required(screen.getByText(project.rootPath, { selector: "code" }).closest("li"), "Project source card");
        expect(card.dataset.oaamSourceState).toBe("ignored");
        expect(within(card).getByText("Not included in scans")).not.toBeNull();
        expect(within(card).getByText(/not currently included in scans/u)).not.toBeNull();

        fireEvent.click(within(card).getByRole("button", { name: "Include again" }));
        const expectedSelections = [
            {
                sourceKey: "fresh:result-1:source-new",
                binding: { assetScope: "project" as const, projectId: project.projectId },
            },
        ];
        await vi.waitFor(() => expect(onPersistWatchSelections).toHaveBeenCalledWith(expectedSelections));

        view.rerender(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                purpose: "manage_locations",
                projects: [project],
                providers: PROVIDERS,
                selectedSourceKeys: [],
                watchSelections: expectedSelections,
                onPersistWatchSelections,
                onWatchSelectionsChange,
            }),
        );
        expect(card.dataset.oaamSourceState).toBe("included");
        expect(within(card).queryByRole("button", { name: "Include again" })).toBeNull();
    });

    it("expands an excluded unregistered Project location instead of pretending that restore succeeded", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const projectSource = required(
            baseResult.sources.find((source) => source.rowId === "source-new"),
            "Project source",
        );
        const probe: ProbeReviewView = {
            ...PROBE,
            results: [
                {
                    ...baseResult,
                    projects: [
                        {
                            rowId: "observed-project",
                            observedProjectId: "observed-brand-new",
                            displayName: "Brand new Project",
                            workspaceSourceRowIds: [projectSource.rowId],
                            containedSourceRootRowIds: [projectSource.rowId],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };
        const prior = watchedSelector("new", projectSource.displayPath);
        const watched: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [{ ...prior, disposition: "excluded" }],
                },
            ],
        };
        const sources = classifyDiscoverySources(watched, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);
        const proposals = deriveDiscoveryProjectProposals(probe, []);
        const onPersistWatchSelections = vi.fn(async () => true);
        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                purpose: "manage_locations",
                projectProposals: proposals,
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys: [],
                watchSelections: [],
                onAddProjectProposal: vi.fn(),
                onPersistWatchSelections,
                onProjectProposalSkippedChange: vi.fn(),
                onWatchSelectionsChange: vi.fn(),
            }),
        );

        const card = required(
            screen.getByText(projectSource.displayPath, { selector: "code" }).closest("li"),
            "unregistered Project card",
        );
        expect(card.dataset.oaamSourceState).toBe("ignored");
        fireEvent.click(within(card).getByRole("button", { name: "Include again" }));

        expect(card.dataset.oaamSourceState).toBe("requires_review");
        expect(within(card).getByRole("button", { name: "Register as Project" })).not.toBeNull();
        expect(within(card).getByRole("radiogroup", { name: "Store in library" })).not.toBeNull();
        expect(onPersistWatchSelections).not.toHaveBeenCalled();
    });

    it("offers a real Global fallback when an excluded Project-shaped root has no registration proposal", () => {
        const projectSource = required(
            PROBE.results[0]?.sources.find((source) => source.rowId === "source-new"),
            "Project source",
        );
        const prior = watchedSelector("new", projectSource.displayPath);
        const watched: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [{ ...prior, disposition: "excluded" }],
                },
            ],
        };
        const sources = classifyDiscoverySources(watched, PROBE);
        const groups = groupDiscoverySourceClaims(sources, PROBE);
        const onWatchSelectionsChange = vi.fn();
        renderWithPresentation(
            createElement(DiscoverySourceReview, {
                busy: false,
                groups,
                purpose: "manage_locations",
                projects: [],
                providers: PROVIDERS,
                selectedSourceKeys: [],
                watchSelections: [],
                onPersistWatchSelections: vi.fn(async () => true),
                onWatchSelectionsChange,
            }),
        );

        const card = required(
            screen.getByText(projectSource.displayPath, { selector: "code" }).closest("li"),
            "Project-shaped source card",
        );
        fireEvent.click(within(card).getByRole("button", { name: "Include again" }));
        expect(card.dataset.oaamSourceState).toBe("requires_review");
        const globalChoice = within(card).getByRole<HTMLInputElement>("radio", { name: "Global" });
        expect(globalChoice.disabled).toBe(false);
        fireEvent.click(globalChoice);
        expect(onWatchSelectionsChange).toHaveBeenCalledWith([
            {
                sourceKey: "fresh:result-1:source-new",
                binding: { assetScope: "global" },
            },
        ]);
    });
});
