import { ReadAccessFailure } from "../adapters/adapter-read-budget";
import { type AssetUsageTargetFailureStatus, assetUsageTargetFailureObservation } from "./asset-usage-target-diagnostics";
/** Fresh, read-only comparison of one exact Version's materialized output with an exact consumer target. */

import {
    inventoryDirectoryNoFollow,
    type PhysicalPathIdentity,
    SafeFilesystemError,
    type StableDirectoryInventory,
    type StableRegularFileRead,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import {
    joinPhysicalAccessPath,
    readPlatformContextRegularFileNoFollow,
    readPlatformContextRegularFileNoFollowBounded,
} from "@oaam/shared/paths";
import { physicalIdentityFingerprint } from "../adapters/adapter-read-physical-authority";
import type { ImportSourceSnapshotV1 } from "../contracts/persistence";
import { desiredDirectoryPathsForBoundaries } from "../deployment/deployment-managed-directory-graph";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { compareUtf8Bytes } from "../foundation/text-order";
import {
    observeStableTargetFileForTargetCheckAsync,
    type TargetCheckObservationSnapshot,
} from "../render/native-project-target-observation-snapshot";
import type { CoreRenderMaterializationView } from "../render/render-materialization";
import type { AssetUsageObservedTargetState, Platform, PlatformContext, PosixRelativePath, Sha256Digest } from "../types";

const MAXIMUM_OBSERVED_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_OBSERVED_DIRECTORY_ENTRIES = 2_048;
const MAXIMUM_SELECTED_WSL_OBSERVATION_MILLISECONDS = 25_000;
const PLATFORM_IDENTITIES: readonly Platform[] = ["darwin", "linux", "win32", "wsl"];

export interface AssetUsageTargetObservation {
    readonly failureStatus?: AssetUsageTargetFailureStatus;
    readonly observedTargetState: AssetUsageObservedTargetState;
    readonly physicalRelation: "same_context_source" | "cross_context_unverified" | "distinct_or_not_imported";
}

/** Minimal semantic expectation; no Provider authority or source snapshot crosses the Target channel. */
export interface AssetUsageTargetExpectation {
    readonly files: readonly {
        readonly relativePath: PosixRelativePath;
        readonly contentHash: Sha256Digest;
        readonly byteSize: number;
        readonly executable: boolean;
    }[];
    readonly directoryBoundaries: readonly {
        readonly relativePath: PosixRelativePath;
        readonly desiredDirectoryPaths: readonly PosixRelativePath[];
    }[];
    readonly sourceIdentityFingerprints: readonly Sha256Digest[];
}
interface ObservedUsageFile {
    readonly contentHash: Sha256Digest;
    readonly byteSize: number;
    readonly executable: boolean;
    readonly identity: PhysicalPathIdentity;
}

export function createAssetUsageTargetExpectation(
    materialization: CoreRenderMaterializationView,
    sourceSnapshot?: ImportSourceSnapshotV1,
): AssetUsageTargetExpectation {
    const files = flattenExpectedFiles(materialization).map((file) => {
        const bytes = expectedFileBytes(file);
        return {
            relativePath: file.relativePath,
            contentHash: sha256Bytes(bytes),
            byteSize: bytes.byteLength,
            executable: file.executable,
        };
    });
    const directoryBoundaries = materialization.units
        .flatMap((unit) => unit.outputUnit.managedDirectoryBoundaries)
        .map((boundary) => ({
            relativePath: boundary.relativePath,
            desiredDirectoryPaths: desiredDirectoryPathsForBoundaries(
                [boundary],
                files.map((file) => file.relativePath),
            ),
        }));
    const sourceIdentityFingerprints = [
        ...new Set(
            sourceSnapshot?.entries.flatMap((entry) => (entry.entryKind === "file" ? [entry.physicalIdentityFingerprint] : [])) ??
                [],
        ),
    ].sort(compareUtf8Bytes);
    return { files, directoryBoundaries, sourceIdentityFingerprints };
}

/** A single business capture reuses bounded file facts, never bytes or observations from an earlier user check. */
export function observeAssetUsageExpectedTargets(input: {
    readonly expectations: readonly AssetUsageTargetExpectation[];
    readonly targetRootPath: string;
    readonly platformContext: PlatformContext;
}): AssetUsageTargetObservation[] {
    const files = new Map<string, { value: ObservedUsageFile } | { error: unknown }>();
    const read = (filePath: string): ObservedUsageFile => {
        const existing = files.get(filePath);
        if (existing !== undefined) {
            if ("error" in existing) throw existing.error;
            return existing.value;
        }
        try {
            const value = observedUsageFile(
                readPlatformContextRegularFileNoFollow({
                    ...input.platformContext,
                    filePath,
                    maximumBytes: MAXIMUM_OBSERVED_FILE_BYTES,
                }),
            );
            files.set(filePath, { value });
            return value;
        } catch (error) {
            files.set(filePath, { error });
            throw error;
        }
    };
    return input.expectations.map((expectation) =>
        observeExpectedTarget(expectation, input.targetRootPath, input.platformContext, read, inventoryDirectoryNoFollow),
    );
}

function observedUsageFile(current: StableRegularFileRead): ObservedUsageFile {
    return {
        contentHash: sha256Bytes(current.bytes),
        byteSize: current.bytes.byteLength,
        executable: current.executable,
        identity: current.identity,
    };
}

function observeExpectedTarget(
    expectation: AssetUsageTargetExpectation,
    targetRootPath: string,
    platformContext: PlatformContext,
    read: (filePath: string) => ObservedUsageFile,
    inventoryDirectory: typeof inventoryDirectoryNoFollow,
): AssetUsageTargetObservation {
    try {
        if (expectation.files.length === 0) return unknown();
        const sourceFingerprints = new Set(expectation.sourceIdentityFingerprints);
        const observations = expectation.files.map((file) => {
            try {
                return observeExpectedFile(
                    read(joinPhysicalAccessPath(targetRootPath, file.relativePath)),
                    file,
                    platformContext,
                    sourceFingerprints,
                );
            } catch (error) {
                if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return absentExpectedFile();
                throw error;
            }
        });
        return classifyObservedTarget(expectation.files.length, observations, expectation, targetRootPath, inventoryDirectory);
    } catch (error) {
        return assetUsageTargetFailureObservation(error);
    }
}

export function observeAssetUsageTarget(input: {
    readonly materialization: CoreRenderMaterializationView;
    readonly targetRootPath: string;
    readonly platformContext: PlatformContext;
    readonly sourceSnapshot?: ImportSourceSnapshotV1;
}): AssetUsageTargetObservation {
    return observeAssetUsageTargetWithDependencies(input, DEFAULT_OBSERVATION_DEPENDENCIES);
}

/** @internal Async production owner; selected-WSL stable reads leave the Host event loop without changing semantics. */
export async function observeAssetUsageTargetAsync(input: {
    readonly materialization: CoreRenderMaterializationView;
    readonly targetRootPath: string;
    readonly platformContext: PlatformContext;
    readonly sourceSnapshot?: ImportSourceSnapshotV1;
    readonly targetCheckSnapshot?: TargetCheckObservationSnapshot;
}): Promise<AssetUsageTargetObservation> {
    return observeAssetUsageTargetAsyncWithDependencies(input, {
        inventoryDirectory: inventoryDirectoryNoFollow,
        readRegularFile: (readInput) =>
            readPlatformContextRegularFileNoFollowBounded(readInput, MAXIMUM_SELECTED_WSL_OBSERVATION_MILLISECONDS),
    });
}

/** @internal Start exact target reads from a validated selection while its Provider materializer runs. */
export async function primeAssetUsageTargetFilesForCheck(input: {
    readonly relativePaths: readonly PosixRelativePath[];
    readonly targetRootPath: string;
    readonly platformContext: PlatformContext;
    readonly targetCheckSnapshot?: TargetCheckObservationSnapshot;
}): Promise<void> {
    return primeAssetUsageTargetFilesForCheckWithDependencies(input, {
        readRegularFile: (readInput) =>
            readPlatformContextRegularFileNoFollowBounded(readInput, MAXIMUM_SELECTED_WSL_OBSERVATION_MILLISECONDS),
    });
}

interface AssetUsageTargetObservationDependencies {
    readonly inventoryDirectory: typeof inventoryDirectoryNoFollow;
    readonly readRegularFile: typeof readPlatformContextRegularFileNoFollow;
}

interface AsyncAssetUsageTargetObservationDependencies {
    readonly inventoryDirectory: typeof inventoryDirectoryNoFollow;
    readonly readRegularFile: (
        input: Parameters<typeof readPlatformContextRegularFileNoFollow>[0],
    ) => Promise<StableRegularFileRead>;
}

interface AsyncAssetUsageTargetPrimeDependencies {
    readonly readRegularFile: AsyncAssetUsageTargetObservationDependencies["readRegularFile"];
}

interface ObservedExpectedFile {
    readonly present: boolean;
    readonly mismatch: boolean;
    readonly relation: AssetUsageTargetObservation["physicalRelation"];
}

const DEFAULT_OBSERVATION_DEPENDENCIES: AssetUsageTargetObservationDependencies = {
    inventoryDirectory: inventoryDirectoryNoFollow,
    readRegularFile: readPlatformContextRegularFileNoFollow,
};

function observeAssetUsageTargetWithDependencies(
    input: {
        readonly materialization: CoreRenderMaterializationView;
        readonly targetRootPath: string;
        readonly platformContext: PlatformContext;
        readonly sourceSnapshot?: ImportSourceSnapshotV1;
    },
    dependencies: AssetUsageTargetObservationDependencies,
): AssetUsageTargetObservation {
    try {
        const expectation = createAssetUsageTargetExpectation(input.materialization, input.sourceSnapshot);
        return observeExpectedTarget(
            expectation,
            input.targetRootPath,
            input.platformContext,
            (filePath) =>
                observedUsageFile(
                    dependencies.readRegularFile({
                        ...input.platformContext,
                        filePath,
                        maximumBytes: MAXIMUM_OBSERVED_FILE_BYTES,
                    }),
                ),
            dependencies.inventoryDirectory,
        );
    } catch (error) {
        return assetUsageTargetFailureObservation(error);
    }
}

async function observeAssetUsageTargetAsyncWithDependencies(
    input: {
        readonly materialization: CoreRenderMaterializationView;
        readonly targetRootPath: string;
        readonly platformContext: PlatformContext;
        readonly sourceSnapshot?: ImportSourceSnapshotV1;
        readonly targetCheckSnapshot?: TargetCheckObservationSnapshot;
    },
    dependencies: AsyncAssetUsageTargetObservationDependencies,
): Promise<AssetUsageTargetObservation> {
    try {
        const expectation = createAssetUsageTargetExpectation(input.materialization, input.sourceSnapshot);
        const files = expectation.files;
        if (files.length === 0) return unknown();
        const sourceFingerprints = new Set(expectation.sourceIdentityFingerprints);
        const observations = await Promise.all(
            files.map(async (file) => {
                const filePath = joinPhysicalAccessPath(input.targetRootPath, file.relativePath);
                try {
                    const current = await observeStableTargetFileForTargetCheckAsync(
                        {
                            platform: input.platformContext.platform,
                            platformInstanceId: input.platformContext.platformInstanceId,
                            accessRootPath: input.platformContext.accessRootPath,
                            filePath,
                            maximumBytes: MAXIMUM_OBSERVED_FILE_BYTES,
                        },
                        input.targetCheckSnapshot,
                        () =>
                            dependencies.readRegularFile({
                                ...input.platformContext,
                                filePath,
                                maximumBytes: MAXIMUM_OBSERVED_FILE_BYTES,
                            }),
                    );
                    return observeExpectedFile(observedUsageFile(current), file, input.platformContext, sourceFingerprints);
                } catch (error) {
                    if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
                        return absentExpectedFile();
                    }
                    throw error;
                }
            }),
        );
        return classifyObservedTarget(
            files.length,
            observations,
            expectation,
            input.targetRootPath,
            dependencies.inventoryDirectory,
        );
    } catch (error) {
        return assetUsageTargetFailureObservation(error);
    }
}

