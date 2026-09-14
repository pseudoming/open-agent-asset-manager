/** Reverse controls for a real generated OpenCode entry from a synthetic single-field-derived source. */
import { createHash } from "node:crypto";
import type { RenderedTargetInspectionInput, RenderMaterializationInput, Sha256Digest, TargetFileContent } from "@oaam/core";
import { expect } from "vitest";
import { assertCanonicalEntryControls } from "../../../../../tests/conformance/canonical-entry-test-controls";
import { opencodeProvider } from "../src/opencode-provider";

const hash = (bytes: string | Uint8Array): Sha256Digest => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const bytes = (content: TargetFileContent): Uint8Array =>
    content.contentKind === "text" ? Buffer.from(content.text) : content.bytes;

export async function assertDerivedSkillReverse(base: RenderMaterializationInput): Promise<void> {
    const request = structuredClone(base);
    const canonical = request.deployment.assets[0]!.version.canonical;
    if (canonical.kind !== "Skill") throw new Error("Skill source missing");
    canonical.typeData.entryDialectId = "cursor-skill-markdown-v1";
    canonical.typeData.whenToUse = canonical.typeData.description;
    const originalCanonical = structuredClone(canonical);
    const analysis = await opencodeProvider.analyzeRender(request);
    expect(analysis.status).toBe("complete");
    request.selection.outputUnits = analysis.outputUnits;
    request.selection.semanticOptions = analysis.semanticOptions.map((option) => ({
        optionFingerprint: option.optionFingerprint,
        semanticRefFingerprint: option.semanticRefFingerprint,
        renderStrategy: option.renderStrategy,
        actualReverseExtractPolicy: option.actualReverseExtractPolicy,
        requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
        ...(option.outcome === "degraded"
            ? { outcome: "degraded" as const, degradationFingerprint: option.degradationFingerprint }
            : { outcome: "preserved" as const }),
    }));
    const result = await opencodeProvider.materializeRender(request);
    assertCanonicalEntryControls(opencodeProvider, request, result);
    if (result.materializationState !== "materialized") throw new Error("canonical Skill did not materialize");
    const unit = request.selection.outputUnits[0]!;
    const files = result.materializedUnits[0]!.files;
    const entry = files.find((file) => file.relativePath.endsWith("/SKILL.md"))!;
    const source = request.deployment.assets[0]!.version.files.find((file) => file.file.role === "entry")!;
    if (entry.content.contentKind !== "text" || source.contentKind !== "text") throw new Error("Skill text entry missing");
    const appliedText = entry.content.text;
    const suffix = "\nA real external body change.\n";
    const fingerprint = hash("synthetic canonical Skill reverse control");
    const inspection = (currentText: string, changed: boolean): RenderedTargetInspectionInput => ({
        schemaVersion: 1,
        deploymentId: "77777777-7777-4777-8777-777777777777",
        appliedAssets: structuredClone(request.deployment.assets),
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            compilerPolicyVersion: "core_render_policy_v1",
            renderInputFingerprint: request.deployment.renderInputFingerprint,
            selectionFingerprint: fingerprint,
            compilationFingerprint: fingerprint,
            outputUnits: request.selection.outputUnits,
            outputUnitRenderers: request.selection.outputUnitRenderers,
            semanticCoverageProofs: [],
            decisions: analysis.semanticOptions.map((option) => ({
                semanticRef: request.requiredSemantics.find(
                    (item) => item.semanticRefFingerprint === option.semanticRefFingerprint,
                )!,
                consumerOwnerAdapterId: opencodeProvider.adapterId,
                consumerOwnerAdapterVersion: opencodeProvider.version,
                optionFingerprint: option.optionFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                outputUnitFingerprints: option.requiredOutputUnitFingerprints,
                ...(option.outcome === "degraded"
                    ? {
                          outcome: "degraded" as const,
                          degradationFingerprint: option.degradationFingerprint,
                          degradationKinds: option.degradationKinds,
                      }
                    : { outcome: "preserved" as const }),
            })),
        },
        inspectionScope: {
            inspectionScopeFingerprint: fingerprint,
            fileStates: files.map((file) => ({
                relativePath: file.relativePath,
                state: changed && file === entry ? "changed" : "unchanged",
                appliedContentHash: hash(bytes(file.content)),
                currentContentHash: file === entry ? hash(currentText) : hash(bytes(file.content)),
                appliedExecutable: file.executable,
                currentExecutable: file.executable,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                provenanceFingerprint: fingerprint,
            })),
            directoryInventories: unit.managedDirectoryBoundaries.map((boundary) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                boundary,
                currentDescendantPaths: files.map((file) => file.relativePath),
            })),
        },
        files: changed
            ? [
                  {
                      fileState: "baseline_changed",
                      relativePath: entry.relativePath,
                      appliedContent: { contentKind: "text", text: appliedText },
                      currentContent: { contentKind: "text", text: currentText },
                      diffHunks: [
                          {
                              hunkFingerprint: hash(currentText),
                              appliedStartByte: 0,
                              appliedEndByte: Buffer.byteLength(appliedText),
                              currentStartByte: 0,
                              currentEndByte: Buffer.byteLength(currentText),
                          },
                      ],
                      attributeChanges: [],
                      provenance: {
                          schemaVersion: 1,
                          appliedRenderSnapshotFingerprint: fingerprint,
                          outputUnitFingerprint: unit.outputUnitFingerprint,
                          semanticRefFingerprints: entry.semanticRefFingerprints,
                          sectionBindings: [],
                          materializationFingerprint: fingerprint,
                          provenanceFingerprint: fingerprint,
                      },
                  },
              ]
            : [],
        inventoryDeltas: [],
    });
    const unchanged = inspection(appliedText, false);
    expect(await opencodeProvider.inspectRenderedTarget(unchanged)).toMatchObject({ status: "complete", changes: [] });
    const changed = inspection(appliedText + suffix, true);
    const changedResult = await opencodeProvider.inspectRenderedTarget(changed);
    expect(changedResult).toMatchObject({ status: "complete", files: [{ attributionState: "uniquely_attributable" }] });
    expect(changedResult.changes).toEqual([
        expect.objectContaining({
            changeKind: "file_content_replacement",
            replacementContent: { contentKind: "text", text: source.text + suffix },
        }),
    ]);
    const drift = appliedText.replace(/^description:.*$/m, 'description: "An independently edited trigger"');
    expect(drift).not.toBe(appliedText);
    expect(await opencodeProvider.inspectRenderedTarget(inspection(drift, true))).toMatchObject({
        status: "complete",
        changes: [],
        files: [{ attributionState: "conflict" }],
    });
    expect(request.deployment.assets[0]!.version.canonical).toEqual(originalCanonical);
    expect(changed.appliedAssets![0]!.version.canonical).toEqual(originalCanonical);
    canonical.typeData.whenToUse = "Independent trigger text that must not disappear";
    expect((await opencodeProvider.analyzeRender(request)).status).toBe("failed");
}
