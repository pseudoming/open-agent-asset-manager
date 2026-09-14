/**
 * Core-owned, descriptor-safe read port for adapter source parsing.
 *
 * Providers receive opaque handles only. Absolute paths, filesystem APIs,
 * physical identities, ledgers, locks, and final stable-closure validation
 * remain owned by Core.
 */

import { inventoryDirectoryNoFollow, readRegularFileNoFollow, readRegularFilesNoFollow } from "@oaam/shared/filesystem";
import type {
    AdapterAssetSourceCapability,
    AdapterReadAccess,
    ExternalAttestationRequest,
    ExternalAttestationResult,
    ManagedTargetReadGuard,
    ObservedReadEntry,
    OperationDiagnostic,
    Platform,
    ReadAccessOutcome,
    ReadAccessOutcomeStatus,
    ReadAccessResult,
    ReadEntryHandle,
    Sha256Digest,
    SourceReadObligation,
    SourceRoot,
} from "../types";
import { acquireAllLocks, computePhysicalAccessClosureKeys } from "../foundation/physical-path-locks";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { isCanonicalRelativePath } from "../foundation/validators";
import {
    AdapterReadBudget,
    DEFAULT_ADAPTER_READ_OPERATION_LIMITS,
    ReadAccessFailure,
    type AdapterReadOperationLimits,
} from "./adapter-read-budget";
import { normalizeReadFailure, readDiagnostic, readFailureDiagnostic } from "./adapter-read-diagnostics";
import {
    absoluteEntryPath,
    directoryInventoryFingerprint,
    joinRelative,
    physicalIdentityFingerprint,
    requireCurrentAuthority,
    requireIdentity,
    resolveChildIdentity,
    resolveRootIdentity,
    stableClosurePass,
    withPhysicalLock,
    withPhysicalPathLock,
    type LockBatch,
    type ReadAuthorityRevalidator,
    type ReadFilesystem,
} from "./adapter-read-physical-authority";
import { rejectManagedTarget } from "./adapter-read-managed-target";

export { DEFAULT_ADAPTER_READ_OPERATION_LIMITS } from "./adapter-read-budget";
export type { AdapterReadOperationLimits } from "./adapter-read-budget";
export { isManagedTargetPath } from "./adapter-read-managed-target";
export type { ReadAuthorityRevalidator } from "./adapter-read-physical-authority";

export interface CreateAdapterReadOperationInput {
    platform: Platform;
    sourceRoots: SourceRoot[];
    sourceReadObligations: SourceReadObligation[];
    sourceCapabilities: AdapterAssetSourceCapability[];
    managedTargetGuards: ManagedTargetReadGuard[];
    readAuthorityFingerprint: Sha256Digest;
    transactionsRoot: string;
    /** Internal/test override; providers never receive or control this authority. */
    limits?: AdapterReadOperationLimits;
}

export interface AdapterReadLedgerSnapshot {
    handles: ReadEntryHandle[];
    outcomes: ReadAccessOutcome[];
    entries: ObservedReadEntry[];
    /** Internal validation payloads; never projected into AdapterReadResult. */
    filePayloads: Array<{ observedReadEntryId: string; bytes: Uint8Array }>;
}

export interface AdapterReadFinalValidation {
    valid: boolean;
    diagnostics: OperationDiagnostic[];
}

export interface AdapterReadOperation {
    readAccess: AdapterReadAccess;
    snapshot(): AdapterReadLedgerSnapshot;
    finalValidate(): AdapterReadFinalValidation;
}

interface HandleRecord {
    handle: ReadEntryHandle;
    rootPath: string;
    absolutePath: string;
    physicalIdentityFingerprint: Sha256Digest;
    consumed: boolean;
}

interface ObservedRecord {
    handleId: string;
    entry: ObservedReadEntry;
    bytes?: Uint8Array;
}

