import type { Database } from "better-sqlite3";
import type {
    AppliedRenderSnapshotV1,
    DeploymentFileBaselineStateV1,
    RenderOutputUnit,
} from "../../../src/contracts/deployment-authority";
import type { Sha256Digest, UuidV4 } from "../../../src/contracts/primitives";
import {
    finalizeTargetFileRenderProvenance,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
} from "../../../src/render/deployment-render-authority";
import type { DeploymentExecutionAuthorityV1 } from "../../../src/deployment/deployment-executor";
import { computeAppliedRenderSnapshotFingerprint, computeRenderOutputUnitFingerprint } from "../../../src/foundation/fingerprint";
import type { TargetFilePlan, TargetPlan } from "../../../src/deployment/deployment-target-plan";
import { insertDeploymentRenderSnapshot, updateDeployment, upsertDeploymentFile } from "../../../src/persistence/state-db";
import { publishDeploymentPayloads } from "../../../src/deployment/deployment-payload-store";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";

const SHA_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const SHA_B = `sha256:${"b".repeat(64)}` as Sha256Digest;

function testOutputUnit(target: Pick<TargetFilePlan, "relativePath" | "content" | "executable">): RenderOutputUnit {
    const preimage = {
        outputContractId: "p6-test-compiled-target-v1",
        outputContractFingerprint: SHA_A,
        claims: [{ relativePath: target.relativePath, contentKind: target.content.contentKind, executable: target.executable }],
        managedDirectoryBoundaries: [],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}

/** Current complete TargetPlan shape for the synthetic executor/recovery fixtures. */
export function makeTestTargetPlan(files: Array<Pick<TargetFilePlan, "relativePath" | "content" | "executable">>): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: [],
        targetFiles: files.map((target) => ({
            ...target,
            outputUnitFingerprint: testOutputUnit(target).outputUnitFingerprint,
            materializationFingerprint: shaBytes(
                target.content.contentKind === "text" ? Buffer.from(target.content.text, "utf8") : target.content.bytes,
            ),
            semanticRefFingerprints: [],
            sectionBindings: [],
        })),
    };
}

export function shaBytes(bytes: Uint8Array): Sha256Digest {
    return sha256Bytes(bytes);
}

export function targetBytes(plan: TargetPlan, relativePath: string): Uint8Array {
    const target = plan.targetFiles.find((file) => file.relativePath === relativePath);
    if (target === undefined) throw new Error(`target plan has no ${relativePath}`);
    return target.content.contentKind === "text"
        ? new Uint8Array(Buffer.from(target.content.text, "utf-8"))
        : target.content.bytes;
}

/**
 * Produce the smallest strict render authority that truthfully covers every
 * file in a legacy TargetPlan. It intentionally claims no semantic refs: P6
 * consumes an already-compiled plan, while Phase 18 replaces this bridge with
 * the public analyze/materialize contract.
 */
