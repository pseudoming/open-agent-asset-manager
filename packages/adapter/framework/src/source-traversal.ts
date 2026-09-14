/** Bounded Core-port traversal and terminal handle-disposition accounting. */

import type {
    AdapterAssetSourceCapability,
    AdapterProviderReadInput,
    AssetKind,
    OperationDiagnostic,
    ProviderReadEntryDisposition,
    ReadEntryHandle,
    SourceReadObligation,
} from "@oaam/core";
import { compareCodeUnitText, decodeUtf8Strict } from "./source-text";
import { canIgnoreManagedSourceEntry } from "./source-managed-entry";
import type {
    ReferencedSourceFileReadResult,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceScanResultBase,
} from "./source-model";

type NoExtension = Record<never, never>;

export interface SourceTraversalPolicy<Context> {
    shouldEnterDirectory(kind: AssetKind, context: Context, relativePath: string): boolean;
    shouldReadFile(kind: AssetKind, context: Context, relativePath: string): boolean;
    /** True only for a whole independent source unit, never a resource inside another asset. */
    isIndependentSourceEntry?(
        kind: AssetKind,
        context: Context,
        entry: ReadEntryHandle,
        ancestorFiles: readonly ReadEntryHandle[],
    ): boolean;
    dispositionId(handle: ReadEntryHandle): string;
    rootEntryKindDiagnostic(context: Context, expectedKind: ReadEntryHandle["entryKind"]): OperationDiagnostic;
    mechanismNotCallableDiagnostic(context: Context, capability: AdapterAssetSourceCapability): OperationDiagnostic;
    onFileReadFailure?(relativePath: string): void;
    onDirectoryReadFailure?(relativePath: string): void;
}

export async function traverseSourceRead<
    Context extends SourceContextBase<string, object>,
    Extension extends object = NoExtension,
