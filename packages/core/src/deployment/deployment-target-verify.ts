/**
 * Post-write verify for deployment target files.
 *
 * Verify is equivalent to one complete trusted observation (CORE_DATA_MODEL
 * §8.10 生命周期步骤 5). Any failure → ok=false; the executor must NOT advance
 * the success baseline.
 *
 * Scope (this module ONLY): verify. Out of scope: CAS, rollback, journal I/O.
 */

import type { OperationDiagnostic } from "../types";
import { sha256Bytes } from "../foundation/crypto-bytes";
import type { JournalEntry } from "./deployment-journal";
import type { TargetIoContext } from "./deployment-target-io";
import { absPath, ioExists, ioReadStableIfPresent } from "./deployment-target-io";

// ============================================================
// Public types
// ============================================================

/** Per-target post-write verification record. Mirrors the DeploymentFile
 *  observed fields the executor will persist on success. */
export interface VerifiedTarget {
    relativePath: string;
    appliedContentHash: string;
    appliedExecutable: boolean;
    observedState: "present" | "missing";
    observedContentHash: string;
    observedExecutable: boolean;
}

/** Result of verifying a batch of entries. */
export interface VerifyResult {
    ok: boolean;
    verified: VerifiedTarget[];
    failures: OperationDiagnostic[];
}

// ============================================================
// verifyAll
// ============================================================

/**
 * Verify every entry against its expected new state. Equivalent to one complete
 * trusted observation (CORE_DATA_MODEL §8.10 生命周期步骤 5). Any failure →
 * ok=false; the executor must NOT advance the success baseline.
 *
 *   - removal entry: assert file no longer exists. A successfully-verified
 *     removal produces NO VerifiedTarget record (VerifiedTarget describes a
 *     present file's observed state); the executor soft-deletes the row instead.
 *   - deploy entry: read runtime, assert SHA-256 == newHash, and compare the
 *     selected backend's executable fact to newExecutable
 */
export function verifyAll(entries: JournalEntry[], ctx: TargetIoContext): VerifyResult {
    const verified: VerifiedTarget[] = [];
    const failures: OperationDiagnostic[] = [];

    for (const entry of entries) {
        const abs = absPath(ctx, entry.relativePath);
        if (entry.isRemoval) {
            if (ioExists(ctx, abs)) {
                failures.push(diag(`removal target still exists: ${entry.relativePath}`, entry.relativePath));
            }
            continue;
        }
        let actual: Uint8Array;
        let actualExec: boolean;
        try {
            const observed = ioReadStableIfPresent(ctx, abs);
            if (observed === null) {
                failures.push(diag(`target missing after write: ${entry.relativePath}`, entry.relativePath));
                continue;
            }
            actual = observed.bytes;
            actualExec = observed.executable;
        } catch (err) {
            failures.push(diag(`verify stable observation failed: ${entry.relativePath}: ${String(err)}`, entry.relativePath));
            continue;
        }
        const actualHash = sha256Bytes(actual);
        if (actualHash !== entry.newHash) {
            failures.push(
                diag(
                    `content hash mismatch on ${entry.relativePath}: expected ${entry.newHash} got ${actualHash}`,
                    entry.relativePath,
                ),
            );
            continue;
        }
        if (actualExec !== entry.newExecutable) {
            failures.push(
                diag(
                    `executable bit mismatch on ${entry.relativePath}: expected ${entry.newExecutable} got ${actualExec}`,
                    entry.relativePath,
                ),
            );
            continue;
        }
        verified.push({
            relativePath: entry.relativePath,
            appliedContentHash: entry.newHash,
            appliedExecutable: entry.newExecutable,
            observedState: "present",
            observedContentHash: actualHash,
            observedExecutable: actualExec,
        });
    }
    return { ok: failures.length === 0, verified, failures };
}

function diag(message: string, pathField: string): OperationDiagnostic {
    return {
        severity: "error",
        code: "deploy_verification_failed",
        message,
        operation: "deploy",
        causeKind: "verification_failed",
        path: pathField,
        traceId: "",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
