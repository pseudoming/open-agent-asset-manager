/** Core-owned derivation of the complete durable authority that guards a source read. */

import { joinPhysicalAccessPath, physicalAccessPathContains, relatePhysicalAccessPaths } from "@oaam/shared/paths";
import type { Database } from "better-sqlite3";
import { type ActiveJournal, scanActiveJournalReservations } from "../deployment/deployment-journal";
import { fingerprintDomain, stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCanonicalRelativePath, isCanonicalTargetRootPath, isUuidV4 } from "../foundation/validators";
import {
    getDeploymentRenderSnapshot,
    listDeploymentFiles,
    listDeploymentResidualAuthorities,
    listDeployments,
} from "../persistence/state-db";
import {
    parseAppliedRenderSnapshot,
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthorityRow,
} from "../render/deployment-render-authority";
import type { AdapterReadTarget, ManagedTargetReadGuard, Platform, Sha256Digest, SourceRoot, UuidV4 } from "../types";
import type { AdapterReadAuthorityContext } from "./source-contract-validator";

const JOURNAL_RESERVATION_DOMAIN = "oaam.read.journal-reservation.v1";

export class SourceReadAuthorityError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Derive guards only from durable Core authorities. Client input can select roots, but it can
 * neither provide nor remove a managed-target guard or active reservation identity.
 */
export function deriveAdapterReadAuthorityContext(input: {
    db: Database;
    target: AdapterReadTarget;
    transactionsRoot: string;
}): AdapterReadAuthorityContext {
    if (input.transactionsRoot.trim().length === 0) {
        throw new SourceReadAuthorityError("read_authority.transactions_root_missing", "transactionsRoot is required");
    }
    const { platform, platformInstanceId, roots } = selectedRoots(input.target);
    const guards: ManagedTargetReadGuard[] = [];

    for (const deployment of listDeployments(input.db, true)) {
        if (!isUuidV4(deployment.deploymentId)) {
            throw corrupt("deployment id is invalid");
        }
        if (deployment.platform !== platform || deployment.platformInstanceId !== platformInstanceId) continue;
        if (!isCanonicalTargetRootPath(deployment.targetRootPath, platform)) {
            throw corrupt(`deployment target root is invalid: ${deployment.deploymentId}`);
        }
        const deploymentId = deployment.deploymentId as UuidV4;
        const files = listDeploymentFiles(input.db, deployment.deploymentId, true);
        for (const file of files) {
            if (!isCanonicalRelativePath(file.relativePath)) {
                throw corrupt(`deployment file path is invalid: ${deployment.deploymentId}`);
            }
            const baseline = parseDeploymentFileBaselineState(file.baselineState);
            if (baseline.rowState !== "active") continue;
            const state = deployment.deleted === 0 && file.deleted === 0 ? "active_managed" : "residual_managed";
            for (const root of roots) {
                addExactGuard(
                    guards,
                    root,
                    deployment.targetRootPath,
                    file.relativePath,
                    deploymentId,
                    state,
                    baseline.appliedPayload.contentHash,
                    baseline.provenance.outputUnitFingerprint,
                );
                addOutputUnitBoundaries(
                    input.db,
                    guards,
                    root,
                    deployment.targetRootPath,
                    deploymentId,
                    state,
                    baseline.provenance.appliedRenderSnapshotFingerprint,
                    baseline.provenance.outputUnitFingerprint,
                );
            }
        }
        for (const row of listDeploymentResidualAuthorities(input.db, deployment.deploymentId)) {
            const residual = parseDeploymentResidualAuthorityRow({
                residualAuthorityId: row.residualAuthorityId,
                residualAuthorityFingerprint: row.residualAuthorityFingerprint as Sha256Digest,
                deploymentId,
                relativePath: row.relativePath,
                authorityBody: row.authorityBody,
            });
            for (const root of roots) {
                addExactGuard(
                    guards,
                    root,
                    deployment.targetRootPath,
                    residual.relativePath,
                    deploymentId,
                    "residual_managed",
                    residual.appliedPayload.contentHash,
                    residual.previousProvenance.outputUnitFingerprint,
                );
                addOutputUnitBoundaries(
                    input.db,
                    guards,
                    root,
                    deployment.targetRootPath,
                    deploymentId,
                    "residual_managed",
                    residual.previousProvenance.appliedRenderSnapshotFingerprint,
                    residual.previousProvenance.outputUnitFingerprint,
                );
            }
        }
    }

    const journalScan = scanActiveJournalReservations(input.transactionsRoot);
    if (journalScan.corruptTxnIds.length > 0) {
        throw new SourceReadAuthorityError(
            "read_authority.corrupt_journal",
            "a corrupt deployment journal prevents authoritative source selection",
        );
    }
    const reservationIdentityFingerprints: Sha256Digest[] = [];
    for (const journal of journalScan.journals) {
        const reservationIdentityFingerprint = journalReservationFingerprint(journal);
        let intersects = false;
        for (const key of journal.reservedPhysicalKeys) {
            const physical = parsePhysicalKey(key);
            if (physical.platform !== platform) continue;
            for (const root of roots) {
                if (
                    addReservationGuard(
                        guards,
                        root,
                        physical.absolutePath,
                        journal.deploymentId as UuidV4,
                        reservationIdentityFingerprint,
                    )
                ) {
                    intersects = true;
                }
            }
        }
        if (intersects) reservationIdentityFingerprints.push(reservationIdentityFingerprint);
    }

    return {
        managedTargetGuards: uniqueSorted(guards),
        reservationIdentityFingerprints: [...new Set(reservationIdentityFingerprints)].sort(compareUtf8Bytes),
        transactionsRoot: input.transactionsRoot,
    };
}

