/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import type { AdapterRenderedTargetInspectionResult } from "../../src/contracts/reverse";
import { inspectRenderedTarget } from "../../src/render/render-inspection";
import {
    computeAttributedSemanticChangeFingerprint,
    computeRenderedTargetAttributeChangeFingerprint,
} from "../../src/foundation/fingerprint";
import { inspectionFixture, adapterResult, run, refreshScope } from "./fixtures/render-inspection-test-fixtures";

describe("rendered target inspection validation and reverse proof closure", () => {
    it("canonicalizes two independently attributed semantic changes", async () => {
        const fixture = await inspectionFixture();
        const result = adapterResult(fixture);
        const first = result.changes[0];
        const file = result.files[0];
        if (first?.changeKind !== "file_content_replacement" || file?.attributionState !== "uniquely_attributable") {
            throw new Error("fixture attribution mismatch");
        }
        const secondPreimage = {
            changeKind: "file_content_replacement" as const,
            semanticRefFingerprints: [...first.semanticRefFingerprints],
            replacementContent: { contentKind: "text" as const, text: "# second change\n" },
        };
        const second = {
            ...secondPreimage,
            changeFingerprint: computeAttributedSemanticChangeFingerprint({
                inspectionScopeFingerprint: fixture.inspection.inspectionScope.inspectionScopeFingerprint,
                change: secondPreimage,
            }),
        };
        result.changes.push(second);
        result.changes.sort((left, right) => left.changeFingerprint.localeCompare(right.changeFingerprint));
        file.changeFingerprints = result.changes.map((change) => change.changeFingerprint).sort();
        const inspected = await run(fixture, result);
        expect(inspected.status).toBe("complete");
        expect(inspected.value.changes).toHaveLength(2);
    });

    it("returns an exact empty result for a wholly unchanged scope without dispatch", async () => {
        const fixture = await inspectionFixture();
        fixture.inspection.inspectionScope.fileStates[0]!.state = "unchanged";
        fixture.inspection.files = [];
        refreshScope(fixture);
        let calls = 0;
        const result = await inspectRenderedTarget(
            { appliedRenderSnapshot: fixture.snapshot, inspection: fixture.inspection },
            {
                registry: fixture.registry,
                dispatch: async () => {
                    calls += 1;
                    throw new Error("must not dispatch");
                },
            },
        );
        expect(result.status).toBe("complete");
        expect(result.value.changes).toEqual([]);
        expect(result.value.files).toEqual([]);
        expect(result.value.reverseCoverageProofs).toEqual([]);
        expect(calls).toBe(0);
    });

    it("rejects schema, deployment identity, safe-snapshot, and scope-fingerprint drift", async () => {
        const cases: Array<[string, (fixture: Awaited<ReturnType<typeof inspectionFixture>>) => void]> = [
            [
                "render.inspection_snapshot_mismatch",
                (fixture) => {
                    fixture.inspection.schemaVersion = 2 as never;
                },
            ],
            [
                "render.inspection_snapshot_mismatch",
                (fixture) => {
                    fixture.inspection.deploymentId = "foreign";
                },
            ],
            [
                "render.inspection_snapshot_mismatch",
                (fixture) => {
                    fixture.inspection.appliedRenderSnapshot.decisions = [];
                },
            ],
            [
                "render.inspection_scope_fingerprint_mismatch",
                (fixture) => {
                    fixture.inspection.inspectionScope.inspectionScopeFingerprint = `sha256:${"f".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const fixture = await inspectionFixture();
            mutate(fixture);
            const result = await run(fixture);
            expect(result.diagnostics[0]?.code).toBe(code);
        }
    });

    it("rejects duplicate, noncanonical, foreign-unit, and malformed scope file states", async () => {
        const cases: Array<(fixture: Awaited<ReturnType<typeof inspectionFixture>>) => void> = [
            (fixture) => {
                fixture.inspection.inspectionScope.fileStates.push(
                    structuredClone(fixture.inspection.inspectionScope.fileStates[0]!),
                );
                refreshScope(fixture);
            },
            (fixture) => {
                fixture.inspection.inspectionScope.fileStates[0]!.relativePath = "../escape";
                fixture.inspection.files[0]!.relativePath = "../escape";
                refreshScope(fixture);
            },
            (fixture) => {
                fixture.inspection.inspectionScope.fileStates[0]!.outputUnitFingerprint = `sha256:${"f".repeat(64)}`;
                refreshScope(fixture);
            },
            (fixture) => {
                const state = fixture.inspection.inspectionScope.fileStates[0]!;
                if (state.state === "changed") state.currentContentHash = "bad" as never;
                refreshScope(fixture);
            },
        ];
        for (const mutate of cases) {
            const fixture = await inspectionFixture();
            mutate(fixture);
            expect((await run(fixture)).status).toBe("failed");
        }
    });

    it("rejects changed-file branch, bytes, provenance, hunk, and attribute lies", async () => {
        const cases: Array<(fixture: Awaited<ReturnType<typeof inspectionFixture>>) => void> = [
            (fixture) => {
                fixture.inspection.files[0]!.fileState = "baseline_missing" as never;
            },
            (fixture) => {
                const file = fixture.inspection.files[0]!;
                if (file.fileState === "baseline_changed") file.currentContent.text = "different";
            },
            (fixture) => {
                const file = fixture.inspection.files[0]!;
                if (file.fileState === "baseline_changed") {
                    file.provenance.provenanceFingerprint = `sha256:${"f".repeat(64)}`;
                }
            },
            (fixture) => {
                fixture.inspection.files[0]!.diffHunks[0]!.appliedStartByte = -1;
            },
            (fixture) => {
                fixture.inspection.files[0]!.diffHunks[0]!.hunkFingerprint = `sha256:${"f".repeat(64)}`;
            },
            (fixture) => {
                const file = fixture.inspection.files[0]!;
                if (file.fileState !== "baseline_changed") return;
                const preimage = {
                    attributeKind: "executable" as const,
                    appliedValue: false,
                    currentValue: true,
                };
                file.attributeChanges = [
                    {
                        ...preimage,
                        attributeChangeFingerprint: computeRenderedTargetAttributeChangeFingerprint({
                            relativePath: file.relativePath,
                            inspectionScopeFingerprint: fixture.inspection.inspectionScope.inspectionScopeFingerprint,
                            change: preimage,
                        }),
                    },
                ];
                file.attributeChanges[0]!.currentValue = false;
            },
        ];
        for (const mutate of cases) {
            const fixture = await inspectionFixture();
            mutate(fixture);
            expect((await run(fixture)).status).toBe("failed");
        }
    });

    it("rejects failed providers, preserves partial status, and rejects invalid result/file/change closures", async () => {
        const fixture = await inspectionFixture();
        expect((await run(fixture, adapterResult(fixture), "failed")).diagnostics[0]?.code).toBe(
            "render.inspection_provider_failed",
        );
        expect((await run(fixture, adapterResult(fixture), "partial")).status).toBe("partial");
        const cases: Array<(result: AdapterRenderedTargetInspectionResult) => void> = [
            (result) => {
                result.status = "failed";
            },
            (result) => {
                result.changes = null as never;
            },
            (result) => {
                result.files = null as never;
            },
            (result) => {
                result.diagnostics = null as never;
            },
            (result) => {
                result.files = [];
            },
            (result) => {
                result.files.push(structuredClone(result.files[0]!));
            },
            (result) => {
                result.changes[0]!.changeFingerprint = `sha256:${"f".repeat(64)}`;
            },
            (result) => {
                result.changes[0]!.semanticRefFingerprints = [];
            },
            (result) => {
                if (result.files[0]!.attributionState === "uniquely_attributable") {
                    result.files[0]!.changeFingerprints = [];
                }
            },
            (result) => {
                if (result.files[0]!.attributionState === "uniquely_attributable") {
                    result.files[0]!.changeFingerprints = [`sha256:${"e".repeat(64)}`];
                }
            },
            (result) => {
                if (result.files[0]!.attributionState === "uniquely_attributable") {
                    result.files[0]!.hunkAttributions = [];
                }
            },
            (result) => {
                const file = result.files[0];
                if (file?.attributionState === "uniquely_attributable") {
                    file.hunkAttributions[0]!.semanticRefFingerprints = [];
                }
            },
        ];
        for (const mutate of cases) {
            const result = adapterResult(fixture);
            mutate(result);
            expect((await run(fixture, result)).status).toBe("failed");
        }
    });

    it("supports explicit whole-file adoption and requires a nonblank conflict reason", async () => {
        const fixture = await inspectionFixture();
        const whole: AdapterRenderedTargetInspectionResult = {
            status: "complete",
            changes: [],
            files: [
                {
                    relativePath: fixture.target.relativePath,
                    attributionState: "whole_file_adoption_required",
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
        expect((await run(fixture, whole)).status).toBe("complete");
        const conflict: AdapterRenderedTargetInspectionResult = {
            status: "complete",
            changes: [],
            files: [
                {
                    relativePath: fixture.target.relativePath,
                    attributionState: "conflict",
                    reasonCode: "",
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
        expect((await run(fixture, conflict)).diagnostics[0]?.code).toBe("render.inspection_conflict_reason_missing");
        conflict.files[0] = { ...conflict.files[0], reasonCode: "ambiguous_marker" } as never;
        expect((await run(fixture, conflict)).status).toBe("complete");
    });

    it("rejects stale, malformed, missing, duplicated, or foreign reverse proofs", async () => {
        const mutations: Array<(proof: import("../../src/contracts/reverse").ReverseInspectionCoverageProof) => void> = [
            (proof) => {
                proof.outputUnitFingerprint = `sha256:${"f".repeat(64)}`;
            },
            (proof) => {
                proof.reverseCoverageFingerprint = "bad" as never;
            },
            (proof) => {
                proof.reverseCoverageFingerprint = `sha256:${"f".repeat(64)}`;
            },
            (proof) => {
                proof.coveredHunkFingerprints = [];
            },
            (proof) => {
                proof.coveredHunkFingerprints.push(proof.coveredHunkFingerprints[0]!);
            },
            (proof) => {
                proof.coveredChangeFingerprints = [];
            },
        ];
        for (const mutateReverseProof of mutations) {
            const fixture = await inspectionFixture({ mutateReverseProof });
            expect((await run(fixture)).status).toBe("failed");
        }
    });

    it("turns a non-Error inspection authority failure into a typed internal diagnostic", async () => {
        const fixture = await inspectionFixture();
        const providerResult = adapterResult(fixture);
        fixture.inspection = new Proxy(fixture.inspection, {
            get() {
                throw "inspection read exploded";
            },
        });
        const result = await run(fixture, providerResult);
        expect(result.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "render.inspection_internal_error",
                message: "inspection read exploded",
            }),
        );
    });
});
