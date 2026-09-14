import * as path from "node:path";
import {
    type SafeFilesystemError,
    durableEnsureDirectory,
    durableReplaceFile,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import type { AssetVersionFileContentV2, AssetVersionManifestV2 } from "../contracts/asset-version";
import type {
    PromotionGrantV1,
    VersionDialectRestorationPayloadRefV1,
    VersionNativeRepresentation,
    VersionNativeRepresentationV1,
} from "../contracts/persistence";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { AssetManifestV1 } from "../types";
import {
    appendVersionId,
    readAssetManifest,
    resolveAssetRoot,
    serializeAssetManifest,
    writeAssetManifest,
} from "./asset-manifest";
import { stableStringify } from "../foundation/fingerprint";
import { bytesForPayload, readPayload, writePayload, writePayloadBytes } from "./payload-store";
import {
    parsePromotionGrant,
    readPromotionGrantAuthority,
    serializePromotionGrant,
    validatePromotionGrantForPendingVersion,
    writePendingVersionPromotionGrantAuthority,
} from "./promotion-grant-store";
import { type AssetSpecVersionNode, getAssetSpecHandler, validateAssetSpecVersionGraph } from "../specs/registry";
import { commitNewAsset, commitNewVersion, createStagingDir, createStagingVersionDir } from "./staging-commit";
import { parseVersionManifest, serializeVersionManifest, validateVersionManifest } from "./version-manifest";
import { isUuidV4 } from "../foundation/validators";
import type { NativeDialectPayloadFileV1 } from "../contracts/dialect";
import type { VersionDialectRegistryV1 } from "./version-dialect-registry";
import { assertPortableDialectContractRefs } from "./portable-dialect-authority";
import { highestAssetRevision, requireValidAssetManifest } from "./asset-manifest-authority";

export {
    EMPTY_VERSION_DIALECT_REGISTRY,
    createVersionDialectRegistry,
    type NativeDialectContractV1,
    type RestorationDialectContractV1,
    type VersionDialectRegistryV1,
} from "./version-dialect-registry";
export {
    projectAppendedAssetManifestAuthority,
    readAssetManifestAuthority,
    readAssetManifestAuthoritySet,
    replaceExistingAssetManifestAuthority,
    type AssetManifestAuthorityViewV1,
} from "./asset-manifest-authority";

export interface NativePayloadFileV1 extends NativeDialectPayloadFileV1 {}

export interface NativePayloadClosureV1 {
    dialectId: string;
    files: NativePayloadFileV1[];
}

export interface RestorationPayloadClosureV1 {
    dialectId: string;
    bytes: Uint8Array;
}

export interface VersionAuthorityClosureV1 {
    manifest: AssetVersionManifestV2;
    files: AssetVersionFileContentV2[];
    nativePayloads: NativePayloadClosureV1[];
    restorationPayloads: RestorationPayloadClosureV1[];
}

export interface PublishInitialAssetVersionInputV1 {
    assetsRoot: string;
    transactionId: string;
    asset: AssetManifestV1;
    version: VersionAuthorityClosureV1;
    dialectRegistry: VersionDialectRegistryV1;
}

export interface PublishAssetVersionInputV1 {
    assetsRoot: string;
    transactionId: string;
    version: VersionAuthorityClosureV1;
    dialectRegistry: VersionDialectRegistryV1;
}

export type ImportPromotionPublishV1 =
    | { promotionAction: "import_only" }
    | { promotionAction: "publish_grant"; grant: PromotionGrantV1 };

export interface PublishImportedInitialAssetVersionInputV1 extends PublishInitialAssetVersionInputV1 {
    promotion: ImportPromotionPublishV1;
}

export interface PublishImportedAssetVersionInputV1 extends PublishAssetVersionInputV1 {
    promotion: ImportPromotionPublishV1;
}

export interface PublishReverseAcceptedAssetVersionInputV1 extends PublishAssetVersionInputV1 {
    promotion: ImportPromotionPublishV1;
}

interface PublishHooks {
    afterPayloads(): void;
    afterManifest(): void;
    afterGrantWrite(grantPath: string): void;
    afterGrant(): void;
    afterVersionRename(): void;
}

const NO_HOOKS: PublishHooks = Object.freeze({
    afterPayloads: () => undefined,
    afterManifest: () => undefined,
    afterGrantWrite: () => undefined,
    afterGrant: () => undefined,
    afterVersionRename: () => undefined,
});

export function publishInitialAssetVersion(input: PublishInitialAssetVersionInputV1): void {
    publishInitialAssetVersionCore(input, NO_HOOKS);
}

export function publishAssetVersion(input: PublishAssetVersionInputV1): void {
    publishAssetVersionCore(input, NO_HOOKS);
}

export function publishImportedInitialAssetVersion(input: PublishImportedInitialAssetVersionInputV1): void {
    publishInitialAssetVersionCore(input, NO_HOOKS, grantFromPromotion(input.promotion));
}

export function publishImportedAssetVersion(input: PublishImportedAssetVersionInputV1): void {
    publishAssetVersionCore(input, NO_HOOKS, grantFromPromotion(input.promotion));
}

export function publishReverseAcceptedAssetVersion(input: PublishReverseAcceptedAssetVersionInputV1): void {
    publishAssetVersionCore(input, NO_HOOKS, grantFromPromotion(input.promotion));
}

/** Test-only kill-point seam; production code must call publishInitialAssetVersion. */
export function publishInitialAssetVersionForTest(input: PublishInitialAssetVersionInputV1, hooks: Partial<PublishHooks>): void {
    publishInitialAssetVersionCore(input, { ...NO_HOOKS, ...hooks });
}

/** Test-only kill-point seam; production code must call publishAssetVersion. */
export function publishAssetVersionForTest(input: PublishAssetVersionInputV1, hooks: Partial<PublishHooks>): void {
    publishAssetVersionCore(input, { ...NO_HOOKS, ...hooks });
}

/** Test-only kill-point seam for imported initial Version + grant atomicity. */
export function publishImportedInitialAssetVersionForTest(
    input: PublishImportedInitialAssetVersionInputV1,
    hooks: Partial<PublishHooks>,
): void {
    publishInitialAssetVersionCore(input, { ...NO_HOOKS, ...hooks }, grantFromPromotion(input.promotion));
}

/** Test-only race seam for imported later Version + grant pointer commit. */
export function publishImportedAssetVersionForTest(
    input: PublishImportedAssetVersionInputV1,
    hooks: Partial<PublishHooks>,
): void {
    publishAssetVersionCore(input, { ...NO_HOOKS, ...hooks }, grantFromPromotion(input.promotion));
}

/** Test-only kill-point seam for reverse-accept Version/grant/Asset publication. */
export function publishReverseAcceptedAssetVersionForTest(
    input: PublishReverseAcceptedAssetVersionInputV1,
    hooks: Partial<PublishHooks>,
): void {
    publishAssetVersionCore(input, { ...NO_HOOKS, ...hooks }, grantFromPromotion(input.promotion));
}

function publishInitialAssetVersionCore(
    input: PublishInitialAssetVersionInputV1,
    hooks: PublishHooks,
    importGrant?: PromotionGrantV1,
): void {
    const { asset, version } = input;
    requireValidAssetManifest(asset);
    if (readAssetManifest(input.assetsRoot, asset.assetId) !== null) {
        throw new Error(`asset already exists: ${asset.assetId}`);
    }
    if (
        asset.deleted ||
        asset.kind !== version.manifest.kind ||
        version.manifest.assetId !== asset.assetId ||
        version.manifest.revision !== 1 ||
        version.manifest.changeKind !== "create" ||
        asset.versionIds.length !== 1 ||
        asset.versionIds[0] !== version.manifest.versionId
    ) {
        throw new Error("initial Asset/Version authority closure is inconsistent");
    }
    validateClosureAndDependencies(input.assetsRoot, asset, version, input.dialectRegistry);
    const stagingRoot = createStagingDir(input.assetsRoot, input.transactionId);
    const versionRoot = createStagingVersionDir(input.assetsRoot, input.transactionId, version.manifest.versionId);
    writeStagedVersion(versionRoot, version, hooks);
    if (importGrant !== undefined) {
        validatePromotionGrantForPendingVersion(importGrant, asset.assetId, version.manifest.versionId);
        durableEnsureDirectory(stagingRoot, "promotion-grants");
        const grantPath = path.join(stagingRoot, "promotion-grants", `${importGrant.promotionGrantId}.json`);
        durableReplaceFile(grantPath, serializePromotionGrant(importGrant));
        hooks.afterGrantWrite(grantPath);
        const reopened = parsePromotionGrant(Buffer.from(readRegularFileNoFollow(grantPath).bytes).toString("utf-8"));
        if (stableStringify(reopened) !== stableStringify(importGrant)) {
            throw new Error("staged import promotion grant differs after reopen");
        }
        hooks.afterGrant();
    }
    durableReplaceFile(path.join(stagingRoot, "asset.json"), serializeAssetManifest(asset));
    commitNewAsset(input.assetsRoot, input.transactionId, asset.assetId);
}

function publishAssetVersionCore(input: PublishAssetVersionInputV1, hooks: PublishHooks, importGrant?: PromotionGrantV1): void {
    const asset = validatePendingAssetVersionAuthority({
        assetsRoot: input.assetsRoot,
        version: input.version,
        dialectRegistry: input.dialectRegistry,
    });
    const manifest = input.version.manifest;
    createStagingDir(input.assetsRoot, input.transactionId);
    const versionRoot = createStagingVersionDir(input.assetsRoot, input.transactionId, manifest.versionId);
    writeStagedVersion(versionRoot, input.version, hooks);
    if (importGrant !== undefined) {
        writePendingVersionPromotionGrantAuthority({
            assetsRoot: input.assetsRoot,
            assetId: asset.assetId,
            pendingVersionId: manifest.versionId,
            grant: importGrant,
        });
        hooks.afterGrant();
    }
    commitNewVersion(input.assetsRoot, input.transactionId, asset.assetId, manifest.versionId);
    hooks.afterVersionRename();
    const publishedRoot = path.join(resolveAssetRoot(input.assetsRoot, asset.assetId), "versions", manifest.versionId);
    readStagedClosure(publishedRoot, manifest, input.version, false);
    const currentAsset = readAssetManifest(input.assetsRoot, asset.assetId);
    if (currentAsset === null || stableStringify(currentAsset) !== stableStringify(asset)) {
        throw new Error("Asset authority changed before Version pointer commit");
    }
    if (importGrant !== undefined) {
        const reopenedGrant = readPromotionGrantAuthority(input.assetsRoot, asset.assetId, importGrant.promotionGrantId);
        if (stableStringify(reopenedGrant) !== stableStringify(importGrant)) {
            throw new Error("promotion grant changed before Version pointer commit");
        }
    }
    writeAssetManifest(
        input.assetsRoot,
        appendVersionId(asset, manifest.versionId, Math.max(asset.updatedAt, manifest.createdAt)),
    );
}

function grantFromPromotion(promotion: ImportPromotionPublishV1): PromotionGrantV1 | undefined {
    return promotion.promotionAction === "publish_grant" ? promotion.grant : undefined;
}

function writeStagedVersion(versionRoot: string, closure: VersionAuthorityClosureV1, hooks: PublishHooks): void {
    for (const file of closure.files) {
        const content = file.contentKind === "text" ? file.text : file.bytes;
        const stored = writePayload(versionRoot, content, file.contentKind);
        if (stored.contentHash !== file.file.contentHash || stored.byteSize !== file.file.byteSize) {
            throw new Error(`canonical payload descriptor mismatch: ${file.file.logicalPath}`);
        }
    }
    for (const native of closure.nativePayloads) {
        const representation = requireRepresentation(closure.manifest, native.dialectId);
        for (const file of native.files) {
            const descriptor = representation.files.find(
                (candidate) => candidate.relativePath === file.relativePath,
            ) as VersionNativeRepresentationV1["files"][number];
            const stored = writePayloadBytes(versionRoot, file.bytes);
            if (stored.contentHash !== descriptor.contentHash || stored.byteSize !== descriptor.byteSize) {
                throw new Error(`native payload descriptor mismatch: ${native.dialectId}/${file.relativePath}`);
            }
        }
    }
    for (const restoration of closure.restorationPayloads) {
        const descriptor = requireRestoration(closure.manifest, restoration.dialectId);
        if (writePayloadBytes(versionRoot, restoration.bytes).contentHash !== descriptor.contentHash) {
            throw new Error(`restoration payload descriptor mismatch: ${restoration.dialectId}`);
        }
    }
    hooks.afterPayloads();
    durableReplaceFile(path.join(versionRoot, "version.json"), serializeVersionManifest(closure.manifest));
    hooks.afterManifest();
    readStagedClosure(versionRoot, closure.manifest, closure, false);
}

/** No-write validation used before reverse-accept publishes a claimed Version. */
export function validatePendingAssetVersionAuthority(input: {
    assetsRoot: string;
    version: VersionAuthorityClosureV1;
    dialectRegistry: VersionDialectRegistryV1;
}): AssetManifestV1 {
    const asset = readAssetManifest(input.assetsRoot, input.version.manifest.assetId);
    if (asset === null || asset.deleted) throw new Error("active Asset not found");
    const manifest = input.version.manifest;
    if (asset.kind !== manifest.kind || asset.versionIds.includes(manifest.versionId)) {
        throw new Error("pending Version does not belong to the active Asset history");
    }
    if (!asset.versionIds.includes(manifest.sourceVersionId)) {
        throw new Error("sourceVersionId must name an existing Version of the same Asset");
    }
    const expectedRevision = highestAssetRevision(input.assetsRoot, asset) + 1;
    if (manifest.revision !== expectedRevision || manifest.changeKind === "create") {
        throw new Error(`pending Version must use revision ${expectedRevision} and a non-create changeKind`);
    }
    validateClosureAndDependencies(input.assetsRoot, asset, input.version, input.dialectRegistry);
    return asset;
}

export function readVersionAuthority(
    assetsRoot: string,
    assetId: string,
    versionId: string,
    dialectRegistry: VersionDialectRegistryV1,
): VersionAuthorityClosureV1 | null {
    const asset = readAssetManifest(assetsRoot, assetId);
    if (asset === null || !asset.versionIds.includes(versionId)) return null;
    const closure = readRawClosure(assetsRoot, asset, versionId, dialectRegistry);
    validateDependencyGraph(assetsRoot, asset, closure, dialectRegistry);
    return closure;
}

function readRawClosure(
    assetsRoot: string,
    asset: AssetManifestV1,
    versionId: string,
    registry: VersionDialectRegistryV1,
): VersionAuthorityClosureV1 {
    const versionRoot = path.join(resolveAssetRoot(assetsRoot, asset.assetId), "versions", versionId);
    const manifestPath = path.join(versionRoot, "version.json");
    const json = Buffer.from(readRegularFileNoFollow(manifestPath).bytes).toString("utf-8");
    const manifest = parseVersionManifest(json);
    if (manifest.assetId !== asset.assetId || manifest.versionId !== versionId || manifest.kind !== asset.kind) {
        throw new Error("Version manifest identity does not match its enclosing Asset path");
    }
    return readStagedClosure(versionRoot, manifest, null, true, registry);
}

function readStagedClosure(
    versionRoot: string,
    manifest: AssetVersionManifestV2,
    expected: VersionAuthorityClosureV1 | null,
    decode: boolean,
    registry?: VersionDialectRegistryV1,
): VersionAuthorityClosureV1 {
    const files = manifest.files.map((descriptor): AssetVersionFileContentV2 => {
        const bytes = readPayload(versionRoot, descriptor.contentHash, descriptor.byteSize).bytes;
        if (descriptor.contentKind === "binary") return { file: descriptor, contentKind: "binary", bytes };
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!Buffer.from(bytesForPayload(text, "text")).equals(Buffer.from(bytes))) {
            throw new Error(`canonical text payload is not normalized: ${descriptor.logicalPath}`);
        }
        return { file: descriptor, contentKind: "text", text };
    });
    const nativePayloads = manifest.nativeRepresentations.map((representation) => ({
        dialectId: representation.dialectId,
        files: representation.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: readPayload(versionRoot, file.contentHash, file.byteSize).bytes,
        })),
    }));
    const restorationPayloads = manifest.dialectRestorationPayloads.map((payload) => ({
        dialectId: payload.dialectId,
        bytes: readPayload(versionRoot, payload.contentHash).bytes,
    }));
    const closure = { manifest, files, nativePayloads, restorationPayloads };
    if (expected !== null && stableStringify(closure) !== stableStringify(expected)) {
        throw new Error("reopened Version closure differs from staged input");
    }
    if (decode && registry !== undefined) validateDialectContracts(closure, registry);
    return closure;
}

