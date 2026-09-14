/** Stateless file recovery shared by local and restricted execution. State,
 * journal authority, direction, locks and journal resolution stay with the caller. */
import { base64ToBytes, sha256Bytes } from "../foundation/crypto-bytes";
import { getJournalRuntimeRollbackState, type JournalEntry } from "./deployment-journal";
import {
    absPath,
    ioAssertExecutableStateSupported,
    ioChmodIfDifferent,
    ioDelete,
    ioExecutable,
    ioExists,
    ioRead,
    ioWrite,
    type TargetIoContext,
} from "./deployment-target-io";

export type TargetRecoveryOutcome = "done" | "third_value" | "io_failed";
type TargetOutcome = TargetRecoveryOutcome;

/** Only old/new states can be changed. A third value is never rollback input. */
export function recoverTargetFiles(ctx: TargetIoContext, entries: JournalEntry[], side: "old" | "new"): TargetRecoveryOutcome {
    if (!executableStatesSupportedForSide(ctx, entries, side)) return "io_failed";
    for (const entry of entries) {
        const result = side === "new" ? convergeOneToNew(ctx, entry) : restoreOneToOld(ctx, entry);
        if (result !== "done") return result;
    }
    return "done";
}

interface CurrentPhysicalState {
    contentHash: string;
    executable: boolean;
}

function convergeOneToNew(ctx: TargetIoContext, entry: JournalEntry): TargetOutcome {
    const abs = absPath(ctx, entry.relativePath);
    const current = readCurrentState(ctx, abs);
    if (current === null) return "io_failed";
    const runtimeOld = getJournalRuntimeRollbackState(entry);

    if (matchesPhysicalState(current, entry.newHash, entry.newExecutable)) {
        return "done"; // already converged
    }
    if (!matchesPhysicalState(current, runtimeOld.contentHash, runtimeOld.executable)) {
        return "third_value"; // runtime diverged from both old and new
    }
    // current === oldHash → write new (or delete for removal)
    if (entry.isRemoval) {
        return deleteAndVerifyAbsent(ctx, abs);
    }
    try {
        ioWrite(ctx, abs, base64ToBytes(entry.newBytesBase64), current.contentHash === "" ? "create" : "replace");
        ioChmodIfDifferent(ctx, abs, entry.newExecutable);
    } catch {
        return "io_failed";
    }
    // write-back verify
    const after = readCurrentState(ctx, abs);
    if (after === null || !matchesPhysicalState(after, entry.newHash, entry.newExecutable)) return "io_failed";
    return "done";
}

function restoreOneToOld(ctx: TargetIoContext, entry: JournalEntry): TargetOutcome {
    const abs = absPath(ctx, entry.relativePath);
    const current = readCurrentState(ctx, abs);
    if (current === null) return "io_failed";
    const runtimeOld = getJournalRuntimeRollbackState(entry);

    if (matchesPhysicalState(current, runtimeOld.contentHash, runtimeOld.executable)) {
        return "done"; // already at old
    }
    if (!matchesPhysicalState(current, entry.newHash, entry.newExecutable)) {
        return "third_value"; // runtime diverged from both old and new
    }
    // current === newHash → restore old
    if (runtimeOld.state === "missing") {
        // did not exist pre-deploy → delete + verify absent
        return deleteAndVerifyAbsent(ctx, abs);
    }
    // oldHash !== "" → write old bytes (incl. zero-byte: base64ToBytes("") = empty)
    try {
        ioWrite(ctx, abs, base64ToBytes(runtimeOld.bytesBase64), current.contentHash === "" ? "create" : "replace");
        ioChmodIfDifferent(ctx, abs, runtimeOld.executable);
    } catch {
        return "io_failed";
    }
    // write-back verify
    const after = readCurrentState(ctx, abs);
    if (after === null || !matchesPhysicalState(after, runtimeOld.contentHash, runtimeOld.executable)) return "io_failed";
    return "done";
}

function readCurrentState(ctx: TargetIoContext, abs: string): CurrentPhysicalState | null {
    try {
        if (!ioExists(ctx, abs)) return { contentHash: "", executable: false };
        return {
            contentHash: sha256Bytes(ioRead(ctx, abs)),
            executable: ioExecutable(ctx, abs),
        };
    } catch {
        return null;
    }
}

function matchesPhysicalState(current: CurrentPhysicalState, contentHash: string, executable: boolean): boolean {
    return current.contentHash === contentHash && current.executable === executable;
}

function executableStatesSupportedForSide(ctx: TargetIoContext, entries: JournalEntry[], side: "old" | "new"): boolean {
    try {
        for (const entry of entries) {
            const state = side === "old" ? getJournalRuntimeRollbackState(entry) : null;
            if (side === "old" && state?.state === "present") {
                ioAssertExecutableStateSupported(ctx, absPath(ctx, entry.relativePath), state.executable);
            } else if (side === "new" && !entry.isRemoval) {
                ioAssertExecutableStateSupported(ctx, absPath(ctx, entry.relativePath), entry.newExecutable);
            }
        }
        return true;
    } catch {
        return false;
    }
}

function deleteAndVerifyAbsent(ctx: TargetIoContext, abs: string): TargetOutcome {
    try {
        if (ioExists(ctx, abs)) ioDelete(ctx, abs);
        if (ioExists(ctx, abs)) {
            // Delete did not throw but file is still present → silent failure.
            return "io_failed";
        }
        return "done";
    } catch {
        return "io_failed";
    }
}
