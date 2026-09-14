import { hasExactKeys, isUuidV4 } from "../foundation/validators";
import { stableStringify } from "../foundation/fingerprint";
import { sha256Bytes } from "../foundation/crypto-bytes";
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { isValidJournal, type ActiveJournalV3, type ActiveJournalV4 } from "./deployment-journal";
import {
    bindRestrictedPublicationChannel,
    type DeploymentTargetPublicationExecution,
} from "./restricted-target-publication-channel";
import { containsPublicationPath, isCompleteReplacementPath } from "./deployment-publication-model";
import { projectPublicationRootForBinding } from "./deployment-publication-staging";
import { isDirectoryIdentityOrNull } from "./deployment-journal-directory-validation";
import { isSelectedWslJournalExecution } from "./deployment-journal-execution";
import { managedDirectoryAncestorPaths } from "./deployment-managed-directory-graph";
import { encodeRestrictedGraphPreparation } from "./restricted-target-graph-codec";
import {
    restrictedGraphJournalFingerprint,
    type RestrictedGraphPrepareInput,
    type RestrictedGraphPreparationResult,
    type RestrictedGraphPrepared,
    type RestrictedGraphStep,
} from "./restricted-target-graph-contract";
import type { TargetRecoveryOutcome } from "./deployment-file-recovery";
import type {
    RestrictedTargetBinding,
    RestrictedTargetExecutionResult,
    RestrictedTargetOperation,
    RestrictedTargetResult,
} from "./restricted-target-contract";

type PersistDirectoryReceipt = (
    journal: ActiveJournalV3,
    relativePath: string,
    identity: PhysicalPathIdentity,
    side: "old" | "new",
) => ActiveJournalV3;

export interface DeploymentTargetGraphExecution extends DeploymentTargetPublicationExecution {
    prepare(input: RestrictedGraphPrepareInput): RestrictedGraphPreparationResult;
    execute(
        preparationId: string,
        journal: ActiveJournalV3,
        persist: PersistDirectoryReceipt,
    ): { result: RestrictedTargetExecutionResult; journal: ActiveJournalV3 };
    recover(
        journal: ActiveJournalV3,
        side: "old" | "new",
        persist: PersistDirectoryReceipt,
    ): { outcome: TargetRecoveryOutcome; journal: ActiveJournalV3 };
}

