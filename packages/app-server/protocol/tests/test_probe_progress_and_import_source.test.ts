import { describe, expect, it } from "vitest";
import { parseProtocolOperationProgress, parseProtocolOperationResult } from "../src";
import { SHA_A, VALID_RESULTS } from "./fixtures/protocol-fixtures";

describe("probe progress and import-source Protocol contracts", () => {
    it("projects bounded per-Provider probe progress and rejects ambiguous progress shapes", () => {
        expect(
            parseProtocolOperationProgress("adapter.probe", {
                stage: "provider_probe",
                completedUnits: 0,
                totalUnits: 6,
            }),
        ).toEqual({ stage: "provider_probe", completedUnits: 0, totalUnits: 6 });
        expect(
            parseProtocolOperationProgress("adapter.probe", {
                stage: "provider_probe",
                completedUnits: 1,
                totalUnits: 6,
                adapterId: "CLAUDECODE",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                outcome: "partial",
                elapsedMilliseconds: 123,
            }),
        ).toMatchObject({ adapterId: "CLAUDECODE", elapsedMilliseconds: 123 });
        for (const invalid of [
            { stage: "provider_probe", completedUnits: 0, totalUnits: 6, adapterId: "CLAUDECODE" },
            {
                stage: "provider_probe",
                completedUnits: 1,
                totalUnits: 6,
                adapterId: "CLAUDECODE",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                outcome: "partial",
                elapsedMilliseconds: 123,
                unexpected: true,
            },
        ]) {
            expect(() => parseProtocolOperationProgress("adapter.probe", invalid)).toThrow();
        }
    });

    it("keeps import provenance summary structured and fail-closed", () => {
        const value = structuredClone(VALID_RESULTS["asset_version.get"]) as {
            value: { found: true; value: { importSource: { roots: unknown[]; sourceSnapshotFingerprint: string } } };
        };
        expect(parseProtocolOperationResult("asset_version.get", value)).toEqual(value);
        const emptyRoots = structuredClone(value);
        emptyRoots.value.value.importSource.roots = [];
        expect(() => parseProtocolOperationResult("asset_version.get", emptyRoots)).toThrow();
        const badFingerprint = structuredClone(value);
        badFingerprint.value.value.importSource.sourceSnapshotFingerprint = SHA_A.slice(1);
        expect(() => parseProtocolOperationResult("asset_version.get", badFingerprint)).toThrow();
    });
});
