import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { AssetAuthorizations } from "../src/renderer/features/project-library/AssetAuthorizations";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";

const ASSET = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);
const grant = {
    promotionGrantId: GRANT,
    subject: { subjectKind: "asset_version" as const, assetId: ASSET, versionId: VERSION },
    target: { targetKind: "project" as const, projectId: PROJECT },
    targetDescription: {
        status: "available" as const,
        targetKind: "project" as const,
        displayName: "Example Project",
        rootPath: "/workspace/example",
    },
    grantState: "active" as const,
    revision: 7,
    grantFingerprint: HASH,
    updatedAt: 1000,
};
const complete = <T>(value: T) => ({ status: "complete" as const, value, diagnostics: [] });

function fixture(overrides: Partial<DesktopApplicationClientApi> = {}) {
    const listPromotionGrants = vi.fn(async () => complete({ grants: [grant] }));
    const revokePromotionGrant = vi.fn(async () => complete({ ...grant, grantState: "revoked" as const }));
    const client = {
        listPromotionGrants,
        revokePromotionGrant,
        listAdapterProviders: vi.fn(async () => complete({ providers: [] })),
        getAssetVersion: vi.fn(async () => complete({ found: true, value: { assetId: ASSET, versionId: VERSION, revision: 3 } })),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
    return { client, listPromotionGrants, revokePromotionGrant };
}
afterEach(cleanup);

describe("Asset-context authorization review", () => {
    it("shows recognizable version and Project, keeps technical IDs collapsed and restores keyboard focus on cancel", async () => {
        const f = fixture();
        const { container } = renderWithPresentation(createElement(AssetAuthorizations, { client: f.client, assetId: ASSET }));
        expect(await screen.findByText("Example Project", { exact: false })).toBeTruthy();
        expect(screen.getByText("Version 3")).toBeTruthy();
        expect(ordinarySurfaceText(container)).toContain("/workspace/example");
        expect(ordinarySurfaceText(container)).not.toContain(HASH);
        expect(ordinarySurfaceText(container)).not.toContain(GRANT);
        fireEvent.click(screen.getByRole("button", { name: "Revoke authorization" }));
        expect(screen.getByRole("button", { name: "Cancel" })).toBe(document.activeElement);
        fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
        await waitFor(() => expect(screen.getByRole("button", { name: "Revoke authorization" })).toBe(document.activeElement));
        expect(f.revokePromotionGrant).not.toHaveBeenCalled();
        expect(f.listPromotionGrants).toHaveBeenCalledTimes(1);
    });

    it("confirms one exact CAS revoke and reads current records before showing revoked state", async () => {
        const f = fixture();
        f.listPromotionGrants
            .mockResolvedValueOnce(complete({ grants: [grant] }))
            .mockResolvedValueOnce(complete({ grants: [{ ...grant, grantState: "revoked" }] }) as never);
        renderWithPresentation(createElement(AssetAuthorizations, { client: f.client, assetId: ASSET }));
        fireEvent.click(await screen.findByRole("button", { name: "Revoke authorization" }));
        expect(screen.getByText(/Future writes cannot use this authorization/u)).toBeTruthy();
        expect(f.revokePromotionGrant).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
        expect(await screen.findByText("Revoked")).toBeTruthy();
        expect(f.revokePromotionGrant).toHaveBeenCalledWith({
            promotionGrantId: GRANT,
            expectedRevision: 7,
            expectedGrantFingerprint: HASH,
            userActionId: expect.any(String),
        });
        expect(f.listPromotionGrants).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(screen.getByRole("button", { name: "Refresh authorizations" })).toBe(document.activeElement));
        expect(screen.queryByRole("button", { name: "Revoke authorization" })).toBeNull();
    });

    it("keeps an unknown global target and all-version scope visible and revocable", async () => {
        const f = fixture({
            listPromotionGrants: vi.fn(async () =>
                complete({
                    grants: [
                        {
                            ...grant,
                            subject: { subjectKind: "asset_all_versions", assetId: ASSET, activationVersionId: VERSION },
                            target: { targetKind: "global_target", targetAuthorityFingerprint: HASH },
                            targetDescription: { status: "unavailable" },
                        },
                    ],
                }),
            ),
        });
        renderWithPresentation(createElement(AssetAuthorizations, { client: f.client, assetId: ASSET }));
        expect(await screen.findByText("All existing and future versions")).toBeTruthy();
        expect(screen.getByText("Global location")).toBeTruthy();
        expect(screen.getByText(/The location record is unavailable/u)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Revoke authorization" }).hasAttribute("disabled")).toBe(false);
        expect(f.client.getAssetVersion).not.toHaveBeenCalled();
    });

    it("keeps missing Version details explicit and displays saved global environment and target", async () => {
        const f = fixture({
            listPromotionGrants: vi.fn(async () =>
                complete({
                    grants: [
                        {
                            ...grant,
                            target: { targetKind: "global_target", targetAuthorityFingerprint: HASH },
                            targetDescription: {
                                status: "available",
                                targetKind: "global_target",
                                platform: "wsl",
                                platformInstanceId: "Ubuntu fixture",
                                targetRootPath: "/home/fixture/.claude",
                                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            },
                        },
                    ],
                }),
            ),
            getAssetVersion: vi.fn(async () => complete({ found: false as const })),
        });
        renderWithPresentation(createElement(AssetAuthorizations, { client: f.client, assetId: ASSET }));
        expect(await screen.findByText("Specific version — details unavailable")).toBeTruthy();
        expect(screen.getByText("WSL — Ubuntu fixture")).toBeTruthy();
        expect(screen.getByText("/home/fixture/.claude")).toBeTruthy();
    });

    it("requires a fresh list after a stale revoke refusal, without claiming success or automatically retrying", async () => {
        const revoke = vi.fn(async () => ({
            status: "failed" as const,
            diagnostics: [
                {
                    severity: "error" as const,
                    code: "promotion.grant_changed",
                    operation: "asset" as const,
                    causeKind: "conflict" as const,
                    retryable: false,
                    suggestedActions: [],
                    message: "record changed",
                },
            ],
        }));
        const f = fixture({ revokePromotionGrant: revoke });
        renderWithPresentation(createElement(AssetAuthorizations, { client: f.client, assetId: ASSET }));
        fireEvent.click(await screen.findByRole("button", { name: "Revoke authorization" }));
        fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
        expect(await screen.findByText(/Revocation was not confirmed/u)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Revoke authorization" }).hasAttribute("disabled")).toBe(true);
        expect(revoke).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Refresh authorizations" }));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Revoke authorization" }).hasAttribute("disabled")).toBe(false),
        );
    });

    it("offers retry after a real transport rejection and then shows an empty list", async () => {
        const f = fixture({
            listPromotionGrants: vi
                .fn()
                .mockRejectedValueOnce(new Error("closed"))
                .mockResolvedValueOnce(complete({ grants: [] })),
        });
        renderWithPresentation(createElement(AssetAuthorizations, { client: f.client, assetId: ASSET }));
        expect(await screen.findByText("Authorizations could not be loaded. Try again.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Refresh authorizations" }));
        expect(await screen.findByText("This Asset has no saved authorizations for a specific location.")).toBeTruthy();
    });
});
