/** Prepared leaf publication and protective recovery. Each yield must be durable before resuming. */
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import {
    getJournalRuntimeRollbackState,
    type ActiveJournalV4,
    type JournalDirectoryEntry,
    type JournalEntry,
} from "./deployment-journal";
import { containsPublicationPath, type CompleteReplacementScope, type JournalPublication } from "./deployment-publication-model";
import {
    capturePublicationTree,
    createPreparedDirectory,
    createRestorationFile,
    desiredPublicationTree,
    fillPreparedDirectory,
    movePublicationEntry,
    publicationIdentity,
    publicationLocations,
    readPublicationFile,
    removeOwnedPublication,
    samePublicationIdentity,
    samePublicationTreeContent,
} from "./deployment-publication-io";
import { removeEmptyPublicationStaging } from "./deployment-publication-io";
import { absPath, ioWrite, type TargetIoContext } from "./deployment-target-io";
import type { TargetRecoveryOutcome } from "./deployment-file-recovery";

export type PublicationOperation = Generator<ActiveJournalV4, TargetRecoveryOutcome, void>;
interface OperationState {
    ctx: TargetIoContext;
    journal: ActiveJournalV4;
}

export function planPublications(
    ctx: TargetIoContext,
    entries: JournalEntry[],
    directories: JournalDirectoryEntry[],
    boundaries: string[],
    scope: CompleteReplacementScope,
): JournalPublication[] {
    const directoryPaths = [
        ...new Set([
            ...directories.filter((entry) => entry.oldState === "missing").map((entry) => entry.relativePath),
            ...boundaries.filter((boundary) => directories.some((entry) => entry.relativePath === boundary)),
        ]),
    ]
        .filter(
            (candidate, _index, all) => !all.some((parent) => parent !== candidate && containsPublicationPath(parent, candidate)),
        )
        .sort(compareUtf8Bytes);
    return [
        ...directoryPaths.map(
            (relativePath): JournalPublication => ({
                kind: "directory",
                relativePath,
                completeReplacement: scope.directoryPaths.includes(relativePath),
                oldTree: capturePublicationTree(absPath(ctx, relativePath)),
                preparedIdentity: null,
                recovery: null,
            }),
        ),
        ...entries
            .filter((entry) => !directoryPaths.some((parent) => containsPublicationPath(parent, entry.relativePath)))
            .map(
                (entry): JournalPublication => ({
                    kind: "file",
                    relativePath: entry.relativePath,
                    completeReplacement: scope.filePaths.includes(entry.relativePath),
                    recovery: null,
                }),
            ),
    ].sort((a, b) => compareUtf8Bytes(a.relativePath, b.relativePath));
}

function* record<Unit extends JournalPublication>(
    state: OperationState,
    index: number,
    unit: Unit,
): Generator<ActiveJournalV4, Unit, void> {
    const next = {
        ...state.journal,
        publications: state.journal.publications.map((current, position) => (position === index ? unit : current)),
    };
    yield structuredClone(next);
    state.journal = next;
    return unit;
}

