import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderAnalysisView } from "../../src/contracts/render";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import { acquireAllLocks, computeDeploymentOperationKey } from "../../src/foundation/physical-path-locks";
import { recoverReverseAcceptReservation } from "../../src/deployment/deployment-recovery";
import { computeAssetManifestAuthoritySetFingerprint, stableStringify } from "../../src/foundation/fingerprint";
import {
    buildPreparedReverseAcceptMarker,
    buildReverseAcceptPreparationIdentity,
    createReverseAcceptMarkerStore,
    createReverseAcceptMarkerStoreForTest,
    type ReverseAcceptRenderAnalysisValidator,
    type ReverseAcceptMarkerStore,
} from "../../src/reverse/reverse-accept-marker";

const PREPARATION_ID = "00000000-0000-4000-8000-000000000301" as UuidV4;
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000302" as UuidV4;
const OTHER_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000307" as UuidV4;
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000303" as UuidV4;
const ASSET_ID = "00000000-0000-4000-8000-000000000304" as UuidV4;
const VERSION_ID = "00000000-0000-4000-8000-000000000305" as UuidV4;
const PREVIOUS_VERSION_ID = "00000000-0000-4000-8000-000000000306" as UuidV4;
const HASH = `sha256:${"a".repeat(64)}` as Sha256Digest;
const ANALYSIS: RenderAnalysisView = {
    renderInputFingerprint: HASH,
    requiredSemantics: [],
    analyses: [],
};
const VALIDATOR: ReverseAcceptRenderAnalysisValidator = {
    validate(value: unknown): asserts value is RenderAnalysisView {
        if (stableStringify(value) !== stableStringify(ANALYSIS)) throw new Error("bad analysis");
    },
};

let sandbox = "";
let transactionsRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-recovery-"));
    transactionsRoot = path.join(sandbox, "transactions");
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function preparedMarker(deploymentId = DEPLOYMENT_ID) {
    const authorities = [{ assetId: ASSET_ID, assetManifestAuthorityFingerprint: HASH }];
    const identity = buildReverseAcceptPreparationIdentity({
        preparationId: PREPARATION_ID,
        deploymentId,
        commitTransactionId: TRANSACTION_ID,
        assetIds: [ASSET_ID],
    });
    return buildPreparedReverseAcceptMarker(
        {
            identity,
            preparedAt: 1,
            expiresAt: 2,
            deploymentAuthorityFingerprint: HASH,
            assetManifestAuthorities: authorities,
            assetManifestAuthoritySetFingerprint: computeAssetManifestAuthoritySetFingerprint(authorities),
            inspectionScopeFingerprint: HASH,
            inspectionResultFingerprint: HASH,
            stagedAssetId: ASSET_ID,
            stagedVersionId: VERSION_ID,
            stagedVersionFingerprint: HASH,
            stagedVersionOriginDraft: {
                previousVersionId: PREVIOUS_VERSION_ID,
                previousVersionOriginAuthorityFingerprint: HASH,
                promotionRequirement: "not_required",
            },
            renderAnalysis: ANALYSIS,
        },
        VALIDATOR,
    );
}

function publish(): ReturnType<typeof createReverseAcceptMarkerStore> {
    const store = createReverseAcceptMarkerStore(transactionsRoot, VALIDATOR);
    store.publishPrepared(preparedMarker());
    return store;
}

function markerPath(): string {
    return path.join(transactionsRoot, "reverse-accept", PREPARATION_ID, "marker.json");
}

function locatorPath(): string {
    return path.join(transactionsRoot, "reverse-accept-locators", `${PREPARATION_ID}.json`);
}