function validateClosureAndDependencies(
    assetsRoot: string,
    asset: AssetManifestV1,
    closure: VersionAuthorityClosureV1,
    registry: VersionDialectRegistryV1,
): void {
    validateVersionMaterialClosure(closure, registry);
    validateDependencyGraph(assetsRoot, asset, closure, registry);
}

/**
 * Validate one self-contained Version material closure without requiring the
 * referenced Asset graph to be present. Portable single-Version archives use
 * this boundary; dependency binding is re-evaluated by the normal import flow.
 */
export function validateVersionMaterialClosure(closure: VersionAuthorityClosureV1, registry: VersionDialectRegistryV1): void {
    const manifestResult = validateVersionManifest(closure.manifest);
    if (!manifestResult.ok) throw new Error(manifestResult.diagnostics.map((item) => item.message).join("; "));
    if (stableStringify(closure.manifest.files) !== stableStringify(closure.files.map((item) => item.file))) {
        throw new Error("canonical payload closure does not exactly match manifest.files");
    }
    assertDialectClosureMatchesManifest(closure);
    validateDialectContracts(closure, registry);
}

function validateDialectContracts(closure: VersionAuthorityClosureV1, registry: VersionDialectRegistryV1): void {
    const canonical = {
        kind: closure.manifest.kind,
        typeData: closure.manifest.typeData,
    } as AssetKindTypeDataV2;
    assertPortableDialectContractRefs({
        canonical,
        canonicalFiles: closure.files,
        versionStatus: closure.manifest.status,
        storedRefs: closure.manifest.portableDialectContracts,
        registry,
    });
    for (const native of closure.nativePayloads) {
        const representation = requireRepresentation(closure.manifest, native.dialectId);
        const contract = registry.getNative(closure.manifest.kind, native.dialectId);
        if (
            contract === null ||
            contract.contractFingerprint !== representation.dialectContractFingerprint ||
            !contract.validateSameContent({
                canonical,
                canonicalFiles: closure.files,
                representation,
                nativeFiles: native.files,
            })
        ) {
            throw new Error(`native dialect contract rejected: ${native.dialectId}`);
        }
    }
    for (const restoration of closure.restorationPayloads) {
        const descriptor = requireRestoration(closure.manifest, restoration.dialectId);
        const contract = registry.getRestoration(closure.manifest.kind, restoration.dialectId);
        if (
            contract === null ||
            contract.contractFingerprint !== descriptor.restorationContractFingerprint ||
            !contract.validatePayload(restoration.bytes)
        ) {
            throw new Error(`restoration dialect contract rejected: ${restoration.dialectId}`);
        }
    }
}

