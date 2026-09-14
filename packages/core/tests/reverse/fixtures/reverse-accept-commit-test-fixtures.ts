import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inventoryDirectoryNoFollow, SafeFilesystemError } from "@oaam/shared/filesystem";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../../src/catalog/asset-manifest";
import { writePayload } from "../../../src/catalog/payload-store";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";
import {
    buildPromotionGrantAuthority,
    createPromotionGrantAuthority,
    readPromotionGrantAuthority,
    serializePromotionGrant,
} from "../../../src/catalog/promotion-grant-store";
import {
    publishInitialAssetVersion,
    publishReverseAcceptedAssetVersion,
    readAssetManifestAuthority,
    readAssetManifestAuthoritySet,
    readVersionAuthority,
} from "../../../src/catalog/version-authority";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../../src/catalog/version-dialect-registry";
import { serializeVersionManifest } from "../../../src/catalog/version-manifest";
import type { RenderAnalysisView, RenderAssetInput } from "../../../src/contracts/render";
import { buildDeploymentCommitReceipt } from "../../../src/deployment/deployment-commit-receipts";
import { readDeploymentPayload } from "../../../src/deployment/deployment-payload-store";
import {
    commitReverseAcceptVersionSelectionSuccessCrashDurable,
    prepareReverseAcceptDeploymentSuccessAuthority,
} from "../../../src/deployment/deployment-state-authority";
import { tryAcquireAuthorityLockLease } from "../../../src/foundation/authority-locks";
import {
    computeAppliedRenderSnapshotFingerprint,
    computePostAssetManifestAuthoritySetFingerprint,
    computeRenderOutputUnitFingerprint,
    computeReverseAcceptCommitIntentFingerprint,
    computeReverseAcceptMarkerFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
    stableStringify,
} from "../../../src/foundation/fingerprint";
import { acquireAllLocks, computeDeploymentOperationKey } from "../../../src/foundation/physical-path-locks";
import { getDeployment, listDeploymentAssets, upsertDeploymentAsset } from "../../../src/persistence/state-db";
import {
    finalizeDeploymentResidualAuthority,
    finalizeTargetFileRenderProvenance,
    makeRemovalIntentFingerprint,
} from "../../../src/render/deployment-render-authority";
import { promotionTargetForDeployment } from "../../../src/render/render-promotion-authorization";
import {
    buildAssetFilesystemCommitReceipt,
    buildClaimedRenderedTargetCommitIntent,
    buildReverseAcceptPreparationIdentity,
    type createReverseAcceptMarkerStore,
    createReverseAcceptMarkerStoreForTest,
    type ReverseAcceptPreparationMarkerV1,
    requireIntentExtendsPreparedForTest,
    reverseAcceptScanBlocksScope,
    scanReverseAcceptReservations,
    validateAssetFilesystemCommitReceiptForTest,
    validateClaimedRenderedTargetCommitIntentForTest,
    validateReverseAcceptMarkerForTest,
} from "../../../src/reverse/reverse-accept-marker";
import {
    type ReverseAcceptReconcileConfiguration,
    type ReverseAcceptReconcileFactsForTest,
    readReverseAcceptReconcileFactsForTest,
    reconcileReverseAcceptPreparation,
    reconcileReverseAcceptPreparationForTest,
} from "../../../src/reverse/reverse-accept-reconcile";
import {
    createReverseAcceptService,
    createReverseAcceptServiceForTest,
    type FreshReverseAcceptCommitDraft,
    type FreshReverseAcceptPreparationDraft,
    physicalKeysForCommitForTest,
    type ReverseAcceptService,
    type ReverseAcceptServiceConfiguration,
} from "../../../src/reverse/reverse-accept-service";
import type { Sha256Digest, UuidV4 } from "../../../src/types";
import {
    ASSET_ID,
    FILE_ID,
    makeAsset,
    makeTextFile,
    makeVersionClosure,
    VERSION_ID,
    VERSION_ID_2,
} from "../../catalog/fixtures/version-v2";
import {
    makeGuidanceRenderAsset,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
} from "../../render/fixtures/render-contract-fixtures";
import {
    DEPLOYMENT_ID,
    initializeStateDatabase,
    makeRemovalSuccessInput,
    makeSuccessInput,
    seedActiveFile,
    seedDeployment,
    TRANSACTION_ID,
    textPlan,
} from "./reverse-accept-db-fixtures";

export const PREPARATION_ID = "77777777-7777-4777-8777-777777777777" as UuidV4;

