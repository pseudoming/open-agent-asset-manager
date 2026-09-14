/** Explicit byte projection for the private graph protocol; no arbitrary object revival. */
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { isCanonicalPhysicalAccessPath } from "@oaam/shared/paths";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import { isValidJournalEntry } from "./deployment-journal";
import { isDirectoryIdentityOrNull, isValidManagedDirectoryBoundaries } from "./deployment-journal-directory-validation";
import type { RestrictedGraphPrepareInput } from "./restricted-target-graph-operation";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";

type MissingFile = Extract<DeploymentRuntimeReplacementAuthorityV1["files"][number], { expectedState: "missing" }>;
type PresentFile = Extract<DeploymentRuntimeReplacementAuthorityV1["files"][number], { expectedState: "present" }>;
export type RestrictedReplacementAuthorityWire = Omit<DeploymentRuntimeReplacementAuthorityV1, "files"> & {
    files: Array<MissingFile | (Omit<PresentFile, "expectedBytes"> & { expectedBytesBase64: string })>;
};
export type RestrictedGraphPrepareWire = Omit<RestrictedGraphPrepareInput, "runtimeReplacementAuthority"> & {
    runtimeReplacementAuthority?: RestrictedReplacementAuthorityWire;
};

export function encodeRestrictedGraphPreparation(input: RestrictedGraphPrepareInput): RestrictedGraphPrepareWire {
    const { runtimeReplacementAuthority, ...rest } = structuredClone(input);
    const wire: RestrictedGraphPrepareWire = {
        ...rest,
        entries: rest.entries.map((entry) => ({ ...entry, entryAuthority: entry.entryAuthority ?? "managed_baseline" })),
        ...(runtimeReplacementAuthority === undefined
            ? {}
            : {
                  runtimeReplacementAuthority: encodeRestrictedReplacementAuthority(runtimeReplacementAuthority),
              }),
    };
    if (decodeRestrictedGraphPreparation(wire) === null) throw new Error("invalid restricted graph preparation input");
    return wire;
}

export function decodeRestrictedGraphPreparation(value: unknown): RestrictedGraphPrepareInput | null {
    if (value === null || typeof value !== "object") return null;
    const wire = value as RestrictedGraphPrepareWire;
    if (
        !hasExactKeys(wire, [
            "compilationFingerprint",
            "entries",
            "managedDirectoryBoundaries",
            "desiredDirectoryPaths",
            ...(wire.publicationTransactionId === undefined ? [] : ["publicationTransactionId"]),
            ...(wire.publicationProjectRootPath === undefined ? [] : ["publicationProjectRootPath"]),
            ...(wire.runtimeReplacementAuthority === undefined ? [] : ["runtimeReplacementAuthority"]),
        ]) ||
        !isSha256Digest(wire.compilationFingerprint) ||
        (wire.publicationTransactionId !== undefined && !isUuidV4(wire.publicationTransactionId)) ||
        (wire.publicationProjectRootPath !== undefined &&
            (wire.publicationTransactionId === undefined || !isCanonicalPhysicalAccessPath(wire.publicationProjectRootPath))) ||
        !Array.isArray(wire.entries) ||
        !wire.entries.every((entry) => isValidJournalEntry(entry, 2)) ||
        new Set(wire.entries.map((entry) => entry.relativePath)).size !== wire.entries.length ||
        !isValidManagedDirectoryBoundaries(wire.managedDirectoryBoundaries) ||
        !paths(wire.desiredDirectoryPaths)
    )
        return null;
    if (wire.runtimeReplacementAuthority === undefined) return structuredClone(wire) as RestrictedGraphPrepareInput;
    const authority = decodeRestrictedReplacementAuthority(wire.runtimeReplacementAuthority);
    if (authority === null) return null;
    const { runtimeReplacementAuthority: _wireAuthority, ...rest } = wire;
    return { ...structuredClone(rest), runtimeReplacementAuthority: authority };
}

function paths(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 4_096 &&
        value.every(isCanonicalRelativePath) &&
        new Set(value).size === value.length
    );
}

