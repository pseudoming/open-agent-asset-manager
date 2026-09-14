import { describe, expect, it } from "vitest";
import {
    catalogRenderGroupIsPassive,
    catalogRenderReviewIsPassiveSingleton,
} from "../src/renderer/features/catalog-deployment/CatalogRenderReviewDetails";
import {
    buildRenderSelection,
    includeSingletonRenderSelections,
    projectRenderReview,
} from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { localizedText } from "../src/renderer/presentation";
import { RENDER_ANALYSIS, SHA_A, SHA_B } from "./catalog-deployment-test-fixtures";

describe("Desktop singleton render selection", () => {
    it("compacts only matching passive groups while keeping exceptional reviews expanded", () => {
        const preserved = RENDER_ANALYSIS.options[0];
        if (preserved === undefined) throw new Error("preserved render fixture is required");
        const review = projectRenderReview({ ...RENDER_ANALYSIS, options: [preserved] });
        if (review.status !== "ready") throw new Error("singleton render review is required");
        const first = review.groups[0];
        const selected = first?.options[0];
        if (first === undefined || selected === undefined) throw new Error("render group is required");
        const second = {
            ...first,
            semantic: {
                ...first.semantic,
                semanticRefFingerprint: "d".repeat(64),
                semanticKind: "guidance.base_context" as const,
            },
            options: [
                {
                    ...selected,
                    option: { ...preserved, semanticRefFingerprint: "d".repeat(64), optionFingerprint: "e".repeat(64) },
                },
            ],
        };
        const candidate = { ...review, groups: [first, second] };
        expect(catalogRenderReviewIsPassiveSingleton(review)).toBe(true);
        expect(catalogRenderGroupIsPassive(first)).toBe(true);
        expect(catalogRenderGroupIsPassive({ ...first, options: [] })).toBe(false);
        expect(
            catalogRenderGroupIsPassive({
                ...first,
                options: [{ ...selected, option: { ...preserved, approvalState: "required" } }],
            }),
        ).toBe(false);
        expect(
            catalogRenderGroupIsPassive({ ...first, options: [{ ...selected, option: { ...preserved, outcome: "degraded" } }] }),
        ).toBe(false);
        expect(catalogRenderReviewIsPassiveSingleton({ ...review, groups: [] })).toBe(false);
        expect(catalogRenderReviewIsPassiveSingleton(candidate)).toBe(true);

        const exceptionalGroups: ReadonlyArray<{ readonly name: string; readonly group: typeof first }> = [
            {
                name: "different runtime",
                group: { ...second, semantic: { ...second.semantic, consumerAgentRuntimeId: "OPENCODE_CLI" } },
            },
            {
                name: "different Asset",
                group: {
                    ...second,
                    semantic: {
                        ...second.semantic,
                        subject: { ...second.semantic.subject, assetId: "99999999-9999-4999-8999-999999999999" },
                    },
                },
            },
            {
                name: "different Version",
                group: {
                    ...second,
                    semantic: {
                        ...second.semantic,
                        subject: { ...second.semantic.subject, versionId: "88888888-8888-4888-8888-888888888888" },
                    },
                },
            },
            { name: "no option", group: { ...second, options: [] } },
            { name: "multiple options", group: { ...second, options: [selected, selected] } },
            { name: "no output", group: { ...second, options: [{ ...selected, outputUnits: [] }] } },
            {
                name: "different physical output",
                group: {
                    ...second,
                    options: [
                        {
                            ...selected,
                            outputUnits: selected.outputUnits.map((unit) => ({ ...unit, outputUnitFingerprint: "9".repeat(64) })),
                        },
                    ],
                },
            },
            {
                name: "blocked",
                group: {
                    ...second,
                    options: [],
                    blocked: {
                        semanticRefFingerprint: second.semantic.semanticRefFingerprint,
                        reasonCode: "blocked",
                        diagnostics: [],
                    },
                },
            },
            ...[
                { name: "different strategy", option: { ...preserved, renderStrategy: "inline" as const } },
                {
                    name: "different reverse policy",
                    option: { ...preserved, actualReverseExtractPolicy: "unsupported" as const },
                },
                {
                    name: "approval required",
                    option: {
                        ...preserved,
                        approvalState: "required" as const,
                        approvalConcerns: ["reverse_extract_unsupported" as const],
                        approvalFingerprint: "f".repeat(64),
                    },
                },
                {
                    name: "degraded",
                    option: {
                        ...preserved,
                        outcome: "degraded" as const,
                        degradationKinds: ["runtime_specific_metadata_lost" as const],
                    },
                },
                {
                    name: "diagnostic",
                    option: {
                        ...preserved,
                        diagnostics: [
                            {
                                severity: "warning" as const,
                                code: "render.fixture",
                                operation: "deploy" as const,
                                causeKind: "conflict" as const,
                                message: "Review the exact target.",
                                retryable: false,
                                suggestedActions: [],
                            },
                        ],
                    },
                },
            ].map(({ name, option }) => ({ name, group: { ...second, options: [{ ...selected, option }] } })),
            {
                name: "exact-file disposition",
                group: {
                    ...second,
                    semantic: { ...second.semantic, semanticKind: "workflow.content" },
                    options: [{ ...selected, option: { ...preserved, reasonCode: "native_project_exact_file_preserved" } }],
                },
            },
        ];
        for (const { name, group } of exceptionalGroups) {
            expect(catalogRenderReviewIsPassiveSingleton({ ...candidate, groups: [first, group] }), name).toBe(false);
        }
    });

    it("fills only an unambiguous strategy while preserving explicit degradation approval", () => {
        const preserved = RENDER_ANALYSIS.options[0];
        if (preserved === undefined) throw new Error("preserved render fixture is required");
        const singletonAnalysis = { ...RENDER_ANALYSIS, options: [preserved] };
        const review = projectRenderReview(singletonAnalysis);
        expect(review.status).toBe("ready");
        if (review.status !== "ready") throw new Error("singleton render review is required");
        const implicit = includeSingletonRenderSelections(review, []);
        expect(implicit).toEqual([
            {
                semanticRefFingerprint: SHA_A,
                optionFingerprint: SHA_B,
                approved: false,
            },
        ]);
        expect(buildRenderSelection(singletonAnalysis, implicit, "action")).toMatchObject({ status: "ready" });

        const explicit = [{ semanticRefFingerprint: SHA_A, optionFingerprint: SHA_B, approved: false }] as const;
        expect(includeSingletonRenderSelections(review, explicit)).toBe(explicit);

        const degraded = RENDER_ANALYSIS.options[1];
        if (degraded === undefined) throw new Error("degraded render fixture is required");
        const degradedAnalysis = { ...RENDER_ANALYSIS, options: [degraded] };
        const degradedReview = projectRenderReview(degradedAnalysis);
        expect(degradedReview.status).toBe("ready");
        if (degradedReview.status !== "ready") throw new Error("degraded singleton review is required");
        expect(
            buildRenderSelection(degradedAnalysis, includeSingletonRenderSelections(degradedReview, []), "action"),
        ).toMatchObject({
            status: "invalid",
            message: localizedText("catalog.validation.render_approval", { strategy: "inline" }),
        });
    });
});
