/** Only reviewed JSONC patch intents and their captured containers cross this private boundary. */
import type { OperationDiagnostic } from "../types";
import { replaceJsoncTopLevelPropertyValue } from "../foundation/jsonc-top-level-property";
import { hasExactKeys, isCanonicalRelativePath } from "../foundation/validators";
import type { CapturedDeploymentContainerPatchTarget, DeploymentContainerPatchIntent } from "./deployment-container-patch";
import { decodeRestrictedTargetContent } from "./restricted-target-preview-codec";

export interface RestrictedContainerPatchWire {
    relativePath: string;
    propertyName: string;
    fragmentBase64: string;
}
export interface RestrictedContainerCaptureWire {
    relativePath: string;
    currentBase64: string | null;
}
export type RestrictedContainerFailure = Pick<OperationDiagnostic, "code" | "message" | "causeKind" | "retryable">;

export function encodeRestrictedContainerPatches(
    intents: readonly DeploymentContainerPatchIntent[],
): RestrictedContainerPatchWire[] {
    const wire = intents.map(({ fragment, ...intent }) => ({
        ...intent,
        fragmentBase64: Buffer.from(fragment).toString("base64"),
    }));
    if (decodeRestrictedContainerPatches(wire) === null) throw new Error("invalid restricted container patch intents");
    return wire;
}

export function decodeRestrictedContainerPatches(value: unknown): DeploymentContainerPatchIntent[] | null {
    try {
        if (!Array.isArray(value) || value.length < 1 || value.length > 256) return null;
        const intents: DeploymentContainerPatchIntent[] = [];
        for (const item of value as RestrictedContainerPatchWire[]) {
            if (
                !hasExactKeys(item, ["relativePath", "propertyName", "fragmentBase64"]) ||
                !isCanonicalRelativePath(item.relativePath) ||
                typeof item.propertyName !== "string"
            )
                return null;
            const fragment = decodeRestrictedTargetContent({ contentKind: "binary", bytesBase64: item.fragmentBase64 });
            if (fragment?.contentKind !== "binary") return null;
            replaceJsoncTopLevelPropertyValue(null, item.propertyName, fragment.bytes);
            intents.push({ relativePath: item.relativePath, propertyName: item.propertyName, fragment: fragment.bytes });
        }
        return intents;
    } catch {
        return null;
    }
}

export function encodeRestrictedContainerCapture(
    captured: readonly CapturedDeploymentContainerPatchTarget[],
): RestrictedContainerCaptureWire[] {
    return captured.map((target) => ({
        relativePath: target.relativePath,
        currentBase64: target.currentBytes === null ? null : Buffer.from(target.currentBytes).toString("base64"),
    }));
}

export function decodeRestrictedContainerCapture(value: unknown): CapturedDeploymentContainerPatchTarget[] | null {
    if (!Array.isArray(value) || value.length > 256) return null;
    const captured: CapturedDeploymentContainerPatchTarget[] = [];
    for (const item of value as RestrictedContainerCaptureWire[]) {
        if (!hasExactKeys(item, ["relativePath", "currentBase64"]) || !isCanonicalRelativePath(item.relativePath)) return null;
        if (item.currentBase64 === null) {
            captured.push({ relativePath: item.relativePath, currentBytes: null });
            continue;
        }
        const current = decodeRestrictedTargetContent({ contentKind: "binary", bytesBase64: item.currentBase64 });
        if (current?.contentKind !== "binary") return null;
        captured.push({ relativePath: item.relativePath, currentBytes: current.bytes });
    }
    return new Set(captured.map((target) => target.relativePath)).size === captured.length ? captured : null;
}

export function isRestrictedContainerFailure(value: unknown): value is RestrictedContainerFailure {
    if (!hasExactKeys(value, ["code", "message", "causeKind", "retryable"])) return false;
    const failure = value as RestrictedContainerFailure;
    const causes: Record<string, OperationDiagnostic["causeKind"]> = {
        "render.materialization_container_patch_target_unavailable": "unavailable",
        "render.materialization_container_patch_limit": "unsupported",
        "render.materialization_container_patch_rejected": "unsupported",
        "render.materialization_container_patch_internal_error": "internal_error",
    };
    const cause = typeof failure.code === "string" && Object.hasOwn(causes, failure.code) ? causes[failure.code] : undefined;
    return (
        cause !== undefined &&
        failure.causeKind === cause &&
        typeof failure.message === "string" &&
        failure.retryable === (cause === "unavailable")
    );
}
