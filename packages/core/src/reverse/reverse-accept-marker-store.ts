import * as path from "node:path";
import {
    durableEnsureDirectory,
    durableReplaceFile,
    readRegularFileNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { DeploymentCommitReceiptV1 } from "../deployment/deployment-commit-receipts";
import { validateDeploymentCommitReceipt } from "../deployment/deployment-commit-receipts";
import {
    computeReverseAcceptMarkerFingerprint,
    computeReverseAcceptReservationLocatorFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { isSha256Digest } from "../foundation/validators";

const MARKERS_DIRECTORY = "reverse-accept";
const LOCATORS_DIRECTORY = "reverse-accept-locators";
const MARKER_FILE = "marker.json";

import {
    inventoryAuthorityIds,
    isReservationActive,
    isSafePositiveInteger,
    parseLocator,
    requireAuthorityPathIdentity,
    requireCanonicalRoot,
    requirePreparationId,
    requireReceiptJoinsIntent,
} from "./reverse-accept-marker-fields";
import type {
    ClaimedRenderedTargetCommitIntent,
    ClaimedReverseAcceptMarkerV1,
    ConsumedReverseAcceptMarkerV1,
    FailedReverseAcceptMarkerV1,
    PreparedRenderedTargetAccept,
    RecoveryRequiredReverseAcceptMarkerV1,
    RetiredReverseAcceptMarkerV1,
    ReverseAcceptFailedFilesystemTerminalProofV1,
    ReverseAcceptMarkerReadResult,
    ReverseAcceptMarkerStore,
    ReverseAcceptMutableMarkerV1,
    ReverseAcceptPreparationIdentityV1,
    ReverseAcceptPreparationMarkerV1,
    ReverseAcceptRecoveryRequiredDetailsV1,
    ReverseAcceptRenderAnalysisValidator,
    ReverseAcceptReservationLocatorV1,
    ReverseAcceptReservationScanResult,
    ReverseAcceptRetiredTerminalProofV1,
    ReverseAcceptTransitionedMarkerV1,
} from "./reverse-accept-marker-model";
import { ReverseAcceptMarkerStoreError } from "./reverse-accept-marker-model";
import {
    parseReverseAcceptMarker,
    validateClaimedIntent,
    validateFilesystemTerminalProof,
    validateRecoveryRequiredDetails,
    validateRetiredTerminalProof,
    validateReverseAcceptMarker,
} from "./reverse-accept-marker-validation";

export function scanReverseAcceptReservations(
    transactionsRoot: string,
    markerStore: ReverseAcceptMarkerStore,
): ReverseAcceptReservationScanResult {
    requireCanonicalRoot(transactionsRoot);
    const markerIds = inventoryAuthorityIds(path.join(transactionsRoot, MARKERS_DIRECTORY), "marker_directory");
    const locatorIds = inventoryAuthorityIds(path.join(transactionsRoot, LOCATORS_DIRECTORY), "locator_file");
    if (markerIds === null || locatorIds === null) {
        return { globalFreeze: true, activePreparations: [] };
    }
    const preparationIds = [...new Set([...markerIds, ...locatorIds])].sort();
    const active = new Map<string, ReverseAcceptPreparationIdentityV1>();
    for (const preparationId of preparationIds) {
        const typedId = preparationId as UuidV4;
        const marker = markerStore.readMarker(typedId);
        if (marker.state === "available") {
            if (isReservationActive(marker.value.preparationState)) {
                active.set(preparationId, marker.value.identity);
            }
            continue;
        }
        const locator = markerStore.readLocator(typedId);
        if (locator.state !== "available") {
            return { globalFreeze: true, activePreparations: [...active.values()] };
        }
        active.set(preparationId, locator.value.identity);
    }
    return {
        globalFreeze: false,
        // `preparationIds` is already canonical-sorted and the store requires
        // every returned identity to join that path ID, so Map insertion order
        // is the one valid result order. A second sort would only add an
        // unreachable comparator branch.
        activePreparations: [...active.values()],
    };
}

export function reverseAcceptScanBlocksScope(
    scan: ReverseAcceptReservationScanResult,
    scope: { deploymentId?: UuidV4; assetIds?: readonly UuidV4[] },
    excludedPreparationIds: readonly UuidV4[] = [],
): boolean {
    if (scan.globalFreeze) return true;
    const excluded = new Set(excludedPreparationIds);
    const assets = new Set(scope.assetIds ?? []);
    return scan.activePreparations.some(
        (identity) =>
            !excluded.has(identity.preparationId) &&
            ((scope.deploymentId !== undefined && identity.deploymentId === scope.deploymentId) ||
                identity.assetIds.some((assetId) => assets.has(assetId))),
    );
}

export interface ReverseAcceptMarkerStoreHooks {
    beforeMarkerPublish(marker: PreparedRenderedTargetAccept): void;
    afterMarkerPublish(marker: PreparedRenderedTargetAccept): void;
    beforeLocatorPublish(locator: ReverseAcceptReservationLocatorV1): void;
    afterLocatorPublish(locator: ReverseAcceptReservationLocatorV1): void;
    beforeMarkerTransition(current: ReverseAcceptMutableMarkerV1, next: ReverseAcceptTransitionedMarkerV1): void;
    afterMarkerTransition(next: ReverseAcceptTransitionedMarkerV1): void;
}

const NO_HOOKS: ReverseAcceptMarkerStoreHooks = {
    beforeMarkerPublish: () => undefined,
    afterMarkerPublish: () => undefined,
    beforeLocatorPublish: () => undefined,
    afterLocatorPublish: () => undefined,
    beforeMarkerTransition: () => undefined,
    afterMarkerTransition: () => undefined,
};

export function createReverseAcceptMarkerStore(
    transactionsRoot: string,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
): ReverseAcceptMarkerStore {
    return createReverseAcceptMarkerStoreCore(transactionsRoot, renderAnalysisValidator, NO_HOOKS);
}

/** Test-only kill/fault seam; production must use createReverseAcceptMarkerStore. */
export function createReverseAcceptMarkerStoreForTest(
    transactionsRoot: string,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
    hooks: Partial<ReverseAcceptMarkerStoreHooks>,
): ReverseAcceptMarkerStore {
    return createReverseAcceptMarkerStoreCore(transactionsRoot, renderAnalysisValidator, {
        ...NO_HOOKS,
        ...hooks,
    });
}

export function createReverseAcceptMarkerStoreCore(
    transactionsRoot: string,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
    hooks: ReverseAcceptMarkerStoreHooks,
): ReverseAcceptMarkerStore {
    requireCanonicalRoot(transactionsRoot);

    const readMarker = (preparationId: UuidV4): ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1> => {
        requirePreparationId(preparationId);
        return readStrictJson(markerPath(transactionsRoot, preparationId), (value) => {
            const marker = parseReverseAcceptMarker(value, renderAnalysisValidator);
            requireAuthorityPathIdentity(marker.identity, preparationId, "marker");
            return marker;
        });
    };

    const readLocator = (preparationId: UuidV4): ReverseAcceptMarkerReadResult<ReverseAcceptReservationLocatorV1> => {
        requirePreparationId(preparationId);
        return readStrictJson(locatorPath(transactionsRoot, preparationId), (value) => {
            const locator = parseLocator(value);
            requireAuthorityPathIdentity(locator.identity, preparationId, "locator");
            return locator;
        });
    };

    const publishLocator = (locator: ReverseAcceptReservationLocatorV1): void => {
        hooks.beforeLocatorPublish(structuredClone(locator));
        durableReplaceFile(locatorPath(transactionsRoot, locator.identity.preparationId), serializeAuthority(locator));
        hooks.afterLocatorPublish(structuredClone(locator));
        const reopened = readLocator(locator.identity.preparationId);
        if (reopened.state !== "available" || stableStringify(reopened.value) !== stableStringify(locator)) {
            throw new ReverseAcceptMarkerStoreError(
                "publication_verification_failed",
                "reverse-accept locator did not reopen as the published authority",
            );
        }
    };

    const publishTransition = <T extends ReverseAcceptTransitionedMarkerV1>(
        current: ReverseAcceptMutableMarkerV1,
        next: T,
    ): T => {
        validateReverseAcceptMarker(next, renderAnalysisValidator);
        hooks.beforeMarkerTransition(structuredClone(current), structuredClone(next));
        durableReplaceFile(markerPath(transactionsRoot, current.identity.preparationId), serializeAuthority(next));
        hooks.afterMarkerTransition(structuredClone(next));
        const reopened = readMarker(current.identity.preparationId);
        if (reopened.state !== "available" || stableStringify(reopened.value) !== stableStringify(next)) {
            throw new ReverseAcceptMarkerStoreError(
                "publication_verification_failed",
                "reverse-accept transitioned marker did not reopen as published",
            );
        }
        return next;
    };

    return Object.freeze({
        readMarker,
        readLocator,

        publishPrepared(marker: PreparedRenderedTargetAccept): void {
            validateReverseAcceptMarker(marker, renderAnalysisValidator);
            ensureAuthorityDirectories(transactionsRoot, marker.identity.preparationId);
            const existingMarker = readMarker(marker.identity.preparationId);
            if (existingMarker.state !== "missing") {
                throw new ReverseAcceptMarkerStoreError(
                    "marker_exists",
                    "reverse-accept marker already exists for preparationId",
                );
            }
            const existingLocator = readLocator(marker.identity.preparationId);
            if (existingLocator.state !== "missing") {
                throw new ReverseAcceptMarkerStoreError(
                    "locator_exists",
                    "reverse-accept locator already exists for preparationId",
                );
            }

            hooks.beforeMarkerPublish(structuredClone(marker));
            durableReplaceFile(markerPath(transactionsRoot, marker.identity.preparationId), serializeAuthority(marker));
            hooks.afterMarkerPublish(structuredClone(marker));

            const reopenedMarker = readMarker(marker.identity.preparationId);
            if (reopenedMarker.state !== "available" || stableStringify(reopenedMarker.value) !== stableStringify(marker)) {
                throw new ReverseAcceptMarkerStoreError(
                    "publication_verification_failed",
                    "reverse-accept marker did not reopen as the published authority",
                );
            }
            publishLocator(buildLocator(marker.identity));
        },

        repairLocatorFromMarker(marker: ReverseAcceptPreparationMarkerV1): "matched" | "rebuilt" {
            validateReverseAcceptMarker(marker, renderAnalysisValidator);
            ensureAuthorityDirectories(transactionsRoot, marker.identity.preparationId);
            const expected = buildLocator(marker.identity);
            const current = readLocator(marker.identity.preparationId);
            if (current.state === "available" && stableStringify(current.value) === stableStringify(expected)) {
                return "matched";
            }
            publishLocator(expected);
            return "rebuilt";
        },

        transitionPrepared(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
            nextState: "cancelled" | "expired",
        ) {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const current = readMarker(preparationId);
            const prepared = requirePreparedCurrent(current, expectedPreparationRevision, expectedMarkerFingerprint);
            const preimage = {
                identity: prepared.identity,
                preparationRevision: prepared.preparationRevision + 1,
                preparationState: nextState,
            } as const;
            const next = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            } as Extract<ReverseAcceptPreparationMarkerV1, { preparationState: "cancelled" | "expired" }>;
            return publishTransition(prepared, next);
        },

        claimPrepared(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
            sourceIntent: ClaimedRenderedTargetCommitIntent,
        ): ClaimedReverseAcceptMarkerV1 {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const prepared = requirePreparedCurrent(
                readMarker(preparationId),
                expectedPreparationRevision,
                expectedMarkerFingerprint,
            );
            const intent = structuredClone(sourceIntent);
            validateClaimedIntent(intent);
            requireIntentExtendsPrepared(intent, prepared);
            const preimage = {
                identity: prepared.identity,
                preparationRevision: prepared.preparationRevision + 1,
                preparationState: "claimed" as const,
                intent,
            };
            const next: ClaimedReverseAcceptMarkerV1 = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            };
            return publishTransition(prepared, next);
        },

        consumeClaimed(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
            sourceReceipt: DeploymentCommitReceiptV1,
        ): ConsumedReverseAcceptMarkerV1 {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const claimed = requireClaimedCurrent(
                readMarker(preparationId),
                expectedPreparationRevision,
                expectedMarkerFingerprint,
            );
            const commitReceipt = structuredClone(sourceReceipt);
            validateDeploymentCommitReceipt(commitReceipt);
            requireReceiptJoinsIntent(commitReceipt, claimed);
            const preimage = {
                identity: claimed.identity,
                preparationRevision: claimed.preparationRevision + 1,
                preparationState: "consumed" as const,
                intent: claimed.intent,
                commitReceipt,
            };
            const next: ConsumedReverseAcceptMarkerV1 = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            };
            return publishTransition(claimed, next);
        },

        failClaimed(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
            sourceProof: ReverseAcceptFailedFilesystemTerminalProofV1,
        ): FailedReverseAcceptMarkerV1 {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const claimed = requireClaimedCurrent(
                readMarker(preparationId),
                expectedPreparationRevision,
                expectedMarkerFingerprint,
            );
            const filesystemTerminalProof = structuredClone(sourceProof);
            validateFilesystemTerminalProof(filesystemTerminalProof, claimed.intent);
            const preimage = {
                identity: claimed.identity,
                preparationRevision: claimed.preparationRevision + 1,
                preparationState: "failed" as const,
                intent: claimed.intent,
                filesystemTerminalProof,
            };
            const next: FailedReverseAcceptMarkerV1 = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            };
            return publishTransition(claimed, next);
        },

        markRecoveryRequired(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
            sourceDetails: ReverseAcceptRecoveryRequiredDetailsV1,
        ): RecoveryRequiredReverseAcceptMarkerV1 {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const current = requireRecoveryWritableCurrent(
                readMarker(preparationId),
                expectedPreparationRevision,
                expectedMarkerFingerprint,
            );
            const details = structuredClone(sourceDetails);
            validateRecoveryRequiredDetails(details, current.intent);
            if (
                current.preparationState === "recovery_required" &&
                current.reasonCode === details.reasonCode &&
                stableStringify(current.evidence) === stableStringify(details.evidence)
            ) {
                return current;
            }
            const preimage = {
                identity: current.identity,
                preparationRevision: current.preparationRevision + 1,
                preparationState: "recovery_required" as const,
                intent: current.intent,
                ...details,
            };
            const next: RecoveryRequiredReverseAcceptMarkerV1 = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            };
            return publishTransition(current, next);
        },

        resolveRecovery(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
            sourceProof: ReverseAcceptRetiredTerminalProofV1,
        ): ConsumedReverseAcceptMarkerV1 | FailedReverseAcceptMarkerV1 {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const current = requireClaimedOrRecoveryCurrent(
                readMarker(preparationId),
                expectedPreparationRevision,
                expectedMarkerFingerprint,
            );
            const terminalProof = structuredClone(sourceProof);
            validateRetiredTerminalProof(terminalProof, current.intent);
            if (terminalProof.terminalState === "consumed") {
                const preimage = {
                    identity: current.identity,
                    preparationRevision: current.preparationRevision + 1,
                    preparationState: "consumed" as const,
                    intent: current.intent,
                    commitReceipt: terminalProof.commitReceipt,
                };
                const next: ConsumedReverseAcceptMarkerV1 = {
                    ...preimage,
                    markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
                };
                return publishTransition(current, next);
            }
            const preimage = {
                identity: current.identity,
                preparationRevision: current.preparationRevision + 1,
                preparationState: "failed" as const,
                intent: current.intent,
                filesystemTerminalProof: terminalProof.filesystemTerminalProof,
            };
            const next: FailedReverseAcceptMarkerV1 = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            };
            return publishTransition(current, next);
        },

        retireTerminal(
            preparationId: UuidV4,
            expectedPreparationRevision: number,
            expectedMarkerFingerprint: Sha256Digest,
        ): RetiredReverseAcceptMarkerV1 {
            requireTransitionExpectation(preparationId, expectedPreparationRevision, expectedMarkerFingerprint);
            const current = requireTerminalCurrent(
                readMarker(preparationId),
                expectedPreparationRevision,
                expectedMarkerFingerprint,
            );
            const retiredTerminalProof: ReverseAcceptRetiredTerminalProofV1 =
                current.preparationState === "consumed"
                    ? { terminalState: "consumed", commitReceipt: current.commitReceipt }
                    : {
                          terminalState: "failed",
                          filesystemTerminalProof: current.filesystemTerminalProof,
                      };
            const preimage = {
                identity: current.identity,
                preparationRevision: current.preparationRevision + 1,
                preparationState: "retired" as const,
                intent: current.intent,
                retiredTerminalProof,
            };
            const next: RetiredReverseAcceptMarkerV1 = {
                ...preimage,
                markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
            };
            return publishTransition(current, next);
        },
    });
}

