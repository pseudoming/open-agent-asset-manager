import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type DesktopAssetLayoutPreference, parseStoredDesktopPreferences } from "../presentation/presentation-preferences";

export interface PackagedAssetUsageAuthorityManifestEntry {
    readonly relativePath: string;
    readonly kind: "directory" | "file";
    readonly size: number | null;
    readonly sha256: string | null;
}

export interface PackagedAssetUsageDesktopPreferencesSnapshot {
    readonly schemaVersion: number;
    readonly onboardingCompleted: boolean;
    readonly lastSelectedProjectId: string | null;
    readonly assetLayout: DesktopAssetLayoutPreference;
}

export interface PackagedAssetUsageAuthoritySnapshot {
    readonly businessAuthorityEntryCount: number;
    readonly businessAuthorityTreeFingerprint: string;
    readonly businessAuthorityManifest: readonly PackagedAssetUsageAuthorityManifestEntry[];
    readonly observabilityEntryCount: number;
    readonly observabilityTreeFingerprint: string;
    readonly observabilityManifest: readonly PackagedAssetUsageAuthorityManifestEntry[];
    readonly desktopPreferencesFingerprint: string;
    readonly desktopPreferences: PackagedAssetUsageDesktopPreferencesSnapshot;
    readonly coordinationPaths: readonly string[];
}

export interface PackagedAssetUsagePhysicalFileIdentity {
    readonly dev: string;
    readonly ino: string;
}

export interface PackagedAssetUsageObservabilityDurableReplacement {
    readonly relativePath: string;
    readonly beforeSize: number;
    readonly afterSize: number;
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly growthBytes: number;
    readonly growthSha256: string | null;
    readonly segmentPathMatched: boolean;
    readonly physicalIdentityTransition: {
        readonly before: PackagedAssetUsagePhysicalFileIdentity;
        readonly after: PackagedAssetUsagePhysicalFileIdentity;
        readonly changed: boolean;
    } | null;
    readonly prefixMatched: boolean;
    readonly beforeNewlineTerminated: boolean;
    readonly newlineTerminated: boolean;
    readonly jsonLineCount: number;
    readonly jsonLinesParseable: boolean;
}

interface ManifestDelta {
    readonly fingerprintChanged: boolean;
    readonly added: readonly PackagedAssetUsageAuthorityManifestEntry[];
    readonly removed: readonly PackagedAssetUsageAuthorityManifestEntry[];
    readonly changed: readonly {
        readonly relativePath: string;
        readonly before: PackagedAssetUsageAuthorityManifestEntry;
        readonly after: PackagedAssetUsageAuthorityManifestEntry;
    }[];
}

export interface PackagedAssetUsageAuthorityDelta {
    readonly authorityChanged: boolean;
    readonly businessAuthorityChanged: boolean;
    readonly preferencesChanged: boolean;
    readonly coordinationChanged: boolean;
    readonly observabilityChanged: boolean;
    readonly businessAuthority: ManifestDelta;
    readonly preferences: {
        readonly fingerprintChanged: boolean;
        readonly changedFields: readonly string[];
    };
    readonly coordination: {
        readonly added: readonly string[];
        readonly removed: readonly string[];
    };
    readonly observability: ManifestDelta & {
        readonly validDurableReplacementGrowth: boolean;
        readonly durableReplacement: PackagedAssetUsageObservabilityDurableReplacement | null;
    };
}

export interface PackagedAssetUsageAuthorityChangeReceipt {
    readonly schemaVersion: 2;
    readonly before: PackagedAssetUsageAuthoritySnapshot;
    readonly after: PackagedAssetUsageAuthoritySnapshot;
    readonly delta: PackagedAssetUsageAuthorityDelta;
}

type ManifestEntryWithBytes = PackagedAssetUsageAuthorityManifestEntry & { readonly bytes?: Buffer };

interface ObservedObservabilityFile {
    readonly bytes: Buffer;
    readonly physicalIdentity: PackagedAssetUsagePhysicalFileIdentity;
}