/** The same generator executes locally or pauses across the restricted channel for a Windows journal receipt. */
export function* executePublications(ctx: TargetIoContext, journal: ActiveJournalV4): PublicationOperation {
    const state = { ctx, journal: structuredClone(journal) };
    try {
        if (journal.staging.identity !== null) throw new Error("forward publication cannot replay an existing staging root");
        const stagingIdentity = createPreparedDirectory(journal.staging.rootPath);
        const stagedJournal = { ...state.journal, staging: { ...state.journal.staging, identity: stagingIdentity } };
        yield structuredClone(stagedJournal);
        state.journal = stagedJournal;
        // Every complete leaf is fully prepared before the first public target changes.
        for (let index = 0; index < state.journal.publications.length; index += 1) {
            let unit = state.journal.publications[index]!;
            if (unit.kind !== "directory" || desiredPublicationTree(state.journal, unit) === null) continue;
            const locations = publicationLocations(ctx, state.journal, index);
            if (unit.preparedIdentity !== null) throw new Error("forward publication cannot replay a prepared transaction");
            const identity = createPreparedDirectory(locations.prepared);
            unit = yield* record(state, index, { ...unit, preparedIdentity: identity });
            fillPreparedDirectory(locations.prepared, state.journal, unit);
        }
        const publishing: ActiveJournalV4 = { ...state.journal, publicationPhase: "publishing" };
        yield structuredClone(publishing);
        state.journal = publishing;
        for (let index = 0; index < state.journal.publications.length; index += 1) {
            let unit = state.journal.publications[index]!;
            const locations = publicationLocations(ctx, state.journal, index);
            if (unit.kind === "file") {
                const entry = state.journal.entries.find((entry) => entry.relativePath === unit.relativePath)!;
                if (unit.completeReplacement) {
                    ioWrite(ctx, locations.target, Buffer.from(entry.newBytesBase64, "base64"), "overwrite", entry.newExecutable);
                } else {
                    const result = yield* recoverFile(state, index, "new");
                    if (result !== "done") return result;
                }
                continue;
            }
            const current = capturePublicationTree(locations.target);
            if (unit.completeReplacement) {
                // The confirmed complete target may change before publication. Persist
                // its actual operation-time identity before moving it out of the public path.
                if (stableStringify(current) !== stableStringify(unit.oldTree)) {
                    unit = yield* record(state, index, { ...unit, oldTree: current });
                }
            } else if (
                !samePublicationIdentity(current?.identity ?? null, unit.oldTree?.identity ?? null) ||
                !samePublicationTreeContent(current, unit.oldTree)
            )
                return "third_value";
            if (current !== null) {
                movePublicationEntry(locations.target, locations.original, "directory", current.identity);
                const retained = capturePublicationTree(locations.original);
                if (retained === null || !samePublicationIdentity(retained.identity, current.identity)) return "io_failed";
                if (!samePublicationTreeContent(retained, unit.oldTree)) {
                    if (!unit.completeReplacement) {
                        return returnDisplaced(locations.original, locations.target, "directory", retained.identity);
                    }
                    unit = yield* record(state, index, { ...unit, oldTree: retained });
                }
            }
            const desired = desiredPublicationTree(state.journal, unit);
            if (desired !== null) {
                if (
                    unit.preparedIdentity === null ||
                    !samePublicationTreeContent(capturePublicationTree(locations.prepared), desired)
                )
                    return "io_failed";
                movePublicationEntry(locations.prepared, locations.target, "directory", unit.preparedIdentity);
            }
            if (!samePublicationTreeContent(capturePublicationTree(locations.target), desired)) return "io_failed";
        }
        return "done";
    } catch {
        return "io_failed";
    }
}

/** Journal/DB authority chooses the side. A third value is returned to its public path when still vacant. */
export function* recoverPublications(ctx: TargetIoContext, journal: ActiveJournalV4, side: "old" | "new"): PublicationOperation {
    const state = { ctx, journal: structuredClone(journal) };
    try {
        // A lost first mkdir receipt cannot have authorized any public write.
        // Do not claim or delete an unreceipted root merely because its name matches.
        if (journal.publicationPhase === "preparing" && journal.staging.identity === null) {
            return side === "old" ? "done" : "io_failed";
        }
        const stagingIdentity = publicationIdentity(journal.staging.rootPath, "directory");
        if (stagingIdentity !== null && !samePublicationIdentity(stagingIdentity, journal.staging.identity)) return "third_value";
        if (journal.publicationPhase === "preparing") {
            if (side !== "old") return "io_failed";
            // No public write was authorized. The receipted private root owns its
            // known prepared slots, including a bounded partial tree or a lost child-create receipt.
            if (stagingIdentity === null) return "done";
            for (let index = 0; index < journal.publications.length; index += 1) {
                const unit = journal.publications[index]!;
                if (unit.kind !== "directory") continue;
                const prepared = publicationLocations(ctx, journal, index).prepared;
                const identity = publicationIdentity(prepared, "directory");
                if (identity === null) continue;
                if (unit.preparedIdentity !== null && !samePublicationIdentity(identity, unit.preparedIdentity))
                    return "third_value";
                removeOwnedPublication(prepared, "directory", identity);
            }
            removeEmptyPublicationStaging(journal.staging.rootPath, stagingIdentity);
            return "done";
        }
        for (let index = state.journal.publications.length - 1; index >= 0; index -= 1) {
            const unit = state.journal.publications[index]!;
            const result =
                unit.kind === "file" ? yield* recoverFile(state, index, side) : yield* recoverDirectory(state, index, side, unit);
            if (result !== "done") return result;
        }
        if (stagingIdentity !== null) removeEmptyPublicationStaging(journal.staging.rootPath, stagingIdentity);
        return "done";
    } catch {
        return "io_failed";
    }
}

function fileSides(entry: JournalEntry) {
    const old = getJournalRuntimeRollbackState(entry);
    return {
        old: { hash: old.contentHash, executable: old.executable, bytes: old.bytesBase64 },
        new: { hash: entry.newHash, executable: entry.newExecutable, bytes: entry.newBytesBase64 },
    };
}

function matchesFile(value: ReturnType<typeof readPublicationFile>, expected: { hash: string; executable: boolean }) {
    return value === null
        ? expected.hash === ""
        : value.contentHash === expected.hash && value.executable === expected.executable;
}