export function bindRestrictedTargetGraphChannel(
    binding: RestrictedTargetBinding,
    call: (binding: RestrictedTargetBinding, operation: RestrictedTargetOperation) => RestrictedTargetResult,
    invalidate: () => void,
): DeploymentTargetGraphExecution {
    function requireJournal(journal: ActiveJournalV3) {
        if (
            !isValidJournal(journal) ||
            journal.schemaVersion !== 3 ||
            journal.deploymentId !== binding.deploymentId ||
            journal.targetExecution.platformInstanceId !== binding.platformInstanceId ||
            journal.targetExecution.targetRootPath !== binding.targetRootPath ||
            journal.targetExecution.executionRootPath !== binding.executionRootPath
        )
            throw new Error("restricted graph journal binding mismatch");
    }

    function stepFor(operation: RestrictedTargetOperation): RestrictedGraphStep {
        const response = call(binding, operation);
        if (!hasExactKeys(response, ["kind", "step"]) || !("step" in response)) throw new Error("invalid restricted graph step");
        return response.step;
    }

    function drive(operation: RestrictedTargetOperation, source: ActiveJournalV3, persist: PersistDirectoryReceipt) {
        let journal = structuredClone(source);
        try {
            requireJournal(journal);
            let step = stepFor(operation);
            let receipts = 0;
            while (step?.kind === "directory_receipt_required") {
                const receipt = step;
                if (
                    !hasExactKeys(step, ["kind", "side", "journalFingerprint", "relativePath", "identity"]) ||
                    (step.side !== "old" && step.side !== "new") ||
                    (step.side === "old" && !(operation.kind === "recover_graph" && operation.side === "old")) ||
                    (step.side === "new" && operation.kind === "recover_graph" && operation.side === "old") ||
                    step.journalFingerprint !== restrictedGraphJournalFingerprint(journal) ||
                    step.identity === null ||
                    !isDirectoryIdentityOrNull(step.identity) ||
                    ++receipts > source.directoryEntries.length
                )
                    throw new Error("invalid restricted graph directory receipt");
                const entry = journal.directoryEntries.find((entry) => entry.relativePath === receipt.relativePath);
                const pending =
                    step.side === "old"
                        ? entry?.oldState === "present" && entry.desiredState === "missing" && entry.restoredIdentity === null
                        : entry?.oldState === "missing" && entry.desiredState === "present" && entry.createdIdentity === null;
                if (!pending) throw new Error("unrequested restricted graph directory receipt");
                const field = step.side === "old" ? "restoredIdentity" : "createdIdentity";
                const expected = {
                    ...journal,
                    directoryEntries: journal.directoryEntries.map((entry) =>
                        entry.relativePath === receipt.relativePath ? { ...entry, [field]: receipt.identity } : entry,
                    ),
                };
                const updated = persist(journal, step.relativePath, structuredClone(step.identity), step.side);
                if (stableStringify(updated) !== stableStringify(expected))
                    throw new Error("durable directory receipt did not return exactly");
                requireJournal(updated);
                journal = structuredClone(updated);
                step = stepFor({ kind: "continue_graph", journal });
            }
            return { step, journal };
        } catch {
            invalidate();
            return { step: null, journal };
        }
    }

    return Object.freeze<DeploymentTargetGraphExecution>({
        ...bindRestrictedPublicationChannel(binding, stepFor, invalidate, validExecutionResult),
        prepare(input: RestrictedGraphPrepareInput): RestrictedGraphPreparationResult {
            try {
                const { publicationProjectRootPath: projectRoot, ...rest } = input;
                const projected = projectRoot === undefined ? undefined : projectPublicationRootForBinding(projectRoot, binding);
                const requestInput = { ...rest, ...(projected === undefined ? {} : { publicationProjectRootPath: projected }) };
                const response = call(binding, { kind: "prepare_graph", input: encodeRestrictedGraphPreparation(requestInput) });
                if (response.kind !== "prepare_graph" || !hasExactKeys(response, ["kind", "result"]))
                    throw new Error("invalid restricted graph preparation response");
                const result = response.result;
                if (result?.outcome !== "ready") {
                    if (hasExactKeys(result, ["outcome"]) && ["unavailable", "unsupported", "conflict"].includes(result.outcome))
                        return result;
                    throw new Error("invalid restricted graph preparation outcome");
                }
                if (!hasExactKeys(result, ["outcome", "prepared"]) || !validPreparation(result.prepared, input, binding))
                    throw new Error("restricted graph preparation differs from its authority");
                return structuredClone(result);
            } catch {
                invalidate();
                return { outcome: "unavailable" };
            }
        },
        execute(preparationId, journal, persist) {
            const result = drive({ kind: "execute_graph", preparationId, journal }, journal, persist);
            if (
                result.step?.kind !== "executed" ||
                !hasExactKeys(result.step, ["kind", "result"]) ||
                !validExecutionResult(result.step.result, result.journal)
            ) {
                invalidate();
                return { result: { outcome: "uncertain" }, journal: result.journal };
            }
            return { result: result.step.result, journal: result.journal };
        },
        recover(journal, side, persist) {
            const result = drive({ kind: "recover_graph", journal, side }, journal, persist);
            if (
                result.step?.kind !== "recovered" ||
                !hasExactKeys(result.step, ["kind", "outcome"]) ||
                !["done", "third_value", "io_failed"].includes(result.step.outcome)
            ) {
                invalidate();
                return { outcome: "io_failed", journal: result.journal };
            }
            return { outcome: result.step.outcome, journal: result.journal };
        },
    });
}

