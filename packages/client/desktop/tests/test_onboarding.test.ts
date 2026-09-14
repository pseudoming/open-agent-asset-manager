import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi } from "@oaam/client-framework";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopResolvedLocale,
} from "../src/presentation/presentation-preferences";
import { DesktopApplicationClient, type DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { OnboardingPage } from "../src/renderer/pages/OnboardingPage";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";
import { interactionElement } from "./desktop-interaction-test-harness";
import { fakeDiscoveryClient, fakeImportableDiscoveryClient, PROBE, probeSource, required } from "./discovery-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";
import { INVALID_READ_PREVIEW } from "./import-review-test-fixtures";

const DIGEST = "a".repeat(64);
const ENVIRONMENT = { platform: "linux" as const, platformInstanceId: "local" };

function sourceCard(displayPath: string): HTMLElement {
    const card = [...document.querySelectorAll<HTMLElement>(".source-review-card[data-oaam-source-path]")].find(
        (candidate) => candidate.dataset.oaamSourcePath === displayPath,
    );
    if (card === undefined) throw new Error(`source card ${displayPath} is missing`);
    return card;
}

afterEach(() => {
    cleanup();
});

function onboardingFixture(
    options: { readonly completeFails?: boolean; readonly probeFailsOnSecond?: boolean; readonly withSource?: boolean } = {},
): {
    readonly bridge: OaamDesktopBridge;
    readonly requestedMethods: ProtocolOperationName[];
    readonly startedMethods: ProtocolOperationName[];
    readonly completeOnboarding: ReturnType<typeof vi.fn>;
    readonly client: DesktopApplicationClient;
} {
    const initialPresentation = createDesktopPresentationSnapshot(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ["en-US"], false);
    const completedPresentation = createDesktopPresentationSnapshot(
        { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, onboardingCompleted: true },
        ["en-US"],
        false,
    );
    const completeOnboarding = vi.fn(async () => {
        if (options.completeFails) throw new Error("preference write failed");
        return completedPresentation;
    });
    const bridge: OaamDesktopBridge = {
        ...createDesktopPresentationTestBridge(initialPresentation),
        completeOnboarding,
    };
    const requestedMethods: ProtocolOperationName[] = [];
    const startedMethods: ProtocolOperationName[] = [];
    let probeCount = 0;
    const connection = {
        request: vi.fn(async (method: ProtocolOperationName) => {
            requestedMethods.push(method);
            const values: Partial<Record<ProtocolOperationName, unknown>> = {
                "adapter_provider.list": {
                    status: "complete",
                    value: {
                        providers: [
                            {
                                adapterId: "CLAUDECODE",
                                displayName: "Claude Code",
                                version: "1.0.0",
                                enabled: true,
                                agentRuntimes: [
                                    {
                                        agentRuntimeId: "CLAUDE_CODE_CLI",
                                        displayName: "Claude Code CLI",
                                        entryClass: "cli",
                                    },
                                ],
                                sourceCapabilities: [],
                                targetCapabilities: [],
                            },
                        ],
                    },
                    diagnostics: [],
                },
                "adapter_enablement.get": {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "adapter_enablement_v1",
                        revision: 1,
                        enabledAdapterIds: ["CLAUDECODE"],
                        userActionEvidenceId: "user-1",
                        updatedAt: 1,
                        settingFingerprint: DIGEST,
                    },
                    diagnostics: [],
                },
                "watched_scan_intent.get": {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "watched_scan_intent_v1",
                        revision: 0,
                        environments: [],
                        updatedAt: 0,
                        settingFingerprint: DIGEST,
                    },
                    diagnostics: [],
                },
                "watched_scan_intent.replace": {
                    status: "complete",
                    value: {
                        configVersion: 1,
                        settingId: "watched_scan_intent_v1",
                        revision: 1,
                        environments: [],
                        userActionEvidenceId: "action",
                        updatedAt: 2,
                        settingFingerprint: "b".repeat(64),
                    },
                    diagnostics: [],
                },
                "environment.list": {
                    status: "complete",
                    value: { environments: [{ environment: ENVIRONMENT, displayName: "Local Linux" }] },
                    diagnostics: [],
                },
                "project.list": { status: "complete", value: { projects: [] }, diagnostics: [] },
            };
            const value = values[method];
            if (value === undefined) throw new Error(`unexpected onboarding request ${method}`);
            return value;
        }) as ClientConnectionApi["request"],
        start: vi.fn(async (method: ProtocolOperationName) => {
            startedMethods.push(method);
            if (method === "adapter.read") {
                return {
                    operationId: "read-operation",
                    operation: "adapter.read",
                    terminal: new Promise(() => undefined),
                    terminalSequence: null,
                    subscribeProgress: () => () => undefined,
                };
            }
            if (method !== "adapter.probe") throw new Error(`unexpected onboarding operation ${method}`);
            probeCount += 1;
            const terminal =
                options.probeFailsOnSecond && probeCount === 2
                    ? {
                          status: "failed",
                          diagnostics: [
                              {
                                  severity: "error",
                                  code: "probe.failed",
                                  operation: "probe",
                                  causeKind: "runtime",
                                  retryable: true,
                                  suggestedActions: ["retry"],
                                  message: "The fresh discovery failed.",
                              },
                          ],
                      }
                    : {
                          status: "complete",
                          value: {
                              probeToken: "probe-token",
                              results: options.withSource
                                  ? [
                                        {
                                            rowId: "result-1",
                                            adapterId: "CLAUDECODE",
                                            environment: ENVIRONMENT,
                                            status: "complete",
                                            runtimes: [
                                                {
                                                    rowId: "runtime-1",
                                                    agentRuntimeId: "CLAUDE_CODE_CLI",
                                                    versionText: "2.1",
                                                    installationStatus: "available",
                                                    projectDiscoveryStatus: "complete",
                                                    sourceRootRowIds: ["source-1"],
                                                    diagnostics: [],
                                                },
                                            ],
                                            sources: [
                                                {
                                                    rowId: "source-1",
                                                    sourceRootId: "root-1",
                                                    rootRole: "source",
                                                    sourceDomain: "project_root",
                                                    displayPath: "/workspace/source",
                                                    accessStatus: "available",
                                                    locatorIdentities: [
                                                        {
                                                            locatorKind: "runtime_known_rule",
                                                            locatorKey: "source",
                                                        },
                                                    ],
                                                    diagnostics: [],
                                                },
                                            ],
                                            projects: [],
                                            targets: [],
                                            diagnostics: [],
                                        },
                                    ]
                                  : [],
                          },
                          diagnostics: [],
                      };
            return {
                operationId: "probe-operation",
                operation: "adapter.probe",
                terminal: Promise.resolve(terminal),
                terminalSequence: null,
                subscribeProgress: () => () => undefined,
            };
        }) as ClientConnectionApi["start"],
        subscribeInvalidation: vi.fn(() => () => undefined),
    } as unknown as ClientConnectionApi;
    return {
        bridge,
        requestedMethods,
        startedMethods,
        completeOnboarding,
        client: new DesktopApplicationClient(connection, [
            "adapter_provider.list",
            "adapter_enablement.get",
            "adapter_enablement.replace",
            "watched_scan_intent.get",
            "watched_scan_intent.replace",
            "environment.list",
            "adapter.probe",
        ]),
    };
}

