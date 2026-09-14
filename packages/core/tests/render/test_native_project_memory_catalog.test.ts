/** Zero-file Memory Catalog exact target analysis, materialization and reverse attribution. */

import { describe, expect, it } from "vitest";
import type {
    RenderAnalysisView,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    ResolvedCoreRenderSelection,
    Sha256Digest,
} from "../../src/types";
import { textPayloadStats } from "../../src/catalog/payload-store";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import {
    computeVersionCanonicalContentFingerprint,
    computeRenderInputFingerprint,
    computeRenderOutputUnitFingerprint,
    computeRenderSelectionFingerprint,
} from "../../src/foundation/fingerprint";
import { rebindAdapterRenderAnalysisOptionFingerprints } from "../../src/render/render-analysis-validator";
import { makeNativeProjectExactFileContractParts } from "../../src/render/native-project-exact-file";
import { analyzeRenderDeployment } from "../../src/render/render-analysis";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import { deriveRequiredRenderSemanticsV1 } from "../../src/render/render-semantics";
import {
    CATALOG_ASSET_ID,
    CATALOG_TEXT,
    CHANGED_CATALOG_TEXT,
    FIRST_TOPIC_PATH,
    MEMORY_CATALOG_PATH,
    SECOND_TOPIC_PATH,
    TEST_HASH,
    UNIT_ASSET_ID,
    UNIT_VERSION_ID,
    SECOND_UNIT_ASSET_ID,
    SECOND_UNIT_VERSION_ID,
    changedCatalogCanonical,
    makeMemoryCatalogExactFileFixture,
    type MemoryCatalogFixtureOverrides,
} from "./fixtures/native-project-memory-catalog-test-fixtures";

