/** Bounded semantic usage expectations; no source snapshot or arbitrary filesystem request. */
import { RESTRICTED_TARGET_MAX_FRAME_BYTES } from "../deployment/restricted-target-contract";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import type { Sha256Digest } from "../types";
import { isAssetUsageTargetFailureStatus } from "./asset-usage-target-diagnostics";
import type { AssetUsageTargetExpectation, AssetUsageTargetObservation } from "./asset-usage-target-observation";

export type RestrictedUsageExpectations = readonly AssetUsageTargetExpectation[];
export interface RestrictedUsageObservation {
    readonly expectationFingerprint: Sha256Digest;
    readonly observation: AssetUsageTargetObservation;
}

export function restrictedUsageExpectationFingerprint(expectation: AssetUsageTargetExpectation): Sha256Digest {
    return sha256Bytes(Buffer.from(`oaam.asset-usage-expectation.v1\n${stableStringify(expectation)}`, "utf8"));
}

export function encodeRestrictedUsageExpectations(value: RestrictedUsageExpectations): RestrictedUsageExpectations {
    const validated = decodeRestrictedUsageExpectations(value);
    if (validated === null) throw new TypeError("invalid restricted asset usage expectations");
    return validated;
}

export function decodeRestrictedUsageExpectations(value: unknown): RestrictedUsageExpectations | null {
    try {
        if (
            !Array.isArray(value) ||
            Buffer.byteLength(JSON.stringify(value), "utf8") > RESTRICTED_TARGET_MAX_FRAME_BYTES - 16_384
        )
            return null;
        for (const item of value) {
            if (!hasExactKeys(item, ["files", "directoryBoundaries", "sourceIdentityFingerprints"])) return null;
            if (
                !Array.isArray(item.files) ||
                !Array.isArray(item.directoryBoundaries) ||
                !Array.isArray(item.sourceIdentityFingerprints)
            )
                return null;
            for (const file of item.files) {
                if (
                    !hasExactKeys(file, ["relativePath", "contentHash", "byteSize", "executable"]) ||
                    !isCanonicalRelativePath(file.relativePath) ||
                    !isSha256Digest(file.contentHash) ||
                    !Number.isSafeInteger(file.byteSize) ||
                    file.byteSize < 0 ||
                    file.byteSize > 4 * 1024 * 1024 ||
                    typeof file.executable !== "boolean"
                )
                    return null;
            }
            if (!sortedUnique(item.files.map((file: { relativePath: string }) => file.relativePath))) return null;
            for (const boundary of item.directoryBoundaries) {
                if (
                    !hasExactKeys(boundary, ["relativePath", "desiredDirectoryPaths"]) ||
                    !isCanonicalRelativePath(boundary.relativePath) ||
                    !Array.isArray(boundary.desiredDirectoryPaths) ||
                    !boundary.desiredDirectoryPaths.every(isCanonicalRelativePath) ||
                    !sortedUnique(boundary.desiredDirectoryPaths) ||
                    !boundary.desiredDirectoryPaths.includes(boundary.relativePath) ||
                    boundary.desiredDirectoryPaths.some(
                        (directory: string) =>
                            directory !== boundary.relativePath && !directory.startsWith(`${boundary.relativePath}/`),
                    )
                )
                    return null;
            }
            if (
                new Set(item.directoryBoundaries.map((boundary: { relativePath: string }) => boundary.relativePath)).size !==
                    item.directoryBoundaries.length ||
                !item.sourceIdentityFingerprints.every(isSha256Digest) ||
                !sortedUnique(item.sourceIdentityFingerprints)
            )
                return null;
        }
        return structuredClone(value) as RestrictedUsageExpectations;
    } catch {
        return null;
    }
}

function sortedUnique(values: readonly string[]): boolean {
    return values.every((value, index) => index === 0 || compareUtf8Bytes(values[index - 1]!, value) < 0);
}

export function isRestrictedUsageObservation(value: unknown): value is AssetUsageTargetObservation {
    if (
        !hasExactKeys(value, ["observedTargetState", "physicalRelation"]) &&
        !hasExactKeys(value, ["observedTargetState", "physicalRelation", "failureStatus"])
    )
        return false;
    const observation = value as AssetUsageTargetObservation;
    if (Object.hasOwn(observation, "failureStatus")) {
        return (
            isAssetUsageTargetFailureStatus(observation.failureStatus) &&
            observation.observedTargetState === "unknown" &&
            observation.physicalRelation === "distinct_or_not_imported"
        );
    }
    const relation = observation.physicalRelation;
    if (relation !== "same_context_source" && relation !== "cross_context_unverified" && relation !== "distinct_or_not_imported")
        return false;
    if (observation.observedTargetState === "different") return true;
    if (observation.observedTargetState === "absent") return relation === "distinct_or_not_imported";
    if (observation.observedTargetState === "already_usable") return relation !== "cross_context_unverified";
    return observation.observedTargetState === "unknown" && relation !== "same_context_source";
}