const observabilityFiles = new WeakMap<PackagedAssetUsageAuthoritySnapshot, ReadonlyMap<string, ObservedObservabilityFile>>();
const EMPTY_TREE_FINGERPRINT = crypto.createHash("sha256").digest("hex");
const LOGS_DIRECTORY = "logs";
const ORDINARY_LOG_DIRECTORY = "logs/ordinary";
const ORDINARY_LOG_PREFIX = `${ORDINARY_LOG_DIRECTORY}/ordinary-`;
const ORDINARY_LOG_SUFFIX = ".jsonl";
const ORDINARY_LOG_PUBLISH_TEMPORARY = /^logs\/ordinary\/\.oaam-publish-[0-9a-f]{32}$/u;
const SQLITE_SHARED_MEMORY_PATH = "oaam.sqlite-shm";
const SQLITE_WRITE_AHEAD_LOG_PATH = "oaam.sqlite-wal";
const AUTHORITY_LOCK_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const AUTHORITY_LOCK_ROOT = "transactions/authority-locks";
const PHYSICAL_PATH_LOCK_ROOT = "transactions/locks";
const PHYSICAL_PATH_LOCK_FILE = /^[0-9a-f]{64}\.lock$/u;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertManifestEntry(value: unknown): asserts value is PackagedAssetUsageAuthorityManifestEntry {
    if (
        !exactRecord(value, ["kind", "relativePath", "sha256", "size"]) ||
        typeof value.relativePath !== "string" ||
        value.relativePath.length === 0 ||
        value.relativePath.includes("\\") ||
        value.relativePath.includes("\0") ||
        path.posix.isAbsolute(value.relativePath) ||
        path.posix.normalize(value.relativePath) !== value.relativePath ||
        value.relativePath === "." ||
        value.relativePath.startsWith("../") ||
        (value.kind !== "directory" && value.kind !== "file") ||
        (value.kind === "directory" && (value.size !== null || value.sha256 !== null)) ||
        (value.kind === "file" &&
            (!Number.isSafeInteger(value.size) ||
                (value.size as number) < 0 ||
                typeof value.sha256 !== "string" ||
                !/^[0-9a-f]{64}$/u.test(value.sha256)))
    ) {
        throw new TypeError("invalid packaged Asset-usage authority manifest entry");
    }
}

type AuthorityObservationInstability = "ordinary_publish_disappeared" | "ordinary_publish_changed";

class PackagedAssetUsageAuthorityObservationUnstableError extends Error {
    readonly observation: AuthorityObservationInstability;

    constructor(observation: AuthorityObservationInstability) {
        super(`packaged Asset-usage authority observation is temporarily non-comparable: ${observation}`);
        this.name = "PackagedAssetUsageAuthorityObservationUnstableError";
        this.observation = observation;
    }
}

