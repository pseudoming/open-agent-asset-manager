import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localizedText } from "../src/presentation/localization";
import { AssetCollection } from "../src/renderer/features/project-library/AssetCollection";
import type { AssetBrowserCollectionState } from "../src/renderer/features/project-library/asset-browser-controller";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { clickSemanticAction } from "./semantic-action-test-harness";

const ASSET_ID = "11111111-1111-4111-8111-111111111111";

function collection(
    guidance:
        | { readonly status: "collapsed"; readonly kind: "Guidance"; readonly totalCount: number }
        | { readonly status: "loading"; readonly kind: "Guidance"; readonly totalCount: number }
        | {
              readonly status: "failed";
              readonly kind: "Guidance";
              readonly totalCount: number;
              readonly message: ReturnType<typeof localizedText>;
              readonly diagnostics: readonly [];
          }
        | {
              readonly status: "ready";
              readonly kind: "Guidance";
              readonly totalCount: number;
              readonly assets: readonly [
                  {
                      readonly assetId: string;
                      readonly kind: "Guidance";
                      readonly scope: "global";
                      readonly scopePath: string;
                      readonly displayName: string;
                      readonly displayDescription: string;
                      readonly deleted: boolean;
                      readonly currentVersionId: string;
                      readonly currentRevision: number;
                      readonly currentVersionStatus: "incomplete";
                      readonly updatedAt: number;
                  },
              ];
              readonly hasMore: boolean;
          },
): AssetBrowserCollectionState {
    return {
        collectionId: "global",
        subject: { scope: "global" },
        kinds: [guidance],
        totalCount: guidance.totalCount,
    };
}

afterEach(cleanup);