export function readAuthorityContextsAreExact(left: AdapterReadAuthorityContext, right: AdapterReadAuthorityContext): boolean {
    return stableStringify(left) === stableStringify(right);
}

function selectedRoots(target: AdapterReadTarget): { platform: Platform; platformInstanceId: string; roots: SourceRoot[] } {
    const selector = target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        return validateSelectedRoots({
            platform: selector.platformContext.platform,
            platformInstanceId: selector.platformContext.platformInstanceId,
            accessRootPath: selector.platformContext.accessRootPath,
            roots: [structuredClone(selector.binding.sourceRoot)],
        });
    }
    const byId = new Map(selector.observation.sourceRoots.map((root) => [root.sourceRootId, root]));
    if (new Set(selector.sourceRootIds).size !== selector.sourceRootIds.length) {
        throw new SourceReadAuthorityError("read_authority.selected_root_duplicate", "selected source roots must be unique");
    }
    const roots = selector.sourceRootIds.map((rootId) => {
        const root = byId.get(rootId);
        if (root === undefined) {
            throw new SourceReadAuthorityError(
                "read_authority.selected_root_missing",
                `selected source root is absent: ${rootId}`,
            );
        }
        return structuredClone(root);
    });
    return validateSelectedRoots({
        platform: selector.observation.platformContext.platform,
        platformInstanceId: selector.observation.platformContext.platformInstanceId,
        accessRootPath: selector.observation.platformContext.accessRootPath,
        roots,
    });
}

function validateSelectedRoots(selection: {
    platform: Platform;
    platformInstanceId: string;
    accessRootPath: string;
    roots: SourceRoot[];
}): {
    platform: Platform;
    platformInstanceId: string;
    roots: SourceRoot[];
} {
    for (const root of selection.roots) {
        if (!physicalAccessPathContains(selection.accessRootPath, root.path)) {
            throw new SourceReadAuthorityError(
                "read_authority.selected_root_invalid",
                `selected source root is not canonical within the selected access root: ${root.sourceRootId}`,
            );
        }
    }
    return { platform: selection.platform, platformInstanceId: selection.platformInstanceId, roots: selection.roots };
}

function addExactGuard(
    guards: ManagedTargetReadGuard[],
    root: SourceRoot,
    targetRootPath: string,
    targetRelativePath: string,
    deploymentId: UuidV4,
    managementState: "active_managed" | "residual_managed",
    appliedContentHash: Sha256Digest,
    outputUnitFingerprint: Sha256Digest,
): void {
    const absolute = joinPhysicalAccessPath(targetRootPath, targetRelativePath);
    const relation = relate(root.path, absolute);
    if (relation.kind === "equal" || relation.kind === "authority_contains_root") {
        guards.push({
            sourceRootId: root.sourceRootId,
            matchKind: "entire_root",
            managementState,
            deploymentId,
            outputUnitFingerprint,
        });
    } else if (relation.kind === "root_contains_authority") {
        guards.push({
            sourceRootId: root.sourceRootId,
            relativePath: relation.relativePath,
            matchKind: "exact_file",
            managementState,
            deploymentId,
            appliedContentHash,
        });
    }
}