function returnDisplaced(
    source: string,
    target: string,
    kind: "file" | "directory",
    identity: PhysicalPathIdentity,
): TargetRecoveryOutcome {
    try {
        movePublicationEntry(source, target, kind, identity);
    } catch {
        /* Preserve both locations and the journal. */
    }
    return "third_value";
}

function* recoverFile(state: OperationState, index: number, side: "old" | "new"): PublicationOperation {
    let unit = state.journal.publications[index]!;
    const entry = state.journal.entries.find((entry) => entry.relativePath === unit.relativePath)!;
    const sides = fileSides(entry),
        wanted = sides[side];
    const paths = publicationLocations(state.ctx, state.journal, index);
    let current = readPublicationFile(paths.target);
    const knownContent = (value: ReturnType<typeof readPublicationFile>) =>
        matchesFile(value, sides.old) || matchesFile(value, sides.new);
    if (unit.recovery === null) {
        if (matchesFile(current, wanted)) return "done";
        if (!knownContent(current)) return "third_value";
        yield* record(state, index, {
            ...unit,
            recovery: { side, candidateIdentity: current?.identity ?? null, restoreIdentity: null },
        });
        unit = state.journal.publications[index]!;
    } else if (unit.recovery.side !== side) {
        yield* record(state, index, { ...unit, recovery: { ...unit.recovery, side } });
        unit = state.journal.publications[index]!;
    }
    let intent = unit.recovery!;
    const locations = () => [
        { path: paths.quarantine, identity: intent.candidateIdentity },
        { path: paths.restoration, identity: intent.restoreIdentity },
    ];
    if (intent.restoreIdentity === null) {
        const unreceipted = readPublicationFile(paths.restoration);
        if (unreceipted !== null) {
            // Restoration is prepared before candidate movement. This exact slot
            // belongs to the receipted private root, but no public move is allowed
            // until its identity receipt is durable. A partial write may be retried
            // only while the original candidate still occupies its recorded place.
            current = readPublicationFile(paths.target);
            if (
                !samePublicationIdentity(current?.identity ?? null, intent.candidateIdentity) ||
                !knownContent(current) ||
                readPublicationFile(paths.quarantine) !== null ||
                !samePublicationIdentity(
                    publicationIdentity(state.journal.staging.rootPath, "directory"),
                    state.journal.staging.identity,
                )
            )
                return "third_value";
            if (matchesFile(unreceipted, wanted)) {
                yield* record(state, index, { ...unit, recovery: { ...intent, restoreIdentity: unreceipted.identity } });
                unit = state.journal.publications[index]!;
                intent = unit.recovery!;
            } else removeOwnedPublication(paths.restoration, "file", unreceipted.identity);
        }
    }
    for (const location of locations()) {
        const file = readPublicationFile(location.path);
        if (file === null) continue;
        if (!samePublicationIdentity(file.identity, location.identity)) return "third_value";
        if (!knownContent(file)) return returnDisplaced(location.path, paths.target, "file", file.identity);
    }
    current = readPublicationFile(paths.target);
    if (
        current !== null &&
        (!knownContent(current) ||
            ![intent.candidateIdentity, intent.restoreIdentity].some((identity) =>
                samePublicationIdentity(identity, current!.identity),
            ))
    )
        return "third_value";
    if (!matchesFile(current, wanted)) {
        let desired = locations().find(
            (location) => matchesFile(readPublicationFile(location.path), wanted) && wanted.hash !== "",
        );
        if (wanted.hash !== "" && desired === undefined) {
            if (publicationIdentity(paths.restoration, "file") !== null || intent.restoreIdentity !== null) return "third_value";
            const identity = createRestorationFile(paths.restoration, Buffer.from(wanted.bytes, "base64"), wanted.executable);
            yield* record(state, index, { ...unit, recovery: { ...intent, restoreIdentity: identity } });
            unit = state.journal.publications[index]!;
            intent = unit.recovery!;
            desired = { path: paths.restoration, identity };
        }
        if (current !== null) {
            const vacant = locations().find(
                (location) =>
                    samePublicationIdentity(location.identity, current!.identity) &&
                    publicationIdentity(location.path, "file") === null,
            );
            if (vacant === undefined) return "third_value";
            movePublicationEntry(paths.target, vacant.path, "file", current.identity);
            const displaced = readPublicationFile(vacant.path);
            if (displaced === null || !samePublicationIdentity(displaced.identity, current.identity)) return "io_failed";
            if (!knownContent(displaced)) return returnDisplaced(vacant.path, paths.target, "file", displaced.identity);
        }
        if (wanted.hash !== "") {
            if (desired?.identity === null || desired === undefined) return "io_failed";
            if (!matchesFile(readPublicationFile(desired.path), wanted)) return "third_value";
            movePublicationEntry(desired.path, paths.target, "file", desired.identity);
        }
        if (!matchesFile(readPublicationFile(paths.target), wanted)) return "third_value";
    }
    for (const location of locations()) {
        const value = readPublicationFile(location.path);
        if (value === null) continue;
        if (!samePublicationIdentity(value.identity, location.identity) || !knownContent(value)) return "third_value";
        removeOwnedPublication(location.path, "file", value.identity);
    }
    yield* record(state, index, { ...unit, recovery: null });
    return "done";
}