function assertDialectClosureMatchesManifest(closure: VersionAuthorityClosureV1): void {
    if (
        stableStringify(closure.nativePayloads.map((item) => item.dialectId)) !==
            stableStringify(closure.manifest.nativeRepresentations.map((item) => item.dialectId)) ||
        stableStringify(closure.restorationPayloads.map((item) => item.dialectId)) !==
            stableStringify(closure.manifest.dialectRestorationPayloads.map((item) => item.dialectId))
    ) {
        throw new Error("dialect payload closure does not match manifest membership");
    }
    for (const native of closure.nativePayloads) {
        const representation = requireRepresentation(closure.manifest, native.dialectId);
        if (
            stableStringify(native.files.map((file) => file.relativePath)) !==
            stableStringify(representation.files.map((file) => file.relativePath))
        ) {
            throw new Error(`native payload paths do not match manifest: ${native.dialectId}`);
        }
    }
}

function validateDependencyGraph(
    assetsRoot: string,
    asset: AssetManifestV1,
    closure: VersionAuthorityClosureV1,
    registry: VersionDialectRegistryV1,
): void {
    const nodes = collectDependencyNodes(assetsRoot, asset, closure, registry);
    const result = validateAssetSpecVersionGraph(nodes);
    if (!result.valid) {
        throw new Error(result.issues.map((issue) => `${issue.code}:${issue.path}`).join("; "));
    }
}