describe("native project Memory Catalog target", () => {
    it("crosses the Core analysis and materialization boundary with the Catalog and its Unit authority", async () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const analyzed = await analyzeRenderDeployment(fixture.deployment, {
            registry: fixture.registry,
            resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
            dispatch: async (_adapterId, input) => ({
                status: "complete",
                value: analyzeFixture(input, fixture),
                diagnostics: [],
            }),
        });
        expect(analyzed.status).toBe("complete");
        const selection = resolvedSelection(fixture, analyzed.value);
        let captured: RenderMaterializationInput | undefined;
        const materialized = await materializeRenderDeployment(
            { deployment: fixture.deployment, analysis: analyzed.value, selection },
            {
                registry: fixture.registry,
                dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect, fixture.unitNativeDialect], [], [], []),
                resolveDialectInputs: (_provider, _deployment, semantics) => {
                    const versionKeys = new Set(
                        semantics.map((semantic) => `${semantic.subject.assetId}\0${semantic.subject.versionId}`),
                    );
                    const includesCatalog = semantics.some((semantic) => semantic.subject.assetId === CATALOG_ASSET_ID);
                    return structuredClone(
                        includesCatalog
                            ? fixture.analysisInput.dialectInputs
                            : fixture.analysisInput.dialectInputs.filter((group) =>
                                  versionKeys.has(`${group.targetVersion.assetId}\0${group.targetVersion.versionId}`),
                              ),
                    );
                },
                dispatch: async (_adapterId, input) => {
                    captured = structuredClone(input);
                    return { status: "complete", value: materializeFixture(input, fixture), diagnostics: [] };
                },
            },
        );
        expect(materialized).toMatchObject({ status: "complete" });
        expect(captured?.deployment.assets).toHaveLength(3);
        expect(captured?.deployment.targetFileSnapshots).toEqual(fixture.deployment.targetFileSnapshots);
    });

    it("materializes one zero-file Catalog while resolving deployed Unit paths", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toMatchObject([
            { claims: [{ relativePath: MEMORY_CATALOG_PATH, contentKind: "text", executable: false }] },
        ]);
        const materialized = fixture.support.materialize(materializationInput(fixture, analysis));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { contentKind: "text", text: CATALOG_TEXT } }] }],
        });
    });

    it("attributes changed ordered membership to deployed Unit Versions", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        if (analysis.status !== "complete") throw new Error("Catalog analysis fixture did not close");
        const inspected = fixture.support.inspect(inspectionInput(fixture, analysis, CHANGED_CATALOG_TEXT));
        expect(inspected).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "asset_type_data_replacement",
                    replacement: changedCatalogCanonical(),
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
            diagnostics: [],
        });
    });

    it("rebases a foreign canonical Catalog onto the immediate Claude-native index", () => {
        const fixture = makeCatalogParentRebaseFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis.status).toBe("complete");
        const materialized = fixture.support.materialize(materializationInput(fixture, analysis));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { contentKind: "text", text: CHANGED_CATALOG_TEXT } }] }],
        });
    });

    it("fails closed for stale snapshots, unknown member paths and duplicated Unit claims", () => {
        const snapshot = makeMemoryCatalogExactFileFixture();
        snapshot.analysisInput.deployment.targetFileSnapshots = [
            {
                relativePath: MEMORY_CATALOG_PATH,
                snapshotState: "present",
                contentHash: `sha256:${"0".repeat(64)}`,
                byteSize: 1,
                executable: false,
            },
        ];
        expect(snapshot.support.analyze(snapshot.analysisInput).status).toBe("failed");

        const absentSnapshot = makeMemoryCatalogExactFileFixture();
        delete absentSnapshot.analysisInput.deployment.targetFileSnapshots;
        expect(absentSnapshot.support.analyze(absentSnapshot.analysisInput).status).toBe("failed");

        const unknown = makeMemoryCatalogExactFileFixture();
        const native = unknown.analysisInput.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation" || native.files[0]?.contentKind !== "text") {
            throw new Error("Catalog native input missing");
        }
        native.files[0].text = CATALOG_TEXT.replace("topics/first.md", "topics/missing.md");
        Object.assign(native.files[0], textPayloadStats(native.files[0].text));
        expect(unknown.support.analyze(unknown.analysisInput).status).toBe("failed");

        const duplicate = makeMemoryCatalogExactFileFixture();
        const analysis = duplicate.support.analyze(duplicate.analysisInput);
        if (analysis.status !== "complete") throw new Error("Catalog analysis fixture did not close");
        const input = inspectionInput(duplicate, analysis, CHANGED_CATALOG_TEXT);
        const secondDecision = input.appliedRenderSnapshot.decisions.find(
            (decision) => decision.semanticRef.subject.assetId === SECOND_UNIT_ASSET_ID,
        );
        const firstDecision = input.appliedRenderSnapshot.decisions.find(
            (decision) => decision.semanticRef.subject.assetId === UNIT_ASSET_ID,
        );
        if (secondDecision === undefined || firstDecision === undefined) throw new Error("Unit decision missing");
        secondDecision.outputUnitFingerprints = [...firstDecision.outputUnitFingerprints];
        expect(duplicate.support.inspect(input)).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict", reasonCode: "native_project_memory_catalog_change_not_reconcilable" }],
        });
    });

    it("fails closed for foreign, incomplete, throwing, unsafe or duplicate member path resolution", () => {
        const foreign = makeMemoryCatalogExactFileFixture();
        foreign.secondUnitAsset.version.canonical = { kind: "Guidance", typeData: { schemaVersion: 1 } };
        expect(foreign.support.analyze(foreign.analysisInput).status).toBe("failed");

        const incomplete = makeMemoryCatalogExactFileFixture();
        incomplete.firstUnitAsset.version.status = "incomplete";
        expect(incomplete.support.analyze(incomplete.analysisInput).status).toBe("failed");

        const throwing = makeMemoryCatalogExactFileFixture({
            resolveMemberPath: () => {
                throw new Error("fixture resolver failure");
            },
        });
        expect(throwing.support.analyze(throwing.analysisInput).status).toBe("failed");

        const unsafe = makeMemoryCatalogExactFileFixture({ resolveMemberPath: () => "../escape.md" as never });
        expect(unsafe.support.analyze(unsafe.analysisInput).status).toBe("failed");

        const duplicatePath = makeCatalogParentRebaseFixture({ resolveMemberPath: () => FIRST_TOPIC_PATH });
        expect(duplicatePath.support.analyze(duplicatePath.analysisInput).status).toBe("failed");
    });

    it("rejects a parent rebase whose rendered membership no longer matches the canonical Catalog", () => {
        const fixture = makeCatalogParentRebaseFixture({ rebaseMaterialize: () => ({ nativeText: CATALOG_TEXT }) });
        expect(fixture.support.analyze(fixture.analysisInput).status).toBe("failed");
    });
});