export function requireIntentExtendsPrepared(
    intent: ClaimedRenderedTargetCommitIntent,
    prepared: PreparedRenderedTargetAccept,
): void {
    if (
        intent.preparationIdentityFingerprint !== prepared.identity.preparationIdentityFingerprint ||
        intent.claimedPreparationRevision !== prepared.preparationRevision ||
        intent.deploymentAuthorityFingerprint !== prepared.deploymentAuthorityFingerprint ||
        intent.assetManifestAuthoritySetFingerprint !== prepared.assetManifestAuthoritySetFingerprint ||
        intent.inspectionScopeFingerprint !== prepared.inspectionScopeFingerprint ||
        intent.inspectionResultFingerprint !== prepared.inspectionResultFingerprint ||
        intent.stagedAssetId !== prepared.stagedAssetId ||
        intent.stagedVersionId !== prepared.stagedVersionId ||
        intent.stagedVersionFingerprint !== prepared.stagedVersionFingerprint ||
        stableStringify(intent.assetManifestAuthorities) !== stableStringify(prepared.assetManifestAuthorities)
    ) {
        throw new ReverseAcceptMarkerStoreError("invalid_input", "claimed intent does not extend the exact prepared authority");
    }
}

export function requireTransitionExpectation(
    preparationId: UuidV4,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
): void {
    requirePreparationId(preparationId);
    if (!isSafePositiveInteger(expectedPreparationRevision)) {
        throw new ReverseAcceptMarkerStoreError("invalid_input", "expectedPreparationRevision must be a positive safe integer");
    }
    if (!isSha256Digest(expectedMarkerFingerprint)) {
        throw new ReverseAcceptMarkerStoreError("invalid_input", "expectedMarkerFingerprint must be a SHA-256 digest");
    }
}