>(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    capability: AdapterAssetSourceCapability,
    context: Context,
    policy: SourceTraversalPolicy<Context>,
    extension?: Extension,
): Promise<SourceScanResultBase<SourceFileRecord, SourceDirectoryRecord, Extension>> {
    const dispositionByHandle = new Map<string, ProviderReadEntryDisposition>();
    const result: SourceScanResultBase<SourceFileRecord, SourceDirectoryRecord, Extension> = {
        obligation,
        capability,
        files: [],
        directories: [],
        dispositions: [],
        observedReadEntryIds: [],
        diagnostics: [],
        hadIgnoredSource: false,
        ...(extension ?? ({} as Extension)),
        attachCandidate(candidateId, records) {
            for (const record of records) {
                const disposition = dispositionByHandle.get(record.handle.readEntryHandleId);
                if (disposition === undefined || disposition.disposition === "ignored") continue;
                if (!disposition.candidateIds.includes(candidateId)) {
                    disposition.candidateIds.push(candidateId);
                    disposition.candidateIds.sort(compareCodeUnitText);
                }
            }
        },
        ignoreRecord(record, reasonCode) {
            replaceWithIgnored(record.handle, reasonCode);
        },
        ignoreHandle(handle, reasonCode) {
            replaceWithIgnored(handle, reasonCode);
        },
        async readReferencedFile(relativePath) {
            const existing = result.files.find((file) => file.relativePath === relativePath);
            if (existing !== undefined) return { state: "succeeded", file: existing };
            const resolved = await input.readAccess.resolveEntry(
                obligation.sourceReadObligationId,
                obligation.sourceRootId,
                relativePath,
            );
            if (resolved.state !== "succeeded") {
                return { state: "failed", failureStatus: resolved.failureStatus };
            }
            if (resolved.value.entryKind !== "file") {
                replaceWithIgnored(resolved.value, "referenced_entry_not_file");
                return { state: "failed", failureStatus: "not_file", handle: resolved.value };
            }
            return readFile(resolved.value);
        },
    };

    const expectedRootKind = callableRootKind(input, capability);
    if (expectedRootKind === null) {
        result.hadIgnoredSource = true;
        result.diagnostics.push(policy.mechanismNotCallableDiagnostic(context, capability));
        return result;
    }

    const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
    if (resolved.state !== "succeeded") return result;
    if (resolved.value.entryKind !== expectedRootKind) {
        setDisposition(
            ignoredDisposition(
                resolved.value,
                expectedRootKind === "file" ? "source_root_not_file" : "source_root_not_directory",
            ),
        );
        result.diagnostics.push(policy.rootEntryKindDiagnostic(context, expectedRootKind));
        return result;
    }
    if (expectedRootKind === "file") {
        await readFile(resolved.value);
    } else {
        await visitDirectory(resolved.value);
    }
    return result;

    async function visitDirectory(handle: ReadEntryHandle, ancestorFiles: readonly ReadEntryHandle[] = []): Promise<void> {
        const listed = await input.readAccess.listDirectory(handle.readEntryHandleId);
        if (listed.state !== "succeeded") {
            policy.onDirectoryReadFailure?.(handle.relativePath);
            setDisposition(ignoredDisposition(handle, "directory_unreadable"));
            return;
        }
        const directory: SourceDirectoryRecord = {
            handle,
            observedReadEntryId: listed.value.directory.observedReadEntryId,
            relativePath: handle.relativePath,
        };
        result.directories.push(directory);
        result.observedReadEntryIds.push(directory.observedReadEntryId);
        setDisposition({
            readEntryDispositionId: policy.dispositionId(handle),
            sourceReadObligationId: obligation.sourceReadObligationId,
            readEntryHandleId: handle.readEntryHandleId,
            disposition: "traversed",
            listDirectoryOutcomeId: listed.readAccessOutcomeId,
            observedDirectoryEntryId: directory.observedReadEntryId,
            candidateIds: [],
        });

        const enclosingFiles = [...ancestorFiles, ...listed.value.children.filter((child) => child.entryKind === "file")];
        for (const child of [...listed.value.children].sort(compareHandle)) {
            const selected =
                child.entryKind === "directory"
                    ? policy.shouldEnterDirectory(capability.assetKind, context, child.relativePath)
                    : policy.shouldReadFile(capability.assetKind, context, child.relativePath);
            if (!selected) {
                setDisposition(ignoredDisposition(child, "outside_source_pattern"));
                continue;
            }
            if (
                canIgnoreManagedSourceEntry(input.managedTargetGuards, child) &&
                policy.isIndependentSourceEntry?.(capability.assetKind, context, child, enclosingFiles) === true
            ) {
                setDisposition(ignoredDisposition(child, "oaam_managed_source_entry"));
                result.diagnostics.push({
                    severity: "info",
                    code: "read.managed_source_entry_ignored",
                    message: "This complete source entry is already managed by OAAM; review its changes through its managed use.",
                    path: child.relativePath,
                    traceId: "",
                    operation: "read",
                    causeKind: "conflict",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "",
                });
                continue;
            }
            if (child.entryKind === "directory") await visitDirectory(child, enclosingFiles);
            else await readFile(child);
        }
    }

    async function readFile(handle: ReadEntryHandle): Promise<ReferencedSourceFileReadResult<SourceFileRecord>> {
        const read = await input.readAccess.readFile(handle.readEntryHandleId);
        if (read.state !== "succeeded") {
            policy.onFileReadFailure?.(handle.relativePath);
            setDisposition(ignoredDisposition(handle, "file_unreadable"));
            return { state: "failed", failureStatus: read.failureStatus, handle };
        }
        const bytes = new Uint8Array(read.value.bytes);
        const file: SourceFileRecord = {
            handle,
            observedReadEntryId: read.value.entry.observedReadEntryId,
            relativePath: handle.relativePath,
            bytes,
            executable: read.value.entry.executable,
            text: decodeUtf8Strict(bytes),
        };
        result.files.push(file);
        result.observedReadEntryIds.push(file.observedReadEntryId);
        setDisposition({
            readEntryDispositionId: policy.dispositionId(handle),
            sourceReadObligationId: obligation.sourceReadObligationId,
            readEntryHandleId: handle.readEntryHandleId,
            disposition: "parsed",
            readAccessOutcomeId: read.readAccessOutcomeId,
            observedReadEntryIds: [file.observedReadEntryId],
            candidateIds: [],
        });
        return { state: "succeeded", file };
    }

    function ignoredDisposition(handle: ReadEntryHandle, reasonCode: string): ProviderReadEntryDisposition {
        return {
            readEntryDispositionId: policy.dispositionId(handle),
            sourceReadObligationId: obligation.sourceReadObligationId,
            readEntryHandleId: handle.readEntryHandleId,
            disposition: "ignored",
            reasonCode,
        };
    }

    function replaceWithIgnored(handle: ReadEntryHandle, reasonCode: string): void {
        const current = dispositionByHandle.get(handle.readEntryHandleId);
        if (current?.disposition === "ignored") return;
        setDisposition(ignoredDisposition(handle, reasonCode));
    }

    function setDisposition(disposition: ProviderReadEntryDisposition): void {
        const current = dispositionByHandle.get(disposition.readEntryHandleId);
        if (current === undefined) {
            result.dispositions.push(disposition);
        } else {
            result.dispositions[result.dispositions.indexOf(current)] = disposition;
        }
        dispositionByHandle.set(disposition.readEntryHandleId, disposition);
        if (disposition.disposition === "ignored") result.hadIgnoredSource = true;
    }
}

function callableRootKind(
    input: AdapterProviderReadInput,
    capability: AdapterAssetSourceCapability,
): ReadEntryHandle["entryKind"] | null {
    if (capability.entrySupportStatus !== "supported") return null;
    if (capability.readPolicy === "report_only") return null;
    if (
        capability.readPolicy === "user_selected_root_only" &&
        input.target.sourceSelector.selectorKind !== "user_selected_root"
    ) {
        return null;
    }
    switch (capability.sourcePathMechanism) {
        case "fixed_file":
        case "manifest_declared":
            return "file";
        case "directory_entry":
        case "recursive_entry":
            return "directory";
        case "unknown":
            return null;
    }
}

function compareHandle(left: ReadEntryHandle, right: ReadEntryHandle): number {
    return compareCodeUnitText(left.relativePath, right.relativePath);
}
