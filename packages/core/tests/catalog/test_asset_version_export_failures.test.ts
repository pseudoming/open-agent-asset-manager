import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAssetManifest } from "../../src/catalog/asset-manifest";
import { EMPTY_VERSION_DIALECT_REGISTRY, publishInitialAssetVersion } from "../../src/catalog/version-authority";
import { exportAssetVersionToFile } from "../../src/orchestration/asset-version-export-service";
import type { ExportAssetVersionToFileInputV1, UuidV4 } from "../../src/types";
import { ASSET_ID, makeAsset, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "./fixtures/version-v2";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

let root = "";
let assetsRoot = "";

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-version-export-failures-"));
    assetsRoot = path.join(root, "assets");
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function validInput(): ExportAssetVersionToFileInputV1 {
    return {
        source: {
            assetId: ASSET_ID as UuidV4,
            versionId: VERSION_ID as UuidV4,
            versionFingerprint: SHA_A,
            originAuthorityFingerprint: SHA_B,
        },
        destinationPath: path.join(root, "export.zip"),
        userActionEvidenceId: "desktop-save-dialog",
    };
}

function invoke(
    input: ExportAssetVersionToFileInputV1,
    durableCreateFile: (filePath: string, data: Uint8Array) => unknown = () => {},
) {
    return exportAssetVersionToFile(assetsRoot, EMPTY_VERSION_DIALECT_REGISTRY, () => 1_000, durableCreateFile, input);
}

describe("Asset Version export failure boundaries", () => {
    it("rejects every malformed identity, authority, destination, and user-action branch", async () => {
        const base = validInput();
        for (const input of [
            { ...base, source: { ...base.source, assetId: "bad" } },
            { ...base, source: { ...base.source, versionId: "bad" } },
            { ...base, source: { ...base.source, versionFingerprint: "bad" } },
            { ...base, source: { ...base.source, originAuthorityFingerprint: "bad" } },
            { ...base, destinationPath: "" },
            { ...base, destinationPath: " export.zip" },
            { ...base, destinationPath: "export\0.zip" },
            { ...base, userActionEvidenceId: "" },
            { ...base, userActionEvidenceId: " user-action" },
            { ...base, userActionEvidenceId: "user\0action" },
        ]) {
            await expect(invoke(input as ExportAssetVersionToFileInputV1)).resolves.toMatchObject({
                status: "failed",
                diagnostics: [{ code: "asset_export.failed", causeKind: "invalid_schema" }],
            });
        }
    });

    it("distinguishes a missing Asset, a foreign Version, and unavailable Version authority", async () => {
        await expect(invoke(validInput())).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("not a member") }],
        });

        fs.mkdirSync(assetsRoot, { recursive: true });
        writeAssetManifest(assetsRoot, makeAsset([VERSION_ID]));
        await expect(
            invoke({
                ...validInput(),
                source: { ...validInput().source, versionId: VERSION_ID_2 as UuidV4 },
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("not a member") }],
        });
        await expect(invoke(validInput())).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("version.json") }],
        });
    });

    it("rejects each stale authority join and redacts non-Error filesystem failures", async () => {
        const version = makeVersionClosure();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "export-authority",
            asset: makeAsset([VERSION_ID]),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const exact: ExportAssetVersionToFileInputV1 = {
            ...validInput(),
            source: {
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                versionFingerprint: version.manifest.fingerprint,
                originAuthorityFingerprint: version.manifest.originAuthority.authorityFingerprint,
            },
        };
        await expect(
            invoke({
                ...exact,
                source: { ...exact.source, versionFingerprint: SHA_A },
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("changed before export") }],
        });
        await expect(
            invoke({
                ...exact,
                source: { ...exact.source, originAuthorityFingerprint: SHA_B },
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("changed before export") }],
        });
        await expect(
            invoke(exact, () => {
                throw "non-error durable create failure";
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: "non-error durable create failure", rawSummary: "non-error durable create failure" }],
        });
    });
});