export const STAGED_VERSION_ID = VERSION_ID_2 as UuidV4;

export const DEPLOYMENT_UUID = DEPLOYMENT_ID as UuidV4;

export const TRANSACTION_UUID = TRANSACTION_ID as UuidV4;

export const PROMOTION_GRANT_ID = "99999999-9999-4999-8999-999999999999" as UuidV4;

export const ASSET_UUID = ASSET_ID as UuidV4;

export const OLD_VERSION_UUID = VERSION_ID as UuidV4;

export const SECOND_ASSET_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UuidV4;

export const SECOND_VERSION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef" as UuidV4;

export const HASH_A = `sha256:${"a".repeat(64)}` as Sha256Digest;

export const HASH_B = `sha256:${"b".repeat(64)}` as Sha256Digest;

export const HASH_C = `sha256:${"c".repeat(64)}` as Sha256Digest;

export const RENDERED_TEXT = "# Guidance changed by runtime\n";

export interface Harness {
    root: string;
    assetsRoot: string;
    deploymentsRoot: string;
    transactionsRoot: string;
    databasePath: string;
    targetRoot: string;
    analysis: RenderAnalysisView;
    preparationDraft: FreshReverseAcceptPreparationDraft;
    makeCommitDraft(
        origin: Parameters<ReverseAcceptServiceConfiguration["resolveFreshCommit"]>[0]["stagedVersionOriginAuthority"],
        promotionGrantId: UuidV4 | "",
    ): FreshReverseAcceptCommitDraft;
    configuration(overrides?: Partial<ReverseAcceptServiceConfiguration>): ReverseAcceptServiceConfiguration;
}

export type ClaimedIntentRecord = Record<string, unknown> & {
    commitIntentFingerprint: Sha256Digest;
};

export let harness: Harness;

beforeEach(() => {
    harness = createHarness();
});

afterEach(() => {
    if (harness !== undefined) {
        fs.rmSync(harness.root, { recursive: true, force: true });
    }
});

export function reconcileConfiguration(source: Harness): ReverseAcceptReconcileConfiguration {
    const configuration = source.configuration();
    return {
        transactionsRoot: source.transactionsRoot,
        authorityLocksRoot: configuration.authorityLocksRoot,
        assetsRoot: source.assetsRoot,
        deploymentsRoot: source.deploymentsRoot,
        databasePath: source.databasePath,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        renderAnalysisValidator: exactAnalysisValidator(source.analysis),
    };
}

export async function leaveClaimedBeforeFilesystem(source: Harness): Promise<ReturnType<typeof createReverseAcceptMarkerStore>> {
    const store = createReverseAcceptMarkerStoreForTest(source.transactionsRoot, exactAnalysisValidator(source.analysis), {
        beforeMarkerTransition(current, next) {
            if (current.preparationState === "claimed" && next.preparationState === "failed") {
                throw new Error("kill-before-failed-marker");
            }
        },
    });
    const service = createReverseAcceptServiceForTest(source.configuration(), store, undefined, {
        publishVersion() {
            throw new Error("kill-before-version-publication");
        },
    });
    await prepare(service);
    expect((await service.commitRenderedTargetAccept(commitRequest(source.analysis))).status).toBe("failed");
    expect(store.readMarker(PREPARATION_ID)).toMatchObject({
        state: "available",
        value: { preparationState: "claimed", preparationRevision: 2 },
    });
    return store;
}

export async function leaveClaimedAfterCommit(
    source: Harness,
    request = commitRequest(source.analysis),
): Promise<ReturnType<typeof createReverseAcceptMarkerStore>> {
    const store = createReverseAcceptMarkerStoreForTest(source.transactionsRoot, exactAnalysisValidator(source.analysis), {
        beforeMarkerTransition(current, next) {
            if (current.preparationState === "claimed" && next.preparationState === "consumed") {
                throw new Error("kill-before-consumed-marker");
            }
        },
    });
    const service = createReverseAcceptServiceForTest(source.configuration(), store);
    await prepare(service);
    const result = await service.commitRenderedTargetAccept(request);
    expect(result.status).toBe("failed");
    expect(store.readMarker(PREPARATION_ID), stableStringify(result)).toMatchObject({
        state: "available",
        value: { preparationState: "claimed" },
    });
    return store;
}