describe("deployment recovery reverse-accept reservation truth table", () => {
    it("accepts a valid marker and matching locator without rewriting", () => {
        const store = publish();
        const before = fs.readFileSync(locatorPath());
        const result = recoverReverseAcceptReservation(store, transactionsRoot, PREPARATION_ID);
        expect(result).toMatchObject({
            reservationState: "marker_authoritative",
            locatorState: "matched",
            identity: { deploymentId: DEPLOYMENT_ID },
        });
        expect(fs.readFileSync(locatorPath())).toEqual(before);
    });

    it("rebuilds a corrupt locator from the valid marker authority", () => {
        const store = publish();
        fs.writeFileSync(locatorPath(), "{corrupt");
        const result = recoverReverseAcceptReservation(store, transactionsRoot, PREPARATION_ID);
        expect(result).toMatchObject({
            reservationState: "marker_authoritative",
            locatorState: "rebuilt",
        });
        expect(store.readLocator(PREPARATION_ID).state).toBe("available");
    });

    it("uses a valid locator only for scoped freeze when the marker is corrupt", () => {
        const store = publish();
        fs.writeFileSync(markerPath(), "{corrupt");
        expect(recoverReverseAcceptReservation(store, transactionsRoot, PREPARATION_ID)).toMatchObject({
            reservationState: "scoped_freeze",
            identity: { deploymentId: DEPLOYMENT_ID, assetIds: [ASSET_ID] },
        });
    });

    it("requires global freeze when neither marker nor locator can be trusted", () => {
        const store = publish();
        fs.writeFileSync(markerPath(), "{corrupt");
        fs.writeFileSync(locatorPath(), "{corrupt");
        expect(recoverReverseAcceptReservation(store, transactionsRoot, PREPARATION_ID)).toEqual({
            reservationState: "global_freeze",
        });
    });

    it("keeps marker authority but freezes mutation while the preparation mutex is busy", () => {
        const store = publish();
        const operationLock = acquireAllLocks(transactionsRoot, [computeDeploymentOperationKey(DEPLOYMENT_ID)]);
        expect(operationLock).not.toBeNull();
        try {
            expect(recoverReverseAcceptReservation(store, transactionsRoot, PREPARATION_ID)).toMatchObject({
                reservationState: "marker_authoritative_locator_unavailable",
                identity: { deploymentId: DEPLOYMENT_ID },
            });
        } finally {
            operationLock?.release();
        }
    });

    it("keeps marker authority and freeze scope when locator repair itself fails", () => {
        publish();
        fs.writeFileSync(locatorPath(), "{corrupt");
        const faulting = createReverseAcceptMarkerStoreForTest(transactionsRoot, VALIDATOR, {
            beforeLocatorPublish: () => {
                throw new Error("repair failed");
            },
        });
        expect(recoverReverseAcceptReservation(faulting, transactionsRoot, PREPARATION_ID)).toMatchObject({
            reservationState: "marker_authoritative_locator_unavailable",
            identity: { deploymentId: DEPLOYMENT_ID },
        });
    });

    it("treats a discovered ID with both files missing as globally unclassifiable", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, VALIDATOR);
        expect(recoverReverseAcceptReservation(store, transactionsRoot, PREPARATION_ID)).toEqual({
            reservationState: "global_freeze",
        });
    });

    it("reclassifies from locator evidence when the marker disappears after mutex acquisition", () => {
        const base = publish();
        let reads = 0;
        const changing: ReverseAcceptMarkerStore = {
            ...base,
            readMarker(preparationId) {
                reads += 1;
                return reads === 1 ? base.readMarker(preparationId) : { state: "missing" };
            },
        };
        expect(recoverReverseAcceptReservation(changing, transactionsRoot, PREPARATION_ID)).toMatchObject({
            reservationState: "scoped_freeze",
            identity: { deploymentId: DEPLOYMENT_ID },
        });
        expect(reads).toBe(2);
    });

    it("globally freezes when a valid marker changes identity during mutex acquisition", () => {
        const base = publish();
        const locatorBefore = fs.readFileSync(locatorPath());
        const replacement = preparedMarker(OTHER_DEPLOYMENT_ID);
        let reads = 0;
        const changing: ReverseAcceptMarkerStore = {
            ...base,
            readMarker(preparationId) {
                reads += 1;
                return reads === 1 ? base.readMarker(preparationId) : { state: "available", value: replacement };
            },
        };

        expect(recoverReverseAcceptReservation(changing, transactionsRoot, PREPARATION_ID)).toEqual({
            reservationState: "global_freeze",
        });
        expect(reads).toBe(2);
        expect(fs.readFileSync(locatorPath())).toEqual(locatorBefore);
    });
});