function isErrno(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function isOrdinaryLogPublishTemporary(relativePath: string): boolean {
    return ORDINARY_LOG_PUBLISH_TEMPORARY.test(relativePath);
}

function isObservabilityEntry(relativePath: string, kind: "directory" | "file"): boolean {
    if (kind === "directory") return relativePath === LOGS_DIRECTORY || relativePath === ORDINARY_LOG_DIRECTORY;
    if (!relativePath.startsWith(`${ORDINARY_LOG_DIRECTORY}/`)) return false;
    return !relativePath.slice(ORDINARY_LOG_DIRECTORY.length + 1).includes("/");
}

function isAuthorityLockCoordinationEntry(relativePath: string, kind: "directory" | "file"): boolean {
    if (relativePath === "transactions" || relativePath === AUTHORITY_LOCK_ROOT) return kind === "directory";
    if (!relativePath.startsWith(`${AUTHORITY_LOCK_ROOT}/`)) return false;
    const components = relativePath.slice(AUTHORITY_LOCK_ROOT.length + 1).split("/");
    if (components.length === 1) return kind === "directory" && AUTHORITY_LOCK_COMPONENT.test(components[0] ?? "");
    if (components.length !== 2 || kind !== "file") return false;
    const [namespace, lockFileName] = components;
    return (
        AUTHORITY_LOCK_COMPONENT.test(namespace ?? "") &&
        typeof lockFileName === "string" &&
        lockFileName.endsWith(".lock") &&
        AUTHORITY_LOCK_COMPONENT.test(lockFileName.slice(0, -".lock".length))
    );
}

function isPhysicalPathLockCoordinationEntry(relativePath: string, kind: "directory" | "file"): boolean {
    if (relativePath === PHYSICAL_PATH_LOCK_ROOT) return kind === "directory";
    if (!relativePath.startsWith(`${PHYSICAL_PATH_LOCK_ROOT}/`) || kind !== "file") return false;
    return PHYSICAL_PATH_LOCK_FILE.test(relativePath.slice(PHYSICAL_PATH_LOCK_ROOT.length + 1));
}

function isCoordinationEntry(relativePath: string, kind: "directory" | "file", size: number | null): boolean {
    return (
        (relativePath === SQLITE_SHARED_MEMORY_PATH && kind === "file") ||
        (relativePath === SQLITE_WRITE_AHEAD_LOG_PATH && kind === "file" && size === 0) ||
        isAuthorityLockCoordinationEntry(relativePath, kind) ||
        isPhysicalPathLockCoordinationEntry(relativePath, kind)
    );
}

function isCoordinationPath(relativePath: string): boolean {
    return (
        relativePath === SQLITE_SHARED_MEMORY_PATH ||
        relativePath === SQLITE_WRITE_AHEAD_LOG_PATH ||
        isAuthorityLockCoordinationEntry(relativePath, "directory") ||
        isAuthorityLockCoordinationEntry(relativePath, "file") ||
        isPhysicalPathLockCoordinationEntry(relativePath, "directory") ||
        isPhysicalPathLockCoordinationEntry(relativePath, "file")
    );
}

function isOwnedOrdinaryLogSegment(relativePath: string): boolean {
    if (!relativePath.startsWith(ORDINARY_LOG_PREFIX) || !relativePath.endsWith(ORDINARY_LOG_SUFFIX)) return false;
    const identity = relativePath.slice(ORDINARY_LOG_PREFIX.length, -ORDINARY_LOG_SUFFIX.length);
    const separator = identity.indexOf("-");
    if (separator <= 0 || identity.indexOf("-", separator + 1) !== -1) return false;
    const occurredAtText = identity.slice(0, separator);
    const segmentId = identity.slice(separator + 1);
    const occurredAt = Number(occurredAtText);
    return (
        Number.isSafeInteger(occurredAt) &&
        occurredAt >= 0 &&
        String(occurredAt) === occurredAtText &&
        /^[0-9a-f]{32}$/u.test(segmentId)
    );
}

function assertOrderedManifest(
    manifest: readonly PackagedAssetUsageAuthorityManifestEntry[],
    expectedEntryCount: number,
    kind: "business" | "observability",
): void {
    if (manifest.length !== expectedEntryCount) throw new TypeError("invalid packaged Asset-usage authority snapshot");
    const paths = manifest.map((entry) => {
        assertManifestEntry(entry);
        const isObservability = isObservabilityEntry(entry.relativePath, entry.kind);
        if (
            (kind === "business" && (isObservability || isCoordinationEntry(entry.relativePath, entry.kind, entry.size))) ||
            (kind === "observability" && !isObservability)
        ) {
            throw new TypeError("invalid packaged Asset-usage authority manifest classification");
        }
        return entry.relativePath;
    });
    if (
        paths.some((entry, index) => index > 0 && entry.localeCompare(paths[index - 1] ?? "") <= 0) ||
        new Set(paths).size !== paths.length
    ) {
        throw new TypeError("invalid packaged Asset-usage authority manifest order");
    }
}

export function assertPackagedAssetUsageAuthoritySnapshot(value: PackagedAssetUsageAuthoritySnapshot): void {
    if (
        !exactRecord(value, [
            "businessAuthorityEntryCount",
            "businessAuthorityManifest",
            "businessAuthorityTreeFingerprint",
            "coordinationPaths",
            "desktopPreferences",
            "desktopPreferencesFingerprint",
            "observabilityEntryCount",
            "observabilityManifest",
            "observabilityTreeFingerprint",
        ]) ||
        !Number.isSafeInteger(value.businessAuthorityEntryCount) ||
        value.businessAuthorityEntryCount < 1 ||
        !/^[0-9a-f]{64}$/u.test(value.businessAuthorityTreeFingerprint) ||
        !Array.isArray(value.businessAuthorityManifest) ||
        !Number.isSafeInteger(value.observabilityEntryCount) ||
        value.observabilityEntryCount < 0 ||
        !/^[0-9a-f]{64}$/u.test(value.observabilityTreeFingerprint) ||
        !Array.isArray(value.observabilityManifest) ||
        !/^[0-9a-f]{64}$/u.test(value.desktopPreferencesFingerprint) ||
        !exactRecord(value.desktopPreferences, [
            "assetLayout",
            "lastSelectedProjectId",
            "onboardingCompleted",
            "schemaVersion",
        ]) ||
        value.desktopPreferences.schemaVersion !== 4 ||
        typeof value.desktopPreferences.onboardingCompleted !== "boolean" ||
        (value.desktopPreferences.lastSelectedProjectId !== null &&
            (typeof value.desktopPreferences.lastSelectedProjectId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                    value.desktopPreferences.lastSelectedProjectId,
                ))) ||
        (value.desktopPreferences.assetLayout !== "list" && value.desktopPreferences.assetLayout !== "cards") ||
        !Array.isArray(value.coordinationPaths) ||
        value.coordinationPaths.some((entry) => typeof entry !== "string" || !isCoordinationPath(entry)) ||
        value.coordinationPaths.some(
            (entry, index) => index > 0 && entry.localeCompare(value.coordinationPaths[index - 1] ?? "") <= 0,
        ) ||
        new Set(value.coordinationPaths).size !== value.coordinationPaths.length
    ) {
        throw new TypeError("invalid packaged Asset-usage authority snapshot");
    }
    assertOrderedManifest(value.businessAuthorityManifest, value.businessAuthorityEntryCount, "business");
    assertOrderedManifest(value.observabilityManifest, value.observabilityEntryCount, "observability");
}

