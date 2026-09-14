/** Whole target graph operations; Windows owns journal publication and every durable receipt. */
import { randomUUID } from "node:crypto";
import {
    confirmDurableDirectoryNoFollow,
    inspectDirectoryNoFollow,
    inspectFilesystemFailure,
    samePhysicalPathIdentity,
    type PhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import { isSelectedWslPhysicalRootMapping, physicalAccessPathContains } from "@oaam/shared/paths";
import { stableStringify } from "../foundation/fingerprint";
import { computePhysicalClosureKeys } from "../foundation/physical-path-locks";
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import {
    isValidJournal,
    isValidJournalEntry,
    type ActiveJournalV3,
    type ActiveJournalV4,
    type JournalDirectoryEntryV3,
    type JournalEntry,
} from "./deployment-journal";
import { isValidManagedDirectoryBoundaries } from "./deployment-journal-directory-validation";
import { isSelectedWslJournalExecution, type SelectedWslJournalExecution } from "./deployment-journal-execution";
import { planManagedTargetDirectories } from "./deployment-managed-directory-execution";
import { verifyManagedDirectoryGraph } from "./deployment-managed-directory-graph";
import { casWriteAll, preflightExecutableTransitions } from "./deployment-target-cas";
import { populateOldBytes } from "./deployment-target-entries";
import { recoverTargetFiles, type TargetRecoveryOutcome } from "./deployment-file-recovery";
import {
    absPath,
    cleanupTargetDirectories,
    createTargetIo,
    ensureTargetDirectory,
    removeTargetDirectories,
    restoreTargetDirectory,
} from "./deployment-target-io";
import { applyRuntimeReplacementAuthority, type DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";
import { verifyAll } from "./deployment-target-verify";
import {
    RESTRICTED_TARGET_MAX_FRAME_BYTES,
    type RestrictedTargetBinding,
    type RestrictedTargetExecutionResult,
} from "./restricted-target-contract";
import { encodeRestrictedGraphPreparation } from "./restricted-target-graph-codec";
import { planPublications } from "./deployment-publication";
import { publicationStagingRoot } from "./deployment-publication-io";
import { createRestrictedPublicationOperation } from "./restricted-target-publication-operation";

import {
    restrictedGraphJournalFingerprint,
    type RestrictedGraphPrepareInput,
    type RestrictedGraphPrepared,
    type RestrictedGraphPreparationResult,
    type RestrictedGraphStep,
} from "./restricted-target-graph-contract";
export type {
    RestrictedGraphPrepareInput,
    RestrictedGraphPrepared,
    RestrictedGraphPreparationResult,
    RestrictedGraphStep,
} from "./restricted-target-graph-contract";

export function createRestrictedTargetGraphOperation(sourceBinding: RestrictedTargetBinding) {
    const binding = structuredClone(sourceBinding);
    if (
        !hasExactKeys(binding, ["bindingId", "deploymentId", "platformInstanceId", "targetRootPath", "executionRootPath"]) ||
        !isUuidV4(binding.bindingId) ||
        !isUuidV4(binding.deploymentId) ||
        typeof binding.platformInstanceId !== "string" ||
        typeof binding.targetRootPath !== "string" ||
        typeof binding.executionRootPath !== "string" ||
        !isSelectedWslPhysicalRootMapping(binding.targetRootPath, binding.executionRootPath, binding.platformInstanceId)
    )
        throw new Error("invalid restricted graph root binding");
    const ctx = createTargetIo(binding.executionRootPath);
    const execution: SelectedWslJournalExecution = {
        kind: "selected_wsl",
        platformInstanceId: binding.platformInstanceId,
        targetRootPath: binding.targetRootPath,
        executionRootPath: binding.executionRootPath,
        rootIdentity: confirmDurableDirectoryNoFollow(binding.executionRootPath),
    };
    if (!isSelectedWslJournalExecution(execution)) throw new Error("invalid restricted graph execution binding");
    const preparations = new Map<string, RestrictedGraphPrepared>();
    const executed = new Set<string>();
    type ActiveGraphOperation = { mode: "execute" | "old" | "new"; journal: ActiveJournalV3; awaiting: ActiveJournalV3 | null };
    let active: ActiveGraphOperation | null = null;
    const publication = createRestrictedPublicationOperation(binding.executionRootPath, requireRoot);

    function requireRoot() {
        if (!samePhysicalPathIdentity(execution.rootIdentity, confirmDurableDirectoryNoFollow(binding.executionRootPath))) {
            throw new Error("restricted graph root identity changed");
        }
    }

    function requireJournal(journal: ActiveJournalV3 | ActiveJournalV4) {
        if (
            !isValidJournal(journal) ||
            (journal.schemaVersion !== 3 && journal.schemaVersion !== 4) ||
            journal.deploymentId !== binding.deploymentId ||
            stableStringify(journal.targetExecution) !== stableStringify(execution)
        )
            throw new Error("restricted graph journal execution binding mismatch");
    }

    function currentDirectory(relativePath: string): PhysicalPathIdentity | null {
        try {
            return inspectDirectoryNoFollow(absPath(ctx, relativePath));
        } catch (error) {
            if (inspectFilesystemFailure(error).failureKind === "not_found") return null;
            throw error;
        }
    }

    function requireKnownDirectory(directory: JournalDirectoryEntryV3, missingAllowed: boolean): boolean {
        const observed = currentDirectory(directory.relativePath);
        const expected =
            directory.oldState === "present" ? (directory.restoredIdentity ?? directory.oldIdentity) : directory.createdIdentity;
        if (observed === null) {
            if (!missingAllowed) throw new Error("restricted graph receipted directory disappeared");
            return false;
        }
        if (expected === null || !samePhysicalPathIdentity(observed, expected)) {
            throw new Error("restricted graph directory has no matching durable identity");
        }
        return true;
    }

    function graphMatches(journal: ActiveJournalV3, side: "old" | "new") {
        return verifyManagedDirectoryGraph({
            targetRootPath: binding.executionRootPath,
            boundaries: journal.managedDirectoryBoundaries,
            files: journal.entries,
            directories: journal.directoryEntries,
            side,
        });
    }

    function requireReceipt(
        operation: ActiveGraphOperation,
        journal: ActiveJournalV3,
        relativePath: string,
        identity: PhysicalPathIdentity,
        side: "old" | "new",
    ): RestrictedGraphStep {
        const field = side === "old" ? "restoredIdentity" : "createdIdentity";
        operation.awaiting = {
            ...journal,
            directoryEntries: journal.directoryEntries.map((entry) =>
                entry.relativePath === relativePath ? { ...entry, [field]: structuredClone(identity) } : entry,
            ),
        };
        requireRoot();
        return {
            kind: "directory_receipt_required",
            side,
            journalFingerprint: restrictedGraphJournalFingerprint(journal),
            relativePath,
            identity: structuredClone(identity),
        };
    }

    // Public entrypoints create this operation or verify and clear its durable receipt
    // immediately before advancing. All graph IO and receipt creation below are synchronous.
    function advance(operation: ActiveGraphOperation): RestrictedGraphStep {
        const { journal, mode } = operation;
        requireRoot();
        let result: RestrictedGraphStep;
        if (mode === "old") {
            // Validate the entire retained identity set before restoring any file.
            // An unreceipted present directory cannot be adopted or removed.
            try {
                for (const directory of journal.directoryEntries) {
                    const missingAllowed =
                        directory.oldState === "missing" ||
                        (directory.desiredState === "missing" && directory.restoredIdentity === null);
                    requireKnownDirectory(directory, missingAllowed);
                }
                for (const directory of journal.directoryEntries.filter((entry) => entry.oldState === "present")) {
                    if (
                        requireKnownDirectory(
                            directory,
                            directory.desiredState === "missing" && directory.restoredIdentity === null,
                        )
                    )
                        continue;
                    const restored = restoreTargetDirectory(ctx, directory);
                    if (!restored.created) throw new Error("restricted graph restoration lost its identity");
                    return requireReceipt(operation, journal, directory.relativePath, restored.identity, "old");
                }
            } catch {
                result = { kind: "recovered", outcome: "third_value" };
                return finish(result);
            }
            const outcome = recoverTargetFiles(ctx, journal.entries, "old");
            result = {
                kind: "recovered",
                outcome:
                    outcome !== "done"
                        ? outcome
                        : cleanupTargetDirectories(ctx, journal.directoryEntries).ok && graphMatches(journal, "old")
                          ? "done"
                          : "io_failed",
            };
            return finish(result);
        }

        try {
            for (const directory of journal.directoryEntries.filter((entry) => entry.desiredState === "present")) {
                const known = directory.oldState === "present" || directory.createdIdentity !== null;
                if (known) {
                    requireKnownDirectory(directory, false);
                    continue;
                }
                if (currentDirectory(directory.relativePath) !== null) throw new Error("unreceipted directory appeared");
                const ensured = ensureTargetDirectory(ctx, directory);
                if (!ensured.created) throw new Error("restricted graph directory creation lost its identity");
                return requireReceipt(operation, journal, directory.relativePath, ensured.identity, "new");
            }
        } catch {
            return finish(
                mode === "execute"
                    ? { kind: "executed", result: { outcome: "uncertain" } }
                    : { kind: "recovered", outcome: "third_value" },
            );
        }

        if (mode === "new") {
            const outcome = recoverTargetFiles(ctx, journal.entries, "new");
            result = {
                kind: "recovered",
                outcome:
                    outcome !== "done"
                        ? outcome
                        : removeTargetDirectories(ctx, journal.directoryEntries).ok && graphMatches(journal, "new")
                          ? "done"
                          : "io_failed",
            };
        } else {
            const cas = casWriteAll(journal.entries, ctx);
            if (!cas.ok) {
                const changed = new Set(cas.mutated);
                const restored =
                    cas.stop?.kind === "third_value" &&
                    recoverTargetFiles(
                        ctx,
                        journal.entries.filter((entry) => changed.has(entry.relativePath)),
                        "old",
                    ) === "done" &&
                    cleanupTargetDirectories(ctx, journal.directoryEntries).ok;
                result = { kind: "executed", result: { outcome: restored ? "conflict" : "uncertain" } };
            } else if (!removeTargetDirectories(ctx, journal.directoryEntries).ok) {
                result = { kind: "executed", result: { outcome: "uncertain" } };
            } else {
                const verified = verifyAll(journal.entries, ctx);
                result = {
                    kind: "executed",
                    result:
                        verified.ok && graphMatches(journal, "new")
                            ? { outcome: "verified", verified: verified.verified }
                            : { outcome: "uncertain" },
                };
            }
        }
        return finish(result);
    }

    function finish(result: RestrictedGraphStep): RestrictedGraphStep {
        requireRoot();
        active = null;
        return result;
    }

    return Object.freeze({
        prepare(source: RestrictedGraphPrepareInput): RestrictedGraphPreparationResult {
            requireRoot();
            if (active !== null || preparations.size >= 8) throw new Error("restricted graph preparation is unavailable");
            const input = structuredClone(source);
            if (
                !hasExactKeys(input, [
                    "compilationFingerprint",
                    "entries",
                    "managedDirectoryBoundaries",
                    "desiredDirectoryPaths",
                    ...(input?.publicationTransactionId === undefined ? [] : ["publicationTransactionId"]),
                    ...(input?.publicationProjectRootPath === undefined ? [] : ["publicationProjectRootPath"]),
                    ...(input?.runtimeReplacementAuthority === undefined ? [] : ["runtimeReplacementAuthority"]),
                ]) ||
                !isSha256Digest(input.compilationFingerprint) ||
                (input.publicationTransactionId !== undefined && !isUuidV4(input.publicationTransactionId)) ||
                (input.runtimeReplacementAuthority?.replacementScope !== undefined &&
                    input.publicationTransactionId === undefined) ||
                (input.publicationProjectRootPath !== undefined &&
                    !physicalAccessPathContains(input.publicationProjectRootPath, binding.executionRootPath)) ||
                !Array.isArray(input.entries) ||
                !input.entries.every((entry) =>
                    isValidJournalEntry({ ...entry, entryAuthority: entry.entryAuthority ?? "managed_baseline" }, 2),
                ) ||
                new Set(input.entries.map((entry) => entry.relativePath)).size !== input.entries.length ||
                !isValidManagedDirectoryBoundaries(input.managedDirectoryBoundaries) ||
                !Array.isArray(input.desiredDirectoryPaths) ||
                !input.desiredDirectoryPaths.every(isCanonicalRelativePath) ||
                input.desiredDirectoryPaths.length > 4_096 ||
                Buffer.byteLength(JSON.stringify(encodeRestrictedGraphPreparation(input)), "utf8") >
                    RESTRICTED_TARGET_MAX_FRAME_BYTES - 16_384
            )
                throw new Error("invalid restricted graph preparation");
            if (
                input.managedDirectoryBoundaries.length > 0 &&
                (input.runtimeReplacementAuthority === undefined ||
                    stableStringify(input.runtimeReplacementAuthority.managedDirectoryBoundaryPaths) !==
                        stableStringify(input.managedDirectoryBoundaries))
            )
                throw new Error("restricted graph preparation requires the exact reviewed directory authority");
            if (populateOldBytes(input.entries, ctx).kind !== "ok") return { outcome: "unavailable" };
            if (
                input.runtimeReplacementAuthority !== undefined &&
                applyRuntimeReplacementAuthority(
                    input.entries,
                    ctx,
                    input.runtimeReplacementAuthority,
                    input.desiredDirectoryPaths,
                ).status === "conflict"
            )
                return { outcome: "conflict" };
            if (preflightExecutableTransitions(input.entries, ctx) !== null) return { outcome: "unsupported" };
            const directoryEntries = planManagedTargetDirectories(
                ctx,
                input.entries,
                input.runtimeReplacementAuthority,
                input.managedDirectoryBoundaries,
                input.desiredDirectoryPaths,
            ).map((entry) => ({ ...entry, restoredIdentity: null }));
            const publications =
                input.publicationTransactionId === undefined
                    ? undefined
                    : planPublications(
                          ctx,
                          input.entries,
                          directoryEntries,
                          input.managedDirectoryBoundaries,
                          input.runtimeReplacementAuthority?.replacementScope ?? { filePaths: [], directoryPaths: [] },
                      );
            const prepared: RestrictedGraphPrepared = {
                preparationId: randomUUID(),
                compilationFingerprint: input.compilationFingerprint,
                entries: input.entries.map((entry) => ({ ...entry, entryAuthority: entry.entryAuthority ?? "managed_baseline" })),
                managedDirectoryBoundaries: input.managedDirectoryBoundaries,
                directoryEntries,
                targetExecution: structuredClone(execution),
                ...(input.publicationTransactionId === undefined
                    ? {}
                    : {
                          publication: {
                              transactionId: input.publicationTransactionId,
                              staging: {
                                  rootPath: publicationStagingRoot(
                                      ctx,
                                      input.publicationTransactionId,
                                      publications!,
                                      input.managedDirectoryBoundaries,
                                      input.publicationProjectRootPath === undefined
                                          ? {}
                                          : { projectRootPath: input.publicationProjectRootPath },
                                  ),
                                  identity: null,
                              },
                              publications: publications!,
                          },
                      }),
            };
            const journal: ActiveJournalV3 = {
                schemaVersion: 3,
                transactionId: randomUUID(),
                deploymentId: binding.deploymentId,
                createdAt: Date.now(),
                compilationFingerprint: prepared.compilationFingerprint,
                entries: prepared.entries,
                managedDirectoryBoundaries: prepared.managedDirectoryBoundaries,
                directoryEntries,
                targetExecution: prepared.targetExecution,
                reservedPhysicalKeys: computePhysicalClosureKeys("wsl", binding.targetRootPath, [
                    ...input.entries.map((entry) => ({
                        relativePath: entry.relativePath,
                        entryKind: "file" as const,
                        containingDirectoryBoundaries: input.managedDirectoryBoundaries,
                    })),
                    ...directoryEntries.map((entry) => ({ relativePath: entry.relativePath, entryKind: "directory" as const })),
                ]),
            };
            requireJournal(journal);
            requireRoot();
            preparations.set(prepared.preparationId, structuredClone(prepared));
            return { outcome: "ready", prepared };
        },
        execute(preparationId: string, source: ActiveJournalV3 | ActiveJournalV4): RestrictedGraphStep {
            if (active !== null || publication.pending || executed.has(source.transactionId) || executed.size >= 128)
                throw new Error("restricted graph execution cannot be replayed");
            const journal = structuredClone(source);
            requireJournal(journal);
            const prepared = preparations.get(preparationId);
            if (journal.schemaVersion === 4) {
                if (
                    prepared?.publication === undefined ||
                    prepared.publication.transactionId !== journal.transactionId ||
                    journal.publicationPhase !== "preparing" ||
                    stableStringify(prepared.publication.staging) !== stableStringify(journal.staging) ||
                    stableStringify(prepared.publication.publications) !== stableStringify(journal.publications) ||
                    ["compilationFingerprint", "entries", "managedDirectoryBoundaries", "targetExecution"].some(
                        (key) =>
                            stableStringify(prepared[key as keyof RestrictedGraphPrepared]) !==
                            stableStringify(journal[key as keyof ActiveJournalV4]),
                    ) ||
                    stableStringify(prepared.directoryEntries.map(({ restoredIdentity: _restored, ...entry }) => entry)) !==
                        stableStringify(journal.directoryEntries)
                )
                    throw new Error("publication journal differs from exact preparation");
                preparations.delete(preparationId);
                executed.add(journal.transactionId);
                return publication.start(journal, "execute");
            }
            if (
                prepared === undefined ||
                prepared.publication !== undefined ||
                ["compilationFingerprint", "entries", "managedDirectoryBoundaries", "directoryEntries", "targetExecution"].some(
                    (key) =>
                        stableStringify(prepared[key as keyof RestrictedGraphPrepared]) !==
                        stableStringify(journal[key as keyof ActiveJournalV3]),
                )
            )
                throw new Error("restricted graph journal differs from its preparation");
            preparations.delete(preparationId);
            executed.add(journal.transactionId);
            active = { mode: "execute", journal, awaiting: null };
            return advance(active);
        },
        continue(source: ActiveJournalV3 | ActiveJournalV4): RestrictedGraphStep {
            requireRoot();
            requireJournal(source);
            if (source.schemaVersion === 4) return publication.continue(source);
            if (active?.awaiting === null || active === null || stableStringify(active.awaiting) !== stableStringify(source))
                throw new Error("restricted graph durable receipt does not match the pending directory");
            active.journal = structuredClone(source);
            active.awaiting = null;
            return advance(active);
        },
        recover(source: ActiveJournalV3 | ActiveJournalV4, side: "old" | "new"): RestrictedGraphStep {
            if (active !== null || publication.pending)
                throw new Error("restricted graph recovery cannot replace a pending operation");
            if (side !== "old" && side !== "new") throw new Error("invalid restricted graph recovery side");
            requireJournal(source);
            if (source.schemaVersion === 4) return publication.start(source, side);
            active = { mode: side, journal: structuredClone(source), awaiting: null };
            return advance(active);
        },
    });
}
