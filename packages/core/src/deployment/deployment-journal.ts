/**
 * Active journal: short-lived recovery material for a single deploy transaction.
 *
 * Purpose (CORE_DATA_MODEL_DRAFT §8.9): the journal is published BEFORE any
 * runtime write and is the single source of truth for crash-recovery direction.
 * Commit proof (§8.10 l.1045-1049):
 *   journal.transactionId == Deployment.committedTransactionId → commit=yes
 *   otherwise (DB authoritative)                  → commit=no
 *   Deployment row missing / unreadable            → commit=unknown (stop)
 *
 * Reservation (§8.10 l.1385-1386): an unresolved journal (active/residual)
 * persists the exact sorted file/parent/managed-boundary physical lock closure
 * and holds it across process death until the journal is deleted. Writers scan
 * all active reservations while holding the same physical keys.
 * `deleteJournal` removes the publish marker (journal.json); if dir removal
 * fails the reservation still ends because the marker is gone.
 *
 * Fail-closed (H5): a corrupt or unreadable journal is reported as `null` by
 * readJournal; the caller (recovery) treats null as commit=unknown and blocks
 * rather than guessing.
 *
 * Scope (this module ONLY):
 *   - ActiveJournal / JournalEntry types
 *   - publishJournal (atomic write of journal.json)
 *   - readJournal (with shape guard → null on corruption)
 *   - deleteJournal (remove marker + best-effort dir cleanup)
 *   - scanJournals (matching vs corrupt split, freeze gate + recovery trigger)
 *   - findRecoverableJournals / hasRecoverableJournal (recoverable-only convenience)
 *
 * Out of scope: SQL, OS locks, runtime file contents, recovery decisions,
 * the CAS anchor semantics of `oldHash`/`newHash` (those are the caller's
 * responsibility — this module only stores/loads opaque bytes).
 */