function snapshotEquals(left: PackagedAssetUsageAuthoritySnapshot, right: PackagedAssetUsageAuthoritySnapshot): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function isPackagedAssetUsageObservabilitySnapshotComparable(snapshot: PackagedAssetUsageAuthoritySnapshot): boolean {
    assertPackagedAssetUsageAuthoritySnapshot(snapshot);
    const files = snapshot.observabilityManifest.filter((entry) => entry.kind === "file");
    const observed = observabilityFiles.get(snapshot);
    return files.every((entry) => {
        const bytes = observed?.get(entry.relativePath)?.bytes;
        return (
            isOwnedOrdinaryLogSegment(entry.relativePath) && bytes !== undefined && bytes.byteLength > 0 && bytes.at(-1) === 0x0a
        );
    });
}

function manifestDelta(
    beforeManifest: readonly PackagedAssetUsageAuthorityManifestEntry[],
    afterManifest: readonly PackagedAssetUsageAuthorityManifestEntry[],
    fingerprintChanged: boolean,
): ManifestDelta {
    const beforeEntries = new Map(beforeManifest.map((entry) => [entry.relativePath, entry]));
    const afterEntries = new Map(afterManifest.map((entry) => [entry.relativePath, entry]));
    const added = afterManifest.filter((entry) => !beforeEntries.has(entry.relativePath));
    const removed = beforeManifest.filter((entry) => !afterEntries.has(entry.relativePath));
    const changed = beforeManifest.flatMap((entry) => {
        const next = afterEntries.get(entry.relativePath);
        return next === undefined || JSON.stringify(entry) === JSON.stringify(next)
            ? []
            : [{ relativePath: entry.relativePath, before: entry, after: next }];
    });
    return Object.freeze({
        fingerprintChanged,
        added: Object.freeze([...added]),
        removed: Object.freeze([...removed]),
        changed: Object.freeze(changed.map((entry) => Object.freeze(entry))),
    });
}

