import * as path from "node:path";
import Database from "better-sqlite3";

/**
 * Dedicated SQLite durability boundary for Stage-R final success commits.
 *
 * The ordinary OAAM singleton intentionally stays WAL + synchronous=NORMAL.
 * A reverse-accept final commit instead opens a short, independent connection,
 * proves WAL, enables and reads back FULL before BEGIN IMMEDIATE, commits one
 * synchronous callback, verifies the durable result after COMMIT on that same
 * connection, then closes it. No PRAGMA is changed inside the transaction and
 * the shared singleton is never temporarily mutated.
 */

export interface FullTransactionOperation<T> {
    mutate(db: Database.Database): T;
    verifyAfterCommit(db: Database.Database, value: T): void;
}

export interface FullTransactionLifecycleHooks<T> {
    afterDurabilityConfigured?(db: Database.Database): void;
    afterBegin?(db: Database.Database): void;
    beforeCommit?(db: Database.Database, value: T): void;
    afterCommit?(db: Database.Database, value: T): void;
}

export function runDedicatedFullTransaction<T>(databasePath: string, operation: FullTransactionOperation<T>): T {
    return runDedicatedFullTransactionCore(databasePath, operation, {});
}

/** Test-only lifecycle seam used for deterministic fault and real-process kill
 * fixtures. Production code must call runDedicatedFullTransaction. */
export function runDedicatedFullTransactionForTest<T>(
    databasePath: string,
    operation: FullTransactionOperation<T>,
    hooks: FullTransactionLifecycleHooks<T>,
): T {
    return runDedicatedFullTransactionCore(databasePath, operation, hooks);
}

/** Test-only pure configuration seam. Production obtains all three values from
 * the dedicated SQLite connection immediately before BEGIN IMMEDIATE. */
export function validateDedicatedFullConfigurationForTest(
    journalMode: unknown,
    foreignKeys: unknown,
    synchronous: unknown,
): void {
    validateDedicatedFullConfiguration(journalMode, foreignKeys, synchronous);
}

function runDedicatedFullTransactionCore<T>(
    databasePath: string,
    operation: FullTransactionOperation<T>,
    hooks: FullTransactionLifecycleHooks<T>,
): T {
    requireDurableDatabasePath(databasePath);
    const db = new Database(databasePath, { fileMustExist: true });
    try {
        const journalMode = db.pragma("journal_mode", { simple: true });
        db.pragma("foreign_keys = ON");
        const foreignKeys = db.pragma("foreign_keys", { simple: true });
        db.pragma("synchronous = FULL");
        const synchronous = db.pragma("synchronous", { simple: true });
        validateDedicatedFullConfiguration(journalMode, foreignKeys, synchronous);
        hooks.afterDurabilityConfigured?.(db);

        db.exec("BEGIN IMMEDIATE");
        let value: T;
        try {
            hooks.afterBegin?.(db);
            value = operation.mutate(db);
            hooks.beforeCommit?.(db, value);
            db.exec("COMMIT");
        } catch (error) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Preserve the original mutation/commit error. Closing a
                // connection with an open transaction is the final fail-closed
                // rollback attempt; callers must not treat this exception as a
                // successful commit.
            }
            throw error;
        }

        hooks.afterCommit?.(db, value);
        operation.verifyAfterCommit(db, value);
        return value;
    } finally {
        db.close();
    }
}

function validateDedicatedFullConfiguration(journalMode: unknown, foreignKeys: unknown, synchronous: unknown): void {
    if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
        throw new Error("Stage-R FULL transaction requires an existing WAL database");
    }
    if (foreignKeys !== 1) {
        throw new Error("Stage-R FULL transaction could not enable foreign_keys");
    }
    if (synchronous !== 2) {
        throw new Error("Stage-R FULL transaction could not verify synchronous=FULL");
    }
}

function requireDurableDatabasePath(databasePath: string): void {
    if (
        databasePath.length === 0 ||
        databasePath === ":memory:" ||
        databasePath.includes("\0") ||
        !path.isAbsolute(databasePath) ||
        path.normalize(databasePath) !== databasePath
    ) {
        throw new Error("Stage-R FULL transaction requires a canonical absolute database path");
    }
}