export function requirePreparedCurrent(
    current: ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
): PreparedRenderedTargetAccept {
    if (current.state !== "available") {
        throw new ReverseAcceptMarkerStoreError("marker_unavailable", "reverse-accept marker is unavailable");
    }
    if (current.value.preparationState !== "prepared") {
        throw new ReverseAcceptMarkerStoreError(
            "marker_state_conflict",
            `reverse-accept marker is already ${current.value.preparationState}`,
        );
    }
    requireExpectedMarker(current.value, expectedPreparationRevision, expectedMarkerFingerprint);
    return current.value;
}

export function requireClaimedCurrent(
    current: ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
): ClaimedReverseAcceptMarkerV1 {
    if (current.state !== "available") {
        throw new ReverseAcceptMarkerStoreError("marker_unavailable", "reverse-accept marker is unavailable");
    }
    if (current.value.preparationState !== "claimed") {
        throw new ReverseAcceptMarkerStoreError(
            "marker_state_conflict",
            `reverse-accept marker is already ${current.value.preparationState}`,
        );
    }
    requireExpectedMarker(current.value, expectedPreparationRevision, expectedMarkerFingerprint);
    return current.value;
}

export function requireClaimedOrRecoveryCurrent(
    current: ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
): ClaimedReverseAcceptMarkerV1 | RecoveryRequiredReverseAcceptMarkerV1 {
    if (current.state !== "available") {
        throw new ReverseAcceptMarkerStoreError("marker_unavailable", "reverse-accept marker is unavailable");
    }
    if (current.value.preparationState !== "claimed" && current.value.preparationState !== "recovery_required") {
        throw new ReverseAcceptMarkerStoreError(
            "marker_state_conflict",
            `reverse-accept marker is already ${current.value.preparationState}`,
        );
    }
    requireExpectedMarker(current.value, expectedPreparationRevision, expectedMarkerFingerprint);
    return current.value;
}