import * as path from "node:path";
import { isCanonicalPhysicalAccessPath, splitPhysicalAccessPath } from "@oaam/shared/paths";
import {
    DurableFilesystemMutationError,
    type PhysicalPathIdentity,
    SafeFilesystemError,
    durableEnsureDirectory,
    durableRemoveDirectoryTree,
    durableRemoveRegularFile,
    durableReplaceFile,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import {
    isDirectoryIdentityOrNull,
    isValidJournalDirectoryEntries,
    isValidManagedDirectoryBoundaries,
} from "./deployment-journal-directory-validation";
import { isSelectedWslJournalExecution, type SelectedWslJournalExecution } from "./deployment-journal-execution";
import { isValidPublications, type JournalPublication } from "./deployment-publication-model";

// ============================================================
// Journal shape
// ============================================================

/**
 * One active journal per transaction, persisted at
 * `<transactionsRoot>/<txnId>/journal.json`.
 *
 * `entries[]` carries full old/new recovery material per target path.
 *
 * ABSENCE MARKER: `oldHash === ""` (and `newHash === ""` for removal targets)
 * is the authoritative "file did not exist" signal. `oldBytesBase64` / `
 * newBytesBase64` are the byte snapshots; they are "" BOTH when the file did
 * not exist AND when the file exists but is zero-byte — so they must NEVER be
 * used to test for absence. The bytes are stored verbatim (base64) so
 * restore-to-old / converge-to-new can run without depending on payload-store
 * availability, and a zero-byte old file restores as an empty file (not a delete).
 */
interface ActiveJournalBase {
    transactionId: string;
    deploymentId: string;
    createdAt: number;
    /** Compilation whose exact output/provenance this transaction applies. */
    compilationFingerprint: string;
    /** Exact sorted physical lock closure retained as the unresolved path reservation. */
    reservedPhysicalKeys: string[];
    /** Per-target recovery material. Order is the journal publish order. */
    entries: JournalEntry[];
}

export interface ActiveJournalV1 extends ActiveJournalBase {
    schemaVersion: 1;
}

export interface ActiveJournalV2 extends ActiveJournalBase {
    schemaVersion: 2;
    managedDirectoryBoundaries: string[];
    /** Runtime parent directories required by new file claims. Missing pre-state
     *  entries acquire `createdIdentity` only after a durable ensure succeeds. */
    directoryEntries: JournalDirectoryEntry[];
}

/** Same Windows reservation/commit owner, with explicitly Linux-observed target identities. */
export interface ActiveJournalV3 extends Omit<ActiveJournalV2, "schemaVersion" | "directoryEntries"> {
    schemaVersion: 3;
    targetExecution: SelectedWslJournalExecution;
    directoryEntries: JournalDirectoryEntryV3[];
}

/** Prepared complete leaves and protective file recovery; old schema recovery never acquires these rules. */
export interface ActiveJournalV4 extends Omit<ActiveJournalV2, "schemaVersion"> {
    schemaVersion: 4;
    targetExecution: { kind: "host" } | SelectedWslJournalExecution;
    staging: { rootPath: string; identity: PhysicalPathIdentity | null };
    publicationPhase: "preparing" | "publishing";
    publications: JournalPublication[];
}

export type DirectoryJournal = ActiveJournalV2 | ActiveJournalV3 | ActiveJournalV4;
export type ActiveJournal = ActiveJournalV1 | DirectoryJournal;

export interface JournalDirectoryEntry {
    relativePath: string;
    oldState: "missing" | "present";
    desiredState: "missing" | "present";
    oldIdentity: PhysicalPathIdentity | null;
    createdIdentity: PhysicalPathIdentity | null;
}

export interface JournalDirectoryEntryV3 extends JournalDirectoryEntry {
    /** A previously present directory recreated while restoring the old side. */
    restoredIdentity: PhysicalPathIdentity | null;
}

export interface JournalEntry {
    relativePath: string;
    /** Old content hash. "" is the authoritative absence marker (file did not
     *  exist pre-deploy). A real sha256:<hex> (including the sha256 of empty
     *  bytes) means the file existed — even if it was zero-byte. */
    oldHash: string;
    /** Old content as base64. "" means EITHER the file did not exist OR the
     *  file existed but was zero-byte — distinguish via oldHash, NOT this field. */
    oldBytesBase64: string;
    oldExecutable: boolean;
    /** Empty only when no old active baseline existed. */
    oldProvenanceFingerprint: string;
    oldMaterializationFingerprint: string;
    /**
     * Present only when an explicitly approved repair/overwrite replaces a
     * runtime state that differs from the last successful OAAM baseline.
     * `old*` remains the database pre-transaction authority; this override is
     * used only by physical CAS/rollback/recovery.
     */
    runtimeRollbackOverride?:
        | { state: "missing" }
        | {
              state: "present";
              contentHash: string;
              bytesBase64: string;
              executable: boolean;
          };
    /** New content hash (SHA-256 of newBytes). "" for removal targets. */
    newHash: string;
    /** New content as base64. "" for removal targets. */
    newBytesBase64: string;
    newExecutable: boolean;
    /** Empty only for removal targets. */
    newProvenanceFingerprint: string;
    newMaterializationFingerprint: string;
    /** true when this target is a removal (old baseline path not in new plan).
     *  Removal target: runtime write = delete file, newBytes = "". */
    isRemoval: boolean;
    /** Required in schema v2; omitted only by historical schema-v1 journals. */
    entryAuthority?: "managed_baseline" | "explicit_unmanaged_replacement";
}

export type JournalRuntimeRollbackState =
    | { state: "missing"; contentHash: ""; bytesBase64: ""; executable: false }
    | {
          state: "present";
          contentHash: string;
          bytesBase64: string;
          executable: boolean;
      };

/** Resolve the physical pre-operation state without changing DB baseline authority. */
export function getJournalRuntimeRollbackState(entry: JournalEntry): JournalRuntimeRollbackState {
    const override = entry.runtimeRollbackOverride;
    if (override?.state === "missing" || (override === undefined && entry.oldHash === "")) {
        return { state: "missing", contentHash: "", bytesBase64: "", executable: false };
    }
    const bytesBase64 = override?.state === "present" ? override.bytesBase64 : entry.oldBytesBase64;
    return {
        state: "present",
        contentHash: override?.state === "present" ? override.contentHash : entry.oldHash,
        bytesBase64,
        executable: override?.state === "present" ? override.executable : entry.oldExecutable,
    };
}

// ============================================================
// Path helpers
// ============================================================

function journalDir(transactionsRoot: string, txnId: string): string {
    return path.join(transactionsRoot, txnId);
}

function journalPath(transactionsRoot: string, txnId: string): string {
    return path.join(journalDir(transactionsRoot, txnId), "journal.json");
}

// ============================================================
// Publish / read / delete
// ============================================================

/**
 * Atomically publish the active journal. Must complete BEFORE any runtime
 * write (§8.9 l.890-893). Uses descriptor-safe durable replacement,
 * so a crash during publish leaves either no journal.json or a complete one —
 * never a partial marker.
 *
 * REFUSES TO OVERWRITE: if a journal.json already exists for this txnId the
 * call throws. An active journal is a short-lived reservation marker + the
 * only recovery material for its transaction; overwriting it would discard
 * the old material and silently replace the reservation. Callers must
 * deleteJournal() first if they genuinely need to republish (recovery only).
 * The txn directory may pre-exist (ensureDir is a no-op then) — only the
 * journal.json marker is protected.
 *
 * @throws Error when journal.json already exists for journal.transactionId.
 */
export function publishJournal(transactionsRoot: string, journal: ActiveJournal): void {
    if (!isValidJournal(journal)) {
        throw new Error("publishJournal: journal authority is not strict/canonical");
    }
    durableEnsureDirectory(path.dirname(transactionsRoot), path.basename(transactionsRoot));
    durableEnsureDirectory(transactionsRoot, journal.transactionId);
    const jp = journalPath(transactionsRoot, journal.transactionId);
    try {
        readRegularFileNoFollow(jp);
        throw new Error(
            `publishJournal: active journal already exists for txn ${journal.transactionId} ` +
                "(refusing to overwrite reservation marker; deleteJournal first if republishing)",
        );
    } catch (error) {
        if (!(error instanceof SafeFilesystemError && error.failureKind === "not_found")) {
            throw error;
        }
    }
    durableReplaceFile(jp, JSON.stringify(journal));
}

/**
 * Read + shape-check a journal. Returns null when the file is missing, unreadable,
 * unparseable, or fails the shape guard (schemaVersion, transactionId type,
 * entries array). Null means "corrupt" → caller treats as commit=unknown (H5).
 */
export function readJournal(transactionsRoot: string, txnId: string): ActiveJournal | null {
    // Reject path-like or non-v4 identifiers before joining with the trusted
    // transactions root. Production callers use UUIDv4 transaction IDs; a
    // malformed external argument must never become a filesystem traversal.
    if (!isUuidV4(txnId)) return null;
    let raw: string;
    try {
        raw = Buffer.from(readRegularFileNoFollow(journalPath(transactionsRoot, txnId)).bytes).toString("utf-8");
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isValidJournal(parsed)) return null;
    if (parsed.transactionId !== txnId) return null;
    return parsed;
}

/** Minimal shape guard. A journal failing any check is treated as corrupt (null). */
export function isValidJournal(value: unknown): value is ActiveJournal {
    if (typeof value !== "object" || value === null) return false;
    const j = value as Record<string, unknown>;
    const commonKeys = [
        "schemaVersion",
        "transactionId",
        "deploymentId",
        "createdAt",
        "compilationFingerprint",
        "reservedPhysicalKeys",
        "entries",
    ];
    if (j.schemaVersion === 1) {
        if (!hasExactKeys(j, commonKeys)) return false;
    } else if (j.schemaVersion === 2) {
        if (!hasExactKeys(j, [...commonKeys, "managedDirectoryBoundaries", "directoryEntries"])) return false;
    } else if (j.schemaVersion === 3) {
        if (!hasExactKeys(j, [...commonKeys, "managedDirectoryBoundaries", "directoryEntries", "targetExecution"])) return false;
        if (!isSelectedWslJournalExecution(j.targetExecution)) return false;
    } else if (j.schemaVersion === 4) {
        if (
            !hasExactKeys(j, [
                ...commonKeys,
                "managedDirectoryBoundaries",
                "directoryEntries",
                "targetExecution",
                "publications",
                "staging",
                "publicationPhase",
            ])
        )
            return false;
        const execution = j.targetExecution as Record<string, unknown> | null;
        const staging = j.staging as Record<string, unknown> | null;
        if (
            !(hasExactKeys(execution, ["kind"]) && execution?.kind === "host") &&
            !isSelectedWslJournalExecution(j.targetExecution)
        )
            return false;
        if (
            !hasExactKeys(staging, ["rootPath", "identity"]) ||
            typeof staging?.rootPath !== "string" ||
            !isCanonicalPhysicalAccessPath(staging.rootPath) ||
            !isDirectoryIdentityOrNull(staging.identity)
        )
            return false;
        try {
            if (splitPhysicalAccessPath(staging.rootPath).name !== `oaam-deployment-${String(j.transactionId)}`) return false;
        } catch {
            return false;
        }
        if (j.publicationPhase !== "preparing" && j.publicationPhase !== "publishing") return false;
        if (j.publicationPhase === "publishing" && staging.identity === null) return false;
    } else {
        return false;
    }
    if (!isUuidV4(j.transactionId)) return false;
    if (!isUuidV4(j.deploymentId)) return false;
    if (!Number.isInteger(j.createdAt) || (j.createdAt as number) < 0) return false;
    if (!isSha256Digest(j.compilationFingerprint)) return false;
    if (!Array.isArray(j.entries)) return false;
    // Validate each entry's shape so a structurally-corrupt journal fails closed
    // here (H5) rather than crashing recovery with undefined-field access later.
    if (!j.entries.every((entry) => isValidJournalEntry(entry, j.schemaVersion === 1 ? 1 : 2))) return false;
    const paths = j.entries.map((entry) => entry.relativePath);
    if (new Set(paths).size !== paths.length) return false;
    if (j.schemaVersion !== 1) {
        if (!isValidManagedDirectoryBoundaries(j.managedDirectoryBoundaries)) return false;
        if (
            !isValidJournalDirectoryEntries(
                j.directoryEntries,
                j.entries as JournalEntry[],
                j.managedDirectoryBoundaries as string[],
                j.schemaVersion === 3 ? 3 : 2,
            )
        ) {
            return false;
        }
    }
    if (j.schemaVersion === 4) {
        const directories = j.directoryEntries as JournalDirectoryEntry[];
        if (
            !isValidPublications(
                j.publications,
                j.entries as JournalEntry[],
                directories,
                j.managedDirectoryBoundaries as string[],
            )
        )
            return false;
        if (
            j.publicationPhase === "publishing" &&
            j.publications.some(
                (unit) =>
                    unit.kind === "directory" &&
                    unit.preparedIdentity === null &&
                    directories.some((entry) => entry.relativePath === unit.relativePath && entry.desiredState === "present"),
            )
        )
            return false;
    }
    return (
        Array.isArray(j.reservedPhysicalKeys) &&
        (j.entries.length === 0) === (j.reservedPhysicalKeys.length === 0) &&
        j.reservedPhysicalKeys.every(isCanonicalPhysicalKey) &&
        new Set(j.reservedPhysicalKeys).size === j.reservedPhysicalKeys.length &&
        JSON.stringify([...j.reservedPhysicalKeys].sort()) === JSON.stringify(j.reservedPhysicalKeys)
    );
}

export function getJournalDirectoryEntries(journal: ActiveJournal): JournalDirectoryEntry[] {
    return journal.schemaVersion === 1 ? [] : journal.directoryEntries;
}

/**
 * Atomically bind one just-created runtime directory identity to an already
 * published directory journal without ever removing the reservation marker. The only
 * allowed transition is `missing/null -> missing/exact identity`; all other
 * journal bytes must still match the caller's retained value.
 */
export function recordJournalCreatedDirectory<T extends DirectoryJournal>(
    transactionsRoot: string,
    journal: T,
    relativePath: string,
    createdIdentity: PhysicalPathIdentity,
): T {
    return recordJournalDirectoryIdentity(transactionsRoot, journal, relativePath, createdIdentity, "createdIdentity");
}

export function recordJournalRestoredDirectory(
    transactionsRoot: string,
    journal: ActiveJournalV3,
    relativePath: string,
    restoredIdentity: PhysicalPathIdentity,
): ActiveJournalV3 {
    return recordJournalDirectoryIdentity(transactionsRoot, journal, relativePath, restoredIdentity, "restoredIdentity");
}

function recordJournalDirectoryIdentity<T extends DirectoryJournal>(
    transactionsRoot: string,
    journal: T,
    relativePath: string,
    createdIdentity: PhysicalPathIdentity,
    field: "createdIdentity" | "restoredIdentity",
): T {
    if (!isDirectoryIdentityOrNull(createdIdentity) || createdIdentity === null) {
        throw new Error("created directory receipt requires one directory identity");
    }
    const retained = readJournal(transactionsRoot, journal.transactionId);
    if (
        retained === null ||
        retained.schemaVersion !== journal.schemaVersion ||
        JSON.stringify(retained) !== JSON.stringify(journal)
    ) {
        throw new Error("active journal changed before directory identity publication");
    }
    const index = journal.directoryEntries.findIndex((entry) => entry.relativePath === relativePath);
    const current = journal.directoryEntries[index];
    const pending =
        field === "createdIdentity"
            ? current?.oldState === "missing" && current.createdIdentity === null
            : journal.schemaVersion === 3 &&
              current?.oldState === "present" &&
              current.desiredState === "missing" &&
              "restoredIdentity" in current &&
              current.restoredIdentity === null;
    if (index < 0 || !pending) {
        throw new Error("directory identity publication does not match one pending missing directory");
    }
    const updated: T = {
        ...journal,
        directoryEntries: journal.directoryEntries.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, [field]: { ...createdIdentity } } : entry,
        ),
    };
    durableReplaceFile(journalPath(transactionsRoot, journal.transactionId), JSON.stringify(updated));
    const readBack = readJournal(transactionsRoot, journal.transactionId);
    if (readBack === null || JSON.stringify(readBack) !== JSON.stringify(updated)) {
        throw new Error("created directory receipt did not read back exactly");
    }
    return updated;
}

