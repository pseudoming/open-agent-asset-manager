/**
 * Type contract invariants for the Phase 18 public-contract cutover.
 *
 * Asserts the decisions codified in implement_steps_plan.md §0.4 (cross-doc shape矛盾裁决)
 * and the stable enums from CORE_API/ASSET_SPECS/CORE_DATA_MODEL_DRAFT. These are
 * Runtime sanity assertions for the compile-time guards that live in
 * `src/type-guards.ts`. Core's production tsconfig excludes tests, so this file
 * must not use suppression comments as if Vitest were a TypeScript compile gate.
 */

import { describe, it, expect } from "vitest";
import type * as Core from "../../src/types";
import { makeVersionClosure } from "../catalog/fixtures/version-v2";

// ============================================================
// 0. Type-level exact-union guards (imported from src/type-guards.ts)
//
// These run in the core compile graph (npm run typecheck covers src/**/* via
// tsconfig; tests/ is excluded from that compile, so the assertions MUST live
// in src to actually fire on drift). The runtime `true` values are re-checked
// here as a second layer.
//
// If a future edit silently adds/removes a union member (needs_recovery leaks
// into DeploymentStage, 7th AssetKind, etc.), `npm run typecheck` fails on the
// IsExact<...> = true assignment in src/type-guards.ts.
// ============================================================

import {
    _exactAssetKind,
    _exactAssetKindTypeDataV2Kinds,
    _exactDurableMutationState,
    _assetVersionBundleUsesV2,
    _versionFileInputUsesV2References,
    _createAssetDiscriminatesGuidanceTypeData,
    _laterVersionChangeKindExcludesCreate,
    _exactAppliedAssetInputSnapshotKeys,
    _exactGuidanceTypeDataPairV2,
    _exactMemoryTypeDataPairV2,
    _exactRuleTypeDataPairV2,
    _exactSafeFilesystemFailureKind,
    _exactSkillTypeDataPairV2,
    _exactSubagentTypeDataPairV2,
    _exactWorkflowTypeDataPairV2,
    _exactDeploymentStage,
    _exactObservationState,
    _exactOperationStatus,
    _exactAgentRuntimeEntryClass,
    _exactObservedFileState,
    _exactAgentRuntimeDescriptorKeys,
    _exactAdapterProviderKeys,
    _exactAdapterProviderSummaryKeys,
    _exactOperationDiagnosticOperations,
    _coreServiceExtendsAllGroups,
    _exactReverseAcceptPreparationMarkerV1States,
    _exactPrepareRenderedTargetAcceptInputKeys,
    _exactCommitRenderedTargetAcceptInputKeys,
    _exactCancelRenderedTargetAcceptInputKeys,
    _exactCoreServiceConfigurationKeys,
    _exactDeploymentApiKeys,
} from "../../src/type-guards";

describe("type-level exact-union guards (src/type-guards.ts)", () => {
    it("AssetKind / DeploymentStage / ObservationState / OperationStatus are exactly approved", () => {
        // Compile-time: each const is typed `true` via IsExact<...>; if the union
        // drifts, the import above fails to compile. Runtime: re-assert the value.
        expect(_exactAssetKind).toBe(true);
        expect(_exactDeploymentStage).toBe(true);
        expect(_exactObservationState).toBe(true);
        expect(_exactOperationStatus).toBe(true);
        expect(_exactAgentRuntimeEntryClass).toBe(true);
        expect(_exactObservedFileState).toBe(true);
        expect(_exactAgentRuntimeDescriptorKeys).toBe(true);
        expect(_exactAdapterProviderKeys).toBe(true);
        expect(_exactAdapterProviderSummaryKeys).toBe(true);
        expect(_exactOperationDiagnosticOperations).toBe(true);
        expect(_exactReverseAcceptPreparationMarkerV1States).toBe(true);
        expect(_exactPrepareRenderedTargetAcceptInputKeys).toBe(true);
        expect(_exactCommitRenderedTargetAcceptInputKeys).toBe(true);
        expect(_exactCancelRenderedTargetAcceptInputKeys).toBe(true);
        expect(_exactCoreServiceConfigurationKeys).toBe(true);
        expect(_exactDeploymentApiKeys).toBe(true);
    });

    it("V2 kind/typeData pairs and authority filesystem unions are exact", () => {
        expect(_exactAssetKindTypeDataV2Kinds).toBe(true);
        expect(_exactGuidanceTypeDataPairV2).toBe(true);
        expect(_exactRuleTypeDataPairV2).toBe(true);
        expect(_exactWorkflowTypeDataPairV2).toBe(true);
        expect(_exactSkillTypeDataPairV2).toBe(true);
        expect(_exactSubagentTypeDataPairV2).toBe(true);
        expect(_exactMemoryTypeDataPairV2).toBe(true);
        expect(_exactSafeFilesystemFailureKind).toBe(true);
        expect(_exactDurableMutationState).toBe(true);
        expect(_assetVersionBundleUsesV2).toBe(true);
        expect(_versionFileInputUsesV2References).toBe(true);
        expect(_createAssetDiscriminatesGuidanceTypeData).toBe(true);
        expect(_laterVersionChangeKindExcludesCreate).toBe(true);
    });
});

