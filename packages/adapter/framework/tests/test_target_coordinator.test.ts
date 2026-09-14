import { describe, expect, it, vi } from "vitest";
import type {
    AdapterAssetTargetCapability,
    AdapterMaterializerCapability,
    AdapterProvider,
    AssetKind,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    RequiredRenderSemantic,
} from "@oaam/core";
import {
    defineAdapterProvider,
    isAdapterFrameworkTargetHandler,
    sourceReader,
    type AdapterFrameworkTargetDefinition,
} from "../src";
import { diagnostic, materializer, targetCapability, unavailableCapability } from "./target-coordinator-test-support";

const HASH = `sha256:${"0".repeat(64)}`;

function provider(
    targetRender: AdapterFrameworkTargetDefinition,
    assetTargetCapabilities: AdapterAssetTargetCapability[],
    materializerCapabilities: AdapterMaterializerCapability[],
    providerOverrides: Record<string, unknown> = {},
): AdapterProvider {
    return defineAdapterProvider({
        ...providerDefinition(assetTargetCapabilities, materializerCapabilities),
        ...providerOverrides,
        targetRender,
    } as never);
}

function providerDefinition(
    assetTargetCapabilities: AdapterAssetTargetCapability[],
    materializerCapabilities: AdapterMaterializerCapability[],
) {
    const reader = sourceReader(() => ({ candidates: [], diagnostics: [], ignoredSource: false }));
    return {
        adapterId: "TEST",
        displayName: "Test Provider",
        version: "1.0.0",
        agentRuntimes: [],
        targetContextSchemas: [],
        assetSourceCapabilities: [],
        assetTargetCapabilities,
        materializerCapabilities,
        renderContractDeclarations: [],
        dialectContracts: { native: [], restoration: [], portableEntries: [], portableSelectors: [] },
        sourceRead: {
            registry: {
                Guidance: reader,
                Rule: reader,
                Workflow: reader,
                Skill: reader,
                Subagent: reader,
                Memory: reader,
            },
            resolveContext: () => null,
            scan: async () => {
                throw new Error("unused");
            },
            diagnostics: {
                unknownAuthority: () => diagnostic("unused"),
                capabilityNotCallable: () => diagnostic("unused"),
                readerUnavailable: () => diagnostic("unused"),
                contextUnresolved: () => diagnostic("unused"),
                rootWithoutObligation: () => diagnostic("unused"),
            },
        },
        probe: async () => ({ status: "empty", observation: null, diagnostics: [] }),
    };
}

function asset(assetId: string, kind: AssetKind) {
    return {
        scope: "project",
        projectId: "project",
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId, versionId: `version-${assetId}` },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete",
            canonical: { kind },
            files: [],
        },
        sectionHandles: {},
    } as never;
}

function semantic(assetId: string, assetKind: AssetKind, consumerAgentRuntimeId: string): RequiredRenderSemantic {
    return {
        semanticRefFingerprint: `semantic-${assetId}`,
        consumerAgentRuntimeId,
        subject: { subjectKind: "asset", assetId, versionId: `version-${assetId}` },
        semanticKind: assetKind === "Guidance" ? "guidance.base_context" : "rule.activation",
    } as RequiredRenderSemantic;
}

function analysisInput(items: Array<{ assetId: string; kind: AssetKind; consumer: string }>): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "linux",
            targetContexts: [...new Set(items.map((item) => item.consumer))].map((agentRuntimeId) => ({ agentRuntimeId })),
            assets: items.map((item) => asset(item.assetId, item.kind)),
            renderInputFingerprint: HASH,
        },
        requiredSemantics: items.map((item) => semantic(item.assetId, item.kind, item.consumer)),
        dialectInputs: items.map((item) => ({
            targetVersion: { assetId: item.assetId, versionId: `version-${item.assetId}` },
            consumerAgentRuntimeIds: [item.consumer],
            inputs: [],
        })),
    } as RenderAnalysisInput;
}

function outputUnit(outputContractId: string, outputUnitFingerprint = `unit:${outputContractId}`) {
    return {
        outputUnitFingerprint,
        outputContractId,
        outputContractFingerprint: HASH,
        claims: [],
        managedDirectoryBoundaries: [],
    } as never;
}

