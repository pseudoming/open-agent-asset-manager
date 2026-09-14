/** One bounded, Provider-private compatibility read of a stopped OpenCode project registry. */

import { execFile, type ExecFileException } from "node:child_process";
import { lstatSync } from "node:fs";
import * as path from "node:path";
import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    inspectProviderRegularFileNoFollow,
    probeDiagnostic as diagnostic,
    sameProviderRegularFileIdentity,
    type ProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import { type BoundedDirectoryEntry, inspectFilesystemFailure, readDirectoryEntriesBounded } from "@oaam/shared/filesystem";

const READER_TIMEOUT_MILLISECONDS = 1_500;
const MAXIMUM_READER_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_DIRECTORY_ENTRIES = 4_096;
const MAXIMUM_DATABASE_BYTES = 8n * 1_024n * 1_024n * 1_024n;
const MAXIMUM_SHM_BYTES = 64n * 1_024n * 1_024n;
const EXPECTED_READER_VERSION = "12.11.1";
const EXPECTED_SCHEMA_FINGERPRINT = "opencode-project-registry-20260423070820";

export interface OpenCodeCompatibilityDatabaseInput {
    readonly databasePath: string;
    readonly platformContext: PlatformContext;
}

export interface OpenCodeCompatibilityDatabaseResult {
    readonly status: "partial";
    readonly projectDocument: Uint8Array | null;
    readonly diagnostics: readonly OperationDiagnostic[];
}

interface ReaderInvocationResult {
    readonly status: "complete" | "timed_out" | "failed";
    readonly stdout: Uint8Array;
    readonly failureCode: string;
    readonly processId: number | null;
    readonly processExited: boolean;
}

type FileState =
    | { readonly status: "absent" }
    | {
          readonly status: "present";
          readonly identity: ProviderRegularFileIdentity;
          readonly size: bigint;
          readonly mtimeNanoseconds: bigint;
      };

interface RegistryState {
    readonly directoryInventory: readonly BoundedDirectoryEntry[];
    readonly database: FileState & { readonly status: "present" };
    readonly wal: FileState;
    readonly shm: FileState;
    readonly journal: FileState;
}

interface CompatibilityDependencies {
    readonly inspectFile: (filePath: string) => ProviderRegularFileIdentity;
    readonly sameFile: (left: ProviderRegularFileIdentity, right: ProviderRegularFileIdentity) => boolean;
    readonly inventoryDirectory: (directoryPath: string, maximumEntries: number) => BoundedDirectoryEntry[];
    readonly runReader: (
        readerModulePath: string,
        databasePath: string,
        timeoutMilliseconds: number,
        maximumOutputBytes: number,
    ) => Promise<ReaderInvocationResult>;
    readonly readerModulePath: string;
}

const DEFAULT_DEPENDENCIES: CompatibilityDependencies = {
    inspectFile: inspectProviderRegularFileNoFollow,
    sameFile: sameProviderRegularFileIdentity,
    inventoryDirectory: readDirectoryEntriesBounded,
    runReader: runOpenCodeCompatibilityReaderBounded,
    readerModulePath: path.join(__dirname, "opencode-compatibility-project-reader.js"),
};

export async function discoverOpenCodeCompatibilityDatabase(
    input: OpenCodeCompatibilityDatabaseInput,
    overrides: Partial<CompatibilityDependencies> = {},
): Promise<OpenCodeCompatibilityDatabaseResult> {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
    const databasePath = canonicalProviderHostPathWithinAccessRoot(input.databasePath, input.platformContext);
    if (databasePath === null || databasePath !== input.databasePath) {
        return failure(
            input.databasePath,
            "opencode_compatibility_database_path_invalid",
            "The OpenCode compatibility registry is outside the selected environment",
            "version_incompatible",
        );
    }
    let before: RegistryState;
    try {
        before = captureRegistryState(databasePath, dependencies);
    } catch (error) {
        return filesystemFailure(databasePath, "before", error);
    }
    const sidecarFailure = validateCompatibilitySidecars(databasePath, before);
    if (sidecarFailure !== null) return sidecarFailure;

    const invocation = await dependencies.runReader(
        dependencies.readerModulePath,
        databasePath,
        READER_TIMEOUT_MILLISECONDS,
        MAXIMUM_READER_OUTPUT_BYTES,
    );
    if (!invocation.processExited) {
        return failure(
            databasePath,
            "opencode_compatibility_database_reader_residual",
            "The compatibility reader did not leave a provably empty process",
            "partial",
        );
    }
    if (invocation.status !== "complete") {
        return failure(
            databasePath,
            `opencode_compatibility_database_reader_${invocation.failureCode || invocation.status}`,
            "The bounded compatibility reader did not return one complete result",
            "partial",
        );
    }
    const parsed = parseReaderOutput(invocation.stdout, databasePath);
    if (parsed.projectDocument === null) return parsed;

    let after: RegistryState;
    try {
        after = captureRegistryState(databasePath, dependencies);
    } catch (error) {
        return filesystemFailure(databasePath, "after", error);
    }
    if (!sameRegistryState(before, after, dependencies.sameFile)) {
        return failure(
            databasePath,
            "opencode_compatibility_database_changed",
            "The OpenCode registry or its sidecars changed during the compatibility read",
            "partial",
        );
    }
    return {
        status: "partial",
        projectDocument: parsed.projectDocument,
        diagnostics: [
            diagnostic(
                "opencode_compatibility_database_used",
                "OpenCode project registrations came from a low-confidence compatibility database read",
                "partial",
                "warning",
                databasePath,
            ),
        ],
    };
}

