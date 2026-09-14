import { describe, expect, it, vi } from "vitest";
import { commitAndCompleteReverseAccept } from "../../src/orchestration/reverse-accept-completion";
import type {
    CommitRenderedTargetAcceptInput,
    CoreResult,
    OperationDiagnostic,
    RenderedTargetAcceptCommitView,
    Sha256Digest,
    UuidV4,
} from "../../src/types";

const preparationId = "11111111-1111-4111-8111-111111111111" as UuidV4;
const version = {
    assetId: "22222222-2222-4222-8222-222222222222" as UuidV4,
    versionId: "33333333-3333-4333-8333-333333333333" as UuidV4,
};
const request: CommitRenderedTargetAcceptInput = {
    preparationId,
    expectedPreparationRevision: 1,
    userActionId: "accept-current-review",
    newVersionPromotion: { promotionAction: "use_existing_authority" },
    renderSelectionRequest: {
        schemaVersion: 1,
        renderInputFingerprint: `sha256:${"a".repeat(64)}` as Sha256Digest,
        semanticOptions: [],
    },
};
const committed: CoreResult<RenderedTargetAcceptCommitView> = {
    status: "complete",
    value: { commitState: "committed", version },
    diagnostics: [],
};
type Dependencies = Parameters<typeof commitAndCompleteReverseAccept>[1];
const diagnostic: OperationDiagnostic = {
    severity: "warning",
    code: "fixture.index_skipped",
    message: "Index skipped",
    path: "",
    traceId: "",
    operation: "reindex",
    causeKind: "partial",
    retryable: true,
    suggestedActions: ["retry"],
    rawSummary: "Index skipped",
};
function setup() {
    return {
        commit: vi.fn<Dependencies["commit"]>(async () => committed),
        finalize: vi.fn<Dependencies["finalize"]>(() => ({
            reconcileState: "retired",
            terminalState: "consumed",
            preparationRevision: 4,
        })),
        reindex: vi.fn<Dependencies["reindex"]>(() => ({ status: "complete", value: { diagnostics: [] }, diagnostics: [] })),
    };
}

