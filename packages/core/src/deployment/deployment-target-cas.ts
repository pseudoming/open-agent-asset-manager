/**
 * CAS write/delete for deployment target files.
 *
 * Action-time guard (R2-P0-2): every write/delete re-reads the live file and
 * only proceeds when it equals the last success baseline (entry.oldHash). A
 * diverged runtime is a third value → stop, do not overwrite.
 *
 * Removal CAS (R2-P0-1 / H8): a missing file is accepted (already removed); a
 * present file equal to baseline is deleted; anything else is a third value
 * (do not delete user-edited content).
 *
 * Scope (this module ONLY): CAS write/delete per entry + batch orchestration.
 * Out of scope: verify, rollback, journal file I/O, recovery decisions, SQL.
 */

import { base64ToBytes, sha256Bytes } from "../foundation/crypto-bytes";
import type { StableRegularFileRead } from "@oaam/shared/filesystem";
import { getJournalRuntimeRollbackState, type JournalEntry } from "./deployment-journal";
import type { TargetIoContext } from "./deployment-target-io";
import {
    absPath,
    ioAssertExecutableStateSupported,
    ioChmodIfDifferent,
    ioDelete,
    ioReadStableIfPresent,
    ioWrite,
} from "./deployment-target-io";

// ============================================================
// Public types
// ============================================================

/** Result of CAS-writing one entry. */
export type CasOutcome =
    | { kind: "written"; mutated: boolean }
    | { kind: "third_value"; relativePath: string }
    | { kind: "write_failed"; relativePath: string };

/** Result of CAS-writing a batch of entries. Stops at the first non-written
 *  outcome; `written` reflects successful entries (including no-ops), while
 *  `mutated` is the exact rollback set. */
export interface CasBatchResult {
    /** true iff every entry was written (no third_value / write_failed). */
    ok: boolean;
    /** Entries confirmed written before any stop. */
    written: string[];
    /** Subset of `written` whose runtime path this invocation actually
     *  changed. Rollback must consume this set, never the broader success set. */
    mutated: string[];
    /** First stopper, if any. */
    stop: CasOutcome | null;
}

// ============================================================
// CAS write batch
// ============================================================

/**
 * CAS-write every entry in order. Stops at the first third_value or
 * write_failed; entries before the stop are confirmed successful. The caller
 * (executor) decides what to do with a non-ok result (third_value → rollback +
 * conflict; write_failed → leave journal unresolved + blocked).
 *
 * Per-entry CAS semantics:
 *   - removal entry: missing → written (no-op, not mutated); present == oldHash
 *     → delete → written+mutated; present != oldHash → third_value;
 *     delete/read failure → write_failed
 *   - deploy entry: absent + oldHash="" → write new → written; runtime hash ==
 *     oldHash → write new → written, or confirm a no-op when desired bytes and
 *     executable state already match; otherwise → third_value; read/write failure → write_failed
 */
export function casWriteAll(entries: JournalEntry[], ctx: TargetIoContext): CasBatchResult {
    const unsupportedPath = preflightExecutableTransitions(entries, ctx);
    if (unsupportedPath !== null) {
        return {
            ok: false,
            written: [],
            mutated: [],
            stop: { kind: "write_failed", relativePath: unsupportedPath },
        };
    }
    const written: string[] = [];
    const mutated: string[] = [];
    for (const entry of entries) {
        const outcome = casWriteOne(entry, ctx);
        if (outcome.kind === "written") {
            written.push(entry.relativePath);
            if (outcome.mutated) mutated.push(entry.relativePath);
            continue;
        }
        return { ok: false, written, mutated, stop: outcome };
    }
    return { ok: true, written, mutated, stop: null };
}

function casWriteOne(entry: JournalEntry, ctx: TargetIoContext): CasOutcome {
    const abs = absPath(ctx, entry.relativePath);
    let current: StableRegularFileRead | null;
    try {
        current = ioReadStableIfPresent(ctx, abs);
    } catch {
        return { kind: "write_failed", relativePath: entry.relativePath };
    }
    const expectedOld = getJournalRuntimeRollbackState(entry);

    if (entry.isRemoval) {
        return casRemoveOne(abs, current, entry, expectedOld, ctx);
    }
    return casDeployOne(abs, current, entry, expectedOld, ctx);
}

/** Removal CAS (H8): missing → written; present==oldHash → delete; else third_value. */
function casRemoveOne(
    abs: string,
    current: StableRegularFileRead | null,
    entry: JournalEntry,
    expectedOld: ReturnType<typeof getJournalRuntimeRollbackState>,
    ctx: TargetIoContext,
): CasOutcome {
    if (current === null) {
        // Already removed — successful no-op, but NOT a mutation that an abort
        // may undo. Restoring the baseline here would resurrect a file the user
        // had already removed before this deploy.
        return { kind: "written", mutated: false };
    }
    const currentHash = sha256Bytes(current.bytes);
    if (currentHash !== expectedOld.contentHash) {
        // present but diverged from baseline → do not delete user-edited content
        return { kind: "third_value", relativePath: entry.relativePath };
    }
    if (current.executable !== expectedOld.executable) {
        return { kind: "third_value", relativePath: entry.relativePath };
    }
    try {
        ioDelete(ctx, abs);
    } catch {
        return { kind: "write_failed", relativePath: entry.relativePath };
    }
    return { kind: "written", mutated: true };
}

/** Deploy CAS: runtime hash == oldHash (or both empty) → write new; else third_value. */
function casDeployOne(
    abs: string,
    current: StableRegularFileRead | null,
    entry: JournalEntry,
    expectedOld: ReturnType<typeof getJournalRuntimeRollbackState>,
    ctx: TargetIoContext,
): CasOutcome {
    const currentHash = current === null ? "" : sha256Bytes(current.bytes);
    if (currentHash !== expectedOld.contentHash) {
        // runtime diverged from baseline (or pre-existing content on first
        // deploy) → do not overwrite
        return { kind: "third_value", relativePath: entry.relativePath };
    }
    if (current !== null && current.executable !== expectedOld.executable) {
        return { kind: "third_value", relativePath: entry.relativePath };
    }
    const newBytes = base64ToBytes(entry.newBytesBase64);
    if (current !== null && currentHash === sha256Bytes(newBytes) && current.executable === entry.newExecutable) {
        return { kind: "written", mutated: false };
    }
    try {
        ioWrite(ctx, abs, newBytes, current === null ? "create" : "replace");
        ioChmodIfDifferent(ctx, abs, entry.newExecutable);
    } catch {
        return { kind: "write_failed", relativePath: entry.relativePath };
    }
    return { kind: "written", mutated: true };
}

/** Prove both the desired side and every possible rollback side before any write. */
export function preflightExecutableTransitions(entries: JournalEntry[], ctx: TargetIoContext): string | null {
    for (const entry of entries) {
        const abs = absPath(ctx, entry.relativePath);
        const runtimeOld = getJournalRuntimeRollbackState(entry);
        try {
            if (runtimeOld.state === "present") {
                ioAssertExecutableStateSupported(ctx, abs, runtimeOld.executable);
            }
            if (!entry.isRemoval) ioAssertExecutableStateSupported(ctx, abs, entry.newExecutable);
        } catch {
            return entry.relativePath;
        }
    }
    return null;
}