export function isValidJournalEntry(value: unknown, schemaVersion: 1 | 2): value is JournalEntry {
    if (typeof value !== "object" || value === null) return false;
    const e = value as Record<string, unknown>;
    const keys = [
        "relativePath",
        "oldHash",
        "oldBytesBase64",
        "oldExecutable",
        "oldProvenanceFingerprint",
        "oldMaterializationFingerprint",
        "newHash",
        "newBytesBase64",
        "newExecutable",
        "newProvenanceFingerprint",
        "newMaterializationFingerprint",
        "isRemoval",
    ];
    if ("runtimeRollbackOverride" in e) keys.push("runtimeRollbackOverride");
    if (schemaVersion === 2) keys.push("entryAuthority");
    if (!hasExactKeys(e, keys)) return false;
    if (
        !(
            isCanonicalRelativePath(e.relativePath) &&
            typeof e.oldHash === "string" &&
            typeof e.oldBytesBase64 === "string" &&
            typeof e.oldExecutable === "boolean" &&
            typeof e.oldProvenanceFingerprint === "string" &&
            typeof e.oldMaterializationFingerprint === "string" &&
            typeof e.newHash === "string" &&
            typeof e.newBytesBase64 === "string" &&
            typeof e.newExecutable === "boolean" &&
            typeof e.newProvenanceFingerprint === "string" &&
            typeof e.newMaterializationFingerprint === "string" &&
            typeof e.isRemoval === "boolean"
        )
    )
        return false;
    if (!isHashOrAbsence(e.oldHash) || !isHashOrAbsence(e.newHash)) return false;
    if (!isHashOrAbsence(e.oldProvenanceFingerprint) || !isHashOrAbsence(e.oldMaterializationFingerprint)) {
        return false;
    }
    if (!isHashOrAbsence(e.newProvenanceFingerprint) || !isHashOrAbsence(e.newMaterializationFingerprint)) {
        return false;
    }
    if (!isCanonicalBase64(e.oldBytesBase64) || !isCanonicalBase64(e.newBytesBase64)) return false;
    if ("runtimeRollbackOverride" in e && !isValidRuntimeRollbackOverride(e.runtimeRollbackOverride)) {
        return false;
    }
    if (schemaVersion === 2 && e.entryAuthority !== "managed_baseline" && e.entryAuthority !== "explicit_unmanaged_replacement") {
        return false;
    }
    if (
        e.entryAuthority === "explicit_unmanaged_replacement" &&
        (!e.isRemoval || e.oldHash !== "" || !("runtimeRollbackOverride" in e))
    ) {
        return false;
    }
    if (e.oldHash === "") {
        if (
            e.oldBytesBase64 !== "" ||
            e.oldExecutable !== false ||
            e.oldProvenanceFingerprint !== "" ||
            e.oldMaterializationFingerprint !== ""
        )
            return false;
    } else {
        if (
            journalBytesHash(e.oldBytesBase64) !== e.oldHash ||
            e.oldProvenanceFingerprint === "" ||
            e.oldMaterializationFingerprint === ""
        )
            return false;
    }
    if (e.isRemoval) {
        return (
            e.newHash === "" &&
            e.newBytesBase64 === "" &&
            e.newExecutable === false &&
            e.newProvenanceFingerprint === "" &&
            e.newMaterializationFingerprint === ""
        );
    }
    return (
        e.newHash !== "" &&
        journalBytesHash(e.newBytesBase64) === e.newHash &&
        e.newProvenanceFingerprint !== "" &&
        e.newMaterializationFingerprint !== ""
    );
}

