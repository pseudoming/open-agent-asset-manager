import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectOrphanVersions, readAssetManifest, writeAssetManifest } from "../../../src/catalog/asset-manifest";
import { binaryPayloadStats, resolvePayloadPath, writePayload } from "../../../src/catalog/payload-store";
import {
    buildPromotionGrantAuthority,
    readPromotionGrantAuthority,
    resolvePromotionGrantAuthority,
    revokePromotionGrantAuthority,
    serializePromotionGrant,
} from "../../../src/catalog/promotion-grant-store";
import {
    createVersionDialectRegistry,
    EMPTY_VERSION_DIALECT_REGISTRY,
    projectAppendedAssetManifestAuthority,
    publishAssetVersion,
    publishAssetVersionForTest,
    publishImportedAssetVersionForTest,
    publishImportedInitialAssetVersion,
    publishImportedInitialAssetVersionForTest,
    publishInitialAssetVersion,
    publishInitialAssetVersionForTest,
    publishReverseAcceptedAssetVersionForTest,
    readAssetManifestAuthority,
    readAssetManifestAuthoritySet,
    readVersionAuthority,
    replaceExistingAssetManifestAuthority,
    type VersionAuthorityClosureV1,
} from "../../../src/catalog/version-authority";
import { serializeVersionManifest } from "../../../src/catalog/version-manifest";
import type { AssetKindTypeDataV2 } from "../../../src/contracts/specs";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../../src/foundation/fingerprint";
import {
    makeNativeDialectContract,
    makeRestorationDialectContract,
    nativeDialectFingerprint,
    restorationDialectFingerprint,
} from "../../source-import/fixtures/dialect-contracts";
import { ASSET_ID, makeAsset, makeTextFile, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "./version-v2";

export function makeDialectVersion(): {
    version: VersionAuthorityClosureV1;
    nativeBytes: Uint8Array;
    restorationBytes: Uint8Array;
    nativeContractFingerprint: `sha256:${string}`;
    restorationContractFingerprint: `sha256:${string}`;
} {
    const version = makeVersionClosure();
    const nativeBytes = Buffer.from("native\r\n");
    const restorationBytes = Buffer.from([0, 1, 2]);
    const nativeStats = binaryPayloadStats(nativeBytes);
    const restorationStats = binaryPayloadStats(restorationBytes);
    const nativeContractFingerprint = nativeDialectFingerprint("Guidance", "fixture-native-v1");
    const restorationContractFingerprint = restorationDialectFingerprint("Guidance", "fixture-restoration-v1");
    const nativePreimage = {
        schemaVersion: 1 as const,
        dialectId: "fixture-native-v1",
        dialectContractFingerprint: nativeContractFingerprint,
        canonicalContentFingerprint: version.manifest.versionCanonicalContentFingerprint,
        files: [
            {
                relativePath: "native.md",
                contentKind: "text" as const,
                mediaType: "text/markdown",
                contentHash: nativeStats.contentHash,
                byteSize: nativeStats.byteSize,
                executable: false,
            },
        ],
    };
    version.manifest.nativeRepresentations = [
        {
            ...nativePreimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(nativePreimage),
        },
    ];
    version.manifest.dialectRestorationPayloads = [
        {
            dialectId: "fixture-restoration-v1",
            restorationContractFingerprint,
            contentHash: restorationStats.contentHash,
        },
    ];
    version.manifest.fingerprint = computeVersionFingerprint(
        version.manifest.versionCanonicalContentFingerprint,
        version.manifest.nativeRepresentations,
        version.manifest.dialectRestorationPayloads,
        version.manifest.portableDialectContracts,
    );
    version.nativePayloads = [
        {
            dialectId: "fixture-native-v1",
            files: [{ relativePath: "native.md", bytes: nativeBytes }],
        },
    ];
    version.restorationPayloads = [{ dialectId: "fixture-restoration-v1", bytes: restorationBytes }];
    return {
        version,
        nativeBytes,
        restorationBytes,
        nativeContractFingerprint,
        restorationContractFingerprint,
    };
}

export let root: string;

export let assetsRoot: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-p3-authority-"));
    assetsRoot = path.join(root, "assets");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