export function createHarness(
    promotionRequirement: "not_required" | "requires_current_authorization" = "not_required",
    includeSecondAsset = false,
    includeResidualRemoval = false,
): Harness {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-commit-"));
    const assetsRoot = path.join(root, "assets");
    const deploymentsRoot = path.join(root, "deployments");
    const transactionsRoot = path.join(root, "transactions");
    const databasePath = path.join(root, "state.db");
    const targetRoot = path.join(root, "target");
    fs.mkdirSync(targetRoot);
    fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), RENDERED_TEXT);
    initializeStateDatabase(databasePath);
    const inputAssets = [
        {
            assetId: ASSET_UUID,
            versionId: OLD_VERSION_UUID,
            allowIncomplete: false,
        },
        ...(includeSecondAsset
            ? [
                  {
                      assetId: SECOND_ASSET_ID,
                      versionId: SECOND_VERSION_ID,
                      allowIncomplete: false,
                  },
              ]
            : []),
    ];
    seedDeployment(databasePath, {
        targetRootPath: targetRoot,
        appliedInputsSnapshot: stableStringify({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_UUID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: inputAssets,
        }),
    });
    const db = new Database(databasePath);
    upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, VERSION_ID, 0, 0, 2_000);
    if (includeSecondAsset) {
        upsertDeploymentAsset(db, DEPLOYMENT_ID, SECOND_ASSET_ID, SECOND_VERSION_ID, 1, 0, 2_000);
    }
    db.close();
    if (includeResidualRemoval) {
        fs.writeFileSync(path.join(targetRoot, "OLD.md"), "# baseline");
        seedActiveFile(databasePath, "OLD.md");
    }

    const initial = makeVersionClosure();
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "initial-version",
        asset: makeAsset(),
        version: initial,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    const second = includeSecondAsset
        ? makeVersionClosure({
              assetId: SECOND_ASSET_ID,
              versionId: SECOND_VERSION_ID,
              files: [makeTextFile("# Unchanged second Asset\n", "SECOND.md")],
          })
        : null;
    if (second !== null) {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "initial-second-version",
            asset: makeAsset([SECOND_VERSION_ID], {
                assetId: SECOND_ASSET_ID,
                displayName: "Second fixture Asset",
            }),
            version: second,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
    }
    const stagedBase = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: VERSION_ID,
        changeKind: "sync",
        files: [makeTextFile("# Guidance changed by runtime\n")],
        createdAt: 10_000,
    });
    const provider = makeProviderSummary({
        adapterId: "claudecode",
        agentRuntimeId: "CLAUDE_CODE_CLI",
    });
    const registry = makeRenderRegistry({ providers: [provider] });
    const stagedAsset = projectAsset(stagedBase);
    const renderAssets = [stagedAsset, ...(second === null ? [] : [projectAsset(second)])];
    const deployment = makeRenderDeployment(registry, provider, {
        deploymentId: DEPLOYMENT_UUID,
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        targetRootPath: targetRoot,
        assets: renderAssets,
    });
    const analysis: RenderAnalysisView = {
        renderInputFingerprint: deployment.renderInputFingerprint,
        requiredSemantics: [],
        analyses: [],
    };
    const assetManifestAuthorities = [ASSET_UUID, ...(includeSecondAsset ? [SECOND_ASSET_ID] : [])].sort().map((assetId) => ({
        assetId,
        assetManifestAuthorityFingerprint:
            readAssetManifestAuthority(assetsRoot, assetId)?.authority.assetManifestAuthorityFingerprint ??
            (() => {
                throw new Error("initial Asset authority fixture is missing");
            })(),
    }));
    const preparationDraft: FreshReverseAcceptPreparationDraft = {
        deploymentAuthorityFingerprint: HASH_A,
        assetManifestAuthorities,
        inspectionScopeFingerprint: HASH_B,
        inspectionResultFingerprint: HASH_C,
        stagedAssetId: ASSET_UUID,
        stagedVersionFingerprint: stagedBase.manifest.fingerprint,
        stagedVersionOriginDraft: {
            previousVersionId: OLD_VERSION_UUID,
            previousVersionOriginAuthorityFingerprint: initial.manifest.originAuthority.authorityFingerprint,
            promotionRequirement,
        },
        promotionState: promotionRequirement === "not_required" ? "already_authorized" : "user_confirmation_required",
        renderAnalysis: analysis,
    };

    const makeCommitDraft: Harness["makeCommitDraft"] = (origin, promotionGrantId) => {
        const staged = structuredClone(stagedBase);
        staged.manifest.originAuthority = structuredClone(origin);
        const freshDeployment = makeRenderDeployment(registry, provider, {
            deploymentId: DEPLOYMENT_UUID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            targetRootPath: targetRoot,
            assets: [projectAsset(staged), ...(second === null ? [] : [projectAsset(second)])],
        });
        const selectionFingerprint = HASH_B;
        const compilationFingerprint = HASH_C;
        const successCommit = makeSuccessInput(textPlan("CLAUDE.md", RENDERED_TEXT));
        successCommit.now = origin.createdAt;
        successCommit.appliedInputsSnapshot = {
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_UUID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [
                {
                    assetId: ASSET_UUID,
                    versionId: STAGED_VERSION_ID,
                    allowIncomplete: false,
                },
                ...(includeSecondAsset
                    ? [
                          {
                              assetId: SECOND_ASSET_ID,
                              versionId: SECOND_VERSION_ID,
                              allowIncomplete: false,
                          },
                      ]
                    : []),
            ],
        };
        const target = promotionTargetForDeployment(freshDeployment);
        const promotionAuthorization =
            origin.promotionRequirement === "not_required"
                ? {
                      promotionAuthorizationState: "not_required" as const,
                      assetId: ASSET_UUID,
                      versionId: STAGED_VERSION_ID,
                      target,
                      versionOriginAuthorityFingerprint: origin.authorityFingerprint,
                  }
                : (() => {
                      const authorityId = promotionGrantId === "" ? PROMOTION_GRANT_ID : promotionGrantId;
                      const grant = buildPromotionGrantAuthority({
                          promotionGrantId: authorityId,
                          subject: {
                              subjectKind: "asset_version",
                              assetId: ASSET_UUID,
                              versionId: STAGED_VERSION_ID,
                          },
                          target,
                          userActionEvidenceId: origin.userActionEvidenceId,
                          updatedAt: origin.createdAt,
                      });
                      return {
                          promotionAuthorizationState: "authorized" as const,
                          assetId: ASSET_UUID,
                          versionId: STAGED_VERSION_ID,
                          target,
                          versionOriginAuthorityFingerprint: origin.authorityFingerprint,
                          authorizationSource: "version_target_grant" as const,
                          authorityId: grant.promotionGrantId,
                          authorityRevision: grant.revision,
                          authorityFingerprint: grant.grantFingerprint,
                      };
                  })();
        successCommit.appliedRenderSnapshot = {
            ...successCommit.appliedRenderSnapshot,
            renderInputFingerprint: freshDeployment.renderInputFingerprint,
            selectionFingerprint,
            compilationFingerprint,
            promotionAuthorizations: [promotionAuthorization],
        };
        if (includeResidualRemoval) {
            const removal = makeRemovalSuccessInput(databasePath, "OLD.md").newlyRemoved[0];
            if (removal === undefined) throw new Error("removal fixture missing");
            successCommit.newlyRemoved = [
                finalizeDeploymentResidualAuthority({
                    schemaVersion: 1,
                    deploymentId: removal.deploymentId,
                    relativePath: removal.relativePath,
                    appliedPayload: removal.appliedPayload,
                    appliedExecutable: removal.appliedExecutable,
                    previousProvenance: removal.previousProvenance,
                    removalIntentFingerprint: makeRemovalIntentFingerprint({
                        deploymentId: removal.deploymentId,
                        relativePath: removal.relativePath,
                        previousProvenanceFingerprint: removal.previousProvenance.provenanceFingerprint,
                        nextCompilationFingerprint: successCommit.appliedRenderSnapshot.compilationFingerprint,
                        reason: "absent_from_new_desired_set",
                    }),
                }),
            ];
        }
        const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(successCommit.appliedRenderSnapshot);
        successCommit.verifiedActiveFiles = successCommit.verifiedActiveFiles.map((file) => ({
            ...file,
            provenance: finalizeTargetFileRenderProvenance({
                schemaVersion: 1,
                appliedRenderSnapshotFingerprint: snapshotFingerprint,
                outputUnitFingerprint: file.provenance.outputUnitFingerprint,
                materializationFingerprint: file.provenance.materializationFingerprint,
                semanticRefFingerprints: [...file.provenance.semanticRefFingerprints],
                sectionBindings: structuredClone(file.provenance.sectionBindings),
            }),
        }));
        const appliedPayload = successCommit.verifiedActiveFiles[0]?.appliedPayload;
        if (appliedPayload === undefined) throw new Error("active payload fixture missing");
        const deploymentPayloads = [
            {
                contentKind: appliedPayload.contentKind,
                contentHash: appliedPayload.contentHash,
                bytes: new Uint8Array(Buffer.from(RENDERED_TEXT, "utf-8")),
            },
        ];
        for (const residual of successCommit.newlyRemoved) {
            deploymentPayloads.push({
                contentKind: residual.appliedPayload.contentKind,
                contentHash: residual.appliedPayload.contentHash,
                bytes: new Uint8Array(Buffer.from("# baseline", "utf-8")),
            });
        }
        return {
            deploymentAuthorityFingerprint: HASH_A,
            assetManifestAuthorities,
            inspectionScopeFingerprint: HASH_B,
            inspectionResultFingerprint: HASH_C,
            deployment: freshDeployment,
            renderAnalysis: analysis,
            selectionFingerprint,
            compilationFingerprint,
            stagedVersion: staged,
            deploymentPayloads,
            successCommit,
        };
    };

    const baseConfiguration: ReverseAcceptServiceConfiguration = {
        transactionsRoot,
        assetsRoot,
        deploymentsRoot,
        authorityLocksRoot: path.join(root, "authority-locks"),
        databasePath,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        preparationTtlMs: 1_000,
        renderAnalysisValidator: exactAnalysisValidator(analysis),
        resolveFreshPreparation: async () => ({
            status: "complete",
            value: structuredClone(preparationDraft),
            diagnostics: [],
        }),
        resolveFreshCommit: async (input) => ({
            status: "complete",
            value: makeCommitDraft(input.stagedVersionOriginAuthority, input.promotionGrantId),
            diagnostics: [],
        }),
        now: () => 10_000,
        newUuid: sequenceUuid([PREPARATION_ID, TRANSACTION_UUID, STAGED_VERSION_ID, PROMOTION_GRANT_ID]),
    };
    return {
        root,
        assetsRoot,
        deploymentsRoot,
        transactionsRoot,
        databasePath,
        targetRoot,
        analysis,
        preparationDraft,
        makeCommitDraft,
        configuration: (overrides = {}) => ({ ...baseConfiguration, ...overrides }),
    };
}