function isValidRuntimeRollbackOverride(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const override = value as Record<string, unknown>;
    if (override.state === "missing") return hasExactKeys(override, ["state"]);
    return (
        override.state === "present" &&
        hasExactKeys(override, ["state", "contentHash", "bytesBase64", "executable"]) &&
        typeof override.contentHash === "string" &&
        isSha256Digest(override.contentHash) &&
        typeof override.bytesBase64 === "string" &&
        isCanonicalBase64(override.bytesBase64) &&
        journalBytesHash(override.bytesBase64) === override.contentHash &&
        typeof override.executable === "boolean"
    );
}

function isHashOrAbsence(value: string): boolean {
    return value === "" || isSha256Digest(value);
}

function isCanonicalBase64(value: string): boolean {
    return Buffer.from(value, "base64").toString("base64") === value;
}

function isCanonicalPhysicalKey(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const separator = value.indexOf("\0");
    if (separator < 1 || separator !== value.lastIndexOf("\0")) return false;
    if (!new Set(["linux", "darwin", "win32", "wsl"]).has(value.slice(0, separator))) {
        return false;
    }
    return value.slice(separator + 1).length > 0;
}

function journalBytesHash(base64: string): string {
    return sha256Bytes(Buffer.from(base64, "base64"));
}

/**
 * Delete the journal: remove journal.json (the publish marker) first, then
 * best-effort remove the txn dir. If dir removal fails, the reservation still
 * ends because the publish marker is gone (§8.10 l.1385-1386).
 *
 * Marker-deletion semantics (audit fix):
 *   - marker absent (ENOENT, including a concurrent delete racing this call)
 *     → return true (idempotent; reservation already ended).
 *   - marker deleted successfully → return true.
 *   - marker present but unlink failed with non-ENOENT (EACCES/EIO/…) → throw
 *     (reservation persists; caller must NOT treat journal as resolved). The
 *     throw includes the errno so the caller can distinguish recoverable
 *     (permission) from fatal (IO) failures.
 *
 * Dir cleanup is ALWAYS attempted best-effort (even when the marker was
 * already absent), so a residual txn dir from a crashed cleanup does not stay
 * forever — otherwise scanJournals would keep reporting it as corrupt and the
 * freeze gate could not be lifted without manual intervention (audit C1).
 *
 * @returns true when the marker is gone after this call.
 * @throws Error when the marker is present but could not be deleted (non-ENOENT).
 */