function fileIdentity(value: unknown): value is PhysicalPathIdentity {
    if (value === null || typeof value !== "object") return false;
    const identity = value as PhysicalPathIdentity;
    return identity.entryKind === "file" && isDirectoryIdentityOrNull({ ...identity, entryKind: "directory" });
}

export function encodeRestrictedReplacementAuthority(
    source: DeploymentRuntimeReplacementAuthorityV1,
): RestrictedReplacementAuthorityWire {
    const authority = structuredClone(source);
    return {
        ...authority,
        files: authority.files.map((file) => {
            if (file.expectedState === "missing") return file;
            const { expectedBytes, ...facts } = file;
            return { ...facts, expectedBytesBase64: Buffer.from(expectedBytes).toString("base64") };
        }),
    };
}

export function decodeRestrictedReplacementAuthority(value: unknown): DeploymentRuntimeReplacementAuthorityV1 | null {
    if (
        !hasExactKeys(value, [
            "files",
            "directories",
            "managedDirectoryBoundaryPaths",
            "desiredManagedDirectoryBoundaryPaths",
            "unmanagedRemovalPaths",
            "directoryRemovalPaths",
            ...(typeof value === "object" && value !== null && "replacementScope" in value ? ["replacementScope"] : []),
        ])
    )
        return null;
    const wire = value as RestrictedReplacementAuthorityWire;
    if (
        !Array.isArray(wire.files) ||
        !Array.isArray(wire.directories) ||
        wire.directories.length > 4_096 ||
        !isValidManagedDirectoryBoundaries(wire.managedDirectoryBoundaryPaths) ||
        !isValidManagedDirectoryBoundaries(wire.desiredManagedDirectoryBoundaryPaths) ||
        !paths(wire.unmanagedRemovalPaths) ||
        !paths(wire.directoryRemovalPaths)
    )
        return null;
    if (
        wire.replacementScope !== undefined &&
        (!hasExactKeys(wire.replacementScope, ["filePaths", "directoryPaths"]) ||
            !paths(wire.replacementScope.filePaths) ||
            !paths(wire.replacementScope.directoryPaths))
    )
        return null;
    const files: DeploymentRuntimeReplacementAuthorityV1["files"] = [];
    for (const file of wire.files) {
        if (file === null || typeof file !== "object" || !isCanonicalRelativePath(file.relativePath)) return null;
        if (file.expectedState === "missing") {
            if (!hasExactKeys(file, ["relativePath", "expectedState"])) return null;
            files.push({ ...file });
            continue;
        }
        if (
            file.expectedState !== "present" ||
            !hasExactKeys(file, [
                "relativePath",
                "expectedState",
                "expectedBytesBase64",
                "expectedExecutable",
                ...(file.expectedIdentity === undefined ? [] : ["expectedIdentity"]),
            ]) ||
            typeof file.expectedExecutable !== "boolean" ||
            typeof file.expectedBytesBase64 !== "string" ||
            (file.expectedIdentity !== undefined && !fileIdentity(file.expectedIdentity))
        )
            return null;
        const bytes = Buffer.from(file.expectedBytesBase64, "base64");
        if (bytes.toString("base64") !== file.expectedBytesBase64) return null;
        const { expectedBytesBase64: _bytes, ...facts } = file;
        files.push({ ...structuredClone(facts), expectedBytes: new Uint8Array(bytes) });
    }
    if (new Set(files.map((file) => file.relativePath)).size !== files.length) return null;
    for (const directory of wire.directories) {
        if (directory === null || typeof directory !== "object" || !isCanonicalRelativePath(directory.relativePath)) return null;
        if (directory.expectedState === "missing") {
            if (!hasExactKeys(directory, ["relativePath", "expectedState"])) return null;
        } else if (
            directory.expectedState !== "present" ||
            !hasExactKeys(directory, ["relativePath", "expectedState", "expectedIdentity"]) ||
            directory.expectedIdentity === null ||
            !isDirectoryIdentityOrNull(directory.expectedIdentity)
        )
            return null;
    }
    if (new Set(wire.directories.map((directory) => directory.relativePath)).size !== wire.directories.length) return null;
    return { ...structuredClone(wire), files };
}
