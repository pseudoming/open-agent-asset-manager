import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CatalogRenderDecisions,
    groupEquivalentRenderDecisions,
} from "../src/renderer/features/catalog-deployment/CatalogRenderDecisions";
import {
    buildRenderSelection,
    includeSingletonRenderSelections,
    projectRenderReview,
    type RenderAnalysisView,
    type RenderOptionSelection,
    type RenderReviewProjection,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, RENDER_ANALYSIS } from "./catalog-deployment-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

type ReadyReview = Extract<RenderReviewProjection, { status: "ready" }>;
function sevenSemanticAnalysis(): RenderAnalysisView {
    const semantic = RENDER_ANALYSIS.semantics[0]!,
        option = RENDER_ANALYSIS.options[1]!;
    const semantics = Array.from({ length: 7 }, (_, index) => ({
        ...semantic,
        semanticRefFingerprint: String(index + 1).repeat(64),
        subject: structuredClone(semantic.subject),
        semanticKind:
            index === 0
                ? ("skill.discovery_metadata" as const)
                : index === 1
                  ? ("skill.body" as const)
                  : ("skill.resource" as const),
    }));
    return {
        ...RENDER_ANALYSIS,
        semantics,
        options: semantics.map((item, index) => ({
            ...option,
            semanticRefFingerprint: item.semanticRefFingerprint,
            optionFingerprint: (index + 8).toString(16).repeat(64),
        })),
    };
}
function ready(analysis = sevenSemanticAnalysis()): ReadyReview {
    const review = projectRenderReview(analysis);
    if (review.status !== "ready") throw new Error("complete review required");
    return review;
}
afterEach(cleanup);

