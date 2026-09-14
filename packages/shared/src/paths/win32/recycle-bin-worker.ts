import {
    DurableFilesystemMutationError,
    type DurableMutationState,
    type PhysicalPathIdentity,
    SafeFilesystemError,
    type SafeFilesystemFailureKind,
} from "../../filesystem/filesystem-types";
import { loadWin32NativeFilesystemAddon } from "./native-addon";

const FAILURE_KINDS = new Set<SafeFilesystemFailureKind>([
    "invalid_path",
    "not_found",
    "permission_denied",
    "symlink_or_reparse",
    "wrong_entry_type",
    "resource_limit",
    "stale",
    "unsupported_platform",
    "io_error",
]);
const MUTATION_STATES = new Set<DurableMutationState>(["not_applied", "may_have_applied"]);

type RecycleOperation = "file" | "directory";

interface WorkerSuccess {
    readonly schemaVersion: 1;
    readonly status: "complete";
    readonly removed: boolean;
}

interface WorkerFailure {
    readonly schemaVersion: 1;
    readonly status: "failed";
    readonly failureKind: SafeFilesystemFailureKind;
    readonly systemCode: string;
    readonly mutationState: DurableMutationState;
    readonly message: string;
}

function parseIdentity(deviceId: string, fileId: string, entryKind: string): PhysicalPathIdentity {
    if (!/^\d+$/u.test(deviceId) || !/^[0-9a-f]{32}$/u.test(fileId) || !["file", "directory"].includes(entryKind)) {
        throw new TypeError("recycle worker received an invalid physical identity");
    }
    return { deviceId, fileId, entryKind: entryKind as PhysicalPathIdentity["entryKind"] };
}

function parseMaximumEntries(value: string): number {
    if (!/^\d+$/u.test(value)) throw new TypeError("recycle worker received an invalid entry limit");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError("recycle worker received an invalid entry limit");
    }
    return parsed;
}

function normalizeFailure(error: unknown): WorkerFailure {
    if (error instanceof DurableFilesystemMutationError) {
        return {
            schemaVersion: 1,
            status: "failed",
            failureKind: error.failureKind,
            systemCode: error.systemCode,
            mutationState: error.mutationState,
            message: error.message.slice(0, 2_048),
        };
    }
    if (error instanceof SafeFilesystemError) {
        return {
            schemaVersion: 1,
            status: "failed",
            failureKind: FAILURE_KINDS.has(error.failureKind) ? error.failureKind : "io_error",
            systemCode: error.systemCode,
            mutationState: "may_have_applied",
            message: error.message.slice(0, 2_048),
        };
    }
    return {
        schemaVersion: 1,
        status: "failed",
        failureKind: "io_error",
        systemCode: "WINDOWS_RECYCLE_WORKER_UNTYPED_FAILURE",
        mutationState: "may_have_applied",
        message: error instanceof Error ? error.message.slice(0, 2_048) : "Recycle Bin worker failed",
    };
}

function run(): WorkerSuccess {
    const [operation, targetPath, deviceId, fileId, entryKind, maximumEntries, invocationToken] = process.argv.slice(2);
    if (
        (operation !== "file" && operation !== "directory") ||
        typeof targetPath !== "string" ||
        targetPath.length === 0 ||
        targetPath.includes("\0") ||
        typeof invocationToken !== "string" ||
        !/^[a-f0-9]{64}$/u.test(invocationToken) ||
        process.env.OAAM_INVOCATION_TOKEN !== invocationToken
    ) {
        throw new TypeError("recycle worker received an invalid fixed invocation");
    }
    const identity = parseIdentity(deviceId ?? "", fileId ?? "", entryKind ?? "");
    const limit = parseMaximumEntries(maximumEntries ?? "");
    if ((operation as RecycleOperation) !== identity.entryKind) {
        throw new TypeError("recycle worker operation does not match the physical identity kind");
    }
    const native = loadWin32NativeFilesystemAddon();
    const removed =
        operation === "file"
            ? native.recycleRegularFileIfIdentity(targetPath, identity)
            : native.recycleDirectoryTreeIfIdentity(targetPath, identity, limit);
    return { schemaVersion: 1, status: "complete", removed };
}

try {
    process.stdout.write(`${JSON.stringify(run())}\n`);
} catch (error) {
    const failure = normalizeFailure(error);
    if (!FAILURE_KINDS.has(failure.failureKind) || !MUTATION_STATES.has(failure.mutationState)) {
        process.stderr.write(
            `${JSON.stringify({
                schemaVersion: 1,
                status: "failed",
                failureKind: "io_error",
                systemCode: "WINDOWS_RECYCLE_WORKER_PROTOCOL_FAILURE",
                mutationState: "may_have_applied",
                message: "Recycle Bin worker produced an invalid failure",
            } satisfies WorkerFailure)}\n`,
        );
    } else {
        process.stderr.write(`${JSON.stringify(failure)}\n`);
    }
    process.exitCode = 70;
}
