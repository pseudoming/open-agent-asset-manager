/** Asset manifest CAS, membership projection, and revision authority. */

import * as path from "node:path";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import type { AssetVersionManifestV2 } from "../contracts/asset-version";
import {
    computeAssetManifestAuthorityFingerprint,
    computeAssetManifestFileFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import type { PreparedAssetManifestAuthority } from "../reverse/reverse-accept-marker";
import type { AssetManifestV1 } from "../types";
import {
    appendVersionId,
    readAssetManifest,
    resolveAssetRoot,
    validateAssetManifest,
    writeAssetManifest,
} from "./asset-manifest";
import { parseVersionManifest } from "./version-manifest";

export interface AssetManifestAuthorityViewV1 {
    manifest: AssetManifestV1;
    authority: PreparedAssetManifestAuthority;
}

export function readAssetManifestAuthority(assetsRoot: string, assetId: string): AssetManifestAuthorityViewV1 | null {
    const manifest = readAssetManifest(assetsRoot, assetId);
    if (manifest === null) return null;
    return {
        manifest,
        authority: projectAssetManifestAuthority(manifest, highestAssetRevision(assetsRoot, manifest)),
    };
}

/**
 * Replace mutable Asset catalog fields while keeping Version membership authority centralized.
 * The caller owns the Asset lock; this function still rechecks the exact expected manifest so an
 * uncooperative filesystem writer cannot turn a display/delete/current-pointer update into a lost
 * update.
 */
export function replaceExistingAssetManifestAuthority(input: {
    assetsRoot: string;
    expected: AssetManifestV1;
    next: AssetManifestV1;
}): void {
    const observed = readAssetManifest(input.assetsRoot, input.expected.assetId);
    if (observed === null || stableStringify(observed) !== stableStringify(input.expected)) {
        throw new Error("Asset authority changed before manifest replacement");
    }
    const immutable = (manifest: AssetManifestV1) => ({
        schemaVersion: manifest.schemaVersion,
        assetId: manifest.assetId,
        kind: manifest.kind,
        scope: manifest.scope,
        projectId: manifest.projectId,
        scopePath: manifest.scopePath,
        createdAt: manifest.createdAt,
    });
    if (stableStringify(immutable(input.next)) !== stableStringify(immutable(input.expected))) {
        throw new Error("Asset manifest replacement changed immutable identity");
    }
    if (stableStringify([...input.next.versionIds].sort()) !== stableStringify([...input.expected.versionIds].sort())) {
        throw new Error("Asset manifest replacement changed Version membership");
    }
    if (input.next.updatedAt < input.expected.updatedAt) {
        throw new Error("Asset manifest replacement moved updatedAt backwards");
    }
    writeAssetManifest(input.assetsRoot, input.next);
}

export function readAssetManifestAuthoritySet(assetsRoot: string, assetIds: readonly string[]): PreparedAssetManifestAuthority[] {
    return [...assetIds].sort().map((assetId) => {
        const view = readAssetManifestAuthority(assetsRoot, assetId);
        if (view === null) throw new Error(`Asset manifest authority is missing: ${assetId}`);
        return view.authority;
    });
}

export function projectAppendedAssetManifestAuthority(input: {
    assetsRoot: string;
    current: AssetManifestV1;
    stagedVersion: AssetVersionManifestV2;
}): AssetManifestAuthorityViewV1 {
    const currentRevision = highestAssetRevision(input.assetsRoot, input.current);
    if (
        input.stagedVersion.assetId !== input.current.assetId ||
        input.stagedVersion.kind !== input.current.kind ||
        input.stagedVersion.revision !== currentRevision + 1 ||
        input.current.versionIds.includes(input.stagedVersion.versionId)
    ) {
        throw new Error("staged Version does not extend the exact Asset revision authority");
    }
    const manifest = appendVersionId(
        input.current,
        input.stagedVersion.versionId,
        Math.max(input.current.updatedAt, input.stagedVersion.createdAt),
    );
    return {
        manifest,
        authority: projectAssetManifestAuthority(manifest, input.stagedVersion.revision),
    };
}

export function highestAssetRevision(assetsRoot: string, asset: AssetManifestV1): number {
    let highest = 0;
    const revisions = new Set<number>();
    for (const versionId of asset.versionIds) {
        const versionRoot = path.join(resolveAssetRoot(assetsRoot, asset.assetId), "versions", versionId);
        const manifest = parseVersionManifest(
            Buffer.from(readRegularFileNoFollow(path.join(versionRoot, "version.json")).bytes).toString("utf-8"),
        );
        if (manifest.assetId !== asset.assetId || manifest.versionId !== versionId || manifest.kind !== asset.kind) {
            throw new Error("Version history crosses Asset authority");
        }
        if (revisions.has(manifest.revision)) {
            throw new Error(`duplicate revision in Asset history: ${manifest.revision}`);
        }
        revisions.add(manifest.revision);
        highest = Math.max(highest, manifest.revision);
    }
    return highest;
}

export function requireValidAssetManifest(asset: AssetManifestV1): void {
    const result = validateAssetManifest(asset);
    if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("; "));
}

function projectAssetManifestAuthority(
    manifest: AssetManifestV1,
    revisionAllocationBase: number,
): PreparedAssetManifestAuthority {
    requireValidAssetManifest(manifest);
    const currentVersionId = manifest.versionIds.at(-1) as string;
    return {
        assetId: manifest.assetId,
        assetManifestAuthorityFingerprint: computeAssetManifestAuthorityFingerprint({
            assetId: manifest.assetId,
            scope: manifest.scope,
            projectId: manifest.projectId,
            scopePath: manifest.scopePath,
            deleted: manifest.deleted,
            assetManifestFingerprint: computeAssetManifestFileFingerprint(manifest),
            versionIds: manifest.versionIds,
            currentVersionId,
            revisionAllocationBase,
        }),
    };
}