// ============================================================
// 1. AssetKind: exactly 6 values, AgentRule retired
// ============================================================

describe("AssetKind (6-class union, AgentRule retired)", () => {
    it("AssetKind accepts exactly the 6 approved literals", () => {
        const valid: Core.AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
        expect(valid).toHaveLength(6);
        expect(new Set(valid).size).toBe(6);
    });

    it("the approved AssetKind runtime set excludes retired AgentRule", () => {
        const approved: Core.AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
        expect(new Set<string>(approved).has("AgentRule")).toBe(false);
    });
});

// ============================================================
// 2. DeploymentStage: exactly 5 stable stages, needs_recovery excluded
// ============================================================

describe("DeploymentStage (5 stable stages, needs_recovery is internal)", () => {
    it("DeploymentStage accepts exactly the 5 approved stable literals", () => {
        const stable: Core.DeploymentStage[] = ["deleted", "blocked", "conflict", "needs_repair", "in_sync"];
        expect(stable).toHaveLength(5);
        expect(new Set(stable).size).toBe(5);
    });

    it("the approved DeploymentStage runtime set excludes internal/temp states", () => {
        // CORE_DATA_MODEL §8.10 + CORE_API §7.1 + implement_steps_plan.md Step 7 裁决:
        // needs_recovery is internal recovery gate, not a public stable stage.
        const approved = new Set<string>([
            "deleted",
            "blocked",
            "conflict",
            "needs_repair",
            "in_sync",
        ] satisfies Core.DeploymentStage[]);
        expect(approved.has("needs_recovery")).toBe(false);
        expect(approved.has("unknown")).toBe(false);
        expect(approved.has("pending_deploy")).toBe(false);
        expect(approved.has("not_initialized")).toBe(false);
    });
});

// ============================================================
// 3. ObservationState: exactly 5 values
// ============================================================

describe("ObservationState (5 values)", () => {
    it("ObservationState accepts exactly the 5 approved literals", () => {
        const states: Core.ObservationState[] = ["never", "in_progress", "complete", "partial", "failed"];
        expect(states).toHaveLength(5);
        expect(new Set(states).size).toBe(5);
    });
});

// ============================================================
// 4. OperationStatus: exactly 3 values
// ============================================================

describe("OperationStatus (3 values)", () => {
    it("OperationStatus accepts exactly complete|partial|failed", () => {
        const statuses: Core.OperationStatus[] = ["complete", "partial", "failed"];
        expect(statuses).toHaveLength(3);
    });
});

// ============================================================
// 5. AppliedInputsSnapshot: NO sortOrder (CORE_DATA_MODEL §8.10 裁决)
// ============================================================

describe("AppliedAssetInputSnapshot (no sortOrder — array order authoritative)", () => {
    it("AppliedAssetInputSnapshot has exactly assetId/versionId/allowIncomplete", () => {
        const snapshot: Core.AppliedAssetInputSnapshot = {
            assetId: "00000000-0000-4000-8000-000000000000",
            versionId: "00000000-0000-4000-8000-000000000001",
            allowIncomplete: false,
        };
        // Verify the three required fields exist.
        expect(snapshot.assetId).toBeTruthy();
        expect(snapshot.versionId).toBeTruthy();
        expect(snapshot.allowIncomplete).toBe(false);
        expect(_exactAppliedAssetInputSnapshotKeys).toBe(true);
    });

    it("AppliedInputsSnapshotV1 wraps consumerAgentRuntimeIds + ordered assets[]", () => {
        const snap: Core.AppliedInputsSnapshotV1 = {
            schemaVersion: 1,
            deploymentId: "00000000-0000-4000-8000-000000000003",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI", "CODEX_CLI"],
            assets: [
                {
                    assetId: "00000000-0000-4000-8000-000000000000",
                    versionId: "00000000-0000-4000-8000-000000000001",
                    allowIncomplete: false,
                },
            ],
        };
        expect(snap.schemaVersion).toBe(1);
        expect(snap.assets).toHaveLength(1);
        // Array order is authoritative — no sortOrder field on entries.
        expect("sortOrder" in snap.assets[0]).toBe(false);
    });
});