export function deleteJournal(transactionsRoot: string, txnId: string): boolean {
    if (!isUuidV4(txnId)) {
        throw new Error("deleteJournal: txnId must be a UUID v4");
    }
    const jp = journalPath(transactionsRoot, txnId);
    try {
        durableRemoveRegularFile(jp);
    } catch (err) {
        if (
            err instanceof DurableFilesystemMutationError &&
            err.failureKind === "not_found" &&
            err.mutationState === "not_applied"
        ) {
            // Missing marker or missing enclosing txn directory: the
            // reservation is already absent. Continue with best-effort dir
            // cleanup for idempotency.
        } else {
            throw new Error(
                `deleteJournal: failed to remove journal marker for txn ${txnId} ` +
                    `(${String(err)}); reservation state must be reconciled`,
            );
        }
    }
    // Best-effort dir cleanup — ALWAYS, so residual dirs from crashed cleanups
    // are removed (audit C1). Failure here does not affect reservation.
    try {
        durableRemoveDirectoryTree(journalDir(transactionsRoot, txnId));
    } catch {
        // dir removal best-effort; marker already removed (or was absent) = reservation ends
    }
    return true;
}

// ============================================================
// Unresolved-journal scan (freeze gate + recovery trigger)
// ============================================================

/** Result of scanning transactionsRoot for journals belonging to a deployment.
 *
 *  - `matchingTxnIds`: dirs whose journal.json parses + deploymentId matches.
 *    These are resolvable (recovery can act on them).
 *  - `corruptTxnIds`: dirs with a journal.json marker that is unreadable,
 *    unparseable, or fails the shape guard. These are unresolved reservations
 *    that CANNOT be auto-resolved;
 *    the freeze gate must treat a non-empty corruptTxnIds as "blocked, do not
 *    start a new deploy" (H5 fail-closed). A corrupt journal cannot be matched
 *    to a deploymentId by content, so it is reported for EVERY deploymentId
 *    scan — the executor freezes the relevant deployment(s) conservatively. */
