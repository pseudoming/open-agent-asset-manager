import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { App } from "../src/renderer/app/App";
import type { DesktopApplicationClientApi, DesktopSession, DesktopSessionState } from "../src/renderer/client";
import { ASSET_DETAIL, PROJECT, VERSION } from "./catalog-deployment-test-support";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeImportableDiscoveryClient } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Onboarding result navigation through the App", () => {
    it.each([
        "failed",
        "not_found",
    ] as const)("keeps a delayed %s Asset lookup retriable before completing onboarding", async (failure) => {
        const assetId = "11111111-1111-4111-8111-111111111111";
        const versionId = "22222222-2222-4222-8222-222222222222";
        const initial = createDesktopPresentationSnapshot(DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, ["en-US"], false);
        let saved = initial;
        const completeOnboarding = vi.fn(async () => {
            saved = createDesktopPresentationSnapshot({ ...saved.preferences, onboardingCompleted: true }, ["en-US"], false);
            return saved;
        });
        const bridge = {
            ...createDesktopPresentationTestBridge(initial),
            completeOnboarding,
            async rememberLastProject(projectId: string) {
                saved = createDesktopPresentationSnapshot(
                    { ...saved.preferences, lastSelectedProjectId: projectId },
                    ["en-US"],
                    false,
                );
                return saved;
            },
        };
        const base = fakeImportableDiscoveryClient();
        let finishLookup: ((result: Awaited<ReturnType<DesktopApplicationClientApi["getAsset"]>>) => void) | undefined;
        const pending = new Promise<Awaited<ReturnType<DesktopApplicationClientApi["getAsset"]>>>((resolve) => {
            finishLookup = resolve;
        });
        const getAsset = vi
            .fn<DesktopApplicationClientApi["getAsset"]>()
            .mockImplementationOnce(async () => pending)
            .mockResolvedValue({
                status: "complete",
                value: { found: true, value: { ...ASSET_DETAIL, assetId, versionIds: [versionId] } },
                diagnostics: [],
            });
        const client: DesktopApplicationClientApi = {
            ...base,
            getAsset,
            supportsOperation: (operation) =>
                base.supportsOperation(operation) ||
                operation === "asset_version.list" ||
                operation === "asset_version.file_children",
            listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [PROJECT] }, diagnostics: [] })),
            listAssetVersions: vi.fn(async () => ({
                status: "complete",
                value: {
                    found: true,
                    value: {
                        versions: [
                            {
                                ...VERSION,
                                assetId,
                                versionId,
                                fingerprint: "a".repeat(64),
                                originAuthorityFingerprint: "b".repeat(64),
                                changeKind: "create",
                                sourceVersionId: "",
                                sourceDeploymentId: "",
                                changeNote: "",
                                fileCount: 0,
                            },
                        ],
                        totalCount: 1,
                        hasMore: false,
                    },
                },
                diagnostics: [],
            })),
            listAssetVersionFileChildren: vi.fn(async () => ({
                status: "complete",
                value: {
                    found: true,
                    value: {
                        entries: [],
                        totalCount: 0,
                        hasMore: false,
                    },
                },
                diagnostics: [],
            })),
        };
        const state: DesktopSessionState = {
            status: "ready",
            mode: "normal",
            hostInstanceId: "fixture",
            assetCount: 0,
            catalogWarningCount: 0,
        };
        const session = {
            state,
            applicationClient: client,
            desktopBridge: bridge,
            subscribe: (listener: (next: DesktopSessionState) => void) => {
                listener(state);
                return () => undefined;
            },
            close: vi.fn(),
            refreshCatalogSummary: vi.fn(async () => undefined),
            authorizeObservedProjectRoot: bridge.authorizeObservedProjectRoot,
            revealObservedProjectRoot: bridge.revealObservedProjectRoot,
            authorizeRegisteredProjectRoot: bridge.authorizeRegisteredProjectRoot,
            revealImportPreviewFile: bridge.revealImportPreviewFile,
        } as unknown as DesktopSession;
        const { container } = renderWithPresentation(createElement(App, { session }), bridge);
        await act(async () => vi.dynamicImportSettled());
        fireEvent.click(await screen.findByRole("button", { name: "Start guided setup" }));
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await screen.findByRole("heading", { name: "Review found locations" });
        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await screen.findByRole("checkbox", { name: "Select Portable guidance" });
        fireEvent.click(screen.getByRole("button", { name: "Import selected Assets" }));
        fireEvent.click(await screen.findByRole("button", { name: "Open Asset" }));
        await vi.waitFor(() => expect(getAsset).toHaveBeenCalledWith({ assetId }));
        expect(completeOnboarding).not.toHaveBeenCalled();
        expect(screen.getByRole("heading", { name: "Import results" })).toBeTruthy();
        await act(async () =>
            finishLookup?.(
                failure === "failed"
                    ? { status: "failed", diagnostics: [] }
                    : { status: "complete", value: { found: false }, diagnostics: [] },
            ),
        );
        expect(
            await screen.findByText("The Asset was saved, but could not be opened. Try again or find it in the library."),
        ).toBeTruthy();
        expect(completeOnboarding).not.toHaveBeenCalled();
        expect(screen.queryByText("OAAM could not save onboarding completion. Nothing was deployed.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Open Asset" }));
        await vi.waitFor(() => expect(completeOnboarding).toHaveBeenCalledOnce());
        await act(async () => vi.dynamicImportSettled());
        await vi.waitFor(() =>
            expect(client.listAssetVersionFileChildren).toHaveBeenCalledWith({
                assetId,
                versionId,
                directoryPath: "",
                pageSize: 50,
            }),
        );
        expect(container.querySelector('main[data-oaam-route="onboarding"]')).toBeNull();
        expect(
            container.querySelector(`.asset-inspector[data-oaam-asset-id="${assetId}"][data-oaam-state="ready"]`),
        ).toBeTruthy();
        expect(base.acceptImportBatch).toHaveBeenCalledOnce();
    });
});
