import * as path from "node:path";
import {
    confirmDurableDirectoryNoFollow,
    confirmDurableRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import { resolveAssetRoot } from "../catalog/asset-manifest";
import { resolvePayloadPath } from "../catalog/payload-store";
import { readPromotionGrantAuthority } from "../catalog/promotion-grant-store";
import { readAssetManifestAuthoritySet, readVersionAuthority } from "../catalog/version-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { VersionRef } from "../contracts/common";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import { readDeploymentCommitReceipt } from "../deployment/deployment-commit-receipts";
import { readDeploymentPayload } from "../deployment/deployment-payload-store";
import {
    readCanonicalDeploymentPreCommitDatabaseState,
    readDeploymentSuccessPostcondition,
} from "../deployment/deployment-state-authority";
import { tryAcquireAuthorityLockLease } from "../foundation/authority-locks";
import {
    computeDeploymentFileBaselineSetFingerprint,
    computePostAssetManifestAuthoritySetFingerprint,
    computePreCommitDatabaseStateFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { acquireAllLocks, computeDeploymentOperationKey } from "../foundation/physical-path-locks";
import { isUuidV4 } from "../foundation/validators";
import {
    type AssetFilesystemCommitReceiptV1,
    buildAssetFilesystemCommitReceipt,
    type ClaimedRenderedTargetCommitIntent,
    createReverseAcceptMarkerStore,
    type ReverseAcceptMarkerStore,
    type ReverseAcceptPreparationMarkerV1,
    type ReverseAcceptRecoveryRequiredDetailsV1,
    type ReverseAcceptRenderAnalysisValidator,
} from "./reverse-accept-marker";
import {
    classifyFacts,
    filesystemMismatch,
    type ReverseAcceptReconcileFacts,
    terminalConflictEvidence,
    terminalMatchesCurrent,
    terminalProof,
} from "./reverse-accept-reconcile-classification";

export interface ReverseAcceptReconcileConfiguration {
    transactionsRoot: string;
    authorityLocksRoot: string;
    assetsRoot: string;
    deploymentsRoot: string;
    databasePath: string;
    dialectRegistry: VersionDialectRegistryV1;
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator;
}

export type ReverseAcceptReconcileResult =
    | {
          reconcileState: "retired";
          terminalState: "consumed" | "failed";
          preparationRevision: number;
      }
    | {
          reconcileState: "recovery_required";
          reasonCode: ReverseAcceptRecoveryRequiredDetailsV1["reasonCode"];
          preparationRevision: number;
      }
    | {
          reconcileState: "pending" | "resolved";
          preparationState: "prepared" | "cancelled" | "expired" | "retired";
      }
    | { reconcileState: "busy"; deploymentId: UuidV4 }
    | { reconcileState: "scoped_freeze"; deploymentId: UuidV4; assetIds: UuidV4[] }
    | { reconcileState: "global_freeze" };

export type ReverseAcceptReconcileFactsForTest = ReverseAcceptReconcileFacts;

interface ReconcileDependencies {
    readFacts(
        configuration: Readonly<ReverseAcceptReconcileConfiguration>,
        intent: ClaimedRenderedTargetCommitIntent,
    ): ReverseAcceptReconcileFactsForTest;
}

interface ReconcileDurabilityPort {
    inventoryDirectory: typeof inventoryDirectoryNoFollow;
    confirmFile(filePath: string): void;
    confirmDirectory(directoryPath: string): void;
}

const PRODUCTION_DURABILITY: ReconcileDurabilityPort = Object.freeze({
    inventoryDirectory: inventoryDirectoryNoFollow,
    confirmFile(filePath: string) {
        confirmDurableRegularFileNoFollow(filePath);
    },
    confirmDirectory(directoryPath: string) {
        confirmDurableDirectoryNoFollow(directoryPath);
    },
});

const PRODUCTION_DEPENDENCIES: ReconcileDependencies = Object.freeze({
    readFacts(configuration: Readonly<ReverseAcceptReconcileConfiguration>, intent: ClaimedRenderedTargetCommitIntent) {
        return readCurrentFacts(configuration, intent, PRODUCTION_DURABILITY);
    },
});

export function reconcileReverseAcceptPreparation(
    configuration: ReverseAcceptReconcileConfiguration,
    preparationId: UuidV4,
): ReverseAcceptReconcileResult {
    const markerStore = createReverseAcceptMarkerStore(configuration.transactionsRoot, configuration.renderAnalysisValidator);
    return reconcileReverseAcceptPreparationCore(configuration, preparationId, markerStore, PRODUCTION_DEPENDENCIES);
}

/** Finish only the exact successful acceptance whose commit has released its locks. */
export function finalizeCommittedReverseAcceptPreparation(
    configuration: ReverseAcceptReconcileConfiguration,
    preparationId: UuidV4,
    version: VersionRef,
): ReverseAcceptReconcileResult {
    requireCommittedVersionReference(version);
    const markerStore = createReverseAcceptMarkerStore(configuration.transactionsRoot, configuration.renderAnalysisValidator);
    return reconcileReverseAcceptPreparationCore(configuration, preparationId, markerStore, PRODUCTION_DEPENDENCIES, version);
}

/** Test-only fact seam; production always reads filesystem and SQLite authorities. */
export function reconcileReverseAcceptPreparationForTest(
    configuration: ReverseAcceptReconcileConfiguration,
    preparationId: UuidV4,
    markerStore: ReverseAcceptMarkerStore,
    readFacts: ReconcileDependencies["readFacts"],
    committedVersion?: VersionRef,
): ReverseAcceptReconcileResult {
    if (committedVersion !== undefined) requireCommittedVersionReference(committedVersion);
    return reconcileReverseAcceptPreparationCore(configuration, preparationId, markerStore, { readFacts }, committedVersion);
}

/** Test-only read seam for production filesystem/SQLite fact classification. */
export function readReverseAcceptReconcileFactsForTest(
    configuration: Readonly<ReverseAcceptReconcileConfiguration>,
    intent: ClaimedRenderedTargetCommitIntent,
    durability: ReconcileDurabilityPort = PRODUCTION_DURABILITY,
): ReverseAcceptReconcileFactsForTest {
    return readCurrentFacts(configuration, intent, durability);
}

function reconcileReverseAcceptPreparationCore(
    configuration: Readonly<ReverseAcceptReconcileConfiguration>,
    preparationId: UuidV4,
    markerStore: ReverseAcceptMarkerStore,
    dependencies: ReconcileDependencies,
    committedVersion?: VersionRef,
): ReverseAcceptReconcileResult {
    const first = markerStore.readMarker(preparationId);
    if (first.state !== "available") return freezeFromLocator(markerStore, preparationId);
    if (committedVersion !== undefined) requireCommittedMarker(first.value, preparationId, committedVersion);
    const identity = first.value.identity;
    const assetLease = tryAcquireAuthorityLockLease(configuration.authorityLocksRoot, "assets", identity.assetIds);
    if (assetLease === null) return { reconcileState: "busy", deploymentId: identity.deploymentId };
    try {
        const deploymentLock = acquireAllLocks(configuration.transactionsRoot, [
            computeDeploymentOperationKey(identity.deploymentId),
        ]);
        if (deploymentLock === null) {
            return { reconcileState: "busy", deploymentId: identity.deploymentId };
        }
        try {
            const currentRead = markerStore.readMarker(preparationId);
            if (currentRead.state !== "available") return freezeFromLocator(markerStore, preparationId);
            const current = currentRead.value;
            if (current.identity.preparationIdentityFingerprint !== identity.preparationIdentityFingerprint) {
                return { reconcileState: "global_freeze" };
            }
            if (committedVersion !== undefined) requireCommittedMarker(current, preparationId, committedVersion);
            try {
                markerStore.repairLocatorFromMarker(current);
            } catch {
                return scopedFreeze(identity.deploymentId, identity.assetIds);
            }
            if (current.preparationState === "prepared") {
                return { reconcileState: "pending", preparationState: "prepared" };
            }
            if (
                current.preparationState === "cancelled" ||
                current.preparationState === "expired" ||
                current.preparationState === "retired"
            ) {
                return { reconcileState: "resolved", preparationState: current.preparationState };
            }
            const facts = dependencies.readFacts(configuration, current.intent);
            const classification = classifyFacts(facts, current.intent);
            if (typeof classification !== "string") {
                const recovery = markerStore.markRecoveryRequired(
                    preparationId,
                    current.preparationRevision,
                    current.markerFingerprint,
                    classification,
                );
                return {
                    reconcileState: "recovery_required",
                    reasonCode: recovery.reasonCode,
                    preparationRevision: recovery.preparationRevision,
                };
            }
            const terminal = terminalProof(classification, facts);
            if (current.preparationState === "claimed" || current.preparationState === "recovery_required") {
                const resolved = markerStore.resolveRecovery(
                    preparationId,
                    current.preparationRevision,
                    current.markerFingerprint,
                    terminal,
                );
                const retired = markerStore.retireTerminal(
                    preparationId,
                    resolved.preparationRevision,
                    resolved.markerFingerprint,
                );
                return {
                    reconcileState: "retired",
                    terminalState: terminal.terminalState,
                    preparationRevision: retired.preparationRevision,
                };
            }
            if (!terminalMatchesCurrent(terminal, current)) {
                const recovery = markerStore.markRecoveryRequired(
                    preparationId,
                    current.preparationRevision,
                    current.markerFingerprint,
                    terminalConflictEvidence(current, classification, facts),
                );
                return {
                    reconcileState: "recovery_required",
                    reasonCode: recovery.reasonCode,
                    preparationRevision: recovery.preparationRevision,
                };
            }
            const retired = markerStore.retireTerminal(preparationId, current.preparationRevision, current.markerFingerprint);
            return {
                reconcileState: "retired",
                terminalState: terminal.terminalState,
                preparationRevision: retired.preparationRevision,
            };
        } finally {
            deploymentLock.release();
        }
    } finally {
        assetLease.release();
    }
}

function requireCommittedVersionReference(version: VersionRef): void {
    if (!isUuidV4(version?.assetId) || !isUuidV4(version?.versionId)) {
        throw new TypeError("committed reverse acceptance requires an exact Version reference");
    }
}

function requireCommittedMarker(marker: ReverseAcceptPreparationMarkerV1, preparationId: UuidV4, version: VersionRef): void {
    if (
        marker.identity.preparationId !== preparationId ||
        (marker.preparationState !== "consumed" &&
            !(marker.preparationState === "retired" && marker.retiredTerminalProof.terminalState === "consumed")) ||
        marker.intent.stagedAssetId !== version.assetId ||
        marker.intent.stagedVersionId !== version.versionId
    ) {
        throw new TypeError("reverse acceptance terminal does not match the committed preparation and Version");
    }
}

function readCurrentFacts(
    configuration: Readonly<ReverseAcceptReconcileConfiguration>,
    intent: ClaimedRenderedTargetCommitIntent,
    durability: ReconcileDurabilityPort,
): ReverseAcceptReconcileFactsForTest {
    const receiptFacts = readReceiptFacts(configuration.databasePath, intent);
    const databaseFacts = readDatabaseFacts(configuration.databasePath, intent);
    const filesystemFacts = readFilesystemFacts(configuration, intent, durability);
    return { ...receiptFacts, ...databaseFacts, ...filesystemFacts };
}

function readReceiptFacts(
    databasePath: string,
    intent: ClaimedRenderedTargetCommitIntent,
): Pick<ReverseAcceptReconcileFactsForTest, "commitReceipt" | "receiptState" | "receiptObservedFingerprint"> {
    try {
        const lookup = readDeploymentCommitReceipt(
            databasePath,
            intent.expectedSuccessPostcondition.deploymentId,
            intent.expectedSuccessPostcondition.commitTransactionId,
        );
        if (lookup.receiptState === "missing") return { receiptState: "missing", commitReceipt: null };
        if (lookup.receipt.commitReceiptFingerprint !== intent.expectedCommitReceiptFingerprint) {
            return {
                receiptState: "mismatch",
                commitReceipt: lookup.receipt,
                receiptObservedFingerprint: lookup.receipt.commitReceiptFingerprint,
            };
        }
        return { receiptState: "exact", commitReceipt: lookup.receipt };
    } catch {
        return { receiptState: "unreadable", commitReceipt: null };
    }
}

function readDatabaseFacts(
    databasePath: string,
    intent: ClaimedRenderedTargetCommitIntent,
): Pick<ReverseAcceptReconcileFactsForTest, "databaseState" | "databaseEvidence"> {
    try {
        const current = readCanonicalDeploymentPreCommitDatabaseState(
            databasePath,
            intent.expectedSuccessPostcondition.deploymentId,
        );
        if (computePreCommitDatabaseStateFingerprint(current) === intent.preCommitDatabaseStateFingerprint) {
            return { databaseState: "pre" };
        }
        const post = readDeploymentSuccessPostcondition(
            databasePath,
            intent.expectedSuccessPostcondition.deploymentId,
            intent.expectedSuccessPostcondition.commitTransactionId,
        );
        if (
            stableStringify(post) === stableStringify(intent.expectedSuccessPostcondition) &&
            current.deployment.appliedInputsSnapshotFingerprint === intent.appliedInputsSnapshotFingerprint &&
            current.deployment.appliedRenderSnapshotFingerprint === intent.appliedRenderSnapshotFingerprint &&
            computeDeploymentFileBaselineSetFingerprint(post) === intent.deploymentFileBaselineSetFingerprint
        ) {
            return { databaseState: "post" };
        }
        return {
            databaseState: "other",
            databaseEvidence: databaseMismatchEvidence(current, post, intent),
        };
    } catch {
        return {
            databaseState: "unreadable",
            databaseEvidence: {
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "database_postcondition",
                        postconditionKind: "applied_inputs_snapshot",
                        observedState: "unreadable",
                        expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
                        failureKind: "corrupt",
                    },
                ],
            },
        };
    }
}

