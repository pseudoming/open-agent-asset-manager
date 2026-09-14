import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportReviewWorkspace } from "../src/renderer/features/import-review/ImportReviewWorkspace";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { candidate, controller, fakeImportClient, PREVIEW, READ_PARAMS } from "./import-review-test-fixtures";

afterEach(() => {
    cleanup();
});

describe("Desktop import review existing Assets", () => {
    it("moves Assets already in OAAM to one collapsed group at the end of review", async () => {
        const duplicate = candidate("existing-skill", "Skill", { status: "duplicate" });
        const boundedDuplicate = candidate("existing-bounded", "Skill", {
            status: "duplicate",
            fileCount: 2,
            logicalPaths: [],
            logicalPathsTruncated: true,
        });
        const client = fakeImportClient({
            previewImport: vi.fn(async () => ({
                status: "complete",
                value: { ...PREVIEW, candidates: [boundedDuplicate, duplicate, ...PREVIEW.candidates] },
                diagnostics: [],
            })),
        });
        const review = controller(client);
        const { container } = renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));
        await act(async () => review.prepare(READ_PARAMS));

        const disclosure = screen.getByText("Already in OAAM · 2").closest("details");
        const existingCard = container.querySelector('[data-oaam-import-candidate-id="existing-skill"]');
        const importActions = container.querySelector(".import-actions");
        expect(disclosure).not.toBeNull();
        expect(disclosure?.open).toBe(false);
        expect(existingCard?.closest("details")).toBe(disclosure);
        expect(disclosure?.compareDocumentPosition(importActions as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

        fireEvent.click(screen.getByText("Already in OAAM · 2"));
        expect(disclosure?.open).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "View existing-bounded" }));
        await vi.waitFor(() =>
            expect(client.getImportPreviewDetail).toHaveBeenCalledWith({
                previewToken: "preview-token",
                candidateId: "existing-bounded",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "View existing-skill" }));
        await vi.waitFor(() =>
            expect(client.getImportPreviewDetail).toHaveBeenCalledWith({
                previewToken: "preview-token",
                candidateId: "existing-skill",
                logicalPath: "existing-skill.md",
            }),
        );
    });
});
