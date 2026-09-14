/** Core-owned shared-target receipts remain bounded, exact and Provider-private. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RenderDeploymentInput, RenderTargetFileSnapshotV1 } from "../../src/contracts/render";
import type { ProbeResult } from "../../src/types";
import { computeRenderInputFingerprint } from "../../src/foundation/fingerprint";
import { prepareRenderOperation } from "../../src/orchestration/deployment-render-service";
import { captureMemoryCatalogTargetFileSnapshots } from "../../src/orchestration/deployment-render-target-snapshot";
import { projectProviderTargetFileSnapshots } from "../../src/render/render-dialect-authority";
import { validateRenderDeploymentInput } from "../../src/render/render-semantics";
import {
    CATALOG_TEXT,
    MEMORY_CATALOG_PATH,
    makeMemoryCatalogExactFileFixture,
} from "./fixtures/native-project-memory-catalog-test-fixtures";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("render target file snapshots", () => {
    it("binds a present Catalog receipt into the fresh operation prepared from durable authority", async () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const targetRoot = ownedRoot();
        fs.writeFileSync(path.join(targetRoot, MEMORY_CATALOG_PATH), CATALOG_TEXT, "utf8");
        const probeResult: ProbeResult = {
            status: "complete",
            observation: {
                adapterId: fixture.provider.adapterId,
                platformContext: {
                    platform: fixture.deployment.platform,
                    platformInstanceId: fixture.deployment.platformInstanceId,
                    accessRootPath: targetRoot,
                },
                observedAgentRuntimes: [],
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            diagnostics: [],
        };
        const operation = await prepareRenderOperation(
            {
                deploymentId: fixture.deployment.deploymentId,
                consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
                platform: fixture.deployment.platform,
                platformInstanceId: fixture.deployment.platformInstanceId,
                targetRootPath: targetRoot,
                projectId: fixture.deployment.projectId,
                projectRootPath: targetRoot,
                assets: fixture.deployment.assets,
                dialectInputs: fixture.analysisInput.dialectInputs,
                appliedInputsSnapshot: {
                    schemaVersion: 1,
                    deploymentId: fixture.deployment.deploymentId,
                    consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
                    assets: fixture.deployment.assets.map((asset) => ({
                        assetId: asset.version.ref.assetId,
                        versionId: asset.version.ref.versionId,
                        allowIncomplete: false,
                    })),
                },
            },
            {
                platformContexts: [
                    {
                        platform: fixture.deployment.platform,
                        platformInstanceId: fixture.deployment.platformInstanceId,
                        accessRootPath: targetRoot,
                    },
                ],
            } as never,
            {
                buildRenderRegistry: () => fixture.registry,
                probeAdapters: async () => ({
                    status: "complete",
                    value: [probeResult],
                    diagnostics: [],
                }),
                resolveObservedTargetContext: () => ({
                    status: "complete",
                    targetContext: fixture.deployment.targetContexts[0],
                    diagnostics: [],
                }),
            } as never,
        );
        expect(operation.deployment.targetFileSnapshots).toEqual(fixture.deployment.targetFileSnapshots);
    });

    it("captures one present or missing shared Catalog target without following an invalid file", () => {
        const present = makeMemoryCatalogExactFileFixture();
        const presentRoot = ownedRoot();
        fs.writeFileSync(path.join(presentRoot, MEMORY_CATALOG_PATH), CATALOG_TEXT, "utf8");
        present.analysisInput.dialectInputs[0]!.inputs.push({ inputKind: "dialect_restoration" } as never);
        expect(
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: presentRoot,
                assets: present.deployment.assets,
                dialectInputs: present.analysisInput.dialectInputs,
            }),
        ).toEqual(present.deployment.targetFileSnapshots);

        const missing = makeMemoryCatalogExactFileFixture();
        expect(
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: ownedRoot(),
                assets: missing.deployment.assets,
                dialectInputs: missing.analysisInput.dialectInputs,
            }),
        ).toEqual([{ relativePath: MEMORY_CATALOG_PATH, snapshotState: "missing" }]);

        const none = makeMemoryCatalogExactFileFixture();
        expect(
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: ownedRoot(),
                assets: none.deployment.assets.filter((asset) => asset.version.canonical.typeData.entityRole !== "catalog"),
                dialectInputs: none.analysisInput.dialectInputs,
            }),
        ).toEqual([]);

        const directory = ownedRoot();
        fs.mkdirSync(path.join(directory, MEMORY_CATALOG_PATH));
        expect(() =>
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: directory,
                assets: present.deployment.assets,
                dialectInputs: present.analysisInput.dialectInputs,
            }),
        ).toThrow(/snapshot failed/);
    });

    it("rejects an unsafe, empty or over-bounded native path projection", () => {
        const unsafe = makeMemoryCatalogExactFileFixture();
        const unsafeNative = unsafe.analysisInput.dialectInputs[0]?.inputs[0];
        if (unsafeNative?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
        unsafeNative.files[0]!.relativePath = "../MEMORY.md";
        expect(() =>
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: ownedRoot(),
                assets: unsafe.deployment.assets,
                dialectInputs: unsafe.analysisInput.dialectInputs,
            }),
        ).toThrow(/not canonical/);

        const empty = makeMemoryCatalogExactFileFixture();
        empty.analysisInput.dialectInputs[0]!.inputs = [];
        expect(() =>
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: ownedRoot(),
                assets: empty.deployment.assets,
                dialectInputs: empty.analysisInput.dialectInputs,
            }),
        ).toThrow(/bounded non-empty/);

        const excessive = makeMemoryCatalogExactFileFixture();
        const excessiveNative = excessive.analysisInput.dialectInputs[0]?.inputs[0];
        if (excessiveNative?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
        excessiveNative.files = Array.from({ length: 17 }, (_, index) => ({
            ...structuredClone(excessiveNative.files[0]!),
            relativePath: `catalog-${index}.md`,
        }));
        expect(() =>
            captureMemoryCatalogTargetFileSnapshots({
                targetRootPath: ownedRoot(),
                assets: excessive.deployment.assets,
                dialectInputs: excessive.analysisInput.dialectInputs,
            }),
        ).toThrow(/bounded non-empty/);
    });

    it("validates every receipt shape without treating a live receipt as durable Deployment intent", () => {
        const valid = makeMemoryCatalogExactFileFixture();
        expect(() => validateRenderDeploymentInput(valid.deployment, valid.registry)).not.toThrow();
        const stableIntentFingerprint = valid.deployment.renderInputFingerprint;

        const missing = makeMemoryCatalogExactFileFixture();
        missing.deployment.targetFileSnapshots = [{ relativePath: MEMORY_CATALOG_PATH, snapshotState: "missing" }];
        refreshFingerprint(missing.deployment);
        expect(() => validateRenderDeploymentInput(missing.deployment, missing.registry)).not.toThrow();
        expect(missing.deployment.renderInputFingerprint).toBe(stableIntentFingerprint);

        const invalidCases: Array<(input: RenderDeploymentInput) => void> = [
            (input) => {
                input.targetFileSnapshots = [];
            },
            (input) => {
                input.targetFileSnapshots = Array.from({ length: 17 }, (_, index) => ({
                    relativePath: `snapshot-${String(index).padStart(2, "0")}.md`,
                    snapshotState: "missing" as const,
                }));
            },
            (input) => {
                input.assets = input.assets.filter((asset) => asset.version.canonical.typeData.entityRole !== "catalog");
            },
            (input) => {
                input.targetFileSnapshots = [{ relativePath: "../MEMORY.md", snapshotState: "missing" }];
            },
            (input) => {
                input.targetFileSnapshots = [
                    { relativePath: MEMORY_CATALOG_PATH, snapshotState: "missing", extra: true } as never,
                ];
            },
            (input) => {
                input.targetFileSnapshots = [{ relativePath: MEMORY_CATALOG_PATH, snapshotState: "unknown" } as never];
            },
            (input) => {
                input.targetFileSnapshots = [{ ...presentSnapshot(), extra: true } as never];
            },
            (input) => {
                input.targetFileSnapshots = [{ ...presentSnapshot(), contentHash: "bad" as never }];
            },
            (input) => {
                input.targetFileSnapshots = [{ ...presentSnapshot(), byteSize: Number.MAX_SAFE_INTEGER + 1 }];
            },
            (input) => {
                input.targetFileSnapshots = [{ ...presentSnapshot(), byteSize: -1 }];
            },
            (input) => {
                input.targetFileSnapshots = [{ ...presentSnapshot(), executable: "no" as never }];
            },
        ];
        for (const mutate of invalidCases) {
            const fixture = makeMemoryCatalogExactFileFixture();
            mutate(fixture.deployment);
            refreshFingerprint(fixture.deployment);
            expect(() => validateRenderDeploymentInput(fixture.deployment, fixture.registry)).toThrow();
        }
    });

    it("projects only receipts owned by the Provider dialect inputs", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        expect(
            projectProviderTargetFileSnapshots({
                targetFileSnapshots: fixture.deployment.targetFileSnapshots,
                dialectInputs: fixture.analysisInput.dialectInputs,
            }),
        ).toEqual(fixture.deployment.targetFileSnapshots);
        expect(
            projectProviderTargetFileSnapshots({
                targetFileSnapshots: fixture.deployment.targetFileSnapshots,
                dialectInputs: [],
            }),
        ).toBeUndefined();
        expect(
            projectProviderTargetFileSnapshots({
                targetFileSnapshots: undefined,
                dialectInputs: fixture.analysisInput.dialectInputs,
            }),
        ).toBeUndefined();
        expect(
            projectProviderTargetFileSnapshots({
                targetFileSnapshots: fixture.deployment.targetFileSnapshots,
                dialectInputs: [
                    {
                        targetVersion: fixture.catalogDialectInput.targetVersion,
                        consumerAgentRuntimeIds: [...fixture.catalogDialectInput.consumerAgentRuntimeIds],
                        inputs: [
                            {
                                inputKind: "dialect_restoration",
                                restoration: {
                                    dialectId: "fixture-restoration-v1",
                                    restorationContractFingerprint: presentSnapshot().contentHash,
                                    contentHash: presentSnapshot().contentHash,
                                },
                                content: { contentKind: "binary", bytes: Uint8Array.of(1) },
                            },
                        ],
                    },
                ],
            }),
        ).toBeUndefined();
    });
});

function ownedRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-target-snapshot-"));
    roots.push(root);
    return root;
}

function presentSnapshot(): Extract<RenderTargetFileSnapshotV1, { snapshotState: "present" }> {
    const fixture = makeMemoryCatalogExactFileFixture();
    const snapshot = fixture.deployment.targetFileSnapshots?.[0];
    if (snapshot?.snapshotState !== "present") throw new Error("present Catalog snapshot missing");
    return snapshot;
}

function refreshFingerprint(input: RenderDeploymentInput): void {
    const { renderInputFingerprint: _stored, ...preimage } = input;
    input.renderInputFingerprint = computeRenderInputFingerprint(preimage);
}