async function primeAssetUsageTargetFilesForCheckWithDependencies(
    input: {
        readonly relativePaths: readonly PosixRelativePath[];
        readonly targetRootPath: string;
        readonly platformContext: PlatformContext;
        readonly targetCheckSnapshot?: TargetCheckObservationSnapshot;
    },
    dependencies: AsyncAssetUsageTargetPrimeDependencies,
): Promise<void> {
    if (input.targetCheckSnapshot === undefined) return;
    const relativePaths = [...new Set(input.relativePaths)].sort(compareUtf8Bytes);
    await Promise.all(
        relativePaths.map(async (relativePath) => {
            const filePath = joinPhysicalAccessPath(input.targetRootPath, relativePath);
            try {
                await observeStableTargetFileForTargetCheckAsync(
                    {
                        platform: input.platformContext.platform,
                        platformInstanceId: input.platformContext.platformInstanceId,
                        accessRootPath: input.platformContext.accessRootPath,
                        filePath,
                        maximumBytes: MAXIMUM_OBSERVED_FILE_BYTES,
                    },
                    input.targetCheckSnapshot,
                    () =>
                        dependencies.readRegularFile({
                            ...input.platformContext,
                            filePath,
                            maximumBytes: MAXIMUM_OBSERVED_FILE_BYTES,
                        }),
                );
            } catch {
                // The exact typed failure is retained by the operation snapshot and classified after materialization.
            }
        }),
    );
}