function makeCatalogParentRebaseFixture(
    overrides: MemoryCatalogFixtureOverrides = {},
): ReturnType<typeof makeMemoryCatalogExactFileFixture> {
    const fixture = makeMemoryCatalogExactFileFixture(overrides);
    const childVersionId = "abababab-abab-4bab-8bab-abababababab" as const;
    const canonical = changedCatalogCanonical();
    const canonicalFingerprint = computeVersionCanonicalContentFingerprint(canonical, []);
    fixture.catalogAsset.version.ref.versionId = childVersionId;
    fixture.catalogAsset.version.versionCanonicalContentFingerprint = canonicalFingerprint;
    fixture.catalogAsset.version.versionFingerprint = `sha256:${"b".repeat(64)}`;
    fixture.catalogAsset.version.canonical = canonical;
    fixture.catalogDialectInput.targetVersion.versionId = childVersionId;
    const native = fixture.catalogDialectInput.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
    Object.assign(native, {
        inputRole: "parent_rebase_seed",
        sourceVersion: { assetId: CATALOG_ASSET_ID, versionId: fixture.catalogClosure.manifest.versionId },
    });
    const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
    fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
    fixture.allSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    fixture.catalogSemantics = fixture.allSemantics.filter(
        (semantic) => semantic.subject.assetId === CATALOG_ASSET_ID && semantic.subject.versionId === childVersionId,
    );
    fixture.analysisInput = {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: fixture.deployment.platform,
            platformInstanceId: fixture.deployment.platformInstanceId,
            targetContexts: fixture.deployment.targetContexts,
            assets: fixture.deployment.assets,
            targetFileSnapshots: fixture.deployment.targetFileSnapshots,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        },
        requiredSemantics: fixture.catalogSemantics,
        dialectInputs: [fixture.catalogDialectInput, fixture.firstDialectInput, fixture.secondDialectInput],
    };
    return fixture;
}

function materializeFixture(input: RenderMaterializationInput, fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>) {
    const key = (ref: { assetId: string; versionId: string }) => `${ref.assetId}\0${ref.versionId}`;
    const results = [fixture.support, fixture.unitSupport].map((support) => {
        const contractId = support.renderContractDeclaration.outputContractId;
        const unitFingerprints = new Set(
            input.selection.outputUnits
                .filter((unit) => unit.outputContractId === contractId)
                .map((unit) => unit.outputUnitFingerprint),
        );
        const semanticFingerprints = new Set(
            input.selection.semanticOptions
                .filter((option) => option.requiredOutputUnitFingerprints.some((unit) => unitFingerprints.has(unit)))
                .map((option) => option.semanticRefFingerprint),
        );
        const semantics = input.requiredSemantics.filter((semantic) => semanticFingerprints.has(semantic.semanticRefFingerprint));
        const versionKeys = new Set(semantics.map((semantic) => key(semantic.subject)));
        const catalog = support === fixture.support;
        const dialectInputs = input.dialectInputs.filter((group) => catalog || versionKeys.has(key(group.targetVersion)));
        const assetIds = new Set([
            ...semantics.map((semantic) => semantic.subject.assetId),
            ...dialectInputs.map((group) => group.targetVersion.assetId),
        ]);
        return support.materialize({
            schemaVersion: 1,
            deployment: {
                ...input.deployment,
                assets: input.deployment.assets.filter((asset) => assetIds.has(asset.version.ref.assetId)),
                ...(catalog ? {} : { targetFileSnapshots: undefined }),
            },
            requiredSemantics: semantics,
            dialectInputs,
            selection: {
                schemaVersion: 1,
                semanticOptions: input.selection.semanticOptions.filter((option) =>
                    semanticFingerprints.has(option.semanticRefFingerprint),
                ),
                outputUnits: input.selection.outputUnits.filter((unit) => unitFingerprints.has(unit.outputUnitFingerprint)),
                outputUnitRenderers: input.selection.outputUnitRenderers.filter((renderer) =>
                    unitFingerprints.has(renderer.outputUnitFingerprint),
                ),
            },
        });
    });
    return results.every((result) => result.status === "complete" && result.materializationState === "materialized")
        ? {
              status: "complete" as const,
              materializationState: "materialized" as const,
              materializedUnits: results.flatMap((result) =>
                  result.materializationState === "materialized" ? result.materializedUnits : [],
              ),
              diagnostics: results.flatMap((result) => result.diagnostics),
          }
        : {
              status: "failed" as const,
              materializationState: "blocked" as const,
              materializedUnits: [],
              diagnostics: results.flatMap((result) => result.diagnostics),
          };
}