function databaseMismatchEvidence(
    current: import("../deployment/deployment-state-authority").CanonicalDeploymentPreCommitDatabaseStateV1,
    post: import("../deployment/deployment-state-authority").DeploymentSuccessPostconditionV1,
    intent: ClaimedRenderedTargetCommitIntent,
): ReverseAcceptRecoveryRequiredDetailsV1 {
    const observed = [
        {
            postconditionKind: "applied_inputs_snapshot" as const,
            expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
            observedFingerprint: current.deployment.appliedInputsSnapshotFingerprint,
        },
        {
            postconditionKind: "applied_render_snapshot" as const,
            expectedFingerprint: intent.appliedRenderSnapshotFingerprint,
            observedFingerprint: current.deployment.appliedRenderSnapshotFingerprint,
        },
        {
            postconditionKind: "deployment_file_baseline_set" as const,
            expectedFingerprint: intent.deploymentFileBaselineSetFingerprint,
            observedFingerprint: computeDeploymentFileBaselineSetFingerprint(post),
        },
    ] as const;
    // This helper is reached only after the exact success postcondition check
    // failed. Inputs, render and baseline are the three fingerprinted members
    // of that postcondition, so if the first two match the baseline is the
    // remaining contradictory authority (ignoring cryptographic collisions).
    const mismatch = observed.find(
        (candidate) => candidate.expectedFingerprint !== candidate.observedFingerprint,
    ) as (typeof observed)[number];
    // A readable success postcondition can differ from the claimed one only
    // through one of these three fingerprinted authorities. Observation and
    // blocking evidence are fixed by the success-postcondition validator.
    return {
        reasonCode: "database_postcondition_partial",
        evidence: [
            {
                evidenceKind: "database_postcondition",
                ...mismatch,
                observedState: "mismatch",
            },
        ],
    };
}

