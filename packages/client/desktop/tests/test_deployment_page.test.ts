import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopResolvedLocale,
} from "../src/presentation/presentation-preferences";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { DeploymentPage } from "../src/renderer/pages/DeploymentPage";
import { WorkspacePage } from "../src/renderer/pages/WorkspacePage";
import { RENDER_ANALYSIS } from "./catalog-deployment-test-fixtures";
import { deployment as catalogDeployment } from "./catalog-deployment-test-support";
import {
    ASSET_ID,
    deploymentClient,
    GLOBAL_ASSET,
    importedSourceDeploymentClient,
    missingInstallationProbe,
    ONE_ENABLED_PROVIDER,
    PROJECT,
    PROJECT_ID,
    VERSION_ID,
    WorkspacePageHarness,
} from "./deployment-page-test-fixtures";
import { exerciseKeyboardResize, exercisePersistentInteractionSidebar } from "./desktop-interaction-test-harness";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";
import { ENVIRONMENT, PROBE, PROVIDERS } from "./discovery-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Project-first Deployment route", () => {
    it("opens an existing selected-Project tool-file relationship without scanning and returns to the library", async () => {
        const client = deploymentClient({
            listDeployments: vi.fn(async () => ({
                status: "complete",
                value: {
                    deployments: [
                        {
                            deploymentId: "44444444-4444-4444-8444-444444444444",
                            subject: { subjectKind: "project", projectId: PROJECT_ID },
                            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            environment: { platform: "linux", platformInstanceId: "local" },
                            targetRootPath: PROJECT.rootPath,
                            stage: "in_sync",
                            reason: "applied",
                            actionHints: ["check_now"],
                            freshness: { state: "complete", attemptedAt: 1, lastCompleteAt: 1 },
                            deleted: false,
                            assets: [],
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        const onNavigateReceipt = vi.fn();
        const onOpenGuidedImport = vi.fn();
        const onOpenLibrary = vi.fn();
        const onOpenSources = vi.fn();
        const onOpenSettings = vi.fn();
        const onOpenSearch = vi.fn();
        renderWithPresentation(
            createElement(WorkspacePageHarness, {
                client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                authorizeRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                revealRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                assetCount: 0,
                catalogWarningCount: 0,
                onOpenGuidedImport,
                onOpenLibrary,
                onOpenSources,
                onOpenSettings,
                onOpenSearch,
                onNavigateReceipt,
            }),
        );

        await screen.findByRole("heading", { level: 1, name: "OAAM" });
        await screen.findByRole("button", { name: "OAAM" });
        fireEvent.click(await screen.findByRole("button", { name: "Manage tool locations" }));
        await screen.findByRole("heading", { level: 1, name: "Manage Asset usage" }, { timeout: 3_000 });
        expect(await screen.findByRole("heading", { name: "Check and update tool files" })).toBeTruthy();
        expect(document.querySelector("main[data-oaam-route='deployment']")).toMatchObject({
            dataset: expect.objectContaining({
                oaamSubject: "project",
                oaamProjectId: PROJECT_ID,
            }),
        });
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect(client.probeProject).not.toHaveBeenCalled();
        expect(document.querySelector(".deployment-target-discovery")).toBeNull();

        const deploymentRoot = document.querySelector("main[data-oaam-route='deployment']");
        const backToLibrary = screen.getByRole("button", { name: "Back to library" });
        expect(deploymentRoot?.querySelector(".deployment-sidebar")?.contains(backToLibrary)).toBe(true);
        expect(deploymentRoot?.querySelector(".workbench-resize-separator")).not.toBeNull();
        await clickSemanticAction("deployment.library.sidebar", "deployment.open_library", {
            expected: onNavigateReceipt,
            expectedArgs: [{ surface: "library", subject: "projects", projectId: PROJECT_ID }],
            unrelated: [onOpenGuidedImport, onOpenLibrary, onOpenSources, onOpenSettings, onOpenSearch],
            root: backToLibrary,
        });
        await screen.findByRole("heading", { level: 1, name: "OAAM" });
    });

    it("runs only the explicitly chosen Project or Global target discovery", async () => {
        const probeProject = vi.fn(async (...args: Parameters<DesktopApplicationClientApi["probeProject"]>) => {
            args[4]?.({
                status: "progress",
                operation: "adapter.probe",
                operationId: "probe-progress",
                sequence: 1,
                progress: {
                    stage: "provider_probe",
                    completedUnits: 1,
                    totalUnits: 2,
                    adapterId: "CLAUDECODE",
                    environment: args[1][0],
                    outcome: "complete",
                    elapsedMilliseconds: 123,
                },
            });
            return { status: "partial" as const, value: PROBE, diagnostics: [] };
        });
        const probeGlobal = vi.fn(async () => ({ status: "complete" as const, value: PROBE, diagnostics: [] }));
        const wslEnvironment = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const client = deploymentClient({
            probeProject,
            probeGlobal,
            getAdapterEnablement: vi.fn(async () => ({
                status: "complete" as const,
                value: ONE_ENABLED_PROVIDER,
                diagnostics: [],
            })),
            getProject: vi.fn(async () => ({
                status: "complete" as const,
                value: { found: true as const, value: { ...PROJECT, displayName: "/workspace/oaam" } },
                diagnostics: [],
            })),
            listEnvironments: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    environments: [
                        { environment: ENVIRONMENT, displayName: "Local Linux" },
                        { environment: wslEnvironment, displayName: "wsl:Ubuntu" },
                    ],
                },
                diagnostics: [],
            })),
        });
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({
            status: "authorized" as const,
            displayPath: "\\\\wsl.localhost\\Ubuntu\\home\\example\\wsl_code\\oaam",
            localPathSelectionToken: "project-token",
        }));
        const revealRegisteredProjectRoot = vi.fn(async () => ({ status: "complete" as const }));
        const projectView = renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot,
                onClose: vi.fn(),
            }),
        );

        const projectAction = await screen.findByRole("button", {
            name: "Enable selected tools",
        });
        const targetContext = projectView.container.querySelector(".deployment-target-context");
        const targetStatus = projectView.container.querySelector(".deployment-target-status");
        expect(targetContext?.querySelector(":scope > .deployment-target-providers")).not.toBeNull();
        expect(targetContext?.querySelector(":scope > .deployment-target-environments")).not.toBeNull();
        expect(targetStatus?.querySelector(".deployment-target-project-context")).not.toBeNull();
        expect(targetStatus?.querySelector(".deployment-target-actions")?.contains(projectAction)).toBe(true);
        const projectIdentity = targetStatus?.querySelector(".deployment-target-project-identity");
        expect(projectIdentity?.getAttribute("title")).toMatch(/Current Project:/u);
        expect(projectIdentity?.getAttribute("title")).toBe(projectIdentity?.textContent);
        expect(projectIdentity?.classList.contains("workbench-notice")).toBe(false);
        const providerChoice = screen.getByRole("checkbox", { name: "Claude Code" }) as HTMLInputElement;
        const opencodeChoice = screen.getByRole("checkbox", { name: "OpenCode" }) as HTMLInputElement;
        const selectAll = screen.getByRole("button", { name: "Select all" }) as HTMLButtonElement;
        const clearAll = screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement;
        expect(selectAll.disabled).toBe(true);
        expect(clearAll.disabled).toBe(false);
        fireEvent.click(clearAll);
        expect(providerChoice.checked).toBe(false);
        expect(opencodeChoice.checked).toBe(false);
        expect(selectAll.disabled).toBe(false);
        expect(clearAll.disabled).toBe(true);
        fireEvent.click(selectAll);
        expect(providerChoice.checked).toBe(true);
        expect(opencodeChoice.checked).toBe(true);
        fireEvent.click(providerChoice);
        expect(providerChoice.checked).toBe(false);
        fireEvent.click(providerChoice);
        expect(providerChoice.checked).toBe(true);
        const environmentChoice = screen.getByRole("radio", { name: "WSL — Ubuntu" });
        expect(screen.queryByText("wsl:Ubuntu")).toBeNull();
        expect((environmentChoice as HTMLInputElement).checked).toBe(false);
        expect(screen.queryByRole("button", { name: "Check tools" })).toBeNull();
        fireEvent.click(environmentChoice);
        expect((environmentChoice as HTMLInputElement).checked).toBe(true);
        expect(screen.queryByRole("button", { name: "Check tools" })).toBeNull();
        expect(probeProject).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Enable selected tools" }));
        await waitFor(() => expect(projectAction.textContent).toBe("Check tools"));
        fireEvent.click(projectAction);
        await waitFor(() =>
            expect(probeProject).toHaveBeenCalledWith(
                ["CLAUDECODE", "OPENCODE"],
                [wslEnvironment],
                "project-token",
                undefined,
                expect.any(Function),
            ),
        );
        expect(client.replaceAdapterEnablement).toHaveBeenCalledWith(
            expect.objectContaining({ enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] }),
        );
        expect(vi.mocked(client.replaceAdapterEnablement).mock.invocationCallOrder[0]).toBeLessThan(
            probeProject.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(PROJECT_ID);
        expect(await screen.findByText("Checked 1 of 2 tool/environment combinations")).toBeTruthy();
        expect(
            await screen.findByText(
                "This check is incomplete, but no specific cause was returned. Confirmed results remain available; run the check again if a result is missing.",
            ),
        ).toBeTruthy();
        expect(targetStatus?.querySelector(".deployment-target-result [data-oaam-completed-units='1']")).not.toBeNull();
        expect(screen.queryByText(/Slowest local check/u)).toBeNull();
        expect(document.querySelector(".deployment-target-probe-timing")).toBeNull();
        expect(screen.queryByText("Claude Code: 123 ms")).toBeNull();
        expect(await screen.findByText("Current Project: oaam · /home/example/wsl_code/oaam")).toBeTruthy();
        expect(await screen.findAllByText("Current check unavailable")).toHaveLength(2);
        expect(
            screen.getAllByText(
                "This check could not confirm the tool's current state. Check the tools again to refresh this result.",
            ),
        ).toHaveLength(2);
        expect(screen.queryByRole("combobox", { name: "Tool location" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Open Project folder" }));
        await waitFor(() => expect(revealRegisteredProjectRoot).toHaveBeenCalledWith(PROJECT_ID));
        fireEvent.click(clearAll);
        expect(screen.queryByText("Checked 1 of 2 tool/environment combinations")).toBeNull();
        await waitFor(() => expect(screen.queryAllByText("Current check unavailable")).toHaveLength(0));
        expect(probeGlobal).not.toHaveBeenCalled();
        projectView.unmount();

        const globalClient = deploymentClient({
            probeGlobal,
            getAdapterEnablement: vi.fn(async () => ({
                status: "complete" as const,
                value: ONE_ENABLED_PROVIDER,
                diagnostics: [],
            })),
            listAssets: vi.fn(async () => ({
                status: "complete" as const,
                value: { assets: [GLOBAL_ASSET] },
                diagnostics: [],
            })),
        });
        renderWithPresentation(
            createElement(DeploymentPage, {
                client: globalClient,
                subject: { subjectKind: "global" },
                assetId: GLOBAL_ASSET.assetId,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot,
                onClose: vi.fn(),
            }),
        );
        const globalEnvironmentChoice = await screen.findByRole("checkbox", { name: "Local Linux" });
        expect(screen.getByText(/Choose tools and environments to check for this Global asset/u)).toBeTruthy();
        expect(screen.queryByText(/Choose which tools and environments to check for this Project/u)).toBeNull();
        fireEvent.click(globalEnvironmentChoice);
        expect((globalEnvironmentChoice as HTMLInputElement).checked).toBe(false);
        fireEvent.click(globalEnvironmentChoice);
        expect((globalEnvironmentChoice as HTMLInputElement).checked).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Enable selected tools" }));
        await waitFor(() =>
            expect((screen.getByRole("button", { name: "Check tools" }) as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Check tools" }));
        await waitFor(() =>
            expect(probeGlobal).toHaveBeenCalledWith(["CLAUDECODE", "OPENCODE"], [ENVIRONMENT], undefined, expect.any(Function)),
        );
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledOnce();
        expect(revealRegisteredProjectRoot).toHaveBeenCalledOnce();
    });

    it("keeps a newly reviewed Asset usage inside the same asset-centric route", async () => {
        const exactProbe = {
            ...PROBE,
            results: PROBE.results.map((result) => ({
                ...result,
                targets: [
                    {
                        rowId: "exact-project-target",
                        targetCandidateId: "exact-project-candidate",
                        targetKind: "project" as const,
                        displayName: "OAAM Project",
                        displayPath: PROJECT.rootPath,
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                status: "ready_for_plan" as const,
                                diagnostics: [],
                            },
                        ],
                        diagnostics: [],
                    },
                ],
            })),
        };
        const createdDeployment = catalogDeployment("in_sync", true);
        const createDeployment = vi.fn(async () => ({
            status: "complete" as const,
            value: createdDeployment,
            diagnostics: [],
        }));
        const analyzeDeployment = vi.fn(async () => ({
            status: "complete" as const,
            value: RENDER_ANALYSIS,
            diagnostics: [],
        }));
        const client = deploymentClient({
            supportsOperation: vi.fn(() => true),
            listDeployments: vi.fn(async () => ({
                status: "complete" as const,
                value: { deployments: [] },
                diagnostics: [],
            })),
            probeProject: vi.fn(async () => ({ status: "complete" as const, value: exactProbe, diagnostics: [] })),
            createDeployment,
            analyzeDeployment,
        });
        const onReplaceRoute = vi.fn();
        const { container } = renderWithPresentation(
            createElement(WorkspacePage, {
                client,
                pickProjectRoot: async () => ({ status: "cancelled" }),
                pickInstallationRoot: async () => ({ status: "cancelled" }),
                authorizeRegisteredProjectRoot: async () => ({
                    status: "authorized" as const,
                    displayPath: PROJECT.rootPath,
                    localPathSelectionToken: "project-root-token",
                }),
                revealRegisteredProjectRoot: async () => ({ status: "failed" as const, code: "unavailable" as const }),
                pickAssetVersionExport: async () => ({ status: "cancelled" }),
                assetCount: 1,
                catalogWarningCount: 0,
                route: {
                    surface: "deployment",
                    subject: { subjectKind: "project", projectId: PROJECT_ID },
                    assetId: ASSET_ID,
                },
                sidebarVisible: true,
                inspectorVisible: false,
                onNavigate: vi.fn(),
                onReplaceRoute,
                onInspectorVisibleChange: vi.fn(),
                onOpenGuidedImport: vi.fn(),
                onOpenLibrary: vi.fn(),
                onOpenSources: vi.fn(),
                onOpenSettings: vi.fn(),
                onOpenSearch: vi.fn(),
            }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Check tools" }));
        const review = await screen.findByRole("button", { name: "Preview files to add" });
        fireEvent.click(review);
        await waitFor(() => expect(createDeployment).toHaveBeenCalledOnce());
        await waitFor(() =>
            expect(analyzeDeployment).toHaveBeenCalledWith(
                { deploymentId: createdDeployment.deploymentId },
                expect.any(Function),
            ),
        );
        expect(container.querySelector('[data-oaam-deployment-step="review"]')).not.toBeNull();
        expect(container.querySelector("main[data-oaam-route='deployment']")?.getAttribute("data-oaam-asset-id")).toBe(ASSET_ID);
        expect(onReplaceRoute).not.toHaveBeenCalled();
    });

    it("recovers one missing tool through an exact installation-folder selection", async () => {
        const missingProbe = missingInstallationProbe();
        const foundProbe = {
            ...PROBE,
            results: PROBE.results.map((result) => ({
                ...result,
                runtimes: [
                    {
                        rowId: "found-installation-runtime",
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        versionText: "2.1.0",
                        installationStatus: "available" as const,
                        projectDiscoveryStatus: "complete" as const,
                        sourceRootRowIds: [],
                        diagnostics: [],
                    },
                ],
                targets: [
                    {
                        rowId: "found-installation-target",
                        targetCandidateId: "found-installation-candidate",
                        targetKind: "project" as const,
                        displayName: "OAAM Project",
                        displayPath: PROJECT.rootPath,
                        entryApplicabilities: [
                            {
                                agentRuntimeId: "CLAUDE_CODE_CLI",
                                status: "ready_for_plan" as const,
                                diagnostics: [],
                            },
                        ],
                        diagnostics: [],
                    },
                ],
            })),
        };
        const probeProject = vi
            .fn()
            .mockResolvedValueOnce({ status: "complete" as const, value: missingProbe, diagnostics: [] })
            .mockResolvedValueOnce({ status: "complete" as const, value: foundProbe, diagnostics: [] });
        const client = deploymentClient({ probeProject });
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({
            status: "authorized" as const,
            displayPath: PROJECT.rootPath,
            localPathSelectionToken: "project-root-token",
        }));
        const pickInstallationRoot = vi.fn(async () => ({
            status: "selected" as const,
            displayPath: "/tools/claude",
            localPathSelectionToken: "installation-root-token",
        }));
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                pickInstallationRoot,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Check tools" }));
        expect(await screen.findByText("Not installed")).toBeTruthy();
        const chooseInstallationFolder = screen.getByRole<HTMLButtonElement>("button", {
            name: "Choose installation folder",
        });
        await waitFor(() => expect(chooseInstallationFolder.disabled).toBe(false));
        fireEvent.click(chooseInstallationFolder);
        await waitFor(() =>
            expect(probeProject).toHaveBeenLastCalledWith(
                ["CLAUDECODE"],
                [ENVIRONMENT],
                "project-root-token",
                "installation-root-token",
                expect.any(Function),
            ),
        );
        expect(pickInstallationRoot).toHaveBeenCalledOnce();
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledTimes(2);
        expect(await screen.findByRole("heading", { name: "Where this Asset can be used" })).toBeTruthy();
        expect(await screen.findByText("Not added yet")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Preview files to add" })).toBeTruthy();
        expect(screen.queryByRole("combobox", { name: "Tool location" })).toBeNull();
        expect(screen.queryByText("Not installed")).toBeNull();
    });

    it("never opens the installation picker when the exact Project root cannot be authorized", async () => {
        const probeProject = vi.fn(async () => ({
            status: "complete" as const,
            value: missingInstallationProbe(),
            diagnostics: [],
        }));
        const client = deploymentClient({ probeProject });
        const authorizeRegisteredProjectRoot = vi
            .fn()
            .mockResolvedValueOnce({
                status: "authorized" as const,
                displayPath: PROJECT.rootPath,
                localPathSelectionToken: "project-root-token",
            })
            .mockResolvedValueOnce({ status: "failed" as const, code: "unavailable" as const })
            .mockRejectedValueOnce(new Error("authorization transport failed"));
        const pickInstallationRoot = vi.fn();
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                pickInstallationRoot,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Check tools" }));
        const choose = await screen.findByRole<HTMLButtonElement>("button", { name: "Choose installation folder" });
        await waitFor(() => expect(choose.disabled).toBe(false));
        fireEvent.click(choose);
        await waitFor(() => expect(authorizeRegisteredProjectRoot).toHaveBeenCalledTimes(2));
        expect(await screen.findByText(/could not verify/)).toBeTruthy();
        fireEvent.click(choose);
        await waitFor(() => expect(authorizeRegisteredProjectRoot).toHaveBeenCalledTimes(3));
        expect(pickInstallationRoot).not.toHaveBeenCalled();
        expect(probeProject).toHaveBeenCalledOnce();
    });

    it("opens the selected current Version as a resizable workbench-side file preview", async () => {
        const assetId = ASSET_ID;
        const versionId = VERSION_ID;
        const file = {
            fileId: "44444444-4444-4444-8444-444444444444",
            logicalPath: "AGENTS.md",
            role: "entry" as const,
            mediaType: "text/markdown",
            contentKind: "text" as const,
            contentHash: "a".repeat(64),
            byteLength: 20,
            executable: false,
        };
        const client = deploymentClient({
            supportsOperation: vi.fn(() => true),
            listAssets: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    assets: [
                        {
                            assetId,
                            kind: "Guidance" as const,
                            scope: "project" as const,
                            projectId: PROJECT_ID,
                            scopePath: "",
                            displayName: "Project guidance",
                            displayDescription: "Current Project guidance",
                            currentVersionId: versionId,
                            currentRevision: 1,
                            currentFingerprint: "b".repeat(64),
                            currentVersionStatus: "complete" as const,
                            deleted: false,
                            createdAt: 1,
                            updatedAt: 2,
                        },
                    ],
                },
                diagnostics: [],
            })),
            getAsset: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    found: true as const,
                    value: {
                        assetId,
                        kind: "Guidance" as const,
                        scope: "project" as const,
                        projectId: PROJECT_ID,
                        scopePath: "",
                        displayName: "Project guidance",
                        displayDescription: "Current Project guidance",
                        versionIds: [versionId],
                        deleted: false,
                        createdAt: 1,
                        updatedAt: 2,
                    },
                },
                diagnostics: [],
            })),
            getAssetVersion: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    found: true as const,
                    value: {
                        assetId,
                        versionId,
                        revision: 1,
                        status: "complete" as const,
                        versionCanonicalContentFingerprint: "b".repeat(64),
                        files: [file],
                        createdAt: 2,
                    },
                },
                diagnostics: [],
            })),
            readAssetVersionFilePreview: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    found: true as const,
                    value: { previewKind: "text" as const, file, text: "# Project guidance\n", lineCount: 2 },
                },
                diagnostics: [],
            })),
        });
        const { container } = renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                revealRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                onClose: vi.fn(),
            }),
        );

        exercisePersistentInteractionSidebar("pages.deployment_page.007", container);
        exerciseKeyboardResize("pages.deployment_page.009", container);
        fireEvent.click(await screen.findByRole("button", { name: "View current Version" }));
        const inspector = await screen.findByLabelText("Current Asset Version");
        const workbench = container.querySelector(".deployment-workbench");
        expect(workbench?.getAttribute("data-inspector-open")).toBe("true");
        expect(inspector.parentElement).toBe(workbench);
        expect(screen.getByRole("region", { name: "File source with line numbers" })).not.toBeNull();
        expect(container.querySelectorAll(".deployment-workbench > .workbench-resize-separator")).toHaveLength(1);
        exerciseKeyboardResize("pages.deployment_page.010", container);
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        await waitFor(() => expect(screen.queryByLabelText("Current Asset Version")).toBeNull());
    });

    it("fails closed when the registered Project root cannot be authorized", async () => {
        const client = deploymentClient();
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({ status: "failed" as const, code: "unavailable" as const }));
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                onClose: vi.fn(),
            }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Check tools" }));
        expect((await screen.findByRole("alert")).textContent).toBe(
            "OAAM could not use this Project's registered folder. Return to Project settings to check the location.",
        );
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(PROJECT_ID);
        expect(client.probeProject).not.toHaveBeenCalled();
    });

    it("keeps rejected registered-Project authorization and reveal calls inside the Project surface", async () => {
        const client = deploymentClient();
        const authorizeRegisteredProjectRoot = vi.fn(async () => {
            throw new Error("authorization transport failed");
        });
        const revealRegisteredProjectRoot = vi.fn(async () => {
            throw new Error("reveal transport failed");
        });
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot,
                onClose: vi.fn(),
            }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Check tools" }));
        await waitFor(() => expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(PROJECT_ID));
        expect(await screen.findByRole("alert")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Open Project folder" }));
        await waitFor(() => expect(revealRegisteredProjectRoot).toHaveBeenCalledWith(PROJECT_ID));
        expect(client.probeProject).not.toHaveBeenCalled();
    });

    it("does not authorize or probe a deleted registered Project", async () => {
        const authorizeRegisteredProjectRoot = vi.fn();
        const client = deploymentClient({
            getProject: vi.fn(async () => ({
                status: "complete" as const,
                value: { found: true as const, value: { ...PROJECT, deleted: true } },
                diagnostics: [],
            })),
        });
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        expect((await screen.findByRole("alert")).textContent).toBe(
            "This Project no longer exists or is no longer managed, so it cannot be checked.",
        );
        expect((screen.getByRole("button", { name: "Check tools" }) as HTMLButtonElement).disabled).toBe(true);
        expect(authorizeRegisteredProjectRoot).not.toHaveBeenCalled();
        expect(client.probeProject).not.toHaveBeenCalled();
    });

    it("binds a WSL Project to its exact WSL environment and never offers Windows", async () => {
        const wslProject = {
            ...PROJECT,
            rootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example\\project",
        };
        const windowsEnvironment = { platform: "win32" as const, platformInstanceId: "local" };
        const wslEnvironment = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const probeProject = vi.fn(async () => ({ status: "complete" as const, value: PROBE, diagnostics: [] }));
        const client = deploymentClient({
            listProjects: vi.fn(async () => ({
                status: "complete" as const,
                value: { projects: [wslProject] },
                diagnostics: [],
            })),
            getProject: vi.fn(async () => ({
                status: "complete" as const,
                value: { found: true as const, value: wslProject },
                diagnostics: [],
            })),
            listEnvironments: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    environments: [
                        { environment: windowsEnvironment, displayName: "Windows" },
                        { environment: wslEnvironment, displayName: "WSL — Ubuntu" },
                    ],
                },
                diagnostics: [],
            })),
            probeProject,
        });
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({
            status: "authorized" as const,
            displayPath: wslProject.rootPath,
            localPathSelectionToken: "wsl-project-token",
        }));
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        const windows = await screen.findByRole("radio", { name: "Local Windows" });
        const wsl = screen.getByRole("radio", { name: "WSL — Ubuntu" });
        expect((windows as HTMLInputElement).checked).toBe(false);
        expect((windows as HTMLInputElement).disabled).toBe(true);
        expect((wsl as HTMLInputElement).checked).toBe(true);
        expect((wsl as HTMLInputElement).disabled).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Check tools" }));
        await waitFor(() =>
            expect(probeProject).toHaveBeenCalledWith(
                ["CLAUDECODE", "OPENCODE"],
                [wslEnvironment],
                "wsl-project-token",
                undefined,
                expect.any(Function),
            ),
        );
    });

    it("keeps a failed target-discovery load retryable inside the exact Asset journey", async () => {
        const listAdapterProviders = vi
            .fn()
            .mockResolvedValueOnce({
                status: "failed" as const,
                error: { code: "settings.unavailable", message: "settings unavailable" },
                diagnostics: [],
            })
            .mockResolvedValue({ status: "complete" as const, value: { providers: [] }, diagnostics: [] });
        renderWithPresentation(
            createElement(DeploymentPage, {
                client: deploymentClient({ listAdapterProviders }),
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot: vi.fn(),
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        expect(await screen.findByRole("heading", { name: "Available tools cannot be checked right now" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByRole("heading", { name: "Find available tools" })).toBeTruthy();
        expect(listAdapterProviders).toHaveBeenCalledTimes(2);
    });

    it("retries a failed Project location lookup in place before enabling target discovery", async () => {
        const getProject = vi
            .fn<DesktopApplicationClientApi["getProject"]>()
            .mockResolvedValueOnce({ status: "failed", diagnostics: [] })
            .mockResolvedValueOnce({
                status: "complete",
                value: { found: true, value: PROJECT },
                diagnostics: [],
            });
        renderWithPresentation(
            createElement(DeploymentPage, {
                client: deploymentClient({ getProject }),
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot: vi.fn(),
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        expect(
            await screen.findByText("OAAM could not load this Project. Try again before checking tool locations."),
        ).toBeTruthy();
        expect((screen.getByRole("button", { name: "Open Project folder" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        expect(await screen.findByText("Current Project: OAAM · /workspace/oaam")).toBeTruthy();
        expect((screen.getByRole("button", { name: "Open Project folder" }) as HTMLButtonElement).disabled).toBe(false);
        expect(getProject).toHaveBeenCalledTimes(2);
    });

    it("does not offer a meaningless retry when the exact Project is no longer managed", async () => {
        const getProject = vi.fn<DesktopApplicationClientApi["getProject"]>(async () => ({
            status: "complete",
            value: { found: false },
            diagnostics: [],
        }));
        renderWithPresentation(
            createElement(DeploymentPage, {
                client: deploymentClient({ getProject }),
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                authorizeRegisteredProjectRoot: vi.fn(),
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        expect(
            await screen.findByText("This Project no longer exists or is no longer managed, so it cannot be checked."),
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("shows the exact imported Provider source in the right pane without losing the current workspace state", async () => {
        const sourcePath = "/workspace/demo-plugin";
        const revealRegisteredProjectRoot = vi.fn(async () => ({ status: "complete" as const }));
        const client = importedSourceDeploymentClient(sourcePath);
        renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                pickInstallationRoot: async () => ({ status: "cancelled" }),
                authorizeRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                revealRegisteredProjectRoot,
                onClose: vi.fn(),
            }),
        );

        expect(await screen.findByText("Imported from Antigravity")).toBeTruthy();
        const providerChoice = screen.getByRole("checkbox", { name: "Antigravity" }) as HTMLInputElement;
        fireEvent.click(providerChoice);
        expect(providerChoice.checked).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "View current Version" }));
        const versionInspector = await screen.findByRole("complementary", { name: "Current Asset Version" });
        fireEvent.click(within(versionInspector).getByRole("button", { name: "Asset source" }));
        const sourceInspector = await screen.findByRole("complementary", { name: "Asset source" });
        expect(document.querySelector("main[data-oaam-route='deployment']")).toBeTruthy();
        expect(within(sourceInspector).getByText(`${sourcePath}/AGENTS.md`)).toBeTruthy();
        expect(providerChoice.checked).toBe(false);
        fireEvent.click(within(sourceInspector).getByRole("button", { name: "Open Project folder" }));
        await waitFor(() => expect(revealRegisteredProjectRoot).toHaveBeenCalledWith(PROJECT_ID));
        fireEvent.click(within(sourceInspector).getByRole("button", { name: "Current Asset Version" }));
        await screen.findByRole("complementary", { name: "Current Asset Version" });
        expect(providerChoice.checked).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(screen.queryByRole("complementary", { name: "Asset source" })).toBeNull();
        expect(providerChoice.checked).toBe(false);
    });

    it.each([
        ["en", "in_sync"],
        ["zh-CN", "conflict"],
        ["de", "needs_repair"],
        ["ja", "blocked"],
    ] as const)("loads only the static Provider directory for a persisted %s %s Deployment", async (locale: DesktopResolvedLocale, stage) => {
        let resolveProviders:
            | ((value: Awaited<ReturnType<DesktopApplicationClientApi["listAdapterProviders"]>>) => void)
            | undefined;
        const providerOutcome = new Promise<Awaited<ReturnType<DesktopApplicationClientApi["listAdapterProviders"]>>>(
            (resolve) => {
                resolveProviders = resolve;
            },
        );
        const listAdapterProviders = vi.fn(() => providerOutcome);
        const snapshot = createDesktopPresentationSnapshot(
            { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: locale, onboardingCompleted: true },
            [locale],
            false,
        );
        const client = deploymentClient({
            listAdapterProviders,
            listDeployments: vi.fn(async () => ({
                status: "complete" as const,
                value: { deployments: [catalogDeployment(stage)] },
                diagnostics: [],
            })),
        });
        const rendered = renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                sidebarVisible: true,
                authorizeRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                revealRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                onClose: vi.fn(),
            }),
            createDesktopPresentationTestBridge(snapshot),
        );

        await waitFor(() => expect(listAdapterProviders).toHaveBeenCalledTimes(1));
        if (resolveProviders === undefined) throw new Error("static Provider directory resolver is missing");
        await act(async () => {
            resolveProviders?.({ status: "complete", value: { providers: PROVIDERS }, diagnostics: [] });
            await providerOutcome;
        });

        expect(await screen.findByText(/Claude Code CLI/u)).toBeTruthy();
        expect(document.querySelector(".deployment-target-discovery")).toBeNull();
        expect(ordinarySurfaceText(rendered.container)).not.toContain("CLAUDE_CODE_CLI");
        expect(client.getAdapterEnablement).not.toHaveBeenCalled();
        expect(client.getWatchedScanIntent).not.toHaveBeenCalled();
        expect(client.listEnvironments).not.toHaveBeenCalled();
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect(client.probeProject).not.toHaveBeenCalled();
    });

    it("keeps a failed static Provider-directory read bounded without claiming an installed build", async () => {
        const listAdapterProviders = vi.fn(async () => ({ status: "failed" as const, diagnostics: [] }));
        const client = deploymentClient({
            listAdapterProviders,
            listDeployments: vi.fn(async () => ({
                status: "complete" as const,
                value: { deployments: [catalogDeployment("in_sync")] },
                diagnostics: [],
            })),
        });
        const rendered = renderWithPresentation(
            createElement(DeploymentPage, {
                client,
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                sidebarVisible: true,
                authorizeRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                revealRegisteredProjectRoot: async () => ({ status: "failed", code: "unavailable" }),
                onClose: vi.fn(),
            }),
        );

        await waitFor(() => expect(listAdapterProviders).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(ordinarySurfaceText(rendered.container)).toContain("Unavailable saved tool"));
        expect(document.querySelector(".deployment-target-discovery")).toBeNull();
        expect(screen.queryByText(/2\.1\.220/u)).toBeNull();
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect(client.probeProject).not.toHaveBeenCalled();
    });
});