function resolvedSelection(
    fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>,
    analysis: RenderAnalysisView,
): ResolvedCoreRenderSelection {
    const providerAnalysis = analysis.analyses[0];
    if (providerAnalysis === undefined) throw new Error("Catalog selection fixture is incomplete");
    const semanticOptions = analysis.requiredSemantics.map((semantic) => {
        const option = providerAnalysis.semanticOptions.find(
            (candidate) => candidate.semanticRefFingerprint === semantic.semanticRefFingerprint,
        );
        if (option === undefined || option.outcome !== "preserved") throw new Error("Catalog option fixture is incomplete");
        return {
            consumerOwnerAdapterId: fixture.provider.adapterId,
            consumerOwnerAdapterVersion: fixture.provider.version,
            optionFingerprint: option.optionFingerprint,
            semanticRefFingerprint: option.semanticRefFingerprint,
            renderStrategy: option.renderStrategy,
            actualReverseExtractPolicy: option.actualReverseExtractPolicy,
            requiredOutputUnitFingerprints: [...option.requiredOutputUnitFingerprints],
            approval: { approvalState: "not_required" as const },
            outcome: "preserved" as const,
        };
    });
    const outputUnits = structuredClone(providerAnalysis.outputUnits);
    const outputUnitRenderers = outputUnits.map((unit) => {
        const support =
            unit.outputContractId === fixture.support.renderContractDeclaration.outputContractId
                ? fixture.support
                : fixture.unitSupport;
        const contract = fixture.registry.getOutputContract(unit.outputContractId);
        const profile = contract?.materializationProfiles.find(
            (candidate) => candidate.materializationProfileId === support.renderContractDeclaration.materializationProfileId,
        );
        if (profile === undefined) throw new Error("Memory renderer profile fixture is incomplete");
        return {
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: fixture.provider.adapterId,
            rendererAdapterVersion: fixture.provider.version,
            materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: support.renderContractDeclaration.materializationProfileId,
            profileConstraintFingerprint: profile.profileConstraintFingerprint,
        };
    });
    const preimage = {
        compilerPolicyVersion: "core_render_policy_v1" as const,
        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        semanticOptions,
        outputUnits,
        outputUnitRenderers,
        promotionAuthorizations: [],
    };
    return {
        schemaVersion: 1,
        ...preimage,
        selectionFingerprint: computeRenderSelectionFingerprint(preimage),
    };
}

function analyzeFixture(
    input: Parameters<ReturnType<typeof makeMemoryCatalogExactFileFixture>["support"]["analyze"]>[0],
    fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>,
) {
    const unitKeys = new Set(
        input.deployment.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "unit",
            )
            .map((asset) => `${asset.version.ref.assetId}\0${asset.version.ref.versionId}`),
    );
    const catalogKeys = new Set(
        input.deployment.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
            )
            .map((asset) => `${asset.version.ref.assetId}\0${asset.version.ref.versionId}`),
    );
    const key = (ref: { assetId: string; versionId: string }) => `${ref.assetId}\0${ref.versionId}`;
    const unitResult = fixture.unitSupport.analyze({
        schemaVersion: 1,
        deployment: {
            ...input.deployment,
            assets: input.deployment.assets.filter((asset) => unitKeys.has(key(asset.version.ref))),
            targetFileSnapshots: undefined,
        },
        requiredSemantics: input.requiredSemantics.filter((semantic) => unitKeys.has(key(semantic.subject))),
        dialectInputs: input.dialectInputs.filter((group) => unitKeys.has(key(group.targetVersion))),
    });
    const catalogResult = fixture.support.analyze({
        schemaVersion: 1,
        deployment: input.deployment,
        requiredSemantics: input.requiredSemantics.filter((semantic) => catalogKeys.has(key(semantic.subject))),
        dialectInputs: input.dialectInputs,
    });
    const value = {
        status: "complete" as const,
        outputUnits: [...unitResult.outputUnits, ...catalogResult.outputUnits],
        semanticOptions: [...unitResult.semanticOptions, ...catalogResult.semanticOptions],
        blockedSemanticRefs: [...unitResult.blockedSemanticRefs, ...catalogResult.blockedSemanticRefs],
        diagnostics: [...unitResult.diagnostics, ...catalogResult.diagnostics],
    };
    return rebindAdapterRenderAnalysisOptionFingerprints(
        { adapterId: fixture.provider.adapterId, version: fixture.provider.version },
        input,
        value,
    );
}

function materializationInput(
    fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>,
    analysis: ReturnType<ReturnType<typeof makeMemoryCatalogExactFileFixture>["support"]["analyze"]>,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Catalog analysis fixture did not close");
    const contract = makeNativeProjectExactFileContractParts(fixture.support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Catalog materialization profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.analysisInput.deployment),
        requiredSemantics: structuredClone(fixture.analysisInput.requiredSemantics),
        dialectInputs: structuredClone(fixture.analysisInput.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: structuredClone(analysis.outputUnits),
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: fixture.provider.adapterId,
                rendererAdapterVersion: fixture.provider.version,
                materializerCapabilityKey: fixture.support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: fixture.support.renderContractDeclaration.materializationProfileId,
                profileConstraintFingerprint: profile.profileConstraintFingerprint,
            })),
            semanticOptions: analysis.semanticOptions.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                outcome: "preserved",
            })),
        },
    };
}

