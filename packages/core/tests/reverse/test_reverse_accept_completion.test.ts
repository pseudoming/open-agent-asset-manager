import { describe, expect, it, vi } from "vitest";
import { tryAcquireAuthorityLockLease } from "../../src/foundation/authority-locks";
import { createReverseAcceptMarkerStore, scanReverseAcceptReservations } from "../../src/reverse/reverse-accept-marker";
import {
    finalizeCommittedReverseAcceptPreparation,
    readReverseAcceptReconcileFactsForTest,
    reconcileReverseAcceptPreparation,
    reconcileReverseAcceptPreparationForTest,
} from "../../src/reverse/reverse-accept-reconcile";
import { createReverseAcceptService } from "../../src/reverse/reverse-accept-service";
import type { UuidV4, VersionRef } from "../../src/types";
import {
    ASSET_UUID,
    commitRequest,
    exactAnalysisValidator,
    harness,
    leaveClaimedBeforeFilesystem,
    PREPARATION_ID,
    prepare,
    reconcileConfiguration,
    STAGED_VERSION_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";

const version: VersionRef = { assetId: ASSET_UUID, versionId: STAGED_VERSION_ID };
const other = "11111111-1111-4111-8111-111111111111" as UuidV4;

async function consumed() {
    const service = createReverseAcceptService(harness.configuration());
    await prepare(service);
    const result = await service.commitRenderedTargetAccept(commitRequest(harness.analysis));
    expect(result).toMatchObject({ status: "complete", value: { commitState: "committed", version } });
    return createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
}

describe("exact committed reverse-accept completion", () => {
    it("retires a verified commit and accepts only its matching retired success without rereading later authority", async () => {
        const store = await consumed();
        const configuration = reconcileConfiguration(harness);
        expect(finalizeCommittedReverseAcceptPreparation(configuration, PREPARATION_ID, version)).toEqual({
            reconcileState: "retired",
            terminalState: "consumed",
            preparationRevision: 4,
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "retired", retiredTerminalProof: { terminalState: "consumed" } },
        });
        expect(scanReverseAcceptReservations(harness.transactionsRoot, store).activePreparations).toEqual([]);
        const readFacts = vi.fn(() => {
            throw new Error("retired history must not be reclassified against later state");
        });
        expect(reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, readFacts, version)).toEqual({
            reconcileState: "resolved",
            preparationState: "retired",
        });
        expect(readFacts).not.toHaveBeenCalled();
        expect(() =>
            finalizeCommittedReverseAcceptPreparation(configuration, PREPARATION_ID, { ...version, versionId: other }),
        ).toThrow("does not match");
    });

    it("keeps consumed authority reserved while an Asset lock is busy", async () => {
        const store = await consumed();
        const configuration = reconcileConfiguration(harness);
        const lease = tryAcquireAuthorityLockLease(configuration.authorityLocksRoot, "assets", [ASSET_UUID]);
        expect(lease).not.toBeNull();
        try {
            expect(finalizeCommittedReverseAcceptPreparation(configuration, PREPARATION_ID, version)).toMatchObject({
                reconcileState: "busy",
            });
            expect(store.readMarker(PREPARATION_ID)).toMatchObject({
                state: "available",
                value: { preparationState: "consumed" },
            });
            expect(scanReverseAcceptReservations(harness.transactionsRoot, store).activePreparations).toHaveLength(1);
        } finally {
            lease?.release();
        }
    });

    it("leaves a recoverable consumed marker when retirement publication fails", async () => {
        const store = await consumed();
        const configuration = reconcileConfiguration(harness);
        const failure = new Error("retired marker durable publication failed");
        const faulty = {
            ...store,
            retireTerminal: vi.fn(() => {
                throw failure;
            }),
        };
        expect(() =>
            reconcileReverseAcceptPreparationForTest(
                configuration,
                PREPARATION_ID,
                faulty,
                (config, intent) => readReverseAcceptReconcileFactsForTest(config, intent),
                version,
            ),
        ).toThrow(failure);
        expect(faulty.retireTerminal).toHaveBeenCalledTimes(1);
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "consumed", preparationRevision: 3 },
        });
        expect(scanReverseAcceptReservations(harness.transactionsRoot, store).activePreparations).toHaveLength(1);
    });

    it("rejects a Version binding that changes on the locked reread before repairing its locator", async () => {
        const store = await consumed();
        let reads = 0;
        const repair = vi.fn(store.repairLocatorFromMarker);
        const changed = {
            ...store,
            repairLocatorFromMarker: repair,
            readMarker(preparationId: UuidV4) {
                const result = store.readMarker(preparationId);
                if (++reads === 1 || result.state !== "available" || result.value.preparationState !== "consumed") return result;
                return {
                    state: "available" as const,
                    value: { ...result.value, intent: { ...result.value.intent, stagedVersionId: other } },
                };
            },
        };
        const facts = vi.fn(() => {
            throw new Error("foreign commit must not be observed");
        });
        expect(() =>
            reconcileReverseAcceptPreparationForTest(reconcileConfiguration(harness), PREPARATION_ID, changed, facts, version),
        ).toThrow("does not match");
        expect(repair).not.toHaveBeenCalled();
        expect(facts).not.toHaveBeenCalled();
    });

    it("does not accept a retired failure as successful completion", async () => {
        await leaveClaimedBeforeFilesystem(harness);
        const configuration = reconcileConfiguration(harness);
        expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
        });
        expect(() => finalizeCommittedReverseAcceptPreparation(configuration, PREPARATION_ID, version)).toThrow("does not match");
    });

    it("rejects malformed references and foreign preparation or Asset bindings", async () => {
        const store = await consumed();
        const configuration = reconcileConfiguration(harness);
        for (const invalid of [undefined, { ...version, assetId: "invalid" }, { ...version, versionId: "invalid" }]) {
            expect(() => finalizeCommittedReverseAcceptPreparation(configuration, PREPARATION_ID, invalid as VersionRef)).toThrow(
                "exact Version reference",
            );
        }
        expect(() =>
            finalizeCommittedReverseAcceptPreparation(configuration, PREPARATION_ID, { ...version, assetId: other }),
        ).toThrow("does not match");
        expect(() =>
            reconcileReverseAcceptPreparationForTest(
                configuration,
                PREPARATION_ID,
                store,
                () => {
                    throw new Error("unused");
                },
                { ...version, versionId: "invalid" as UuidV4 },
            ),
        ).toThrow("exact Version reference");
        expect(() =>
            reconcileReverseAcceptPreparationForTest(
                configuration,
                other,
                { ...store, readMarker: () => store.readMarker(PREPARATION_ID) },
                () => {
                    throw new Error("unused");
                },
                version,
            ),
        ).toThrow("does not match");
    });
});
