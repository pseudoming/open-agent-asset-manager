/** Linux read operations retain original Core checks inside exact Host lock admissions. */
import {
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    readRegularFilesNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import type { createSelectedWslPathProjection } from "@oaam/shared/paths";
import {
    createAdapterReadOperationWithPhysicalAuthority,
    type AdapterReadFinalValidation,
    type AdapterReadOperation,
    type CreateAdapterReadOperationInput,
} from "../adapters/adapter-read-access";
import type { ReadFilesystem } from "../adapters/adapter-read-physical-authority";
import { computePhysicalAccessClosureKeys } from "../foundation/physical-path-locks";
import { fingerprintDomain } from "../foundation/fingerprint";
import { isCanonicalRelativePath } from "../foundation/validators";
import type { ReadEntryHandle, Sha256Digest } from "../types";

export interface RestrictedReadAuthorityTarget {
    sourceRootId: string;
    relativePath: string;
    entryKind: "file" | "directory";
}
export interface RestrictedReadAuthorityIntent {
    phase: "access" | "final_validate";
    targets: RestrictedReadAuthorityTarget[];
}
export function restrictedReadAuthorityIntentFingerprint(intent: RestrictedReadAuthorityIntent): Sha256Digest {
    return fingerprintDomain("oaam.restricted-source.authority-intent.v1", intent);
}
export type RestrictedReadAuthorityPermission = { state: "held" | "busy" | "stale" } | { state: "io_error"; message: string };
export interface RestrictedReadAuthorityOwner {
    withAuthority<T>(
        intent: RestrictedReadAuthorityIntent,
        run: (permission: RestrictedReadAuthorityPermission) => T | Promise<T>,
    ): Promise<T>;
}
export interface SettledAdapterReadOperation extends Omit<AdapterReadOperation, "finalValidate"> {
    settle(): Promise<void>;
    finalValidate(): Promise<AdapterReadFinalValidation>;
}

export function createRestrictedSourceReadOperation(
    sourceInput: CreateAdapterReadOperationInput,
    projection: ReturnType<typeof createSelectedWslPathProjection>,
    owner: RestrictedReadAuthorityOwner,
): SettledAdapterReadOperation {
    const input = structuredClone(sourceInput);
    if (input.platform !== "wsl") throw new Error("restricted source operation requires the selected WSL context");
    const roots = new Map(input.sourceRoots.map((root) => [root.sourceRootId, root]));
    for (const root of roots.values()) projection.toExecution(root.path);
    const issued = new Map<string, ReadEntryHandle>();
    let active:
        | { keys: string[]; permission: RestrictedReadAuthorityPermission; consumed: boolean; released: boolean }
        | undefined;
    let tail: Promise<void> = Promise.resolve();
    let acceptingAccess = true;
    const physical = projectedFilesystem(projection);
    const operation = createAdapterReadOperationWithPhysicalAuthority(
        input,
        physical,
        (transactionsRoot, keys) => {
            if (
                active === undefined ||
                active.consumed ||
                transactionsRoot !== input.transactionsRoot ||
                JSON.stringify(keys) !== JSON.stringify(active.keys)
            )
                throw new Error("restricted source operation has no matching Host physical authority");
            active.consumed = true;
            if (active.permission.state === "busy") return null;
            if (active.permission.state === "io_error") throw new Error(active.permission.message);
            const admitted = active;
            return {
                release() {
                    admitted.released = true;
                },
            };
        },
        () => active?.permission.state === "held" && active.consumed && !active.released,
    );

    function schedule<T>(run: () => Promise<T>): Promise<T> {
        const result = tail.then(run);
        tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    function scheduleAccess<T>(run: () => Promise<T>): Promise<T> {
        if (!acceptingAccess) return Promise.reject(new Error("restricted source read access is complete"));
        return schedule(run);
    }

    async function authorized<T>(intent: RestrictedReadAuthorityIntent, run: () => T | Promise<T>): Promise<T> {
        const keys = restrictedReadAuthorityKeys(input, intent);
        let entered = false;
        const result = await owner.withAuthority(structuredClone(intent), async (permission) => {
            if (entered || active !== undefined) throw new Error("restricted source authority cannot be replayed or nested");
            entered = true;
            active = { keys, permission: structuredClone(permission), consumed: false, released: false };
            try {
                return await run();
            } finally {
                active = undefined;
            }
        });
        if (!entered) throw new Error("restricted source owner omitted its authority decision");
        return result;
    }

    const resolve = (
        obligationId: string,
        rootId: string,
        relativePath: string,
        run: () => ReturnType<AdapterReadOperation["readAccess"]["resolveRootEntry"]>,
    ) =>
        scheduleAccess(async () => {
            const allowed =
                roots.has(rootId) &&
                input.sourceReadObligations.some(
                    (obligation) => obligation.sourceReadObligationId === obligationId && obligation.sourceRootId === rootId,
                ) &&
                (relativePath === "" || isCanonicalRelativePath(relativePath));
            const result = allowed
                ? await authorized({ phase: "access", targets: [{ sourceRootId: rootId, relativePath, entryKind: "file" }] }, run)
                : await run();
            if (result.state === "succeeded") issued.set(result.value.readEntryHandleId, structuredClone(result.value));
            return result;
        });
    const byHandle = <T>(handleId: string, run: () => Promise<T>) =>
        scheduleAccess(async () => {
            const handle = issued.get(handleId);
            if (handle === undefined) return run();
            return authorized(
                {
                    phase: "access",
                    targets: [
                        { sourceRootId: handle.sourceRootId, relativePath: handle.relativePath, entryKind: handle.entryKind },
                    ],
                },
                run,
            );
        });

    return {
        readAccess: Object.freeze<AdapterReadOperation["readAccess"]>({
            resolveRootEntry: (obligationId, rootId) =>
                resolve(obligationId, rootId, "", () => operation.readAccess.resolveRootEntry(obligationId, rootId)),
            resolveEntry: (obligationId, rootId, relativePath) =>
                resolve(obligationId, rootId, relativePath, () =>
                    operation.readAccess.resolveEntry(obligationId, rootId, relativePath),
                ),
            listDirectory: (handleId) =>
                byHandle(handleId, async () => {
                    const result = await operation.readAccess.listDirectory(handleId);
                    if (result.state === "succeeded")
                        for (const handle of result.value.children) issued.set(handle.readEntryHandleId, structuredClone(handle));
                    return result;
                }),
            readFile: (handleId) => byHandle(handleId, () => operation.readAccess.readFile(handleId)),
            verifyExternalAttestation: (...args) => scheduleAccess(() => operation.readAccess.verifyExternalAttestation(...args)),
        }),
        snapshot: operation.snapshot,
        settle() {
            // Provider completion seals new callbacks while already-admitted accesses retain their release/drain.
            acceptingAccess = false;
            return tail;
        },
        finalValidate() {
            acceptingAccess = false;
            return schedule(() =>
                authorized(
                    {
                        phase: "final_validate",
                        targets: operation.snapshot().entries.map((entry) => ({
                            sourceRootId: entry.sourceRootId,
                            relativePath: entry.relativePath,
                            entryKind: entry.entryKind,
                        })),
                    },
                    operation.finalValidate,
                ),
            );
        },
    };
}

/** Host and service independently derive the original exact physical-key closure from declared roots. */
export function restrictedReadAuthorityKeys(
    input: Pick<CreateAdapterReadOperationInput, "platform" | "sourceRoots">,
    intent: RestrictedReadAuthorityIntent,
): string[] {
    const roots = new Map(input.sourceRoots.map((root) => [root.sourceRootId, root]));
    return [
        ...new Set(
            intent.targets.flatMap((target) => {
                const root = roots.get(target.sourceRootId);
                if (
                    root === undefined ||
                    (target.relativePath !== "" && !isCanonicalRelativePath(target.relativePath)) ||
                    (target.entryKind !== "file" && target.entryKind !== "directory")
                )
                    throw new Error("restricted source authority target is outside its declared roots");
                return computePhysicalAccessClosureKeys(input.platform, root.path, [target]);
            }),
        ),
    ].sort();
}

function projectedFilesystem(projection: ReturnType<typeof createSelectedWslPathProjection>): ReadFilesystem {
    const call = <T>(run: () => T): T => {
        try {
            return run();
        } catch (error) {
            if (!(error instanceof SafeFilesystemError)) throw error;
            throw new SafeFilesystemError({
                failureKind: error.failureKind,
                operation: error.operation,
                targetPath: projection.toHost(error.targetPath),
                systemCode: error.systemCode,
                message: error.message,
            });
        }
    };
    return {
        readRegularFileNoFollow: (filePath, maximumBytes) =>
            call(() => readRegularFileNoFollow(projection.toExecution(filePath), maximumBytes)),
        readRegularFilesNoFollow: (inputs, maximumTotalBytes) =>
            call(() =>
                readRegularFilesNoFollow(
                    inputs.map((input) => ({ ...input, filePath: projection.toExecution(input.filePath) })),
                    maximumTotalBytes,
                ),
            ),
        inventoryDirectoryNoFollow: (directoryPath, maximumEntries) =>
            call(() => inventoryDirectoryNoFollow(projection.toExecution(directoryPath), maximumEntries)),
    };
}