function readFilesystemFacts(
    configuration: Readonly<ReverseAcceptReconcileConfiguration>,
    intent: ClaimedRenderedTargetCommitIntent,
    durability: ReconcileDurabilityPort,
): Pick<ReverseAcceptReconcileFactsForTest, "filesystemState" | "assetFilesystemReceipt" | "filesystemEvidence"> {
    try {
        const authorities = readAssetManifestAuthoritySet(
            configuration.assetsRoot,
            intent.assetManifestAuthorities.map((item) => item.assetId),
        );
        if (stableStringify(authorities) === stableStringify(intent.assetManifestAuthorities)) {
            return { filesystemState: "old" };
        }
        const exact = exactPostFilesystem(configuration, intent, authorities);
        if (exact === null) {
            return {
                filesystemState: "other",
                filesystemEvidence: filesystemMismatch(
                    "asset_manifest",
                    intent.expectedPostAssetManifestAuthoritySetFingerprint,
                    computePostAssetManifestAuthoritySetFingerprint(authorities),
                ),
            };
        }
        try {
            confirmPostFilesystemDurability(configuration, intent, authorities, durability);
        } catch (error) {
            const failure = error as DurabilityConfirmationFailure;
            return {
                filesystemState: "other",
                filesystemEvidence: {
                    reasonCode: "durability_unconfirmed",
                    evidence: [failure.evidence],
                },
            };
        }
        const reopenedAuthorities = readAssetManifestAuthoritySet(
            configuration.assetsRoot,
            intent.assetManifestAuthorities.map((item) => item.assetId),
        );
        const reopened = exactPostFilesystem(configuration, intent, reopenedAuthorities);
        return reopened === null ||
            reopened.receipt.assetFilesystemReceiptFingerprint !== exact.receipt.assetFilesystemReceiptFingerprint
            ? {
                  filesystemState: "other",
                  filesystemEvidence: filesystemMismatch(
                      "asset_manifest",
                      intent.expectedPostAssetManifestAuthoritySetFingerprint,
                      computePostAssetManifestAuthoritySetFingerprint(reopenedAuthorities),
                  ),
              }
            : { filesystemState: "post", assetFilesystemReceipt: reopened.receipt };
    } catch {
        return {
            filesystemState: "unreadable",
            filesystemEvidence: {
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind: "asset_manifest",
                        observedState: "unreadable",
                        expectedFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
                        failureKind: "corrupt",
                    },
                ],
            },
        };
    }
}