function collectDependencyNodes(
    assetsRoot: string,
    asset: AssetManifestV1,
    root: VersionAuthorityClosureV1,
    registry: VersionDialectRegistryV1,
): AssetSpecVersionNode[] {
    const nodes: AssetSpecVersionNode[] = [];
    const pending: Array<{ asset: AssetManifestV1; closure: VersionAuthorityClosureV1 }> = [{ asset, closure: root }];
    const seen = new Set<string>();
    while (pending.length > 0) {
        const current = pending.pop() as {
            asset: AssetManifestV1;
            closure: VersionAuthorityClosureV1;
        };
        if (seen.has(current.closure.manifest.versionId)) continue;
        seen.add(current.closure.manifest.versionId);
        const node = toSpecNode(current.asset, current.closure);
        nodes.push(node);
        if (node.status !== "complete") continue;
        const canonical = node.canonical as AssetKindTypeDataV2;
        const handler = getAssetSpecHandler(canonical.kind);
        const targetIds = new Set(
            handler.collectDependencies(canonical, node.files).map((requirement) => requirement.targetAssetVersionId),
        );
        for (const file of node.files) {
            for (const reference of file.file.references) {
                if (reference.resolution === "resolved_asset_version") {
                    targetIds.add(reference.targetAssetVersionId);
                }
            }
        }
        for (const targetId of targetIds) {
            const targetAsset = findAssetForVersion(assetsRoot, targetId);
            if (targetAsset !== null) {
                pending.push({
                    asset: targetAsset,
                    closure: readRawClosure(assetsRoot, targetAsset, targetId, registry),
                });
            }
        }
    }
    return nodes;
}

