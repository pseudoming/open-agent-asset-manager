/** Pure projection from one validated compiled target closure to success authority. */

import type { TargetPlan } from "./deployment-target-plan";
import type { DeploymentExecutionAuthorityV1 } from "./deployment-execution-validation";
import type { ActiveDeploymentBaseline } from "./deployment-state-ops";
import type { DeploymentSuccessCommitInputV1, DeploymentSuccessActiveFileV1 } from "./deployment-state-ops";
import type { VerifiedTarget } from "./deployment-target-verify";
import type { DeploymentPayloadInput } from "./deployment-payload-store";
import { finalizeDeploymentResidualAuthority, makeRemovalIntentFingerprint } from "../render/deployment-render-authority";
import { binaryPayloadStats, textPayloadStats } from "../catalog/payload-store";
import { compareUtf8Bytes } from "../foundation/text-order";

export interface ProjectDeploymentSuccessAuthorityInput {
    deploymentId: string;
    targetPlan: TargetPlan;
    executionAuthority: DeploymentExecutionAuthorityV1;
    baseline: ActiveDeploymentBaseline[];
    verifiedActiveTargets: VerifiedTarget[];
    transactionId: string;
    now: number;
}

export interface ProjectedDeploymentSuccessAuthority {
    successCommit: DeploymentSuccessCommitInputV1;
    activePayloads: DeploymentPayloadInput[];
}

/**
 * Project the exact same success authority for executor writes and no-write
 * reverse accept. The caller still owns physical verification and payload
 * durability; this function owns only closure equality and canonical records.
 */
export function projectDeploymentSuccessAuthority(
    input: ProjectDeploymentSuccessAuthorityInput,
): ProjectedDeploymentSuccessAuthority {
    const targets = new Map(input.targetPlan.targetFiles.map((file) => [file.relativePath, file] as const));
    const verified = new Map(input.verifiedActiveTargets.map((file) => [file.relativePath, file] as const));
    const provenance = new Map(
        input.executionAuthority.targetFileProvenance.map((file) => [file.relativePath, file.provenance] as const),
    );
    requireExactPaths(targets.keys(), verified.keys(), "verified target closure");
    requireExactPaths(targets.keys(), provenance.keys(), "target provenance closure");

    const activePayloads: DeploymentPayloadInput[] = [];
    const verifiedActiveFiles: DeploymentSuccessActiveFileV1[] = [];
    for (const target of [...targets.values()].sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath))) {
        const bytes =
            target.content.contentKind === "text"
                ? new Uint8Array(Buffer.from(target.content.text, "utf8"))
                : new Uint8Array(target.content.bytes);
        const stats = target.content.contentKind === "text" ? textPayloadStats(target.content.text) : binaryPayloadStats(bytes);
        const observation = verified.get(target.relativePath) as VerifiedTarget;
        if (
            observation.observedState !== "present" ||
            observation.appliedContentHash !== stats.contentHash ||
            observation.observedContentHash !== stats.contentHash ||
            observation.appliedExecutable !== target.executable ||
            observation.observedExecutable !== target.executable
        ) {
            throw new Error(`verified target does not match compiled bytes: ${target.relativePath}`);
        }
        activePayloads.push({
            contentKind: target.content.contentKind,
            contentHash: stats.contentHash,
            bytes,
        });
        // Exact Map-key closure was proved above, so this lookup is total.
        const targetProvenance = provenance.get(target.relativePath) as NonNullable<ReturnType<typeof provenance.get>>;
        verifiedActiveFiles.push({
            verified: structuredClone(observation),
            appliedPayload: {
                contentKind: target.content.contentKind,
                contentHash: stats.contentHash,
                byteSize: bytes.byteLength,
            },
            provenance: structuredClone(targetProvenance),
        });
    }

    const newlyRemoved = input.baseline
        .filter((row) => !targets.has(row.relativePath))
        .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath))
        .map((row) =>
            finalizeDeploymentResidualAuthority({
                schemaVersion: 1,
                deploymentId: input.deploymentId,
                relativePath: row.relativePath,
                appliedPayload: row.baselineState.appliedPayload,
                appliedExecutable: row.baselineState.appliedExecutable,
                previousProvenance: row.baselineState.provenance,
                removalIntentFingerprint: makeRemovalIntentFingerprint({
                    deploymentId: input.deploymentId,
                    relativePath: row.relativePath,
                    previousProvenanceFingerprint: row.baselineState.provenance.provenanceFingerprint,
                    nextCompilationFingerprint: input.executionAuthority.appliedRenderSnapshot.compilationFingerprint,
                    reason: "absent_from_new_desired_set",
                }),
            }),
        );

    return {
        activePayloads,
        successCommit: {
            deploymentId: input.deploymentId,
            verifiedActiveFiles,
            newlyRemoved,
            transactionId: input.transactionId,
            appliedInputsSnapshot: structuredClone(input.executionAuthority.appliedInputsSnapshot),
            appliedRenderSnapshot: structuredClone(input.executionAuthority.appliedRenderSnapshot),
            now: input.now,
        },
    };
}

function requireExactPaths(expectedValues: Iterable<string>, actualValues: Iterable<string>, label: string): void {
    const expected = [...expectedValues].sort(compareUtf8Bytes);
    const actual = [...actualValues].sort(compareUtf8Bytes);
    // Callers pass Map key iterators; duplicate physical paths were already
    // canonicalized by construction, so only exact set equality remains here.
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error(`${label} is not exact`);
    }
}