function* recoverDirectory(
    state: OperationState,
    index: number,
    side: "old" | "new",
    initial: Extract<JournalPublication, { kind: "directory" }>,
): PublicationOperation {
    let unit = initial;
    const paths = publicationLocations(state.ctx, state.journal, index);
    const desired = desiredPublicationTree(state.journal, unit),
        wanted = side === "old" ? unit.oldTree : desired;
    const wantedIdentity = side === "old" ? (unit.oldTree?.identity ?? null) : unit.preparedIdentity;
    const knownContent = (value: ReturnType<typeof capturePublicationTree>) =>
        samePublicationTreeContent(value, unit.oldTree) || samePublicationTreeContent(value, desired);
    let current = capturePublicationTree(paths.target);
    const privateLocations = [paths.original, paths.prepared, paths.quarantine];
    const expectedIdentity = (path: string) =>
        path === paths.original
            ? (unit.oldTree?.identity ?? null)
            : path === paths.prepared
              ? unit.preparedIdentity
              : (unit.recovery?.candidateIdentity ?? null);
    if (unit.recovery === null && !samePublicationTreeContent(current, wanted)) {
        if (!knownContent(current) && current !== null) return "third_value";
        if (
            current !== null &&
            ![unit.oldTree?.identity ?? null, unit.preparedIdentity].some((identity) =>
                samePublicationIdentity(identity, current!.identity),
            )
        )
            return "third_value";
        unit = yield* record(state, index, {
            ...unit,
            recovery: { side, candidateIdentity: current?.identity ?? null, restoreIdentity: null },
        });
    }
    for (const path of privateLocations) {
        const value = capturePublicationTree(path);
        if (value === null) continue;
        if (!samePublicationIdentity(value.identity, expectedIdentity(path))) return "third_value";
        if (!knownContent(value))
            return path === paths.prepared ? "third_value" : returnDisplaced(path, paths.target, "directory", value.identity);
    }
    if (!samePublicationTreeContent(current, wanted) || !samePublicationIdentity(current?.identity ?? null, wantedIdentity)) {
        if (current !== null) {
            if (!knownContent(current) || !samePublicationIdentity(current.identity, unit.recovery?.candidateIdentity ?? null))
                return "third_value";
            movePublicationEntry(paths.target, paths.quarantine, "directory", current.identity);
            const displaced = capturePublicationTree(paths.quarantine);
            if (displaced === null || !samePublicationIdentity(displaced.identity, current.identity)) return "io_failed";
            if (!knownContent(displaced)) return returnDisplaced(paths.quarantine, paths.target, "directory", displaced.identity);
        }
        if (wanted !== null) {
            const source = privateLocations.find((path) => {
                const value = capturePublicationTree(path);
                return (
                    samePublicationIdentity(value?.identity ?? null, wantedIdentity) && samePublicationTreeContent(value, wanted)
                );
            });
            if (source === undefined || wantedIdentity === null) return "io_failed";
            movePublicationEntry(source, paths.target, "directory", wantedIdentity);
        }
        current = capturePublicationTree(paths.target);
        if (!samePublicationTreeContent(current, wanted) || !samePublicationIdentity(current?.identity ?? null, wantedIdentity))
            return "third_value";
    }
    for (const path of privateLocations) {
        const value = capturePublicationTree(path);
        if (value === null) continue;
        if (!samePublicationIdentity(value.identity, expectedIdentity(path)) || !knownContent(value)) return "third_value";
        removeOwnedPublication(path, "directory", value.identity, value);
    }
    if (unit.recovery !== null) yield* record(state, index, { ...unit, recovery: null });
    return "done";
}

/** Cleanup only after DB commit; uncertainty keeps the journal and its reservation. */
export function finalizePublications(ctx: TargetIoContext, journal: ActiveJournalV4): TargetRecoveryOutcome {
    const operation = recoverPublications(ctx, journal, "new");
    const result = operation.next();
    // A normally verified forward operation needs only cleanup, never a new recovery intent.
    return result.done ? result.value : "io_failed";
}