function inspectionInput(
    fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>,
    analysis: ReturnType<ReturnType<typeof makeMemoryCatalogExactFileFixture>["support"]["analyze"]>,
    currentText: string,
): RenderedTargetInspectionInput {
    if (analysis.status !== "complete") throw new Error("Catalog analysis fixture did not close");
    const catalogUnit = analysis.outputUnits[0];
    if (catalogUnit === undefined) throw new Error("Catalog output unit missing");
    const firstUnit = unitOutput("FIXTURE_MEMORY_UNIT_FIRST", FIRST_TOPIC_PATH, `sha256:${"1".repeat(64)}`);
    const secondUnit = unitOutput("FIXTURE_MEMORY_UNIT_SECOND", SECOND_TOPIC_PATH, `sha256:${"2".repeat(64)}`);
    const catalogSupport = fixture.catalogSemantics.find((semantic) => semantic.semanticKind === "memory.support");
    const firstSupport = fixture.allSemantics.find(
        (semantic) =>
            semantic.semanticKind === "memory.support" &&
            semantic.subject.assetId === UNIT_ASSET_ID &&
            semantic.subject.versionId === UNIT_VERSION_ID,
    );
    const secondSupport = fixture.allSemantics.find(
        (semantic) =>
            semantic.semanticKind === "memory.support" &&
            semantic.subject.assetId === SECOND_UNIT_ASSET_ID &&
            semantic.subject.versionId === SECOND_UNIT_VERSION_ID,
    );
    if (catalogSupport === undefined || firstSupport === undefined || secondSupport === undefined) {
        throw new Error("Memory support semantics missing");
    }
    const renderer = materializationInput(fixture, analysis).selection.outputUnitRenderers[0];
    if (renderer === undefined) throw new Error("Catalog renderer missing");
    return {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: TEST_HASH,
            compilationFingerprint: TEST_HASH,
            decisions: [
                decision(catalogSupport, catalogUnit.outputUnitFingerprint),
                decision(firstSupport, firstUnit.outputUnitFingerprint),
                decision(secondSupport, secondUnit.outputUnitFingerprint),
            ],
            outputUnits: [catalogUnit, firstUnit, secondUnit],
            outputUnitRenderers: [renderer],
            semanticCoverageProofs: [],
        },
        appliedAssets: [fixture.catalogAsset, fixture.firstUnitAsset, fixture.secondUnitAsset],
        inspectionScope: {
            inspectionScopeFingerprint: TEST_HASH,
            fileStates: [
                {
                    relativePath: MEMORY_CATALOG_PATH,
                    state: "changed",
                    appliedContentHash: textPayloadStats(CATALOG_TEXT).contentHash,
                    currentContentHash: textPayloadStats(currentText).contentHash,
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: catalogUnit.outputUnitFingerprint,
                    provenanceFingerprint: TEST_HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: MEMORY_CATALOG_PATH,
                appliedContent: { contentKind: "text", text: CATALOG_TEXT },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: TEST_HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(CATALOG_TEXT),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: TEST_HASH,
                    outputUnitFingerprint: catalogUnit.outputUnitFingerprint,
                    semanticRefFingerprints: [catalogSupport.semanticRefFingerprint],
                    sectionBindings: [],
                    materializationFingerprint: TEST_HASH,
                    provenanceFingerprint: TEST_HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function decision(
    semanticRef: ReturnType<typeof makeMemoryCatalogExactFileFixture>["allSemantics"][number],
    outputUnitFingerprint: Sha256Digest,
) {
    return {
        semanticRef,
        consumerOwnerAdapterId: "FIXTURE",
        consumerOwnerAdapterVersion: "0.1.0",
        optionFingerprint: TEST_HASH,
        renderStrategy: "native_file" as const,
        actualReverseExtractPolicy: "can_reconcile" as const,
        outputUnitFingerprints: [outputUnitFingerprint],
        outcome: "preserved" as const,
    };
}

function unitOutput(outputContractId: string, relativePath: string, fingerprint: Sha256Digest) {
    const preimage = {
        outputContractId,
        outputContractFingerprint: fingerprint,
        claims: [{ relativePath: relativePath as typeof FIRST_TOPIC_PATH, contentKind: "text" as const, executable: false }],
        managedDirectoryBoundaries: [],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}