export function createAdapterReadOperation(
    input: CreateAdapterReadOperationInput,
    revalidateAuthority: ReadAuthorityRevalidator,
): AdapterReadOperation {
    return createOperation(
        input,
        {
            readRegularFileNoFollow,
            readRegularFilesNoFollow,
            inventoryDirectoryNoFollow,
        },
        acquireAllLocks,
        revalidateAuthority,
    );
}

/** @internal The restricted source service retains this operation and supplies an exact Host-held physical authority. */
export function createAdapterReadOperationWithPhysicalAuthority(
    input: CreateAdapterReadOperationInput,
    filesystem: ReadFilesystem,
    lockBatch: LockBatch,
    revalidateAuthority: ReadAuthorityRevalidator,
): AdapterReadOperation {
    return createOperation(input, filesystem, lockBatch, revalidateAuthority);
}

/** Test-only fault seam; architecture tests forbid production imports. */
export function createAdapterReadOperationForTest(
    input: CreateAdapterReadOperationInput,
    filesystem: ReadFilesystem,
    lockBatch: LockBatch,
    revalidateAuthority: ReadAuthorityRevalidator = () => true,
): AdapterReadOperation {
    return createOperation(input, filesystem, lockBatch, revalidateAuthority);
}

function createOperation(
    sourceInput: CreateAdapterReadOperationInput,
    filesystem: ReadFilesystem,
    lockBatch: LockBatch,
    revalidateAuthority: ReadAuthorityRevalidator,
): AdapterReadOperation {
    // The operation owns one immutable authority snapshot. Callers and providers
    // must not be able to rewrite roots/guards while an asynchronous read is in
    // flight and thereby change what the final closure validator judges.
    const input = structuredClone(sourceInput);
    const budget = new AdapterReadBudget(input.limits ?? DEFAULT_ADAPTER_READ_OPERATION_LIMITS);
    const limits = budget.limits;
    const roots = new Map(input.sourceRoots.map((root) => [root.sourceRootId, root]));
    const obligations = new Map(input.sourceReadObligations.map((obligation) => [obligation.sourceReadObligationId, obligation]));
    const capabilities = new Map(
        input.sourceCapabilities.map((capability) => [capability.sourceCapabilityFingerprint, capability]),
    );
    const handles = new Map<string, HandleRecord>();
    const outcomes: ReadAccessOutcome[] = [];
    const observed: ObservedRecord[] = [];
    let handleSequence = 0;
    let outcomeSequence = 0;
    let entrySequence = 0;
    const normalizeOperationFailure = (error: unknown): ReadAccessFailure => {
        return budget.latch(normalizeReadFailure(error));
    };

    const nextId = (kind: "handle" | "outcome" | "entry"): string => {
        const sequence = kind === "handle" ? ++handleSequence : kind === "outcome" ? ++outcomeSequence : ++entrySequence;
        return `${input.readAuthorityFingerprint}:${kind}:${sequence}`;
    };

    const appendResolveFailure = (
        operation: "resolve_root" | "resolve_entry",
        obligationId: string,
        rootId: string,
        relativePath: string,
        failure: ReadAccessFailure,
    ): ReadAccessResult<ReadEntryHandle> => {
        const outcomeId = nextId("outcome");
        const diagnostics = [readFailureDiagnostic(failure)];
        outcomes.push({
            readAccessOutcomeId: outcomeId,
            sourceReadObligationId: obligationId,
            sourceRootId: rootId,
            relativePath,
            status: failure.status,
            observedReadEntryIds: [],
            diagnostics,
            operation,
            producedReadEntryHandleIds: [],
        });
        return structuredClone({
            state: "failed",
            readAccessOutcomeId: outcomeId,
            failureStatus: failure.status,
            diagnostics,
        });
    };

    const resolve = (
        operation: "resolve_root" | "resolve_entry",
        obligationId: string,
        rootId: string,
        relativePath: string,
    ): ReadAccessResult<ReadEntryHandle> => {
        try {
            budget.requireOpen();
            const obligation = obligations.get(obligationId);
            const root = roots.get(rootId);
            if (obligation === undefined || obligation.sourceRootId !== rootId || root === undefined) {
                throw new ReadAccessFailure("io_error", "read obligation/root pair is not authorized");
            }
            if (operation === "resolve_entry" && !isCanonicalRelativePath(relativePath)) {
                throw new ReadAccessFailure("io_error", "relative path is not canonical POSIX-relative");
            }
            budget.requirePathDepth(relativePath);
            budget.requireIssuedHandleCapacity(1);
            rejectManagedTarget(input.managedTargetGuards, rootId, relativePath);
            const capability = capabilities.get(obligation.sourceCapabilityFingerprint);
            if (capability === undefined) {
                throw new ReadAccessFailure("io_error", "read obligation capability is unavailable");
            }
            const absolutePath = absoluteEntryPath(root.path, relativePath);
            const identity = withPhysicalPathLock(input, root.path, relativePath, lockBatch, revalidateAuthority, () =>
                operation === "resolve_root"
                    ? resolveRootIdentity(filesystem, absolutePath, capability.sourcePathMechanism, limits)
                    : resolveChildIdentity(filesystem, absolutePath, limits.maxIssuedHandles),
            );
            const handle: ReadEntryHandle = {
                readEntryHandleId: nextId("handle"),
                sourceReadObligationId: obligationId,
                sourceRootId: rootId,
                relativePath,
                entryKind: identity.entryKind,
            };
            handles.set(handle.readEntryHandleId, {
                handle,
                rootPath: root.path,
                absolutePath,
                physicalIdentityFingerprint: physicalIdentityFingerprint(input.platform, identity),
                consumed: false,
            });
            budget.recordIssuedHandles(1);
            const outcomeId = nextId("outcome");
            outcomes.push({
                readAccessOutcomeId: outcomeId,
                sourceReadObligationId: obligationId,
                sourceRootId: rootId,
                relativePath,
                status: "succeeded",
                observedReadEntryIds: [],
                diagnostics: [],
                operation,
                producedReadEntryHandleIds: [handle.readEntryHandleId],
            });
            return {
                state: "succeeded",
                readAccessOutcomeId: outcomeId,
                value: structuredClone(handle),
            };
        } catch (error) {
            return appendResolveFailure(operation, obligationId, rootId, relativePath, normalizeOperationFailure(error));
        }
    };

    const listDirectory = (
        handleId: string,
    ): ReadAccessResult<{
        directory: Extract<ObservedReadEntry, { entryKind: "directory" }>;
        children: ReadEntryHandle[];
    }> => {
        const handleRecord = handles.get(handleId);
        return runHandleOperation(
            "list_directory",
            handleRecord,
            () => {
                if (handleRecord?.handle.entryKind !== "directory") {
                    throw new ReadAccessFailure("io_error", "listDirectory requires a directory handle");
                }
                budget.consumeListedDirectory();
                const inventory = withPhysicalLock(input, handleRecord, lockBatch, revalidateAuthority, () =>
                    filesystem.inventoryDirectoryNoFollow(handleRecord.absolutePath, budget.remainingIssuedHandles()),
                );
                requireIdentity(input.platform, handleRecord, inventory.identity);
                const childDefinitions = inventory.entries.map((child) => {
                    const relativePath = joinRelative(handleRecord.handle.relativePath, child.relativeName);
                    if (!isCanonicalRelativePath(relativePath)) {
                        throw new ReadAccessFailure("io_error", "directory inventory returned an invalid child name");
                    }
                    budget.requirePathDepth(relativePath);
                    return { child, relativePath };
                });
                budget.requireIssuedHandleCapacity(childDefinitions.length);
                const children = childDefinitions.map(({ child, relativePath }) => {
                    const childHandle: ReadEntryHandle = {
                        readEntryHandleId: nextId("handle"),
                        sourceReadObligationId: handleRecord.handle.sourceReadObligationId,
                        sourceRootId: handleRecord.handle.sourceRootId,
                        relativePath,
                        entryKind: child.identity.entryKind,
                    };
                    handles.set(childHandle.readEntryHandleId, {
                        handle: childHandle,
                        rootPath: handleRecord.rootPath,
                        absolutePath: absoluteEntryPath(handleRecord.rootPath, relativePath),
                        physicalIdentityFingerprint: physicalIdentityFingerprint(input.platform, child.identity),
                        consumed: false,
                    });
                    return childHandle;
                });
                budget.recordIssuedHandles(children.length);
                const entry: Extract<ObservedReadEntry, { entryKind: "directory" }> = {
                    observedReadEntryId: nextId("entry"),
                    sourceRootId: handleRecord.handle.sourceRootId,
                    relativePath: handleRecord.handle.relativePath,
                    entryKind: "directory",
                    physicalIdentityFingerprint: handleRecord.physicalIdentityFingerprint,
                    directoryInventoryFingerprint: directoryInventoryFingerprint(
                        handleRecord.handle.sourceRootId,
                        handleRecord.handle.relativePath,
                        input.platform,
                        inventory,
                    ),
                };
                observed.push({ handleId, entry });
                return {
                    value: { directory: entry, children },
                    entryIds: [entry.observedReadEntryId],
                };
            },
            (outcomeId, result, entryIds) => ({
                readAccessOutcomeId: outcomeId,
                sourceReadObligationId: result.handle.sourceReadObligationId,
                sourceRootId: result.handle.sourceRootId,
                relativePath: result.handle.relativePath,
                status: "succeeded",
                observedReadEntryIds: entryIds,
                diagnostics: [],
                operation: "list_directory",
                subjectReadEntryHandleId: handleId,
                producedReadEntryHandleIds: result.value.children.map((child) => child.readEntryHandleId),
            }),
        );
    };

    const readFile = (
        handleId: string,
    ): ReadAccessResult<{
        entry: Extract<ObservedReadEntry, { entryKind: "file" }>;
        bytes: Uint8Array;
    }> => {
        const handleRecord = handles.get(handleId);
        return runHandleOperation(
            "read_file",
            handleRecord,
            () => {
                if (handleRecord?.handle.entryKind !== "file") {
                    throw new ReadAccessFailure("io_error", "readFile requires a file handle");
                }
                budget.consumeReadFile();
                const remainingBytes = budget.remainingReadBytes();
                const file = withPhysicalLock(input, handleRecord, lockBatch, revalidateAuthority, () =>
                    filesystem.readRegularFileNoFollow(handleRecord.absolutePath, remainingBytes),
                );
                requireIdentity(input.platform, handleRecord, file.identity);
                budget.consumeReadBytes(file.bytes.byteLength);
                const entry: Extract<ObservedReadEntry, { entryKind: "file" }> = {
                    observedReadEntryId: nextId("entry"),
                    sourceRootId: handleRecord.handle.sourceRootId,
                    relativePath: handleRecord.handle.relativePath,
                    entryKind: "file",
                    contentHash: sha256Bytes(file.bytes),
                    executable: file.executable,
                    physicalIdentityFingerprint: handleRecord.physicalIdentityFingerprint,
                };
                observed.push({ handleId, entry, bytes: new Uint8Array(file.bytes) });
                return {
                    value: { entry, bytes: file.bytes },
                    entryIds: [entry.observedReadEntryId],
                };
            },
            (outcomeId, result, entryIds) => ({
                readAccessOutcomeId: outcomeId,
                sourceReadObligationId: result.handle.sourceReadObligationId,
                sourceRootId: result.handle.sourceRootId,
                relativePath: result.handle.relativePath,
                status: "succeeded",
                observedReadEntryIds: entryIds,
                diagnostics: [],
                operation: "read_file",
                subjectReadEntryHandleId: handleId,
                producedReadEntryHandleIds: [],
            }),
        );
    };

    function runHandleOperation<T>(
        operation: "list_directory" | "read_file",
        handleRecord: HandleRecord | undefined,
        perform: () => { value: T; entryIds: string[] },
        successOutcome: (
            outcomeId: string,
            result: { handle: ReadEntryHandle; value: T },
            entryIds: string[],
        ) => ReadAccessOutcome,
    ): ReadAccessResult<T> {
        const outcomeId = nextId("outcome");
        try {
            budget.requireOpen();
            if (handleRecord === undefined) {
                throw new ReadAccessFailure("io_error", "read handle is unknown");
            }
            if (handleRecord.consumed) {
                throw new ReadAccessFailure("io_error", "read handle was already consumed");
            }
            rejectManagedTarget(input.managedTargetGuards, handleRecord.handle.sourceRootId, handleRecord.handle.relativePath);
            const performed = perform();
            handleRecord.consumed = true;
            outcomes.push(successOutcome(outcomeId, { handle: handleRecord.handle, value: performed.value }, performed.entryIds));
            return {
                state: "succeeded",
                readAccessOutcomeId: outcomeId,
                value: structuredClone(performed.value),
            };
        } catch (error) {
            const failure = normalizeOperationFailure(error);
            const handle = handleRecord?.handle;
            const diagnostics = [readFailureDiagnostic(failure)];
            outcomes.push({
                readAccessOutcomeId: outcomeId,
                sourceReadObligationId: handle?.sourceReadObligationId ?? "",
                sourceRootId: handle?.sourceRootId ?? "",
                relativePath: handle?.relativePath ?? "",
                status: failure.status,
                observedReadEntryIds: [],
                diagnostics,
                operation,
                subjectReadEntryHandleId: handle?.readEntryHandleId ?? "",
                producedReadEntryHandleIds: [],
            });
            return structuredClone({
                state: "failed",
                readAccessOutcomeId: outcomeId,
                failureStatus: failure.status,
                diagnostics,
            });
        }
    }

    const finalValidate = (): AdapterReadFinalValidation => {
        const diagnostics: OperationDiagnostic[] = [];
        let finalFailureStatus: Exclude<ReadAccessOutcomeStatus, "succeeded"> | undefined;
        const records = [...observed];
        if (budget.terminalFailure !== undefined) {
            diagnostics.push(readFailureDiagnostic(budget.terminalFailure));
            appendFinalFailure(records, budget.terminalFailure.status, diagnostics);
            return { valid: false, diagnostics };
        }
        const targetsByRoot = new Map<
            string,
            Array<{
                relativePath: string;
                entryKind: "file" | "directory";
            }>
        >();
        for (const record of records) {
            const handle = handles.get(record.handleId) as HandleRecord;
            const targets = targetsByRoot.get(handle.rootPath) ?? [];
            targets.push({
                relativePath: handle.handle.relativePath,
                entryKind: handle.handle.entryKind,
            });
            targetsByRoot.set(handle.rootPath, targets);
        }
        const keys = [
            ...new Set(
                [...targetsByRoot.entries()].flatMap(([rootPath, targets]) =>
                    computePhysicalAccessClosureKeys(input.platform, rootPath, targets),
                ),
            ),
        ].sort();
        let lock: { release(): void } | null;
        try {
            lock = lockBatch(input.transactionsRoot, [...new Set(keys)].sort());
        } catch (error) {
            diagnostics.push(readDiagnostic("read_final_lock_failed", String(error), "io_error"));
            appendFinalFailure(records, "io_error", diagnostics);
            return { valid: false, diagnostics };
        }
        if (lock === null) {
            diagnostics.push(readDiagnostic("read_final_lock_busy", "stable closure is busy", "busy"));
            appendFinalFailure(records, "busy", diagnostics);
            return { valid: false, diagnostics };
        }
        try {
            requireCurrentAuthority(revalidateAuthority);
            const subjects = records.map((record) => ({
                handle: handles.get(record.handleId) as HandleRecord,
                expected: record.entry,
                byteSize: record.entry.entryKind === "file" ? (record.bytes as Uint8Array).byteLength : 0,
            }));
            const firstPass = stableClosurePass(filesystem, input.platform, subjects, limits);
            for (const [index, record] of records.entries()) {
                if (!firstPass[index]) {
                    diagnostics.push(
                        readDiagnostic(
                            "read_final_stale",
                            `stable closure changed: ${record.entry.sourceRootId}/${record.entry.relativePath}`,
                            "stale",
                        ),
                    );
                }
            }
            const secondPass = stableClosurePass(filesystem, input.platform, subjects, limits);
            for (const [index, record] of records.entries()) {
                if (!secondPass[index]) {
                    diagnostics.push(
                        readDiagnostic(
                            "read_final_stale",
                            `second stable pass changed: ${record.entry.sourceRootId}/${record.entry.relativePath}`,
                            "stale",
                        ),
                    );
                }
            }
        } catch (error) {
            const failure = normalizeOperationFailure(error);
            finalFailureStatus = failure.status;
            diagnostics.push(
                failure.status === "resource_limit_exceeded"
                    ? readFailureDiagnostic(failure)
                    : readDiagnostic("read_final_failed", failure.message, failure.status),
            );
        } finally {
            lock.release();
        }
        const valid = diagnostics.length === 0;
        for (const record of records) {
            const handle = handles.get(record.handleId) as HandleRecord;
            outcomes.push({
                readAccessOutcomeId: nextId("outcome"),
                sourceReadObligationId: handle.handle.sourceReadObligationId,
                sourceRootId: handle.handle.sourceRootId,
                relativePath: handle.handle.relativePath,
                status: valid ? "succeeded" : (finalFailureStatus ?? "stale"),
                observedReadEntryIds: [record.entry.observedReadEntryId],
                diagnostics: valid ? [] : diagnostics,
                operation: "final_validate",
                subjectReadEntryHandleId: handle.handle.readEntryHandleId,
                producedReadEntryHandleIds: [],
            });
        }
        return { valid, diagnostics };
    };

    const appendFinalFailure = (
        records: ObservedRecord[],
        status: Exclude<ReadAccessOutcomeStatus, "succeeded">,
        diagnostics: OperationDiagnostic[],
    ): void => {
        for (const record of records) {
            const handle = handles.get(record.handleId) as HandleRecord;
            outcomes.push({
                readAccessOutcomeId: nextId("outcome"),
                sourceReadObligationId: handle.handle.sourceReadObligationId,
                sourceRootId: handle.handle.sourceRootId,
                relativePath: handle.handle.relativePath,
                status,
                observedReadEntryIds: [record.entry.observedReadEntryId],
                diagnostics,
                operation: "final_validate",
                subjectReadEntryHandleId: handle.handle.readEntryHandleId,
                producedReadEntryHandleIds: [],
            });
        }
    };

    return {
        readAccess: {
            resolveRootEntry: async (obligationId, rootId) => resolve("resolve_root", obligationId, rootId, ""),
            resolveEntry: async (obligationId, rootId, relativePath) =>
                resolve("resolve_entry", obligationId, rootId, relativePath),
            listDirectory: async (handleId) => listDirectory(handleId),
            readFile: async (handleId) => readFile(handleId),
            verifyExternalAttestation: async (_request: ExternalAttestationRequest): Promise<ExternalAttestationResult> => ({
                state: "failed",
                failureStatus: "unsupported_verifier",
                diagnostics: [
                    readDiagnostic(
                        "read_attestation_verifier_unavailable",
                        "no frozen external attestation verifier is installed",
                        "io_error",
                    ),
                ],
            }),
        },
        snapshot: () =>
            structuredClone({
                handles: [...handles.values()].map((record) => record.handle),
                outcomes: [...outcomes],
                entries: observed.map((record) => record.entry),
                filePayloads: observed.flatMap((record) =>
                    record.entry.entryKind === "file" && record.bytes !== undefined
                        ? [{ observedReadEntryId: record.entry.observedReadEntryId, bytes: new Uint8Array(record.bytes) }]
                        : [],
                ),
            }),
        finalValidate,
    };
}
