import { cleanup, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogRenderOutputSummary } from "../src/renderer/features/catalog-deployment/CatalogRenderReviewDetails";
import {
    includeSingletonRenderSelections,
    projectRenderReview,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { RENDER_ANALYSIS } from "./catalog-deployment-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
afterEach(cleanup);

describe("Long planned file summary", () => {
    it.each([
        1, 41,
    ])("summarizes files and %i managed directories while preserving the exact full review graph", (directoryCount) => {
        const output = RENDER_ANALYSIS.outputUnits[0],
            option = RENDER_ANALYSIS.options[0];
        if (output === undefined || output.claims[0] === undefined || option === undefined)
            throw new Error("render fixture required");
        const originalClaim = output.claims[0];
        const claims = Array.from({ length: 41 }, (_, index) => ({
            ...originalClaim,
            relativePath: `skill/resources/long-file-${index}.md`,
            contentKind: index === 40 ? ("binary" as const) : ("text" as const),
            executable: index === 39,
        }));
        const review = projectRenderReview({
            ...RENDER_ANALYSIS,
            options: [option],
            outputUnits: [
                {
                    ...output,
                    claims,
                    managedDirectoryPaths: Array.from({ length: directoryCount }, (_, index) => `skill-${index}`),
                },
            ],
        });
        if (review.status !== "ready") throw new Error("ready review required");
        const before = JSON.stringify(review);
        const { container } = renderWithPresentation(
            createElement(CatalogRenderOutputSummary, {
                review,
                selections: includeSingletonRenderSelections(review, []),
            }),
        );
        expect(screen.getByText("41 files · 40 text · 1 binary · 1 executable")).toBeTruthy();
        expect(container.querySelectorAll(".render-output-paths li")).toHaveLength(directoryCount > 3 ? 0 : 1);
        if (directoryCount > 3) expect(screen.getByText("41 managed directories")).toBeTruthy();
        else expect(container.textContent).toContain("skill-0");
        expect(screen.queryByText(/long-file-40/)).toBeNull();
        expect(JSON.stringify(review)).toBe(before);
    });
});
