/** Physical observations and owned staging for Core publication; no commit decisions. */
import {
    assertDirectoryTreeRecycleSupported,
    durableRecycleDirectoryTreeIfIdentity,
    confirmDurableDirectoryTreeNoFollow,
    confirmDurableRegularFileNoFollow,
    durableCreateFile,
    durableEnsureDirectory,
    durablePublishDirectory,
    durablePublishRegularFile,
    durableRemoveDirectoryTree,
    durableRemoveRegularFile,
    inspectDirectoryNoFollow,
    inspectRegularFileNoFollow,
    inspectFilesystemFailure,
    readRegularFileNoFollow,
    samePhysicalPathIdentity,
    type PhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath, splitPhysicalAccessPath } from "@oaam/shared/paths";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { captureManagedDirectoryGraph } from "./deployment-managed-directory-graph";
import type { ActiveJournalV4 } from "./deployment-journal";
import { containsPublicationPath, type JournalPublication, type PublicationTreeSnapshot } from "./deployment-publication-model";
import { absPath, type TargetIoContext } from "./deployment-target-io";
import { selectPublicationStagingRoot, type PublicationStagingParents } from "./deployment-publication-staging";

export function publicationLocations(ctx: TargetIoContext, journal: ActiveJournalV4, index: number) {
    const target = absPath(ctx, journal.publications[index]!.relativePath);
    const { parentPath } = splitPhysicalAccessPath(target);
    const staging = journal.staging.rootPath;
    return {
        target,
        parent: parentPath,
        prepared: joinPhysicalAccessPath(staging, `${index}-prepared`),
        original: joinPhysicalAccessPath(staging, `${index}-original`),
        quarantine: joinPhysicalAccessPath(staging, `${index}-quarantine`),
        restoration: joinPhysicalAccessPath(staging, `${index}-restoration`),
    };
}

export function publicationStagingRoot(
    ctx: TargetIoContext,
    transactionId: string,
    publications: readonly JournalPublication[],
    boundaries: readonly string[],
    parents: PublicationStagingParents = {},
): string {
    return selectPublicationStagingRoot(ctx, transactionId, publications, boundaries, parents);
}

export function publicationIdentity(path: string, kind: "file" | "directory"): PhysicalPathIdentity | null {
    try {
        return kind === "directory" ? inspectDirectoryNoFollow(path) : inspectRegularFileNoFollow(path);
    } catch (error) {
        if (inspectFilesystemFailure(error).failureKind === "not_found") return null;
        throw error;
    }
}

export function samePublicationIdentity(left: PhysicalPathIdentity | null, right: PhysicalPathIdentity | null): boolean {
    return left === null || right === null ? left === right : samePhysicalPathIdentity(left, right);
}

export function capturePublicationTree(path: string): PublicationTreeSnapshot | null {
    const { parentPath, name } = splitPhysicalAccessPath(path);
    const graph = captureManagedDirectoryGraph(parentPath, [{ relativePath: name }]);
    const root = graph.directories.find((entry) => entry.relativePath === name);
    if (root === undefined) return null;
    return {
        identity: root.identity,
        files: graph.files.map(({ relativePath, current }) => ({
            relativePath: relativePath.slice(name.length + 1),
            contentHash: sha256Bytes(current.bytes),
            executable: current.executable,
        })),
        directoryPaths: graph.directories
            .map(({ relativePath }) => (relativePath === name ? "" : relativePath.slice(name.length + 1)))
            .sort(compareUtf8Bytes),
    };
}

export function desiredPublicationTree(journal: ActiveJournalV4, unit: Extract<JournalPublication, { kind: "directory" }>) {
    const files = journal.entries
        .filter((entry) => !entry.isRemoval && containsPublicationPath(unit.relativePath, entry.relativePath))
        .map((entry) => ({
            relativePath: entry.relativePath.slice(unit.relativePath.length + 1),
            contentHash: entry.newHash,
            executable: entry.newExecutable,
        }))
        .sort((a, b) => compareUtf8Bytes(a.relativePath, b.relativePath));
    const directoryPaths = journal.directoryEntries
        .filter((entry) => entry.desiredState === "present" && containsPublicationPath(unit.relativePath, entry.relativePath))
        .map((entry) => (entry.relativePath === unit.relativePath ? "" : entry.relativePath.slice(unit.relativePath.length + 1)))
        .sort(compareUtf8Bytes);
    return directoryPaths.length === 0 ? null : { files, directoryPaths };
}

export function samePublicationTreeContent(
    left: PublicationTreeSnapshot | null,
    right: Pick<PublicationTreeSnapshot, "files" | "directoryPaths"> | null,
): boolean {
    if (left === null || right === null) return left === right;
    return (
        stableStringify({ files: left.files, directoryPaths: left.directoryPaths }) ===
        stableStringify({ files: right.files, directoryPaths: right.directoryPaths })
    );
}

