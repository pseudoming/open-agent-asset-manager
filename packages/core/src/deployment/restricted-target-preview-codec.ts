/** Explicit preview bytes and last-success facts; no State row or arbitrary object revival. */
import type { TargetFileContent } from "../contracts/common";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import { validateSectionBinding } from "../render/deployment-render-authority-validation";
import { validateTargetPlanPaths } from "./deployment-execution-validation";
import type { DeploymentPreWritePreviewInput } from "./deployment-prewrite-preview";
import type { TargetFilePlan, TargetPlan } from "./deployment-target-plan";

export type RestrictedTargetContentWire =
    | Extract<TargetFileContent, { contentKind: "text" }>
    | { contentKind: "binary"; bytesBase64: string };
export type RestrictedPreviewInput = Omit<DeploymentPreWritePreviewInput, "targetRootPath">;
export type RestrictedPreviewWire = Omit<RestrictedPreviewInput, "targetPlan"> & {
    targetPlan: Omit<TargetPlan, "targetFiles"> & {
        targetFiles: Array<Omit<TargetFilePlan, "content"> & { content: RestrictedTargetContentWire }>;
    };
};

export function encodeRestrictedTargetContent(content: TargetFileContent): RestrictedTargetContentWire {
    return content.contentKind === "text"
        ? { ...content }
        : { contentKind: "binary", bytesBase64: Buffer.from(content.bytes).toString("base64") };
}

export function decodeRestrictedTargetContent(value: unknown): TargetFileContent | null {
    if (value === null || typeof value !== "object") return null;
    const wire = value as RestrictedTargetContentWire;
    if (wire.contentKind === "text") {
        return hasExactKeys(wire, ["contentKind", "text"]) && typeof wire.text === "string" ? { ...wire } : null;
    }
    if (
        wire.contentKind !== "binary" ||
        !hasExactKeys(wire, ["contentKind", "bytesBase64"]) ||
        typeof wire.bytesBase64 !== "string"
    ) {
        return null;
    }
    const bytes = Buffer.from(wire.bytesBase64, "base64");
    return bytes.toString("base64") === wire.bytesBase64 ? { contentKind: "binary", bytes: new Uint8Array(bytes) } : null;
}

export function encodeRestrictedPreview(input: DeploymentPreWritePreviewInput): RestrictedPreviewWire {
    const wire: RestrictedPreviewWire = {
        deploymentId: input.deploymentId,
        renderInputFingerprint: input.renderInputFingerprint,
        selectionFingerprint: input.selectionFingerprint,
        compilationFingerprint: input.compilationFingerprint,
        targetPlan: {
            ...structuredClone(input.targetPlan),
            targetFiles: input.targetPlan.targetFiles.map((file) => ({
                ...structuredClone(file),
                content: encodeRestrictedTargetContent(file.content),
            })),
        },
        baseline: input.baseline.map((file) => ({
            relativePath: file.relativePath,
            managedDirectoryBoundaryPaths: [...file.managedDirectoryBoundaryPaths],
            baselineState: {
                appliedPayload: { contentHash: file.baselineState.appliedPayload.contentHash },
                appliedExecutable: file.baselineState.appliedExecutable,
            },
        })),
    };
    if (decodeRestrictedPreview(wire) === null) throw new Error("invalid restricted preview input");
    return wire;
}

export function decodeRestrictedPreview(value: unknown): RestrictedPreviewInput | null {
    try {
        if (
            !hasExactKeys(value, [
                "deploymentId",
                "renderInputFingerprint",
                "selectionFingerprint",
                "compilationFingerprint",
                "targetPlan",
                "baseline",
            ])
        )
            return null;
        const wire = value as RestrictedPreviewWire;
        if (
            !isUuidV4(wire.deploymentId) ||
            !isSha256Digest(wire.renderInputFingerprint) ||
            !isSha256Digest(wire.selectionFingerprint) ||
            !isSha256Digest(wire.compilationFingerprint)
        )
            return null;
        const plan = wire.targetPlan;
        if (
            !hasExactKeys(plan, ["schemaVersion", "targetFiles", "managedDirectoryBoundaries"]) ||
            plan.schemaVersion !== 1 ||
            !Array.isArray(plan.targetFiles) ||
            plan.targetFiles.length > 256 ||
            !Array.isArray(plan.managedDirectoryBoundaries) ||
            plan.managedDirectoryBoundaries.length > 4_096
        )
            return null;
        const targetFiles: TargetFilePlan[] = [];
        for (const file of plan.targetFiles) {
            if (
                !hasExactKeys(file, [
                    "relativePath",
                    "content",
                    "executable",
                    "outputUnitFingerprint",
                    "materializationFingerprint",
                    "semanticRefFingerprints",
                    "sectionBindings",
                    ...(file.containerPatchPreimageHash === undefined ? [] : ["containerPatchPreimageHash"]),
                ]) ||
                !isCanonicalRelativePath(file.relativePath) ||
                typeof file.executable !== "boolean" ||
                !isSha256Digest(file.outputUnitFingerprint) ||
                !isSha256Digest(file.materializationFingerprint) ||
                !Array.isArray(file.semanticRefFingerprints) ||
                !file.semanticRefFingerprints.every(isSha256Digest) ||
                !Array.isArray(file.sectionBindings)
            )
                return null;
            file.sectionBindings.forEach(validateSectionBinding);
            const content = decodeRestrictedTargetContent(file.content);
            if (content === null) return null;
            targetFiles.push({ ...structuredClone(file), content });
        }
        for (const boundary of plan.managedDirectoryBoundaries) {
            if (
                !hasExactKeys(boundary, [
                    "relativePath",
                    "outputUnitFingerprint",
                    ...(boundary.desiredDirectoryPaths === undefined ? [] : ["desiredDirectoryPaths"]),
                ]) ||
                !isSha256Digest(boundary.outputUnitFingerprint) ||
                (boundary.desiredDirectoryPaths !== undefined && !paths(boundary.desiredDirectoryPaths))
            )
                return null;
        }
        const targetPlan: TargetPlan = { ...structuredClone(plan), targetFiles };
        if (validateTargetPlanPaths(targetPlan) !== null || !Array.isArray(wire.baseline) || wire.baseline.length > 256)
            return null;
        for (const file of wire.baseline) {
            if (
                !hasExactKeys(file, ["relativePath", "managedDirectoryBoundaryPaths", "baselineState"]) ||
                !isCanonicalRelativePath(file.relativePath) ||
                !paths(file.managedDirectoryBoundaryPaths) ||
                !hasExactKeys(file.baselineState, ["appliedPayload", "appliedExecutable"]) ||
                !hasExactKeys(file.baselineState.appliedPayload, ["contentHash"]) ||
                !isSha256Digest(file.baselineState.appliedPayload.contentHash) ||
                typeof file.baselineState.appliedExecutable !== "boolean" ||
                file.managedDirectoryBoundaryPaths.some((boundary) => !file.relativePath.startsWith(`${boundary}/`))
            )
                return null;
        }
        if (new Set(wire.baseline.map((file) => file.relativePath)).size !== wire.baseline.length) return null;
        return { ...structuredClone(wire), targetPlan };
    } catch {
        return null;
    }
}

function paths(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 4_096 &&
        value.every(isCanonicalRelativePath) &&
        new Set(value).size === value.length
    );
}