function captureRegistryState(databasePath: string, dependencies: CompatibilityDependencies): RegistryState {
    const paths = hostPathApiFor(databasePath);
    if (paths === null) throw new TypeError("database path has no Host path grammar");
    return {
        directoryInventory: dependencies.inventoryDirectory(paths.dirname(databasePath), MAXIMUM_DIRECTORY_ENTRIES),
        database: requirePresentFileState(databasePath, dependencies.inspectFile),
        wal: optionalFileState(`${databasePath}-wal`, dependencies.inspectFile),
        shm: optionalFileState(`${databasePath}-shm`, dependencies.inspectFile),
        journal: optionalFileState(`${databasePath}-journal`, dependencies.inspectFile),
    };
}

function requirePresentFileState(
    filePath: string,
    inspectFile: CompatibilityDependencies["inspectFile"],
): FileState & { readonly status: "present" } {
    const state = optionalFileState(filePath, inspectFile);
    if (state.status !== "present") throw Object.assign(new Error("database missing"), { code: "ENOENT" });
    return state;
}

function optionalFileState(filePath: string, inspectFile: CompatibilityDependencies["inspectFile"]): FileState {
    try {
        const identityBefore = inspectFile(filePath);
        const stat = lstatSync(filePath, { bigint: true });
        const identityAfter = inspectFile(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || !sameProviderRegularFileIdentity(identityBefore, identityAfter)) {
            throw new TypeError("registry member changed or is not a regular file");
        }
        return {
            status: "present",
            identity: identityAfter,
            size: stat.size,
            mtimeNanoseconds: stat.mtimeNs,
        };
    } catch (error) {
        const inspected = inspectFilesystemFailure(error);
        if (inspected.failureKind === "not_found") {
            return { status: "absent" };
        }
        throw error;
    }
}

function validateCompatibilitySidecars(databasePath: string, state: RegistryState): OpenCodeCompatibilityDatabaseResult | null {
    if (state.database.size > MAXIMUM_DATABASE_BYTES) {
        return failure(
            databasePath,
            "opencode_compatibility_database_size_limit",
            "The OpenCode registry exceeds the bounded compatibility-reader size",
            "partial",
        );
    }
    if (state.wal.status === "present" && state.wal.size > 0n) {
        return failure(
            databasePath,
            "opencode_compatibility_database_nonempty_wal",
            "A non-empty OpenCode WAL cannot be represented by the low-confidence compatibility reader",
            "partial",
        );
    }
    if (state.shm.status === "present" && state.wal.status === "absent") {
        return failure(
            databasePath,
            "opencode_compatibility_database_orphan_shm",
            "The OpenCode registry has an unmatched shared-memory sidecar",
            "invalid_schema",
        );
    }
    if (state.shm.status === "present" && state.shm.size > MAXIMUM_SHM_BYTES) {
        return failure(
            databasePath,
            "opencode_compatibility_database_shm_size_limit",
            "The OpenCode shared-memory sidecar exceeds the compatibility bound",
            "partial",
        );
    }
    if (state.journal.status === "present") {
        return failure(
            databasePath,
            "opencode_compatibility_database_journal_present",
            "The OpenCode registry has an unsupported rollback-journal sidecar",
            "partial",
        );
    }
    return null;
}

