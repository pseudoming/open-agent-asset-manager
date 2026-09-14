import type { ConfirmOneTimeRenderApprovalInput, RenderSelectionRequest, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    createHostRenderApprovalAuthority,
    hostRenderApprovalResolutionsMatchSelection,
    isHostOneTimeRenderApprovalResolution,
} from "../src/render-approval-authority";

const DIGEST_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const DIGEST_B = `sha256:${"b".repeat(64)}` as Sha256Digest;
const DIGEST_C = `sha256:${"c".repeat(64)}` as Sha256Digest;

function selection(
    renderInputFingerprint = DIGEST_A,
    optionFingerprint = DIGEST_B,
    userActionId = "approve-migration",
): RenderSelectionRequest {
    return {
        schemaVersion: 1,
        renderInputFingerprint,
        semanticOptions: [
            {
                optionFingerprint,
                approvalRequest: { approvalAction: "approve_once", userActionId },
            },
        ],
    };
}

function challenge(
    request: RenderSelectionRequest,
    optionFingerprint = required(request.semanticOptions[0], "render option is missing").optionFingerprint,
    userActionId = "approve-migration",
): ConfirmOneTimeRenderApprovalInput {
    return {
        userActionId,
        approvalFingerprint: DIGEST_C,
        deployment: { renderInputFingerprint: request.renderInputFingerprint } as ConfirmOneTimeRenderApprovalInput["deployment"],
        semantic: {} as ConfirmOneTimeRenderApprovalInput["semantic"],
        option: { optionFingerprint } as ConfirmOneTimeRenderApprovalInput["option"],
    };
}

describe("Host operation-local render approval authority", () => {
    it("attests only an exact armed selection and reuses its stable resolution time", async () => {
        let clockCalls = 0;
        const authority = createHostRenderApprovalAuthority(() => {
            clockCalls += 1;
            return 1_234;
        });
        const request = selection();
        const resolutions = authority.createResolutions(request);

        expect(clockCalls).toBe(1);
        expect(resolutions).toEqual([
            {
                renderInputFingerprint: DIGEST_A,
                optionFingerprint: DIGEST_B,
                userActionId: "approve-migration",
                resolvedAt: 1_234,
            },
        ]);
        expect(authority.confirmOneTimeApproval(challenge(request))).toBeNull();

        await authority.runWithResolutions(request, resolutions, async () => {
            expect(authority.confirmOneTimeApproval(challenge(request))).toBe(1_234);
            expect(authority.confirmOneTimeApproval(challenge(request))).toBe(1_234);
            expect(authority.confirmOneTimeApproval(challenge(request, DIGEST_C))).toBeNull();
            expect(authority.confirmOneTimeApproval(challenge(request, DIGEST_B, "different-action"))).toBeNull();
            expect(
                authority.confirmOneTimeApproval(challenge(selection(DIGEST_C, DIGEST_B), DIGEST_B, "approve-migration")),
            ).toBeNull();
        });

        expect(authority.confirmOneTimeApproval(challenge(request))).toBeNull();
    });

    it("does not consult the clock for a selection without one-time approval", () => {
        const authority = createHostRenderApprovalAuthority(() => {
            throw new Error("clock must not be consulted");
        });
        const request: RenderSelectionRequest = {
            schemaVersion: 1,
            renderInputFingerprint: DIGEST_A,
            semanticOptions: [{ optionFingerprint: DIGEST_B, approvalRequest: { approvalAction: "none" } }],
        };
        expect(authority.createResolutions(request)).toEqual([]);
        expect(hostRenderApprovalResolutionsMatchSelection(request, [])).toBe(true);
    });

    it("isolates concurrent operation scopes", async () => {
        let time = 10;
        const authority = createHostRenderApprovalAuthority(() => time++);
        const first = selection(DIGEST_A, DIGEST_B, "first");
        const second = selection(DIGEST_C, DIGEST_A, "second");
        const firstResolutions = authority.createResolutions(first);
        const secondResolutions = authority.createResolutions(second);

        await Promise.all([
            authority.runWithResolutions(first, firstResolutions, async () => {
                await Promise.resolve();
                expect(authority.confirmOneTimeApproval(challenge(first, DIGEST_B, "first"))).toBe(10);
                expect(authority.confirmOneTimeApproval(challenge(second, DIGEST_A, "second"))).toBeNull();
            }),
            authority.runWithResolutions(second, secondResolutions, async () => {
                await Promise.resolve();
                expect(authority.confirmOneTimeApproval(challenge(second, DIGEST_A, "second"))).toBe(11);
                expect(authority.confirmOneTimeApproval(challenge(first, DIGEST_B, "first"))).toBeNull();
            }),
        ]);
    });

    it("rejects missing, extra, duplicate, stale, malformed, and invalid-time resolutions", async () => {
        const request = selection();
        const valid = required(
            createHostRenderApprovalAuthority(() => 1_234).createResolutions(request)[0],
            "render approval resolution is missing",
        );
        const authority = createHostRenderApprovalAuthority(() => 1_234);
        const extra = { ...valid, optionFingerprint: DIGEST_C };
        const stale = { ...valid, renderInputFingerprint: DIGEST_C };

        for (const resolutions of [[], [valid, extra], [valid, valid], [stale]]) {
            await expect(authority.runWithResolutions(request, resolutions, async () => undefined)).rejects.toThrow(
                /approval resolution/u,
            );
        }
        expect(hostRenderApprovalResolutionsMatchSelection(request, [{ ...valid, resolvedAt: -1 }])).toBe(false);
        expect(isHostOneTimeRenderApprovalResolution({ ...valid, unknown: true })).toBe(false);
        expect(isHostOneTimeRenderApprovalResolution({ ...valid, userActionId: " bad " })).toBe(false);
        expect(isHostOneTimeRenderApprovalResolution(null)).toBe(false);
        expect(() => createHostRenderApprovalAuthority(() => -1).createResolutions(request)).toThrow(/time/u);
        expect(() => createHostRenderApprovalAuthority(() => Number.MAX_SAFE_INTEGER + 1).createResolutions(request)).toThrow(
            /time/u,
        );
    });

    it("rejects blank or duplicate one-time requests before publishing authority", () => {
        const authority = createHostRenderApprovalAuthority(() => 1_234);
        const blank = selection(DIGEST_A, DIGEST_B, " ");
        const duplicate = selection();
        duplicate.semanticOptions.push(structuredClone(required(duplicate.semanticOptions[0], "render option is missing")));

        expect(() => authority.createResolutions(blank)).toThrow(/non-blank and unique/u);
        expect(() => authority.createResolutions(duplicate)).toThrow(/non-blank and unique/u);
        expect(hostRenderApprovalResolutionsMatchSelection(blank, [])).toBe(false);
    });
});

function required<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new Error(message);
    return value;
}