function validPreparation(
    prepared: RestrictedGraphPrepared,
    input: RestrictedGraphPrepareInput,
    binding: RestrictedTargetBinding,
) {
    if (
        !hasExactKeys(prepared, [
            "preparationId",
            "compilationFingerprint",
            "entries",
            "managedDirectoryBoundaries",
            "directoryEntries",
            "targetExecution",
            ...(prepared?.publication === undefined ? [] : ["publication"]),
        ]) ||
        !isUuidV4(prepared.preparationId) ||
        prepared.compilationFingerprint !== input.compilationFingerprint ||
        !isSelectedWslJournalExecution(prepared.targetExecution) ||
        prepared.targetExecution.platformInstanceId !== binding.platformInstanceId ||
        prepared.targetExecution.targetRootPath !== binding.targetRootPath ||
        prepared.targetExecution.executionRootPath !== binding.executionRootPath ||
        stableStringify(prepared.managedDirectoryBoundaries) !== stableStringify(input.managedDirectoryBoundaries) ||
        !Array.isArray(prepared.entries) ||
        prepared.entries.length !== input.entries.length ||
        !Array.isArray(prepared.directoryEntries) ||
        prepared.directoryEntries.some((entry) => entry.createdIdentity !== null || entry.restoredIdentity !== null)
    )
        return false;
    const authorityByPath = new Map(input.runtimeReplacementAuthority?.files.map((file) => [file.relativePath, file]));
    for (let index = 0; index < input.entries.length; index++) {
        const source = input.entries[index]!;
        const authority = authorityByPath.get(source.relativePath);
        const expected = {
            ...source,
            entryAuthority: source.entryAuthority ?? "managed_baseline",
            ...(authority === undefined
                ? {}
                : {
                      runtimeRollbackOverride:
                          authority.expectedState === "missing"
                              ? { state: "missing" }
                              : {
                                    state: "present",
                                    contentHash: sha256Bytes(authority.expectedBytes),
                                    bytesBase64: Buffer.from(authority.expectedBytes).toString("base64"),
                                    executable: authority.expectedExecutable,
                                },
                  }),
        };
        const scope = input.runtimeReplacementAuthority?.replacementScope;
        if (scope !== undefined && isCompleteReplacementPath(scope, source.relativePath)) {
            const { runtimeRollbackOverride: _expectedCurrent, ...expectedAuthority } = expected;
            const { runtimeRollbackOverride, ...actualAuthority } = prepared.entries[index]!;
            if (runtimeRollbackOverride === undefined || stableStringify(actualAuthority) !== stableStringify(expectedAuthority))
                return false;
        } else if (stableStringify(prepared.entries[index]) !== stableStringify(expected)) return false;
    }
    const desired = new Set(input.desiredDirectoryPaths);
    for (const entry of input.entries.filter((entry) => !entry.isRemoval)) {
        const boundary = input.managedDirectoryBoundaries.find((boundary) => entry.relativePath.startsWith(`${boundary}/`));
        const segments = entry.relativePath.split("/");
        segments.pop();
        let current = "";
        for (const segment of segments) {
            current = current === "" ? segment : `${current}/${segment}`;
            if (boundary === undefined || current === boundary || current.startsWith(`${boundary}/`)) desired.add(current);
        }
    }
    const structuralParents = new Set(
        managedDirectoryAncestorPaths(input.managedDirectoryBoundaries.filter((boundary) => desired.has(boundary))),
    );
    const expectedRemoved = [...(input.runtimeReplacementAuthority?.directoryRemovalPaths ?? [])]
        .filter(
            (relativePath) =>
                !input.runtimeReplacementAuthority?.replacementScope?.directoryPaths.some((parent) =>
                    containsPublicationPath(parent, relativePath),
                ),
        )
        .sort();
    if (
        stableStringify(
            prepared.directoryEntries
                .filter((entry) => entry.desiredState === "present")
                // Optional fresh missing ancestors are physical creation receipts. They do not
                // replace any exact desired native directory or authorize existing parent content.
                .filter(
                    (entry) =>
                        desired.has(entry.relativePath) ||
                        entry.oldState !== "missing" ||
                        !structuralParents.has(entry.relativePath),
                )
                .map((entry) => entry.relativePath)
                .sort(),
        ) !== stableStringify([...desired].sort()) ||
        stableStringify(
            prepared.directoryEntries
                .filter((entry) => entry.desiredState === "missing")
                .map((entry) => entry.relativePath)
                .sort(),
        ) !== stableStringify(expectedRemoved)
    )
        return false;
    const validLegacyShape = isValidJournal({
        schemaVersion: 3,
        transactionId: prepared.preparationId,
        deploymentId: binding.deploymentId,
        createdAt: 1,
        compilationFingerprint: prepared.compilationFingerprint,
        entries: prepared.entries,
        managedDirectoryBoundaries: prepared.managedDirectoryBoundaries,
        directoryEntries: prepared.directoryEntries,
        targetExecution: prepared.targetExecution,
        reservedPhysicalKeys: prepared.entries.length === 0 ? [] : [`wsl\0${binding.targetRootPath}`],
    });
    if (!validLegacyShape) return false;
    if (input.publicationTransactionId === undefined) return prepared.publication === undefined;
    const publication = prepared.publication;
    if (
        !hasExactKeys(publication, ["transactionId", "staging", "publications"]) ||
        publication === undefined ||
        publication.transactionId !== input.publicationTransactionId ||
        publication.staging.identity !== null
    )
        return false;
    const journal: ActiveJournalV4 = {
        schemaVersion: 4,
        transactionId: publication.transactionId,
        deploymentId: binding.deploymentId,
        createdAt: 1,
        compilationFingerprint: prepared.compilationFingerprint,
        entries: prepared.entries,
        managedDirectoryBoundaries: prepared.managedDirectoryBoundaries,
        directoryEntries: prepared.directoryEntries.map(({ restoredIdentity: _restored, ...entry }) => entry),
        targetExecution: prepared.targetExecution,
        staging: publication.staging,
        publicationPhase: "preparing",
        publications: publication.publications,
        reservedPhysicalKeys: prepared.entries.length === 0 ? [] : [`wsl\0${binding.targetRootPath}`],
    };
    const scope = input.runtimeReplacementAuthority?.replacementScope ?? { filePaths: [], directoryPaths: [] };
    return (
        isValidJournal(journal) &&
        publication.publications.every(
            (unit) =>
                unit.recovery === null &&
                unit.completeReplacement ===
                    (unit.kind === "directory" ? scope.directoryPaths : scope.filePaths).includes(unit.relativePath) &&
                (unit.kind === "file" || unit.preparedIdentity === null),
        ) &&
        prepared.managedDirectoryBoundaries.every((boundary) =>
            publication.publications.some(
                (unit) => unit.kind === "directory" && containsPublicationPath(unit.relativePath, boundary),
            ),
        )
    );
}

function validExecutionResult(result: RestrictedTargetExecutionResult, journal: ActiveJournalV3 | ActiveJournalV4) {
    if ((result?.outcome === "conflict" || result?.outcome === "uncertain") && hasExactKeys(result, ["outcome"])) return true;
    if (result?.outcome !== "verified" || !hasExactKeys(result, ["outcome", "verified"]) || !Array.isArray(result.verified))
        return false;
    const expected = journal.entries
        .filter((entry) => !entry.isRemoval)
        .map((entry) => ({
            relativePath: entry.relativePath,
            appliedContentHash: entry.newHash,
            appliedExecutable: entry.newExecutable,
            observedState: "present",
            observedContentHash: entry.newHash,
            observedExecutable: entry.newExecutable,
        }));
    return stableStringify(result.verified) === stableStringify(expected);
}
