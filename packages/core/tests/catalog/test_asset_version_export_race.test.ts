import { describe, expect, it, vi } from "vitest";

const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

vi.mock("../../src/catalog/asset-manifest", () => ({
    readAssetManifest: vi.fn(() => ({ assetId: ASSET_ID, versionIds: [VERSION_ID] })),
}));

vi.mock("../../src/catalog/version-authority", () => ({
    readVersionAuthority: vi.fn(() => null),
}));

import { exportAssetVersionToFile } from "../../src/orchestration/asset-version-export-service";

describe("Asset Version export action-time authority race", () => {
    it("fails closed when Version authority vanishes after membership was checked", async () => {
        await expect(
            exportAssetVersionToFile(
                "/assets",
                {} as never,
                () => 1,
                () => {
                    throw new Error("must not publish");
                },
                {
                    source: {
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        versionFingerprint: SHA_A,
                        originAuthorityFingerprint: SHA_B,
                    },
                    destinationPath: "/exports/asset.zip",
                    userActionEvidenceId: "user-action",
                },
            ),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: "selected Version authority is unavailable" }],
        });
    });
});
