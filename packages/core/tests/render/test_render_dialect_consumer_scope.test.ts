import { describe, expect, it } from "vitest";
import type { AdapterNativeExactGraphRenderDeclarationV1 } from "../../src/contracts/source-import";
import type { ProviderRenderDialectInputsForAsset, RenderVersionDialectInputs } from "../../src/contracts/render";
import { computeProviderRenderDialectInputFingerprint } from "../../src/foundation/fingerprint";
import { resolveProviderExactFileDialectInputs } from "../../src/render/render-dialect-authority";
import { projectRenderDialectInputs } from "../../src/render/render-dialect-scope";
import { validateDialectInputProjection } from "../../src/render/render-analysis-validator";
import { deriveRequiredRenderSemanticsV1 } from "../../src/render/render-semantics";
import { makeExactFileFixture } from "./fixtures/native-project-exact-file-test-fixtures";
import {
    CATALOG_VERSION_ID,
    UNIT_VERSION_ID,
    SECOND_UNIT_VERSION_ID,
    makeMemoryCatalogExactFileFixture,
} from "./fixtures/native-project-memory-catalog-test-fixtures";

const OTHER = "OTHER_CLI";
const HASH = `sha256:${"9".repeat(64)}` as const;
function migration(componentId: string): NonNullable<AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"]> {
    return {
        materializer: { componentId, componentVersion: 1, configFingerprint: HASH },
        degradationKinds: ["runtime_specific_metadata_lost"],
        reasonCode: componentId,
    };
}
function twoConsumers() {
    const fixture = makeExactFileFixture();
    const provider = structuredClone(fixture.provider);
    const declaration = provider.renderContractDeclarations[0]!;
    if (declaration.declarationKind !== "native_project_exact_file_v1") throw new Error("missing fixture declaration");
    const sibling = { ...structuredClone(declaration), agentRuntimeId: OTHER };
    provider.renderContractDeclarations.push(sibling);
    provider.agentRuntimes.push({ agentRuntimeId: OTHER, displayName: "Other CLI", entryClass: "cli" });
    const deployment = structuredClone(fixture.deployment);
    deployment.consumerAgentRuntimeIds.push(OTHER);
    deployment.targetContexts.push({ ...structuredClone(deployment.targetContexts[0]!), agentRuntimeId: OTHER });
    const semantics = deriveRequiredRenderSemanticsV1(deployment);
    const available: RenderVersionDialectInputs[] = fixture.analysisInput.dialectInputs.map(({ targetVersion, inputs }) => ({
        targetVersion,
        inputs,
    }));
    const resolve = () => resolveProviderExactFileDialectInputs({ provider, deployment, semantics, available });
    return { fixture, provider, declaration, sibling, deployment, semantics, available, resolve };
}

