/** Private selected-Environment source operations with one suspended read and one bounded result transfer. */
import { hasExactKeys, isSha256Digest, isUuidV4 } from "../foundation/validators";
import type { AdapterReadTarget, Sha256Digest } from "../types";
import {
    decodeRestrictedSourceAuthority,
    decodeRestrictedSourceContinuation,
    type RestrictedSourceAuthority,
} from "./restricted-source-request";
import type { RestrictedSourceReadContinuation, RestrictedSourceReadStep } from "./restricted-source-read-run";
import type { RestrictedSourceResultChunk, RestrictedSourceResultDescriptor } from "./restricted-source-result-transfer";

export const RESTRICTED_SOURCE_PROTOCOL = "oaam.restricted-source.v1";
export const RESTRICTED_SOURCE_MAX_FRAME_BYTES = 12 * 1024 * 1024;
export const RESTRICTED_SOURCE_MAX_READS = 128;
export const RESTRICTED_SOURCE_MAX_CONTINUATIONS = 32_768;

export type RestrictedSourceOperation =
    | { kind: "begin"; readId: string; target: AdapterReadTarget; authority: RestrictedSourceAuthority }
    | { kind: "continue"; readId: string; continuation: RestrictedSourceReadContinuation }
    | { kind: "result_chunk"; readId: string; transferId: string; offset: number }
    | { kind: "acknowledge"; readId: string; transferId: string; contentHash: Sha256Digest }
    | { kind: "cancel"; readId: string };

export interface RestrictedSourceRequest {
    protocol: typeof RESTRICTED_SOURCE_PROTOCOL;
    hostInstanceId: string;
    sessionId: string;
    operationId: string;
    sequence: number;
    operation: RestrictedSourceOperation;
}
export type RestrictedSourceWireStep =
    | Exclude<RestrictedSourceReadStep, { kind: "complete" }>
    | { kind: "result"; descriptor: RestrictedSourceResultDescriptor };
export type RestrictedSourceResponse = Omit<RestrictedSourceRequest, "operation"> & {
    result:
        | { kind: "read_step"; readId: string; step: RestrictedSourceWireStep }
        | { kind: "result_chunk"; readId: string; chunk: RestrictedSourceResultChunk }
        | { kind: "acknowledged" | "cancelled"; readId: string };
};

export function isRestrictedSourceRequest(value: unknown): value is RestrictedSourceRequest {
    if (!hasExactKeys(value, ["protocol", "hostInstanceId", "sessionId", "operationId", "sequence", "operation"])) return false;
    const request = value as RestrictedSourceRequest;
    if (
        request.protocol !== RESTRICTED_SOURCE_PROTOCOL ||
        !isUuidV4(request.hostInstanceId) ||
        !isUuidV4(request.sessionId) ||
        !isUuidV4(request.operationId) ||
        !Number.isSafeInteger(request.sequence) ||
        request.sequence < 1 ||
        !isUuidV4(request.operation?.readId)
    )
        return false;
    const operation = request.operation;
    switch (operation.kind) {
        case "begin":
            return (
                hasExactKeys(operation, ["kind", "readId", "target", "authority"]) &&
                decodeRestrictedSourceAuthority(operation.authority) !== null
            );
        case "continue":
            return (
                hasExactKeys(operation, ["kind", "readId", "continuation"]) &&
                decodeRestrictedSourceContinuation(operation.continuation) !== null
            );
        case "result_chunk":
            return (
                hasExactKeys(operation, ["kind", "readId", "transferId", "offset"]) &&
                isUuidV4(operation.transferId) &&
                Number.isSafeInteger(operation.offset) &&
                operation.offset >= 0
            );
        case "acknowledge":
            return (
                hasExactKeys(operation, ["kind", "readId", "transferId", "contentHash"]) &&
                isUuidV4(operation.transferId) &&
                isSha256Digest(operation.contentHash)
            );
        case "cancel":
            return hasExactKeys(operation, ["kind", "readId"]);
        default:
            return false;
    }
}