function successfulConsumer(outputContractId: string, calls: RenderAnalysisInput[]) {
    return async (input: RenderAnalysisInput) => {
        calls.push(input);
        return {
            status: "complete",
            outputUnits: [outputUnit(outputContractId)],
            semanticOptions: input.requiredSemantics.map((item) => ({
                optionFingerprint: `option:${item.semanticRefFingerprint}`,
                semanticRefFingerprint: item.semanticRefFingerprint,
                renderStrategy: "native_file",
                actualReverseExtractPolicy: "can_reconcile",
                approvalRequirement: { approvalState: "not_required" },
                requiredOutputUnitFingerprints: [`unit:${outputContractId}`],
                reasonCode: "test",
                diagnostics: [],
                outcome: "preserved",
            })),
            blockedSemanticRefs: [],
            diagnostics: [],
        } as never;
    };
}

function successfulMaterializer(calls: RenderMaterializationInput[]) {
    return async (input: RenderMaterializationInput) => {
        calls.push(input);
        return {
            status: "complete",
            materializationState: "materialized",
            materializedUnits: input.selection.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                files: [],
            })),
            diagnostics: [],
        } as never;
    };
}

function successfulInspector(calls: RenderedTargetInspectionInput[]) {
    return async (input: RenderedTargetInspectionInput) => {
        calls.push(input);
        return {
            status: "complete",
            changes: input.files.map((file) => ({
                changeKind: "file_content_replacement",
                changeFingerprint: `change:${file.relativePath}`,
                semanticRefFingerprints: [],
                replacementContent: { contentKind: "text", text: "changed" },
            })),
            files: input.files.map((file) => ({
                relativePath: file.relativePath,
                attributionState: "conflict",
                reasonCode: "test",
                diagnostics: [],
            })),
            diagnostics: [],
        } as never;
    };
}

function selectionInput(contractIds: string[]): RenderMaterializationInput {
    const items = contractIds.map((outputContractId, index) => ({
        assetId: `asset-${index}`,
        kind: index === 0 ? ("Guidance" as const) : ("Rule" as const),
        consumer: index === 0 ? "TEST_A" : "TEST_B",
        outputContractId,
    }));
    const base = analysisInput(items);
    return {
        ...base,
        selection: {
            schemaVersion: 1,
            semanticOptions: base.requiredSemantics.map((item, index) => ({
                optionFingerprint: `option:${item.semanticRefFingerprint}`,
                semanticRefFingerprint: item.semanticRefFingerprint,
                renderStrategy: "native_file",
                actualReverseExtractPolicy: "can_reconcile",
                requiredOutputUnitFingerprints: [`unit:${items[index]?.outputContractId}`],
                outcome: "preserved",
            })),
            outputUnits: items.map((item) => outputUnit(item.outputContractId)),
            outputUnitRenderers: items.map((item) => ({
                outputUnitFingerprint: `unit:${item.outputContractId}`,
                rendererAdapterId: "TEST",
                rendererAdapterVersion: "1.0.0",
                materializerCapabilityKey: `materializer:${item.outputContractId}`,
                materializationProfileId: `profile:${item.outputContractId}`,
                profileConstraintFingerprint: HASH,
            })),
        },
    } as RenderMaterializationInput;
}

function inspectionInput(contractIds: string[]): RenderedTargetInspectionInput {
    const units = contractIds.map((id) => outputUnit(id));
    const fileStates = units.map((unit, index) => ({
        relativePath: `file-${index}.md`,
        state: "changed",
        appliedContentHash: HASH,
        currentContentHash: HASH,
        appliedExecutable: false,
        currentExecutable: false,
        outputUnitFingerprint: unit.outputUnitFingerprint,
        provenanceFingerprint: HASH,
    }));
    return {
        schemaVersion: 1,
        deploymentId: "deployment",
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            outputUnits: units,
            outputUnitRenderers: [],
            decisions: [],
        },
        inspectionScope: {
            inspectionScopeFingerprint: HASH,
            fileStates,
            directoryInventories: [],
        },
        files: fileStates.map((state) => ({
            fileState: "baseline_changed",
            relativePath: state.relativePath,
            appliedContent: { contentKind: "text", text: "before" },
            currentContent: { contentKind: "text", text: "after" },
            diffHunks: [],
            attributeChanges: [],
            provenance: { sectionBindings: [] },
        })),
        inventoryDeltas: [],
    } as RenderedTargetInspectionInput;
}

