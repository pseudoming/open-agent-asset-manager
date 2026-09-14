import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { ConfirmOneTimeRenderApprovalInput, Sha256Digest, UuidV4 } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { ProductionHostRuntime } from "../src/host-runtime";
import { createHostRenderApprovalAuthority } from "../src/render-approval-authority";
import {
    ASSET_ID,
    VERSION_ID,
    fakeCoreWith,
    initializeRequest,
    recordingSink,
    testStateResilienceIntegration,
} from "./support/host-test-fixtures";

const INPUT = "a".repeat(64);
const OPTION = "b".repeat(64);
const OTHER = `sha256:${"c".repeat(64)}` as Sha256Digest;

describe("reverse commit approval through the production Host connection", () => {
    it.each([
        { approved: true, failed: false },
        { approved: true, failed: true },
        { approved: false, failed: false },
    ])("keeps exact approval operation-local with $approved approval and $failed failure", async ({ approved, failed }) => {
        const authority = createHostRenderApprovalAuthority(() => 42);
        let observed: ConfirmOneTimeRenderApprovalInput | undefined;
        const commit = vi.fn(async (input: Parameters<ReturnType<typeof fakeCoreWith>["commitRenderedTargetAccept"]>[0]) => {
            const selected = input.renderSelectionRequest.semanticOptions[0]!;
            observed = {
                userActionId: "approve-this-reverse",
                approvalFingerprint: OTHER,
                deployment: {
                    renderInputFingerprint: input.renderSelectionRequest.renderInputFingerprint,
                } as ConfirmOneTimeRenderApprovalInput["deployment"],
                semantic: {} as ConfirmOneTimeRenderApprovalInput["semantic"],
                option: { optionFingerprint: selected.optionFingerprint } as ConfirmOneTimeRenderApprovalInput["option"],
            };
            await Promise.resolve();
            expect(authority.confirmOneTimeApproval(observed)).toBe(approved ? 42 : null);
            expect(authority.confirmOneTimeApproval({ ...observed, userActionId: "different-action" })).toBeNull();
            expect(
                authority.confirmOneTimeApproval({ ...observed, option: { ...observed.option, optionFingerprint: OTHER } }),
            ).toBeNull();
            expect(
                authority.confirmOneTimeApproval({
                    ...observed,
                    deployment: { ...observed.deployment, renderInputFingerprint: OTHER },
                }),
            ).toBeNull();
            return failed
                ? { status: "failed" as const, value: { commitState: "outcome_unavailable" as const }, diagnostics: [] }
                : {
                      status: "complete" as const,
                      value: {
                          commitState: "committed" as const,
                          version: { assetId: ASSET_ID as UuidV4, versionId: VERSION_ID as UuidV4 },
                      },
                      diagnostics: [],
                  };
        });
        const runtime = new ProductionHostRuntime(
            "reverse-approval-host",
            fakeCoreWith({ commitRenderedTargetAccept: commit }),
            testStateResilienceIntegration(),
            {
                renderApprovalAuthority: authority,
            },
        );
        try {
            const sink = recordingSink();
            const connection = runtime.openConnection(sink);
            connection.receive(initializeRequest());
            connection.receive(
                createProtocolRequest("reverse", "reverse_accept.commit", {
                    preparationId: VERSION_ID,
                    expectedPreparationRevision: 1,
                    userActionId: "save-this-reverse",
                    newVersionPromotion: "use_existing_authority",
                    renderSelection: {
                        schemaVersion: 1,
                        renderInputFingerprint: INPUT,
                        semanticOptions: [
                            {
                                optionFingerprint: OPTION,
                                approval: approved
                                    ? { action: "approve_once", userActionId: "approve-this-reverse" }
                                    : { action: "none" },
                            },
                        ],
                    },
                }),
            );
            const terminal = () =>
                sink.messages.find((message) => "method" in message && message.method === "operation.terminal");
            await vi.waitFor(() => expect(terminal()).toBeDefined());
            expect(commit).toHaveBeenCalledOnce();
            expect(terminal()).toMatchObject({
                params: {
                    outcome: {
                        status: failed ? "failed" : "complete",
                        value: failed
                            ? { commitState: "outcome_unavailable" }
                            : { commitState: "committed", version: { assetId: ASSET_ID, versionId: VERSION_ID } },
                    },
                },
            });
            expect(observed).toBeDefined();
            expect(authority.confirmOneTimeApproval(observed!)).toBeNull();
        } finally {
            await runtime.shutdown();
        }
    });
});
