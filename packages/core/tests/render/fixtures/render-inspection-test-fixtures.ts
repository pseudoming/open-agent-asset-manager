/** Shared deterministic fixtures for the split render authority tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { clearRegistry } from "../../../src/orchestration/adapter-registry";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "../../../src/contracts/reverse";
import { inspectRenderedTarget, projectInspectionSafeAppliedRenderSnapshot } from "../../../src/render/render-inspection";
import {
    computeAttributedSemanticChangeFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    computeRenderedTargetInventoryDeltaFingerprint,
} from "../../../src/foundation/fingerprint";
import { binaryPayloadStats, textPayloadStats } from "../../../src/catalog/payload-store";
import { makeCompiledLifecycleFixture } from "./render-lifecycle-fixtures";
import { makeProviderSummary, makeRenderRegistry } from "./render-contract-fixtures";

export let root = "";

beforeEach(() => {
    clearRegistry();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-render-inspection-"));
});

afterEach(() => {
    clearRegistry();
    fs.rmSync(root, { recursive: true, force: true });
});

export async function inspectionFixture(options: Parameters<typeof makeCompiledLifecycleFixture>[1] = {}) {
    const fixture = await makeCompiledLifecycleFixture(fs.mkdtempSync(path.join(root, "fixture-")), options);
    const snapshot = fixture.compiled.executionAuthority.appliedRenderSnapshot;
    const target = fixture.compiled.targetPlan.targetFiles[0]!;
    const provenance = fixture.compiled.executionAuthority.targetFileProvenance[0]!.provenance;
    const appliedContent = structuredClone(target.content);
    const currentContent = { contentKind: "text" as const, text: "# edited\n" };
    const appliedContentHash = textPayloadStats((appliedContent as { contentKind: "text"; text: string }).text).contentHash;
    const currentContentHash = textPayloadStats(currentContent.text).contentHash;
    const scopePreimage = {
        fileStates: [
            {
                relativePath: target.relativePath,
                state: "changed" as const,
                appliedContentHash,
                currentContentHash,
                appliedExecutable: target.executable,
                currentExecutable: target.executable,
                outputUnitFingerprint: target.outputUnitFingerprint,
                provenanceFingerprint: provenance.provenanceFingerprint,
            },
        ],
        directoryInventories: [],
    };
    const inspectionScope = {
        ...scopePreimage,
        inspectionScopeFingerprint: computeRenderedTargetInspectionScopeFingerprint({
            deploymentId: fixture.deployment.deploymentId,
            appliedCompilationFingerprint: snapshot.compilationFingerprint,
            scope: scopePreimage,
        }),
    };
    const hunkPreimage = {
        appliedStartByte: 0,
        appliedEndByte: Buffer.byteLength((appliedContent as { contentKind: "text"; text: string }).text),
        currentStartByte: 0,
        currentEndByte: Buffer.byteLength(currentContent.text),
    };
    const hunk = {
        ...hunkPreimage,
        hunkFingerprint: computeRenderedTargetDiffHunkFingerprint({
            relativePath: target.relativePath,
            appliedContentHash,
            currentContentHash,
            diffAlgorithmVersion: "core_byte_ranges_v1",
            hunk: hunkPreimage,
        }),
    };
    const inspection: RenderedTargetInspectionInput = {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: projectInspectionSafeAppliedRenderSnapshot(snapshot),
        inspectionScope,
        files: [
            {
                fileState: "baseline_changed",
                relativePath: target.relativePath,
                appliedContent,
                currentContent,
                diffHunks: [hunk],
                attributeChanges: [],
                provenance,
            },
        ],
        inventoryDeltas: [],
    };
    return { ...fixture, snapshot, target, provenance, inspection, hunk, currentContent };
}

export function adapterResult(fixture: Awaited<ReturnType<typeof inspectionFixture>>) {
    const semanticRef = fixture.snapshot.decisions.find((decision) => decision.semanticRef.subject.subjectKind === "file")!
        .semanticRef.semanticRefFingerprint;
    const changePreimage = {
        changeKind: "file_content_replacement" as const,
        semanticRefFingerprints: [semanticRef],
        replacementContent: fixture.currentContent,
    };
    const change = {
        ...changePreimage,
        changeFingerprint: computeAttributedSemanticChangeFingerprint({
            inspectionScopeFingerprint: fixture.inspection.inspectionScope.inspectionScopeFingerprint,
            change: changePreimage,
        }),
    };
    const result: AdapterRenderedTargetInspectionResult = {
        status: "complete",
        changes: [change],
        files: [
            {
                relativePath: fixture.target.relativePath,
                attributionState: "uniquely_attributable",
                changeFingerprints: [change.changeFingerprint],
                hunkAttributions: [
                    {
                        attributionKind: "semantic",
                        hunkFingerprint: fixture.hunk.hunkFingerprint,
                        semanticRefFingerprints: [semanticRef],
                    },
                ],
                diagnostics: [],
            },
        ],
        diagnostics: [],
    };
    return result;
}

export async function run(
    fixture: Awaited<ReturnType<typeof inspectionFixture>>,
    result: AdapterRenderedTargetInspectionResult = adapterResult(fixture),
    dispatchStatus: "complete" | "partial" | "failed" = "complete",
    registry = fixture.registry,
) {
    return inspectRenderedTarget(
        { appliedRenderSnapshot: fixture.snapshot, inspection: fixture.inspection },
        {
            registry,
            dispatch: async () => ({ status: dispatchStatus, value: result, diagnostics: [] }),
        },
    );
}

export function refreshScope(fixture: Awaited<ReturnType<typeof inspectionFixture>>): void {
    const { inspectionScopeFingerprint: _stored, ...preimage } = fixture.inspection.inspectionScope;
    fixture.inspection.inspectionScope.inspectionScopeFingerprint = computeRenderedTargetInspectionScopeFingerprint({
        deploymentId: fixture.inspection.deploymentId,
        appliedCompilationFingerprint: fixture.snapshot.compilationFingerprint,
        scope: preimage,
    });
}

export async function addedInspectionFixture(addedPath = "managed/user.md", binary = false) {
    const fixture = await inspectionFixture({
        analysisResultOptions: { managedDirectoryBoundary: "managed" },
    });
    const originalState = fixture.inspection.inspectionScope.fileStates[0];
    if (originalState?.state !== "changed") throw new Error("fixture state mismatch");
    originalState.state = "unchanged";
    fixture.inspection.files = [];
    const currentContent = binary
        ? ({ contentKind: "binary" as const, bytes: new Uint8Array([7, 8, 9]) } as const)
        : ({ contentKind: "text" as const, text: "# user addition\n" } as const);
    const currentContentHash =
        currentContent.contentKind === "text"
            ? textPayloadStats(currentContent.text).contentHash
            : binaryPayloadStats(currentContent.bytes).contentHash;
    const currentByteLength =
        currentContent.contentKind === "text" ? Buffer.byteLength(currentContent.text) : currentContent.bytes.byteLength;
    fixture.inspection.inspectionScope.fileStates.push({
        relativePath: addedPath,
        state: "added",
        currentContentHash,
        currentExecutable: false,
        outputUnitFingerprint: fixture.target.outputUnitFingerprint,
    });
    fixture.inspection.inspectionScope.directoryInventories = [
        {
            outputUnitFingerprint: fixture.target.outputUnitFingerprint,
            boundary: { relativePath: "managed", boundaryKind: "directory_inventory" },
            currentDescendantPaths: [addedPath],
        },
    ];
    refreshScope(fixture);
    const hunkPreimage = {
        appliedStartByte: 0,
        appliedEndByte: 0,
        currentStartByte: 0,
        currentEndByte: currentByteLength,
    };
    const hunk = {
        ...hunkPreimage,
        hunkFingerprint: computeRenderedTargetDiffHunkFingerprint({
            relativePath: addedPath,
            appliedContentHash: textPayloadStats("").contentHash,
            currentContentHash,
            diffAlgorithmVersion: "core_byte_ranges_v1",
            hunk: hunkPreimage,
        }),
    };
    fixture.inspection.files = [
        {
            fileState: "added_managed_descendant",
            relativePath: addedPath,
            currentContent,
            diffHunks: [hunk],
        },
    ];
    const inventorySemantic = fixture.snapshot.decisions.find(
        (decision) => decision.semanticRef.semanticKind === "asset.file_inventory",
    )?.semanticRef.semanticRefFingerprint;
    if (inventorySemantic === undefined) throw new Error("fixture inventory semantic missing");
    const deltaPreimage = {
        outputUnitFingerprint: fixture.target.outputUnitFingerprint,
        relativePath: addedPath,
        deltaKind: "file_added" as const,
        inventorySemanticRefFingerprint: inventorySemantic,
    };
    fixture.inspection.inventoryDeltas = [
        {
            ...deltaPreimage,
            inventoryDeltaFingerprint: computeRenderedTargetInventoryDeltaFingerprint({
                inspectionScopeFingerprint: fixture.inspection.inspectionScope.inspectionScopeFingerprint,
                delta: deltaPreimage,
            }),
        },
    ];
    return { ...fixture, addedPath, addedHunk: hunk };
}

export async function missingInspectionFixture(options: Parameters<typeof makeCompiledLifecycleFixture>[1] = {}) {
    const fixture = await inspectionFixture(options);
    const changedState = fixture.inspection.inspectionScope.fileStates[0];
    const changedFile = fixture.inspection.files[0];
    if (changedState?.state !== "changed" || changedFile?.fileState !== "baseline_changed") {
        throw new Error("fixture state mismatch");
    }
    fixture.inspection.inspectionScope.fileStates[0] = {
        relativePath: changedState.relativePath,
        state: "missing",
        appliedContentHash: changedState.appliedContentHash,
        appliedExecutable: changedState.appliedExecutable,
        outputUnitFingerprint: changedState.outputUnitFingerprint,
        provenanceFingerprint: changedState.provenanceFingerprint,
    };
    const hunkPreimage = {
        appliedStartByte: 0,
        appliedEndByte: Buffer.byteLength((changedFile.appliedContent as { contentKind: "text"; text: string }).text),
        currentStartByte: 0,
        currentEndByte: 0,
    };
    fixture.inspection.files = [
        {
            fileState: "baseline_missing",
            relativePath: changedFile.relativePath,
            appliedContent: changedFile.appliedContent,
            currentContent: { contentKind: "missing" },
            diffHunks: [
                {
                    ...hunkPreimage,
                    hunkFingerprint: computeRenderedTargetDiffHunkFingerprint({
                        relativePath: changedFile.relativePath,
                        appliedContentHash: changedState.appliedContentHash,
                        currentContentHash: "missing",
                        diffAlgorithmVersion: "core_byte_ranges_v1",
                        hunk: hunkPreimage,
                    }),
                },
            ],
            provenance: changedFile.provenance,
        },
    ];
    const unit = fixture.snapshot.outputUnits.find((item) => item.outputUnitFingerprint === changedState.outputUnitFingerprint);
    fixture.inspection.inspectionScope.directoryInventories =
        unit?.managedDirectoryBoundaries.map((boundary) => ({
            outputUnitFingerprint: changedState.outputUnitFingerprint,
            boundary: structuredClone(boundary),
            currentDescendantPaths: [],
        })) ?? [];
    refreshScope(fixture);
    if (fixture.inspection.inspectionScope.directoryInventories.length > 0) {
        const inventorySemantic = fixture.snapshot.decisions.find(
            (decision) => decision.semanticRef.semanticKind === "asset.file_inventory",
        )?.semanticRef.semanticRefFingerprint;
        if (inventorySemantic === undefined) throw new Error("fixture inventory semantic missing");
        const deltaPreimage = {
            outputUnitFingerprint: changedState.outputUnitFingerprint,
            relativePath: changedState.relativePath,
            deltaKind: "file_deleted" as const,
            inventorySemanticRefFingerprint: inventorySemantic,
        };
        fixture.inspection.inventoryDeltas = [
            {
                ...deltaPreimage,
                inventoryDeltaFingerprint: computeRenderedTargetInventoryDeltaFingerprint({
                    inspectionScopeFingerprint: fixture.inspection.inspectionScope.inspectionScopeFingerprint,
                    delta: deltaPreimage,
                }),
            },
        ];
    }
    return fixture;
}

export function wholeFileResult(relativePath: string): AdapterRenderedTargetInspectionResult {
    return {
        status: "complete",
        changes: [],
        files: [
            {
                relativePath,
                attributionState: "whole_file_adoption_required",
                diagnostics: [],
            },
        ],
        diagnostics: [],
    };
}

export async function multiRendererInspectionFixture() {
    const fixture = await makeCompiledLifecycleFixture(fs.mkdtempSync(path.join(root, "multi-renderer-")), {
        analysisResultOptions: { additionalOutputUnitPaths: ["SECOND.md"] },
    });
    const snapshot = fixture.compiled.executionAuthority.appliedRenderSnapshot;
    const secondProvider = makeProviderSummary({
        adapterId: "SECOND_RENDERER",
        agentRuntimeId: "SECOND_RENDERER_CLI",
        contract: fixture.contract,
    });
    const secondTarget = fixture.compiled.targetPlan.targetFiles.find((file) => file.relativePath === "SECOND.md");
    if (secondTarget === undefined) throw new Error("second target missing");
    const secondRenderer = snapshot.outputUnitRenderers.find(
        (renderer) => renderer.outputUnitFingerprint === secondTarget.outputUnitFingerprint,
    );
    if (secondRenderer === undefined) throw new Error("second renderer missing");
    secondRenderer.rendererAdapterId = secondProvider.adapterId;
    secondRenderer.rendererAdapterVersion = secondProvider.version;
    secondRenderer.materializerCapabilityKey = secondProvider.materializerCapabilities[0]!.materializerCapabilityKey;
    const registry = makeRenderRegistry({
        providers: [fixture.provider, secondProvider],
        contract: fixture.contract,
    });
    const fileStates = fixture.compiled.targetPlan.targetFiles.map((target) => {
        const provenance = fixture.compiled.executionAuthority.targetFileProvenance.find(
            (item) => item.relativePath === target.relativePath,
        )?.provenance;
        if (provenance === undefined || target.content.contentKind !== "text") {
            throw new Error("multi-renderer fixture mismatch");
        }
        const currentContent = {
            contentKind: "text" as const,
            text: `# edited ${target.relativePath}\n`,
        };
        return {
            target,
            provenance,
            currentContent,
            appliedContentHash: textPayloadStats(target.content.text).contentHash,
            currentContentHash: textPayloadStats(currentContent.text).contentHash,
        };
    });
    const scopePreimage = {
        fileStates: fileStates.map((item) => ({
            relativePath: item.target.relativePath,
            state: "changed" as const,
            appliedContentHash: item.appliedContentHash,
            currentContentHash: item.currentContentHash,
            appliedExecutable: item.target.executable,
            currentExecutable: item.target.executable,
            outputUnitFingerprint: item.target.outputUnitFingerprint,
            provenanceFingerprint: item.provenance.provenanceFingerprint,
        })),
        directoryInventories: [],
    };
    const inspectionScope = {
        ...scopePreimage,
        inspectionScopeFingerprint: computeRenderedTargetInspectionScopeFingerprint({
            deploymentId: fixture.deployment.deploymentId,
            appliedCompilationFingerprint: snapshot.compilationFingerprint,
            scope: scopePreimage,
        }),
    };
    const files = fileStates.map((item) => {
        const hunkPreimage = {
            appliedStartByte: 0,
            appliedEndByte: Buffer.byteLength((item.target.content as { contentKind: "text"; text: string }).text),
            currentStartByte: 0,
            currentEndByte: Buffer.byteLength(item.currentContent.text),
        };
        return {
            fileState: "baseline_changed" as const,
            relativePath: item.target.relativePath,
            appliedContent: item.target.content,
            currentContent: item.currentContent,
            diffHunks: [
                {
                    ...hunkPreimage,
                    hunkFingerprint: computeRenderedTargetDiffHunkFingerprint({
                        relativePath: item.target.relativePath,
                        appliedContentHash: item.appliedContentHash,
                        currentContentHash: item.currentContentHash,
                        diffAlgorithmVersion: "core_byte_ranges_v1",
                        hunk: hunkPreimage,
                    }),
                },
            ],
            attributeChanges: [],
            provenance: item.provenance,
        };
    });
    const inspection: RenderedTargetInspectionInput = {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: projectInspectionSafeAppliedRenderSnapshot(snapshot),
        inspectionScope,
        files,
        inventoryDeltas: [],
    };
    return { ...fixture, snapshot, registry, inspection };
}