function targetDefinition(
    options: {
        consumerCalls?: RenderAnalysisInput[];
        materializerCalls?: RenderMaterializationInput[];
        inspectorCalls?: RenderedTargetInspectionInput[];
    } = {},
): AdapterFrameworkTargetDefinition {
    const consumerCalls = options.consumerCalls ?? [];
    const materializerCalls = options.materializerCalls ?? [];
    const inspectorCalls = options.inspectorCalls ?? [];
    return {
        consumers: [
            { agentRuntimeId: "TEST_A", assetKind: "Guidance", analyze: successfulConsumer("contract-a", consumerCalls) },
            { agentRuntimeId: "TEST_B", assetKind: "Rule", analyze: successfulConsumer("contract-b", consumerCalls) },
        ],
        materializers: [
            {
                outputContractId: "contract-a",
                materialize: successfulMaterializer(materializerCalls),
                inspect: successfulInspector(inspectorCalls),
            },
            {
                outputContractId: "contract-b",
                materialize: successfulMaterializer(materializerCalls),
                inspect: successfulInspector(inspectorCalls),
            },
        ],
    };
}

const TARGET_CAPABILITIES = [
    targetCapability("TEST_A", "Guidance", "contract-a"),
    targetCapability("TEST_B", "Rule", "contract-b"),
];
const MATERIALIZERS = [materializer("contract-a"), materializer("contract-b")];

