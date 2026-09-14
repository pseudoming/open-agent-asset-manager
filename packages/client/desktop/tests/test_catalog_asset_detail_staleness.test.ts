import { describe, expect, it, vi } from "vitest";
import { ASSET_DETAIL, ASSET_ID, createController, fakeCatalogClient, VERSION } from "./catalog-deployment-test-support";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise?.(value) };
}

const ASSET_OUTCOME = {
    status: "complete" as const,
    value: { found: true as const, value: ASSET_DETAIL },
    diagnostics: [],
};
const VERSION_OUTCOME = {
    status: "complete" as const,
    value: { found: true as const, value: VERSION },
    diagnostics: [],
};

describe("catalog current-Version detail staleness", () => {
    it("drops late Asset, file-preview and large-text page completions after their exact selection is gone", async () => {
        const staleAsset = deferred<typeof ASSET_OUTCOME>();
        const staleVersion = deferred<typeof VERSION_OUTCOME>();
        const assetFake = fakeCatalogClient({
            getAsset: vi.fn(() => staleAsset.promise),
            getAssetVersion: vi.fn(() => staleVersion.promise),
        });
        const assetController = createController(assetFake.client);
        await assetController.selectAsset(ASSET_ID);
        await assetController.load();
        const pendingAsset = assetController.selectAsset(ASSET_ID);
        await vi.waitFor(() => expect(assetFake.client.getAsset).toHaveBeenCalledTimes(1));
        assetController.dispose();
        staleAsset.resolve(ASSET_OUTCOME);
        staleVersion.resolve(VERSION_OUTCOME);
        await pendingAsset;

        const stalePreview = deferred<{
            readonly status: "complete";
            readonly value: {
                readonly found: true;
                readonly value: {
                    readonly previewKind: "text";
                    readonly file: (typeof VERSION.files)[number];
                    readonly text: string;
                    readonly lineCount: number;
                };
            };
            readonly diagnostics: readonly [];
        }>();
        const previewFake = fakeCatalogClient({ readAssetVersionFilePreview: vi.fn(() => stalePreview.promise) });
        const previewController = createController(previewFake.client);
        await previewController.load();
        const pendingPreview = previewController.selectAsset(ASSET_ID);
        await vi.waitFor(() => expect(previewFake.client.readAssetVersionFilePreview).toHaveBeenCalledTimes(1));
        previewController.clearAssetSelection();
        stalePreview.resolve({
            status: "complete",
            value: {
                found: true,
                value: {
                    previewKind: "text",
                    file: VERSION.files[0],
                    text: "late preview",
                    lineCount: 1,
                },
            },
            diagnostics: [],
        });
        await pendingPreview;

        const largeFile = { ...VERSION.files[0], logicalPath: "large.md", byteLength: 22 };
        const largeVersion = { ...VERSION, files: [largeFile] };
        const largePreview = {
            status: "complete" as const,
            value: {
                found: true as const,
                value: { previewKind: "large_text" as const, file: largeFile, limitReason: "byte_limit" as const },
            },
            diagnostics: [],
        };
        const firstPage = {
            status: "complete" as const,
            value: {
                found: true as const,
                value: {
                    file: largeFile,
                    text: "first page\n",
                    loadedByteStart: 0,
                    loadedByteEnd: 11,
                    totalBytes: 22,
                    firstLine: 1,
                    lastLine: 1,
                    totalLines: 2,
                    hasMore: true as const,
                    nextCursor: "next-page",
                },
            },
            diagnostics: [],
        };
        const finalPage = {
            status: "complete" as const,
            value: {
                found: true as const,
                value: {
                    ...firstPage.value.value,
                    text: "final page\n",
                    loadedByteStart: 11,
                    loadedByteEnd: 22,
                    firstLine: 2,
                    lastLine: 2,
                    hasMore: false as const,
                },
            },
            diagnostics: [],
        };

        const staleNextPage = deferred<typeof finalPage>();
        const nextPageRead = vi
            .fn()
            .mockResolvedValueOnce(firstPage)
            .mockImplementationOnce(() => staleNextPage.promise);
        const nextPageFake = fakeCatalogClient({
            getAssetVersion: vi.fn(async () => ({ ...VERSION_OUTCOME, value: { found: true, value: largeVersion } })),
            readAssetVersionFilePreview: vi.fn(async () => largePreview),
            readAssetVersionTextPage: nextPageRead,
        });
        const nextPageController = createController(nextPageFake.client);
        await nextPageController.load();
        await nextPageController.selectAsset(ASSET_ID);
        const pendingNextPage = nextPageController.loadMoreAssetText();
        await vi.waitFor(() => expect(nextPageRead).toHaveBeenCalledTimes(2));
        nextPageController.clearAssetSelection();
        staleNextPage.resolve(finalPage);
        await pendingNextPage;

        const staleFirstPage = deferred<typeof firstPage>();
        const firstPageRead = vi.fn(() => staleFirstPage.promise);
        const firstPageFake = fakeCatalogClient({
            getAssetVersion: vi.fn(async () => ({ ...VERSION_OUTCOME, value: { found: true, value: largeVersion } })),
            readAssetVersionFilePreview: vi.fn(async () => largePreview),
            readAssetVersionTextPage: firstPageRead,
        });
        const firstPageController = createController(firstPageFake.client);
        await firstPageController.load();
        const pendingFirstPage = firstPageController.selectAsset(ASSET_ID);
        await vi.waitFor(() => expect(firstPageRead).toHaveBeenCalledTimes(1));
        firstPageController.clearAssetSelection();
        staleFirstPage.resolve(firstPage);
        await pendingFirstPage;

        expect(assetController.state).toMatchObject({ assetDetail: { status: "loading" } });
        expect(previewController.state).toMatchObject({ assetDetail: { status: "none" } });
        expect(nextPageController.state).toMatchObject({ assetDetail: { status: "none" } });
        expect(firstPageController.state).toMatchObject({ assetDetail: { status: "none" } });
    });
});