export function movePublicationEntry(
    source: string,
    destination: string,
    kind: "file" | "directory",
    expected: PhysicalPathIdentity,
): PhysicalPathIdentity {
    if (!samePublicationIdentity(publicationIdentity(source, kind), expected))
        throw new Error("publication source identity changed");
    // The no-replace publisher requires a durable source, including an externally
    // edited original or quarantined tree that did not pass through preparation.
    const confirmed =
        kind === "directory"
            ? confirmDurableDirectoryTreeNoFollow(source, 4096)
            : confirmDurableRegularFileNoFollow(source).identity;
    if (!samePhysicalPathIdentity(confirmed, expected))
        throw new Error("publication source identity changed during durability confirmation");
    const { parentPath, name } = splitPhysicalAccessPath(destination);
    const moved =
        kind === "directory"
            ? durablePublishDirectory(source, parentPath, name)
            : durablePublishRegularFile(source, parentPath, name);
    if (!samePhysicalPathIdentity(moved, expected))
        throw new Error("publication moved an unexpected object; preserve both locations");
    return moved;
}

export function createPreparedDirectory(path: string): PhysicalPathIdentity {
    if (publicationIdentity(path, "directory") !== null) throw new Error("unreceipted staging directory already exists");
    const { parentPath, name } = splitPhysicalAccessPath(path);
    const created = durableEnsureDirectory(parentPath, name);
    if (!created.created) throw new Error("staging directory creation was not exclusive");
    return created.identity;
}

export function removeEmptyPublicationStaging(path: string, expected: PhysicalPathIdentity): void {
    if (!samePublicationIdentity(publicationIdentity(path, "directory"), expected))
        throw new Error("staging root identity changed");
    durableRemoveDirectoryTree(path, 0);
}

export function fillPreparedDirectory(
    path: string,
    journal: ActiveJournalV4,
    unit: Extract<JournalPublication, { kind: "directory" }>,
): void {
    const desired = desiredPublicationTree(journal, unit);
    if (desired === null) throw new Error("absent desired tree cannot be prepared");
    for (const relativePath of desired.directoryPaths
        .filter(Boolean)
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
        const { parentPath, name } = splitPhysicalAccessPath(joinPhysicalAccessPath(path, relativePath));
        if (!durableEnsureDirectory(parentPath, name).created) throw new Error("prepared tree acquired unexpected content");
    }
    for (const entry of journal.entries.filter(
        (entry) => !entry.isRemoval && containsPublicationPath(unit.relativePath, entry.relativePath),
    )) {
        const filePath = joinPhysicalAccessPath(path, entry.relativePath.slice(unit.relativePath.length + 1));
        durableCreateFile(filePath, Buffer.from(entry.newBytesBase64, "base64"), entry.newExecutable);
        confirmDurableRegularFileNoFollow(filePath);
    }
    const identity = confirmDurableDirectoryTreeNoFollow(path, 4096);
    if (
        !samePublicationIdentity(identity, unit.preparedIdentity) ||
        !samePublicationTreeContent(capturePublicationTree(path), desired)
    )
        throw new Error("prepared complete tree verification failed");
}

export function createRestorationFile(path: string, bytes: Uint8Array, executable: boolean): PhysicalPathIdentity {
    durableCreateFile(path, bytes, executable);
    return confirmDurableRegularFileNoFollow(path).identity;
}

export function removeOwnedPublication(
    path: string,
    kind: "file" | "directory",
    expected: PhysicalPathIdentity,
    expectedTree?: PublicationTreeSnapshot,
): void {
    if (!samePublicationIdentity(publicationIdentity(path, kind), expected))
        throw new Error("owned publication identity changed before cleanup");
    if (kind === "file") {
        durableRemoveRegularFile(path);
        return;
    }
    const captured = capturePublicationTree(path);
    if (captured === null || !samePhysicalPathIdentity(captured.identity, expected))
        throw new Error("owned tree changed before cleanup");
    if (expectedTree !== undefined && !samePublicationTreeContent(captured, expectedTree))
        throw new Error("owned tree content changed before cleanup");
    if (expectedTree !== undefined && supportsOwnedTreeRecycle(path)) {
        const confirmed = capturePublicationTree(path);
        if (
            confirmed === null ||
            !samePhysicalPathIdentity(confirmed.identity, expected) ||
            !samePublicationTreeContent(confirmed, captured)
        )
            throw new Error("owned tree changed before recycle");
        // This is the receipted private staging tree, already checked against the journal's known content.
        // Bind the existing physical recycle operation to its identity and exact observed child-count limit.
        durableRecycleDirectoryTreeIfIdentity(path, expected, captured.files.length + captured.directoryPaths.length - 1);
        return;
    }
    // Incomplete preparations and backends without identity-bound Trash retain bounded per-entry cleanup.
    for (const file of captured.files) durableRemoveRegularFile(joinPhysicalAccessPath(path, file.relativePath));
    for (const directory of [...captured.directoryPaths].sort(
        (a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a),
    )) {
        durableRemoveDirectoryTree(directory === "" ? path : joinPhysicalAccessPath(path, directory), 0);
    }
}

function supportsOwnedTreeRecycle(path: string): boolean {
    try {
        assertDirectoryTreeRecycleSupported(path);
        return true;
    } catch (error) {
        if (inspectFilesystemFailure(error).failureKind !== "unsupported_platform") throw error;
        return false;
    }
}

export function readPublicationFile(path: string) {
    try {
        const file = readRegularFileNoFollow(path);
        return { identity: file.identity, contentHash: sha256Bytes(file.bytes), executable: file.executable };
    } catch (error) {
        if (inspectFilesystemFailure(error).failureKind === "not_found") return null;
        throw error;
    }
}