describe("adapter-framework target coordinator", () => {
    it("keeps Memory Catalog member Assets and dialect inputs in handler projections", async () => {
        const analysisCalls: RenderAnalysisInput[] = [];
        const materializationCalls: RenderMaterializationInput[] = [];
        const capabilities = [targetCapability("TEST_A", "Memory", "contract-memory")];
        const materializers = [materializer("contract-memory")];
        const result = provider(
            {
                consumers: [
                    {
                        agentRuntimeId: "TEST_A",
                        assetKind: "Memory",
                        analyze: successfulConsumer("contract-memory", analysisCalls),
                    },
                ],
                materializers: [
                    {
                        outputContractId: "contract-memory",
                        materialize: successfulMaterializer(materializationCalls),
                        inspect: successfulInspector([]),
                    },
                ],
            },
            capabilities,
            materializers,
        );
        const catalog = asset("catalog", "Memory");
        catalog.version.canonical = {
            kind: "Memory",
            typeData: {
                schemaVersion: 2,
                entityRole: "catalog",
                members: [
                    {
                        targetAssetVersionId: "version-unit",
                        routingTitle: "Unit",
                        routingHint: "fixture",
                    },
                ],
            },
        } as never;
        const unit = asset("unit", "Memory");
        unit.version.canonical = {
            kind: "Memory",
            typeData: {
                schemaVersion: 2,
                entityRole: "unit",
                card: { name: "Unit", description: "fixture" },
                lifecycle: { retentionClass: "durable", refreshPolicy: "manual" },
            },
        } as never;
        const input = analysisInput([{ assetId: "catalog", kind: "Memory", consumer: "TEST_A" }]);
        input.deployment.assets = [catalog, unit];
        input.dialectInputs = [
            { targetVersion: catalog.version.ref, consumerAgentRuntimeIds: ["TEST_A"], inputs: [] },
            { targetVersion: unit.version.ref, consumerAgentRuntimeIds: ["TEST_A"], inputs: [] },
        ];

        const analyzed = await result.analyzeRender(input);
        expect(analyzed).toMatchObject({ status: "complete" });
        expect(analysisCalls[0]?.deployment.assets.map((item) => item.version.ref.assetId)).toEqual(["catalog", "unit"]);
        expect(analysisCalls[0]?.dialectInputs.map((item) => item.targetVersion.assetId)).toEqual(["catalog", "unit"]);

        const selected: RenderMaterializationInput = {
            ...input,
            selection: {
                schemaVersion: 1,
                semanticOptions: analyzed.semanticOptions.map((option) => ({
                    optionFingerprint: option.optionFingerprint,
                    semanticRefFingerprint: option.semanticRefFingerprint,
                    renderStrategy: option.renderStrategy,
                    actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                    requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                    outcome: "preserved",
                })),
                outputUnits: analyzed.outputUnits,
                outputUnitRenderers: analyzed.outputUnits.map((output) => ({
                    outputUnitFingerprint: output.outputUnitFingerprint,
                    rendererAdapterId: "TEST",
                    rendererAdapterVersion: "1.0.0",
                    materializerCapabilityKey: "materializer:contract-memory",
                    materializationProfileId: "profile:contract-memory",
                    profileConstraintFingerprint: HASH,
                })),
            },
        } as RenderMaterializationInput;
        expect(await result.materializeRender(selected)).toMatchObject({ status: "complete" });
        expect(materializationCalls[0]?.deployment.assets.map((item) => item.version.ref.assetId)).toEqual(["catalog", "unit"]);
        expect(materializationCalls[0]?.dialectInputs.map((item) => item.targetVersion.assetId)).toEqual(["catalog", "unit"]);
    });

    it("authenticates final handlers and deterministically partitions all three target operations", async () => {
        const analysisCalls: RenderAnalysisInput[] = [];
        const materializationCalls: RenderMaterializationInput[] = [];
        const inspectionCalls: RenderedTargetInspectionInput[] = [];
        const result = provider(
            targetDefinition({
                consumerCalls: analysisCalls,
                materializerCalls: materializationCalls,
                inspectorCalls: inspectionCalls,
            }),
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );

        expect(isAdapterFrameworkTargetHandler(result.analyzeRender)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(result.materializeRender)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(result.inspectRenderedTarget)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(() => undefined)).toBe(false);

        const composedInput = analysisInput([
            { assetId: "z", kind: "Rule", consumer: "TEST_B" },
            { assetId: "a", kind: "Guidance", consumer: "TEST_A" },
        ]);
        const analyzed = await result.analyzeRender(composedInput);
        expect(analyzed.status).toBe("complete");
        expect(analyzed.outputUnits.map((unit) => unit.outputContractId)).toEqual(["contract-a", "contract-b"]);
        expect(analyzed.semanticOptions.map((option) => option.optionFingerprint)).toEqual([
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        ]);
        expect(analyzed.semanticOptions.every((option) => !option.optionFingerprint.startsWith("option:"))).toBe(true);
        expect(analysisCalls).toHaveLength(2);
        expect(analysisCalls.map((input) => input.deployment.assets.map((item) => item.version.ref.assetId))).toEqual([
            ["a"],
            ["z"],
        ]);
        expect(analysisCalls.every((input) => input.deployment.targetContexts.length === 1)).toBe(true);
        expect(analysisCalls.every((input) => input.dialectInputs.length === 1)).toBe(true);

        const materialized = await result.materializeRender(selectionInput(["contract-b", "contract-a"]));
        expect(materialized).toMatchObject({ materializationState: "materialized", status: "complete" });
        if (materialized.materializationState !== "materialized") throw new Error("expected materialized result");
        expect(materialized.materializedUnits.map((unit) => unit.outputUnitFingerprint)).toEqual([
            "unit:contract-a",
            "unit:contract-b",
        ]);
        expect(materializationCalls).toHaveLength(2);
        expect(materializationCalls.every((input) => input.selection.outputUnits.length === 1)).toBe(true);

        const inspected = await result.inspectRenderedTarget(inspectionInput(["contract-b", "contract-a"]));
        expect(inspected.status).toBe("complete");
        expect(inspected.files.map((file) => file.relativePath)).toEqual(["file-0.md", "file-1.md"]);
        expect(inspected.changes.map((change) => change.changeFingerprint)).toEqual(["change:file-0.md", "change:file-1.md"]);
        expect(inspectionCalls).toHaveLength(2);
        expect(inspectionCalls.every((input) => input.files.length === 1 && input.inspectionScope.fileStates.length === 1)).toBe(
            true,
        );
        expect(inspectionCalls.every((input) => input.appliedRenderSnapshot.outputUnits.length === 2)).toBe(true);
    });

    it("snapshots handler identities so caller mutation cannot replace Framework-owned dispatch", async () => {
        const calls: RenderAnalysisInput[] = [];
        const definition = targetDefinition({ consumerCalls: calls });
        const result = provider(definition, TARGET_CAPABILITIES, MATERIALIZERS);
        definition.consumers[0].analyze = vi.fn(async () => {
            throw new Error("mutated handler must not run");
        });

        await expect(
            result.analyzeRender(analysisInput([{ assetId: "a", kind: "Guidance", consumer: "TEST_A" }])),
        ).resolves.toMatchObject({ status: "complete" });
        expect(calls).toHaveLength(1);
    });

    it("allows one consumer to coordinate multiple honest target variants in the same runtime and AssetKind cell", async () => {
        const calls: RenderAnalysisInput[] = [];
        const definition = targetDefinition({ consumerCalls: calls });
        definition.materializers.push({
            outputContractId: "contract-a-graph",
            materialize: successfulMaterializer([]),
            inspect: successfulInspector([]),
        });
        const result = provider(
            definition,
            [...TARGET_CAPABILITIES, targetCapability("TEST_A", "Guidance", "contract-a-graph")],
            [...MATERIALIZERS, materializer("contract-a-graph")],
        );

        await expect(
            result.analyzeRender(analysisInput([{ assetId: "a", kind: "Guidance", consumer: "TEST_A" }])),
        ).resolves.toMatchObject({ status: "complete", outputUnits: [{ outputContractId: "contract-a" }] });
        expect(calls).toHaveLength(1);
    });

    it("rejects duplicate, foreign, or missing consumer and materializer handlers", () => {
        const valid = targetDefinition();
        expect(() =>
            provider(
                { ...valid, consumers: [valid.consumers[0] as never, valid.consumers[0] as never] },
                TARGET_CAPABILITIES,
                MATERIALIZERS,
            ),
        ).toThrow("adapter target consumer handler is duplicated");
        expect(() =>
            provider(
                { ...valid, consumers: [{ ...valid.consumers[0], agentRuntimeId: "FOREIGN" } as never] },
                TARGET_CAPABILITIES,
                MATERIALIZERS,
            ),
        ).toThrow("adapter target consumer handler has no exact supported capability");
        expect(() =>
            provider({ ...valid, consumers: [valid.consumers[0] as never] }, TARGET_CAPABILITIES, MATERIALIZERS),
        ).toThrow("every supported target capability requires one consumer handler");
        expect(() =>
            provider(
                valid,
                [...TARGET_CAPABILITIES, structuredClone(TARGET_CAPABILITIES[0] as AdapterAssetTargetCapability)],
                MATERIALIZERS,
            ),
        ).toThrow("adapter target capability variant is duplicated");
        expect(() =>
            provider(valid, [...TARGET_CAPABILITIES, unavailableCapability("TEST_A", "Guidance")], MATERIALIZERS),
        ).toThrow("adapter unavailable target capability must be exclusive in its cell");
        expect(() =>
            provider(
                { ...valid, materializers: [valid.materializers[0] as never, valid.materializers[0] as never] },
                TARGET_CAPABILITIES,
                MATERIALIZERS,
            ),
        ).toThrow("adapter target materializer handler is duplicated");
        expect(() =>
            provider(
                { ...valid, materializers: [{ ...valid.materializers[0], outputContractId: "foreign" } as never] },
                TARGET_CAPABILITIES,
                MATERIALIZERS,
            ),
        ).toThrow("adapter target materializer handler has no declared materializer capability");
        expect(() =>
            provider({ ...valid, materializers: [valid.materializers[0] as never] }, TARGET_CAPABILITIES, MATERIALIZERS),
        ).toThrow("every materializer output contract requires one target handler");
    });

    it("rejects caller-owned final target methods when coordinated target handlers are declared", () => {
        const valid = targetDefinition();
        const direct = vi.fn();
        expect(() => provider(valid, TARGET_CAPABILITIES, MATERIALIZERS, { analyzeRender: direct })).toThrow(
            "adapter framework owns final Provider target handlers",
        );
        expect(direct).not.toHaveBeenCalled();
    });

    it("rejects the retired direct-target construction branch before any caller method can run", () => {
        const direct = vi.fn();
        const legacy = {
            ...providerDefinition(TARGET_CAPABILITIES, MATERIALIZERS),
            analyzeRender: direct,
            materializeRender: direct,
            inspectRenderedTarget: direct,
        };

        expect(() => defineAdapterProvider(legacy as never)).toThrow(
            "adapter framework requires one explicit targetRender definition",
        );
        expect(direct).not.toHaveBeenCalled();
    });

    it("fails closed before handler calls for unknown analysis, materialization, and inspection units", async () => {
        const analysisCalls: RenderAnalysisInput[] = [];
        const materializationCalls: RenderMaterializationInput[] = [];
        const inspectionCalls: RenderedTargetInspectionInput[] = [];
        const result = provider(
            targetDefinition({
                consumerCalls: analysisCalls,
                materializerCalls: materializationCalls,
                inspectorCalls: inspectionCalls,
            }),
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );

        const missingAsset = analysisInput([{ assetId: "missing", kind: "Guidance", consumer: "TEST_A" }]);
        missingAsset.deployment.assets = [];
        expect(await result.analyzeRender(missingAsset)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "adapter_framework.target_handler_unavailable" }],
        });

        expect(
            await result.analyzeRender(analysisInput([{ assetId: "foreign", kind: "Guidance", consumer: "FOREIGN" }])),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "adapter_framework.target_handler_unavailable" }],
        });

        const unknownMaterializer = selectionInput(["unknown"]);
        expect(await result.materializeRender(unknownMaterializer)).toMatchObject({
            status: "failed",
            materializationState: "blocked",
        });

        const unknownInspection = inspectionInput(["unknown"]);
        expect(await result.inspectRenderedTarget(unknownInspection)).toMatchObject({ status: "failed", changes: [], files: [] });
        expect(analysisCalls).toHaveLength(0);
        expect(materializationCalls).toHaveLength(0);
        expect(inspectionCalls).toHaveLength(0);
    });

    it("uses declared unavailable diagnostics and derives partial versus failed analysis honestly", async () => {
        const calls: RenderAnalysisInput[] = [];
        const definition = targetDefinition({ consumerCalls: calls });
        const capabilities = [targetCapability("TEST_A", "Guidance", "contract-a"), unavailableCapability("TEST_B", "Rule")];
        const result = provider(
            { consumers: [definition.consumers[0] as never], materializers: definition.materializers },
            capabilities,
            MATERIALIZERS,
        );

        expect(
            await result.analyzeRender(
                analysisInput([
                    { assetId: "a", kind: "Guidance", consumer: "TEST_A" },
                    { assetId: "b", kind: "Rule", consumer: "TEST_B" },
                ]),
            ),
        ).toMatchObject({ status: "partial", blockedSemanticRefs: [{ reasonCode: "test.Rule.deferred" }] });
        expect(
            await result.analyzeRender(
                analysisInput([
                    { assetId: "z", kind: "Rule", consumer: "TEST_B" },
                    { assetId: "b", kind: "Rule", consumer: "TEST_B" },
                ]),
            ),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "test.Rule.deferred", operation: "render" }],
            blockedSemanticRefs: [{ semanticRefFingerprint: "semantic-b" }, { semanticRefFingerprint: "semantic-z" }],
        });
        expect(calls).toHaveLength(1);
    });

    it("accepts exact handler-owned blocked and partial semantic classifications", async () => {
        const valid = targetDefinition();
        const classify = async (input: RenderAnalysisInput) => {
            const successful = await successfulConsumer(
                "contract-a",
                [],
            )({
                ...input,
                requiredSemantics: input.requiredSemantics.slice(0, 1),
            });
            const blocked = input.requiredSemantics.slice(1).map((item) => ({
                semanticRefFingerprint: item.semanticRefFingerprint,
                reasonCode: "test.blocked",
                diagnostics: [diagnostic("test.blocked")],
            }));
            return input.requiredSemantics.length === 1
                ? {
                      status: "failed" as const,
                      outputUnits: [],
                      semanticOptions: [],
                      blockedSemanticRefs: [
                          {
                              semanticRefFingerprint: input.requiredSemantics[0]?.semanticRefFingerprint,
                              reasonCode: "test.blocked",
                              diagnostics: [diagnostic("test.blocked")],
                          },
                      ],
                      diagnostics: [diagnostic("test.blocked")],
                  }
                : {
                      ...successful,
                      status: "partial" as const,
                      blockedSemanticRefs: blocked,
                      diagnostics: [diagnostic("test.blocked")],
                  };
        };
        const result = provider(
            { ...valid, consumers: [{ ...valid.consumers[0], analyze: classify }, valid.consumers[1] as never] },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );

        expect(await result.analyzeRender(analysisInput([{ assetId: "a", kind: "Guidance", consumer: "TEST_A" }]))).toMatchObject(
            {
                status: "failed",
                blockedSemanticRefs: [{ reasonCode: "test.blocked" }],
            },
        );
        expect(
            await result.analyzeRender(
                analysisInput([
                    { assetId: "a", kind: "Guidance", consumer: "TEST_A" },
                    { assetId: "b", kind: "Guidance", consumer: "TEST_A" },
                ]),
            ),
        ).toMatchObject({ status: "partial", semanticOptions: [{ semanticRefFingerprint: "semantic-a" }] });
    });

    it("rejects handler results that omit semantics, duplicate units, fail materialization, or return a foreign unit", async () => {
        const valid = targetDefinition();
        const missingSemantic = async () => ({
            status: "complete" as const,
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const duplicateUnit = successfulConsumer("contract-a", []);
        const analysisProvider = provider(
            {
                ...valid,
                consumers: [
                    { ...valid.consumers[0], analyze: duplicateUnit },
                    { ...valid.consumers[1], analyze: duplicateUnit },
                ],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(
            await analysisProvider.analyzeRender(
                analysisInput([
                    { assetId: "a", kind: "Guidance", consumer: "TEST_A" },
                    { assetId: "b", kind: "Rule", consumer: "TEST_B" },
                ]),
            ),
        ).toMatchObject({ status: "failed", outputUnits: [] });

        const omittedProvider = provider(
            { ...valid, consumers: [{ ...valid.consumers[0], analyze: missingSemantic }, valid.consumers[1] as never] },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(
            await omittedProvider.analyzeRender(analysisInput([{ assetId: "a", kind: "Guidance", consumer: "TEST_A" }])),
        ).toMatchObject({
            status: "failed",
            blockedSemanticRefs: [{ reasonCode: "adapter_framework.target_handler_unavailable" }],
        });

        const contradictory = async (input: RenderAnalysisInput) => ({
            ...(await successfulConsumer("contract-a", [])(input)),
            status: "failed" as const,
        });
        const contradictoryProvider = provider(
            { ...valid, consumers: [{ ...valid.consumers[0], analyze: contradictory }, valid.consumers[1] as never] },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(
            await contradictoryProvider.analyzeRender(analysisInput([{ assetId: "a", kind: "Guidance", consumer: "TEST_A" }])),
        ).toMatchObject({ status: "failed", outputUnits: [] });

        const blocked = async () => ({
            status: "failed" as const,
            materializationState: "blocked" as const,
            reasonCode: "test",
            diagnostics: [diagnostic("handler.blocked")],
        });
        const blockedProvider = provider(
            {
                ...valid,
                materializers: [{ ...valid.materializers[0], materialize: blocked }, valid.materializers[1] as never],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(await blockedProvider.materializeRender(selectionInput(["contract-a"]))).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "handler.blocked" }, { code: "adapter_framework.target_handler_unavailable" }],
        });

        const foreign = async () => ({
            status: "complete" as const,
            materializationState: "materialized" as const,
            materializedUnits: [{ outputUnitFingerprint: "foreign", files: [] }],
            diagnostics: [],
        });
        const foreignProvider = provider(
            {
                ...valid,
                materializers: [{ ...valid.materializers[0], materialize: foreign }, valid.materializers[1] as never],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(await foreignProvider.materializeRender(selectionInput(["contract-a"]))).toMatchObject({
            status: "failed",
            materializationState: "blocked",
        });
    });

    it("fails inspection when a file lacks state, a delta lacks a handler, or one handler returns an invalid closure", async () => {
        const valid = targetDefinition();
        const result = provider(valid, TARGET_CAPABILITIES, MATERIALIZERS);
        const noState = inspectionInput(["contract-a"]);
        noState.inspectionScope.fileStates = [];
        expect(await result.inspectRenderedTarget(noState)).toMatchObject({ status: "failed" });

        const unknownDelta = inspectionInput([]);
        unknownDelta.inventoryDeltas = [{ outputUnitFingerprint: "unknown" }] as never;
        expect(await result.inspectRenderedTarget(unknownDelta)).toMatchObject({ status: "failed" });

        const failedInspect = async () => ({
            status: "failed" as const,
            changes: [],
            files: [],
            diagnostics: [diagnostic("handler.inspect.failed", "scan")],
        });
        const failedProvider = provider(
            {
                ...valid,
                materializers: [{ ...valid.materializers[0], inspect: failedInspect }, valid.materializers[1] as never],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(await failedProvider.inspectRenderedTarget(inspectionInput(["contract-a"]))).toMatchObject({
            status: "failed",
            diagnostics: [
                { code: "handler.inspect.failed" },
                { code: "adapter_framework.target_handler_unavailable", operation: "scan" },
            ],
        });

        const foreignInspect = async () => ({
            status: "complete" as const,
            changes: [],
            files: [{ relativePath: "foreign.md", attributionState: "conflict" as const, reasonCode: "test", diagnostics: [] }],
            diagnostics: [],
        });
        const foreignProvider = provider(
            {
                ...valid,
                materializers: [{ ...valid.materializers[0], inspect: foreignInspect }, valid.materializers[1] as never],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(await foreignProvider.inspectRenderedTarget(inspectionInput(["contract-a"]))).toMatchObject({
            status: "failed",
            files: [],
        });
    });

    it("rejects duplicate changes within or across inspection handlers", async () => {
        const valid = targetDefinition();
        const duplicateChange = async (input: RenderedTargetInspectionInput) => ({
            status: "complete" as const,
            changes: [
                {
                    changeKind: "file_content_replacement" as const,
                    changeFingerprint: "duplicate-change",
                    semanticRefFingerprints: [],
                    replacementContent: { contentKind: "text" as const, text: "changed" },
                },
                {
                    changeKind: "file_content_replacement" as const,
                    changeFingerprint: "duplicate-change",
                    semanticRefFingerprints: [],
                    replacementContent: { contentKind: "text" as const, text: "changed" },
                },
            ],
            files: input.files.map((file) => ({
                relativePath: file.relativePath,
                attributionState: "conflict" as const,
                reasonCode: "test",
                diagnostics: [],
            })),
            diagnostics: [],
        });
        const duplicateProvider = provider(
            {
                ...valid,
                materializers: [{ ...valid.materializers[0], inspect: duplicateChange }, valid.materializers[1] as never],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(await duplicateProvider.inspectRenderedTarget(inspectionInput(["contract-a"]))).toMatchObject({
            status: "failed",
        });

        const overlapping = async (input: RenderedTargetInspectionInput) => ({
            status: "complete" as const,
            changes: [
                {
                    changeKind: "file_content_replacement" as const,
                    changeFingerprint: "cross-handler-change",
                    semanticRefFingerprints: [],
                    replacementContent: { contentKind: "text" as const, text: "changed" },
                },
            ],
            files: input.files.map((file) => ({
                relativePath: file.relativePath,
                attributionState: "conflict" as const,
                reasonCode: "test",
                diagnostics: [],
            })),
            diagnostics: [],
        });
        const overlapProvider = provider(
            {
                ...valid,
                materializers: [
                    { ...valid.materializers[0], inspect: overlapping },
                    { ...valid.materializers[1], inspect: overlapping },
                ],
            },
            TARGET_CAPABILITIES,
            MATERIALIZERS,
        );
        expect(await overlapProvider.inspectRenderedTarget(inspectionInput(["contract-a", "contract-b"]))).toMatchObject({
            status: "failed",
        });
    });

    it("partitions managed-directory inventory deltas by output contract", async () => {
        const calls: RenderedTargetInspectionInput[] = [];
        const result = provider(targetDefinition({ inspectorCalls: calls }), TARGET_CAPABILITIES, MATERIALIZERS);
        const input = inspectionInput(["contract-a", "contract-b"]);
        input.files = [];
        input.inspectionScope.directoryInventories = input.appliedRenderSnapshot.outputUnits.map((unit, index) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            boundary: { relativePath: `dir-${index}`, boundaryKind: "directory_inventory" },
            currentDescendantPaths: [],
        })) as never;
        input.inventoryDeltas = [
            { outputUnitFingerprint: "unit:contract-a", inventoryDeltaFingerprint: "delta-a1" },
            { outputUnitFingerprint: "unit:contract-a", inventoryDeltaFingerprint: "delta-a2" },
            { outputUnitFingerprint: "unit:contract-b", inventoryDeltaFingerprint: "delta-b" },
        ] as never;

        expect(await result.inspectRenderedTarget(input)).toMatchObject({ status: "complete" });
        expect(calls).toHaveLength(2);
        expect(calls.map((call) => call.inventoryDeltas.length)).toEqual([2, 1]);
        expect(calls.every((call) => call.inspectionScope.directoryInventories.length === 1)).toBe(true);
    });

    it("returns empty complete results for empty coordinator inputs", async () => {
        const result = provider(targetDefinition(), TARGET_CAPABILITIES, MATERIALIZERS);
        expect(await result.analyzeRender(analysisInput([]))).toEqual({
            status: "complete",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(await result.analyzeRender({ requiredSemantics: [] } as never)).toEqual({
            status: "complete",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = selectionInput([]);
        expect(await result.materializeRender(materialization)).toEqual({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [],
            diagnostics: [],
        });
        expect(await result.inspectRenderedTarget(inspectionInput([]))).toEqual({
            status: "complete",
            changes: [],
            files: [],
            diagnostics: [],
        });
    });

    it("fails typed instead of reporting an empty success when the Provider supports no target cell", async () => {
        const result = provider({ consumers: [], materializers: [] }, [unavailableCapability("TEST_A", "Guidance")], []);

        expect(await result.analyzeRender(analysisInput([]))).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            diagnostics: [{ code: "adapter_framework.target_handler_unavailable" }],
        });
        expect(await result.materializeRender(selectionInput([]))).toMatchObject({
            status: "failed",
            materializationState: "blocked",
            reasonCode: "adapter_framework.target_handler_unavailable",
        });
        expect(await result.inspectRenderedTarget(inspectionInput([]))).toMatchObject({
            status: "failed",
            changes: [],
            files: [],
            diagnostics: [{ code: "adapter_framework.target_handler_unavailable" }],
        });
    });
});
