import * as path from "node:path";
import { durableEnsureDirectory, lockFile } from "@oaam/shared/filesystem";

const LOCK_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
type AcquireLock = (lockPath: string) => (() => void) | null;

declare const authorityLockLeaseBrand: unique symbol;
declare const authorityLockLeaseProofBrand: unique symbol;

export interface AuthorityLockLeaseProof {
    readonly [authorityLockLeaseProofBrand]: true;
}

/**
 * Process-local, non-serializable proof that one exact authority namespace is
 * still locked. Consumers must validate the lease against the authority set
 * they are about to read; a plain boolean cannot prove lock ownership.
 */
export interface AuthorityLockLease {
    readonly [authorityLockLeaseBrand]: true;
    readonly proof: AuthorityLockLeaseProof;
    release(): void;
}

interface AuthorityLockLeaseState {
    authorityLocksRoot: string;
    namespace: string;
    lockNames: string[];
    released: boolean;
    releaseLocks(): void;
}

const AUTHORITY_LOCK_LEASES = new WeakMap<object, AuthorityLockLeaseState>();

/**
 * Acquire one canonical lock namespace in caller-provided order. A busy lock
 * returns null; an unexpected failure releases every earlier lock before it
 * propagates. Callers own identity validation and global namespace ordering.
 */
export function tryAcquireAuthorityLocks(
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
): (() => void) | null {
    return tryAcquireAuthorityLocksCore(authorityLocksRoot, namespace, lockNames, lockFile);
}

export function tryAcquireAuthorityLockLease(
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
): AuthorityLockLease | null {
    return tryAcquireAuthorityLockLeaseCore(authorityLocksRoot, namespace, lockNames, lockFile);
}

/** Test-only seam for deterministic lease acquisition and release failures. */
export function tryAcquireAuthorityLockLeaseForTest(
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
    acquireLock: AcquireLock,
): AuthorityLockLease | null {
    return tryAcquireAuthorityLockLeaseCore(authorityLocksRoot, namespace, lockNames, acquireLock);
}

export function assertAuthorityLockLease(
    proof: AuthorityLockLeaseProof,
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
): void {
    const state = AUTHORITY_LOCK_LEASES.get(proof as object);
    if (
        state === undefined ||
        state.released ||
        state.authorityLocksRoot !== authorityLocksRoot ||
        state.namespace !== namespace ||
        !sameLockNames(state.lockNames, lockNames)
    ) {
        throw new Error("authority lock lease does not cover the required live authority set");
    }
}

/** Test-only seam for deterministic busy/unexpected-acquire cleanup tests. */
export function tryAcquireAuthorityLocksForTest(
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
    acquireLock: AcquireLock,
): (() => void) | null {
    return tryAcquireAuthorityLocksCore(authorityLocksRoot, namespace, lockNames, acquireLock);
}

function tryAcquireAuthorityLocksCore(
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
    acquireLock: AcquireLock,
): (() => void) | null {
    requireCanonicalAuthorityLocksRoot(authorityLocksRoot);
    requireLockComponent(namespace, "lock namespace");
    for (const lockName of lockNames) requireLockComponent(lockName, "lock name");
    const directory = ensureLockDirectory(authorityLocksRoot, namespace);
    const releases: Array<() => void> = [];
    try {
        for (const lockName of lockNames) {
            const release = acquireLock(path.join(directory, `${lockName}.lock`));
            if (release === null) {
                releaseAll(releases);
                return null;
            }
            releases.push(release);
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            releaseAll(releases);
        };
    } catch (error) {
        releaseAll(releases);
        throw error;
    }
}

function requireCanonicalAuthorityLocksRoot(root: string): void {
    if (
        root.length === 0 ||
        root.includes("\0") ||
        !path.isAbsolute(root) ||
        path.normalize(root) !== root ||
        root.endsWith(path.sep) ||
        root === path.parse(root).root
    ) {
        throw new Error("authorityLocksRoot must be a non-root canonical absolute path");
    }
}

function tryAcquireAuthorityLockLeaseCore(
    authorityLocksRoot: string,
    namespace: string,
    lockNames: readonly string[],
    acquireLock: AcquireLock,
): AuthorityLockLease | null {
    const releaseLocks = tryAcquireAuthorityLocksCore(authorityLocksRoot, namespace, lockNames, acquireLock);
    if (releaseLocks === null) return null;
    const state: AuthorityLockLeaseState = {
        authorityLocksRoot,
        namespace,
        lockNames: [...lockNames],
        released: false,
        releaseLocks,
    };
    const proof = Object.freeze({}) as AuthorityLockLeaseProof;
    const lease = Object.freeze({
        proof,
        release() {
            if (state.released) return;
            state.released = true;
            state.releaseLocks();
        },
    }) as AuthorityLockLease;
    AUTHORITY_LOCK_LEASES.set(proof, state);
    return lease;
}

function sameLockNames(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireLockComponent(value: string, label: string): void {
    if (!LOCK_COMPONENT.test(value)) {
        throw new Error(`${label} must be one safe path component`);
    }
}

function ensureLockDirectory(authorityLocksRoot: string, child: string): string {
    durableEnsureDirectory(path.dirname(authorityLocksRoot), path.basename(authorityLocksRoot));
    durableEnsureDirectory(authorityLocksRoot, child);
    return path.join(authorityLocksRoot, child);
}

function releaseAll(releases: Array<() => void>): void {
    for (const release of releases.reverse()) release();
}
