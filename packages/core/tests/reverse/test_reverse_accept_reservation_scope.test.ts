import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { reverseAcceptScanBlocksScope, scanReverseAcceptReservations } from "../../src/reverse/reverse-accept-marker";
import type { UuidV4 } from "../../src/types";
import {
    ASSET_UUID,
    DEPLOYMENT_UUID,
    harness,
    leaveClaimedBeforeFilesystem,
    PREPARATION_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";

describe("reverse-accept reservation scope", () => {
    it("freezes active reservations and uses a valid locator to scope corrupt markers", async () => {
        const store = await leaveClaimedBeforeFilesystem(harness);
        const active = scanReverseAcceptReservations(harness.transactionsRoot, store);
        expect(active.globalFreeze).toBe(false);
        expect(reverseAcceptScanBlocksScope(active, { deploymentId: DEPLOYMENT_UUID })).toBe(true);
        expect(reverseAcceptScanBlocksScope(active, { assetIds: [ASSET_UUID] })).toBe(true);
        expect(reverseAcceptScanBlocksScope(active, { deploymentId: DEPLOYMENT_UUID }, [PREPARATION_ID])).toBe(false);
        expect(
            reverseAcceptScanBlocksScope(active, {
                deploymentId: "22222222-2222-4222-8222-222222222222" as UuidV4,
                assetIds: [],
            }),
        ).toBe(false);

        const secondPreparationId = "11111111-1111-4111-8111-111111111111" as UuidV4;
        fs.mkdirSync(path.join(harness.transactionsRoot, "reverse-accept", secondPreparationId));
        const existing = store.readMarker(PREPARATION_ID);
        if (existing.state !== "available") throw new Error("active marker fixture missing");
        const multipleStore = {
            ...store,
            readMarker(preparationId: UuidV4) {
                if (preparationId !== secondPreparationId) return store.readMarker(preparationId);
                return {
                    state: "available" as const,
                    value: {
                        ...existing.value,
                        identity: {
                            ...existing.value.identity,
                            preparationId: secondPreparationId,
                        },
                    },
                };
            },
        };
        expect(
            scanReverseAcceptReservations(harness.transactionsRoot, multipleStore).activePreparations.map(
                (identity) => identity.preparationId,
            ),
        ).toEqual([secondPreparationId, PREPARATION_ID]);
        const thirdPreparationId = "99999999-9999-4999-8999-999999999998" as UuidV4;
        fs.mkdirSync(path.join(harness.transactionsRoot, "reverse-accept", thirdPreparationId));
        const threeStore = {
            ...multipleStore,
            readMarker(preparationId: UuidV4) {
                if (preparationId !== thirdPreparationId) {
                    return multipleStore.readMarker(preparationId);
                }
                return {
                    state: "available" as const,
                    value: {
                        ...existing.value,
                        identity: { ...existing.value.identity, preparationId: thirdPreparationId },
                    },
                };
            },
        };
        expect(
            scanReverseAcceptReservations(harness.transactionsRoot, threeStore).activePreparations.map(
                (identity) => identity.preparationId,
            ),
        ).toEqual([secondPreparationId, PREPARATION_ID, thirdPreparationId]);
        fs.rmSync(path.join(harness.transactionsRoot, "reverse-accept", thirdPreparationId), {
            recursive: true,
            force: true,
        });
        fs.rmSync(path.join(harness.transactionsRoot, "reverse-accept", secondPreparationId), {
            recursive: true,
            force: true,
        });
        const existingLocator = store.readLocator(PREPARATION_ID);
        if (existingLocator.state !== "available") {
            throw new Error("prepared locator fixture missing");
        }
        const locatorOnlyPath = path.join(harness.transactionsRoot, "reverse-accept-locators", `${secondPreparationId}.json`);
        fs.writeFileSync(locatorOnlyPath, "{}");
        const locatorOnlyStore = {
            ...store,
            readLocator(preparationId: UuidV4) {
                if (preparationId !== secondPreparationId) return store.readLocator(preparationId);
                return {
                    state: "available" as const,
                    value: {
                        ...existingLocator.value,
                        identity: {
                            ...existingLocator.value.identity,
                            preparationId: secondPreparationId,
                        },
                    },
                };
            },
        };
        expect(
            scanReverseAcceptReservations(harness.transactionsRoot, locatorOnlyStore).activePreparations.map(
                (identity) => identity.preparationId,
            ),
        ).toEqual([secondPreparationId, PREPARATION_ID]);
        fs.rmSync(locatorOnlyPath, { force: true });

        const invalidEntry = path.join(harness.transactionsRoot, "reverse-accept", "not-a-uuid");
        fs.mkdirSync(invalidEntry);
        expect(scanReverseAcceptReservations(harness.transactionsRoot, store).globalFreeze).toBe(true);
        fs.rmSync(invalidEntry, { recursive: true, force: true });
        const outside = path.join(harness.root, "outside-marker");
        fs.mkdirSync(outside);
        const linkedEntry = path.join(harness.transactionsRoot, "reverse-accept", "linked");
        fs.symlinkSync(outside, linkedEntry);
        expect(scanReverseAcceptReservations(harness.transactionsRoot, store).globalFreeze).toBe(true);
        expect(reverseAcceptScanBlocksScope(scanReverseAcceptReservations(harness.transactionsRoot, store), {})).toBe(true);
        fs.rmSync(linkedEntry, { force: true });

        const invalidLocatorEntry = path.join(harness.transactionsRoot, "reverse-accept-locators", "not-json");
        fs.writeFileSync(invalidLocatorEntry, "not a locator");
        expect(scanReverseAcceptReservations(harness.transactionsRoot, store).globalFreeze).toBe(true);
        fs.rmSync(invalidLocatorEntry, { force: true });

        fs.writeFileSync(path.join(harness.transactionsRoot, "reverse-accept", PREPARATION_ID, "marker.json"), "{corrupt");
        const scoped = scanReverseAcceptReservations(harness.transactionsRoot, store);
        expect(scoped).toMatchObject({ globalFreeze: false });
        expect(reverseAcceptScanBlocksScope(scoped, { deploymentId: DEPLOYMENT_UUID })).toBe(true);
        fs.writeFileSync(path.join(harness.transactionsRoot, "reverse-accept-locators", `${PREPARATION_ID}.json`), "{corrupt");
        expect(scanReverseAcceptReservations(harness.transactionsRoot, store).globalFreeze).toBe(true);

        const emptyTransactionsRoot = path.join(harness.root, "empty-transactions");
        fs.mkdirSync(emptyTransactionsRoot);
        expect(
            scanReverseAcceptReservations(emptyTransactionsRoot, {
                ...store,
                readMarker: store.readMarker,
                readLocator: store.readLocator,
            }),
        ).toEqual({ globalFreeze: false, activePreparations: [] });
    });
});
