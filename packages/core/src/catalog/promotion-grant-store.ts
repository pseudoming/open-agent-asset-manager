import * as path from "node:path";
import {
    SafeFilesystemError,
    durableEnsureDirectory,
    durableReplaceFile,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import type { PromotionGrantSubject, PromotionGrantTarget, PromotionGrantV1 } from "../contracts/persistence";
import type { EpochMillis, Sha256Digest, UuidV4 } from "../contracts/primitives";
import { readAssetManifest, resolveAssetRoot } from "./asset-manifest";
import { computePromotionGrantFingerprint, stableStringify } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";

const GRANTS_DIRECTORY = "promotion-grants";

export interface CreatePromotionGrantAuthorityInput {
    assetsRoot: string;
    promotionGrantId: UuidV4;
    subject: PromotionGrantSubject;
    target: PromotionGrantTarget;
    userActionEvidenceId: string;
    updatedAt: EpochMillis;
}

export type BuildPromotionGrantAuthorityInput = Omit<CreatePromotionGrantAuthorityInput, "assetsRoot">;

export interface WritePendingVersionPromotionGrantInput {
    assetsRoot: string;
    assetId: UuidV4;
    pendingVersionId: UuidV4;
    grant: PromotionGrantV1;
}

export type WritePendingImportPromotionGrantInput = WritePendingVersionPromotionGrantInput;

export interface RevokePromotionGrantAuthorityInput {
    assetsRoot: string;
    assetId: UuidV4;
    promotionGrantId: UuidV4;
    expectedRevision: number;
    expectedGrantFingerprint: Sha256Digest;
    userActionEvidenceId: string;
    updatedAt: EpochMillis;
}

export interface ResolvePromotionGrantInput {
    assetsRoot: string;
    assetId: UuidV4;
    versionId: UuidV4;
    target: PromotionGrantTarget;
}

interface PromotionGrantStoreHooks {
    beforeCreateWrite(grantPath: string, grant: PromotionGrantV1): void;
    afterInventory(directory: string): void;
}

const NO_HOOKS: PromotionGrantStoreHooks = {
    beforeCreateWrite: () => undefined,
    afterInventory: () => undefined,
};

/** Caller must hold the owning Asset authority lock for the whole read/CAS/write sequence. */
export function createPromotionGrantAuthority(input: CreatePromotionGrantAuthorityInput): PromotionGrantV1 {
    return createPromotionGrantAuthorityCore(input, NO_HOOKS);
}

/** Test-only race seam; production callers must use createPromotionGrantAuthority under the Asset lock. */
export function createPromotionGrantAuthorityForTest(
    input: CreatePromotionGrantAuthorityInput,
    hooks: Partial<PromotionGrantStoreHooks>,
): PromotionGrantV1 {
    return createPromotionGrantAuthorityCore(input, { ...NO_HOOKS, ...hooks });
}

function createPromotionGrantAuthorityCore(
    input: CreatePromotionGrantAuthorityInput,
    hooks: PromotionGrantStoreHooks,
): PromotionGrantV1 {
    const asset = requireActiveAsset(input.assetsRoot, input.subject.assetId);
    const grant = buildPromotionGrantAuthority(input);

    const grants = listPromotionGrantAuthorities(input.assetsRoot, asset.assetId);
    if (grants.some((item) => item.promotionGrantId === input.promotionGrantId)) {
        throw new Error(`promotion grant already exists: ${input.promotionGrantId}`);
    }
    if (
        grants.some(
            (grant) =>
                grant.grantState === "active" &&
                stableStringify(grant.subject) === stableStringify(input.subject) &&
                stableStringify(grant.target) === stableStringify(input.target),
        )
    ) {
        throw new Error("an active promotion grant already covers this exact subject and target");
    }

    writeNewGrant(input.assetsRoot, asset.assetId, grant, hooks);
    return grant;
}

/** Build immutable grant bytes before a Version's pointer-last publish. */
export function buildPromotionGrantAuthority(input: BuildPromotionGrantAuthorityInput): PromotionGrantV1 {
    requireUuid(input.promotionGrantId, "promotionGrantId");
    requireEvidence(input.userActionEvidenceId);
    requireEpoch(input.updatedAt, "updatedAt");
    validateSubject(input.subject);
    validatePromotionGrantTarget(input.target);
    const preimage: Omit<PromotionGrantV1, "grantFingerprint"> = {
        schemaVersion: 1,
        promotionGrantId: input.promotionGrantId,
        subject: input.subject,
        target: input.target,
        grantState: "active",
        revision: 1,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.updatedAt,
    };
    const grant: PromotionGrantV1 = {
        ...preimage,
        grantFingerprint: computePromotionGrantFingerprint(preimage),
    };
    return grant;
}

/**
 * Publish a grant before its pending Version becomes an Asset member.
 * Until asset.json includes pendingVersionId the otherwise-active grant is
 * deliberately ineffective. Caller holds the owning Asset authority lock.
 */
export function writePendingVersionPromotionGrantAuthority(input: WritePendingVersionPromotionGrantInput): void {
    const asset = requireActiveAsset(input.assetsRoot, input.assetId);
    requireUuid(input.pendingVersionId, "pendingVersionId");
    if (asset.versionIds.includes(input.pendingVersionId)) {
        throw new Error("pending Version is already an Asset member");
    }
    validatePromotionGrantForPendingVersion(input.grant, input.assetId, input.pendingVersionId);
    const grants = listPromotionGrantAuthorities(input.assetsRoot, input.assetId);
    if (grants.some((item) => item.promotionGrantId === input.grant.promotionGrantId)) {
        throw new Error(`promotion grant already exists: ${input.grant.promotionGrantId}`);
    }
    if (
        grants.some(
            (item) =>
                item.grantState === "active" &&
                stableStringify(item.subject) === stableStringify(input.grant.subject) &&
                stableStringify(item.target) === stableStringify(input.grant.target),
        )
    ) {
        throw new Error("an active promotion grant already covers this exact subject and target");
    }
    writeNewGrant(input.assetsRoot, input.assetId, input.grant, NO_HOOKS);
}

/** Compatibility name for the import workflow; authority semantics are shared with reverse accept. */
export function writePendingImportPromotionGrantAuthority(input: WritePendingImportPromotionGrantInput): void {
    writePendingVersionPromotionGrantAuthority(input);
}

export function validatePromotionGrantForPendingVersion(
    grant: PromotionGrantV1,
    assetId: UuidV4,
    pendingVersionId: UuidV4,
): void {
    validatePromotionGrant(grant);
    if (grant.grantState !== "active" || grant.revision !== 1) {
        throw new Error("pending Version promotion grant must be a new active authority");
    }
    if (grant.subject.assetId !== assetId) {
        throw new Error("pending Version promotion grant belongs to another Asset");
    }
    const anchor = grant.subject.subjectKind === "asset_version" ? grant.subject.versionId : grant.subject.activationVersionId;
    if (anchor !== pendingVersionId) {
        throw new Error("promotion grant must be anchored by the pending Version");
    }
}

/** Compatibility name retained for existing import callers. */
export function validateImportPromotionGrantForPendingVersion(
    grant: PromotionGrantV1,
    assetId: UuidV4,
    pendingVersionId: UuidV4,
): void {
    validatePromotionGrantForPendingVersion(grant, assetId, pendingVersionId);
}

/** Caller must hold the owning Asset authority lock for the whole read/CAS/write sequence. */
export function revokePromotionGrantAuthority(input: RevokePromotionGrantAuthorityInput): PromotionGrantV1 {
    requireActiveAsset(input.assetsRoot, input.assetId);
    requireUuid(input.promotionGrantId, "promotionGrantId");
    requireEvidence(input.userActionEvidenceId);
    requireEpoch(input.updatedAt, "updatedAt");
    const current = readPromotionGrantAuthority(input.assetsRoot, input.assetId, input.promotionGrantId);
    if (current === null) throw new Error(`promotion grant not found: ${input.promotionGrantId}`);
    if (current.revision !== input.expectedRevision || current.grantFingerprint !== input.expectedGrantFingerprint) {
        throw new Error("promotion grant CAS mismatch");
    }
    if (current.grantState !== "active") throw new Error("promotion grant is already revoked");

    const { grantFingerprint: _currentFingerprint, ...currentPreimage } = current;
    const preimage: Omit<PromotionGrantV1, "grantFingerprint"> = {
        ...currentPreimage,
        grantState: "revoked",
        revision: current.revision + 1,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.updatedAt,
    };
    const next: PromotionGrantV1 = {
        ...preimage,
        grantFingerprint: computePromotionGrantFingerprint(preimage),
    };
    durableReplaceFile(resolveGrantPath(input.assetsRoot, input.assetId, input.promotionGrantId), serializePromotionGrant(next));
    return next;
}

export function listPromotionGrantAuthorities(assetsRoot: string, assetId: UuidV4): PromotionGrantV1[] {
    return listPromotionGrantAuthoritiesCore(assetsRoot, assetId, true, NO_HOOKS);
}

/**
 * Strictly inventory owner-local grants for an Asset that may be soft-deleted.
 * Lifecycle purge uses this only to validate and count the retained owner tree;
 * deleted Assets still cannot resolve or exercise these grants.
 */
export function listRetainedPromotionGrantAuthorities(assetsRoot: string, assetId: UuidV4): PromotionGrantV1[] {
    return listPromotionGrantAuthoritiesCore(assetsRoot, assetId, false, NO_HOOKS);
}

/** Test-only inventory race seam. */
export function listPromotionGrantAuthoritiesForTest(
    assetsRoot: string,
    assetId: UuidV4,
    hooks: Partial<PromotionGrantStoreHooks>,
): PromotionGrantV1[] {
    return listPromotionGrantAuthoritiesCore(assetsRoot, assetId, true, { ...NO_HOOKS, ...hooks });
}

function listPromotionGrantAuthoritiesCore(
    assetsRoot: string,
    assetId: UuidV4,
    requireActive: boolean,
    hooks: PromotionGrantStoreHooks,
): PromotionGrantV1[] {
    if (requireActive) {
        requireActiveAsset(assetsRoot, assetId);
    } else {
        requireRetainedAsset(assetsRoot, assetId);
    }
    const directory = resolveGrantsDirectory(assetsRoot, assetId);
    let entries: ReturnType<typeof inventoryDirectoryNoFollow>["entries"];
    try {
        entries = inventoryDirectoryNoFollow(directory).entries;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
    hooks.afterInventory(directory);
    return entries.map((entry) => {
        if (entry.identity.entryKind !== "file" || !entry.relativeName.endsWith(".json")) {
            throw new Error(`unexpected promotion grant authority entry: ${entry.relativeName}`);
        }
        const grantId = entry.relativeName.slice(0, -".json".length);
        requireUuid(grantId, "promotionGrantId filename");
        const grant = readPromotionGrantAuthority(assetsRoot, assetId, grantId as UuidV4);
        if (grant === null) throw new Error(`promotion grant disappeared during inventory: ${grantId}`);
        return grant;
    });
}

export function readPromotionGrantAuthority(
    assetsRoot: string,
    assetId: UuidV4,
    promotionGrantId: UuidV4,
): PromotionGrantV1 | null {
    requireUuid(assetId, "assetId");
    requireUuid(promotionGrantId, "promotionGrantId");
    const file = resolveGrantPath(assetsRoot, assetId, promotionGrantId);
    try {
        const grant = parsePromotionGrant(Buffer.from(readRegularFileNoFollow(file).bytes).toString("utf-8"));
        if (grant.promotionGrantId !== promotionGrantId || grant.subject.assetId !== assetId) {
            throw new Error("promotion grant identity does not match its enclosing Asset path");
        }
        return grant;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return null;
        throw error;
    }
}

export function resolvePromotionGrantAuthority(input: ResolvePromotionGrantInput): PromotionGrantV1 | null {
    const asset = requireActiveAsset(input.assetsRoot, input.assetId);
    if (!asset.versionIds.includes(input.versionId)) return null;
    validatePromotionGrantTarget(input.target);
    const matches = listPromotionGrantAuthorities(input.assetsRoot, input.assetId).filter(
        (grant) =>
            grant.grantState === "active" &&
            stableStringify(grant.target) === stableStringify(input.target) &&
            isSubjectActive(grant.subject, asset.versionIds, input.versionId),
    );
    const exact = matches.filter((grant) => grant.subject.subjectKind === "asset_version");
    const preferred = exact.length > 0 ? exact : matches;
    if (preferred.length > 1) throw new Error("ambiguous active promotion grant authority");
    return preferred[0] ?? null;
}

export function serializePromotionGrant(grant: PromotionGrantV1): string {
    validatePromotionGrant(grant);
    return `${JSON.stringify(JSON.parse(stableStringify(grant)), null, 2)}\n`;
}

export function parsePromotionGrant(json: string): PromotionGrantV1 {
    const parsed: unknown = JSON.parse(json);
    validatePromotionGrant(parsed);
    return parsed as PromotionGrantV1;
}

function validatePromotionGrant(value: unknown): asserts value is PromotionGrantV1 {
    if (!isStrictObject(value)) throw new Error("promotion grant must be an object");
    requireExactKeys(value, [
        "schemaVersion",
        "promotionGrantId",
        "subject",
        "target",
        "grantState",
        "revision",
        "userActionEvidenceId",
        "updatedAt",
        "grantFingerprint",
    ]);
    if (value.schemaVersion !== 1) throw new Error("promotion grant schemaVersion must be 1");
    requireUuid(value.promotionGrantId, "promotionGrantId");
    validateSubject(value.subject);
    validatePromotionGrantTarget(value.target);
    if (value.grantState !== "active" && value.grantState !== "revoked") {
        throw new Error("promotion grant state must be active|revoked");
    }
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1) {
        throw new Error("promotion grant revision must be a positive integer");
    }
    requireEvidence(value.userActionEvidenceId);
    requireEpoch(value.updatedAt, "updatedAt");
    if (!isSha256Digest(value.grantFingerprint)) throw new Error("invalid promotion grant fingerprint");
    const { grantFingerprint: _stored, ...preimage } = value as unknown as PromotionGrantV1;
    if (computePromotionGrantFingerprint(preimage) !== value.grantFingerprint) {
        throw new Error("promotion grant fingerprint mismatch");
    }
}

function validateSubject(value: unknown): asserts value is PromotionGrantSubject {
    if (!isStrictObject(value)) throw new Error("promotion grant subject must be an object");
    if (value.subjectKind === "asset_version") {
        requireExactKeys(value, ["subjectKind", "assetId", "versionId"]);
        requireUuid(value.assetId, "subject.assetId");
        requireUuid(value.versionId, "subject.versionId");
        return;
    }
    if (value.subjectKind === "asset_all_versions") {
        requireExactKeys(value, ["subjectKind", "assetId", "activationVersionId"]);
        requireUuid(value.assetId, "subject.assetId");
        requireUuid(value.activationVersionId, "subject.activationVersionId");
        return;
    }
    throw new Error("promotion grant subjectKind is invalid");
}

export function validatePromotionGrantTarget(value: unknown): asserts value is PromotionGrantTarget {
    if (!isStrictObject(value)) throw new Error("promotion grant target must be an object");
    if (value.targetKind === "project") {
        requireExactKeys(value, ["targetKind", "projectId"]);
        requireUuid(value.projectId, "target.projectId");
        return;
    }
    if (value.targetKind === "global_target") {
        requireExactKeys(value, ["targetKind", "targetAuthorityFingerprint"]);
        if (!isSha256Digest(value.targetAuthorityFingerprint)) {
            throw new Error("targetAuthorityFingerprint must be a SHA-256 digest");
        }
        return;
    }
    throw new Error("promotion grant targetKind is invalid");
}

function isSubjectActive(subject: PromotionGrantSubject, versionIds: readonly string[], versionId: UuidV4): boolean {
    if (subject.subjectKind === "asset_version") {
        return subject.versionId === versionId && versionIds.includes(subject.versionId);
    }
    return versionIds.includes(subject.activationVersionId);
}

function writeNewGrant(assetsRoot: string, assetId: UuidV4, grant: PromotionGrantV1, hooks: PromotionGrantStoreHooks): void {
    const assetRoot = resolveAssetRoot(assetsRoot, assetId);
    durableEnsureDirectory(assetRoot, GRANTS_DIRECTORY);
    const destination = resolveGrantPath(assetsRoot, assetId, grant.promotionGrantId);
    hooks.beforeCreateWrite(destination, grant);
    if (readPromotionGrantAuthority(assetsRoot, assetId, grant.promotionGrantId) !== null) {
        throw new Error(`promotion grant already exists: ${grant.promotionGrantId}`);
    }
    durableReplaceFile(destination, serializePromotionGrant(grant));
}

function requireActiveAsset(assetsRoot: string, assetId: UuidV4) {
    requireUuid(assetId, "assetId");
    const asset = readAssetManifest(assetsRoot, assetId);
    if (asset === null || asset.deleted) throw new Error("active Asset not found");
    return asset;
}

function requireRetainedAsset(assetsRoot: string, assetId: UuidV4) {
    const asset = readAssetManifest(assetsRoot, assetId);
    if (asset === null) throw new Error("Asset not found");
    return asset;
}

function resolveGrantsDirectory(assetsRoot: string, assetId: UuidV4): string {
    return path.join(resolveAssetRoot(assetsRoot, assetId), GRANTS_DIRECTORY);
}

function resolveGrantPath(assetsRoot: string, assetId: UuidV4, promotionGrantId: UuidV4): string {
    return path.join(resolveGrantsDirectory(assetsRoot, assetId), `${promotionGrantId}.json`);
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    if (!hasExactKeys(value, allowed)) {
        throw new Error("authority object has missing or undeclared fields");
    }
}

function requireUuid(value: unknown, label: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${label} must be a UUID v4`);
}

function requireEvidence(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("userActionEvidenceId must be non-blank");
    }
}

function requireEpoch(value: unknown, label: string): asserts value is EpochMillis {
    if (!isNonNegativeInteger(value)) throw new Error(`${label} must be a non-negative epoch-ms integer`);
}