function expectedFileBytes(file: CoreRenderMaterializationView["units"][number]["files"][number]): Uint8Array {
    const expectedBytes = file.content.contentKind === "text" ? new TextEncoder().encode(file.content.text) : file.content.bytes;
    if (expectedBytes.byteLength > MAXIMUM_OBSERVED_FILE_BYTES) {
        throw new ReadAccessFailure("resource_limit_exceeded", "asset usage target exceeds read bound");
    }
    return expectedBytes;
}

function observeExpectedFile(
    current: ObservedUsageFile,
    expected: AssetUsageTargetExpectation["files"][number],
    platformContext: PlatformContext,
    sourceFingerprints: ReadonlySet<string>,
): ObservedExpectedFile {
    return {
        present: true,
        mismatch:
            current.executable !== expected.executable ||
            current.byteSize !== expected.byteSize ||
            current.contentHash !== expected.contentHash,
        relation: sourcePhysicalRelation(current.identity, platformContext.platform, sourceFingerprints),
    };
}

function absentExpectedFile(): ObservedExpectedFile {
    return { present: false, mismatch: false, relation: "distinct_or_not_imported" };
}

function classifyObservedTarget(
    expectedFileCount: number,
    observations: readonly ObservedExpectedFile[],
    expectation: AssetUsageTargetExpectation,
    targetRootPath: string,
    inventoryDirectory: typeof inventoryDirectoryNoFollow,
): AssetUsageTargetObservation {
    const presentCount = observations.filter((observation) => observation.present).length;
    let mismatch = observations.some((observation) => observation.mismatch);
    const sameContextSource = observations.some((observation) => observation.relation === "same_context_source");
    const crossContextSource = observations.some((observation) => observation.relation === "cross_context_unverified");
    const directoryState = compareManagedDirectoryGraphs(expectation, targetRootPath, inventoryDirectory);
    if (directoryState === "unknown") return unknown();
    mismatch ||= directoryState === "different";
    if (presentCount === 0 && directoryState !== "different") {
        return { observedTargetState: "absent", physicalRelation: "distinct_or_not_imported" };
    }
    if (presentCount !== expectedFileCount || mismatch) {
        return {
            observedTargetState: "different",
            physicalRelation: crossContextSource
                ? "cross_context_unverified"
                : sameContextSource
                  ? "same_context_source"
                  : "distinct_or_not_imported",
        };
    }
    if (crossContextSource && !sameContextSource) {
        return { observedTargetState: "unknown", physicalRelation: "cross_context_unverified" };
    }
    return {
        observedTargetState: "already_usable",
        physicalRelation: sameContextSource ? "same_context_source" : "distinct_or_not_imported",
    };
}

