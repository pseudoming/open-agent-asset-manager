import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDeploymentInspectionReview } from "../src/renderer/features/catalog-deployment/CatalogDeploymentInspectionReview";
import type { CatalogDeploymentController } from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import { INSPECTION, INSPECTION_DETAIL } from "./catalog-deployment-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(cleanup);
describe("inspection navigation", () => {
    it("keeps one long-file entry and both exact detail selectors in long lists", () => {
        const loadInspectionDetail = vi.fn();
        const controller = { loadInspectionDetail } as unknown as CatalogDeploymentController;
        const longPath = `${"long-folder/".repeat(50)}AGENTS.md`;
        const details = Array.from({ length: 40 }, (_, i) => ({
            selector: `file-${i}`,
            detailKind: "file_attribution" as const,
            displayName: `${i}/${longPath}`,
        }));
        details.push({ selector: "file-last", detailKind: "file_attribution", displayName: longPath });
        const props = {
            controller,
            interactionLocked: false,
            stale: false,
            canRepair: false,
            canReviewConflict: false,
            inspection: {
                status: "ready" as const,
                value: {
                    ...INSPECTION,
                    details: [
                        ...details,
                        { selector: "change-last", detailKind: "semantic_change" as const, displayName: longPath },
                    ],
                    detailsTruncated: false,
                },
                detail: { status: "none" as const },
            },
        };
        const view = renderWithPresentation(createElement(CatalogDeploymentInspectionReview, props));
        const change = screen.getByRole("button", { name: `Content change: ${longPath}` });
        expect(screen.queryByRole("button", { name: `File ownership: ${longPath}` })).toBeNull();
        expect(view.container.querySelectorAll(".inspection-detail-row")).toHaveLength(41);
        expect(change.textContent).toBe("");
        fireEvent.click(change);
        const loadedProps = {
            ...props,
            inspection: {
                ...props.inspection,
                detail: { status: "ready" as const, value: { ...INSPECTION_DETAIL, selector: "change-last" } },
            },
        };
        view.rerender(createElement(CatalogDeploymentInspectionReview, loadedProps));
        const file = screen.getByRole("button", { name: "File ownership" });
        fireEvent.click(file);
        expect(loadInspectionDetail.mock.calls).toEqual([["change-last"], ["file-last"]]);
        expect(view.container.querySelectorAll(".inspection-detail-row")).toHaveLength(41);
        view.rerender(createElement(CatalogDeploymentInspectionReview, { ...loadedProps, interactionLocked: true }));
        fireEvent.click(file);
        expect(loadInspectionDetail).toHaveBeenCalledTimes(2);
    });
});