export function requireRecoveryWritableCurrent(
    current: ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
):
    | ClaimedReverseAcceptMarkerV1
    | RecoveryRequiredReverseAcceptMarkerV1
    | ConsumedReverseAcceptMarkerV1
    | FailedReverseAcceptMarkerV1 {
    if (current.state !== "available") {
        throw new ReverseAcceptMarkerStoreError("marker_unavailable", "reverse-accept marker is unavailable");
    }
    if (
        current.value.preparationState !== "claimed" &&
        current.value.preparationState !== "recovery_required" &&
        current.value.preparationState !== "consumed" &&
        current.value.preparationState !== "failed"
    ) {
        throw new ReverseAcceptMarkerStoreError(
            "marker_state_conflict",
            `reverse-accept marker is already ${current.value.preparationState}`,
        );
    }
    requireExpectedMarker(current.value, expectedPreparationRevision, expectedMarkerFingerprint);
    return current.value;
}

export function requireTerminalCurrent(
    current: ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
): ConsumedReverseAcceptMarkerV1 | FailedReverseAcceptMarkerV1 {
    if (current.state !== "available") {
        throw new ReverseAcceptMarkerStoreError("marker_unavailable", "reverse-accept marker is unavailable");
    }
    if (current.value.preparationState !== "consumed" && current.value.preparationState !== "failed") {
        throw new ReverseAcceptMarkerStoreError(
            "marker_state_conflict",
            `reverse-accept marker is ${current.value.preparationState}, not terminal`,
        );
    }
    requireExpectedMarker(current.value, expectedPreparationRevision, expectedMarkerFingerprint);
    return current.value;
}

