import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopResolvedLocale,
} from "../src/presentation/presentation-preferences";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { DiscoveryWorkspace } from "../src/renderer/features/discovery/DiscoveryWorkspace";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";
import type { ProbeReviewView, WatchedScanIntentView } from "../src/renderer/features/discovery/discovery-model";
import { localizedText } from "../src/renderer/presentation";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import {
    DIGEST,
    diagnostic,
    EMPTY_WATCHED,
    ENABLEMENT,
    ENVIRONMENT,
    fakeDiscoveryClient,
    PROBE,
    PROVIDERS,
    probeSource,
    required,
    WATCHED,
    watchedSelector,
} from "./discovery-test-fixtures";

afterEach(() => {
    cleanup();
});

describe("Desktop discovery Client and source comparison", () => {
    it("runs one startup probe only for watched, reachable and still-enabled provider scope", async () => {
        const unreachableEnvironment = { platform: "wsl" as const, platformInstanceId: "Stopped" };
        const watched: WatchedScanIntentView = {
            ...WATCHED,
            environments: [
                required(WATCHED.environments[0], "watched environment"),
                {
                    environment: unreachableEnvironment,
                    sourceSelectors: [
                        {
                            ...watchedSelector("unreachable", "/unreachable"),
                            source: {
                                ...watchedSelector("unreachable", "/unreachable").source,
                                adapterId: "OPENCODE",
                            },
                        },
                    ],
                },
            ],
        };
        const client = fakeDiscoveryClient({
            getWatchedScanIntent: vi.fn(async () => ({ status: "complete", value: watched, diagnostics: [] })),
        });
        const controller = new DiscoveryController(client, { createUserActionId: () => "action" });

        await controller.load();

        expect(client.probeGlobal).toHaveBeenCalledOnce();
        expect(client.probeGlobal).toHaveBeenCalledWith(["CLAUDECODE"], [ENVIRONMENT], undefined, expect.any(Function));
        expect(controller.state).toMatchObject({
            status: "ready",
            activity: "idle",
            message: localizedText("discovery.snapshot_refreshed"),
        });
        expect(controller.state.status === "ready" && controller.state.sources.map((source) => source.status)).toEqual([
            "moved",
            "not_checked",
            "new",
        ]);
    });

    it("keeps Deployment target discovery idle until an exact Global or Project action", async () => {
        const probeProject = vi.fn(async () => ({ status: "complete" as const, value: PROBE, diagnostics: [] }));
        const client = fakeDiscoveryClient({
            getWatchedScanIntent: vi.fn(async () => ({ status: "complete", value: WATCHED, diagnostics: [] })),
            probeProject,
        });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            autoProbeWatched: false,
        });

        await controller.load();
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect(probeProject).not.toHaveBeenCalled();
        await expect(controller.probeProject("   ")).resolves.toBe(false);
        expect(probeProject).not.toHaveBeenCalled();

        controller.toggleProvider("OPENCODE");
        await expect(controller.probeProject("project-root-token")).resolves.toBe(true);
        expect(probeProject).toHaveBeenCalledWith(
            ["CLAUDECODE", "OPENCODE"],
            [ENVIRONMENT],
            "project-root-token",
            undefined,
            expect.any(Function),
        );
        expect(client.replaceAdapterEnablement).not.toHaveBeenCalled();
        expect(controller.state).toMatchObject({ status: "ready", activity: "idle", probeReview: PROBE });
        controller.dispose();
    });

    it("loads disabled providers, saves an explicit change and invalidates the old probe snapshot", async () => {
        const client = fakeDiscoveryClient({
            listAdapterProviders: vi.fn(async () => ({
                status: "partial",
                value: { providers: PROVIDERS },
                diagnostics: [diagnostic("One provider summary is incomplete.")],
            })),
        });
        const controller = new DiscoveryController(client, { createUserActionId: () => "action-1" });
        await controller.load();
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedAdapterIds: ["CLAUDECODE"],
            configurationDiagnostics: [
                expect.objectContaining({
                    message: "One provider summary is incomplete.",
                }),
            ],
        });
        controller.toggleProvider("OPENCODE");
        expect(controller.hasUnsavedProviderChanges()).toBe(true);
        await controller.saveProviderEnablement();
        expect(client.replaceAdapterEnablement).toHaveBeenCalledWith({
            expectedRevision: 1,
            expectedSettingFingerprint: DIGEST,
            enabledAdapterIds: ["CLAUDECODE", "OPENCODE"],
            userActionId: "action-1",
        });
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedAdapterIds: ["CLAUDECODE", "OPENCODE"],
            probeReview: undefined,
            sources: [],
            activity: "idle",
        });
    });

    it("fails closed on stale enablement and probe failures while preserving retryable UI state", async () => {
        const client = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("The setting changed in another client.")],
            })),
            probeGlobal: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("The runtime could not be inspected.")],
            })),
        });
        const controller = new DiscoveryController(client, { createUserActionId: () => "action" });
        await controller.load();
        controller.toggleProvider("OPENCODE");
        await controller.saveProviderEnablement();
        expect(controller.state).toMatchObject({
            status: "ready",
            activity: "save_failed",
            message: localizedText("discovery.provider.save_failed"),
            selectedAdapterIds: ["CLAUDECODE", "OPENCODE"],
            activityDiagnostics: [
                expect.objectContaining({
                    message: "The setting changed in another client.",
                }),
            ],
        });
        controller.toggleProvider("OPENCODE");
        await controller.probe();
        expect(controller.state).toMatchObject({
            status: "ready",
            activity: "probe_failed",
            message: localizedText("discovery.snapshot_untrustworthy"),
            activityDiagnostics: [
                expect.objectContaining({
                    message: "The runtime could not be inspected.",
                }),
            ],
        });
    });

    it("persists an unsaved provider choice before probing and dispatches no probe when persistence fails", async () => {
        const successfulClient = fakeDiscoveryClient();
        const successful = new DiscoveryController(successfulClient, { createUserActionId: () => "compound-action" });
        await successful.load();
        successful.toggleProvider("OPENCODE");
        await successful.saveProviderEnablementAndProbe();
        expect(successfulClient.replaceAdapterEnablement).toHaveBeenCalledWith({
            expectedRevision: 1,
            expectedSettingFingerprint: DIGEST,
            enabledAdapterIds: ["CLAUDECODE", "OPENCODE"],
            userActionId: "compound-action",
        });
        expect(successfulClient.probeGlobal).toHaveBeenCalledWith(
            ["CLAUDECODE", "OPENCODE"],
            [ENVIRONMENT],
            undefined,
            expect.any(Function),
        );
        expect(
            required(
                vi.mocked(successfulClient.replaceAdapterEnablement).mock.invocationCallOrder[0],
                "provider enablement invocation order",
            ),
        ).toBeLessThan(required(vi.mocked(successfulClient.probeGlobal).mock.invocationCallOrder[0], "probe invocation order"));

        const staleClient = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("The setting changed in another client.")],
            })),
        });
        const stale = new DiscoveryController(staleClient, { createUserActionId: () => "stale-action" });
        await stale.load();
        stale.toggleProvider("OPENCODE");
        await stale.saveProviderEnablementAndProbe();
        expect(staleClient.probeGlobal).not.toHaveBeenCalled();
        expect(stale.state).toMatchObject({
            status: "ready",
            activity: "save_failed",
            message: localizedText("discovery.provider.save_failed"),
            activityDiagnostics: [
                expect.objectContaining({
                    message: "The setting changed in another client.",
                }),
            ],
        });

        const interruptedClient = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(async () => {
                throw new Error("transport closed");
            }),
        });
        const interrupted = new DiscoveryController(interruptedClient, { createUserActionId: () => "interrupted-action" });
        await interrupted.load();
        interrupted.toggleProvider("OPENCODE");
        await interrupted.saveProviderEnablementAndProbe();
        expect(interruptedClient.probeGlobal).not.toHaveBeenCalled();
        expect(interrupted.state).toMatchObject({
            status: "ready",
            activity: "save_failed",
            message: localizedText("discovery.provider.save_failed"),
        });
    });

    it("reports unavailable initial authority and thrown requests without inventing empty success", async () => {
        const failed = new DiscoveryController(
            fakeDiscoveryClient({
                getAdapterEnablement: vi.fn(async () => ({
                    status: "failed",
                    diagnostics: [diagnostic("Settings cannot be read.")],
                })),
            }),
            { createUserActionId: () => "action" },
        );
        await failed.load();
        expect(failed.state).toEqual({
            status: "failed",
            message: localizedText("discovery.settings_unavailable"),
            diagnostics: [expect.objectContaining({ message: "Settings cannot be read." })],
        });

        const interrupted = new DiscoveryController(
            fakeDiscoveryClient({
                listAdapterProviders: vi.fn(async () => {
                    throw new Error("transport closed");
                }),
            }),
            { createUserActionId: () => "action" },
        );
        await interrupted.load();
        expect(interrupted.state).toEqual({
            status: "failed",
            message: localizedText("discovery.loading_failed"),
            diagnostics: [],
        });
    });

    it("handles no-provider, no-environment, interrupted mutation and a partial selected-environment probe", async () => {
        const virgin = {
            configVersion: 1 as const,
            settingId: "adapter_enablement_v1" as const,
            revision: 0 as const,
            enabledAdapterIds: [] as const,
            updatedAt: 0 as const,
            settingFingerprint: DIGEST,
        };
        const noProvider = new DiscoveryController(
            fakeDiscoveryClient({
                getAdapterEnablement: vi.fn(async () => ({ status: "complete", value: virgin, diagnostics: [] })),
            }),
            { createUserActionId: () => "action" },
        );
        expect(noProvider.hasUnsavedProviderChanges()).toBe(false);
        await noProvider.probe();
        await noProvider.saveProviderEnablement();
        noProvider.toggleProvider("CLAUDECODE");
        await noProvider.load();
        await noProvider.probe();
        expect(noProvider.state).toMatchObject({
            status: "ready",
            activity: "probe_failed",
            message: localizedText("discovery.enable_provider_first"),
        });

        const noEnvironment = new DiscoveryController(
            fakeDiscoveryClient({
                listEnvironments: vi.fn(async () => ({
                    status: "complete",
                    value: { environments: [] },
                    diagnostics: [],
                })),
            }),
            { createUserActionId: () => "action" },
        );
        await noEnvironment.load();
        await noEnvironment.probe();
        expect(noEnvironment.state).toMatchObject({
            activity: "probe_failed",
            message: localizedText("discovery.no_environment"),
        });

        const interruptedSave = new DiscoveryController(
            fakeDiscoveryClient({
                replaceAdapterEnablement: vi.fn(async () => {
                    throw new Error("connection lost");
                }),
            }),
            { createUserActionId: () => "action" },
        );
        await interruptedSave.load();
        interruptedSave.toggleProvider("OPENCODE");
        await interruptedSave.saveProviderEnablement();
        expect(interruptedSave.state).toMatchObject({ activity: "save_failed" });

        const secondEnvironment = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const partialProbe = new DiscoveryController(
            fakeDiscoveryClient({
                listEnvironments: vi.fn(async () => ({
                    status: "complete",
                    value: {
                        environments: [
                            { environment: ENVIRONMENT, displayName: "Local Linux" },
                            { environment: secondEnvironment, displayName: "Ubuntu" },
                        ],
                    },
                    diagnostics: [],
                })),
                probeGlobal: vi.fn(async () => ({
                    status: "partial",
                    value: PROBE,
                    diagnostics: [diagnostic("One environment needs attention.")],
                })),
            }),
            { createUserActionId: () => "action" },
        );
        await partialProbe.load();
        await partialProbe.probe();
        expect(partialProbe.state).toMatchObject({
            activity: "idle",
            message: localizedText("discovery.complete_with_warnings"),
            activityDiagnostics: [
                expect.objectContaining({
                    message: "One environment needs attention.",
                }),
            ],
        });
        expect(partialProbe.state.status === "ready" && partialProbe.state.environments).toHaveLength(2);
    });

    it("saves watched-source choices through the existing revisioned Core authority and reports stale writes", async () => {
        const savedWatched: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            revision: 1,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [watchedSelector("new", "/brand-new", "4".repeat(64))],
                },
            ],
            userActionEvidenceId: "watch-action",
            updatedAt: 2,
            settingFingerprint: "5".repeat(64),
        };
        const save = vi.fn(async () => ({ status: "complete" as const, value: savedWatched, diagnostics: [] }));
        const client = fakeDiscoveryClient({ replaceWatchedScanIntent: save });
        const controller = new DiscoveryController(client, { createUserActionId: () => "watch-action" });
        await controller.load();
        await controller.probe();
        if (controller.state.status !== "ready") throw new Error("ready discovery state is required");
        const selected = required(
            controller.state.sources.find((source) => source.displayPath === "/brand-new"),
            "new watched source",
        );
        await controller.saveWatchedSources([{ sourceKey: selected.key, binding: { assetScope: "global" } }]);
        expect(save).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            decisions: [
                {
                    action: "include_observed",
                    probeToken: "probe-token",
                    probeResultRowId: "result-1",
                    sourceRootRowId: "source-new",
                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    binding: { assetScope: "global" },
                },
            ],
            userActionId: "watch-action",
        });
        expect(controller.state).toMatchObject({
            status: "ready",
            activity: "idle",
            watched: { revision: 1, settingFingerprint: "5".repeat(64) },
        });

        const staleClient = fakeDiscoveryClient({
            replaceWatchedScanIntent: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("The watched-source setting is stale.")],
            })),
        });
        const stale = new DiscoveryController(staleClient, { createUserActionId: () => "action" });
        await stale.load();
        await stale.probe();
        if (stale.state.status !== "ready") throw new Error("ready discovery state is required");
        const staleSource = required(stale.state.sources[0], "stale watched source");
        await stale.saveWatchedSources([{ sourceKey: staleSource.key, binding: { assetScope: "global" } }]);
        expect(stale.state).toMatchObject({
            status: "ready",
            activity: "watch_failed",
            message: localizedText("discovery.watch.save_failed"),
            activityDiagnostics: [
                expect.objectContaining({
                    message: "The watched-source setting is stale.",
                }),
            ],
        });
    });

    it("rejects stale watched-source UI state before Core dispatch and keeps interrupted saves retryable", async () => {
        const invalidClient = fakeDiscoveryClient();
        const invalid = new DiscoveryController(invalidClient, { createUserActionId: () => "action" });
        await invalid.load();
        await invalid.probe();
        await invalid.saveWatchedSources([
            {
                sourceKey: "stale-source-key",
                binding: { assetScope: "global" },
            },
        ]);
        expect(invalidClient.replaceWatchedScanIntent).not.toHaveBeenCalled();
        expect(invalid.state).toMatchObject({
            status: "ready",
            activity: "watch_failed",
            message: localizedText("discovery.watch.selection_invalid"),
        });

        const interruptedClient = fakeDiscoveryClient({
            replaceWatchedScanIntent: vi.fn(async () => {
                throw new Error("transport closed");
            }),
        });
        const interrupted = new DiscoveryController(interruptedClient, { createUserActionId: () => "action" });
        await interrupted.load();
        await interrupted.probe();
        if (interrupted.state.status !== "ready") throw new Error("ready discovery state is required");
        const source = required(interrupted.state.sources[0], "watched source");
        await interrupted.saveWatchedSources([{ sourceKey: source.key, binding: { assetScope: "global" } }]);
        expect(interrupted.state).toMatchObject({
            status: "ready",
            activity: "watch_failed",
            message: localizedText("discovery.watch.save_failed"),
        });
    });

    it("preserves unavailable stored provider intent without dispatching that foreign ID", async () => {
        const mixedClient = fakeDiscoveryClient({
            getAdapterEnablement: vi.fn(async () => ({
                status: "partial",
                value: { ...ENABLEMENT, enabledAdapterIds: ["CLAUDECODE", "MISSING_PROVIDER"] },
                diagnostics: [diagnostic("A stored provider is unavailable.")],
            })),
        });
        const mixed = new DiscoveryController(mixedClient, { createUserActionId: () => "action" });
        await mixed.load();
        await mixed.probe();
        expect(mixedClient.probeGlobal).toHaveBeenCalledWith(["CLAUDECODE"], [ENVIRONMENT], undefined, expect.any(Function));

        const missingClient = fakeDiscoveryClient({
            getAdapterEnablement: vi.fn(async () => ({
                status: "partial",
                value: { ...ENABLEMENT, enabledAdapterIds: ["MISSING_PROVIDER"] },
                diagnostics: [diagnostic("A stored provider is unavailable.")],
            })),
        });
        const missing = new DiscoveryController(missingClient, { createUserActionId: () => "action" });
        await missing.load();
        await missing.probe();
        expect(missingClient.probeGlobal).not.toHaveBeenCalled();
        expect(missing.state).toMatchObject({
            activity: "probe_failed",
            message: localizedText("discovery.enable_provider_first"),
        });
    });

    it("drops stale async mutation results and preserves interrupted probe as retry-required", async () => {
        let resolveSave:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["replaceAdapterEnablement"]>>) => void)
            | undefined;
        const staleClient = fakeDiscoveryClient({
            replaceAdapterEnablement: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveSave = resolve;
                    }),
            ),
        });
        const stale = new DiscoveryController(staleClient, { createUserActionId: () => "action" });
        await stale.load();
        stale.toggleProvider("OPENCODE");
        const saving = stale.saveProviderEnablement();
        expect(stale.state).toMatchObject({ activity: "saving" });
        await stale.load();
        resolveSave?.({
            status: "complete",
            value: { ...ENABLEMENT, revision: 2, enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] },
            diagnostics: [],
        });
        await saving;
        expect(stale.state).toMatchObject({ status: "ready", selectedAdapterIds: ["CLAUDECODE"] });

        const interruptedProbe = new DiscoveryController(
            fakeDiscoveryClient({
                probeGlobal: vi.fn(async () => {
                    throw new Error("connection lost");
                }),
            }),
            { createUserActionId: () => "action" },
        );
        await interruptedProbe.load();
        await interruptedProbe.probe();
        expect(interruptedProbe.state).toMatchObject({
            activity: "probe_failed",
            message: localizedText("discovery.interrupted"),
        });
    });

    it("renders one explicit save-and-scan action, moved evidence and an actionable new location", async () => {
        const client = fakeDiscoveryClient({
            getWatchedScanIntent: vi.fn(async () => ({ status: "complete", value: WATCHED, diagnostics: [] })),
        });
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            autoProbeWatched: false,
        });
        const reviewSources = vi.fn();
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: reviewSources }));
        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: "Choose systems and tools" })).not.toBeNull());

        const opencode = screen.getByRole("checkbox", { name: /OpenCode/u });
        const claudeCode = screen.getByRole("checkbox", { name: /Claude Code/u });
        const opencodeCard = required(opencode.closest("label"), "OpenCode tool card");
        const claudeCodeCard = required(claudeCode.closest("label"), "Claude Code tool card");
        expect(opencodeCard.dataset.selected).toBe("false");
        expect(claudeCodeCard.dataset.selected).toBe("true");
        expect((opencode as HTMLInputElement).checked).toBe(false);
        fireEvent.click(opencode);
        expect(opencodeCard.dataset.selected).toBe("true");
        fireEvent.click(claudeCode);
        expect(claudeCodeCard.dataset.selected).toBe("false");
        fireEvent.click(claudeCode);
        const saveAndRun = screen.getByRole("button", { name: "Save choices and scan" }) as HTMLButtonElement;
        expect(saveAndRun.disabled).toBe(false);
        fireEvent.click(saveAndRun);
        await vi.waitFor(() => expect(screen.getByText("Moved")).not.toBeNull());
        expect(client.replaceAdapterEnablement).toHaveBeenCalledOnce();
        expect(client.probeGlobal).toHaveBeenCalledWith(
            ["CLAUDECODE", "OPENCODE"],
            [ENVIRONMENT],
            undefined,
            expect.any(Function),
        );
        expect(
            required(
                vi.mocked(client.replaceAdapterEnablement).mock.invocationCallOrder[0],
                "rendered provider enablement invocation order",
            ),
        ).toBeLessThan(required(vi.mocked(client.probeGlobal).mock.invocationCallOrder[0], "rendered probe invocation order"));
        expect(screen.queryByText("New")).toBeNull();
        expect(screen.getByText("Previously: /old")).not.toBeNull();
        const environmentResults = screen.getByRole("region", { name: "Scan results by location" });
        expect(within(environmentResults).getByText(/1 tools checked · 2 source locations/u)).not.toBeNull();
        expect(environmentResults.querySelector(".environment-result-list")).toBeNull();
        expect(screen.getByText("Moved").getAttribute("data-oaam-tone")).toBe("warning");
        expect(within(environmentResults).queryByText("CLAUDE_CODE_CLI")).toBeNull();
        expect(document.querySelector(".discovery-workspace")).toMatchObject({
            dataset: expect.objectContaining({
                oaamEnvironmentResultStatuses: '[["[\\"linux\\",\\"local\\"]","complete"]]',
            }),
        });

        const path = screen.getByText("/brand-new", { selector: "code" });
        const sourceCard = path.closest("li");
        if (sourceCard === null) throw new Error("source review card is missing");
        expect(sourceCard.dataset.oaamSourceState).toBe("requires_review");
        expect(sourceCard.textContent).toContain("Destination needs confirmation");
        expect(within(sourceCard).getByRole<HTMLInputElement>("radio", { name: "Global" }).disabled).toBe(false);
        expect(within(sourceCard).queryByRole("checkbox")).toBeNull();
        const movedCard = required(screen.getByText("/new", { selector: "code" }).closest("li"), "moved source card");
        fireEvent.click(within(movedCard).getByRole("button", { name: "Ignore this location" }));
        expect(within(movedCard).getByText("Ignore this location?")).not.toBeNull();
        fireEvent.click(within(movedCard).getByRole("button", { name: "Ignore" }));
        await vi.waitFor(() => expect(client.replaceWatchedScanIntent).toHaveBeenCalledTimes(1));
        expect(client.replaceWatchedScanIntent).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                decisions: [
                    expect.objectContaining({
                        action: "exclude_observed",
                        sourceRootRowId: "source-moved",
                    }),
                ],
            }),
        );
        expect(movedCard.dataset.oaamSourceState).toBe("ignored");
        await vi.waitFor(() =>
            expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review selected locations" }).disabled).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Review selected locations" }));
        expect(reviewSources).toHaveBeenCalledWith({
            probeToken: "probe-token",
            selections: [{ probeResultRowId: "result-1", sourceRootRowIds: ["source-new"] }],
        });
        fireEvent.click(within(sourceCard).getByRole("button", { name: "Ignore this location" }));
        fireEvent.click(within(sourceCard).getByRole("button", { name: "Ignore" }));
        await vi.waitFor(() => expect(client.replaceWatchedScanIntent).toHaveBeenCalledTimes(2));
        expect(client.replaceWatchedScanIntent).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                decisions: [
                    expect.objectContaining({
                        action: "exclude_observed",
                        sourceRootRowId: "source-new",
                    }),
                ],
            }),
        );
        expect(screen.getByRole("button", { name: "Review selected locations" }).hasAttribute("disabled")).toBe(true);
        await vi.waitFor(() =>
            expect(within(sourceCard).getByRole<HTMLButtonElement>("button", { name: "Include again" }).disabled).toBe(false),
        );
        fireEvent.click(within(sourceCard).getByRole("button", { name: "Include again" }));
        expect(client.replaceWatchedScanIntent).toHaveBeenCalledTimes(2);
        expect(sourceCard.dataset.oaamSourceState).toBe("requires_review");
        fireEvent.click(within(sourceCard).getByRole("radio", { name: "Global" }));
        expect(sourceCard.dataset.oaamSourceState).toBe("included");
        await vi.waitFor(() =>
            expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save location choices" }).disabled).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Save location choices" }));
        await vi.waitFor(() => expect(client.replaceWatchedScanIntent).toHaveBeenCalledTimes(3));
    });

    it("reviews one exact physical path once without repeating ordinary relationship labels", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const groupedProbe: ProbeReviewView = {
            probeToken: "grouped-probe",
            results: [
                {
                    ...baseResult,
                    rowId: "claude-result",
                    adapterId: "CLAUDECODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["claude-root"] }],
                    sources: [
                        {
                            ...probeSource("claude-root", "claude-native", "/home/user/.claude"),
                            sourceDomain: "agent_runtime_private",
                        },
                    ],
                },
                {
                    ...baseResult,
                    rowId: "opencode-result",
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
                            ...probeSource("opencode-root", "opencode-compatible", "/home/user/.claude"),
                            sourceDomain: "family_shared",
                        },
                    ],
                },
            ],
        };
        const groupedWatched: WatchedScanIntentView = {
            configVersion: 1,
            settingId: "watched_scan_intent_v1",
            revision: 2,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        {
                            disposition: "included",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "agent_runtime_private",
                                canonicalPath: "/home/user/.claude",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "claude-native" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            binding: { assetScope: "global" },
                            selectorFingerprint: "b".repeat(64),
                        },
                        {
                            disposition: "included",
                            source: {
                                adapterId: "OPENCODE",
                                rootRole: "source",
                                sourceDomain: "family_shared",
                                canonicalPath: "/home/user/.claude",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "opencode-compatible" }],
                            },
                            agentRuntimeIds: ["OPENCODE_CLI"],
                            binding: { assetScope: "project", projectId: "project-1" },
                            selectorFingerprint: "c".repeat(64),
                        },
                    ],
                },
            ],
            userActionEvidenceId: "prior-action",
            updatedAt: 2,
            settingFingerprint: "d".repeat(64),
        };
        const reviewSources = vi.fn();
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                getAdapterEnablement: vi.fn(async () => ({
                    status: "complete",
                    value: { ...ENABLEMENT, enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] },
                    diagnostics: [],
                })),
                getWatchedScanIntent: vi.fn(async () => ({
                    status: "complete",
                    value: groupedWatched,
                    diagnostics: [],
                })),
                probeGlobal: vi.fn(async () => ({ status: "complete", value: groupedProbe, diagnostics: [] })),
            }),
            { createUserActionId: () => "action", autoProbeWatched: false },
        );
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: reviewSources }));
        const scan = await screen.findByRole("button", { name: "Scan now" });
        fireEvent.click(scan);

        const path = await screen.findByText("/home/user/.claude", { selector: "code" });
        expect(screen.getAllByText("/home/user/.claude", { selector: "code" })).toHaveLength(1);
        const sourceCard = path.closest("li");
        if (sourceCard === null) throw new Error("grouped source card is missing");
        expect(sourceCard.dataset.oaamSourceClaimKinds).toBe('["native","compatible_shared"]');
        expect(sourceCard.querySelector(".source-relationship-list")).toBeNull();
        expect(sourceCard.textContent).not.toContain("Native source");
        expect(sourceCard.textContent).not.toContain("Compatible source");
        expect(sourceCard.textContent).not.toContain("without changing files in this folder");
        expect(sourceCard.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
        expect(sourceCard.dataset.oaamSourceState).toBe("included");
        expect(sourceCard.textContent).toContain("Different saved choices");
        const globalLibrary = within(sourceCard).getByRole<HTMLInputElement>("radio", { name: "Global" });
        fireEvent.click(globalLibrary);
        expect(globalLibrary.checked).toBe(true);
        expect(sourceCard.textContent).not.toContain("Different saved choices");

        fireEvent.click(screen.getByRole("button", { name: "Review selected locations" }));
        expect(reviewSources).toHaveBeenCalledWith({
            probeToken: "grouped-probe",
            selections: [{ probeResultRowId: "claude-result", sourceRootRowIds: ["claude-root"] }],
        });
    });

    it.each([
        "en",
        "zh-CN",
        "de",
        "ja",
    ] as const)("keeps raw discovery identities and diagnostics out of the %s ordinary surface", async (locale: DesktopResolvedLocale) => {
        const rawDiagnostic = "RAW_PROVIDER_DIAGNOSTIC_SENTINEL";
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                listAdapterProviders: vi.fn(async () => ({
                    status: "partial",
                    value: { providers: PROVIDERS },
                    diagnostics: [diagnostic(rawDiagnostic)],
                })),
            }),
            { createUserActionId: () => "action", autoProbeWatched: false },
        );
        const snapshot = createDesktopPresentationSnapshot(
            {
                ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                language: locale,
                onboardingCompleted: true,
            },
            [locale],
            false,
        );
        const { container } = renderWithPresentation(
            createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }),
            createDesktopPresentationTestBridge(snapshot),
        );
        await vi.waitFor(() => expect(container.querySelector(".discovery-workspace")).not.toBeNull());
        const run = required(container.querySelector<HTMLButtonElement>("[data-oaam-discovery-run]"), "localized scan button");
        fireEvent.click(run);
        await vi.waitFor(() => expect(container.querySelector("[data-oaam-source-state]")).not.toBeNull());

        const ordinaryText = ordinarySurfaceText(container);
        expect(ordinaryText).not.toMatch(
            /\b(?:CLAUDECODE|OPENCODE|CLAUDE_CODE_CLI|agent_runtime_private|family_shared|rootRole|accessStatus)\b/u,
        );
        expect(ordinaryText).not.toMatch(
            /\b(?:provider|adapter|runtime entr(?:y|ies)|source roots?|probe|rendered target|host)\b/iu,
        );
        expect(ordinaryText).not.toContain(rawDiagnostic);
        expect(container.textContent).toContain("CLAUDE_CODE_CLI");
        expect(container.textContent).toContain(rawDiagnostic);
    });

    it("keeps a partial location result visibly distinct without presenting an unactionable danger", async () => {
        const partialProbe: ProbeReviewView = {
            ...PROBE,
            results: PROBE.results.map((result) => ({ ...result, status: "partial" as const })),
        };
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                probeGlobal: vi.fn(async () => ({ status: "partial", value: partialProbe, diagnostics: [] })),
            }),
            { createUserActionId: () => "action" },
        );
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));
        await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Scan now" })).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));

        await vi.waitFor(() => {
            const scanNotes = screen.getAllByText("Partially checked");
            expect(scanNotes).toHaveLength(1);
            expect(scanNotes[0]?.getAttribute("data-oaam-scan-notes")).toBe("true");
            expect(scanNotes[0]?.getAttribute("data-oaam-tone")).toBe("warning");
        });
    });

    it("renders unavailable stored providers and stale-save refresh without hiding the failed mutation", async () => {
        const unavailableEnablement = { ...ENABLEMENT, enabledAdapterIds: ["CLAUDECODE", "MISSING_PROVIDER"] };
        const client = fakeDiscoveryClient({
            getAdapterEnablement: vi.fn(async () => ({
                status: "partial",
                value: unavailableEnablement,
                diagnostics: [diagnostic("A stored provider is unavailable.")],
            })),
            replaceAdapterEnablement: vi.fn(async () => ({
                status: "failed",
                diagnostics: [diagnostic("The provider setting is stale.")],
            })),
        });
        const controller = new DiscoveryController(client, { createUserActionId: () => "action" });
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));
        await vi.waitFor(() => expect(screen.queryByText("Unavailable saved tool")).not.toBeNull());
        expect(screen.queryByText("MISSING_PROVIDER")).toBeNull();
        fireEvent.click(screen.getByRole("checkbox", { name: /Unavailable saved tool/u }));
        fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
        await vi.waitFor(() => expect(screen.queryByText(/Your tool choices were not saved/u)).not.toBeNull());
        expect(screen.queryByText("The provider setting is stale.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Refresh choices" }));
        await vi.waitFor(() => expect(client.listAdapterProviders).toHaveBeenCalledTimes(2));
    });

    it("shows a retained project binding honestly when that project is unavailable in the current catalog", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const watched: WatchedScanIntentView = {
            ...WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        {
                            ...watchedSelector("gone", "/gone"),
                            binding: { assetScope: "project", projectId },
                        },
                    ],
                },
            ],
        };
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                getWatchedScanIntent: vi.fn(async () => ({ status: "complete", value: watched, diagnostics: [] })),
            }),
            { createUserActionId: () => "action" },
        );
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));

        const path = await screen.findByText("/gone", { selector: "code" });
        const sourceCard = path.closest("li");
        if (sourceCard === null) throw new Error("retained source card is missing");
        expect(within(sourceCard).getByRole<HTMLInputElement>("radio", { name: "Project" }).checked).toBe(true);
        expect(sourceCard.textContent).toContain("Saved Project (currently unavailable)");
        expect(sourceCard.textContent).not.toContain(projectId);
    });
});