export function makeExecutionAuthority(
    plan: TargetPlan,
    inputs: Partial<DeploymentExecutionAuthorityV1["appliedInputsSnapshot"]> = {},
): DeploymentExecutionAuthorityV1 {
    const unitsByPath = new Map<string, RenderOutputUnit>();
    for (const target of plan.targetFiles) {
        unitsByPath.set(target.relativePath, testOutputUnit(target));
    }
    const outputUnits = [...unitsByPath.values()].sort((left, right) =>
        left.outputUnitFingerprint.localeCompare(right.outputUnitFingerprint),
    );
    const snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }> = {
        schemaVersion: 1,
        snapshotState: "applied",
        renderInputFingerprint: SHA_A,
        compilerPolicyVersion: "core_render_policy_v1",
        selectionFingerprint: SHA_B,
        compilationFingerprint: shaBytes(Buffer.from(JSON.stringify(plan))),
        promotionAuthorizations: [],
        decisions: [],
        outputUnits,
        outputUnitRenderers: outputUnits.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: "claudecode",
            rendererAdapterVersion: "p6-test",
            materializerCapabilityKey: "test.compiled-target",
            materializationProfileId: "test",
            profileConstraintFingerprint: SHA_A,
        })),
        semanticCoverageProofs: outputUnits.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            coveredSemanticRefFingerprints: [],
            coverageFingerprint: SHA_B,
        })),
    };
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(snapshot);
    for (const target of plan.targetFiles) {
        const unit = unitsByPath.get(target.relativePath) as RenderOutputUnit;
        const legacy = target as typeof target & { renderedSectionIds?: string[] };
        const materializationFingerprint = target.materializationFingerprint ?? shaBytes(targetBytes(plan, target.relativePath));
        const semanticRefFingerprints = target.semanticRefFingerprints ?? [];
        const sectionBindings =
            target.sectionBindings ??
            (legacy.renderedSectionIds ?? []).map((sectionHandle) => ({
                sectionHandle,
                semanticRefFingerprints: [],
            }));
        Object.assign(target, {
            outputUnitFingerprint: target.outputUnitFingerprint ?? unit.outputUnitFingerprint,
            materializationFingerprint,
            semanticRefFingerprints,
            sectionBindings,
        });
        delete legacy.renderedSectionIds;
    }
    return {
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: inputs.deploymentId ?? "00000000-0000-4000-8000-000000000001",
            consumerAgentRuntimeIds: inputs.consumerAgentRuntimeIds ?? ["CLAUDE_CODE_CLI"],
            assets: inputs.assets ?? [
                {
                    assetId: "00000000-0000-4000-8000-000000000010",
                    versionId: "00000000-0000-4000-8000-000000000020",
                    allowIncomplete: false,
                },
            ],
        },
        appliedRenderSnapshot: snapshot,
        targetFileProvenance: plan.targetFiles
            .map((target) => {
                const unit = unitsByPath.get(target.relativePath);
                if (unit === undefined) throw new Error("missing test output unit");
                return {
                    relativePath: target.relativePath,
                    provenance: finalizeTargetFileRenderProvenance({
                        schemaVersion: 1,
                        appliedRenderSnapshotFingerprint: snapshotFingerprint,
                        outputUnitFingerprint: target.outputUnitFingerprint,
                        materializationFingerprint: target.materializationFingerprint,
                        semanticRefFingerprints: [...target.semanticRefFingerprints],
                        sectionBindings: structuredClone(target.sectionBindings),
                    }),
                };
            })
            .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    };
}

export interface SeedActiveBaselineInput {
    db: Database;
    deploymentsRoot: string;
    deploymentId: UuidV4;
    transactionId: UuidV4;
    plan: TargetPlan;
    relativePath: string;
    now?: number;
}

/** Seed a real snapshot + payload + active DeploymentFile authority. */
export function seedActiveBaseline(input: SeedActiveBaselineInput): void {
    const now = input.now ?? 4_000;
    const authority = makeExecutionAuthority(input.plan);
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(authority.appliedRenderSnapshot);
    const snapshotJson = serializeAppliedRenderSnapshot(authority.appliedRenderSnapshot);
    insertDeploymentRenderSnapshot(input.db, {
        snapshotFingerprint,
        deploymentId: input.deploymentId,
        snapshotJson,
        deleted: 0,
        createdAt: now,
        updatedAt: now,
    });
    updateDeployment(
        input.db,
        input.deploymentId,
        {
            appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                snapshotState: "applied",
                snapshotFingerprint,
            }),
        },
        now,
    );
    const bytes = targetBytes(input.plan, input.relativePath);
    const target = input.plan.targetFiles.find((file) => file.relativePath === input.relativePath);
    const provenance = authority.targetFileProvenance.find((file) => file.relativePath === input.relativePath)?.provenance;
    if (target === undefined || provenance === undefined) throw new Error("invalid baseline fixture");
    const contentHash = shaBytes(bytes);
    publishDeploymentPayloads({
        deploymentsRoot: input.deploymentsRoot,
        deploymentId: input.deploymentId,
        transactionId: input.transactionId,
        payloads: [{ contentKind: target.content.contentKind, contentHash, bytes }],
    });
    const baseline: DeploymentFileBaselineStateV1 = {
        rowState: "active",
        appliedPayload: { contentKind: target.content.contentKind, contentHash, byteSize: bytes.length },
        appliedExecutable: target.executable,
        provenance,
    };
    upsertDeploymentFile(
        input.db,
        input.deploymentId,
        input.relativePath,
        serializeDeploymentFileBaselineState(baseline),
        "present",
        contentHash,
        target.executable ? 1 : 0,
        now,
        now,
    );
}
