/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import { resolveCoreRenderSelectionWithAuthorityLeases } from "../../src/render/render-selection";
import { computeRenderInputFingerprint } from "../../src/foundation/fingerprint";
import { tryAcquireAuthorityLockLease, tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import { type makeOutputUnit, makeRenderRegistry } from "./fixtures/render-contract-fixtures";
import {
    selectionFixture,
    selectionResult,
    refreshAnalysis,
    makeTwoUnitAnalysis,
} from "./fixtures/render-selection-test-fixtures";

describe("selection physical and authority safety", () => {
    it("fails closed when the Asset authority is absent or stale", async () => {
        const absent = await selectionFixture({ publishAsset: false });
        expect(selectionResult(absent).diagnostics[0]?.code).toBe("render.promotion_asset_stale");

        const stale = await selectionFixture();
        stale.deployment.assets[0]!.version.versionFingerprint = `sha256:${"9".repeat(64)}`;
        const { renderInputFingerprint: _stored, ...preimage } = stale.deployment;
        stale.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
        await refreshAnalysis(stale);
        expect(selectionResult(stale).diagnostics[0]?.code).toBe("render.promotion_version_stale");
    });

    it("blocks when a selected output has no exact materializer conformance", async () => {
        const fixture = await selectionFixture();
        const noPredicateRegistry = makeRenderRegistry({
            providers: [fixture.provider],
            contract: fixture.contract,
            predicateResult: false,
        });
        fixture.configuration.registry = noPredicateRegistry;
        fixture.deployment.renderRegistryFingerprint = noPredicateRegistry.fingerprint;
        const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
        const { computeRenderInputFingerprint } = await import("../../src/foundation/fingerprint");
        fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
        fixture.analysis.renderInputFingerprint = fixture.deployment.renderInputFingerprint;
        fixture.request.renderInputFingerprint = fixture.deployment.renderInputFingerprint;
        expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.materializer_missing");
    });

    it("releases Asset locks and reports busy Asset/settings authorities", async () => {
        const assetBusy = await selectionFixture();
        const releaseAsset = tryAcquireAuthorityLocks(assetBusy.configuration.authorityLocksRoot, "assets", [
            assetBusy.deployment.assets[0]!.version.ref.assetId,
        ]);
        expect(selectionResult(assetBusy).diagnostics[0]?.code).toBe("render.asset_locked");
        releaseAsset?.();
        expect(selectionResult(assetBusy).status).toBe("complete");

        const settingsBusy = await selectionFixture();
        const releaseSettings = tryAcquireAuthorityLocks(settingsBusy.configuration.authorityLocksRoot, "settings", ["settings"]);
        expect(selectionResult(settingsBusy).diagnostics[0]?.code).toBe("render.settings_locked");
        releaseSettings?.();
        expect(selectionResult(settingsBusy).status).toBe("complete");
    });

    it("consumes exact caller-held Asset/settings leases without re-acquiring them", async () => {
        const fixture = await selectionFixture();
        const assetIds = fixture.deployment.assets.map((asset) => asset.version.ref.assetId);
        const assetLease = tryAcquireAuthorityLockLease(fixture.configuration.authorityLocksRoot, "assets", assetIds);
        const settingsLease = tryAcquireAuthorityLockLease(fixture.configuration.authorityLocksRoot, "settings", ["settings"]);
        if (assetLease === null || settingsLease === null) {
            throw new Error("authority lease fixture is busy");
        }
        try {
            expect(selectionResult(fixture).diagnostics[0]?.code).toBe("render.asset_locked");
            expect(
                resolveCoreRenderSelectionWithAuthorityLeases(
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
                ).status,
            ).toBe("complete");
            expect(
                resolveCoreRenderSelectionWithAuthorityLeases(
                    {
                        deployment: fixture.deployment,
                        analysis: fixture.analysis,
                        request: fixture.request,
                    },
                    fixture.configuration,
                    {
                        assetAuthorityLeaseProof: assetLease.proof,
                        settingsAuthorityLeaseProof: assetLease.proof,
                    },
                ).status,
            ).toBe("failed");
        } finally {
            settingsLease.release();
            assetLease.release();
        }
        expect(
            resolveCoreRenderSelectionWithAuthorityLeases(
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
            ).status,
        ).toBe("failed");
    });

    it("rejects selecting two options for one semantic and a changed owner version", async () => {
        const duplicate = await selectionFixture();
        const analysis = structuredClone(duplicate.analysis);
        const second = structuredClone(analysis.analyses[0]!.semanticOptions[0]!);
        second.optionFingerprint = `sha256:${"8".repeat(64)}`;
        analysis.analyses[0]!.semanticOptions.push(second);
        duplicate.analysis = analysis;
        duplicate.request.semanticOptions[1] = {
            optionFingerprint: second.optionFingerprint,
            approvalRequest: { approvalAction: "none" },
        };
        expect(selectionResult(duplicate).diagnostics[0]?.code).toBe("render.selection_semantic_duplicate");

        const owner = await selectionFixture();
        owner.configuration.registry = {
            ...owner.registry,
            getOwner: (agentRuntimeId: string) => {
                const current = owner.registry.getOwner(agentRuntimeId);
                return current === null ? null : { ...current, version: "changed-version" };
            },
        };
        expect(selectionResult(owner).diagnostics[0]?.code).toBe("render.selection_owner_mismatch");
    });

    it("rejects exact, ancestor, and managed-boundary conflicts across selected units", async () => {
        const cases: Array<{
            primary?: (unit: ReturnType<typeof makeOutputUnit>) => void;
            second: (unit: ReturnType<typeof makeOutputUnit>) => void;
            code: string;
        }> = [
            {
                second: (unit) => {
                    unit.claims[0]!.relativePath = "AGENTS.md";
                    unit.claims[0]!.executable = true;
                },
                code: "render.output_path_conflict",
            },
            {
                second: (unit) => {
                    unit.claims[0]!.relativePath = "AGENTS.md/child";
                },
                code: "render.output_path_conflict",
            },
            {
                second: (unit) => {
                    unit.claims[0]!.relativePath = "OTHER.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "AGENTS.md", boundaryKind: "directory_inventory" }];
                },
                code: "render.output_boundary_claim_conflict",
            },
        ];
        for (const testCase of cases) {
            const fixture = await selectionFixture({
                buildAnalysisResult: makeTwoUnitAnalysis(testCase.primary, testCase.second),
            });
            const result = selectionResult(fixture);
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe(testCase.code);
        }
    });

    it("rejects each direction of cross-unit boundary/claim and boundary/boundary overlap", async () => {
        const cases: Array<{
            primary: (unit: ReturnType<typeof makeOutputUnit>) => void;
            second: (unit: ReturnType<typeof makeOutputUnit>) => void;
            code: string;
        }> = [
            {
                primary: (unit) => {
                    unit.claims[0]!.relativePath = "tree/file.md";
                },
                second: (unit) => {
                    unit.claims[0]!.relativePath = "OTHER.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree", boundaryKind: "directory_inventory" }];
                },
                code: "render.output_boundary_claim_conflict",
            },
            {
                primary: (unit) => {
                    unit.claims[0]!.relativePath = "tree";
                },
                second: (unit) => {
                    unit.claims[0]!.relativePath = "OTHER.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree/child", boundaryKind: "directory_inventory" }];
                },
                code: "render.output_boundary_claim_conflict",
            },
            {
                primary: (unit) => {
                    unit.claims[0]!.relativePath = "FIRST.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree", boundaryKind: "directory_inventory" }];
                },
                second: (unit) => {
                    unit.claims[0]!.relativePath = "SECOND.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree", boundaryKind: "directory_inventory" }];
                },
                code: "render.output_boundary_conflict",
            },
            {
                primary: (unit) => {
                    unit.claims[0]!.relativePath = "FIRST.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree/child", boundaryKind: "directory_inventory" }];
                },
                second: (unit) => {
                    unit.claims[0]!.relativePath = "SECOND.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree", boundaryKind: "directory_inventory" }];
                },
                code: "render.output_boundary_conflict",
            },
            {
                primary: (unit) => {
                    unit.claims[0]!.relativePath = "FIRST.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree", boundaryKind: "directory_inventory" }];
                },
                second: (unit) => {
                    unit.claims[0]!.relativePath = "SECOND.md";
                    unit.managedDirectoryBoundaries = [{ relativePath: "tree/child", boundaryKind: "directory_inventory" }];
                },
                code: "render.output_boundary_conflict",
            },
        ];
        for (const testCase of cases) {
            const fixture = await selectionFixture({
                buildAnalysisResult: makeTwoUnitAnalysis(testCase.primary, testCase.second),
            });
            const result = selectionResult(fixture);
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe(testCase.code);
        }
    });
});
