/** Compiled runtime-state verification and Deployment payload collection. */

import type { UuidV4 } from "../types";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";
import { stableStringify } from "../foundation/fingerprint";
import { binaryPayloadStats, textPayloadStats } from "../catalog/payload-store";
import type { ValidatedCompiledDeploymentPlanData } from "../render/render-compiler";
import { readDeploymentPayload, type DeploymentPayloadInput } from "../deployment/deployment-payload-store";
import type { VerifiedTarget } from "../deployment/deployment-target-verify";
import { lifecycleFailure, compareUtf8Bytes } from "./deployment-lifecycle-shared";

export function verifyCompiledPlanAlreadyPresent(
    compiled: ValidatedCompiledDeploymentPlanData,
    inspected: DeploymentInspectionAuthorityV1,
): VerifiedTarget[] {
    const expected = new Map(inspected.runtimeReplacementAuthority.files.map((file) => [file.relativePath, file]));
    const targetPaths = compiled.targetPlan.targetFiles.map((file) => file.relativePath).sort(compareUtf8Bytes);
    if (stableStringify([...expected.keys()].sort(compareUtf8Bytes)) !== stableStringify(targetPaths)) {
        throw lifecycleFailure(
            "reverse_accept.compiled_target_changed",
            "fresh compiled target closure differs from the inspected runtime closure",
            "conflict",
            true,
        );
    }
    return compiled.targetPlan.targetFiles.map((target): VerifiedTarget => {
        const current = expected.get(target.relativePath);
        const bytes =
            target.content.contentKind === "text"
                ? new Uint8Array(Buffer.from(target.content.text, "utf8"))
                : new Uint8Array(target.content.bytes);
        if (
            current === undefined ||
            current.expectedState !== "present" ||
            !Buffer.from(current.expectedBytes).equals(Buffer.from(bytes)) ||
            current.expectedExecutable !== target.executable
        ) {
            throw lifecycleFailure(
                "reverse_accept.runtime_not_materialized",
                `runtime path does not contain the freshly compiled bytes: ${target.relativePath}`,
                "conflict",
                true,
            );
        }
        const stats = target.content.contentKind === "text" ? textPayloadStats(target.content.text) : binaryPayloadStats(bytes);
        return {
            relativePath: target.relativePath,
            appliedContentHash: stats.contentHash,
            appliedExecutable: target.executable,
            observedState: "present",
            observedContentHash: stats.contentHash,
            observedExecutable: target.executable,
        };
    });
}

export function collectDeploymentPayloads(
    deploymentsRoot: string,
    deploymentId: UuidV4,
    active: DeploymentPayloadInput[],
    residuals: import("../contracts/deployment-authority").DeploymentResidualRenderAuthorityV1[],
): DeploymentPayloadInput[] {
    const payloads = new Map<string, DeploymentPayloadInput>();
    for (const payload of active) payloads.set(payload.contentHash, payload);
    for (const residual of residuals) {
        const ref = residual.appliedPayload;
        const bytes = readDeploymentPayload({
            deploymentsRoot,
            deploymentId,
            contentHash: ref.contentHash,
            expectedByteSize: ref.byteSize,
        });
        const existing = payloads.get(ref.contentHash);
        if (existing !== undefined && existing.contentKind !== ref.contentKind) {
            throw new Error("one Deployment payload hash has conflicting content kinds");
        }
        payloads.set(ref.contentHash, {
            contentKind: ref.contentKind,
            contentHash: ref.contentHash,
            bytes,
        });
    }
    return [...payloads.values()].sort((left, right) => compareUtf8Bytes(left.contentHash, right.contentHash));
}
