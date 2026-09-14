import * as path from "node:path";
import type {
    AdapterRenderAnalysisResult,
    MaterializedRenderFile,
    RenderAnalysisInput,
    RenderAssetInput,
    RenderDeploymentInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
} from "../../../src/contracts/render";
import type { AdapterProvider as AdapterProviderContract } from "../../../src/contracts/adapter";
import type { AdapterProviderSummary } from "../../../src/types";
import { analyzeRenderDeployment } from "../../../src/render/render-analysis";
import { resolveCoreRenderSelection } from "../../../src/render/render-selection";
import { materializeRenderDeployment } from "../../../src/render/render-materialization";
import { compileRenderDeployment, openValidatedCompiledDeploymentPlan } from "../../../src/render/render-compiler";
import { EMPTY_VERSION_DIALECT_REGISTRY, publishInitialAssetVersion } from "../../../src/catalog/version-authority";
import { makeAsset, makeVersionClosure } from "../../catalog/fixtures/version-v2";
import {
    makeAnalysisResult,
    makeGuidanceRenderAsset,
    makeOutputContract,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
} from "./render-contract-fixtures";
import { createAdapterAssetSourceCapability } from "../../../src/adapters/adapter-source-capability";
import { makeContractProvider, TEST_ASSET_KINDS, testDiagnostic } from "../../adapters/fixtures/adapter-contract-fixtures";

/** Build a registry-valid live provider with the exact render fixture declarations. */
export function makeLifecycleAdapterProvider(summary: AdapterProviderSummary): AdapterProviderContract {
    const provider = makeContractProvider(summary.adapterId);
    provider.displayName = summary.displayName;
    provider.version = summary.version;
    provider.agentRuntimes = structuredClone(summary.agentRuntimes);
    provider.targetContextSchemas = structuredClone(summary.targetContextSchemas);
    provider.materializerCapabilities = structuredClone(summary.materializerCapabilities);
    provider.renderContractDeclarations = structuredClone(summary.renderContractDeclarations);
    const sourceTemplates = provider.assetSourceCapabilities;
    provider.assetSourceCapabilities = provider.agentRuntimes.flatMap((descriptor) =>
        sourceTemplates.map((template) => {
            const { sourceCapabilityFingerprint: _stored, ...input } = template;
            return createAdapterAssetSourceCapability(provider, {
                ...input,
                agentRuntimeId: descriptor.agentRuntimeId,
            });
        }),
    );
    const declaredCells = new Set(summary.assetTargetCapabilities.map((row) => `${row.agentRuntimeId}\0${row.assetKind}`));
    provider.assetTargetCapabilities = [
        ...structuredClone(summary.assetTargetCapabilities),
        ...provider.agentRuntimes.flatMap((descriptor) =>
            TEST_ASSET_KINDS.filter((assetKind) => !declaredCells.has(`${descriptor.agentRuntimeId}\0${assetKind}`)).map(
                (assetKind) => ({
                    agentRuntimeId: descriptor.agentRuntimeId,
                    entrySupportStatus: "deferred" as const,
                    assetKind,
                    diagnostics: [testDiagnostic("deferred", "render")],
                }),
            ),
        ),
    ];
    return provider;
}