interface ExactPostFilesystem {
    receipt: AssetFilesystemCommitReceiptV1;
}

function exactPostFilesystem(
    configuration: Readonly<ReverseAcceptReconcileConfiguration>,
    intent: ClaimedRenderedTargetCommitIntent,
    authorities: ReturnType<typeof readAssetManifestAuthoritySet>,
): ExactPostFilesystem | null {
    if (
        computePostAssetManifestAuthoritySetFingerprint(authorities) !== intent.expectedPostAssetManifestAuthoritySetFingerprint
    ) {
        return null;
    }
    const version = readVersionAuthority(
        configuration.assetsRoot,
        intent.stagedAssetId,
        intent.stagedVersionId,
        configuration.dialectRegistry,
    );
    if (
        version === null ||
        version.manifest.fingerprint !== intent.stagedVersionFingerprint ||
        stableStringify(version.manifest.originAuthority) !== stableStringify(intent.stagedVersionOriginAuthority)
    ) {
        return null;
    }
    const publication = intent.stagedPromotionPublication;
    if (publication.publicationState === "version_target_grant") {
        const grant = readPromotionGrantAuthority(
            configuration.assetsRoot,
            intent.stagedAssetId,
            publication.promotionGrant.promotionGrantId,
        );
        if (stableStringify(grant) !== stableStringify(publication.promotionGrant)) return null;
    }
    for (const payload of expectedPayloads(intent)) {
        readDeploymentPayload({
            deploymentsRoot: configuration.deploymentsRoot,
            deploymentId: intent.expectedSuccessPostcondition.deploymentId,
            contentHash: payload.contentHash,
            expectedByteSize: payload.byteSize,
        });
    }
    const receipt = buildAssetFilesystemCommitReceipt({
        schemaVersion: 1,
        preparationIdentityFingerprint: intent.preparationIdentityFingerprint,
        stagedAssetId: intent.stagedAssetId,
        stagedVersionId: intent.stagedVersionId,
        stagedVersionFingerprint: intent.stagedVersionFingerprint,
        stagedVersionOriginAuthorityFingerprint: intent.stagedVersionOriginAuthority.authorityFingerprint,
        stagedPromotionPublication: intent.stagedPromotionPublication,
        stagedAssetManifestFingerprint: intent.stagedAssetManifestFingerprint,
        postAssetManifestAuthoritySetFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
    });
    // The claimed-intent validator already recomputes this deterministic
    // receipt fingerprint from the same immutable fields. Repeating a
    // defensive nullable branch here would create an unreachable third state.
    return { receipt };
}