describe("equivalent conversion decisions", () => {
    it.each([false, true])("confirms seven exact selections through one ordinary checkbox (reverse=%s)", (reverse) => {
        const analysis = sevenSemanticAnalysis(),
            review = ready(analysis),
            changed = vi.fn();
        function Subject() {
            const [selections, setSelections] = useState<readonly RenderOptionSelection[]>(
                includeSingletonRenderSelections(review, []),
            );
            return createElement(CatalogRenderDecisions, {
                review,
                selections,
                assets: [],
                providers: DEPLOYMENT_PROVIDERS,
                target: undefined,
                disabled: false,
                reverse,
                onChange: (updates) => {
                    changed(updates);
                    setSelections(updates);
                },
            });
        }
        const view = renderWithPresentation(createElement(Subject));
        expect(screen.getAllByRole("checkbox")).toHaveLength(1);
        expect(view.container.querySelector('[data-oaam-render-decision-members="7"]')).not.toBeNull();
        expect(view.container.querySelectorAll(".reverse-semantic-review")).toHaveLength(reverse ? 1 : 0);
        if (reverse) {
            expect(view.container.querySelector("[data-oaam-reverse-option-auto-selected]")?.textContent).toBe("Inline content");
        }
        const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        expect(changed).not.toHaveBeenCalled();
        fireEvent.click(checkbox);
        const selections = changed.mock.calls[0]![0] as readonly RenderOptionSelection[];
        expect(selections).toEqual(
            analysis.options.map((option) => ({
                semanticRefFingerprint: option.semanticRefFingerprint,
                optionFingerprint: option.optionFingerprint,
                approved: true,
            })),
        );
        const request = buildRenderSelection(analysis, selections, "one-user-conversion-confirmation");
        expect(request.status).toBe("ready");
        if (request.status !== "ready") throw new Error("all exact approvals required");
        expect(request.selection.semanticOptions).toEqual(
            analysis.options.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                approval: { action: "approve_once", userActionId: "one-user-conversion-confirmation" },
            })),
        );
        expect(checkbox.checked).toBe(true);
        fireEvent.click(checkbox);
        expect(changed.mock.calls[1]![0]).toEqual(selections.map((selection) => ({ ...selection, approved: false })));
        expect(checkbox.checked).toBe(false);
    });

    it.each([
        "loss",
        "reverse",
        "reason",
        "diagnostic",
        "runtime",
        "version",
        "asset",
        "output",
        "multiple_options",
        "blocked",
        "preserved",
        "no_approval",
        "no_output",
    ])("keeps a different decision separate: %s", (variant) => {
        const review = structuredClone(ready());
        const groups = [...review.groups],
            candidate = groups[1]!,
            selected = candidate.options[0]!;
        const option = selected.option;
        if (variant === "loss")
            (option as { degradationKinds: string[] }).degradationKinds = ["permission_or_tool_boundary_lost"];
        if (variant === "reverse")
            (option as { actualReverseExtractPolicy: string }).actualReverseExtractPolicy = "can_reconcile";
        if (variant === "reason") (option as { reasonCode: string }).reasonCode = "another_mapping";
        if (variant === "diagnostic") (option as { diagnostics: unknown[] }).diagnostics = [{ code: "another_reason" }];
        if (variant === "runtime")
            (candidate.semantic as { consumerAgentRuntimeId: string }).consumerAgentRuntimeId = "ANTIGRAVITY_CLI";
        if (variant === "version") (candidate.semantic.subject as { versionId: string }).versionId = "another-version";
        if (variant === "asset") (candidate.semantic.subject as { assetId: string }).assetId = "another-asset";
        if (variant === "output")
            (option as { requiredOutputUnitFingerprints: string[] }).requiredOutputUnitFingerprints = ["another-output"];
        if (variant === "multiple_options")
            (candidate as { options: unknown[] }).options = [
                selected,
                { ...selected, option: { ...option, optionFingerprint: "other-option" } },
            ];
        if (variant === "blocked") (candidate as { blocked: unknown }).blocked = { reasonCode: "blocked" };
        if (variant === "preserved") (option as { outcome: string }).outcome = "preserved";
        if (variant === "no_approval") (option as { approvalState: string }).approvalState = "not_required";
        if (variant === "no_output") (selected as { outputUnits: unknown[] }).outputUnits = [];
        expect(
            groupEquivalentRenderDecisions({ ...review, groups })
                .map((members) => members.length)
                .sort(),
        ).toEqual([1, 6]);
    });

    it("keeps forward and reverse native radio groups independent when their semantics match", () => {
        const review = ready(RENDER_ANALYSIS),
            option = RENDER_ANALYSIS.options[0]!;
        const props = {
            review,
            selections: [
                {
                    semanticRefFingerprint: option.semanticRefFingerprint,
                    optionFingerprint: option.optionFingerprint,
                    approved: false,
                },
            ],
            assets: [],
            providers: DEPLOYMENT_PROVIDERS,
            target: undefined,
            disabled: false,
            onChange: vi.fn(),
        };
        renderWithPresentation(
            createElement(
                "div",
                null,
                createElement(CatalogRenderDecisions, props),
                createElement(CatalogRenderDecisions, { ...props, reverse: true }),
            ),
        );
        const native = screen.getAllByRole("radio", { name: /Native file/ }) as HTMLInputElement[];
        expect(native).toHaveLength(2);
        expect(native.every((radio) => radio.checked)).toBe(true);
        expect(new Set(native.map((radio) => radio.name)).size).toBe(2);
    });

    it("does not present partial approval as group approval, and keeps locked controls disabled", () => {
        const review = ready(),
            selections = includeSingletonRenderSelections(review, []).map((selection, index) => ({
                ...selection,
                approved: index === 0,
            }));
        const changed = vi.fn();
        renderWithPresentation(
            createElement(CatalogRenderDecisions, {
                review,
                selections,
                assets: [],
                providers: DEPLOYMENT_PROVIDERS,
                target: undefined,
                disabled: true,
                onChange: changed,
            }),
        );
        const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        expect(checkbox.disabled).toBe(true);
        checkbox.click();
        expect(changed).not.toHaveBeenCalled();
    });
});