export async function makeLifecycleFixture(
    root: string,
    options: {
        mutateMaterializationProof?: NonNullable<Parameters<typeof makeRenderRegistry>[0]>["mutateMaterializationProof"];
        mutateReverseProof?: NonNullable<Parameters<typeof makeRenderRegistry>[0]>["mutateReverseProof"];
        analysisResultOptions?: Parameters<typeof makeAnalysisResult>[3];
        approveRequiredOption?: boolean;
        deploymentOverrides?: Partial<RenderDeploymentInput>;
        versionClosure?: ReturnType<typeof makeVersionClosure>;
    } = {},
) {
    const contract = makeOutputContract();
    const provider = makeProviderSummary({ contract });
    const registry = makeRenderRegistry({
        providers: [provider],
        contract,
        mutateMaterializationProof: options.mutateMaterializationProof,
        mutateReverseProof: options.mutateReverseProof,
    });
    const versionClosure = options.versionClosure ?? makeVersionClosure();
    const deployment = makeRenderDeployment(registry, provider, {
        ...(options.versionClosure === undefined
            ? {}
            : {
                  assets: [
                      makeGuidanceRenderAsset({
                          version: {
                              ref: {
                                  assetId: versionClosure.manifest.assetId,
                                  versionId: versionClosure.manifest.versionId,
                              },
                              versionFingerprint: versionClosure.manifest.fingerprint,
                              versionCanonicalContentFingerprint: versionClosure.manifest.versionCanonicalContentFingerprint,
                              status: versionClosure.manifest.status,
                              canonical: {
                                  kind: versionClosure.manifest.kind,
                                  typeData: versionClosure.manifest.typeData,
                              } as RenderAssetInput["version"]["canonical"],
                              files: versionClosure.files,
                          },
                          sectionHandles: Object.fromEntries(
                              versionClosure.files.map((file, index) => [file.file.fileId, `fixture-section-${index}`]),
                          ),
                      }),
                  ],
              }),
        ...options.deploymentOverrides,
    });
    let providerAnalysisInput: RenderAnalysisInput | undefined;
    let providerAnalysisResult: AdapterRenderAnalysisResult | undefined;
    const analyzed = await analyzeRenderDeployment(deployment, {
        registry,
        resolveDialectInputs: () => [],
        dispatch: async (_adapterId, input) => {
            providerAnalysisInput = structuredClone(input);
            providerAnalysisResult = makeAnalysisResult(provider, input, contract, options.analysisResultOptions);
            return { status: "complete", value: providerAnalysisResult, diagnostics: [] };
        },
    });
    if (analyzed.status !== "complete") {
        throw new Error(`fixture analysis failed: ${JSON.stringify(analyzed.diagnostics)}`);
    }
    const assetsRoot = path.join(root, "assets");
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "txn-render-lifecycle-fixture",
        asset: makeAsset([versionClosure.manifest.versionId]),
        version: versionClosure,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    const resolved = resolveCoreRenderSelection(
        {
            deployment,
            analysis: analyzed.value,
            request: {
                schemaVersion: 1,
                renderInputFingerprint: deployment.renderInputFingerprint,
                semanticOptions: analyzed.value.requiredSemantics.map((semantic) => ({
                    optionFingerprint: analyzed.value.analyses[0]!.semanticOptions.find(
                        (option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint,
                    )!.optionFingerprint,
                    approvalRequest:
                        options.approveRequiredOption === true
                            ? {
                                  approvalAction: "approve_once" as const,
                                  userActionId: "fixture-render-approval",
                              }
                            : { approvalAction: "none" as const },
                })),
            },
        },
        {
            assetsRoot,
            oaamRoot: path.join(root, "oaam"),
            authorityLocksRoot: path.join(root, "locks"),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            registry,
            confirmOneTimeApproval: () => (options.approveRequiredOption === true ? 100 : null),
            resolveSavedPolicy: () => null,
            now: () => 100,
        },
    );
    if (resolved.status !== "complete") throw new Error("fixture selection failed");
    return {
        contract,
        provider,
        registry,
        deployment,
        providerAnalysisInput: providerAnalysisInput as RenderAnalysisInput,
        providerAnalysisResult: providerAnalysisResult as AdapterRenderAnalysisResult,
        analysis: analyzed.value,
        selection: resolved.value,
        assetsRoot,
    };
}

export function materializeFixtureResult(
    input: RenderMaterializationInput,
    mutateFile: (file: MaterializedRenderFile) => void = () => undefined,
): RenderMaterializationResult {
    const semanticRefs = input.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort();
    return {
        status: "complete",
        materializationState: "materialized",
        materializedUnits: input.selection.outputUnits.map((unit) => {
            const unitRefs = input.selection.semanticOptions
                .filter((option) => option.requiredOutputUnitFingerprints.includes(unit.outputUnitFingerprint))
                .map((option) => option.semanticRefFingerprint)
                .filter((ref) => semanticRefs.includes(ref))
                .sort();
            return {
                outputUnitFingerprint: unit.outputUnitFingerprint,
                files: unit.claims.map((claim) => {
                    const file: MaterializedRenderFile = {
                        relativePath: claim.relativePath,
                        content:
                            claim.contentKind === "text"
                                ? { contentKind: "text", text: "# materialized\n" }
                                : { contentKind: "binary", bytes: new Uint8Array([1, 2, 3]) },
                        executable: claim.executable,
                        semanticRefFingerprints: unitRefs,
                        sectionBindings: [],
                    };
                    mutateFile(file);
                    return file;
                }),
            };
        }),
        diagnostics: [],
    };
}

export async function makeCompiledLifecycleFixture(root: string, options: Parameters<typeof makeLifecycleFixture>[1] = {}) {
    const fixture = await makeLifecycleFixture(root, options);
    const materialized = await materializeRenderDeployment(
        {
            deployment: fixture.deployment,
            analysis: fixture.analysis,
            selection: fixture.selection,
        },
        {
            registry: fixture.registry,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            resolveDialectInputs: () => [],
            dispatch: async (_adapterId, input) => ({
                status: "complete",
                value: materializeFixtureResult(input),
                diagnostics: [],
            }),
        },
    );
    if (materialized.status !== "complete") throw new Error("fixture materialization failed");
    const appliedInputsSnapshot = {
        schemaVersion: 1 as const,
        deploymentId: fixture.deployment.deploymentId,
        consumerAgentRuntimeIds: [...fixture.deployment.consumerAgentRuntimeIds],
        assets: fixture.deployment.assets.map((asset) => ({
            assetId: asset.version.ref.assetId,
            versionId: asset.version.ref.versionId,
            allowIncomplete: asset.allowIncomplete,
        })),
    };
    const compiled = compileRenderDeployment({
        deployment: fixture.deployment,
        analysis: fixture.analysis,
        selection: fixture.selection,
        materialization: materialized.value,
        appliedInputsSnapshot,
    });
    if (compiled.status !== "complete") throw new Error("fixture compilation failed");
    return {
        ...fixture,
        materialization: materialized.value,
        appliedInputsSnapshot,
        compiledToken: compiled.value,
        compiled: openValidatedCompiledDeploymentPlan(compiled.value),
    };
}