type DurabilityEvidenceKind = Extract<
    ReverseAcceptRecoveryRequiredDetailsV1,
    { reasonCode: "durability_unconfirmed" }
>["evidence"][number]["evidenceKind"];

class DurabilityConfirmationFailure extends Error {
    readonly evidence: Extract<
        ReverseAcceptRecoveryRequiredDetailsV1,
        { reasonCode: "durability_unconfirmed" }
    >["evidence"][number];

    constructor(evidenceKind: DurabilityEvidenceKind, expectedFingerprint: Sha256Digest, source: unknown) {
        super(`durability confirmation failed for ${evidenceKind}`);
        this.name = "DurabilityConfirmationFailure";
        this.evidence = {
            evidenceKind,
            observedState: "durability_unconfirmed",
            expectedFingerprint,
            failureKind: durabilityFailureKind(source),
        };
    }
}

function durabilityFailureKind(source: unknown): "flush_failed" | "identity_changed" | "platform_unconfirmed" {
    if (source instanceof SafeFilesystemError) {
        if (source.failureKind === "unsupported_platform") return "platform_unconfirmed";
        if (source.failureKind === "stale" || source.failureKind === "symlink_or_reparse") {
            return "identity_changed";
        }
    }
    return "flush_failed";
}

function confirmPostFilesystemDurability(
    configuration: Readonly<ReverseAcceptReconcileConfiguration>,
    intent: ClaimedRenderedTargetCommitIntent,
    authorities: ReturnType<typeof readAssetManifestAuthoritySet>,
    durability: ReconcileDurabilityPort,
): void {
    const files = new Map<string, { evidenceKind: DurabilityEvidenceKind; expectedFingerprint: Sha256Digest }>();
    const directories = new Map<string, { evidenceKind: DurabilityEvidenceKind; expectedFingerprint: Sha256Digest }>();
    const addFile = (filePath: string, evidenceKind: DurabilityEvidenceKind, expectedFingerprint: Sha256Digest) =>
        files.set(filePath, { evidenceKind, expectedFingerprint });
    const addDirectory = (directoryPath: string, evidenceKind: DurabilityEvidenceKind, expectedFingerprint: Sha256Digest) =>
        directories.set(directoryPath, { evidenceKind, expectedFingerprint });
    const addDirectoryTree = (
        directoryPath: string,
        evidenceKind: DurabilityEvidenceKind,
        expectedFingerprint: Sha256Digest,
    ): void => {
        addDirectory(directoryPath, evidenceKind, expectedFingerprint);
        let inventory: ReturnType<typeof inventoryDirectoryNoFollow>;
        try {
            inventory = durability.inventoryDirectory(directoryPath);
        } catch (error) {
            throw new DurabilityConfirmationFailure(evidenceKind, expectedFingerprint, error);
        }
        for (const entry of inventory.entries) {
            const entryPath = path.join(directoryPath, entry.relativeName);
            if (entry.identity.entryKind === "file") {
                addFile(entryPath, evidenceKind, expectedFingerprint);
            } else {
                addDirectoryTree(entryPath, evidenceKind, expectedFingerprint);
            }
        }
    };

    addDirectory(configuration.assetsRoot, "asset_manifest", intent.expectedPostAssetManifestAuthoritySetFingerprint);
    for (const authority of authorities) {
        const assetRoot = resolveAssetRoot(configuration.assetsRoot, authority.assetId);
        addFile(path.join(assetRoot, "asset.json"), "asset_manifest", intent.expectedPostAssetManifestAuthoritySetFingerprint);
        addDirectory(assetRoot, "asset_manifest", intent.expectedPostAssetManifestAuthoritySetFingerprint);
    }

    const stagedAssetRoot = resolveAssetRoot(configuration.assetsRoot, intent.stagedAssetId);
    const versionsRoot = path.join(stagedAssetRoot, "versions");
    const versionRoot = path.join(versionsRoot, intent.stagedVersionId);
    // The immutable Version directory is one authority closure. Walking the
    // actual no-follow tree avoids teaching recovery every current and future
    // native/restoration payload dialect while still durability-confirming all
    // bytes that the strict Version reader accepted above.
    addDirectoryTree(versionRoot, "immutable_version", intent.stagedVersionFingerprint);
    addDirectory(versionsRoot, "immutable_version", intent.stagedVersionFingerprint);

    const publication = intent.stagedPromotionPublication;
    if (publication.publicationState === "version_target_grant") {
        const grantsRoot = path.join(stagedAssetRoot, "promotion-grants");
        addFile(
            path.join(grantsRoot, `${publication.promotionGrant.promotionGrantId}.json`),
            "promotion_grant",
            publication.promotionGrant.grantFingerprint,
        );
        addDirectory(grantsRoot, "promotion_grant", publication.promotionGrant.grantFingerprint);
    }

    const deploymentRoot = path.join(configuration.deploymentsRoot, intent.expectedSuccessPostcondition.deploymentId);
    const expectedDeploymentPayloads = expectedPayloads(intent);
    for (const payload of expectedDeploymentPayloads) {
        addFile(resolvePayloadPath(deploymentRoot, payload.contentHash), "durable_payload", payload.contentHash);
        addDirectory(path.join(deploymentRoot, "payloads"), "durable_payload", payload.contentHash);
        addDirectory(deploymentRoot, "durable_payload", payload.contentHash);
        addDirectory(configuration.deploymentsRoot, "durable_payload", payload.contentHash);
    }

    for (const [filePath, evidence] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
        try {
            durability.confirmFile(filePath);
        } catch (error) {
            throw new DurabilityConfirmationFailure(evidence.evidenceKind, evidence.expectedFingerprint, error);
        }
    }
    const orderedDirectories = [...directories]
        .sort(([left], [right]) => left.localeCompare(right))
        .sort(([left], [right]) => right.length - left.length);
    for (const [directoryPath, evidence] of orderedDirectories) {
        try {
            durability.confirmDirectory(directoryPath);
        } catch (error) {
            throw new DurabilityConfirmationFailure(evidence.evidenceKind, evidence.expectedFingerprint, error);
        }
    }
}