function inspectObservabilityDurableReplacement(
    before: PackagedAssetUsageAuthoritySnapshot,
    after: PackagedAssetUsageAuthoritySnapshot,
    delta: ManifestDelta,
): {
    readonly validDurableReplacementGrowth: boolean;
    readonly durableReplacement: PackagedAssetUsageObservabilityDurableReplacement | null;
} {
    if (delta.added.length !== 0 || delta.removed.length !== 0 || delta.changed.length !== 1) {
        return Object.freeze({ validDurableReplacementGrowth: false, durableReplacement: null });
    }
    const changed = delta.changed[0];
    if (changed === undefined || changed.before.kind !== "file" || changed.after.kind !== "file") {
        return Object.freeze({ validDurableReplacementGrowth: false, durableReplacement: null });
    }
    const beforeSize = changed.before.size ?? -1;
    const afterSize = changed.after.size ?? -1;
    const beforeSha256 = changed.before.sha256 ?? "";
    const afterSha256 = changed.after.sha256 ?? "";
    const beforeFile = observabilityFiles.get(before)?.get(changed.relativePath);
    const afterFile = observabilityFiles.get(after)?.get(changed.relativePath);
    const beforeBytes = beforeFile?.bytes;
    const afterBytes = afterFile?.bytes;
    const hasExactBytes = beforeBytes !== undefined && afterBytes !== undefined;
    const physicalIdentityTransition =
        beforeFile === undefined || afterFile === undefined
            ? null
            : Object.freeze({
                  before: beforeFile.physicalIdentity,
                  after: afterFile.physicalIdentity,
                  changed:
                      beforeFile.physicalIdentity.dev !== afterFile.physicalIdentity.dev ||
                      beforeFile.physicalIdentity.ino !== afterFile.physicalIdentity.ino,
              });
    const prefixMatched =
        hasExactBytes &&
        beforeBytes.byteLength < afterBytes.byteLength &&
        beforeBytes.equals(afterBytes.subarray(0, beforeBytes.byteLength));
    const growth =
        hasExactBytes && afterBytes.byteLength >= beforeBytes.byteLength
            ? afterBytes.subarray(beforeBytes.byteLength)
            : undefined;
    const beforeNewlineTerminated = beforeBytes !== undefined && beforeBytes.byteLength > 0 && beforeBytes.at(-1) === 0x0a;
    let newlineTerminated = false;
    let jsonLineCount = 0;
    let jsonLinesParseable = false;
    if (growth !== undefined && growth.byteLength > 0) {
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(growth);
            newlineTerminated = text.endsWith("\n");
            const lines = newlineTerminated ? text.slice(0, -1).split("\n") : [];
            jsonLineCount = lines.length;
            jsonLinesParseable =
                lines.length > 0 &&
                lines.every((line) => {
                    if (line.length === 0) return false;
                    try {
                        JSON.parse(line);
                        return true;
                    } catch {
                        return false;
                    }
                });
        } catch {
            // The structured receipt below preserves the exact failed UTF-8/JSONL verdict.
        }
    }
    const segmentPathMatched = isOwnedOrdinaryLogSegment(changed.relativePath);
    const growthBytes = afterSize - beforeSize;
    const durableReplacement = Object.freeze({
        relativePath: changed.relativePath,
        beforeSize,
        afterSize,
        beforeSha256,
        afterSha256,
        growthBytes,
        growthSha256: growth === undefined ? null : crypto.createHash("sha256").update(growth).digest("hex"),
        segmentPathMatched,
        physicalIdentityTransition,
        prefixMatched,
        beforeNewlineTerminated,
        newlineTerminated,
        jsonLineCount,
        jsonLinesParseable,
    });
    return Object.freeze({
        validDurableReplacementGrowth:
            segmentPathMatched &&
            hasExactBytes &&
            physicalIdentityTransition?.changed === true &&
            beforeSize === beforeBytes.byteLength &&
            afterSize === afterBytes.byteLength &&
            growthBytes > 0 &&
            prefixMatched &&
            beforeNewlineTerminated &&
            newlineTerminated &&
            jsonLinesParseable,
        durableReplacement,
    });
}