// ============================================================
// 6. Manifests: Asset pointer V1 + immutable Version authority V2
// ============================================================

describe("AssetManifestV1 / AssetVersionManifestV2 field completeness", () => {
    it("AssetManifestV1 uses `kind: AssetKind` (not old `type:`) and includes versionIds", () => {
        const manifest: Core.AssetManifestV1 = {
            schemaVersion: 1,
            assetId: "00000000-0000-4000-8000-000000000000",
            kind: "Skill",
            scope: "project",
            projectId: "00000000-0000-4000-8000-000000000002",
            scopePath: "packages/core",
            displayName: "my-skill",
            displayDescription: "",
            versionIds: ["00000000-0000-4000-8000-000000000001"],
            deleted: false,
            createdAt: 0,
            updatedAt: 0,
        };
        expect(manifest.kind).toBe("Skill");
        expect(manifest.versionIds).toHaveLength(1);
    });

    it("AssetVersionManifestV2 contains canonical, source, native, and restoration authority", () => {
        const version: Core.AssetVersionManifestV2 = makeVersionClosure().manifest;
        expect(version.kind).toBe("Guidance");
        expect(version.schemaVersion).toBe(2);
        expect(version.originAuthority.originKind).toBe("user_created");
        expect(version.nativeRepresentations).toEqual([]);
        expect(version.dialectRestorationPayloads).toEqual([]);
        expect(version.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("CreateAssetInput kind constrains initial typeData and later Version requires a parent", () => {
        const initial: Core.CreateAssetInput = {
            kind: "Guidance",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "guidance",
            initialVersion: {
                typeData: { schemaVersion: 1 },
                files: [],
                userActionEvidenceId: "user-action-create",
                changeKind: "create",
            },
        };
        const later: Core.CreateVersionInput<Core.GuidanceTypeDataV1> = {
            typeData: { schemaVersion: 1 },
            files: [],
            userActionEvidenceId: "user-action-edit",
            changeKind: "edit",
            sourceVersionId: "00000000-0000-4000-8000-000000000001",
        };
        expect(initial.initialVersion.changeKind).toBe("create");
        expect(later.sourceVersionId).toMatch(/0001$/);
    });
});

// ============================================================
// 7. global Asset: empty projectId/scopePath, NOT __global__
// ============================================================

describe("global Asset: empty projectId/scopePath (no __global__ virtual Project)", () => {
    it("AssetManifestV1 global uses empty strings, not a __global__ sentinel", () => {
        const globalAsset: Core.AssetManifestV1 = {
            schemaVersion: 1,
            assetId: "00000000-0000-4000-8000-000000000000",
            kind: "Guidance",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "global-guidance",
            displayDescription: "",
            versionIds: ["00000000-0000-4000-8000-000000000001"],
            deleted: false,
            createdAt: 0,
            updatedAt: 0,
        };
        expect(globalAsset.projectId).toBe("");
        expect(globalAsset.scopePath).toBe("");
        // __global__ sentinel must NOT be used (old model retired).
        expect(globalAsset.projectId).not.toBe("__global__");
    });
});

// ============================================================
// 8. CoreService aggregates all API groups
// ============================================================

describe("CoreService aggregate", () => {
    it("CoreService extends every public API group (compile guard in src/type-guards.ts)", () => {
        // The real compile-time check lives in src/type-guards.ts
        // (_coreServiceExtendsAllGroups) and is enforced by the core typecheck
        // (which covers all of src). This test re-asserts the runtime value
        // as a second layer, matching the pattern for _exactAssetKind etc.
        expect(_coreServiceExtendsAllGroups).toBe(true);
    });
});
