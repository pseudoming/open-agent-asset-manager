/** Zero-file Memory Catalog reverse staging and immutable Version publication. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { UuidV4 } from "../../src/types";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import {
    publishAssetVersion,
    publishInitialAssetVersion,
    validateVersionMaterialClosure,
} from "../../src/catalog/version-authority";
import {
    computeRenderInputFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import { deriveRequiredRenderSemanticsV1 } from "../../src/render/render-semantics";
import { makeAsset, makeVersionClosure } from "../catalog/fixtures/version-v2";
import {
    CATALOG_ASSET_ID,
    CATALOG_PROJECT_ID,
    CATALOG_VERSION_ID,
    CHANGED_CATALOG_TEXT,
    MEMORY_CATALOG_PATH,
    SECOND_UNIT_ASSET_ID,
    SECOND_UNIT_VERSION_ID,
    UNIT_ASSET_ID,
    UNIT_VERSION_ID,
    changedCatalogCanonical,
    makeMemoryCatalogExactFileFixture,
    makeMemoryCatalogInspectionInput,
} from "../render/fixtures/native-project-memory-catalog-test-fixtures";

const STAGED_VERSION_ID = "90909090-9090-4090-8090-909090909090" as UuidV4;
const CHILD_VERSION_ID = "91919191-9191-4191-8191-919191919191" as UuidV4;

describe("deployment lifecycle Memory Catalog projection", () => {
    it("publishes changed membership as a zero-file Version and preserves deployed Unit authority", () => {
        const published = publishCatalogFixture();
        try {
            const invocation = stagingInvocation(published);
            const before = structuredClone(invocation.base);
            const staged = deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                invocation.configuration,
                invocation.inspected,
                invocation.base,
                STAGED_VERSION_ID,
            );
            expect(staged).toMatchObject({
                assetId: CATALOG_ASSET_ID,
                versionId: STAGED_VERSION_ID,
                revision: 2,
                parentVersionId: CATALOG_VERSION_ID,
                canonical: changedCatalogCanonical(),
                files: [],
            });
            expect(staged.nativeRepresentations).toHaveLength(1);
            expect(Buffer.from(staged.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(CHANGED_CATALOG_TEXT);

            const originPreimage = {
                schemaVersion: 1 as const,
                assetId: staged.assetId,
                versionId: staged.versionId,
                originKind: "reverse_accept" as const,
                previousVersionId: staged.parentVersionId,
                previousVersionOriginAuthorityFingerprint: staged.parentOriginAuthorityFingerprint,
                reversePreparationIdentityFingerprint: `sha256:${"7".repeat(64)}` as const,
                userActionEvidenceId: "memory-catalog-reverse",
                promotionRequirement: staged.promotionRequirement,
                createdAt: published.fixture.catalogClosure.manifest.createdAt + 1,
            };
            const closure = deploymentLifecycleInternalsForTest.buildStagedVersionClosure(
                staged,
                {
                    ...originPreimage,
                    authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
                },
                published.fixture.deployment.deploymentId,
            );
            validateVersionMaterialClosure(closure, published.dialectRegistry);
            expect(closure.manifest.files).toEqual([]);
            expect(closure.manifest.typeData).toEqual(changedCatalogCanonical().typeData);

            const projected = deploymentLifecycleInternalsForTest.projectStagedRenderBase(invocation.base, staged);
            expect(projected.assets[0]!.version.ref.versionId).toBe(STAGED_VERSION_ID);
            expect(projected.assets.slice(1)).toEqual(before.assets.slice(1));
            expect(projected.appliedInputsSnapshot.assets.slice(1)).toEqual(before.appliedInputsSnapshot.assets.slice(1));
            expect(projected.dialectInputs.slice(1)).toEqual(before.dialectInputs.slice(1));
            expect(projected.dialectInputs[0]).toMatchObject({
                targetVersion: { assetId: CATALOG_ASSET_ID, versionId: STAGED_VERSION_ID },
                inputs: [
                    {
                        inputKind: "native_representation",
                        inputRole: "current_exact",
                        representation: { canonicalContentFingerprint: staged.versionCanonicalContentFingerprint },
                    },
                ],
            });
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("blocks undeployed members, stale lineage and malformed changed native bytes", () => {
        const published = publishCatalogFixture();
        try {
            const missing = stagingInvocation(published);
            const replacement = missing.inspected.result.changes[0];
            if (replacement?.changeKind !== "asset_type_data_replacement" || replacement.replacement.kind !== "Memory") {
                throw new Error("Catalog replacement fixture missing");
            }
            replacement.replacement.typeData = {
                schemaVersion: 2,
                entityRole: "catalog",
                members: [
                    {
                        targetAssetVersionId: "abababab-abab-4bab-8bab-abababababab",
                        routingTitle: "Missing",
                        routingHint: "",
                    },
                ],
            };
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    missing.configuration,
                    missing.inspected,
                    missing.base,
                    STAGED_VERSION_ID,
                ),
            ).toThrow(/same-scope Memory Units/);

            const stale = stagingInvocation(published);
            const native = stale.inspected.operation.dialectInputs[0]?.inputs[0];
            if (native?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
            native.representation.canonicalContentFingerprint = `sha256:${"0".repeat(64)}`;
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    stale.configuration,
                    stale.inspected,
                    stale.base,
                    STAGED_VERSION_ID,
                ),
            ).toThrow(/immediate Version lineage/);

            const invalid = stagingInvocation(published);
            const changed = invalid.inspected.input.files[0];
            if (changed?.fileState !== "baseline_changed" || changed.currentContent.contentKind !== "text") {
                throw new Error("Catalog changed file missing");
            }
            changed.currentContent.text = `${CHANGED_CATALOG_TEXT}- [Missing](topics/missing.md)\n`;
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    invalid.configuration,
                    invalid.inspected,
                    invalid.base,
                    STAGED_VERSION_ID,
                ),
            ).toThrow(/validator rejected/);

            const guards: Array<{
                expected: RegExp;
                mutate(value: ReturnType<typeof stagingInvocation>): void;
            }> = [
                {
                    expected: /one applied Catalog Asset/,
                    mutate: ({ inspected }) => {
                        inspected.appliedRenderSnapshot.decisions.push(
                            structuredClone(inspected.appliedRenderSnapshot.decisions[0]!),
                        );
                    },
                },
                {
                    expected: /zero-file applied Catalog Asset/,
                    mutate: ({ base }) => {
                        base.assets[0]!.version.status = "incomplete";
                    },
                },
                {
                    expected: /invalid canonical membership/,
                    mutate: ({ inspected }) => {
                        const change = inspected.result.changes[0];
                        if (change?.changeKind !== "asset_type_data_replacement" || change.replacement.kind !== "Memory") {
                            throw new Error("Catalog replacement fixture missing");
                        }
                        change.replacement.typeData.members.push(structuredClone(change.replacement.typeData.members[0]!));
                    },
                },
                {
                    expected: /no unique current Provider target contract/,
                    mutate: ({ inspected }) => {
                        const changed = inspected.input.files[0];
                        if (changed?.fileState !== "baseline_changed") throw new Error("Catalog changed file missing");
                        changed.relativePath = "wrong.md";
                    },
                },
                {
                    expected: /parent Version is missing/,
                    mutate: ({ base }) => {
                        base.assets[0]!.version.versionFingerprint = `sha256:${"1".repeat(64)}`;
                    },
                },
                {
                    expected: /exactly one uniquely attributable membership replacement/,
                    mutate: ({ inspected }) => {
                        inspected.result.status = "partial";
                    },
                },
                {
                    expected: /exactly one uniquely attributable membership replacement/,
                    mutate: ({ inspected }) => {
                        inspected.result.files[0] = {
                            relativePath: MEMORY_CATALOG_PATH,
                            attributionState: "conflict",
                            reasonCode: "fixture",
                            diagnostics: [],
                        };
                    },
                },
                {
                    expected: /no unique applied target-dialect input/,
                    mutate: ({ inspected }) => {
                        inspected.operation.dialectInputs = inspected.operation.dialectInputs.filter(
                            (group) => group.targetVersion.assetId !== CATALOG_ASSET_ID,
                        );
                    },
                },
                {
                    expected: /matching selected native text index/,
                    mutate: ({ inspected }) => {
                        const native = inspected.operation.dialectInputs[0]?.inputs[0];
                        if (native?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
                        native.files[0]!.executable = true;
                    },
                },
            ];
            for (const { expected, mutate } of guards) {
                const guarded = stagingInvocation(published);
                mutate(guarded);
                expect(() =>
                    deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                        guarded.configuration,
                        guarded.inspected,
                        guarded.base,
                        STAGED_VERSION_ID,
                    ),
                ).toThrow(expected);
            }
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });

    it("accepts an exact immediate-parent Catalog seed and rejects every stale parent lineage", () => {
        const published = publishCatalogFixture();
        try {
            publishCatalogChild(published);
            const exact = stagingInvocation(published);
            expect(
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    exact.configuration,
                    exact.inspected,
                    exact.base,
                    STAGED_VERSION_ID,
                ),
            ).toMatchObject({ parentVersionId: CHILD_VERSION_ID, revision: 3 });

            const staleLineages: Array<
                (
                    native: Extract<
                        (typeof exact.inspected.operation.dialectInputs)[number]["inputs"][number],
                        { inputKind: "native_representation" }
                    >,
                ) => void
            > = [
                (native) => {
                    native.sourceVersion.assetId = UNIT_ASSET_ID;
                },
                (native) => {
                    native.sourceVersion.versionId = SECOND_UNIT_VERSION_ID;
                },
            ];
            for (const mutate of staleLineages) {
                const stale = stagingInvocation(published);
                const native = stale.inspected.operation.dialectInputs[0]?.inputs[0];
                if (native?.inputKind !== "native_representation" || native.inputRole !== "parent_rebase_seed") {
                    throw new Error("Catalog parent seed missing");
                }
                mutate(native);
                expect(() =>
                    deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                        stale.configuration,
                        stale.inspected,
                        stale.base,
                        STAGED_VERSION_ID,
                    ),
                ).toThrow(/immediate Version lineage/);
            }
        } finally {
            fs.rmSync(published.assetsRoot, { recursive: true, force: true });
        }
    });
});

function publishCatalogFixture() {
    const fixture = makeMemoryCatalogExactFileFixture();
    const assetsRoot = path.join(os.tmpdir(), `oaam-memory-catalog-parent-${process.pid}-${Date.now()}-${Math.random()}`);
    const dialectRegistry = createVersionDialectRegistry([fixture.nativeDialect], [], [], []);
    const catalogNative = fixture.catalogDialectInput.inputs[0];
    if (catalogNative?.inputKind !== "native_representation") throw new Error("Catalog native fixture missing");
    fixture.catalogClosure.manifest.nativeRepresentations = [
        {
            ...structuredClone(catalogNative.representation),
            files: catalogNative.files.map(({ text: _text, ...descriptor }) => descriptor),
        },
    ];
    fixture.catalogClosure.nativePayloads = [
        {
            dialectId: catalogNative.representation.dialectId,
            files: catalogNative.files.map((file) => ({
                relativePath: file.relativePath,
                bytes: Buffer.from(file.contentKind === "text" ? file.text : file.bytes),
            })),
        },
    ];
    fixture.catalogClosure.manifest.fingerprint = computeVersionFingerprint(
        fixture.catalogClosure.manifest.versionCanonicalContentFingerprint,
        fixture.catalogClosure.manifest.nativeRepresentations,
        [],
        [],
    );
    fixture.catalogAsset.version.versionFingerprint = fixture.catalogClosure.manifest.fingerprint;
    for (const [assetId, versionId, closure] of [
        [UNIT_ASSET_ID, UNIT_VERSION_ID, fixture.firstUnitClosure],
        [SECOND_UNIT_ASSET_ID, SECOND_UNIT_VERSION_ID, fixture.secondUnitClosure],
    ] as const) {
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: `txn-${assetId}`,
            asset: makeAsset([versionId], {
                assetId,
                kind: "Memory",
                scope: "project",
                projectId: CATALOG_PROJECT_ID,
                scopePath: "",
            }),
            version: closure,
            dialectRegistry,
        });
    }
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "txn-memory-catalog",
        asset: makeAsset([CATALOG_VERSION_ID], {
            assetId: CATALOG_ASSET_ID,
            kind: "Memory",
            scope: "project",
            projectId: CATALOG_PROJECT_ID,
            scopePath: "",
        }),
        version: fixture.catalogClosure,
        dialectRegistry,
    });
    return { fixture, assetsRoot, dialectRegistry };
}

function stagingInvocation(published: ReturnType<typeof publishCatalogFixture>) {
    const input = makeMemoryCatalogInspectionInput(published.fixture);
    const result = published.fixture.support.inspect(input);
    const base = {
        deploymentId: published.fixture.deployment.deploymentId,
        consumerAgentRuntimeIds: published.fixture.deployment.consumerAgentRuntimeIds,
        platform: published.fixture.deployment.platform,
        platformInstanceId: published.fixture.deployment.platformInstanceId,
        targetRootPath: published.fixture.deployment.targetRootPath,
        projectId: published.fixture.deployment.projectId,
        projectRootPath: published.fixture.deployment.targetRootPath,
        assets: structuredClone(published.fixture.deployment.assets),
        dialectInputs: structuredClone(published.fixture.analysisInput.dialectInputs),
        appliedInputsSnapshot: {
            schemaVersion: 1 as const,
            deploymentId: published.fixture.deployment.deploymentId,
            consumerAgentRuntimeIds: published.fixture.deployment.consumerAgentRuntimeIds,
            assets: published.fixture.deployment.assets.map((asset) => ({
                assetId: asset.version.ref.assetId,
                versionId: asset.version.ref.versionId,
                allowIncomplete: false,
            })),
        },
    };
    const inspected = {
        input,
        result,
        appliedRenderSnapshot: input.appliedRenderSnapshot,
        operation: {
            deployment: structuredClone(published.fixture.deployment),
            registry: published.fixture.registry,
            dialectInputs: structuredClone(published.fixture.analysisInput.dialectInputs),
            diagnostics: [],
        },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[1];
    const configuration = {
        render: { assetsRoot: published.assetsRoot, dialectRegistry: published.dialectRegistry },
    } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];
    return { configuration, inspected, base };
}

function publishCatalogChild(published: ReturnType<typeof publishCatalogFixture>): void {
    const fixture = published.fixture;
    const child = makeVersionClosure({
        assetId: CATALOG_ASSET_ID,
        versionId: CHILD_VERSION_ID,
        revision: 2,
        sourceVersionId: CATALOG_VERSION_ID,
        changeKind: "edit",
        canonical: changedCatalogCanonical(),
        files: [],
        createdAt: fixture.catalogClosure.manifest.createdAt + 1,
    });
    publishAssetVersion({
        assetsRoot: published.assetsRoot,
        transactionId: "txn-memory-catalog-child",
        version: child,
        dialectRegistry: published.dialectRegistry,
    });
    fixture.catalogClosure = child;
    fixture.catalogAsset.version.ref.versionId = CHILD_VERSION_ID;
    fixture.catalogAsset.version.versionFingerprint = child.manifest.fingerprint;
    fixture.catalogAsset.version.versionCanonicalContentFingerprint = child.manifest.versionCanonicalContentFingerprint;
    fixture.catalogAsset.version.canonical = changedCatalogCanonical();
    fixture.catalogDialectInput.targetVersion.versionId = CHILD_VERSION_ID;
    const native = fixture.catalogDialectInput.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
    Object.assign(native, {
        inputRole: "parent_rebase_seed",
        sourceVersion: { assetId: CATALOG_ASSET_ID, versionId: CATALOG_VERSION_ID },
    });
    const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
    fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
    fixture.allSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    fixture.catalogSemantics = fixture.allSemantics.filter(
        (semantic) => semantic.subject.assetId === CATALOG_ASSET_ID && semantic.subject.versionId === CHILD_VERSION_ID,
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
}