describe("exact consumer and Version dialect authority", () => {
    it("shares identical sibling native bytes while each handler receives only its selected consumer", () => {
        const f = twoConsumers();
        const projected = f.resolve();
        expect(projected).toHaveLength(1);
        expect(projected[0]?.consumerAgentRuntimeIds).toEqual([f.fixture.descriptor.agentRuntimeId, OTHER].sort());
        expect(projected[0]?.inputs).toEqual(f.available[0]?.inputs);
        validateDialectInputProjection(projected, f.deployment.assets, f.semantics);
        for (const consumer of projected[0]!.consumerAgentRuntimeIds) {
            const selected = f.semantics.filter((semantic) => semantic.consumerAgentRuntimeId === consumer);
            expect(projectRenderDialectInputs(projected, selected, f.deployment.assets)).toEqual([
                { ...projected[0], consumerAgentRuntimeIds: [consumer] },
            ]);
        }
    });

    it("keeps current native and sibling canonical fallback independent even for one Version", () => {
        const f = twoConsumers();
        f.sibling.nativeDialectId = "other-native-v1";
        f.sibling.canonicalMaterialization = migration("other-reviewed-conversion");
        const projected = f.resolve();
        expect(projected).toHaveLength(2);
        const own = projected.find((group) => group.consumerAgentRuntimeIds.includes(f.fixture.descriptor.agentRuntimeId))!;
        const other = projected.find((group) => group.consumerAgentRuntimeIds.includes(OTHER))!;
        expect(own.inputs[0]?.inputKind).toBe("native_representation");
        expect(other.inputs).toMatchObject([{ inputKind: "canonical_materialization", nativeDialectId: "other-native-v1" }]);
        validateDialectInputProjection(projected, f.deployment.assets, f.semantics);
        const selected = f.semantics.filter((semantic) => semantic.consumerAgentRuntimeId === OTHER);
        expect(projectRenderDialectInputs(projected, selected, f.deployment.assets)).toEqual([other]);
    });

    it("preserves distinct same-dialect canonical approvals and binds their scope into fingerprints", () => {
        const f = twoConsumers();
        f.available.length = 0;
        f.declaration.canonicalMaterialization = migration("own-conversion");
        f.sibling.canonicalMaterialization = migration("other-conversion");
        const projected = f.resolve();
        expect(projected).toHaveLength(2);
        validateDialectInputProjection(projected, f.deployment.assets, f.semantics);
        const fingerprint = (groups: ProviderRenderDialectInputsForAsset[]) =>
            computeProviderRenderDialectInputFingerprint({
                adapterId: f.provider.adapterId,
                adapterVersion: f.provider.version,
                dialectInputs: groups,
            });
        expect(fingerprint([...projected].reverse())).toBe(fingerprint(projected));
        const swapped = structuredClone(projected);
        [swapped[0]!.consumerAgentRuntimeIds, swapped[1]!.consumerAgentRuntimeIds] = [
            swapped[1]!.consumerAgentRuntimeIds,
            swapped[0]!.consumerAgentRuntimeIds,
        ];
        expect(fingerprint(swapped)).not.toBe(fingerprint(projected));
        expect(() =>
            validateDialectInputProjection([projected[0]!, structuredClone(projected[0]!)], f.deployment.assets, f.semantics),
        ).toThrow(/consumer scope/);
    });

    it("rejects consumer-Version cross pairing even when both independent identity sets match", () => {
        const f = twoConsumers();
        const first = f.deployment.assets[0]!;
        const second = structuredClone(first);
        second.version.ref = {
            assetId: "11111111-1111-4111-8111-111111111111",
            versionId: "22222222-2222-4222-8222-222222222222",
        };
        f.deployment.assets.push(second);
        const selected = f.semantics.map((semantic) =>
            semantic.consumerAgentRuntimeId === OTHER
                ? {
                      ...semantic,
                      subject: { ...semantic.subject, ...second.version.ref },
                  }
                : semantic,
        );
        const projected = f.resolve()[0]!;
        const wrong: ProviderRenderDialectInputsForAsset[] = [
            { ...projected, consumerAgentRuntimeIds: [OTHER] },
            { ...projected, targetVersion: second.version.ref, consumerAgentRuntimeIds: [f.fixture.descriptor.agentRuntimeId] },
        ];
        expect(() => validateDialectInputProjection(wrong, f.deployment.assets, selected)).toThrow(/consumer scope/);
        expect(projectRenderDialectInputs(wrong, selected, f.deployment.assets)).toEqual([]);
    });

    it("keeps true same-consumer declaration conflicts blocked without suppressing a valid sibling", () => {
        const f = twoConsumers();
        const conflicting = structuredClone(f.declaration);
        conflicting.rebaseMaterializer = null;
        f.provider.renderContractDeclarations.push(conflicting);
        const projected = f.resolve();
        expect(projected).toHaveLength(1);
        expect(projected[0]?.consumerAgentRuntimeIds).toEqual([OTHER]);
    });

    it("does not invent dialect authority for an absent Memory catalog member", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const assets = fixture.deployment.assets.filter((asset) => asset.version.ref.versionId !== UNIT_VERSION_ID);
        const semantics = fixture.analysisInput.requiredSemantics.filter(
            (semantic) => semantic.subject.versionId !== UNIT_VERSION_ID,
        );
        const projected = projectRenderDialectInputs(fixture.analysisInput.dialectInputs, semantics, assets);
        expect(projected.some((group) => group.targetVersion.versionId === UNIT_VERSION_ID)).toBe(false);
        expect(projected.some((group) => group.targetVersion.versionId === CATALOG_VERSION_ID)).toBe(true);
    });

    it("retains Memory member authority only in its Catalog consumer scope", () => {
        const f = makeMemoryCatalogExactFileFixture();
        const projected = resolveProviderExactFileDialectInputs({
            provider: f.provider,
            deployment: f.deployment,
            semantics: f.analysisInput.requiredSemantics,
            available: f.analysisInput.dialectInputs,
        });
        expect(projected.map((group) => group.targetVersion.versionId).sort()).toEqual(
            [CATALOG_VERSION_ID, UNIT_VERSION_ID].sort(),
        );
        expect(projected.some((group) => group.targetVersion.versionId === SECOND_UNIT_VERSION_ID)).toBe(false);
        validateDialectInputProjection(projected, f.deployment.assets, f.analysisInput.requiredSemantics);
        const selected = projectRenderDialectInputs(projected, f.analysisInput.requiredSemantics, f.deployment.assets);
        expect(selected.map((group) => group.targetVersion)).toEqual(projected.map((group) => group.targetVersion));
        const foreignMember = structuredClone(
            projected.find((group) => group.targetVersion.assetId !== f.catalogAsset.version.ref.assetId)!,
        );
        foreignMember.consumerAgentRuntimeIds = [OTHER];
        expect(() =>
            validateDialectInputProjection([foreignMember], f.deployment.assets, f.analysisInput.requiredSemantics),
        ).toThrow(/consumer scope/);
    });
});