export function diffPackagedAssetUsageAuthority(
    before: PackagedAssetUsageAuthoritySnapshot,
    after: PackagedAssetUsageAuthoritySnapshot,
): PackagedAssetUsageAuthorityDelta {
    assertPackagedAssetUsageAuthoritySnapshot(before);
    assertPackagedAssetUsageAuthoritySnapshot(after);
    const businessAuthority = manifestDelta(
        before.businessAuthorityManifest,
        after.businessAuthorityManifest,
        before.businessAuthorityTreeFingerprint !== after.businessAuthorityTreeFingerprint,
    );
    const businessAuthorityChanged =
        before.businessAuthorityEntryCount !== after.businessAuthorityEntryCount ||
        businessAuthority.fingerprintChanged ||
        businessAuthority.added.length > 0 ||
        businessAuthority.removed.length > 0 ||
        businessAuthority.changed.length > 0;
    const observabilityBase = manifestDelta(
        before.observabilityManifest,
        after.observabilityManifest,
        before.observabilityTreeFingerprint !== after.observabilityTreeFingerprint,
    );
    const observabilityChanged =
        before.observabilityEntryCount !== after.observabilityEntryCount ||
        observabilityBase.fingerprintChanged ||
        observabilityBase.added.length > 0 ||
        observabilityBase.removed.length > 0 ||
        observabilityBase.changed.length > 0;
    const observabilityDurableReplacement = observabilityChanged
        ? inspectObservabilityDurableReplacement(before, after, observabilityBase)
        : Object.freeze({ validDurableReplacementGrowth: false, durableReplacement: null });
    const preferenceFields = ["schemaVersion", "onboardingCompleted", "lastSelectedProjectId", "assetLayout"] as const;
    const changedPreferenceFields = preferenceFields.filter(
        (field) => before.desktopPreferences[field] !== after.desktopPreferences[field],
    );
    const preferencesFingerprintChanged = before.desktopPreferencesFingerprint !== after.desktopPreferencesFingerprint;
    const preferencesChanged = preferencesFingerprintChanged || changedPreferenceFields.length > 0;
    const beforeCoordination = new Set(before.coordinationPaths);
    const afterCoordination = new Set(after.coordinationPaths);
    const coordinationAdded = after.coordinationPaths.filter((entry) => !beforeCoordination.has(entry));
    const coordinationRemoved = before.coordinationPaths.filter((entry) => !afterCoordination.has(entry));
    const coordinationChanged = coordinationAdded.length > 0 || coordinationRemoved.length > 0;
    return Object.freeze({
        authorityChanged: businessAuthorityChanged || preferencesChanged,
        businessAuthorityChanged,
        preferencesChanged,
        coordinationChanged,
        observabilityChanged,
        businessAuthority,
        preferences: Object.freeze({
            fingerprintChanged: preferencesFingerprintChanged,
            changedFields: Object.freeze([...changedPreferenceFields]),
        }),
        coordination: Object.freeze({
            added: Object.freeze([...coordinationAdded]),
            removed: Object.freeze([...coordinationRemoved]),
        }),
        observability: Object.freeze({
            ...observabilityBase,
            validDurableReplacementGrowth: observabilityDurableReplacement.validDurableReplacementGrowth,
            durableReplacement: observabilityDurableReplacement.durableReplacement,
        }),
    });
}

export async function waitForPackagedAssetUsageAuthorityQuiescence(
    readSnapshot: () => PackagedAssetUsageAuthoritySnapshot,
    expectedProjectId: string,
    options: { readonly deadlineMilliseconds?: number; readonly pollIntervalMilliseconds?: number } = {},
): Promise<PackagedAssetUsageAuthoritySnapshot> {
    const deadlineMilliseconds = options.deadlineMilliseconds ?? 10_000;
    const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 25;
    if (
        !Number.isSafeInteger(deadlineMilliseconds) ||
        deadlineMilliseconds < 1 ||
        deadlineMilliseconds > 30_000 ||
        !Number.isSafeInteger(pollIntervalMilliseconds) ||
        pollIntervalMilliseconds < 1 ||
        pollIntervalMilliseconds > deadlineMilliseconds
    ) {
        throw new TypeError("invalid packaged Asset-usage authority quiescence bounds");
    }
    const deadline = Date.now() + deadlineMilliseconds;
    let previous: PackagedAssetUsageAuthoritySnapshot | undefined;
    let latest: PackagedAssetUsageAuthoritySnapshot | undefined;
    let lastObservation: AuthorityObservationInstability | "observability_non_comparable" | undefined;
    for (;;) {
        try {
            latest = readSnapshot();
            assertPackagedAssetUsageAuthoritySnapshot(latest);
            if (!isPackagedAssetUsageObservabilitySnapshotComparable(latest)) {
                lastObservation = "observability_non_comparable";
                previous = undefined;
            } else if (latest.desktopPreferences.lastSelectedProjectId === expectedProjectId) {
                if (previous !== undefined && snapshotEquals(previous, latest)) return latest;
                previous = latest;
                lastObservation = undefined;
            } else {
                previous = undefined;
                lastObservation = undefined;
            }
        } catch (error) {
            if (!(error instanceof PackagedAssetUsageAuthorityObservationUnstableError)) throw error;
            previous = undefined;
            lastObservation = error.observation;
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `timed out waiting for the exact Project preference and stable authority: ${JSON.stringify({
                    expectedProjectId,
                    lastObservation,
                    latest,
                })}`,
            );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
    }
}

