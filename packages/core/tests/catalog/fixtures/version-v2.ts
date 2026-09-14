import type { AssetVersionFileContentV2, AssetVersionManifestV2, FileReferenceV2 } from "../../../src/contracts/asset-version";
import type { AssetKindTypeDataV2 } from "../../../src/contracts/specs";
import type { AssetManifestV1 } from "../../../src/types";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../../src/foundation/fingerprint";
import { binaryPayloadStats, textPayloadStats } from "../../../src/catalog/payload-store";
import type { VersionAuthorityClosureV1 } from "../../../src/catalog/version-authority";
import type { VersionPortableDialectContractRefV1 } from "../../../src/contracts/persistence";

export const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const VERSION_ID_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const FILE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

export function makeAsset(versionIds: string[] = [VERSION_ID], overrides: Partial<AssetManifestV1> = {}): AssetManifestV1 {
    return {
        schemaVersion: 1,
        assetId: ASSET_ID,
        kind: "Guidance",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName: "Fixture Guidance",
        displayDescription: "P3 authority fixture",
        versionIds,
        deleted: false,
        createdAt: 100,
        updatedAt: 100,
        ...overrides,
    };
}

export function makeTextFile(
    text = "# Guidance\n",
    logicalPath = "AGENTS.md",
    references: FileReferenceV2[] = [],
): AssetVersionFileContentV2 {
    const stats = textPayloadStats(text);
    return {
        contentKind: "text",
        text,
        file: {
            fileId: FILE_ID,
            logicalPath,
            role: "entry",
            contentHash: stats.contentHash,
            contentKind: "text",
            mediaType: "text/markdown",
            byteSize: stats.byteSize,
            executable: false,
            references,
        },
    };
}

export function makeBinaryFile(
    bytes = new Uint8Array([1, 2, 3]),
    logicalPath = "resource.bin",
    references: FileReferenceV2[] = [],
): AssetVersionFileContentV2 {
    const stats = binaryPayloadStats(bytes);
    return {
        contentKind: "binary",
        bytes,
        file: {
            fileId: FILE_ID,
            logicalPath,
            role: "resource",
            contentHash: stats.contentHash,
            contentKind: "binary",
            mediaType: "application/octet-stream",
            byteSize: stats.byteSize,
            executable: false,
            references,
        },
    };
}

export function makeVersionClosure(
    input: {
        assetId?: string;
        versionId?: string;
        revision?: number;
        sourceVersionId?: string;
        changeKind?: AssetVersionManifestV2["changeKind"];
        canonical?: AssetKindTypeDataV2;
        files?: AssetVersionFileContentV2[];
        status?: AssetVersionManifestV2["status"];
        createdAt?: number;
        portableDialectContracts?: VersionPortableDialectContractRefV1[];
    } = {},
): VersionAuthorityClosureV1 {
    const assetId = input.assetId ?? ASSET_ID;
    const versionId = input.versionId ?? VERSION_ID;
    const revision = input.revision ?? 1;
    const sourceVersionId = input.sourceVersionId ?? "";
    const changeKind = input.changeKind ?? "create";
    const canonical = input.canonical ?? { kind: "Guidance", typeData: { schemaVersion: 1 } };
    const files = input.files ?? [makeTextFile()];
    const status = input.status ?? "complete";
    const createdAt = input.createdAt ?? 100;
    const portableDialectContracts = input.portableDialectContracts ?? [];
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    const originWithoutFingerprint = {
        schemaVersion: 1 as const,
        assetId,
        versionId,
        originKind: "user_created" as const,
        userActionEvidenceId: "user-action-fixture",
        promotionRequirement: "not_required" as const,
        createdAt,
    };
    const originAuthority = {
        ...originWithoutFingerprint,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originWithoutFingerprint),
    };
    const manifest = {
        schemaVersion: 2 as const,
        versionId,
        assetId,
        revision,
        fingerprint: computeVersionFingerprint(versionCanonicalContentFingerprint, [], [], portableDialectContracts),
        status,
        diagnostics: [],
        ...canonical,
        files: files.map((file) => file.file),
        changeKind,
        sourceVersionId,
        sourceDeploymentId: "",
        changeNote: "",
        createdAt,
        versionCanonicalContentFingerprint,
        portableDialectContracts,
        nativeRepresentations: [],
        dialectRestorationPayloads: [],
        originAuthority,
    } as AssetVersionManifestV2;
    return { manifest, files, nativePayloads: [], restorationPayloads: [] };
}