function parseReaderOutput(bytes: Uint8Array, databasePath: string): OpenCodeCompatibilityDatabaseResult {
    try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("reader envelope");
        const record = value as Record<string, unknown>;
        if (record.readerVersion !== EXPECTED_READER_VERSION) {
            return failure(
                databasePath,
                "opencode_compatibility_database_reader_version_mismatch",
                "The packaged compatibility reader version is unsupported",
                "version_incompatible",
            );
        }
        if (record.status === "failed") {
            const failureCode = typeof record.failureCode === "string" ? record.failureCode : "invalid";
            return failure(
                databasePath,
                `opencode_compatibility_database_${failureCode}`,
                "The OpenCode registry does not match the bounded compatibility schema",
                "invalid_schema",
            );
        }
        if (
            record.status !== "complete" ||
            typeof record.sqliteVersion !== "string" ||
            record.sqliteVersion.length === 0 ||
            record.schemaFingerprint !== EXPECTED_SCHEMA_FINGERPRINT ||
            !Array.isArray(record.projects) ||
            record.failureCode !== ""
        ) {
            throw new TypeError("reader result");
        }
        return {
            status: "partial",
            projectDocument: Buffer.from(JSON.stringify(record.projects), "utf8"),
            diagnostics: [],
        };
    } catch {
        return failure(
            databasePath,
            "opencode_compatibility_database_reader_output_invalid",
            "The compatibility reader returned an invalid bounded document",
            "invalid_schema",
        );
    }
}

function sameRegistryState(left: RegistryState, right: RegistryState, sameFile: CompatibilityDependencies["sameFile"]): boolean {
    return (
        JSON.stringify(left.directoryInventory) === JSON.stringify(right.directoryInventory) &&
        sameFileState(left.database, right.database, sameFile) &&
        sameFileState(left.wal, right.wal, sameFile) &&
        sameFileState(left.shm, right.shm, sameFile) &&
        sameFileState(left.journal, right.journal, sameFile)
    );
}

function sameFileState(left: FileState, right: FileState, sameFile: CompatibilityDependencies["sameFile"]): boolean {
    if (left.status !== right.status) return false;
    if (left.status === "absent" || right.status === "absent") return true;
    return (
        sameFile(left.identity, right.identity) && left.size === right.size && left.mtimeNanoseconds === right.mtimeNanoseconds
    );
}

function filesystemFailure(
    databasePath: string,
    surface: "before" | "after",
    error: unknown,
): OpenCodeCompatibilityDatabaseResult {
    const inspected = inspectFilesystemFailure(error);
    return failure(
        databasePath,
        `opencode_compatibility_database_${surface}_${inspected.systemCode.toLowerCase()}`,
        "The OpenCode registry and sidecars could not be inspected safely",
        inspected.failureKind === "permission_denied" ? "permission_denied" : "partial",
    );
}

function failure(
    databasePath: string,
    code: string,
    message: string,
    causeKind: "partial" | "invalid_schema" | "permission_denied" | "version_incompatible",
): OpenCodeCompatibilityDatabaseResult {
    return {
        status: "partial",
        projectDocument: null,
        diagnostics: [diagnostic(code, message, causeKind, "warning", databasePath)],
    };
}

export function runOpenCodeCompatibilityReaderBounded(
    readerModulePath: string,
    databasePath: string,
    timeoutMilliseconds: number,
    maximumOutputBytes: number,
    executeFile: typeof execFile = execFile,
): Promise<ReaderInvocationResult> {
    return new Promise((resolve) => {
        const child = executeFile(
            process.execPath,
            [readerModulePath, databasePath],
            {
                encoding: "buffer",
                env: compatibilityReaderEnvironment(),
                killSignal: "SIGKILL",
                maxBuffer: maximumOutputBytes,
                timeout: timeoutMilliseconds,
                windowsHide: true,
            },
            (error, stdout) => {
                const bytes = typeof stdout === "string" ? Buffer.from(stdout, "utf8") : new Uint8Array(stdout);
                if (error === null && bytes.byteLength > 0) {
                    resolve({
                        status: "complete",
                        stdout: bytes,
                        failureCode: "",
                        processId: child.pid ?? null,
                        processExited: true,
                    });
                    return;
                }
                const failed = readerInvocationFailure(error);
                resolve({
                    ...failed,
                    processId: child.pid ?? null,
                    processExited: true,
                });
            },
        );
    });
}

function compatibilityReaderEnvironment(): NodeJS.ProcessEnv {
    return {
        ELECTRON_RUN_AS_NODE: "1",
        SQLITE_USE_URI: "1",
        ...(typeof process.env.SystemRoot === "string" ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(typeof process.env.WINDIR === "string" ? { WINDIR: process.env.WINDIR } : {}),
    };
}

function readerInvocationFailure(
    error: ExecFileException | null,
): Pick<ReaderInvocationResult, "status" | "stdout" | "failureCode"> {
    const code = typeof error?.code === "string" ? error.code : "";
    const timedOut = (error?.killed ?? false) || typeof error?.signal === "string";
    return {
        status: timedOut ? "timed_out" : "failed",
        stdout: new Uint8Array(),
        failureCode:
            code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output_limit" : timedOut ? "timeout" : code.toLowerCase() || "exit",
    };
}