function flattenExpectedFiles(materialization: CoreRenderMaterializationView) {
    const byPath = new Map<string, CoreRenderMaterializationView["units"][number]["files"][number]>();
    for (const file of materialization.units.flatMap((unit) => unit.files)) {
        if (byPath.has(file.relativePath)) throw new Error("asset usage materialization repeats one target path");
        byPath.set(file.relativePath, file);
    }
    return [...byPath.values()].sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
}

function compareManagedDirectoryGraphs(
    expectation: AssetUsageTargetExpectation,
    targetRootPath: string,
    inventoryDirectory: typeof inventoryDirectoryNoFollow,
): "same" | "different" | "unknown" {
    const files = expectation.files;
    const boundaries = expectation.directoryBoundaries;
    const seen = new Set<string>();
    for (const boundary of boundaries) {
        if (seen.has(boundary.relativePath)) return "unknown";
        seen.add(boundary.relativePath);
        const expected = expectedDirectoryGraph(
            files.map((file) => file.relativePath),
            boundary,
        );
        const actual = inventoryDirectoryGraph(targetRootPath, boundary.relativePath, inventoryDirectory);
        if (actual === null) continue;
        if (actual.size !== expected.size || [...expected].some((entry) => !actual.has(entry))) {
            return "different";
        }
    }
    return "same";
}

