import type { PhysicalPathIdentity, SafeFilesystemFailureKind } from "../filesystem/filesystem-types";
import type { LocalProcessExecutableIdentity } from "./path-environment";

export const SELECTED_WSL_MUTATION_PAYLOAD_MAXIMUM_BYTES = 16 * 1_024 * 1_024;
export const SELECTED_WSL_MUTATION_RECEIPT_BYTES = 200;
const REQUEST_HEADER_BYTES = 96;
const REQUEST_MAGIC = Buffer.from("OAAMWFM1", "ascii");
const RECEIPT_MAGIC = Buffer.from("OAAMWFR1", "ascii");

export type HelperOperation = "publish_directory" | "publish_file";

export interface SelectedWslTarget {
    readonly hostPath: string;
    readonly runtimeRootPath: string;
    readonly runtimeTargetPath: string;
}

export interface HelperReceipt {
    readonly status: "complete" | "failed";
    readonly certainty: "not_applied" | "may_have_applied" | "applied_verified";
    readonly operation: HelperOperation;
    readonly failure: string;
    readonly cleanupComplete: boolean;
    readonly byteSize: number;
    readonly parentBefore: PhysicalPathIdentity;
    readonly parentAfter: PhysicalPathIdentity;
    readonly targetBefore: PhysicalPathIdentity;
    readonly targetAfter: PhysicalPathIdentity;
    readonly helperIdentity: LocalProcessExecutableIdentity;
    readonly contentSha256: string;
    readonly helperSha256: string;
}

const HELPER_FAILURES = [
    "none",
    "invalid_frame",
    "unsupported_architecture",
    "invalid_path",
    "parent_open_failed",
    "target_not_found",
    "target_conflict",
    "symlink_or_magiclink",
    "wrong_entry_type",
    "permission_denied",
    "resource_limit",
    "temp_collision",
    "write_failed",
    "temp_fsync_failed",
    "rename_failed",
    "parent_fsync_failed",
    "readback_failed",
    "remove_failed",
    "cleanup_failed",
    "identity_changed",
    "unsupported_operation",
    "io_error",
    "timeout",
    "chmod_failed",
    "directory_not_empty",
] as const;

function writeU64(buffer: Buffer, value: number | bigint | string, offset: number): void {
    buffer.writeBigUInt64LE(BigInt(value), offset);
}

export function buildRequest(
    operation: HelperOperation,
    target: SelectedWslTarget,
    payload: Uint8Array,
    nonce: Buffer,
    expectedIdentity: PhysicalPathIdentity,
    directoryParents: { readonly source: PhysicalPathIdentity; readonly destination: PhysicalPathIdentity },
): Buffer {
    const rootBytes = Buffer.from(target.runtimeRootPath, "utf8");
    const targetBytes = Buffer.from(target.runtimeTargetPath, "utf8");
    const header = Buffer.alloc(REQUEST_HEADER_BYTES + 16);
    try {
        if (
            payload.byteLength === 0 ||
            payload.byteLength > 4 * 1_024 ||
            rootBytes.byteLength === 0 ||
            rootBytes.byteLength > 4 * 1_024 ||
            targetBytes.byteLength === 0 ||
            targetBytes.byteLength > 4 * 1_024 ||
            nonce.byteLength !== 32
        )
            throw new RangeError("Linux publication request exceeds the reviewed frame bound");
        if (
            expectedIdentity.entryKind !== (operation === "publish_file" ? "file" : "directory") ||
            directoryParents.source.entryKind !== "directory" ||
            directoryParents.destination.entryKind !== "directory"
        )
            throw new TypeError("publication requires exact source and parent identities");
        REQUEST_MAGIC.copy(header);
        header.writeUInt16LE(2, 8);
        header[10] = operation === "publish_directory" ? 7 : 8;
        header[11] = 1;
        header.writeUInt32LE(rootBytes.byteLength, 16);
        header.writeUInt32LE(targetBytes.byteLength, 20);
        writeU64(header, payload.byteLength, 24);
        nonce.copy(header, 32);
        writeU64(header, expectedIdentity.deviceId, 64);
        writeU64(header, expectedIdentity.fileId, 72);
        writeU64(header, directoryParents.destination.deviceId, 80);
        writeU64(header, directoryParents.destination.fileId, 88);
        writeU64(header, directoryParents.source.deviceId, 96);
        writeU64(header, directoryParents.source.fileId, 104);
        return Buffer.concat([header, rootBytes, targetBytes, payload]);
    } finally {
        header.fill(0);
        rootBytes.fill(0);
        targetBytes.fill(0);
    }
}