function toSpecNode(asset: AssetManifestV1, closure: VersionAuthorityClosureV1): AssetSpecVersionNode {
    return {
        versionId: closure.manifest.versionId,
        scope: asset.scope,
        projectId: asset.projectId,
        scopePath: asset.scopePath,
        status: closure.manifest.status,
        canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData },
        files: closure.files,
    };
}

function findAssetForVersion(assetsRoot: string, versionId: string): AssetManifestV1 | null {
    let found: AssetManifestV1 | null = null;
    let inventory: ReturnType<typeof inventoryDirectoryNoFollow>;
    try {
        inventory = inventoryDirectoryNoFollow(assetsRoot);
    } catch (caught) {
        const error = caught as SafeFilesystemError;
        if (error.failureKind === "not_found") return null;
        throw error;
    }
    for (const entry of inventory.entries) {
        if (entry.identity.entryKind !== "directory" || !isUuidV4(entry.relativeName)) continue;
        const candidate = readAssetManifest(assetsRoot, entry.relativeName);
        if (candidate?.versionIds.includes(versionId)) {
            if (found !== null) throw new Error(`versionId belongs to multiple Assets: ${versionId}`);
            found = candidate;
        }
    }
    return found;
}

function requireRepresentation(manifest: AssetVersionManifestV2, dialectId: string): VersionNativeRepresentation {
    return manifest.nativeRepresentations.find((item) => item.dialectId === dialectId) as VersionNativeRepresentation;
}

function requireRestoration(manifest: AssetVersionManifestV2, dialectId: string): VersionDialectRestorationPayloadRefV1 {
    return manifest.dialectRestorationPayloads.find(
        (item) => item.dialectId === dialectId,
    ) as VersionDialectRestorationPayloadRefV1;
}