export function requireExpectedMarker(
    marker: ReverseAcceptPreparationMarkerV1,
    expectedPreparationRevision: number,
    expectedMarkerFingerprint: Sha256Digest,
): void {
    if (marker.preparationRevision !== expectedPreparationRevision || marker.markerFingerprint !== expectedMarkerFingerprint) {
        throw new ReverseAcceptMarkerStoreError("marker_revision_stale", "reverse-accept marker CAS expectation is stale");
    }
}

export function buildLocator(identity: ReverseAcceptPreparationIdentityV1): ReverseAcceptReservationLocatorV1 {
    const preimage = { identity: structuredClone(identity) };
    return {
        ...preimage,
        locatorFingerprint: computeReverseAcceptReservationLocatorFingerprint(preimage),
    };
}

export function readStrictJson<T>(file: string, parse: (value: unknown) => T): ReverseAcceptMarkerReadResult<T> {
    try {
        const text = Buffer.from(readRegularFileNoFollow(file).bytes).toString("utf-8");
        return { state: "available", value: parse(JSON.parse(text) as unknown) };
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
            return { state: "missing" };
        }
        return { state: "unreadable", error };
    }
}

export function ensureAuthorityDirectories(transactionsRoot: string, preparationId: UuidV4): void {
    durableEnsureDirectory(path.dirname(transactionsRoot), path.basename(transactionsRoot));
    durableEnsureDirectory(transactionsRoot, MARKERS_DIRECTORY);
    durableEnsureDirectory(transactionsRoot, LOCATORS_DIRECTORY);
    durableEnsureDirectory(path.join(transactionsRoot, MARKERS_DIRECTORY), preparationId);
}

export function markerPath(transactionsRoot: string, preparationId: UuidV4): string {
    return path.join(transactionsRoot, MARKERS_DIRECTORY, preparationId, MARKER_FILE);
}

export function locatorPath(transactionsRoot: string, preparationId: UuidV4): string {
    return path.join(transactionsRoot, LOCATORS_DIRECTORY, `${preparationId}.json`);
}

export function serializeAuthority(value: unknown): string {
    return `${stableStringify(value)}\n`;
}
