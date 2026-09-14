/** Shared deterministic fixtures for the split render authority tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import type {
    AdapterRenderAnalysisResult,
    RenderAnalysisInput,
    RenderAnalysisView,
    RenderDeploymentInput,
    RenderSelectionRequest,
} from "../../../src/contracts/render";
import { analyzeRenderDeployment } from "../../../src/render/render-analysis";
import {
    resolveCoreRenderSelection,
    resolveCoreRenderSelectionForStagedVersion,
    type RenderSelectionConfiguration,
} from "../../../src/render/render-selection";
import { publishInitialAssetVersion, EMPTY_VERSION_DIALECT_REGISTRY } from "../../../src/catalog/version-authority";
import {
    computeGlobalPromotionTargetAuthorityFingerprint,
    computeImportProvenanceAuthorityFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderInputFingerprint,
    computeRenderOptionFingerprint,
    computeRenderOutputUnitFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../../src/foundation/fingerprint";
import type { buildPromotionGrantAuthority } from "../../../src/catalog/promotion-grant-store";
import {
    setRestrictedSourceFullAccessAuthority,
    virginRestrictedSourceFullAccessAuthority,
} from "../../../src/catalog/settings-authority";
import { tryAcquireAuthorityLockLease } from "../../../src/foundation/authority-locks";
import { makeAsset, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "../../catalog/fixtures/version-v2";
import {
    makeAnalysisResult,
    makeGuidanceRenderAsset,
    makeOutputContract,
    makeOutputUnit,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
    RENDER_PROJECT_ID,
} from "./render-contract-fixtures";

export const VERSION_ID_3 = "ffffffff-ffff-4fff-8fff-ffffffffffff" as typeof VERSION_ID;

export interface SelectionFixture {
    contract: ReturnType<typeof makeOutputContract>;
    provider: ReturnType<typeof makeProviderSummary>;
    registry: ReturnType<typeof makeRenderRegistry>;
    deployment: RenderDeploymentInput;
    input: RenderAnalysisInput;
    providerResult: AdapterRenderAnalysisResult;
    analysis: RenderAnalysisView;
    request: RenderSelectionRequest;
    configuration: RenderSelectionConfiguration;
}

export let sandbox = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-render-selection-"));
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

export async function selectionFixture(
    options: {
        outcome?: "preserved" | "degraded";
        reversePolicy?: "can_reconcile" | "ignore_generated_wrapper" | "unsupported";
        publishAsset?: boolean;
        confirm?: RenderSelectionConfiguration["confirmOneTimeApproval"];
        resolveSavedPolicy?: RenderSelectionConfiguration["resolveSavedPolicy"];
        now?: () => number;
        projectScoped?: boolean;
        buildAnalysisResult?: typeof makeAnalysisResult;
    } = {},
): Promise<SelectionFixture> {
    const fixtureRoot = fs.mkdtempSync(path.join(sandbox, "fixture-"));
    const contract = makeOutputContract();
    const provider = makeProviderSummary({ contract });
    const registry = makeRenderRegistry({ providers: [provider], contract });
    const renderAsset = options.projectScoped
        ? makeGuidanceRenderAsset({
              scope: "project",
              projectId: RENDER_PROJECT_ID,
              scopePath: "",
          })
        : makeGuidanceRenderAsset();
    const deployment = makeRenderDeployment(registry, provider, {
        projectId: options.projectScoped ? RENDER_PROJECT_ID : "",
        assets: [renderAsset],
    });
    let captured: RenderAnalysisInput | undefined;
    let providerResult: AdapterRenderAnalysisResult | undefined;
    const analyzed = await analyzeRenderDeployment(deployment, {
        registry,
        resolveDialectInputs: () => [],
        dispatch: async (_adapterId, input) => {
            captured = structuredClone(input);
            providerResult = options.buildAnalysisResult
                ? options.buildAnalysisResult(provider, input, contract)
                : makeAnalysisResult(provider, input, contract, options);
            return { status: "complete", value: providerResult, diagnostics: [] };
        },
    });
    expect(analyzed.status).toBe("complete");
    const assetsRoot = path.join(fixtureRoot, "assets");
    if (options.publishAsset !== false) {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-selection-fixture",
            asset: makeAsset(
                [VERSION_ID],
                options.projectScoped
                    ? {
                          scope: "project",
                          projectId: RENDER_PROJECT_ID,
                          scopePath: "",
                      }
                    : {},
            ),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
    }
    const request: RenderSelectionRequest = {
        schemaVersion: 1,
        renderInputFingerprint: deployment.renderInputFingerprint,
        semanticOptions: analyzed.value.requiredSemantics.map((semantic) => ({
            optionFingerprint: analyzed.value.analyses[0]!.semanticOptions.find(
                (option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint,
            )!.optionFingerprint,
            approvalRequest: { approvalAction: "none" },
        })),
    };
    return {
        contract,
        provider,
        registry,
        deployment,
        input: captured as RenderAnalysisInput,
        providerResult: providerResult as AdapterRenderAnalysisResult,
        analysis: analyzed.value,
        request,
        configuration: {
            assetsRoot,
            oaamRoot: path.join(fixtureRoot, "oaam"),
            authorityLocksRoot: path.join(fixtureRoot, "locks"),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            registry,
            confirmOneTimeApproval: options.confirm ?? (() => null),
            resolveSavedPolicy: options.resolveSavedPolicy ?? (() => null),
            now: options.now ?? (() => 1234),
        },
    };
}

export function selectionResult(fixture: SelectionFixture) {
    return resolveCoreRenderSelection(
        {
            deployment: fixture.deployment,
            analysis: fixture.analysis,
            request: fixture.request,
        },
        fixture.configuration,
    );
}

export async function refreshAnalysis(
    fixture: SelectionFixture,
    buildAnalysisResult: typeof makeAnalysisResult = makeAnalysisResult,
): Promise<void> {
    let captured: RenderAnalysisInput | undefined;
    let providerResult: AdapterRenderAnalysisResult | undefined;
    const analyzed = await analyzeRenderDeployment(fixture.deployment, {
        registry: fixture.registry,
        resolveDialectInputs: () => [],
        dispatch: async (adapterId, input) => {
            captured = structuredClone(input);
            const provider = fixture.registry.getProvider(adapterId)!;
            providerResult = buildAnalysisResult(provider, input, fixture.contract);
            return { status: "complete", value: providerResult, diagnostics: [] };
        },
    });
    expect(analyzed.status).toBe("complete");
    fixture.input = captured as RenderAnalysisInput;
    fixture.providerResult = providerResult as AdapterRenderAnalysisResult;
    fixture.analysis = analyzed.value;
    fixture.request = {
        schemaVersion: 1,
        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        semanticOptions: analyzed.value.requiredSemantics.map((semantic) => ({
            optionFingerprint: analyzed.value.analyses[0]!.semanticOptions.find(
                (option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint,
            )!.optionFingerprint,
            approvalRequest: { approvalAction: "none" },
        })),
    };
}

export function makeTwoUnitAnalysis(
    mutatePrimary: (unit: ReturnType<typeof makeOutputUnit>) => void = () => undefined,
    mutateSecond: (unit: ReturnType<typeof makeOutputUnit>) => void = () => undefined,
): typeof makeAnalysisResult {
    return (provider, input, contract) => {
        const result = makeAnalysisResult(provider, input, contract);
        const primary = result.outputUnits[0]!;
        const oldPrimaryFingerprint = primary.outputUnitFingerprint;
        mutatePrimary(primary);
        const { outputUnitFingerprint: _primaryStored, ...primaryPreimage } = primary;
        primary.outputUnitFingerprint = computeRenderOutputUnitFingerprint(primaryPreimage);
        for (const option of result.semanticOptions) {
            option.requiredOutputUnitFingerprints = option.requiredOutputUnitFingerprints.map((fingerprint) =>
                fingerprint === oldPrimaryFingerprint ? primary.outputUnitFingerprint : fingerprint,
            );
        }

        const second = makeOutputUnit(contract, "OTHER.md");
        mutateSecond(second);
        const { outputUnitFingerprint: _secondStored, ...secondPreimage } = second;
        second.outputUnitFingerprint = computeRenderOutputUnitFingerprint(secondPreimage);
        result.outputUnits.push(second);
        result.semanticOptions[result.semanticOptions.length - 1]!.requiredOutputUnitFingerprints = [
            second.outputUnitFingerprint,
        ];

        const dialectFingerprint = computeProviderRenderDialectInputFingerprint({
            adapterId: provider.adapterId,
            adapterVersion: provider.version,
            dialectInputs: input.dialectInputs,
        });
        for (const option of result.semanticOptions) {
            const { optionFingerprint: _stored, diagnostics: _diagnostics, ...preimage } = option;
            option.optionFingerprint = computeRenderOptionFingerprint({
                adapterId: provider.adapterId,
                adapterVersion: provider.version,
                renderInputFingerprint: input.deployment.renderInputFingerprint,
                providerRenderDialectInputFingerprint: dialectFingerprint,
                option: preimage,
            });
        }
        return result;
    };
}

export function pointDeploymentAtVersion(fixture: SelectionFixture, closure: ReturnType<typeof makeVersionClosure>): void {
    const asset = fixture.deployment.assets[0]!;
    asset.version = {
        ref: {
            assetId: closure.manifest.assetId,
            versionId: closure.manifest.versionId,
        },
        versionFingerprint: closure.manifest.fingerprint,
        versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
        status: closure.manifest.status,
        canonical: {
            kind: closure.manifest.kind,
            typeData: closure.manifest.typeData,
        } as never,
        files: closure.files,
    };
    asset.sectionHandles = Object.fromEntries(closure.files.map((file) => [file.file.fileId, `section-${file.file.fileId}`]));
    const { renderInputFingerprint: _stored, ...preimage } = fixture.deployment;
    fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
}

export function makeImportedClosure(promotionSafety: "default_promotable" | "requires_user_confirmation") {
    const closure = makeVersionClosure();
    const provenancePreimage = {
        schemaVersion: 1 as const,
        importProvenanceId: "import-provenance-fixture",
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        previewSnapshotFingerprint: `sha256:${"1".repeat(64)}` as const,
        candidateFingerprint: `sha256:${"2".repeat(64)}` as const,
        acceptedFreshness: "current_source_verified" as const,
        acceptedPromotion: {
            promotionAction: "import_only" as const,
            userActionEvidenceId: "import-action",
        },
        promotionSafety,
        importedAt: 100,
    };
    const importProvenanceAuthority = {
        ...provenancePreimage,
        authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
    };
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        originKind: "import" as const,
        importProvenanceId: importProvenanceAuthority.importProvenanceId,
        importProvenanceAuthorityFingerprint: importProvenanceAuthority.authorityFingerprint,
        promotionRequirement: "requires_current_authorization" as const,
        createdAt: 100,
    };
    closure.manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    Object.assign(closure.manifest, { importProvenanceAuthority });
    return closure as typeof closure & {
        manifest: typeof closure.manifest & {
            importProvenanceAuthority: typeof importProvenanceAuthority;
        };
    };
}

export function makeReverseClosure(
    parent: ReturnType<typeof makeVersionClosure>,
    input: {
        versionId?: typeof VERSION_ID;
        revision?: number;
        previousVersionId?: string;
        previousOriginFingerprint?: `sha256:${string}`;
        promotionRequirement?: "not_required" | "requires_current_authorization";
    } = {},
) {
    const closure = makeVersionClosure({
        versionId: input.versionId ?? VERSION_ID_2,
        revision: input.revision ?? 2,
        sourceVersionId: parent.manifest.versionId,
        changeKind: "extract",
        createdAt: 200,
    });
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        originKind: "reverse_accept" as const,
        previousVersionId: input.previousVersionId ?? parent.manifest.versionId,
        previousVersionOriginAuthorityFingerprint:
            input.previousOriginFingerprint ?? parent.manifest.originAuthority.authorityFingerprint,
        reversePreparationIdentityFingerprint: `sha256:${"3".repeat(64)}` as const,
        userActionEvidenceId: "reverse-action",
        promotionRequirement: input.promotionRequirement ?? "requires_current_authorization",
        createdAt: 200,
    };
    closure.manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    return closure;
}

export function globalTarget(fixture: SelectionFixture) {
    return {
        targetKind: "global_target" as const,
        targetAuthorityFingerprint: computeGlobalPromotionTargetAuthorityFingerprint({
            platform: fixture.deployment.platform,
            platformInstanceId: fixture.deployment.platformInstanceId,
            targetRootPath: fixture.deployment.targetRootPath,
            consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
        }),
    };
}

export function enableFullAccess(fixture: SelectionFixture): void {
    const virgin = virginRestrictedSourceFullAccessAuthority();
    setRestrictedSourceFullAccessAuthority({
        oaamRoot: fixture.configuration.oaamRoot,
        expectedRevision: virgin.revision,
        expectedSettingFingerprint: virgin.settingFingerprint,
        nextState: "enabled",
        userActionEvidenceId: "full-access-action",
        changedAt: 101,
    });
}

export function resolveStagedSelection(
    fixture: SelectionFixture,
    version: ReturnType<typeof makeReverseClosure>,
    promotionGrant?: ReturnType<typeof buildPromotionGrantAuthority>,
) {
    const assetLease = tryAcquireAuthorityLockLease(fixture.configuration.authorityLocksRoot, "assets", [
        version.manifest.assetId,
    ]);
    const settingsLease = tryAcquireAuthorityLockLease(fixture.configuration.authorityLocksRoot, "settings", ["settings"]);
    if (assetLease === null || settingsLease === null) {
        throw new Error("staged selection authority fixture is busy");
    }
    try {
        return resolveCoreRenderSelectionForStagedVersion(
            {
                deployment: fixture.deployment,
                analysis: fixture.analysis,
                request: fixture.request,
            },
            fixture.configuration,
            {
                assetAuthorityLeaseProof: assetLease.proof,
                settingsAuthorityLeaseProof: settingsLease.proof,
            },
            { version, promotionGrant },
        );
    } finally {
        settingsLease.release();
        assetLease.release();
    }
}