describe("Desktop first-run onboarding", () => {
    async function startFreshJourney(): Promise<void> {
        fireEvent.click(await screen.findByRole("button", { name: "Start guided setup" }));
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    }

    async function reachSourceReview(): Promise<void> {
        await startFreshJourney();
        await screen.findByRole("heading", { name: "Review found locations" });
    }

    it.each([
        "en",
        "zh-CN",
        "de",
        "ja",
    ] as const)("keeps the %s welcome and tool step free of internal architecture language", async (locale: DesktopResolvedLocale) => {
        const fixture = onboardingFixture();
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: locale },
            [locale],
            false,
        );
        const { container } = renderWithPresentation(createElement(OnboardingPage, { client: fixture.client, assetCount: 0 }), {
            ...fixture.bridge,
            initialPresentation: snapshot,
        });

        const assertOrdinaryLanguage = () => {
            expect(container.textContent).not.toMatch(
                /\b(?:CLAUDECODE|OPENCODE|CLAUDE_CODE_CLI|agent_runtime_private|family_shared|rootRole|accessStatus)\b/u,
            );
            expect(container.textContent).not.toMatch(
                /\b(?:provider|adapter|runtime entr(?:y|ies)|source roots?|probe|rendered target)\b/iu,
            );
        };
        assertOrdinaryLanguage();
        const start = container.querySelector<HTMLButtonElement>("[data-oaam-onboarding-start]");
        if (start === null) throw new Error("onboarding start action is missing");
        fireEvent.click(start);
        await vi.waitFor(() => expect(container.querySelector("[data-oaam-provider-id]")).not.toBeNull());
        expect(container.querySelectorAll(".import-journey-steps > li")).toHaveLength(6);
        assertOrdinaryLanguage();
    });

    it("describes zero selected sources and returns to the existing source choices without reading", async () => {
        const client = fakeDiscoveryClient();
        renderWithPresentation(createElement(OnboardingPage, { client, assetCount: 0 }));
        fireEvent.click(await screen.findByRole("button", { name: "Start guided setup" }));
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        for (const path of ["/new", "/brand-new"]) {
            await vi.waitFor(() =>
                expect(
                    (within(sourceCard(path)).getByRole("button", { name: "Ignore this location" }) as HTMLButtonElement)
                        .disabled,
                ).toBe(false),
            );
            fireEvent.click(within(sourceCard(path)).getByRole("button", { name: "Ignore this location" }));
            fireEvent.click(within(sourceCard(path)).getByRole("button", { name: "Ignore" }));
            await vi.waitFor(() => expect(sourceCard(path).dataset.oaamSourceState).toBe("ignored"));
        }
        await vi.waitFor(() =>
            expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByRole("heading", { name: "No sources selected" });
        expect(screen.getByText("No source locations were selected for this import. Nothing was imported.")).not.toBeNull();
        expect(client.readSources).not.toHaveBeenCalled();
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        expect(sourceCard("/new").dataset.oaamSourceState).toBe("ignored");
        expect(client.probeGlobal).toHaveBeenCalledOnce();
    });

    it("does not inspect before consent and ends an empty scan without source or Asset review theatre", async () => {
        const fixture = onboardingFixture();
        const catalogChanged = vi.fn(async () => undefined);
        renderWithPresentation(
            createElement(OnboardingPage, {
                client: fixture.client,
                assetCount: 0,
                onCatalogChanged: catalogChanged,
            }),
            fixture.bridge,
        );

        expect(await screen.findByRole("heading", { name: "Choose when OAAM inspects your computer" })).not.toBeNull();
        expect(fixture.requestedMethods).toEqual([]);
        expect(fixture.startedMethods).toEqual([]);
        expect(screen.queryByRole("button", { name: "Start scan" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Catalog & deploy" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
        expect(document.querySelector("[aria-current='step']")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Start guided setup" }));
        const runDiscovery = await screen.findByRole("button", { name: "Start scan" });
        expect(document.querySelector("[aria-current='step']")?.textContent).toBe("AI coding tools");
        expect(fixture.startedMethods).toEqual([]);
        fireEvent.click(runDiscovery);
        await vi.waitFor(() => expect(fixture.startedMethods).toEqual(["adapter.probe"]));
        expect(await screen.findByRole("heading", { name: "No Assets ready to import" })).not.toBeNull();
        expect(screen.queryByRole("heading", { name: "Review found locations" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Choose Assets and any required related Assets" })).toBeNull();
        expect(document.querySelector("[aria-current='step']")?.textContent).toBe("Complete");
        fireEvent.click(await screen.findByRole("button", { name: "Back" }));
        expect(await screen.findByRole("heading", { name: "Which tools do you use?" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Start scan" }));
        const finish = await screen.findByRole("button", { name: "Finish without importing" });
        fireEvent.click(finish);
        await vi.waitFor(() => expect(fixture.completeOnboarding).toHaveBeenCalledOnce());
        expect(catalogChanged).not.toHaveBeenCalled();

        expect(fixture.requestedMethods).not.toContain("watched_scan_intent.replace");
        expect(fixture.startedMethods).not.toContain("adapter.read");
        expect([...fixture.requestedMethods, ...fixture.startedMethods]).not.toContain("deployment.deploy");
        expect([...fixture.requestedMethods, ...fixture.startedMethods]).not.toContain("deployment.create");
    });

    it("uses the retained Project subject for a first-run Project source scan", async () => {
        const targetProjectId = "11111111-1111-4111-8111-111111111111";
        const projectRoot = "/workspace/exact-project";
        const projectRootSelectionToken = "onboarding-project-root-token";
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const source = {
            ...probeSource("onboarding-project-source", "onboarding-project-source", projectRoot),
            rootRole: "project_actual" as const,
        };
        const probeProject = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                probeToken: "onboarding-project-probe",
                results: [
                    {
                        ...baseResult,
                        runtimes: [{ ...baseRuntime, sourceRootRowIds: [source.rowId] }],
                        sources: [source],
                        projects: [
                            {
                                rowId: "onboarding-project-row",
                                observedProjectId: "onboarding-project",
                                displayName: "Exact Project",
                                workspaceSourceRowIds: [source.rowId],
                                containedSourceRootRowIds: [source.rowId],
                                diagnostics: [],
                            },
                        ],
                    },
                ],
            },
            diagnostics: [],
        }));
        const client = fakeDiscoveryClient({
            listProjects: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    projects: [
                        {
                            projectId: targetProjectId,
                            displayName: "Exact Project",
                            rootPath: projectRoot,
                            deleted: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                diagnostics: [],
            })),
            probeProject,
        });
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({
            status: "authorized" as const,
            displayPath: projectRoot,
            localPathSelectionToken: projectRootSelectionToken,
        }));
        renderWithPresentation(
            createElement(OnboardingPage, {
                client,
                assetCount: 0,
                preferredProjectId: targetProjectId,
                authorizeRegisteredProjectRoot,
            }),
        );

        await startFreshJourney();
        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(targetProjectId);
        expect(probeProject).toHaveBeenCalledWith(
            ["CLAUDECODE"],
            [ENVIRONMENT],
            projectRootSelectionToken,
            undefined,
            expect.any(Function),
        );
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("refreshes the catalog before completing onboarding after an Asset import", async () => {
        const fixture = onboardingFixture();
        const client = fakeImportableDiscoveryClient();
        const catalogChanged = vi.fn(async () => undefined);
        const complete = vi.fn();
        renderWithPresentation(
            createElement(OnboardingPage, {
                client,
                assetCount: 0,
                onCatalogChanged: catalogChanged,
                onComplete: complete,
            }),
            fixture.bridge,
        );

        await reachSourceReview();
        expect(sourceCard("/brand-new").dataset.oaamSourceSelected).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        expect(((await screen.findByRole("checkbox", { name: "Select Portable guidance" })) as HTMLInputElement).checked).toBe(
            true,
        );
        expect(screen.queryByRole("heading", { name: "Review found locations" })).toBeNull();
        expect(document.querySelector("[data-oaam-step='assets'] .journey-stage:not([hidden]) .source-review-list")).toBeNull();
        expect(screen.queryByRole("combobox", { name: "How to save Portable guidance" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));
        await clickSemanticAction("onboarding.library.completion", "onboarding.open_library", {
            expected: complete,
            expectedArgs: [],
            unrelated: [],
            root: await screen.findByRole("button", { name: "Open workspace" }),
        });
        expect(catalogChanged).toHaveBeenCalledOnce();
        expect(fixture.completeOnboarding).toHaveBeenCalledOnce();
        expect(catalogChanged.mock.invocationCallOrder[0]).toBeLessThan(
            fixture.completeOnboarding.mock.invocationCallOrder[0] ?? 0,
        );
        expect(fixture.completeOnboarding.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0] ?? 0);
    });

    it("lets the user finish a populated review without importing anything", async () => {
        const fixture = onboardingFixture();
        const client = fakeImportableDiscoveryClient();
        const complete = vi.fn();
        renderWithPresentation(createElement(OnboardingPage, { client, assetCount: 0, onComplete: complete }), fixture.bridge);

        await reachSourceReview();
        expect(sourceCard("/brand-new").dataset.oaamSourceSelected).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByRole("heading", { name: "Choose Assets and any required related Assets" });
        fireEvent.click(screen.getByRole("button", { name: "Continue without importing" }));

        expect(await screen.findByRole("heading", { name: "Finish when the source snapshot looks right" })).not.toBeNull();
        await vi.waitFor(() => expect(client.cancelImportPreview).toHaveBeenCalledOnce());
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Finish without importing" }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    });

    it("allows setup later without loading discovery settings or scanning", async () => {
        const fixture = onboardingFixture();
        renderWithPresentation(createElement(OnboardingPage, { client: fixture.client, assetCount: 0 }), fixture.bridge);

        await clickSemanticAction("onboarding.library.later", "onboarding.open_library", {
            expected: fixture.completeOnboarding,
            expectedArgs: [],
            unrelated: [],
            root: await screen.findByRole("button", { name: "Set up later" }),
        });
        expect(fixture.requestedMethods).toEqual([]);
        expect(fixture.startedMethods).toEqual([]);
    });

    it("permits Back to the explicit location choice and welcome after a one-time local auto-skip", async () => {
        const fixture = onboardingFixture({ completeFails: true });
        renderWithPresentation(createElement(OnboardingPage, { client: fixture.client, assetCount: 0 }), fixture.bridge);

        fireEvent.click(await screen.findByRole("button", { name: "Start guided setup" }));
        await screen.findByRole("heading", { name: "Which tools do you use?" });
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByRole("heading", { name: "Where should OAAM look?" })).not.toBeNull();
        fireEvent.click(await screen.findByRole("button", { name: "Back" }));
        fireEvent.click(await screen.findByRole("button", { name: "Set up later" }));

        expect((await screen.findByRole("alert")).textContent).toContain("could not save onboarding completion");
        expect(fixture.startedMethods).toEqual([]);
    });

    it("cancels the exact retained preview before returning to source review", async () => {
        const client = fakeDiscoveryClient();
        const bridge = createDesktopPresentationTestBridge();
        const complete = vi.fn();
        renderWithPresentation(createElement(OnboardingPage, { client, assetCount: 1, onComplete: complete }), bridge);

        await reachSourceReview();
        expect(sourceCard("/brand-new").dataset.oaamSourceSelected).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByRole("heading", { name: "No Assets ready to import" });
        fireEvent.click(interactionElement("pages.onboarding_page.003"));

        await vi.waitFor(() => expect(client.cancelImportPreview).toHaveBeenCalledOnce());
        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByRole("heading", { name: "No Assets ready to import" });
        fireEvent.click(await screen.findByRole("button", { name: "Finish without importing" }));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        expect(client.cancelImportPreview).toHaveBeenCalledTimes(2);
    });

    it("keeps onboarding open and reports a failed presentation-only completion write", async () => {
        const fixture = onboardingFixture({ completeFails: true });
        renderWithPresentation(
            createElement(OnboardingPage, {
                client: fixture.client,
                assetCount: 0,
            }),
            fixture.bridge,
        );
        await startFreshJourney();
        await screen.findByRole("heading", { name: "No Assets ready to import" });
        const finish = await screen.findByRole("button", { name: "Finish without importing" });
        fireEvent.click(finish);
        expect((await screen.findByRole("alert")).textContent).toContain("could not save onboarding completion");
    });

    it("cannot complete from a stale failed rescan or while a selected-source read is still running", async () => {
        const staleFixture = onboardingFixture({ probeFailsOnSecond: true, withSource: true });
        renderWithPresentation(
            createElement(OnboardingPage, {
                client: staleFixture.client,
                assetCount: 0,
            }),
            staleFixture.bridge,
        );
        await startFreshJourney();
        await screen.findByRole("heading", { name: "Review found locations" });
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        fireEvent.click(screen.getByRole("button", { name: "Start scan" }));
        await screen.findByText("OAAM could not finish checking this item.");
        expect(screen.getByText("Original detail: The fresh discovery failed.")).not.toBeNull();
        expect(screen.queryByRole("heading", { name: "Review found locations" })).toBeNull();
        cleanup();

        const busyFixture = onboardingFixture({ withSource: true });
        renderWithPresentation(
            createElement(OnboardingPage, {
                client: busyFixture.client,
                assetCount: 0,
            }),
            busyFixture.bridge,
        );
        await reachSourceReview();
        expect(sourceCard("/workspace/source").dataset.oaamSourceSelected).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByText("Reading selected sources…");
        expect(screen.queryByRole("button", { name: "Finish without importing" })).toBeNull();
        expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
        expect(busyFixture.startedMethods).toEqual(["adapter.probe", "adapter.read"]);
    });

    it("continues readable onboarding locations automatically and retains failed-root notes", async () => {
        const readSources = vi
            .fn<DesktopApplicationClientApi["readSources"]>()
            .mockResolvedValueOnce({
                status: "partial" as const,
                value: {
                    readToken: "partial-read",
                    reports: [
                        {
                            adapterId: "CLAUDECODE",
                            agentRuntimeId: "CLAUDE_CODE_CLI",
                            sourceRootId: "root-source-moved",
                            status: "complete" as const,
                            candidateCount: 1,
                            diagnostics: [],
                        },
                        {
                            adapterId: "CLAUDECODE",
                            agentRuntimeId: "CLAUDE_CODE_CLI",
                            sourceRootId: "root-source-new",
                            status: "failed" as const,
                            candidateCount: 0,
                            diagnostics: [
                                {
                                    severity: "error" as const,
                                    code: "read.invalid_closure",
                                    operation: "read" as const,
                                    causeKind: "invalid_schema" as const,
                                    retryable: true,
                                    suggestedActions: ["retry" as const],
                                    message: "The source returned an invalid closure.",
                                },
                            ],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "complete",
                value: {
                    readToken: "complete-read",
                    reports: [
                        {
                            adapterId: "CLAUDECODE",
                            agentRuntimeId: "CLAUDE_CODE_CLI",
                            sourceRootId: "root-source-moved",
                            status: "complete",
                            candidateCount: 0,
                            diagnostics: [],
                        },
                    ],
                    candidateCount: 0,
                },
                diagnostics: [],
            });
        const client = fakeDiscoveryClient({ readSources });
        vi.mocked(client.previewImport).mockResolvedValueOnce(INVALID_READ_PREVIEW);
        renderWithPresentation(createElement(OnboardingPage, { client, assetCount: 0 }), createDesktopPresentationTestBridge());

        await reachSourceReview();
        expect(sourceCard("/new").dataset.oaamSourceSelected).toBe("true");
        expect(sourceCard("/brand-new").dataset.oaamSourceSelected).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));

        expect(await screen.findByRole("heading", { name: "Choose Assets and any required related Assets" })).not.toBeNull();
        expect(readSources).toHaveBeenCalledTimes(2);
        expect(readSources).toHaveBeenNthCalledWith(2, {
            probeToken: "probe-token",
            selections: [{ probeResultRowId: "result-1", sourceRootRowIds: ["source-moved"] }],
        });
        expect(screen.getByText("The selected sources contain no Assets ready to import.")).not.toBeNull();
        fireEvent.click(screen.getByText("Scan notes · 1"));
        expect(document.querySelector(".import-read-notes code")?.textContent).toBe("/brand-new");
    });
});