function expectedPayloads(intent: ClaimedRenderedTargetCommitIntent): Array<{
    contentHash: Sha256Digest;
    byteSize: number;
}> {
    const byHash = new Map<Sha256Digest, number>();
    for (const file of intent.expectedSuccessPostcondition.files) {
        if (file.rowState === "active") byHash.set(file.appliedPayload.contentHash, file.appliedPayload.byteSize);
    }
    for (const residual of intent.expectedSuccessPostcondition.residualAuthorities) {
        byHash.set(residual.appliedPayload.contentHash, residual.appliedPayload.byteSize);
    }
    return [...byHash].map(([contentHash, byteSize]) => ({ contentHash, byteSize }));
}

function freezeFromLocator(markerStore: ReverseAcceptMarkerStore, preparationId: UuidV4): ReverseAcceptReconcileResult {
    const locator = markerStore.readLocator(preparationId);
    return locator.state === "available"
        ? scopedFreeze(locator.value.identity.deploymentId, locator.value.identity.assetIds)
        : { reconcileState: "global_freeze" };
}

function scopedFreeze(deploymentId: UuidV4, assetIds: UuidV4[]): ReverseAcceptReconcileResult {
    return { reconcileState: "scoped_freeze", deploymentId, assetIds: [...assetIds] };
}