export interface JournalScanResult {
    matchingTxnIds: string[];
    corruptTxnIds: string[];
}

/** All parseable active journal reservations plus globally blocking corruption. */
export interface ActiveJournalReservationScanResult {
    journals: ActiveJournal[];
    corruptTxnIds: string[];
}

/**
 * Scan transactionsRoot for journals belonging to `deploymentId`, separating
 * resolvable (matching) from corrupt (fail-closed) txn dirs.
 *
 * Used by:
 *   - executor freeze gate: if matchingTxnIds OR corruptTxnIds is non-empty →
 *     refuse to start a new deploy (H6 freeze + H5 fail-closed on corrupt).
 *   - recovery: matchingTxnIds are the journals it can recover from;
 *     corruptTxnIds block recovery (commit=unknown → blocked_needs_support).
 *
 * A txn dir is counted as "corrupt" only when its marker exists but
 * readJournal returns null (unreadable/unparseable/shape-failed journal.json).
 * A marker-less txn dir is not a reservation: it is either pre-publication
 * debris (no runtime write is allowed before marker publication) or residue
 * after successful marker deletion. Corrupt
 * journals cannot be attributed to a specific deploymentId by content, so they
 * are reported for every scan — the caller freezes conservatively.
 *
 * Returns { [], [] } only when transactionsRoot does not exist. An unreadable,
 * symlinked, or unstable authority root throws so the executor stops before
 * runtime writes instead of confusing "could not inspect" with "no journal".
 */
