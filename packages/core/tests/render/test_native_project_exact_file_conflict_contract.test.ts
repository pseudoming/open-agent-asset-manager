/** Safe conflict validation for changed exact-native project files. */

import { describe, expect, it } from "vitest";
import {
    EXACT_TARGET_PATH,
    changedExactFileInspection,
    exactMaterializationInput,
    fullExactFileAppliedSnapshot,
    makeExactFileFixture,
} from "./fixtures/native-project-exact-file-test-fixtures";

describe("native project exact-file content conflicts", () => {
    it("accepts a zero-change conflict and rejects missing or unowned attribution", () => {
        const fixture = makeExactFileFixture();
        const materialization = exactMaterializationInput(fixture);
        const inspection = changedExactFileInspection(fixture, materialization);
        const attributed = fixture.support.inspect(inspection);
        const conflict = {
            status: "complete" as const,
            changes: [],
            files: [
                {
                    relativePath: EXACT_TARGET_PATH,
                    attributionState: "conflict" as const,
                    reasonCode: "fixture_content_conflict",
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };

        expect(validate(fixture, materialization, inspection, conflict)).toMatchObject({ coveredChangeFingerprints: [] });

        const missingResultFile = structuredClone(attributed);
        missingResultFile.files = [];
        expect(() => validate(fixture, materialization, inspection, missingResultFile)).toThrow(/violates its policy/);

        const missingChangeReference = structuredClone(attributed);
        const changedResult = missingChangeReference.files[0];
        if (changedResult?.attributionState !== "uniquely_attributable") throw new Error("changed result missing");
        changedResult.changeFingerprints = [];
        expect(() => validate(fixture, materialization, inspection, missingChangeReference)).toThrow(/violates its policy/);

        const conflictWithUnownedChange = structuredClone(conflict);
        conflictWithUnownedChange.changes = structuredClone(attributed.changes);
        expect(() => validate(fixture, materialization, inspection, conflictWithUnownedChange)).toThrow(/violates its policy/);
    });
});

function validate(
    fixture: ReturnType<typeof makeExactFileFixture>,
    materialization: ReturnType<typeof exactMaterializationInput>,
    inspection: ReturnType<typeof changedExactFileInspection>,
    adapterResult: ReturnType<ReturnType<typeof makeExactFileFixture>["support"]["inspect"]>,
) {
    return fixture.registry.validateOutputContractReverseInspection({
        contract: fixture.components.outputContracts[0]!,
        outputUnit: materialization.selection.outputUnits[0]!,
        appliedRenderSnapshot: fullExactFileAppliedSnapshot(inspection.appliedRenderSnapshot),
        inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
        files: inspection.files,
        inventoryDeltas: [],
        adapterResult,
    });
}