describe("public committed result during exact reverse completion", () => {
    it("waits for commit completion, then retires and indexes only the committed Asset", async () => {
        const dependencies = setup();
        let release!: () => void;
        dependencies.commit.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(committed);
                }),
        );
        const input = structuredClone(request);
        const pending = commitAndCompleteReverseAccept(input, dependencies);
        input.preparationId = version.assetId;
        expect(dependencies.finalize).not.toHaveBeenCalled();
        release();
        expect(await pending).toBe(committed);
        expect(dependencies.finalize).toHaveBeenCalledWith(preparationId, version);
        expect(dependencies.reindex).toHaveBeenCalledTimes(1);
        expect(dependencies.reindex).toHaveBeenCalledWith(version.assetId);
        expect(dependencies.finalize.mock.invocationCallOrder[0]).toBeLessThan(
            dependencies.reindex.mock.invocationCallOrder[0] as number,
        );
    });

    it("accepts a matching already-retired result and ignores informational index notes", async () => {
        const dependencies = setup();
        dependencies.finalize.mockReturnValue({ reconcileState: "resolved", preparationState: "retired" });
        dependencies.reindex.mockReturnValue({
            status: "complete",
            value: { diagnostics: [{ ...diagnostic, severity: "info" }] },
            diagnostics: [],
        });
        expect(await commitAndCompleteReverseAccept(request, dependencies)).toBe(committed);
    });

    it.each([
        { status: "failed", value: { commitState: "outcome_unavailable" }, diagnostics: [] },
        {
            status: "partial",
            value: { commitState: "not_committed", versionPublicationState: "published_not_selected", version },
            diagnostics: [],
        },
        { status: "failed", value: { commitState: "not_committed", versionPublicationState: "not_published" }, diagnostics: [] },
    ] as CoreResult<RenderedTargetAcceptCommitView>[])("does not finalize a non-committed outcome: $value.commitState", async (result) => {
        const dependencies = setup();
        dependencies.commit.mockResolvedValue(result);
        expect(await commitAndCompleteReverseAccept(request, dependencies)).toBe(result);
        expect(dependencies.finalize).not.toHaveBeenCalled();
        expect(dependencies.reindex).not.toHaveBeenCalled();
    });

    it.each([
        "busy",
        "failed_terminal",
        "resolved_cancelled",
        "recovery_required",
        "binding",
        "throw",
    ] as const)("keeps the committed Version and blocks indexing after %s retirement", async (failure) => {
        const dependencies = setup();
        dependencies.finalize.mockImplementation(() => {
            if (failure === "throw") throw new Error("durability unavailable");
            if (failure === "binding") throw new TypeError("terminal binding mismatch");
            if (failure === "recovery_required")
                return { reconcileState: "recovery_required", reasonCode: "durability_unconfirmed", preparationRevision: 4 };
            if (failure === "failed_terminal")
                return { reconcileState: "retired", terminalState: "failed", preparationRevision: 4 };
            if (failure === "resolved_cancelled") return { reconcileState: "resolved", preparationState: "cancelled" };
            return { reconcileState: "busy", deploymentId: version.assetId };
        });
        const result = await commitAndCompleteReverseAccept(request, dependencies);
        expect(result).toMatchObject({
            status: "complete",
            value: committed.value,
            diagnostics: [{ code: "reverse_accept.completion_pending", severity: "warning", retryable: true }],
        });
        expect(dependencies.reindex).not.toHaveBeenCalled();
        expect(result.diagnostics[0]?.rawSummary).toContain(
            failure === "binding"
                ? "invalid_terminal_binding"
                : failure === "throw"
                  ? "terminal_persistence_unavailable"
                  : failure === "recovery_required"
                    ? "durability_unconfirmed"
                    : failure === "failed_terminal"
                      ? "retired"
                      : failure === "resolved_cancelled"
                        ? "resolved"
                        : "busy",
        );
    });

    it.each([
        "failed",
        "partial",
        "reported_warning",
        "throw",
    ] as const)("retains committed success with a retry hint after %s indexing", async (failure) => {
        const dependencies = setup();
        dependencies.reindex.mockImplementation(() => {
            if (failure === "throw") throw new Error("index unavailable");
            if (failure === "failed") return { status: "failed", value: undefined as never, diagnostics: [diagnostic] };
            return {
                status: failure === "reported_warning" ? "complete" : failure,
                value: { diagnostics: [diagnostic] },
                diagnostics: [],
            };
        });
        const result = await commitAndCompleteReverseAccept(request, dependencies);
        expect(result).toMatchObject({ status: "complete", value: committed.value });
        expect(result.diagnostics[0]).toMatchObject({
            code: "reverse_accept.index_refresh_pending",
            operation: "reindex",
            retryable: true,
        });
        if (failure !== "throw") expect(result.diagnostics).toContainEqual(diagnostic);
        expect(dependencies.finalize).toHaveBeenCalledTimes(1);
    });

    it("leaves invalid getter handling with the original commit boundary", async () => {
        const dependencies = setup();
        const input = {
            ...request,
            get preparationId(): UuidV4 {
                throw new TypeError("invalid input getter");
            },
        };
        const failure: CoreResult<RenderedTargetAcceptCommitView> = {
            status: "failed",
            value: { commitState: "outcome_unavailable" },
            diagnostics: [],
        };
        dependencies.commit.mockResolvedValue(failure);
        expect(await commitAndCompleteReverseAccept(input, dependencies)).toBe(failure);
        expect(dependencies.commit).toHaveBeenCalledTimes(1);
        expect(dependencies.commit.mock.calls[0]?.[0]).toBe(input);
        expect(dependencies.finalize).not.toHaveBeenCalled();
    });
});
