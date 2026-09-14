import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { EMPTY_WATCHED, fakeDiscoveryClient, PROBE, probeSource, required } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Desktop guided import stopped Project recovery", () => {
    function sourceCard(path: string): HTMLElement {
        const card = [...document.querySelectorAll<HTMLElement>("[data-oaam-source-path]")].find(
            (candidate) => candidate.dataset.oaamSourcePath === path,
        );
        if (card === undefined) throw new Error(`Source card ${path} is required`);
        return card;
    }

    async function reachSourceReview(): Promise<void> {
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
    }

    it("restores an exact stopped Project while preserving its watched destination", async () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const projectRoot = {
            ...probeSource("retained-project-root", "retained-project-root", "/work/retained-project"),
            rootRole: "project_actual" as const,
        };
        const retainedProject = {
            projectId: "99999999-9999-4999-8999-999999999999",
            displayName: "Stopped workspace",
            rootPath: projectRoot.displayPath,
            deleted: true,
            createdAt: 1,
            updatedAt: 2,
        } as const;
        const restoredProject = { ...retainedProject, deleted: false, updatedAt: 3 } as const;
        const watched = {
            ...EMPTY_WATCHED,
            revision: 1,
            environments: [
                {
                    environment: baseResult.environment,
                    sourceSelectors: [
                        {
                            disposition: "included" as const,
                            source: {
                                adapterId: baseResult.adapterId,
                                rootRole: projectRoot.rootRole,
                                sourceDomain: projectRoot.sourceDomain,
                                canonicalPath: projectRoot.displayPath,
                                locatorIdentities: projectRoot.locatorIdentities,
                            },
                            agentRuntimeIds: [baseRuntime.agentRuntimeId],
                            binding: { assetScope: "project" as const, projectId: retainedProject.projectId },
                            selectorFingerprint: "d".repeat(64),
                        },
                    ],
                },
            ],
            updatedAt: 2,
            settingFingerprint: "e".repeat(64),
        };
        const registerProject = vi.fn();
        const inspectProjectLifecycle = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                schemaVersion: 1 as const,
                action: "restore" as const,
                projectLifecycleReviewToken: "retained-restore-review",
                projectId: retainedProject.projectId,
                projectAuthorityFingerprint: "a".repeat(64),
                displayName: retainedProject.displayName,
                rootPath: retainedProject.rootPath,
                rootAccessState: "available" as const,
            },
            diagnostics: [],
        }));
        const commitProjectLifecycle = vi.fn(async () => ({
            status: "complete" as const,
            value: restoredProject,
            diagnostics: [],
        }));
        commitProjectLifecycle.mockResolvedValueOnce({
            status: "complete" as const,
            value: { ...restoredProject, rootPath: "/work/unrelated-project" },
            diagnostics: [],
        });
        const client = fakeDiscoveryClient({
            listProjects: vi.fn(async () => ({
                status: "complete" as const,
                value: { projects: [retainedProject] },
                diagnostics: [],
            })),
            getWatchedScanIntent: vi.fn(async () => ({ status: "complete" as const, value: watched, diagnostics: [] })),
            registerProject,
            inspectProjectLifecycle,
            commitProjectLifecycle,
            probeGlobal: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    ...PROBE,
                    probeToken: "retained-project-probe",
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
                                    rowId: "retained-project-row",
                                    observedProjectId: "retained-project-observation",
                                    displayName: "Observed stopped workspace",
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
        (client.availableOperations as ProtocolOperationName[]).push("project_lifecycle.inspect", "project_lifecycle.commit");
        const authorizeObservedProjectRoot = vi.fn();
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client,
                assetCount: 0,
                authorizeObservedProjectRoot,
                revealObservedProjectRoot: vi.fn(async () => ({ status: "complete" as const })),
                onClose: vi.fn(),
            }),
        );

        await reachSourceReview();
        const card = sourceCard(projectRoot.displayPath);
        const shell = document.querySelector(".guided-import-shell");
        expect(shell).toBeInstanceOf(HTMLElement);
        if (!(shell instanceof HTMLElement)) throw new TypeError("guided import shell is unavailable");
        shell.scrollTop = 280;
        const scrollTopBefore = shell.scrollTop;
        expect(within(card).getByText(/belongs to a stopped OAAM Project/u)).not.toBeNull();
        expect(within(card).getByText("Observed stopped workspace", { selector: "small" })).not.toBeNull();
        expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(within(card).getByRole("button", { name: "Restore Project" }));

        let dialog = await screen.findByRole("dialog", { name: "Restore retained Project" });
        expect(dialog.parentElement?.parentElement).toBe(document.body);
        expect(shell.scrollTop).toBe(scrollTopBefore);
        expect(within(dialog).getByText(retainedProject.displayName)).not.toBeNull();
        expect(within(dialog).getByText(retainedProject.rootPath)).not.toBeNull();
        fireEvent.click(within(dialog).getByRole("button", { name: "Close Project management" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Restore retained Project" })).toBeNull());
        fireEvent.click(within(sourceCard(projectRoot.displayPath)).getByRole("button", { name: "Restore Project" }));
        dialog = await screen.findByRole("dialog", { name: "Restore retained Project" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Review restore" }));
        await vi.waitFor(() => expect(within(dialog).queryByText("Review: Restore Project")).not.toBeNull());
        fireEvent.click(within(dialog).getByRole("button", { name: "Confirm exact Project change" }));

        await vi.waitFor(() => {
            expect(screen.queryByRole("dialog", { name: "Restore retained Project" })).toBeNull();
            expect(within(sourceCard(projectRoot.displayPath)).getByRole("alert").textContent).toContain(
                "could not restore the stopped Project",
            );
        });
        fireEvent.click(within(sourceCard(projectRoot.displayPath)).getByRole("button", { name: "Restore Project" }));
        dialog = await screen.findByRole("dialog", { name: "Restore retained Project" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Review restore" }));
        await vi.waitFor(() => expect(within(dialog).queryByText("Review: Restore Project")).not.toBeNull());
        fireEvent.click(within(dialog).getByRole("button", { name: "Confirm exact Project change" }));

        await vi.waitFor(() => {
            expect(screen.queryByRole("dialog", { name: "Restore retained Project" })).toBeNull();
            expect(within(sourceCard(projectRoot.displayPath)).queryByRole("button", { name: "Restore Project" })).toBeNull();
        });
        expect(inspectProjectLifecycle).toHaveBeenCalledWith({
            action: "restore",
            projectId: retainedProject.projectId,
        });
        expect(commitProjectLifecycle).toHaveBeenCalledWith({
            projectLifecycleReviewToken: "retained-restore-review",
            userActionId: expect.any(String),
        });
        expect(registerProject).not.toHaveBeenCalled();
        expect(authorizeObservedProjectRoot).not.toHaveBeenCalled();
        expect((screen.getByRole("button", { name: "Scan selected locations" }) as HTMLButtonElement).disabled).toBe(false);
    });
});