describe("AssetCollection", () => {
    it("shows non-empty parent groups directly while keeping retry, selection and pagination explicit", () => {
        const onLoadKind = vi.fn();
        const onSelectAsset = vi.fn();
        const view = renderWithPresentation(
            createElement(AssetCollection, {
                collection: collection({
                    status: "failed",
                    kind: "Guidance",
                    totalCount: 1,
                    message: localizedText("library.load_failed"),
                    diagnostics: [],
                }),
                layout: "list",
                selectedAssetId: undefined,
                onLoadKind,
                onSelectAsset,
            }),
        );

        expect(screen.getByRole("heading", { name: "Guidance" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "Guidance" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(onLoadKind).toHaveBeenCalledWith("global", "Guidance");

        view.rerender(
            createElement(AssetCollection, {
                collection: collection({
                    status: "ready",
                    kind: "Guidance",
                    totalCount: 2,
                    assets: [
                        {
                            assetId: ASSET_ID,
                            kind: "Guidance",
                            scope: "global",
                            scopePath: "",
                            displayName: "Global Guidance",
                            displayDescription: "",
                            deleted: false,
                            currentVersionId: "22222222-2222-4222-8222-222222222222",
                            currentRevision: 1,
                            currentVersionStatus: "incomplete",
                            updatedAt: 2,
                        },
                    ],
                    hasMore: true,
                }),
                layout: "cards",
                selectedAssetId: ASSET_ID,
                onLoadKind,
                onSelectAsset,
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: /Global Guidance/u }));
        expect(onSelectAsset).toHaveBeenCalledWith(ASSET_ID);
        fireEvent.click(screen.getByRole("button", { name: /Show 1 more Guidance/u }));
        expect(onLoadKind).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("button", { name: /Global Guidance/u })).toBeDefined();
    });

    it("loads a visible parent group and requests it again when refreshed state returns to collapsed", () => {
        const onLoadKind = vi.fn();
        const props = {
            layout: "list" as const,
            selectedAssetId: undefined,
            onLoadKind,
            onSelectAsset: vi.fn(),
        };
        const view = renderWithPresentation(
            createElement(AssetCollection, {
                ...props,
                collection: collection({ status: "collapsed", kind: "Guidance", totalCount: 1 }),
            }),
        );
        expect(onLoadKind).toHaveBeenCalledOnce();

        view.rerender(
            createElement(AssetCollection, {
                ...props,
                collection: collection({ status: "loading", kind: "Guidance", totalCount: 1 }),
            }),
        );
        expect(onLoadKind).toHaveBeenCalledOnce();

        view.rerender(
            createElement(AssetCollection, {
                ...props,
                collection: collection({ status: "collapsed", kind: "Guidance", totalCount: 1 }),
            }),
        );
        expect(onLoadKind).toHaveBeenCalledTimes(2);
    });

    it("keeps the selected kind as one grouped-list heading with an accessible Guidance explanation", () => {
        const onOpenAssetAction = vi.fn();
        const onAddAssetToTool = vi.fn();
        const { container } = renderWithPresentation(
            createElement(AssetCollection, {
                collection: collection({
                    status: "ready",
                    kind: "Guidance",
                    totalCount: 1,
                    assets: [
                        {
                            assetId: ASSET_ID,
                            kind: "Guidance",
                            scope: "global",
                            scopePath: "",
                            displayName: "Global Guidance",
                            displayDescription: "",
                            deleted: false,
                            currentVersionId: "22222222-2222-4222-8222-222222222222",
                            currentRevision: 1,
                            currentVersionStatus: "incomplete",
                            updatedAt: 2,
                        },
                    ],
                    hasMore: false,
                }),
                selectedKind: "Guidance",
                layout: "list",
                selectedAssetId: undefined,
                showTargetSupport: true,
                targetSupport: {
                    status: "ready",
                    byKind: new Map([
                        [
                            "Guidance",
                            [
                                {
                                    key: "provider:CLAUDECODE",
                                    displayName: "Claude Code",
                                    agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                },
                                {
                                    key: "provider:CODEX",
                                    displayName: "Codex",
                                    agentRuntimeIds: ["CODEX_CLI"],
                                },
                                {
                                    key: "provider:ANTIGRAVITY",
                                    displayName: "Antigravity",
                                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                                },
                                {
                                    key: "provider:CURSOR",
                                    displayName: "Cursor",
                                    agentRuntimeIds: ["CURSOR_AGENT_CLI"],
                                },
                            ],
                        ],
                    ]),
                },
                onLoadKind: vi.fn(),
                onSelectAsset: vi.fn(),
                onOpenAssetAction,
                onAddAssetToTool,
            }),
        );

        expect(container.querySelector(".asset-collection")?.getAttribute("aria-label")).not.toBe("Guidance");
        expect(screen.getByRole("region", { name: "Guidance" })).toBeDefined();
        expect(screen.getByRole("heading", { name: "Guidance" })).toBeDefined();
        const guidanceTitle = container.querySelector(".asset-kind-title-label");
        expect(guidanceTitle?.getAttribute("title")).toBe(
            "Instructions that tell AI how to work in a Project. Common files include AGENTS.md and CLAUDE.md.",
        );
        expect(guidanceTitle?.tagName).toBe("SPAN");
        expect(container.querySelectorAll(".asset-kind-group")).toHaveLength(1);
        const assetItem = container.querySelector(".asset-library-item");
        expect(assetItem?.tagName).toBe("DIV");
        expect(assetItem?.getAttribute("data-oaam-revision")).toBe("1");
        expect(assetItem?.querySelector('[data-oaam-action="inspect-asset"]')).toBeInstanceOf(HTMLButtonElement);
        expect(screen.getByText("Can write to")).toBeDefined();
        expect(screen.getByText("Claude Code").getAttribute("data-oaam-agent-runtime-ids")).toBe("CLAUDE_CODE_CLI");
        expect(screen.queryByText("Cursor")).toBeNull();
        const moreTargets = screen.getByRole("button", { name: "+1" });
        expect(moreTargets.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(moreTargets);
        expect(screen.getByText("Cursor").getAttribute("data-oaam-agent-runtime-ids")).toBe("CURSOR_AGENT_CLI");
        expect(screen.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByRole("button", { name: /Global Guidance/u })).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "Choose where to use" }));
        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        expect(onAddAssetToTool).toHaveBeenCalledWith(ASSET_ID);
        expect(onOpenAssetAction).toHaveBeenNthCalledWith(1, ASSET_ID, "metadata");
        expect(onOpenAssetAction).toHaveBeenNthCalledWith(2, ASSET_ID, "copy");
    });

    it("keeps an unavailable provider projection distinct from a verified-empty target set", () => {
        renderWithPresentation(
            createElement(AssetCollection, {
                collection: collection({
                    status: "ready",
                    kind: "Guidance",
                    totalCount: 1,
                    assets: [
                        {
                            assetId: ASSET_ID,
                            kind: "Guidance",
                            scope: "global",
                            scopePath: "",
                            displayName: "Global Guidance",
                            displayDescription: "",
                            deleted: false,
                            currentVersionId: "22222222-2222-4222-8222-222222222222",
                            currentRevision: 1,
                            currentVersionStatus: "incomplete",
                            updatedAt: 2,
                        },
                    ],
                    hasMore: false,
                }),
                layout: "list",
                selectedAssetId: undefined,
                showTargetSupport: true,
                targetSupport: { status: "unavailable" },
                onLoadKind: vi.fn(),
                onSelectAsset: vi.fn(),
            }),
        );

        expect(screen.getByText("Cannot check write support right now")).toBeDefined();
        expect(screen.queryByText("Cannot currently write to AI tools")).toBeNull();
    });

    it("starts guided import directly from a truly empty subject", async () => {
        const onOpenGuidedImport = vi.fn();
        renderWithPresentation(
            createElement(AssetCollection, {
                collection: collection({ status: "collapsed", kind: "Guidance", totalCount: 0 }),
                layout: "list",
                selectedAssetId: undefined,
                onOpenGuidedImport,
                onLoadKind: vi.fn(),
                onSelectAsset: vi.fn(),
            }),
        );

        await clickSemanticAction("library.guided_import.empty_kind", "library.start_guided_import", {
            expected: onOpenGuidedImport,
            expectedArgs: [],
            unrelated: [],
        });
    });
});