export function assertPackagedAssetUsageAuthorityUnchanged(
    before: PackagedAssetUsageAuthoritySnapshot,
    after: PackagedAssetUsageAuthoritySnapshot,
    recordAuthorityChange: (receipt: PackagedAssetUsageAuthorityChangeReceipt) => void,
): PackagedAssetUsageAuthorityDelta {
    const delta = diffPackagedAssetUsageAuthority(before, after);
    if (delta.authorityChanged || (delta.observabilityChanged && !delta.observability.validDurableReplacementGrowth)) {
        const receipt = Object.freeze({ schemaVersion: 2 as const, before, after, delta });
        recordAuthorityChange(receipt);
        throw new Error(
            `the read-only Asset-usage check changed business authority or emitted an invalid observability delta: ${JSON.stringify(receipt)}`,
        );
    }
    return delta;
}

function treeFingerprint(entries: readonly ManifestEntryWithBytes[]): string {
    const hash = crypto.createHash("sha256");
    for (const entry of entries) {
        hash.update(entry.kind === "directory" ? "D\0" : "F\0");
        hash.update(entry.relativePath);
        hash.update("\0");
        if (entry.bytes !== undefined) {
            hash.update(String(entry.bytes.byteLength));
            hash.update("\0");
            hash.update(entry.bytes);
        }
        hash.update("\0");
    }
    return hash.digest("hex");
}

