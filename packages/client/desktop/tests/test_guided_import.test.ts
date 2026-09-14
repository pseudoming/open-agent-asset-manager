import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { interactionElement } from "./desktop-interaction-test-harness";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import {
    EMPTY_WATCHED,
    fakeDiscoveryClient,
    fakeImportableDiscoveryClient,
    PROBE,
    probeSource,
    required,
} from "./discovery-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";
import { INVALID_READ_PREVIEW } from "./import-review-test-fixtures";

afterEach(cleanup);

describe("Desktop ordinary guided import", () => {
    function sourceCard(path: string): HTMLElement {
        const card = [...document.querySelectorAll<HTMLElement>("[data-oaam-source-path]")].find(
            (candidate) => candidate.dataset.oaamSourcePath === path,
        );
        if (card === undefined) throw new Error(`Source card ${path} is required`);
        return card;
    }

    async function ignoreSource(path: string, client: DesktopApplicationClientApi): Promise<void> {
        const replaceWatchedScanIntent = client.replaceWatchedScanIntent as ReturnType<typeof vi.fn>;
        const callCount = replaceWatchedScanIntent.mock.calls.length;
        fireEvent.click(within(sourceCard(path)).getByRole("button", { name: "Ignore this location" }));
        fireEvent.click(within(sourceCard(path)).getByRole("button", { name: "Ignore" }));
        await vi.waitFor(() => expect(replaceWatchedScanIntent).toHaveBeenCalledTimes(callCount + 1));
        await vi.waitFor(() =>
            expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(false),
        );
    }

    async function reachSourceReview(): Promise<void> {
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
    }

    async function prepareBrandNewSource(client: DesktopApplicationClientApi): Promise<void> {
        await reachSourceReview();
        expect(sourceCard("/brand-new").dataset.oaamSourceState).toBe("included");
        await ignoreSource("/new", client);
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
    }

    it("uses a distinct route and never mutates first-run completion", async () => {
        const client = fakeDiscoveryClient();
        const close = vi.fn();
        const catalogChanged = vi.fn(async () => undefined);
        const completeOnboarding = vi.fn();
        const bridge = {
            ...createDesktopPresentationTestBridge(),
            completeOnboarding,
        };
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 3,
                onClose: close,
                onCatalogChanged: catalogChanged,
            }),
            bridge,
        );

        expect(screen.getByRole("heading", { name: "Find and import Assets from your AI coding tools" })).not.toBeNull();
        expect(screen.queryByText("First run")).toBeNull();
        expect(document.querySelector("[data-oaam-route='guided_import']")).not.toBeNull();
        await screen.findByRole("heading", { name: "Which tools do you use?" });
        expect(document.querySelector("[aria-current='step']")?.textContent).toBe("AI coding tools");

        await reachSourceReview();
        expect(screen.getByText("Selected locations are used for this scan and saved for future manual scans.")).not.toBeNull();
        await vi.waitFor(() => expect(client.probeGlobal).toHaveBeenCalledOnce());
        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        await ignoreSource("/new", client);
        await ignoreSource("/brand-new", client);
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        expect(await screen.findByRole("heading", { name: "No sources selected" })).not.toBeNull();
        expect(screen.getByText("No source locations were selected for this import. Nothing was imported.")).not.toBeNull();
        expect(document.querySelector("[aria-current='step']")?.textContent).toBe("Complete");
        fireEvent.click(screen.getByRole("button", { name: "Back to sources" }));
        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Skip guided import" }));

        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(catalogChanged).not.toHaveBeenCalled();
        expect(completeOnboarding).not.toHaveBeenCalled();
        expect(client.readSources).not.toHaveBeenCalled();
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
    });

    it("cancels the exact retained preview before leaving and stays visible when cancellation fails", async () => {
        const cancelImportPreview = vi.fn(async () => ({
            status: "failed" as const,
            diagnostics: [
                {
                    severity: "error" as const,
                    code: "import.preview_still_active",
                    operation: "import" as const,
                    causeKind: "conflict" as const,
                    retryable: true,
                    suggestedActions: ["retry"] as const,
                    message: "Preview remains active.",
                },
            ],
        }));
        const client = fakeDiscoveryClient({ cancelImportPreview });
        const close = vi.fn();
        let leaveGuard: (() => Promise<boolean>) | undefined;
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 0,
                onClose: close,
                onLeaveGuardChange: (nextLeaveGuard) => {
                    leaveGuard = nextLeaveGuard;
                },
            }),
        );

        await prepareBrandNewSource(client);
        await screen.findByRole("heading", { name: "No Assets ready to import" });
        expect(screen.queryByRole("heading", { name: "Review found locations" })).toBeNull();
        expect(document.querySelector("[data-oaam-step='assets'] .journey-stage:not([hidden]) .source-review-list")).toBeNull();
        await vi.waitFor(() => expect(leaveGuard).toBeTypeOf("function"));
        expect(await leaveGuard?.()).toBe(false);

        await vi.waitFor(() => expect(cancelImportPreview).toHaveBeenCalledWith({ previewToken: "preview-token" }));
        expect(close).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be closed"));
        expect(screen.getByRole("heading", { name: "No Assets ready to import" })).not.toBeNull();
        expect(screen.queryByRole("heading", { name: "Choose Assets and any required related Assets" })).toBeNull();
    });

    it("returns through a successfully cancelled preview and keeps source review reusable", async () => {
        const client = fakeDiscoveryClient();
        const close = vi.fn();
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: close }));

        await prepareBrandNewSource(client);
        await screen.findByRole("heading", { name: "No Assets ready to import" });
        fireEvent.click(interactionElement("pages.guided_import_page.002"));

        await vi.waitFor(() => expect(client.cancelImportPreview).toHaveBeenCalledOnce());
        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Skip guided import" }));
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    });

    it("returns an expired review to source selection and permits a new scan", async () => {
        const previewImport = vi
            .fn<DesktopApplicationClientApi["previewImport"]>()
            .mockResolvedValueOnce({
                status: "failed",
                diagnostics: [
                    {
                        severity: "error",
                        code: "host.review_record_unavailable",
                        operation: "import",
                        causeKind: "conflict",
                        retryable: false,
                        suggestedActions: ["rescan"],
                        message: "The retained review expired.",
                    },
                ],
            })
            .mockResolvedValueOnce({
                status: "complete",
                value: { previewToken: "replacement-preview", candidates: [] },
                diagnostics: [],
            });
        const client = fakeDiscoveryClient({ previewImport });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        await reachSourceReview();
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        expect(await screen.findByRole("heading", { name: "Fresh discovery required" })).not.toBeNull();
        fireEvent.click(interactionElement("features.import-review.import_review_workspace.018"));

        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        expect(await screen.findByRole("heading", { name: "No Assets ready to import" })).not.toBeNull();
        expect(previewImport).toHaveBeenCalledTimes(2);
    });

    it("reports a completed library import without turning it into onboarding or deployment", async () => {
        const client = { ...fakeImportableDiscoveryClient(), deploy: vi.fn() };
        const close = vi.fn();
        const catalogChanged = vi.fn(async () => undefined);
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 4,
                onClose: close,
                onCatalogChanged: catalogChanged,
            }),
        );

        await prepareBrandNewSource(client);
        await screen.findByRole("heading", { name: "Choose Assets and any required related Assets" });
        expect(screen.queryByRole("button", { name: "Close Asset review" })).toBeNull();
        expect(screen.getByRole("button", { name: "Back" })).not.toBeNull();
        expect(
            screen.getByRole("button", { name: "Finish without importing" }).classList.contains("library-secondary-button"),
        ).toBe(true);
        expect(((await screen.findByRole("checkbox", { name: "Select Portable guidance" })) as HTMLInputElement).checked).toBe(
            true,
        );
        expect(screen.queryByRole("combobox", { name: "How to save Portable guidance" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));

        expect(await screen.findByRole("heading", { name: "Import results" })).not.toBeNull();
        expect(screen.getByText("New Asset saved in the OAAM library")).not.toBeNull();
        expect(client.deploy).not.toHaveBeenCalled();
        await clickSemanticAction("guided_import.previous.completion", "guided_import.open_previous", {
            expected: close,
            expectedArgs: [],
            unrelated: [],
            root: screen.getByRole("button", { name: "Return to workspace" }),
        });
        expect(catalogChanged).toHaveBeenCalledOnce();
        expect(catalogChanged.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0] ?? 0);
    });

    it("lets the user finish a populated review without importing anything", async () => {
        const client = fakeImportableDiscoveryClient();
        const close = vi.fn();
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: close }));

        await prepareBrandNewSource(client);
        await screen.findByRole("heading", { name: "Choose Assets and any required related Assets" });
        fireEvent.click(screen.getByRole("button", { name: "Finish without importing" }));

        expect(await screen.findByRole("heading", { name: "Scan review complete" })).not.toBeNull();
        await vi.waitFor(() => expect(client.cancelImportPreview).toHaveBeenCalledOnce());
        expect(client.acceptImportBatch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Return to workspace" }));
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    });

    it("keeps the user on tool selection when enablement cannot be saved", async () => {
        const replaceAdapterEnablement = vi.fn(async () => ({
            status: "failed" as const,
            diagnostics: [
                {
                    severity: "error" as const,
                    code: "settings.stale",
                    operation: "settings" as const,
                    causeKind: "conflict" as const,
                    retryable: true,
                    suggestedActions: ["retry"] as const,
                    message: "The tool selection changed elsewhere.",
                },
            ],
        }));
        const client = fakeDiscoveryClient({ replaceAdapterEnablement });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        fireEvent.click(await screen.findByRole("checkbox", { name: "OpenCode" }));
        fireEvent.click(screen.getByRole("button", { name: "Start scan" }));

        await vi.waitFor(() => expect(replaceAdapterEnablement).toHaveBeenCalledOnce());
        expect(document.querySelector("[data-oaam-step='tools']")).not.toBeNull();
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect((await screen.findByRole("alert")).textContent).toContain("were not saved");
    });

    it("keeps the user on source review when the follow-location decision cannot be saved", async () => {
        const replaceWatchedScanIntent = vi.fn(async () => ({
            status: "failed" as const,
            diagnostics: [
                {
                    severity: "error" as const,
                    code: "settings.stale",
                    operation: "settings" as const,
                    causeKind: "conflict" as const,
                    retryable: true,
                    suggestedActions: ["retry"] as const,
                    message: "The location choices changed elsewhere.",
                },
            ],
        }));
        const client = fakeDiscoveryClient({ replaceWatchedScanIntent });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        await reachSourceReview();
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));

        await vi.waitFor(() => expect(replaceWatchedScanIntent).toHaveBeenCalledOnce());
        expect(document.querySelector("[data-oaam-step='sources']")).not.toBeNull();
        expect(client.readSources).not.toHaveBeenCalled();
        expect((await screen.findByRole("alert")).textContent).toContain("were not saved");
    });

    it("finishes saving selected scan locations before reading candidates", async () => {
        let finishSave: (() => void) | undefined;
        const replaceWatchedScanIntent = vi.fn(
            () =>
                new Promise<Awaited<ReturnType<DesktopApplicationClientApi["replaceWatchedScanIntent"]>>>((resolve) => {
                    finishSave = () =>
                        resolve({
                            status: "complete",
                            value: { ...EMPTY_WATCHED, revision: 1, settingFingerprint: "c".repeat(64) },
                            diagnostics: [],
                        });
                }),
        );
        const client = fakeDiscoveryClient({ replaceWatchedScanIntent });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        await reachSourceReview();
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await vi.waitFor(() => expect(replaceWatchedScanIntent).toHaveBeenCalledOnce());
        expect(client.readSources).not.toHaveBeenCalled();
        expect(document.querySelector("[data-oaam-step='sources']")).not.toBeNull();

        required(finishSave, "pending watched-source save")();
        await vi.waitFor(() => expect(client.readSources).toHaveBeenCalledOnce());
        expect(replaceWatchedScanIntent.mock.invocationCallOrder[0]).toBeLessThan(
            (client.readSources as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0,
        );
    });

    it("registers a newly discovered Project from its exact scan snapshot without opening a file picker", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const projectRoot = {
            ...probeSource("project-root", "project-root", "/work/discovered-project"),
            rootRole: "project_actual" as const,
        };
        const probeGlobal = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                ...PROBE,
                probeToken: "project-probe",
                results: [
                    {
                        ...baseResult,
                        runtimes: [
                            {
                                ...baseRuntime,
                                sourceRootRowIds: [...baseRuntime.sourceRootRowIds, projectRoot.rowId],
                            },
                        ],
                        sources: [...baseResult.sources, projectRoot],
                        projects: [
                            {
                                rowId: "discovered-project-row",
                                observedProjectId: "discovered-project",
                                displayName: "Discovered project",
                                workspaceSourceRowIds: [projectRoot.rowId],
                                containedSourceRootRowIds: [projectRoot.rowId],
                                diagnostics: [],
                            },
                        ],
                    },
                ],
            },
            diagnostics: [],
        }));
        const registerProject = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                projectId: "11111111-1111-4111-8111-111111111111",
                displayName: "My workspace",
                rootPath: "/work/discovered-project",
                deleted: false,
                createdAt: 1,
                updatedAt: 1,
            },
            diagnostics: [],
        }));
        const authorizeObservedProjectRoot = vi.fn(async () => ({
            status: "authorized" as const,
            displayPath: "/work/discovered-project",
            localPathSelectionToken: "exact-project-token",
        }));
        const revealObservedProjectRoot = vi.fn(async () => ({ status: "complete" as const }));
        const client = fakeDiscoveryClient({
            probeGlobal,
            registerProject,
            listProjects: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    projects: [
                        {
                            projectId: "22222222-2222-4222-8222-222222222222",
                            displayName: "Another workspace",
                            rootPath: "/work/another-project",
                            deleted: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 0,
                authorizeObservedProjectRoot,
                revealObservedProjectRoot,
                onClose: vi.fn(),
            }),
        );

        await reachSourceReview();
        expect(screen.queryByRole("heading", { name: "Other Project folders" })).toBeNull();
        const projectCard = sourceCard("/work/discovered-project");
        const projectDestination = within(projectCard).getByRole("radiogroup", { name: "Store in library" });
        expect(within(projectDestination).getByRole<HTMLInputElement>("radio", { name: "Project" }).checked).toBe(true);
        expect(within(projectDestination).getByRole<HTMLInputElement>("radio", { name: "Project" }).disabled).toBe(false);
        expect(within(projectDestination).getByRole<HTMLInputElement>("radio", { name: "Global" }).disabled).toBe(false);
        expect(
            within(projectCard).getByText("Register this folder to keep the Assets found here with this Project."),
        ).not.toBeNull();
        const continueButton = screen.getByRole("button", { name: "Scan selected locations" });
        expect((continueButton as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(within(projectDestination).getByRole("radio", { name: "Global" }));
        expect(within(projectDestination).getByRole<HTMLInputElement>("radio", { name: "Global" }).checked).toBe(true);
        expect(within(projectCard).queryByRole("button", { name: "Register as Project" })).toBeNull();
        expect((continueButton as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(within(projectDestination).getByRole("radio", { name: "Project" }));
        expect(within(projectDestination).getByRole<HTMLInputElement>("radio", { name: "Project" }).checked).toBe(true);
        expect((continueButton as HTMLButtonElement).disabled).toBe(true);
        const addProject = within(projectCard).getByRole("button", { name: "Register as Project" });
        const skipProject = within(projectCard).getByRole("button", { name: "Ignore this location" });
        expect(addProject.getAttribute("data-oaam-project-decision")).toBe("add");
        expect(skipProject.getAttribute("data-oaam-project-decision")).toBe("skip");
        expect(skipProject.closest("[data-oaam-project-proposal-key]")).not.toBeNull();
        fireEvent.click(addProject);

        const dialog = await screen.findByRole("dialog", { name: "Register this Project" });
        expect(dialog.parentElement?.parentElement).toBe(document.body);
        expect(within(dialog).getByText("/work/discovered-project")).not.toBeNull();
        expect(
            within(dialog).getByText("Give this Project the name you want to see in OAAM. The folder below came from this scan."),
        ).not.toBeNull();
        expect(within(dialog).getByLabelText<HTMLInputElement>("Project name").value).toBe("Discovered project");
        fireEvent.click(within(dialog).getByRole("button", { name: "View in file manager" }));
        await vi.waitFor(() => {
            expect(revealObservedProjectRoot).toHaveBeenCalledWith({
                probeToken: "project-probe",
                probeResultRowId: baseResult.rowId,
                projectRowId: "discovered-project-row",
                sourceRootRowId: projectRoot.rowId,
            });
        });
        expect(screen.getByRole("dialog", { name: "Register this Project" })).toBe(dialog);
        fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "My workspace" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Register Project" }));

        await vi.waitFor(() => {
            expect(authorizeObservedProjectRoot).toHaveBeenCalledWith({
                probeToken: "project-probe",
                probeResultRowId: baseResult.rowId,
                projectRowId: "discovered-project-row",
                sourceRootRowId: projectRoot.rowId,
            });
            expect(registerProject).toHaveBeenCalledWith({
                localPathSelectionToken: "exact-project-token",
                displayName: "My workspace",
            });
            expect(
                within(sourceCard("/work/discovered-project")).queryByRole("button", {
                    name: "Register as Project",
                }),
            ).toBeNull();
            expect(
                within(sourceCard("/work/discovered-project")).getByRole("combobox", { name: "Choose a Project" }).textContent,
            ).toBe("Project: My workspace");
            expect((continueButton as HTMLButtonElement).disabled).toBe(false);
        });
        expect(screen.queryByRole("dialog", { name: "Register this Project" })).toBeNull();

        const registeredCard = sourceCard("/work/discovered-project");
        const registeredDestination = within(registeredCard).getByRole("radiogroup", { name: "Store in library" });
        fireEvent.click(within(registeredDestination).getByRole("radio", { name: "Global" }));
        expect(within(registeredDestination).getByRole<HTMLInputElement>("radio", { name: "Global" }).checked).toBe(true);
        fireEvent.click(within(registeredDestination).getByRole("radio", { name: "Project" }));
        await vi.waitFor(() => {
            expect(within(registeredDestination).getByRole<HTMLInputElement>("radio", { name: "Project" }).checked).toBe(true);
            expect(within(registeredCard).getByRole("combobox", { name: "Choose a Project" }).textContent).toBe(
                "Project: My workspace",
            );
        });
    });

    it("keeps an exact detached Project proposal decisionable instead of deadlocking source review", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const detachedProjectRoot = {
            ...probeSource("detached-project-root", "detached-project-root", "/work/detached-project"),
            rootRole: "source" as const,
            sourceDomain: "agent_runtime_private" as const,
        };
        const client = fakeDiscoveryClient({
            probeGlobal: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    ...PROBE,
                    probeToken: "detached-project-probe",
                    results: [
                        {
                            ...baseResult,
                            sources: [...baseResult.sources, detachedProjectRoot],
                            projects: [
                                {
                                    rowId: "detached-project-row",
                                    observedProjectId: "detached-project",
                                    displayName: "Detached project",
                                    workspaceSourceRowIds: [detachedProjectRoot.rowId],
                                    containedSourceRootRowIds: [detachedProjectRoot.rowId],
                                    diagnostics: [],
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        const authorizeObservedProjectRoot = vi.fn();
        const revealObservedProjectRoot = vi.fn(async () => ({ status: "complete" as const }));
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 0,
                authorizeObservedProjectRoot,
                revealObservedProjectRoot,
                onClose: vi.fn(),
            }),
        );

        await reachSourceReview();
        const projectReview = screen.getByRole("heading", { name: "Other Project folders" }).closest("section");
        if (projectReview === null) throw new Error("Detached Project review is required");
        expect(within(projectReview).getByText("/work/detached-project")).not.toBeNull();
        const continueButton = screen.getByRole("button", { name: "Scan selected locations" });
        expect((continueButton as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(within(projectReview).getByRole("button", { name: "Register as Project" }));
        expect(await screen.findByRole("dialog", { name: "Register this Project" })).not.toBeNull();
        expect(authorizeObservedProjectRoot).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(within(projectReview).getByRole("button", { name: "Do not register now" }));
        await vi.waitFor(() => {
            expect(within(projectReview).queryByRole("button", { name: "Do not register now" })).toBeNull();
            expect((continueButton as HTMLButtonElement).disabled).toBe(false);
        });
    });

    it("does not re-block a Project source whose whole location remains explicitly ignored", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const projectRoot = {
            ...probeSource("ignored-project-root", "ignored-project-root", "/work/ignored-project"),
            rootRole: "project_actual" as const,
        };
        const client = fakeDiscoveryClient({
            getWatchedScanIntent: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    ...EMPTY_WATCHED,
                    revision: 1,
                    environments: [
                        {
                            environment: baseResult.environment,
                            sourceSelectors: [
                                {
                                    disposition: "excluded" as const,
                                    source: {
                                        adapterId: baseResult.adapterId,
                                        rootRole: "project_actual" as const,
                                        sourceDomain: "project_root" as const,
                                        canonicalPath: projectRoot.displayPath,
                                        locatorIdentities: projectRoot.locatorIdentities,
                                    },
                                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                    selectorFingerprint: "c".repeat(64),
                                },
                            ],
                        },
                    ],
                    updatedAt: 1,
                    settingFingerprint: "d".repeat(64),
                },
                diagnostics: [],
            })),
            probeGlobal: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    ...PROBE,
                    probeToken: "ignored-project-probe",
                    results: [
                        {
                            ...baseResult,
                            runtimes: [
                                {
                                    ...baseRuntime,
                                    sourceRootRowIds: [...baseRuntime.sourceRootRowIds, projectRoot.rowId],
                                },
                            ],
                            sources: [...baseResult.sources, projectRoot],
                            projects: [
                                {
                                    rowId: "ignored-project-row",
                                    observedProjectId: "ignored-project",
                                    displayName: "Ignored project",
                                    workspaceSourceRowIds: [projectRoot.rowId],
                                    containedSourceRootRowIds: [projectRoot.rowId],
                                    diagnostics: [],
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        await reachSourceReview();
        const projectCard = sourceCard("/work/ignored-project");
        expect(projectCard.dataset.oaamSourceState).toBe("ignored");
        expect(within(projectCard).queryByRole("button", { name: "Register as Project" })).toBeNull();
        expect(document.querySelector("[data-oaam-project-decision='skip']")).toBeNull();
        expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("keeps cancelled, stale, and failed Project registration unresolved before permitting an explicit skip", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const projectRoot = {
            ...probeSource("project-root", "project-root", "/work/discovered-project"),
            rootRole: "project_actual" as const,
        };
        const registerProject = vi.fn(async () => ({
            status: "failed" as const,
            diagnostics: [
                {
                    severity: "error" as const,
                    code: "project.root_is_link",
                    operation: "project" as const,
                    causeKind: "invalid_schema" as const,
                    retryable: false,
                    suggestedActions: [],
                    message: "root is a reparse point",
                    path: "/work/discovered-project",
                },
            ],
        }));
        const client = fakeDiscoveryClient({
            registerProject,
            probeGlobal: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    ...PROBE,
                    probeToken: "project-probe",
                    results: [
                        {
                            ...baseResult,
                            runtimes: [
                                {
                                    ...baseRuntime,
                                    sourceRootRowIds: [...baseRuntime.sourceRootRowIds, projectRoot.rowId],
                                },
                            ],
                            sources: [...baseResult.sources, projectRoot],
                            projects: [
                                {
                                    rowId: "discovered-project-row",
                                    observedProjectId: "discovered-project",
                                    displayName: "Discovered project",
                                    workspaceSourceRowIds: [projectRoot.rowId],
                                    containedSourceRootRowIds: [projectRoot.rowId],
                                    diagnostics: [],
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        const authorizeObservedProjectRoot = vi
            .fn()
            .mockRejectedValueOnce(new Error("stale observation"))
            .mockResolvedValueOnce({
                status: "authorized" as const,
                displayPath: "/work/a-different-project",
                localPathSelectionToken: "wrong-project-token",
            })
            .mockResolvedValueOnce({
                status: "authorized" as const,
                displayPath: "/work/discovered-project",
                localPathSelectionToken: "failed-project-token",
            });
        const revealObservedProjectRoot = vi
            .fn()
            .mockRejectedValueOnce(new Error("file manager unavailable"))
            .mockResolvedValue({ status: "complete" as const });
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 0,
                authorizeObservedProjectRoot,
                revealObservedProjectRoot,
                onClose: vi.fn(),
            }),
        );

        await reachSourceReview();
        fireEvent.click(screen.getByRole("button", { name: "Register as Project" }));
        fireEvent.click(await screen.findByRole("button", { name: "View in file manager" }));
        expect((await screen.findByRole("alert")).textContent).toContain("could not be opened");
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "Register this Project" })).toBeNull();
        expect(authorizeObservedProjectRoot).not.toHaveBeenCalled();
        expect(registerProject).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Register as Project" }));
        fireEvent.click(await screen.findByRole("button", { name: "Register Project" }));
        expect((await screen.findByRole("alert")).textContent).toContain("scan result is no longer current");
        expect(authorizeObservedProjectRoot).toHaveBeenCalledTimes(1);
        expect(registerProject).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        fireEvent.click(screen.getByRole("button", { name: "Register as Project" }));
        fireEvent.click(await screen.findByRole("button", { name: "Register Project" }));
        expect((await screen.findByRole("alert")).textContent).toContain("scan result is no longer current");
        expect(authorizeObservedProjectRoot).toHaveBeenCalledTimes(2);
        expect(registerProject).not.toHaveBeenCalled();
        expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        fireEvent.click(screen.getByRole("button", { name: "Register as Project" }));
        fireEvent.click(await screen.findByRole("button", { name: "Register Project" }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "This location is a link. Register the folder it points to instead.",
        );
        expect(authorizeObservedProjectRoot).toHaveBeenCalledTimes(3);
        expect(registerProject).toHaveBeenCalledWith({
            localPathSelectionToken: "failed-project-token",
            displayName: "Discovered project",
        });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await ignoreSource("/work/discovered-project", client);
        expect(sourceCard("/work/discovered-project").dataset.oaamSourceState).toBe("ignored");
        expect(within(sourceCard("/work/discovered-project")).queryByText("Technical details")).toBeNull();
        expect(within(sourceCard("/work/discovered-project")).getByText("Not included in scans")).not.toBeNull();
        expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(false);
        const restoreCallCount = (client.replaceWatchedScanIntent as ReturnType<typeof vi.fn>).mock.calls.length;
        fireEvent.click(within(sourceCard("/work/discovered-project")).getByRole("button", { name: "Include again" }));
        await vi.waitFor(() => expect(client.replaceWatchedScanIntent).toHaveBeenCalledTimes(restoreCallCount + 1));
        expect(sourceCard("/work/discovered-project").dataset.oaamSourceState).not.toBe("ignored");
        expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("does not misreport an actionable partial inspection as an empty successful scan", async () => {
        const probeGlobal = vi.fn(async () => ({
            status: "partial" as const,
            value: { probeToken: "partial-probe", results: [] },
            diagnostics: [
                {
                    severity: "warning" as const,
                    code: "probe.path_unavailable",
                    operation: "probe" as const,
                    causeKind: "access" as const,
                    retryable: true,
                    suggestedActions: ["retry"] as const,
                    message: "One selected location could not be inspected.",
                },
            ],
        }));
        const client = fakeDiscoveryClient({
            probeGlobal,
        });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));

        fireEvent.click(await screen.findByRole("button", { name: "Scan again" }));
        await vi.waitFor(() => expect(probeGlobal).toHaveBeenCalledTimes(2));
        expect(document.querySelector("[data-oaam-step='results']")).not.toBeNull();
        expect(document.querySelector("[aria-current='step']")?.textContent).toBe("Results");
        expect(screen.queryByRole("heading", { name: "No Assets ready to import" })).toBeNull();
        expect(screen.queryByRole("heading", { name: "Review found locations" })).toBeNull();
    });

    it("attributes a partial tool location while keeping its readable source available", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const rawDetail = "Project registry entry is incomplete.";
        const client = fakeDiscoveryClient({
            probeGlobal: vi.fn(async () => ({
                status: "partial" as const,
                value: {
                    ...PROBE,
                    probeToken: "partial-with-readable-source",
                    results: [
                        {
                            ...baseResult,
                            status: "partial" as const,
                            diagnostics: [
                                {
                                    severity: "warning" as const,
                                    code: "antigravity_project_registry_entry_incomplete",
                                    operation: "probe" as const,
                                    causeKind: "invalid_schema" as const,
                                    retryable: false,
                                    suggestedActions: ["skip"] as const,
                                    message: rawDetail,
                                    path: "/home/user/.gemini/config/projects/incomplete.json",
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        const { container } = renderWithPresentation(
            createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));

        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        expect(screen.getByLabelText("Scan notes")).not.toBeNull();
        expect(screen.getByText("Scan notes · 1")).not.toBeNull();
        expect(
            required(container.querySelector(".discovery-probe-issue-owner strong"), "ordinary probe issue owner").textContent,
        ).toBe("Claude Code · Local Linux");
        expect(
            required(container.querySelector(".discovery-probe-issue-paths"), "ordinary attributed probe issue list").textContent,
        ).toContain("/home/user/.gemini/config/projects/incomplete.json");
        expect(screen.getByText("An old Project entry that no longer points to an available folder was ignored.")).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain(rawDetail);
        expect(sourceCard("/brand-new").dataset.oaamSourceState).toBe("included");

        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await vi.waitFor(() =>
            expect(client.readSources).toHaveBeenCalledWith({
                probeToken: "partial-with-readable-source",
                selections: [{ probeResultRowId: "result-1", sourceRootRowIds: ["source-moved", "source-new"] }],
            }),
        );
    });

    it("continues readable locations automatically and keeps the failed folder as a scan note", async () => {
        const rawDetail = "The selected source returned an invalid closure.";
        const readSources = vi
            .fn<DesktopApplicationClientApi["readSources"]>()
            .mockResolvedValueOnce({
                status: "partial",
                value: {
                    readToken: "mixed-read",
                    reports: [
                        {
                            adapterId: "CLAUDECODE",
                            agentRuntimeId: "CLAUDE_CODE_CLI",
                            sourceRootId: "root-source-moved",
                            status: "complete",
                            candidateCount: 1,
                            diagnostics: [],
                        },
                        {
                            adapterId: "CLAUDECODE",
                            agentRuntimeId: "CLAUDE_CODE_CLI",
                            sourceRootId: "root-source-new",
                            status: "failed",
                            candidateCount: 0,
                            diagnostics: [
                                {
                                    severity: "error",
                                    code: "read.invalid_closure",
                                    operation: "read",
                                    causeKind: "invalid_schema",
                                    retryable: true,
                                    suggestedActions: ["retry"],
                                    message: rawDetail,
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
        const { container } = renderWithPresentation(
            createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }),
        );

        await reachSourceReview();
        expect(sourceCard("/new").dataset.oaamSourceState).toBe("included");
        expect(sourceCard("/brand-new").dataset.oaamSourceState).toBe("included");
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));

        expect(await screen.findByRole("heading", { name: "Choose Assets and any required related Assets" })).not.toBeNull();
        expect(ordinarySurfaceText(container)).not.toContain(rawDetail);
        await vi.waitFor(() =>
            expect(readSources).toHaveBeenNthCalledWith(2, {
                probeToken: "probe-token",
                selections: [{ probeResultRowId: "result-1", sourceRootRowIds: ["source-moved"] }],
            }),
        );
        expect(screen.getByText("The selected sources contain no Assets ready to import.")).not.toBeNull();
        fireEvent.click(screen.getByText("Scan notes · 1"));
        expect(document.querySelector(".import-read-notes code")?.textContent).toBe("/brand-new");
        expect(screen.queryByRole("button", { name: "Continue with readable locations" })).toBeNull();
        expect(client.previewImport).toHaveBeenCalledWith({ readToken: "complete-read" });
    });
});
