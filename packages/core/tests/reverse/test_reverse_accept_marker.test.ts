import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderAnalysisView } from "../../src/contracts/render";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import {
    computeAssetManifestAuthoritySetFingerprint,
    computeReverseAcceptMarkerFingerprint,
    computeReverseAcceptPreparationIdentityFingerprint,
    computeReverseAcceptReservationLocatorFingerprint,
    stableStringify,
} from "../../src/foundation/fingerprint";
import {
    ReverseAcceptMarkerStoreError,
    buildPreparedReverseAcceptMarker,
    buildReverseAcceptPreparationIdentity,
    createReverseAcceptMarkerStore,
    createReverseAcceptMarkerStoreForTest,
    type PreparedAssetManifestAuthority,
    type PreparedRenderedTargetAccept,
    type ReverseAcceptRenderAnalysisValidator,
} from "../../src/reverse/reverse-accept-marker";

const PREPARATION_ID = "00000000-0000-4000-8000-000000000101" as UuidV4;
const OTHER_PREPARATION_ID = "00000000-0000-4000-8000-000000000108" as UuidV4;
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000102" as UuidV4;
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000103" as UuidV4;
const ASSET_A = "00000000-0000-4000-8000-000000000104" as UuidV4;
const ASSET_B = "00000000-0000-4000-8000-000000000105" as UuidV4;
const VERSION_ID = "00000000-0000-4000-8000-000000000106" as UuidV4;
const PREVIOUS_VERSION_ID = "00000000-0000-4000-8000-000000000107" as UuidV4;
const HASH_1 = `sha256:${"1".repeat(64)}` as Sha256Digest;
const HASH_2 = `sha256:${"2".repeat(64)}` as Sha256Digest;
const HASH_3 = `sha256:${"3".repeat(64)}` as Sha256Digest;
const HASH_4 = `sha256:${"4".repeat(64)}` as Sha256Digest;

const ANALYSIS: RenderAnalysisView = {
    renderInputFingerprint: HASH_1,
    requiredSemantics: [],
    analyses: [],
};

const ANALYSIS_VALIDATOR: ReverseAcceptRenderAnalysisValidator = {
    validate(value: unknown): asserts value is RenderAnalysisView {
        if (stableStringify(value) !== stableStringify(ANALYSIS)) {
            throw new Error("render analysis fixture mismatch");
        }
    },
};

let sandbox = "";
let transactionsRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-marker-"));
    transactionsRoot = path.join(sandbox, "transactions");
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function authorities(): PreparedAssetManifestAuthority[] {
    return [
        { assetId: ASSET_A, assetManifestAuthorityFingerprint: HASH_1 },
        { assetId: ASSET_B, assetManifestAuthorityFingerprint: HASH_2 },
    ];
}

function marker(): PreparedRenderedTargetAccept {
    const assetAuthorities = authorities();
    const identity = buildReverseAcceptPreparationIdentity({
        preparationId: PREPARATION_ID,
        deploymentId: DEPLOYMENT_ID,
        commitTransactionId: TRANSACTION_ID,
        assetIds: assetAuthorities.map((item) => item.assetId),
    });
    return buildPreparedReverseAcceptMarker(
        {
            identity,
            preparedAt: 1_000,
            expiresAt: 2_000,
            deploymentAuthorityFingerprint: HASH_1,
            assetManifestAuthorities: assetAuthorities,
            assetManifestAuthoritySetFingerprint: computeAssetManifestAuthoritySetFingerprint(assetAuthorities),
            inspectionScopeFingerprint: HASH_2,
            inspectionResultFingerprint: HASH_3,
            stagedAssetId: ASSET_A,
            stagedVersionId: VERSION_ID,
            stagedVersionFingerprint: HASH_4,
            stagedVersionOriginDraft: {
                previousVersionId: PREVIOUS_VERSION_ID,
                previousVersionOriginAuthorityFingerprint: HASH_2,
                promotionRequirement: "requires_current_authorization",
            },
            renderAnalysis: ANALYSIS,
        },
        ANALYSIS_VALIDATOR,
    );
}

