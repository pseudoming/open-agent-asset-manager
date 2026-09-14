import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeDiscoveryClient, PROBE, probeSource, required } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Desktop guided-import Project folder candidates", () => {
    function sourceCard(path: string): HTMLElement {
        const card = [...document.querySelectorAll<HTMLElement>("[data-oaam-source-path]")].find(
            (candidate) => candidate.dataset.oaamSourcePath === path,
        );
        if (card === undefined) throw new Error(`Source card ${path} is required`);
        return card;
    }

    it("returns every available multi-workspace folder to its exact source card for an explicit choice", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const primaryRoot = {
            ...probeSource("multi-primary", "multi-primary", "/work/multi-primary"),
            rootRole: "project_actual" as const,
        };
        const secondaryRoot = {
            ...probeSource("multi-secondary", "multi-secondary", "/work/multi-secondary"),
            rootRole: "project_actual" as const,
        };
        const authorizeObservedProjectRoot = vi.fn();
        const client = fakeDiscoveryClient({
            probeGlobal: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    ...PROBE,
                    probeToken: "multi-workspace-probe",
                    results: [
                        {
                            ...baseResult,
                            runtimes: [
                                {
                                    ...baseRuntime,
                                    sourceRootRowIds: [primaryRoot.rowId, secondaryRoot.rowId],
                                },
                            ],
                            sources: [primaryRoot, secondaryRoot],
                            projects: [
                                {
                                    rowId: "multi-project-row",
                                    observedProjectId: "multi-project",
                                    displayName: "Multi workspace",
                                    workspaceSourceRowIds: [primaryRoot.rowId, secondaryRoot.rowId],
                                    containedSourceRootRowIds: [primaryRoot.rowId, secondaryRoot.rowId],
                                    diagnostics: [],
                                },
                            ],
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
                revealObservedProjectRoot: vi.fn(async () => ({ status: "complete" as const })),
                onClose: vi.fn(),
            }),
        );

        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        expect(screen.queryByRole("heading", { name: "Other Project folders" })).toBeNull();
        const primaryCard = sourceCard(primaryRoot.displayPath);
        const secondaryCard = sourceCard(secondaryRoot.displayPath);
        expect(within(primaryCard).getByRole("button", { name: "Register as Project" })).not.toBeNull();
        expect(within(secondaryCard).getByRole("button", { name: "Register as Project" })).not.toBeNull();
        expect(primaryCard.dataset.oaamProjectProposalKey).not.toBe(secondaryCard.dataset.oaamProjectProposalKey);

        fireEvent.click(within(secondaryCard).getByRole("button", { name: "Register as Project" }));
        const dialog = await screen.findByRole("dialog", { name: "Register this Project" });
        expect(within(dialog).getByText(secondaryRoot.displayPath)).not.toBeNull();
        fireEvent.click(within(dialog).getByRole("button", { name: "Close Project registration" }));
        expect(screen.queryByRole("dialog", { name: "Register this Project" })).toBeNull();
        expect(authorizeObservedProjectRoot).not.toHaveBeenCalled();
    });

    it("keeps an empty Project import route scoped to the exact runtime-observed Project source", async () => {
        const targetProjectId = "11111111-1111-4111-8111-111111111111";
        const otherProjectId = "22222222-2222-4222-8222-222222222222";
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const targetRoot = {
            ...probeSource("target-root", "target-root", "/work/demo-plugin"),
            rootRole: "project_actual" as const,
        };
        const otherRoot = {
            ...probeSource("other-root", "other-root", "/work/unrelated-project"),
            rootRole: "project_actual" as const,
        };
        const targetSkillRoot = probeSource("target-skill-root", "target-skill-root", "/work/demo-plugin/.agents/skills");
        const readSources = vi.fn(async () => ({
            status: "complete" as const,
            value: { readToken: "target-read", reports: [], candidateCount: 0 },
            diagnostics: [],
        }));
        const probeProject = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                ...PROBE,
                probeToken: "project-scoped-probe",
                results: [
                    {
                        ...baseResult,
                        runtimes: [
                            {
                                ...baseRuntime,
                                sourceRootRowIds: [targetRoot.rowId, targetSkillRoot.rowId, otherRoot.rowId],
                            },
                        ],
                        sources: [targetRoot, targetSkillRoot, otherRoot],
                        projects: [
                            {
                                rowId: "target-project-row",
                                observedProjectId: "runtime-target",
                                displayName: "demo-plugin",
                                workspaceSourceRowIds: [targetRoot.rowId],
                                containedSourceRootRowIds: [targetRoot.rowId, targetSkillRoot.rowId],
                                diagnostics: [],
                            },
                            {
                                rowId: "other-project-row",
                                observedProjectId: "runtime-other",
                                displayName: "unrelated-project",
                                workspaceSourceRowIds: [otherRoot.rowId],
                                containedSourceRootRowIds: [otherRoot.rowId],
                                diagnostics: [],
                            },
                        ],
                    },
                ],
            },
            diagnostics: [],
        }));
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({
            status: "authorized" as const,
            displayPath: targetRoot.displayPath,
            localPathSelectionToken: "target-project-root-token",
        }));
        const client = fakeDiscoveryClient({
            listProjects: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    projects: [
                        {
                            projectId: targetProjectId,
                            displayName: "demo-plugin",
                            rootPath: targetRoot.displayPath,
                            deleted: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            projectId: otherProjectId,
                            displayName: "unrelated-project",
                            rootPath: otherRoot.displayPath,
                            deleted: false,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                diagnostics: [],
            })),
            probeProject,
            readSources,
        });
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 0,
                targetProjectId,
                authorizeRegisteredProjectRoot,
                onClose: vi.fn(),
            }),
        );

        expect(await screen.findByRole("heading", { name: "Find and import Assets for “demo-plugin”" })).not.toBeNull();
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(targetProjectId);
        expect(probeProject).toHaveBeenCalledWith(
            ["CLAUDECODE"],
            expect.any(Array),
            "target-project-root-token",
            undefined,
            expect.any(Function),
        );
        expect(client.probeGlobal).not.toHaveBeenCalled();
        expect(sourceCard(targetRoot.displayPath)).not.toBeNull();
        expect(sourceCard(targetSkillRoot.displayPath)).not.toBeNull();
        expect(document.querySelector(`[data-oaam-source-path="${otherRoot.displayPath}"]`)).toBeNull();
        expect(screen.getByRole("heading", { name: "Find and import Assets for “demo-plugin”" })).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await vi.waitFor(() =>
            expect(readSources).toHaveBeenCalledWith({
                probeToken: "project-scoped-probe",
                selections: [
                    {
                        probeResultRowId: "result-1",
                        sourceRootRowIds: [targetRoot.rowId, targetSkillRoot.rowId],
                    },
                ],
            }),
        );
    });

    it("stops a Project-scoped import when the exact registered Project no longer exists", async () => {
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client: fakeDiscoveryClient(),
                assetCount: 0,
                targetProjectId: "99999999-9999-4999-8999-999999999999",
                onClose: vi.fn(),
            }),
        );

        expect(await screen.findByRole("heading", { name: "This Project is no longer available" })).not.toBeNull();
        expect(
            screen.getByText("The Project list changed. Return to the Asset library and open the import again."),
        ).not.toBeNull();
    });
});
