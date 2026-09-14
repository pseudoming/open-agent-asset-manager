/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import { selectionFixture, selectionResult } from "./fixtures/render-selection-test-fixtures";

describe("render approval authority", () => {
    it("blocks degradation without approval and rejects an unverified one-time action", async () => {
        const fixture = await selectionFixture({ outcome: "degraded" });
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.approval_required");
        fixture.request.semanticOptions = fixture.request.semanticOptions.map((request) => ({
            ...request,
            approvalRequest: {
                approvalAction: "approve_once",
                userActionId: "user-action-1",
            },
        }));
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.one_time_approval_unverified");
    });

    it("accepts only a Core-verified exact one-time approval", async () => {
        const seen: string[] = [];
        const fixture = await selectionFixture({
            outcome: "degraded",
            confirm: (input) => {
                seen.push(input.approvalFingerprint);
                input.deployment.assets.length = 0;
                input.option.requiredOutputUnitFingerprints.length = 0;
                return input.userActionId === "approved-action" ? 1234 : null;
            },
        });
        fixture.request.semanticOptions = fixture.request.semanticOptions.map((request) => ({
            ...request,
            approvalRequest: {
                approvalAction: "approve_once",
                userActionId: "approved-action",
            },
        }));
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(seen).toHaveLength(fixture.analysis.requiredSemantics.length);
        expect(fixture.deployment.assets).toHaveLength(1);
        expect(result.value.semanticOptions[0]?.approval).toEqual(
            expect.objectContaining({
                approvalSource: "one_time_user_approval",
                userActionEvidenceId: "approved-action",
                resolvedAt: 1234,
            }),
        );
    });

    it("rejects stale saved policy evidence and accepts exact id/revision/fingerprint", async () => {
        let exact = false;
        const fixture = await selectionFixture({
            outcome: "degraded",
            resolveSavedPolicy: (input) =>
                exact
                    ? {
                          policyId: input.policyId,
                          policyRevision: 2,
                          approvalFingerprint: input.approvalFingerprint,
                          resolvedAt: 1234,
                      }
                    : {
                          policyId: input.policyId,
                          policyRevision: 0,
                          approvalFingerprint: input.approvalFingerprint,
                          resolvedAt: 1234,
                      },
        });
        fixture.request.semanticOptions = fixture.request.semanticOptions.map((request) => ({
            ...request,
            approvalRequest: { approvalAction: "use_saved_policy", policyId: "policy-1" },
        }));
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.saved_policy_stale");
        exact = true;
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.semanticOptions[0]?.approval).toEqual(
            expect.objectContaining({
                approvalSource: "saved_user_policy",
                policyId: "policy-1",
                policyRevision: 2,
            }),
        );
    });

    it("does not accept approval evidence on a safe option and validates authority resolution time", async () => {
        const fixture = await selectionFixture();
        fixture.request.semanticOptions[0]!.approvalRequest = {
            approvalAction: "approve_once",
            userActionId: "unneeded",
        };
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.approval_unexpected");

        for (const resolvedAt of [-1, Number.MAX_SAFE_INTEGER + 1]) {
            const degraded = await selectionFixture({
                outcome: "degraded",
                confirm: () => resolvedAt,
            });
            degraded.request.semanticOptions = degraded.request.semanticOptions.map((request) => ({
                ...request,
                approvalRequest: { approvalAction: "approve_once", userActionId: "approval-action" },
            }));
            expect(selectionResult(degraded).diagnostics[0]?.code).toBe("render.resolution_time_invalid");
        }
    });

    it("keeps safe selection clock-independent and converts a non-Error approval-port throw into a typed failure", async () => {
        const safe = await selectionFixture();
        safe.configuration.now = undefined;
        expect(selectionResult(safe).status).toBe("complete");

        const faulting = await selectionFixture({
            outcome: "degraded",
            confirm: () => {
                throw "approval port failed";
            },
        });
        faulting.request.semanticOptions = faulting.request.semanticOptions.map((request) => ({
            ...request,
            approvalRequest: {
                approvalAction: "approve_once",
                userActionId: "approval-action",
            },
        }));
        expect(selectionResult(faulting).diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "render.selection_internal_error",
                message: "approval port failed",
                causeKind: "internal_error",
                retryable: false,
            }),
        );
    });

    it("rejects blank one-time and saved-policy evidence before calling an authority", async () => {
        const fixture = await selectionFixture({ outcome: "degraded" });
        fixture.request.semanticOptions = fixture.request.semanticOptions.map((request) => ({
            ...request,
            approvalRequest: { approvalAction: "approve_once", userActionId: " " },
        }));
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.user_evidence_missing");
        fixture.request.semanticOptions = fixture.request.semanticOptions.map((request) => ({
            ...request,
            approvalRequest: { approvalAction: "use_saved_policy", policyId: "" },
        }));
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.user_evidence_missing");
    });
});
