import * as path from "node:path";
import { SafeFilesystemError, inspectRegularFileNoFollow, inventoryDirectoryNoFollow } from "@oaam/shared/filesystem";
import { inspectStateDatabase, resolveDbPath, type StateDatabaseInspection } from "./db";

const EMPTY_SCAFFOLD_DIRECTORIES = new Set(["assets", "deployments", "projects", "transactions"]);
const DATABASE_SIDECAR_SUFFIXES = ["-journal", "-shm", "-wal"] as const;

export type StateProfileRecoveryReason =
    | "missing_database"
    | "corrupt_database"
    | "incompatible_database"
    | "restore_reconciliation";

export class StateProfileRecoveryRequiredError extends Error {
    public readonly state = "recovery_required" as const;
    public readonly reason: StateProfileRecoveryReason;
    public readonly databasePath: string;
    public readonly evidencePaths: readonly string[];

    public constructor(input: {
        readonly reason: StateProfileRecoveryReason;
        readonly databasePath: string;
        readonly evidencePaths: readonly string[];
        readonly detail: string;
        readonly cause?: unknown;
    }) {
        super(input.detail, input.cause === undefined ? undefined : { cause: input.cause });
        this.name = "StateProfileRecoveryRequiredError";
        this.reason = input.reason;
        this.databasePath = input.databasePath;
        this.evidencePaths = Object.freeze([...new Set(input.evidencePaths)].sort());
    }
}

export type StateProfileStartupClassification =
    | { readonly state: "memory" }
    | { readonly state: "virgin" }
    | { readonly state: "ready" }
    | { readonly state: "compatible_empty_rebuild" };

function recoveryForDatabaseInspection(
    databasePath: string,
    inspection: Extract<StateDatabaseInspection, { readonly state: "corrupt" | "incompatible" }>,
): never {
    throw new StateProfileRecoveryRequiredError({
        reason: inspection.state === "corrupt" ? "corrupt_database" : "incompatible_database",
        databasePath,
        evidencePaths: [databasePath],
        detail: `OAAM state recovery is required because ${inspection.marker}`,
    });
}

function sidecarEvidence(databasePath: string): string[] {
    const evidence: string[] = [];
    for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
        const candidate = `${databasePath}${suffix}`;
        try {
            inspectRegularFileNoFollow(candidate);
            evidence.push(candidate);
        } catch (error) {
            if (error instanceof SafeFilesystemError && error.failureKind === "not_found") continue;
            evidence.push(candidate);
        }
    }
    return evidence;
}

function knownScaffoldContainsMaterial(directoryPath: string): boolean {
    try {
        return inventoryDirectoryNoFollow(directoryPath, 1).entries.length > 0;
    } catch {
        return true;
    }
}

function profileRootEvidence(oaamRoot: string, databasePath: string): string[] {
    let rootInventory: ReturnType<typeof inventoryDirectoryNoFollow>;
    try {
        rootInventory = inventoryDirectoryNoFollow(oaamRoot, 10_000);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw new StateProfileRecoveryRequiredError({
            reason: "missing_database",
            databasePath,
            evidencePaths: [oaamRoot],
            detail: "OAAM state recovery is required because the existing profile root cannot be inventoried safely",
            cause: error,
        });
    }

    const evidence: string[] = [];
    for (const entry of rootInventory.entries) {
        const absolutePath = path.join(oaamRoot, entry.relativeName);
        if (
            entry.identity.entryKind === "directory" &&
            EMPTY_SCAFFOLD_DIRECTORIES.has(entry.relativeName) &&
            !knownScaffoldContainsMaterial(absolutePath)
        ) {
            continue;
        }
        evidence.push(absolutePath);
    }
    return evidence;
}

/**
 * Classify the state profile before Core creates the OAAM root, SQLite file or
 * normal empty scaffolding.
 */
export function assertStateProfileStartup(input: {
    readonly oaamRoot: string;
    readonly databasePath?: string;
}): StateProfileStartupClassification {
    const databasePath = resolveDbPath(input.databasePath);
    const inspection = inspectStateDatabase(databasePath);
    switch (inspection.state) {
        case "memory":
            return { state: "memory" };
        case "current":
            return { state: "ready" };
        case "compatible_empty_rebuild":
            return { state: "compatible_empty_rebuild" };
        case "corrupt":
        case "incompatible":
            return recoveryForDatabaseInspection(databasePath, inspection);
        case "missing": {
            const evidence = [...sidecarEvidence(databasePath), ...profileRootEvidence(input.oaamRoot, databasePath)];
            if (evidence.length > 0) {
                throw new StateProfileRecoveryRequiredError({
                    reason: "missing_database",
                    databasePath,
                    evidencePaths: evidence,
                    detail: "OAAM state recovery is required because the State DB is missing beside existing profile material",
                });
            }
            return { state: "virgin" };
        }
    }
}

/** @internal Deterministic disappearing-scaffold seam; production imports are forbidden. */
export const stateProfileInternalsForTest = Object.freeze({
    knownScaffoldContainsMaterial,
});
