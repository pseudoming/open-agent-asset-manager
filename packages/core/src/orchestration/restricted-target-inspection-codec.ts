/** Exact compiled inspection claims and typed capture failures; no State or payload locators. */
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath } from "@oaam/shared/paths";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import { compareUtf8Bytes } from "../foundation/text-order";
import { validateRenderOutputUnit } from "../render/deployment-render-authority-validation";
import type { DeploymentInspectionTargetPlan } from "./deployment-inspection-capture";
import { DeploymentInspectionFailure } from "./deployment-inspection-errors";

export type RestrictedInspectionFailure =
    | {
          kind: "filesystem";
          failureKind: SafeFilesystemError["failureKind"];
          operation: "read_regular_file" | "inventory_directory";
          relativePath: string;
          systemCode: string;
          message: string;
      }
    | { kind: "ownership_conflict"; message: string }
    | { kind: "unavailable"; summary: string };

export function decodeRestrictedInspectionPlan(value: unknown): DeploymentInspectionTargetPlan | null {
    try {
        if (!hasExactKeys(value, ["compilationFingerprint", "outputUnits", "baselineFiles"])) return null;
        const plan = value as DeploymentInspectionTargetPlan;
        if (
            !isSha256Digest(plan.compilationFingerprint) ||
            !Array.isArray(plan.outputUnits) ||
            !Array.isArray(plan.baselineFiles)
        )
            return null;
        plan.outputUnits.forEach(validateRenderOutputUnit);
        if (new Set(plan.outputUnits.map((unit) => unit.outputUnitFingerprint)).size !== plan.outputUnits.length) return null;
        const claims = new Map(
            plan.outputUnits.flatMap((unit) => unit.claims.map((claim) => [claim.relativePath, unit] as const)),
        );
        if (
            claims.size !== plan.outputUnits.reduce((total, unit) => total + unit.claims.length, 0) ||
            claims.size !== plan.baselineFiles.length
        )
            return null;
        const boundaries = plan.outputUnits.flatMap((unit) =>
            unit.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
        );
        if (
            boundaries.some((boundary, index) =>
                boundaries.some(
                    (other, otherIndex) => index !== otherIndex && (boundary === other || boundary.startsWith(`${other}/`)),
                ),
            )
        )
            return null;
        const seen = new Set<string>();
        for (const file of plan.baselineFiles) {
            if (
                !hasExactKeys(file, ["relativePath", "outputUnitFingerprint", "managedDirectoryBoundaryPaths"]) ||
                !isCanonicalRelativePath(file.relativePath) ||
                seen.has(file.relativePath) ||
                !Array.isArray(file.managedDirectoryBoundaryPaths) ||
                !file.managedDirectoryBoundaryPaths.every(isCanonicalRelativePath)
            )
                return null;
            seen.add(file.relativePath);
            const owner = claims.get(file.relativePath as Parameters<typeof claims.get>[0]);
            if (owner === undefined || file.outputUnitFingerprint !== owner.outputUnitFingerprint) return null;
            const expected = owner.managedDirectoryBoundaries
                .filter((boundary) => file.relativePath.startsWith(`${boundary.relativePath}/`))
                .map((boundary) => boundary.relativePath)
                .sort(compareUtf8Bytes);
            const allOwners = boundaries
                .filter((boundary) => file.relativePath === boundary || file.relativePath.startsWith(`${boundary}/`))
                .sort(compareUtf8Bytes);
            if (
                JSON.stringify(expected) !== JSON.stringify(allOwners) ||
                JSON.stringify(expected) !== JSON.stringify([...file.managedDirectoryBoundaryPaths].sort(compareUtf8Bytes))
            )
                return null;
        }
        return structuredClone(plan);
    } catch {
        return null;
    }
}

export function encodeRestrictedInspectionFailure(error: unknown, executionRootPath: string): RestrictedInspectionFailure {
    if (error instanceof SafeFilesystemError) {
        if (error.operation !== "read_regular_file" && error.operation !== "inventory_directory") throw error;
        const relativePath =
            error.targetPath === executionRootPath
                ? ""
                : error.targetPath.startsWith(`${executionRootPath}/`)
                  ? error.targetPath.slice(executionRootPath.length + 1)
                  : null;
        if (relativePath === null || (relativePath !== "" && !isCanonicalRelativePath(relativePath))) throw error;
        return {
            kind: "filesystem",
            failureKind: error.failureKind,
            operation: error.operation,
            relativePath,
            systemCode: error.systemCode,
            message: error.message,
        };
    }
    if (
        error instanceof DeploymentInspectionFailure &&
        error.code === "scan.managed_directory_ownership_conflict" &&
        error.causeKind === "conflict" &&
        error.retryable
    )
        return { kind: "ownership_conflict", message: error.message };
    return { kind: "unavailable", summary: String(error) };
}

/** Recreate the original failure taxonomy with target paths in Host coordinates. */
export function decodeRestrictedInspectionFailure(value: unknown, targetRootPath: string): Error | null {
    if (value === null || typeof value !== "object") return null;
    const wire = value as RestrictedInspectionFailure;
    if (wire.kind === "filesystem") {
        if (
            !hasExactKeys(wire, ["kind", "failureKind", "operation", "relativePath", "systemCode", "message"]) ||
            ![
                "invalid_path",
                "not_found",
                "permission_denied",
                "symlink_or_reparse",
                "wrong_entry_type",
                "resource_limit",
                "stale",
                "unsupported_platform",
                "io_error",
            ].includes(wire.failureKind) ||
            (wire.operation !== "read_regular_file" && wire.operation !== "inventory_directory") ||
            (wire.relativePath !== "" && !isCanonicalRelativePath(wire.relativePath)) ||
            typeof wire.systemCode !== "string" ||
            typeof wire.message !== "string"
        )
            return null;
        return new SafeFilesystemError({
            ...wire,
            targetPath: wire.relativePath === "" ? targetRootPath : joinPhysicalAccessPath(targetRootPath, wire.relativePath),
        });
    }
    if (wire.kind === "ownership_conflict" && hasExactKeys(wire, ["kind", "message"]) && typeof wire.message === "string")
        return new DeploymentInspectionFailure("scan.managed_directory_ownership_conflict", wire.message, "conflict", true);
    if (wire.kind === "unavailable" && hasExactKeys(wire, ["kind", "summary"]) && typeof wire.summary === "string")
        return new DeploymentInspectionFailure(
            "scan.inspection_unavailable",
            `Deployment inspection authority is unavailable: ${wire.summary}`,
            "unavailable",
            true,
        );
    return null;
}
