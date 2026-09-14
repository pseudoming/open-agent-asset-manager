import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { hasExactKeys, isCanonicalRelativePath } from "../foundation/validators";
import type { JournalDirectoryEntry, JournalEntry } from "./deployment-journal";

export function isValidManagedDirectoryBoundaries(value: unknown): value is string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && isCanonicalRelativePath(item))) {
        return false;
    }
    if (new Set(value).size !== value.length || JSON.stringify([...value].sort()) !== JSON.stringify(value)) return false;
    return !value.some((boundary, index) =>
        value.some(
            (candidate, candidateIndex) =>
                index !== candidateIndex && (boundary.startsWith(`${candidate}/`) || candidate.startsWith(`${boundary}/`)),
        ),
    );
}

export function isValidJournalDirectoryEntries(
    value: unknown,
    entries: JournalEntry[],
    boundaries: string[],
    schemaVersion: 2 | 3 = 2,
): value is JournalDirectoryEntry[] {
    if (!Array.isArray(value) || value.length > 4_096) return false;
    if (
        entries.some(
            (entry) =>
                entry.entryAuthority === "explicit_unmanaged_replacement" &&
                !boundaries.some((boundary) => entry.relativePath === boundary || entry.relativePath.startsWith(`${boundary}/`)),
        )
    ) {
        return false;
    }
    const expectedDesiredPaths = expectedDesiredDirectoryPaths(entries, boundaries);
    if (expectedDesiredPaths === null) return false;
    const expectedDesiredPathSet = new Set(expectedDesiredPaths);
    const paths: string[] = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null) return false;
        const entry = item as Record<string, unknown>;
        if (
            !hasExactKeys(entry, [
                "relativePath",
                "oldState",
                "desiredState",
                "oldIdentity",
                "createdIdentity",
                ...(schemaVersion === 3 ? ["restoredIdentity"] : []),
            ])
        ) {
            return false;
        }
        if (typeof entry.relativePath !== "string" || !isCanonicalRelativePath(entry.relativePath)) return false;
        const relativePath = entry.relativePath;
        if (entry.oldState !== "missing" && entry.oldState !== "present") return false;
        if (entry.desiredState !== "missing" && entry.desiredState !== "present") return false;
        if (!isDirectoryIdentityOrNull(entry.oldIdentity) || !isDirectoryIdentityOrNull(entry.createdIdentity)) return false;
        if (
            schemaVersion === 3 &&
            (!isDirectoryIdentityOrNull(entry.restoredIdentity) ||
                (entry.restoredIdentity !== null && (entry.oldState !== "present" || entry.desiredState !== "missing")))
        )
            return false;
        if (
            (entry.oldState === "present" && (entry.oldIdentity === null || entry.createdIdentity !== null)) ||
            (entry.oldState === "missing" && entry.oldIdentity !== null) ||
            (entry.desiredState === "missing" && entry.oldState !== "present")
        ) {
            return false;
        }
        if (
            entry.desiredState === "present" &&
            ((!expectedDesiredPathSet.has(relativePath) &&
                !boundaries.some((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`)) &&
                !(entry.oldState === "missing" && boundaries.some((boundary) => boundary.startsWith(`${relativePath}/`)))) ||
                entries.some((file) => !file.isRemoval && file.relativePath === relativePath))
        )
            return false;
        if (
            entry.desiredState === "missing" &&
            !boundaries.some((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`))
        ) {
            return false;
        }
        paths.push(relativePath);
    }
    if (new Set(paths).size !== paths.length) return false;
    const ordered = [...paths].sort(byDepthThenUtf8);
    if (JSON.stringify(paths) !== JSON.stringify(ordered)) return false;
    const desiredPaths = (value as JournalDirectoryEntry[])
        .filter((entry) => entry.desiredState === "present")
        .map((entry) => entry.relativePath);
    const desiredPathSet = new Set(desiredPaths);
    if (expectedDesiredPaths.some((relativePath) => !desiredPathSet.has(relativePath))) return false;
    for (const relativePath of desiredPaths) {
        if (expectedDesiredPathSet.has(relativePath)) continue;
        // Optional missing-before ancestor receipts extend neither legacy required paths nor
        // managed inventory/removal authority. Existing shared parents remain excluded above.
        if (boundaries.some((boundary) => boundary.startsWith(`${relativePath}/`) && desiredPathSet.has(boundary))) continue;
        const containing = boundaries.filter((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`));
        if (containing.length !== 1) return false;
        if (relativePath === containing[0]) continue;
        const parent = relativePath.slice(0, relativePath.lastIndexOf("/"));
        if (!desiredPathSet.has(parent)) return false;
    }
    return true;
}

function expectedDesiredDirectoryPaths(entries: JournalEntry[], boundaries: string[]): string[] | null {
    const desired = new Set<string>();
    for (const entry of entries) {
        if (entry.isRemoval) continue;
        const containing = boundaries.filter(
            (boundary) => entry.relativePath === boundary || entry.relativePath.startsWith(`${boundary}/`),
        );
        if (containing.length > 1) return null;
        const boundary = containing[0];
        const segments = entry.relativePath.split("/");
        segments.pop();
        let current = "";
        for (const segment of segments) {
            current = current === "" ? segment : `${current}/${segment}`;
            if (boundary !== undefined && current !== boundary && !current.startsWith(`${boundary}/`)) continue;
            desired.add(current);
        }
    }
    return [...desired].sort(byDepthThenUtf8);
}

export function isDirectoryIdentityOrNull(value: unknown): value is PhysicalPathIdentity | null {
    if (value === null) return true;
    if (typeof value !== "object") return false;
    const identity = value as Record<string, unknown>;
    return (
        hasExactKeys(identity, ["deviceId", "fileId", "entryKind"]) &&
        typeof identity.deviceId === "string" &&
        identity.deviceId.length > 0 &&
        !identity.deviceId.includes("\0") &&
        typeof identity.fileId === "string" &&
        identity.fileId.length > 0 &&
        !identity.fileId.includes("\0") &&
        identity.entryKind === "directory"
    );
}

function byDepthThenUtf8(left: string, right: string): number {
    const depth = left.split("/").length - right.split("/").length;
    return depth || Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