export function scanJournals(transactionsRoot: string, deploymentId: string): JournalScanResult {
    const reservations = scanActiveJournalReservations(transactionsRoot);
    return {
        matchingTxnIds: reservations.journals
            .filter((journal) => journal.deploymentId === deploymentId)
            .map((journal) => journal.transactionId),
        corruptTxnIds: reservations.corruptTxnIds,
    };
}

/**
 * Scan the reservation authority without filtering by Deployment. Writers use
 * this under their operation + physical locks so a foreign unresolved journal
 * that intersects the same file/parent/boundary closure blocks before I/O.
 */
export function scanActiveJournalReservations(transactionsRoot: string): ActiveJournalReservationScanResult {
    const result: ActiveJournalReservationScanResult = { journals: [], corruptTxnIds: [] };
    let entries: ReturnType<typeof inventoryDirectoryNoFollow>["entries"];
    try {
        entries = inventoryDirectoryNoFollow(transactionsRoot).entries;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return result;
        throw error;
    }
    for (const e of entries) {
        if (e.identity.entryKind !== "directory") continue;
        // A txn dir is named like a UUID; non-UUID dirs (e.g. the "locks/"
        // sibling) are skipped to avoid false corrupt reports.
        if (!isTxnIdLike(e.relativeName)) continue;
        const txnId = e.relativeName;
        const jp = journalPath(transactionsRoot, txnId);
        let markerExists = true;
        try {
            readRegularFileNoFollow(jp);
        } catch (error) {
            if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
                markerExists = false;
            } else {
                throw error;
            }
        }
        if (!markerExists) {
            // The marker is the reservation authority. A directory alone may
            // be pre-publication or post-deletion debris and cannot prove that
            // any runtime write began.
            continue;
        }
        const j = readJournal(transactionsRoot, txnId);
        if (j === null) {
            // journal.json present but unreadable/unparseable/shape-failed.
            result.corruptTxnIds.push(txnId);
        } else {
            result.journals.push(j);
        }
    }
    result.journals.sort((left, right) =>
        Buffer.compare(Buffer.from(left.transactionId, "utf-8"), Buffer.from(right.transactionId, "utf-8")),
    );
    result.corruptTxnIds.sort();
    return result;
}

