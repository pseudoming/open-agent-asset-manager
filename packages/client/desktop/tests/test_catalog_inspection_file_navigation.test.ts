import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogDeploymentInspectionReview } from "../src/renderer/features/catalog-deployment/CatalogDeploymentInspectionReview";
import { groupInspectionFileDetails } from "../src/renderer/features/catalog-deployment/CatalogInspectionDetail";
import { INSPECTION, INSPECTION_DETAIL } from "./catalog-deployment-test-fixtures";
import { fakeController, readyState } from "./catalog-deployment-test-support";
import { localizedText } from "../src/renderer/presentation";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(cleanup);
const details = [
    { selector: "file-1", detailKind: "file_attribution" as const, displayName: ".agents/skills/review/SKILL.md" },
    { selector: "semantic-1", detailKind: "semantic_change" as const, displayName: ".agents/skills/review/SKILL.md" },
];

describe("inspection file navigation", () => {
    it("shows one file entry while keeping its content and attribution separately reachable", () => {
        const controller = fakeController(readyState());
        const inspection = {
            status: "ready" as const,
            value: { ...INSPECTION, details, changeCount: 1, conflictCount: 0 },
            detail: { status: "none" as const },
        };
        const props = {
            controller,
            inspection,
            interactionLocked: false,
            stale: false,
            canRepair: false,
            canReviewConflict: true,
        };
        const view = renderWithPresentation(createElement(CatalogDeploymentInspectionReview, props));
        expect(view.container.querySelectorAll(".inspection-detail-row")).toHaveLength(1);
        fireEvent.click(view.container.querySelector<HTMLButtonElement>(".inspection-detail-row button")!);
        expect(controller.loadInspectionDetail).toHaveBeenLastCalledWith("semantic-1");
        view.rerender(
            createElement(CatalogDeploymentInspectionReview, {
                ...props,
                inspection: { ...inspection, detail: { status: "ready", value: INSPECTION_DETAIL } },
            }),
        );
        const attribution = screen.getByRole("button", { name: "File ownership" });
        fireEvent.click(attribution);
        expect(controller.loadInspectionDetail).toHaveBeenLastCalledWith("file-1");
        expect(view.container.querySelectorAll(".inspection-detail-row")).toHaveLength(1);
        expect(screen.getByText("# changed")).not.toBeNull();
    });

    it.each(["loading", "failed"] as const)("keeps file navigation and retry visible while attribution is %s", (status) => {
        const controller = fakeController(readyState());
        const detail =
            status === "loading"
                ? { status, selector: "file-1" }
                : {
                      status,
                      selector: "file-1",
                      failureKind: "inspection_detail.operation_failed" as const,
                      message: localizedText("catalog.inspection.detail_unavailable"),
                  };
        const inspection = { status: "ready" as const, value: { ...INSPECTION, details }, detail };
        renderWithPresentation(
            createElement(CatalogDeploymentInspectionReview, {
                controller,
                inspection,
                interactionLocked: false,
                stale: false,
                canRepair: false,
                canReviewConflict: true,
            }),
        );
        const attribution = screen.getByRole("button", { name: "File ownership" });
        expect(attribution.getAttribute("aria-pressed")).toBe("true");
        fireEvent.click(attribution);
        expect(controller.loadInspectionDetail).toHaveBeenLastCalledWith("file-1");
        fireEvent.click(screen.getByRole("button", { name: "Content change" }));
        expect(controller.loadInspectionDetail).toHaveBeenLastCalledWith("semantic-1");
    });

    it("preserves every selector when names or multiple changes are ambiguous", () => {
        expect(groupInspectionFileDetails(details).map((group) => group.map((detail) => detail.selector))).toEqual([
            ["semantic-1", "file-1"],
        ]);
        const ambiguous = [...details, { ...details[1]!, selector: "semantic-2" }];
        expect(groupInspectionFileDetails(ambiguous).map((group) => group.length)).toEqual([1, 1, 1]);
        expect(
            groupInspectionFileDetails(INSPECTION.details)
                .flat()
                .map((detail) => detail.selector),
        ).toEqual(INSPECTION.details.map((detail) => detail.selector));
    });
});
