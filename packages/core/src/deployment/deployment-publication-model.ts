/** Versioned deployment publication state. Only Core decides scope and recovery direction. */
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import { isDirectoryIdentityOrNull } from "./deployment-journal-directory-validation";
import { compareUtf8Bytes } from "../foundation/text-order";
import type { JournalDirectoryEntry, JournalEntry } from "./deployment-journal";

export interface PublicationTreeSnapshot {
    identity: PhysicalPathIdentity;
    files: { relativePath: string; contentHash: string; executable: boolean }[];
    directoryPaths: string[];
}

export interface PublicationRecoveryIntent {
    side: "old" | "new";
    candidateIdentity: PhysicalPathIdentity | null;
    restoreIdentity: PhysicalPathIdentity | null;
}

export type JournalPublication = {
    relativePath: string;
    completeReplacement: boolean;
    recovery: PublicationRecoveryIntent | null;
} & (
    | { kind: "file" }
    | {
          kind: "directory";
          oldTree: PublicationTreeSnapshot | null;
          preparedIdentity: PhysicalPathIdentity | null;
      }
);

export interface CompleteReplacementScope {
    filePaths: string[];
    directoryPaths: string[];
}

export function containsPublicationPath(parent: string, child: string): boolean {
    return parent === child || child.startsWith(`${parent}/`);
}

export function isCompleteReplacementPath(scope: CompleteReplacementScope, relativePath: string): boolean {
    return (
        scope.filePaths.includes(relativePath) ||
        scope.directoryPaths.some((parent) => containsPublicationPath(parent, relativePath))
    );
}

function isIdentity(value: unknown, kind: "file" | "directory"): value is PhysicalPathIdentity {
    if (!hasExactKeys(value, ["deviceId", "fileId", "entryKind"])) return false;
    const identity = value as PhysicalPathIdentity;
    return (
        identity.entryKind === kind &&
        typeof identity.deviceId === "string" &&
        identity.deviceId.length > 0 &&
        !identity.deviceId.includes("\0") &&
        typeof identity.fileId === "string" &&
        identity.fileId.length > 0 &&
        !identity.fileId.includes("\0")
    );
}

function sortedPaths(value: unknown, rootAllowed = false): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 4096 &&
        value.every((item) => (rootAllowed && item === "") || isCanonicalRelativePath(item)) &&
        new Set(value).size === value.length &&
        JSON.stringify([...value].sort(compareUtf8Bytes)) === JSON.stringify(value)
    );
}

export function isPublicationTreeSnapshot(value: unknown): value is PublicationTreeSnapshot {
    if (!hasExactKeys(value, ["identity", "files", "directoryPaths"])) return false;
    const tree = value as PublicationTreeSnapshot;
    if (
        !isIdentity(tree.identity, "directory") ||
        !sortedPaths(tree.directoryPaths, true) ||
        tree.directoryPaths[0] !== "" ||
        !Array.isArray(tree.files) ||
        tree.files.length > 4096
    )
        return false;
    if (
        !tree.files.every(
            (file) =>
                hasExactKeys(file, ["relativePath", "contentHash", "executable"]) &&
                isCanonicalRelativePath(file.relativePath) &&
                isSha256Digest(file.contentHash) &&
                typeof file.executable === "boolean",
        )
    )
        return false;
    const filePaths = tree.files.map((file) => file.relativePath);
    if (!sortedPaths(filePaths) || filePaths.some((file) => tree.directoryPaths.includes(file))) return false;
    return [...filePaths, ...tree.directoryPaths.filter(Boolean)].every((relativePath) =>
        tree.directoryPaths.includes(relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : ""),
    );
}

export function isValidPublications(
    value: unknown,
    entries: JournalEntry[],
    directories: JournalDirectoryEntry[],
    boundaries: string[],
): value is JournalPublication[] {
    if (!Array.isArray(value) || value.length > 4096) return false;
    const paths: string[] = [];
    for (const unit of value as JournalPublication[]) {
        if (typeof unit !== "object" || unit === null) return false;
        if (
            !hasExactKeys(unit, [
                "relativePath",
                "kind",
                "completeReplacement",
                "recovery",
                ...(unit.kind === "directory" ? ["oldTree", "preparedIdentity"] : []),
            ]) ||
            !isCanonicalRelativePath(unit.relativePath) ||
            !["file", "directory"].includes(unit.kind) ||
            typeof unit.completeReplacement !== "boolean"
        )
            return false;
        paths.push(unit.relativePath);
        if (unit.kind === "file") {
            const entry = entries.find((entry) => entry.relativePath === unit.relativePath);
            if (entry === undefined || (unit.completeReplacement && entry.isRemoval)) return false;
        } else {
            const directory = directories.find((entry) => entry.relativePath === unit.relativePath);
            if (
                directory === undefined ||
                (unit.oldTree !== null && !isPublicationTreeSnapshot(unit.oldTree)) ||
                !isDirectoryIdentityOrNull(unit.preparedIdentity) ||
                (unit.completeReplacement && !boundaries.includes(unit.relativePath)) ||
                (!boundaries.includes(unit.relativePath) && (directory.oldState !== "missing" || unit.oldTree !== null))
            )
                return false;
        }
        if (unit.recovery !== null) {
            const recovery = unit.recovery;
            if (
                !hasExactKeys(recovery, ["side", "candidateIdentity", "restoreIdentity"]) ||
                !["old", "new"].includes(recovery.side) ||
                (recovery.candidateIdentity !== null && !isIdentity(recovery.candidateIdentity, unit.kind)) ||
                (recovery.restoreIdentity !== null && (unit.kind !== "file" || !isIdentity(recovery.restoreIdentity, "file")))
            )
                return false;
        }
    }
    if (
        !sortedPaths(paths) ||
        paths.some((parent, index) => paths.some((child, other) => index !== other && containsPublicationPath(parent, child)))
    )
        return false;
    return (
        entries.every((entry) =>
            (value as JournalPublication[]).some((unit) =>
                unit.kind === "directory"
                    ? containsPublicationPath(unit.relativePath, entry.relativePath)
                    : unit.relativePath === entry.relativePath,
            ),
        ) &&
        directories
            .filter((entry) => entry.oldState === "missing")
            .every((entry) =>
                (value as JournalPublication[]).some(
                    (unit) => unit.kind === "directory" && containsPublicationPath(unit.relativePath, entry.relativePath),
                ),
            )
    );
}