export function snapshotPackagedAssetUsageAuthority(
    oaamStateRoot: string,
    desktopPreferencesBytes: Uint8Array,
): PackagedAssetUsageAuthoritySnapshot {
    const resolvedRoot = path.resolve(oaamStateRoot);
    const rootStat = fs.lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new TypeError("packaged Asset-usage authority root must be one direct directory");
    }
    const businessAuthorityEntries: ManifestEntryWithBytes[] = [];
    const observabilityEntries: ManifestEntryWithBytes[] = [];
    const observedObservabilityFiles = new Map<string, ObservedObservabilityFile>();
    const coordinationPaths: string[] = [];
    const visit = (directoryPath: string): void => {
        for (const entry of fs
            .readdirSync(directoryPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))) {
            const entryPath = path.join(directoryPath, entry.name);
            const relativePath = path.relative(resolvedRoot, entryPath).split(path.sep).join("/");
            const publishTemporary = isOrdinaryLogPublishTemporary(relativePath);
            let stat: fs.Stats;
            try {
                stat = fs.lstatSync(entryPath);
            } catch (error) {
                if (publishTemporary && isErrno(error, "ENOENT")) {
                    throw new PackagedAssetUsageAuthorityObservationUnstableError("ordinary_publish_disappeared");
                }
                throw error;
            }
            if (stat.isSymbolicLink()) throw new TypeError("packaged Asset-usage authority tree contains a symbolic link");
            if (entry.isDirectory() && stat.isDirectory()) {
                if (publishTemporary) {
                    throw new TypeError("packaged ordinary-log publish temporary is not a regular file");
                }
                if (isCoordinationEntry(relativePath, "directory", null)) coordinationPaths.push(relativePath);
                else {
                    const targetEntries = isObservabilityEntry(relativePath, "directory")
                        ? observabilityEntries
                        : businessAuthorityEntries;
                    targetEntries.push(Object.freeze({ relativePath, kind: "directory", size: null, sha256: null }));
                }
                visit(entryPath);
                continue;
            }
            if (!entry.isFile() || !stat.isFile()) {
                if (publishTemporary) {
                    throw new PackagedAssetUsageAuthorityObservationUnstableError("ordinary_publish_changed");
                }
                throw new TypeError("packaged Asset-usage authority tree contains a special filesystem entry");
            }
            if (isCoordinationEntry(relativePath, "file", stat.size)) {
                if (relativePath !== SQLITE_SHARED_MEMORY_PATH) {
                    const bytes = fs.readFileSync(entryPath);
                    const reopened = fs.lstatSync(entryPath);
                    if (
                        bytes.byteLength !== 0 ||
                        reopened.isSymbolicLink() ||
                        !reopened.isFile() ||
                        reopened.dev !== stat.dev ||
                        reopened.ino !== stat.ino ||
                        reopened.size !== stat.size ||
                        reopened.mtimeMs !== stat.mtimeMs
                    ) {
                        throw new Error("packaged authority lock anchor is non-empty or changed while being observed");
                    }
                }
                coordinationPaths.push(relativePath);
                continue;
            }
            let bytes: Buffer;
            let reopened: fs.Stats;
            try {
                bytes = fs.readFileSync(entryPath);
                reopened = fs.lstatSync(entryPath);
            } catch (error) {
                if (publishTemporary && isErrno(error, "ENOENT")) {
                    throw new PackagedAssetUsageAuthorityObservationUnstableError("ordinary_publish_disappeared");
                }
                throw error;
            }
            if (
                reopened.isSymbolicLink() ||
                !reopened.isFile() ||
                reopened.dev !== stat.dev ||
                reopened.ino !== stat.ino ||
                reopened.size !== stat.size ||
                reopened.mtimeMs !== stat.mtimeMs ||
                bytes.byteLength !== stat.size
            ) {
                if (publishTemporary && !reopened.isSymbolicLink()) {
                    throw new PackagedAssetUsageAuthorityObservationUnstableError("ordinary_publish_changed");
                }
                throw new Error("packaged Asset-usage authority changed while being observed");
            }
            const targetEntries = isObservabilityEntry(relativePath, "file") ? observabilityEntries : businessAuthorityEntries;
            targetEntries.push(
                Object.freeze({
                    relativePath,
                    kind: "file",
                    size: bytes.byteLength,
                    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
                    bytes,
                }),
            );
            if (isObservabilityEntry(relativePath, "file")) {
                observedObservabilityFiles.set(
                    relativePath,
                    Object.freeze({
                        bytes,
                        physicalIdentity: Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) }),
                    }),
                );
            }
        }
    };
    visit(resolvedRoot);
    businessAuthorityEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    observabilityEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    coordinationPaths.sort((left, right) => left.localeCompare(right));
    let desktopPreferences: ReturnType<typeof parseStoredDesktopPreferences>;
    try {
        desktopPreferences = parseStoredDesktopPreferences(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(desktopPreferencesBytes)) as unknown,
        );
    } catch (error) {
        throw new TypeError(
            `packaged Asset-usage Desktop preferences are invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const businessAuthorityManifest = businessAuthorityEntries.map(({ bytes: _bytes, ...entry }) => Object.freeze(entry));
    const observabilityManifest = observabilityEntries.map(({ bytes: _bytes, ...entry }) => Object.freeze(entry));
    const snapshot = Object.freeze({
        businessAuthorityEntryCount: businessAuthorityManifest.length,
        businessAuthorityTreeFingerprint:
            businessAuthorityEntries.length === 0 ? EMPTY_TREE_FINGERPRINT : treeFingerprint(businessAuthorityEntries),
        businessAuthorityManifest: Object.freeze(businessAuthorityManifest),
        observabilityEntryCount: observabilityManifest.length,
        observabilityTreeFingerprint:
            observabilityEntries.length === 0 ? EMPTY_TREE_FINGERPRINT : treeFingerprint(observabilityEntries),
        observabilityManifest: Object.freeze(observabilityManifest),
        desktopPreferencesFingerprint: crypto.createHash("sha256").update(desktopPreferencesBytes).digest("hex"),
        desktopPreferences: Object.freeze({
            schemaVersion: desktopPreferences.schemaVersion,
            onboardingCompleted: desktopPreferences.onboardingCompleted,
            lastSelectedProjectId: desktopPreferences.lastSelectedProjectId ?? null,
            assetLayout: desktopPreferences.assetLayout,
        }),
        coordinationPaths: Object.freeze(coordinationPaths),
    });
    observabilityFiles.set(snapshot, observedObservabilityFiles);
    return snapshot;
}
