import { cleanup, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogRenderDisposition } from "../src/renderer/features/catalog-deployment/CatalogRenderDisposition";
import type { RenderOptionView, RenderSemanticView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { presentClaudeExactFileDisposition } from "../src/renderer/features/catalog-deployment/render-review-presentation";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";

const PRESERVED_OPTION: RenderOptionView = {
    optionFingerprint: SHA_B,
    semanticRefFingerprint: SHA_A,
    renderStrategy: "native_file",
    actualReverseExtractPolicy: "can_reconcile",
    requiredOutputUnitFingerprints: [],
    outcome: "preserved",
    approvalState: "not_required",
    reasonCode: "native_project_exact_file_preserved",
    diagnostics: [],
};

function semantic(semanticKind: RenderSemanticView["semanticKind"], consumerAgentRuntimeId = "CLAUDE_CODE_CLI") {
    return {
        semanticRefFingerprint: SHA_A,
        consumerAgentRuntimeId,
        semanticKind,
        subject: { subjectKind: "file" as const, assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
    } satisfies RenderSemanticView;
}

afterEach(() => cleanup());

describe("Claude exact-file ordinary disposition presentation", () => {
    it("maps only the three primary Claude CLI semantics and their exact terminal reasons", () => {
        const cases = [
            {
                semanticKind: "workflow.content" as const,
                detail: "catalog.ui.render.claude.preserved.workflow",
                blocked: "claudecode_project_workflow_exact_file_blocked",
            },
            {
                semanticKind: "skill.body" as const,
                detail: "catalog.ui.render.claude.preserved.skill",
                blocked: "claudecode_project_skill_exact_file_blocked",
            },
            {
                semanticKind: "subagent.invoked_context" as const,
                detail: "catalog.ui.render.claude.preserved.subagent",
                blocked: "claudecode_project_subagent_exact_file_blocked",
            },
        ];
        for (const item of cases) {
            expect(
                presentClaudeExactFileDisposition(semantic(item.semanticKind), {
                    state: "option",
                    option: PRESERVED_OPTION,
                }),
            ).toEqual({
                state: "preserved",
                title: "catalog.ui.render.claude.title.preserved",
                detail: item.detail,
                boundary: "catalog.ui.render.claude.no_silent_degradation",
            });
            expect(
                presentClaudeExactFileDisposition(semantic(item.semanticKind), {
                    state: "blocked",
                    reasonCode: item.blocked,
                }),
            ).toMatchObject({ state: "blocked", title: "catalog.ui.render.claude.title.blocked" });
        }
    });

    it("does not infer Claude preservation from a sibling runtime, semantic, degraded option, or foreign reason", () => {
        expect(
            presentClaudeExactFileDisposition(semantic("workflow.content", "CLAUDE_CODE_APP"), {
                state: "option",
                option: PRESERVED_OPTION,
            }),
        ).toBeUndefined();
        expect(
            presentClaudeExactFileDisposition(semantic("workflow.activation"), {
                state: "option",
                option: PRESERVED_OPTION,
            }),
        ).toBeUndefined();
        expect(
            presentClaudeExactFileDisposition(semantic("workflow.content"), {
                state: "option",
                option: {
                    ...PRESERVED_OPTION,
                    outcome: "degraded",
                    degradationKinds: ["runtime_specific_metadata_lost"],
                },
            }),
        ).toBeUndefined();
        expect(
            presentClaudeExactFileDisposition(semantic("workflow.content"), {
                state: "blocked",
                reasonCode: "target_unsupported",
            }),
        ).toBeUndefined();
    });

    it("renders preserved and blocked copy as ordinary product language", () => {
        const preserved = renderWithPresentation(
            createElement(CatalogRenderDisposition, {
                semantic: semantic("workflow.content"),
                option: PRESERVED_OPTION,
            }),
        );
        expect(screen.getByText("Claude Code settings kept")).toBeTruthy();
        expect(screen.getByText(/keeps the existing Claude Code command settings/u)).toBeTruthy();
        expect(screen.getByText(/instead of silently dropping behavior/u)).toBeTruthy();
        preserved.unmount();

        renderWithPresentation(
            createElement(CatalogRenderDisposition, {
                semantic: semantic("skill.body"),
                blocked: {
                    semanticRefFingerprint: SHA_A,
                    reasonCode: "claudecode_project_skill_exact_file_blocked",
                    diagnostics: [],
                },
            }),
        );
        expect(screen.getByText("Claude Code settings cannot be kept safely")).toBeTruthy();
        expect(screen.getByText(/one-file SKILL\.md format/u)).toBeTruthy();
        expect(screen.queryByText("claudecode_project_skill_exact_file_blocked")).toBeNull();
    });
});
