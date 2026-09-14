import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { ImportReviewWorkspace } from "../src/renderer/features/import-review/ImportReviewWorkspace";
import { localizedText } from "../src/renderer/presentation";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { toggleInteractionDisclosure } from "./desktop-interaction-test-harness";
import { controller, diagnostic, fakeImportClient, INVALID_READ_PREVIEW, READ_PREPARATION } from "./import-review-test-fixtures";

afterEach(() => {
    cleanup();
});

describe("Desktop import review bounded partial-read retry", () => {
    it("retries complete roots once after Core rejects the mixed snapshot and stops if it remains partial", async () => {
        const readSources = vi
            .fn<DesktopApplicationClientApi["readSources"]>()
            .mockResolvedValueOnce({
                status: "partial",
                value: {
                    readToken: "mixed-read",
                    reports: [
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-root",
                            status: "complete",
                            candidateCount: 1,
                            diagnostics: [],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "partial",
                value: {
                    readToken: "second-partial",
                    reports: [
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-root",
                            status: "partial",
                            candidateCount: 1,
                            diagnostics: [diagnostic("read.partial", "Still partial.")],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [],
            });
        const client = fakeImportClient({ readSources });
        vi.mocked(client.previewImport).mockResolvedValueOnce(INVALID_READ_PREVIEW);
        const review = controller(client);

        await review.prepare(READ_PREPARATION);

        expect(readSources).toHaveBeenCalledTimes(2);
        expect(client.previewImport).toHaveBeenCalledOnce();
        expect(client.previewImport).toHaveBeenCalledWith({ readToken: "mixed-read" });
        expect(review.state).toMatchObject({
            status: "read_attention",
            issues: [expect.objectContaining({ sourceRootId: "source-root", status: "partial" })],
        });
    });

    it("lets the user inspect one retained read issue and continue with the exact readable source set", async () => {
        const preparation = {
            request: {
                probeToken: "probe-token",
                selections: [{ probeResultRowId: "probe-row", sourceRootRowIds: ["source-a-row", "source-b-row"] }],
            },
            sources: [
                {
                    probeResultRowId: "probe-row",
                    sourceRootRowId: "source-a-row",
                    sourceRootId: "source-a",
                    adapterId: "adapter",
                    environmentLabel: localizedText("sources.environment.local"),
                    toolLabel: localizedText("sources.tool.unknown"),
                    displayPath: "/home/user/.agent/a",
                },
                {
                    probeResultRowId: "probe-row",
                    sourceRootRowId: "source-b-row",
                    sourceRootId: "source-b",
                    adapterId: "adapter",
                    environmentLabel: localizedText("sources.environment.local"),
                    toolLabel: localizedText("sources.tool.unknown"),
                    displayPath: "/home/user/.agent/b",
                },
            ],
        } as const;
        const readSources = vi
            .fn<DesktopApplicationClientApi["readSources"]>()
            .mockResolvedValueOnce({
                status: "partial",
                value: {
                    readToken: "mixed-read",
                    reports: [
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-a",
                            status: "complete",
                            candidateCount: 1,
                            diagnostics: [],
                        },
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-b",
                            status: "failed",
                            candidateCount: 0,
                            diagnostics: [diagnostic("read.failed", "Source B could not be read.")],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "partial",
                value: {
                    readToken: "bounded-partial",
                    reports: [
                        {
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-a",
                            status: "complete",
                            candidateCount: 1,
                            diagnostics: [],
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
                            adapterId: "adapter",
                            agentRuntimeId: "AGENT_CLI",
                            sourceRootId: "source-a",
                            status: "complete",
                            candidateCount: 1,
                            diagnostics: [],
                        },
                    ],
                    candidateCount: 1,
                },
                diagnostics: [],
            });
        const client = fakeImportClient({ readSources });
        vi.mocked(client.previewImport).mockResolvedValueOnce(INVALID_READ_PREVIEW);
        const review = controller(client);
        const view = renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));

        await act(async () => review.prepare(preparation));
        expect(review.state).toMatchObject({
            status: "read_attention",
            completeSourcePreparation: {
                request: {
                    selections: [{ probeResultRowId: "probe-row", sourceRootRowIds: ["source-a-row"] }],
                },
            },
        });
        toggleInteractionDisclosure("features.import-review.import_review_workspace.001", view.container);
        fireEvent.click(screen.getByRole("button", { name: "Continue with readable locations" }));
        await vi.waitFor(() => expect(readSources).toHaveBeenCalledTimes(3));
        expect(readSources).toHaveBeenLastCalledWith({
            probeToken: "probe-token",
            selections: [{ probeResultRowId: "probe-row", sourceRootRowIds: ["source-a-row"] }],
        });
        await vi.waitFor(() => expect(review.state.status).toBe("review"));
    });
});