function identity(
    bytes: Buffer,
    offset: number,
    entryKind: PhysicalPathIdentity["entryKind"],
    deviceRadix: 10 | 16 = 10,
): PhysicalPathIdentity {
    return {
        deviceId: bytes.readBigUInt64LE(offset).toString(deviceRadix),
        fileId: bytes.readBigUInt64LE(offset + 8).toString(10),
        entryKind,
    };
}

export function parseReceipt(bytes: Uint8Array, expectedNonce: Buffer): HelperReceipt {
    const raw = Buffer.from(bytes);
    try {
        if (
            raw.byteLength !== SELECTED_WSL_MUTATION_RECEIPT_BYTES ||
            !raw.subarray(0, 8).equals(RECEIPT_MAGIC) ||
            raw.readUInt16LE(8) !== 1 ||
            raw[15] !== 0
        ) {
            throw new Error("selected-WSL helper receipt frame is invalid");
        }
        const status = raw[10] === 1 ? "complete" : raw[10] === 2 ? "failed" : null;
        const certainty =
            raw[11] === 1 ? "not_applied" : raw[11] === 2 ? "may_have_applied" : raw[11] === 3 ? "applied_verified" : null;
        const operation = raw[12] === 7 ? "publish_directory" : raw[12] === 8 ? "publish_file" : null;
        const failure = HELPER_FAILURES[raw[13] ?? -1];
        const cleanupComplete = raw[14] === 1;
        const nonce = raw.subarray(168, 200);
        const byteSizeValue = raw.readBigUInt64LE(16);
        if (
            status === null ||
            certainty === null ||
            operation === null ||
            failure === undefined ||
            (raw[14] !== 0 && raw[14] !== 1) ||
            byteSizeValue > BigInt(SELECTED_WSL_MUTATION_PAYLOAD_MAXIMUM_BYTES) ||
            !nonce.equals(expectedNonce) ||
            (status === "complete" && (certainty !== "applied_verified" || failure !== "none" || !cleanupComplete)) ||
            (status === "failed" && (certainty === "applied_verified" || failure === "none"))
        ) {
            throw new Error("selected-WSL helper receipt values are inconsistent");
        }
        const targetEntryKind = operation === "publish_directory" ? "directory" : "file";
        return {
            status,
            certainty,
            operation,
            failure,
            cleanupComplete,
            byteSize: Number(byteSizeValue),
            parentBefore: identity(raw, 24, "directory"),
            parentAfter: identity(raw, 40, "directory"),
            targetBefore: identity(raw, 56, targetEntryKind),
            targetAfter: identity(raw, 72, targetEntryKind),
            helperIdentity: identity(raw, 88, "file", 16) as LocalProcessExecutableIdentity,
            contentSha256: raw.subarray(104, 136).toString("hex"),
            helperSha256: raw.subarray(136, 168).toString("hex"),
        };
    } finally {
        raw.fill(0);
    }
}

export function helperFailureKind(failure: string): SafeFilesystemFailureKind {
    if (failure === "invalid_path") return "invalid_path";
    if (failure === "target_not_found") return "not_found";
    if (failure === "target_conflict" || failure === "temp_collision" || failure === "identity_changed") return "stale";
    if (failure === "symlink_or_magiclink") return "symlink_or_reparse";
    if (failure === "wrong_entry_type") return "wrong_entry_type";
    if (failure === "permission_denied") return "permission_denied";
    if (failure === "resource_limit") return "resource_limit";
    if (failure === "unsupported_architecture" || failure === "unsupported_operation") return "unsupported_platform";
    return "io_error";
}