function markerFile(): string {
    return path.join(transactionsRoot, "reverse-accept", PREPARATION_ID, "marker.json");
}

function locatorFile(): string {
    return path.join(transactionsRoot, "reverse-accept-locators", `${PREPARATION_ID}.json`);
}

describe("reverse-accept marker/locator authority", () => {
    it("publishes marker first, locator second, and reopens both exact authorities", () => {
        const events: string[] = [];
        const store = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            beforeMarkerPublish: () => events.push("before-marker"),
            afterMarkerPublish: () => events.push("after-marker"),
            beforeLocatorPublish: () => events.push("before-locator"),
            afterLocatorPublish: () => events.push("after-locator"),
        });
        const prepared = marker();
        store.publishPrepared(prepared);

        expect(events).toEqual(["before-marker", "after-marker", "before-locator", "after-locator"]);
        expect(store.readMarker(PREPARATION_ID)).toEqual({
            state: "available",
            value: prepared,
        });
        const locator = store.readLocator(PREPARATION_ID);
        expect(locator.state).toBe("available");
        if (locator.state === "available") {
            expect(locator.value.identity).toEqual(prepared.identity);
        }
        expect(store.repairLocatorFromMarker(prepared)).toBe("matched");
    });

    it("leaves no authority when failure occurs before marker publication", () => {
        const store = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            beforeMarkerPublish: () => {
                throw new Error("kill-before-marker");
            },
        });
        expect(() => store.publishPrepared(marker())).toThrow("kill-before-marker");
        expect(store.readMarker(PREPARATION_ID)).toEqual({ state: "missing" });
        expect(store.readLocator(PREPARATION_ID)).toEqual({ state: "missing" });
    });

    it("keeps the durable marker and no locator when failure occurs after marker publication", () => {
        const store = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            afterMarkerPublish: () => {
                throw new Error("kill-after-marker");
            },
        });
        expect(() => store.publishPrepared(marker())).toThrow("kill-after-marker");
        expect(store.readMarker(PREPARATION_ID).state).toBe("available");
        expect(store.readLocator(PREPARATION_ID)).toEqual({ state: "missing" });
    });

    it("does not report publication success when locator publication fails and can rebuild it", () => {
        const faulting = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            beforeLocatorPublish: () => {
                throw new Error("locator-failed");
            },
        });
        const prepared = marker();
        expect(() => faulting.publishPrepared(prepared)).toThrow("locator-failed");
        expect(faulting.readMarker(PREPARATION_ID).state).toBe("available");
        expect(faulting.readLocator(PREPARATION_ID)).toEqual({ state: "missing" });

        const production = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        expect(production.repairLocatorFromMarker(prepared)).toBe("rebuilt");
        expect(production.repairLocatorFromMarker(prepared)).toBe("matched");
    });

    it("valid marker replaces a corrupt or mismatched locator but a corrupt marker stays unreadable", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const prepared = marker();
        store.publishPrepared(prepared);
        fs.writeFileSync(locatorFile(), "{bad json");
        expect(store.readLocator(PREPARATION_ID).state).toBe("unreadable");
        expect(store.repairLocatorFromMarker(prepared)).toBe("rebuilt");

        const locator = JSON.parse(fs.readFileSync(locatorFile(), "utf-8")) as Record<string, unknown>;
        locator.locatorFingerprint = HASH_4;
        fs.writeFileSync(locatorFile(), JSON.stringify(locator));
        expect(store.readLocator(PREPARATION_ID).state).toBe("unreadable");
        expect(store.repairLocatorFromMarker(prepared)).toBe("rebuilt");

        const rawMarker = JSON.parse(fs.readFileSync(markerFile(), "utf-8")) as Record<string, unknown>;
        rawMarker.markerFingerprint = HASH_1;
        fs.writeFileSync(markerFile(), JSON.stringify(rawMarker));
        expect(store.readMarker(PREPARATION_ID).state).toBe("unreadable");
        expect(store.readLocator(PREPARATION_ID).state).toBe("available");
    });

    it("rejects a valid authority copied under a different preparation path", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        store.publishPrepared(marker());
        const copiedMarker = path.join(transactionsRoot, "reverse-accept", OTHER_PREPARATION_ID, "marker.json");
        const copiedLocator = path.join(transactionsRoot, "reverse-accept-locators", `${OTHER_PREPARATION_ID}.json`);
        fs.mkdirSync(path.dirname(copiedMarker), { recursive: true });
        fs.copyFileSync(markerFile(), copiedMarker);
        fs.copyFileSync(locatorFile(), copiedLocator);

        expect(store.readMarker(OTHER_PREPARATION_ID).state).toBe("unreadable");
        expect(store.readLocator(OTHER_PREPARATION_ID).state).toBe("unreadable");
        expect(store.readMarker(PREPARATION_ID).state).toBe("available");
        expect(store.readLocator(PREPARATION_ID).state).toBe("available");
    });

    it("transitions prepared to cancelled with expected revision/fingerprint CAS", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const prepared = marker();
        store.publishPrepared(prepared);
        const cancelled = store.transitionPrepared(PREPARATION_ID, 1, prepared.markerFingerprint, "cancelled");
        expect(cancelled).toMatchObject({
            preparationState: "cancelled",
            preparationRevision: 2,
            identity: prepared.identity,
        });
        expect(store.readMarker(PREPARATION_ID)).toEqual({
            state: "available",
            value: cancelled,
        });
        expect(() => store.transitionPrepared(PREPARATION_ID, 1, prepared.markerFingerprint, "expired")).toThrow(
            /already cancelled/,
        );
    });

    it("rejects stale transition expectations and supports the distinct expired terminal branch", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const prepared = marker();
        store.publishPrepared(prepared);
        expect(() => store.transitionPrepared(PREPARATION_ID, 2, prepared.markerFingerprint, "expired")).toThrow(
            /CAS expectation is stale/,
        );
        const expired = store.transitionPrepared(PREPARATION_ID, 1, prepared.markerFingerprint, "expired");
        expect(expired.preparationState).toBe("expired");
        expect(expired.preparationRevision).toBe(2);
    });

    it("rejects consume/fail when the claimed marker is missing or still prepared", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        expect(() => store.consumeClaimed(PREPARATION_ID, 2, HASH_1, {} as never)).toThrow(/marker is unavailable/);
        const prepared = marker();
        store.publishPrepared(prepared);
        expect(() =>
            store.failClaimed(PREPARATION_ID, 1, prepared.markerFingerprint, {
                filesystemTerminalState: "pre_authority",
            }),
        ).toThrow(/already prepared/);
    });

    it("rejects duplicate initial publication and an orphan locator collision", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const prepared = marker();
        store.publishPrepared(prepared);
        expect(() => store.publishPrepared(prepared)).toThrow(/marker already exists/);

        fs.rmSync(path.dirname(markerFile()), { recursive: true, force: true });
        expect(() => store.publishPrepared(prepared)).toThrow(/locator already exists/);
    });

    it("rejects noncanonical roots, unsafe IDs, and duplicate Asset IDs", () => {
        expect(() => createReverseAcceptMarkerStore("relative", ANALYSIS_VALIDATOR)).toThrow(/canonical absolute/);
        expect(() => createReverseAcceptMarkerStore("/", ANALYSIS_VALIDATOR)).toThrow(/canonical absolute/);
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        expect(() => store.readMarker("../escape" as UuidV4)).toThrow(/UUID v4/);
        expect(() =>
            buildReverseAcceptPreparationIdentity({
                preparationId: PREPARATION_ID,
                deploymentId: DEPLOYMENT_ID,
                commitTransactionId: TRANSACTION_ID,
                assetIds: [ASSET_A, ASSET_A],
            }),
        ).toThrow(/sorted unique/);
    });

    it("rejects marker field, authority, TTL, origin, analysis, and fingerprint tampering", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const valid = marker();
        const invalids: unknown[] = [
            null,
            {},
            { ...valid, extra: true },
            { ...valid, preparationRevision: 2 },
            { ...valid, preparedAt: -1 },
            { ...valid, expiresAt: -1 },
            { ...valid, expiresAt: valid.preparedAt },
            { ...valid, stagedAssetId: "bad" },
            { ...valid, stagedVersionId: "bad" },
            { ...valid, stagedAssetId: PREVIOUS_VERSION_ID },
            { ...valid, deploymentAuthorityFingerprint: "bad" },
            { ...valid, assetManifestAuthoritySetFingerprint: HASH_1 },
            { ...valid, assetManifestAuthorities: null },
            { ...valid, assetManifestAuthorities: [valid.assetManifestAuthorities[0]] },
            { ...valid, assetManifestAuthorities: [null, valid.assetManifestAuthorities[1]] },
            {
                ...valid,
                assetManifestAuthorities: [
                    { ...valid.assetManifestAuthorities[0], extra: true },
                    valid.assetManifestAuthorities[1],
                ],
            },
            {
                ...valid,
                assetManifestAuthorities: [
                    { ...valid.assetManifestAuthorities[0], assetId: "bad" },
                    valid.assetManifestAuthorities[1],
                ],
            },
            {
                ...valid,
                assetManifestAuthorities: [
                    {
                        ...valid.assetManifestAuthorities[0],
                        assetManifestAuthorityFingerprint: "bad",
                    },
                    valid.assetManifestAuthorities[1],
                ],
            },
            {
                ...valid,
                assetManifestAuthorities: [valid.assetManifestAuthorities[1], valid.assetManifestAuthorities[0]],
            },
            { ...valid, stagedVersionOriginDraft: null },
            {
                ...valid,
                stagedVersionOriginDraft: {
                    ...valid.stagedVersionOriginDraft,
                    extra: true,
                },
            },
            {
                ...valid,
                stagedVersionOriginDraft: {
                    ...valid.stagedVersionOriginDraft,
                    previousVersionId: "bad",
                },
            },
            {
                ...valid,
                stagedVersionOriginDraft: {
                    ...valid.stagedVersionOriginDraft,
                    previousVersionOriginAuthorityFingerprint: "bad",
                },
            },
            {
                ...valid,
                stagedVersionOriginDraft: {
                    ...valid.stagedVersionOriginDraft,
                    promotionRequirement: "bad",
                },
            },
            { ...valid, renderAnalysis: { ...ANALYSIS, analyses: [{ bad: true }] } },
            { ...valid, markerFingerprint: HASH_1 },
        ];
        for (const invalid of invalids) {
            expect(() => store.publishPrepared(invalid as PreparedRenderedTargetAccept)).toThrow();
        }
    });

    it("rejects every malformed preparation identity component before publication", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const valid = marker();
        const identityCases: unknown[] = [
            null,
            { ...valid.identity, extra: true },
            { ...valid.identity, schemaVersion: 2 },
            { ...valid.identity, preparationId: "bad" },
            { ...valid.identity, deploymentId: "bad" },
            { ...valid.identity, commitTransactionId: "bad" },
            { ...valid.identity, assetIds: [] },
            { ...valid.identity, assetIds: [ASSET_B, ASSET_A] },
            { ...valid.identity, assetIds: ["bad"] },
            { ...valid.identity, preparationIdentityFingerprint: "bad" },
            { ...valid.identity, preparationIdentityFingerprint: HASH_1 },
        ];
        for (const identity of identityCases) {
            expect(() =>
                store.publishPrepared({
                    ...valid,
                    identity,
                } as PreparedRenderedTargetAccept),
            ).toThrow();
        }
        expect(() =>
            buildReverseAcceptPreparationIdentity({
                preparationId: PREPARATION_ID,
                deploymentId: DEPLOYMENT_ID,
                commitTransactionId: TRANSACTION_ID,
                assetIds: [] as UuidV4[],
            }),
        ).toThrow(/sorted unique/);
    });

    it("rejects malformed terminal marker and locator branches on reopen", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        const prepared = marker();
        store.publishPrepared(prepared);
        const cancelled = store.transitionPrepared(PREPARATION_ID, 1, prepared.markerFingerprint, "cancelled");
        const markerCases: unknown[] = [
            { ...cancelled, extra: true },
            { ...cancelled, preparationRevision: 1 },
            { ...cancelled, preparationState: "future" },
            { ...cancelled, markerFingerprint: "bad" },
        ];
        for (const value of markerCases) {
            fs.writeFileSync(markerFile(), JSON.stringify(value));
            expect(store.readMarker(PREPARATION_ID).state).toBe("unreadable");
        }

        const locator = store.readLocator(PREPARATION_ID);
        if (locator.state !== "available") throw new Error("fixture locator missing");
        for (const value of [
            { ...locator.value, extra: true },
            { ...locator.value, locatorFingerprint: "bad" },
            { ...locator.value, locatorFingerprint: HASH_1 },
        ]) {
            fs.writeFileSync(locatorFile(), JSON.stringify(value));
            expect(store.readLocator(PREPARATION_ID).state).toBe("unreadable");
        }
    });

    it("detects exact read-back mismatch after each durable publication step", () => {
        const expected = marker();
        const {
            markerFingerprint: _markerFingerprint,
            preparationRevision: _preparationRevision,
            preparationState: _preparationState,
            ...preparedBase
        } = expected;
        const differentPrepared = buildPreparedReverseAcceptMarker(
            { ...preparedBase, expiresAt: expected.expiresAt + 1 },
            ANALYSIS_VALIDATOR,
        );
        const markerMismatch = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            afterMarkerPublish: () => fs.writeFileSync(markerFile(), `${stableStringify(differentPrepared)}\n`),
        });
        expect(() => markerMismatch.publishPrepared(expected)).toThrow(/did not reopen/);

        fs.rmSync(transactionsRoot, { recursive: true, force: true });
        const otherIdentityPreimage = {
            schemaVersion: 1 as const,
            preparationId: PREPARATION_ID,
            deploymentId: "00000000-0000-4000-8000-000000000199" as UuidV4,
            commitTransactionId: TRANSACTION_ID,
            assetIds: [ASSET_A, ASSET_B],
        };
        const otherIdentity = {
            ...otherIdentityPreimage,
            preparationIdentityFingerprint: computeReverseAcceptPreparationIdentityFingerprint(otherIdentityPreimage),
        };
        const otherLocatorPreimage = { identity: otherIdentity };
        const otherLocator = {
            ...otherLocatorPreimage,
            locatorFingerprint: computeReverseAcceptReservationLocatorFingerprint(otherLocatorPreimage),
        };
        const locatorMismatch = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            afterLocatorPublish: () => fs.writeFileSync(locatorFile(), `${stableStringify(otherLocator)}\n`),
        });
        expect(() => locatorMismatch.publishPrepared(expected)).toThrow(/locator did not reopen/);

        fs.rmSync(transactionsRoot, { recursive: true, force: true });
        const transitionMismatch = createReverseAcceptMarkerStoreForTest(transactionsRoot, ANALYSIS_VALIDATOR, {
            afterMarkerTransition: (next) => {
                const preimage = {
                    identity: next.identity,
                    preparationRevision: next.preparationRevision + 1,
                    preparationState: next.preparationState,
                } as const;
                const different = {
                    ...preimage,
                    markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
                };
                fs.writeFileSync(markerFile(), `${stableStringify(different)}\n`);
            },
        });
        transitionMismatch.publishPrepared(expected);
        expect(() => transitionMismatch.transitionPrepared(PREPARATION_ID, 1, expected.markerFingerprint, "cancelled")).toThrow(
            /transitioned marker did not reopen/,
        );
    });

    it("rejects invalid transition arguments and missing markers without creating files", () => {
        const store = createReverseAcceptMarkerStore(transactionsRoot, ANALYSIS_VALIDATOR);
        expect(() => store.transitionPrepared(PREPARATION_ID, 0, HASH_1, "cancelled")).toThrow(/positive safe integer/);
        expect(() => store.transitionPrepared(PREPARATION_ID, 1, "bad" as Sha256Digest, "cancelled")).toThrow(/SHA-256/);
        expect(() => store.transitionPrepared(PREPARATION_ID, 1, HASH_1, "cancelled")).toThrow(/unavailable/);
        expect(fs.existsSync(markerFile())).toBe(false);
    });
});