export function projectAsset(closure: ReturnType<typeof makeVersionClosure>): RenderAssetInput {
    return makeGuidanceRenderAsset({
        version: {
            ref: {
                assetId: closure.manifest.assetId,
                versionId: closure.manifest.versionId,
            },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            status: closure.manifest.status,
            canonical: {
                kind: closure.manifest.kind,
                typeData: closure.manifest.typeData,
            },
            files: closure.files,
        },
        sectionHandles: { [FILE_ID]: "fixture-section" },
    });
}

export function refreshSuccessProvenance(draft: FreshReverseAcceptCommitDraft): void {
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(draft.successCommit.appliedRenderSnapshot);
    draft.successCommit.verifiedActiveFiles = draft.successCommit.verifiedActiveFiles.map((file) => ({
        ...file,
        provenance: finalizeTargetFileRenderProvenance({
            schemaVersion: 1,
            appliedRenderSnapshotFingerprint: snapshotFingerprint,
            outputUnitFingerprint: file.provenance.outputUnitFingerprint,
            materializationFingerprint: file.provenance.materializationFingerprint,
            semanticRefFingerprints: [...file.provenance.semanticRefFingerprints],
            sectionBindings: structuredClone(file.provenance.sectionBindings),
        }),
    }));
}

export function exactAnalysisValidator(analysis: RenderAnalysisView) {
    return {
        validate(value: unknown): asserts value is RenderAnalysisView {
            if (stableStringify(value) !== stableStringify(analysis)) {
                throw new Error("render analysis fixture mismatch");
            }
        },
    };
}

export function sequenceUuid(values: UuidV4[]): () => UuidV4 {
    const queue = [...values];
    return () => {
        const value = queue.shift();
        if (value === undefined) throw new Error("UUID fixture exhausted");
        return value;
    };
}

export function commitRequest(analysis: RenderAnalysisView) {
    return {
        preparationId: PREPARATION_ID,
        expectedPreparationRevision: 1,
        userActionId: "accept-edited-guidance",
        newVersionPromotion: { promotionAction: "use_existing_authority" as const },
        renderSelectionRequest: {
            schemaVersion: 1 as const,
            renderInputFingerprint: analysis.renderInputFingerprint,
            semanticOptions: [],
        },
    };
}

export async function prepare(service: ReverseAcceptService) {
    return service.prepareRenderedTargetAccept({
        deploymentId: DEPLOYMENT_UUID,
        inspectionResultFingerprint: HASH_C,
    });
}