function expectedDirectoryGraph(
    paths: readonly PosixRelativePath[],
    boundary: AssetUsageTargetExpectation["directoryBoundaries"][number],
): Set<string> {
    const expected = new Set<string>();
    for (const relativePath of desiredDirectoryPathsForBoundaries([boundary], paths)) {
        if (relativePath === boundary.relativePath) continue;
        expected.add(`${relativePath.slice(boundary.relativePath.length + 1)}\0directory`);
    }
    for (const relativePath of paths.filter((candidate) => candidate.startsWith(`${boundary.relativePath}/`))) {
        expected.add(`${relativePath.slice(boundary.relativePath.length + 1)}\0file`);
    }
    return expected;
}

function inventoryDirectoryGraph(
    targetRootPath: string,
    boundary: PosixRelativePath,
    inventoryDirectory: typeof inventoryDirectoryNoFollow,
): Set<string> | null {
    const root = joinPhysicalAccessPath(targetRootPath, boundary);
    let remaining = MAXIMUM_OBSERVED_DIRECTORY_ENTRIES;
    const output = new Set<string>();
    const visit = (directoryPath: string, prefix: string, allowMissing: boolean): boolean => {
        let before: StableDirectoryInventory;
        try {
            before = inventoryDirectory(directoryPath, remaining);
        } catch (error) {
            if (allowMissing && error instanceof SafeFilesystemError && error.failureKind === "not_found") return false;
            throw error;
        }
        for (const entry of before.entries) {
            remaining -= 1;
            const relative = prefix === "" ? entry.relativeName : `${prefix}/${entry.relativeName}`;
            output.add(`${relative}\0${entry.identity.entryKind}`);
            if (entry.identity.entryKind === "directory") {
                visit(joinPhysicalAccessPath(directoryPath, entry.relativeName), relative, false);
            }
        }
        const after = inventoryDirectory(directoryPath, before.entries.length);
        if (!sameInventory(before, after))
            throw new ReadAccessFailure("stale", "asset usage directory changed during observation");
        return true;
    };
    return visit(root, "", true) ? output : null;
}

function sameInventory(left: StableDirectoryInventory, right: StableDirectoryInventory): boolean {
    return (
        samePhysicalPathIdentity(left.identity, right.identity) &&
        left.entries.length === right.entries.length &&
        left.entries.every((entry, index) => {
            const candidate = right.entries[index];
            return (
                candidate !== undefined &&
                entry.relativeName === candidate.relativeName &&
                samePhysicalPathIdentity(entry.identity, candidate.identity)
            );
        })
    );
}

function sourcePhysicalRelation(
    identity: PhysicalPathIdentity,
    targetPlatform: Platform,
    sourceFingerprints: ReadonlySet<string>,
): AssetUsageTargetObservation["physicalRelation"] {
    if (sourceFingerprints.has(physicalIdentityFingerprint(targetPlatform, identity))) return "same_context_source";
    if (
        PLATFORM_IDENTITIES.some(
            (platform) => platform !== targetPlatform && sourceFingerprints.has(physicalIdentityFingerprint(platform, identity)),
        )
    ) {
        return "cross_context_unverified";
    }
    return "distinct_or_not_imported";
}

function unknown(): AssetUsageTargetObservation {
    return { observedTargetState: "unknown", physicalRelation: "distinct_or_not_imported" };
}

export const assetUsageTargetObservationInternalsForTest = {
    observeWithDependencies: observeAssetUsageTargetWithDependencies,
    observeAsyncWithDependencies: observeAssetUsageTargetAsyncWithDependencies,
    primeAsyncWithDependencies: primeAssetUsageTargetFilesForCheckWithDependencies,
};