function addOutputUnitBoundaries(
    db: Database,
    guards: ManagedTargetReadGuard[],
    root: SourceRoot,
    targetRootPath: string,
    deploymentId: UuidV4,
    managementState: "active_managed" | "residual_managed",
    snapshotFingerprint: Sha256Digest,
    outputUnitFingerprint: Sha256Digest,
): void {
    const row = getDeploymentRenderSnapshot(db, deploymentId, snapshotFingerprint);
    if (row === null || row.deleted !== 0) {
        throw corrupt(`referenced render snapshot is unavailable: ${snapshotFingerprint}`);
    }
    const snapshot = parseAppliedRenderSnapshot(row.snapshotJson, snapshotFingerprint);
    if (snapshot.snapshotState !== "applied") {
        throw corrupt("managed file provenance points to a never render snapshot");
    }
    const unit = snapshot.outputUnits.find((candidate) => candidate.outputUnitFingerprint === outputUnitFingerprint);
    if (unit === undefined) {
        throw corrupt("managed file provenance output unit is absent from its render snapshot");
    }
    for (const boundary of unit.managedDirectoryBoundaries) {
        const absolute = joinPhysicalAccessPath(targetRootPath, boundary.relativePath);
        const relation = relate(root.path, absolute);
        if (relation.kind === "equal" || relation.kind === "authority_contains_root") {
            guards.push({
                sourceRootId: root.sourceRootId,
                matchKind: "entire_root",
                managementState,
                deploymentId,
                outputUnitFingerprint,
            });
        } else if (relation.kind === "root_contains_authority") {
            guards.push({
                sourceRootId: root.sourceRootId,
                relativePath: relation.relativePath,
                matchKind: "directory_prefix",
                managementState,
                deploymentId,
                outputUnitFingerprint,
            });
        }
    }
}

function addReservationGuard(
    guards: ManagedTargetReadGuard[],
    root: SourceRoot,
    reservedAbsolutePath: string,
    deploymentId: UuidV4,
    reservationIdentityFingerprint: Sha256Digest,
): boolean {
    const relation = relate(root.path, reservedAbsolutePath);
    if (relation.kind === "disjoint") return false;
    if (relation.kind === "equal" || relation.kind === "authority_contains_root") {
        guards.push({
            sourceRootId: root.sourceRootId,
            matchKind: "entire_root",
            managementState: "in_flight_managed",
            deploymentId,
            reservationIdentityFingerprint,
        });
    } else {
        guards.push({
            sourceRootId: root.sourceRootId,
            relativePath: relation.relativePath,
            matchKind: "directory_prefix",
            managementState: "in_flight_managed",
            deploymentId,
            reservationIdentityFingerprint,
        });
    }
    return true;
}

function journalReservationFingerprint(journal: ActiveJournal): Sha256Digest {
    return fingerprintDomain(JOURNAL_RESERVATION_DOMAIN, journal);
}

function parsePhysicalKey(key: string): { platform: Platform; absolutePath: string } {
    const separator = key.indexOf("\0");
    const platform = key.slice(0, separator);
    const absolutePath = key.slice(separator + 1);
    if (
        separator < 1 ||
        (platform !== "win32" && platform !== "darwin" && platform !== "linux" && platform !== "wsl") ||
        !isCanonicalTargetRootPath(absolutePath, platform)
    ) {
        throw corrupt("journal physical reservation key is invalid");
    }
    return { platform, absolutePath };
}

type PathRelation =
    | { kind: "equal" }
    | { kind: "root_contains_authority"; relativePath: string }
    | { kind: "authority_contains_root" }
    | { kind: "disjoint" };

function relate(rootPath: string, authorityPath: string): PathRelation {
    const relation = relatePhysicalAccessPaths(rootPath, authorityPath);
    if (relation.kind === "root_contains_candidate") {
        return { kind: "root_contains_authority", relativePath: relation.relativePath };
    }
    if (relation.kind === "candidate_contains_root") return { kind: "authority_contains_root" };
    return relation;
}

function uniqueSorted(guards: ManagedTargetReadGuard[]): ManagedTargetReadGuard[] {
    const byKey = new Map(guards.map((guard) => [stableStringify(guard), guard]));
    return [...byKey.entries()].sort(([left], [right]) => compareUtf8Bytes(left, right)).map(([, guard]) => guard);
}

function corrupt(message: string): SourceReadAuthorityError {
    return new SourceReadAuthorityError("read_authority.durable_state_corrupt", message);
}