/** Heuristic: a txn id looks like a UUID v4 (8-4-4-4-12 hex). Used to
 *  distinguish txn dirs from sibling dirs like "locks/" so the latter are not
 *  mis-reported as corrupt journals. */
function isTxnIdLike(name: string): boolean {
    return isUuidV4(name);
}

/**
 * Convenience: txnIds whose journal.json parses + matches the deploymentId.
 *
 * Naming (audit fix): this is named "recoverable" on purpose, NOT
 * "unresolved". An "unresolved journal / reservation" in our design includes
 * corrupt/residual journals that block recovery (H5 fail-closed). This helper
 * only covers the RECOVERABLE subset (parseable + deploymentId match) — it
 * does NOT report corrupt journals. The name makes that limitation visible at
 * the call site so the executor freeze gate cannot accidentally use this and
 * miss corrupt journals. For freeze decisions use scanJournals() and check
 * BOTH matchingTxnIds and corruptTxnIds.
 */
export function findRecoverableJournals(transactionsRoot: string, deploymentId: string): string[] {
    return scanJournals(transactionsRoot, deploymentId).matchingTxnIds;
}

/** Convenience: true iff scanJournals finds any matching (recoverable) journal.
 *  Naming note: "recoverable" excludes corrupt journals — see
 *  findRecoverableJournals. Freeze gate must use scanJournals() directly. */
export function hasRecoverableJournal(transactionsRoot: string, deploymentId: string): boolean {
    return scanJournals(transactionsRoot, deploymentId).matchingTxnIds.length > 0;
}

// ============================================================
// Internal
// ============================================================
