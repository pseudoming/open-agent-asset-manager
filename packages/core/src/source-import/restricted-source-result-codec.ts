/** Compact JSON with bytes only at the three declared source-result locations; no generic object revival. */
import { hasExactKeys, isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import { BUILTIN_ASSET_KINDS } from "../specs/registry";
import type { AdapterReadResult, CoreResult, ExtractedAssetCandidate, OperationDiagnostic } from "../types";
import { failedResult } from "./source-read-validation-helpers";
import { isRestrictedSourceDiagnostics } from "./restricted-source-diagnostics";

const READ_FIELDS = [
    "status",
    "readTarget",
    "readAuthorityFingerprint",
    "readSnapshotFingerprint",
    "sourceRoots",
    "sourceReadObligations",
    "readAccessOutcomes",
    "observedReadEntries",
    "externalAttestationReceipts",
    "sourceParseReports",
    "candidates",
    "sourceReports",
    "diagnostics",
];
const CANDIDATE_FIELDS = [
    "candidateId",
    "adapterId",
    "sourceRootIds",
    "scope",
    "projectRootPath",
    "scopePath",
    "displayName",
    "displayDescription",
    "files",
    "nativeRepresentation",
    "dialectRestorationTransition",
    "status",
    "assetCandidateStatus",
    "promotionSafety",
    "sourceFileOrigins",
    "sourceContainerEntryIds",
    "metadataSourceOrigins",
    "sourceEvidence",
    "diagnostics",
    "kind",
    "typeData",
];

/** The payload omits CoreResult's duplicated status/diagnostics. Host reconstructs those from the original read result. */
export function encodeRestrictedSourceReadResult(result: CoreResult<AdapterReadResult>): Buffer {
    if (result.value === undefined) {
        if (result.status !== "failed" || !Array.isArray(result.diagnostics) || result.diagnostics.length === 0)
            throw new Error("restricted source missing result is not a diagnosed failure");
        return Buffer.from(JSON.stringify({ failure: result.diagnostics }), "utf8");
    }
    const read = result.value;
    const candidates = read.candidates.map((candidate) => {
        const native = candidate.nativeRepresentation;
        const restoration = candidate.dialectRestorationTransition;
        return {
            ...candidate,
            files: candidate.files.map((file) =>
                file.contentKind === "binary" ? { ...file, bytes: encodeBytes(file.bytes) } : file,
            ),
            nativeRepresentation:
                native.representationSource === "canonical_files"
                    ? native
                    : {
                          ...native,
                          files: native.files.map((file) => ({ ...file, bytes: encodeBytes(file.bytes) })),
                      },
            dialectRestorationTransition:
                restoration.action === "replace" ? { action: "replace", bytes: encodeBytes(restoration.bytes) } : restoration,
        };
    });
    const wire = { ...read, candidates };
    requirePlainJson(wire);
    return Buffer.from(JSON.stringify(wire), "utf8");
}

export function decodeRestrictedSourceReadResult(bytes: Uint8Array): CoreResult<AdapterReadResult> {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (hasExactKeys(value, ["failure"])) {
        const failure = (value as { failure: OperationDiagnostic[] }).failure;
        if (!isRestrictedSourceDiagnostics(failure) || failure.length === 0)
            throw new Error("invalid restricted source failure diagnostics");
        return failedResult(failure);
    }
    if (!hasExactKeys(value, READ_FIELDS)) throw new Error("invalid restricted source result fields");
    const read = value as AdapterReadResult;
    if (
        !["complete", "partial", "failed"].includes(read.status) ||
        !isSha256Digest(read.readAuthorityFingerprint) ||
        !isSha256Digest(read.readSnapshotFingerprint) ||
        [
            read.sourceRoots,
            read.sourceReadObligations,
            read.readAccessOutcomes,
            read.observedReadEntries,
            read.externalAttestationReceipts,
            read.sourceParseReports,
            read.candidates,
            read.sourceReports,
            read.diagnostics,
        ].some((entries) => !Array.isArray(entries))
    )
        throw new Error("invalid restricted source result shape");
    if (
        !isRestrictedSourceDiagnostics(read.diagnostics) ||
        [
            ...read.sourceRoots,
            ...read.readAccessOutcomes,
            ...read.sourceParseReports,
            ...read.sourceReports,
            ...read.candidates,
        ].some((entry) => entry === null || typeof entry !== "object" || !isRestrictedSourceDiagnostics(entry.diagnostics))
    )
        throw new Error("invalid restricted source result diagnostics");
    if (
        read.sourceParseReports.some(
            (report) =>
                ![
                    "parsed",
                    "empty",
                    "skipped_ignored_source",
                    "deferred",
                    "unsupported",
                    "malformed_source",
                    "unknown_schema",
                ].includes(report.status),
        ) ||
        read.sourceReports.some(
            (report) =>
                ![
                    "scanned",
                    "not_found",
                    "empty",
                    "partial",
                    "blocked",
                    "skipped_ignored_source",
                    "deferred",
                    "unsupported",
                    "permission_denied",
                    "malformed_source",
                    "unknown_schema",
                ].includes(report.status),
        )
    )
        throw new Error("invalid restricted source report status");
    for (const entry of read.observedReadEntries) {
        const fields = ["observedReadEntryId", "sourceRootId", "relativePath", "entryKind", "physicalIdentityFingerprint"];
        if (entry.entryKind === "file") fields.push("contentHash", "executable");
        else if (entry.entryKind === "directory") fields.push("directoryInventoryFingerprint");
        else throw new Error("invalid restricted source observed entry kind");
        if (
            !hasExactKeys(entry, fields) ||
            typeof entry.observedReadEntryId !== "string" ||
            typeof entry.sourceRootId !== "string" ||
            (entry.relativePath !== "" && !isCanonicalRelativePath(entry.relativePath)) ||
            !isSha256Digest(entry.physicalIdentityFingerprint) ||
            (entry.entryKind === "file"
                ? !isSha256Digest(entry.contentHash) || typeof entry.executable !== "boolean"
                : !isSha256Digest(entry.directoryInventoryFingerprint))
        )
            throw new Error("invalid restricted source observed entry");
    }
    for (const candidate of read.candidates) decodeCandidate(candidate);
    return { status: read.status, value: read, diagnostics: read.diagnostics };
}

function decodeCandidate(candidate: ExtractedAssetCandidate) {
    const extra =
        candidate.kind === "Workflow"
            ? ["workflowExecutionAgentBindingInput"]
            : candidate.kind === "Memory" && candidate.memoryCatalogMemberBindingInputs !== undefined
              ? ["memoryCatalogMemberBindingInputs"]
              : [];
    if (
        !hasExactKeys(candidate, [...CANDIDATE_FIELDS, ...extra]) ||
        !BUILTIN_ASSET_KINDS.includes(candidate.kind) ||
        ![
            candidate.candidateId,
            candidate.adapterId,
            candidate.projectRootPath,
            candidate.scopePath,
            candidate.displayName,
            candidate.displayDescription,
        ].every((text) => typeof text === "string") ||
        ![
            candidate.files,
            candidate.sourceRootIds,
            candidate.sourceFileOrigins,
            candidate.sourceContainerEntryIds,
            candidate.metadataSourceOrigins,
            candidate.sourceEvidence,
            candidate.diagnostics,
        ].every(Array.isArray)
    )
        throw new Error("invalid restricted source candidate shape");
    for (const file of candidate.files) {
        const fields = [
            "logicalPath",
            "role",
            "contentKind",
            "mediaType",
            "executable",
            ...(file.references === undefined ? [] : ["references"]),
        ];
        if (file.contentKind === "text") fields.push("text");
        else if (file.contentKind === "binary") fields.push("bytes");
        else throw new Error("invalid restricted source candidate content kind");
        if (
            !hasExactKeys(file, fields) ||
            !isCanonicalRelativePath(file.logicalPath) ||
            typeof file.executable !== "boolean" ||
            typeof file.mediaType !== "string" ||
            !["entry", "resource", "dependency"].includes(file.role) ||
            (file.references !== undefined && !Array.isArray(file.references))
        )
            throw new Error("invalid restricted source candidate file");
        if (file.contentKind === "text") {
            if (typeof file.text !== "string") throw new Error("invalid restricted source candidate text");
        } else file.bytes = decodeBytes(file.bytes);
    }
    const native = candidate.nativeRepresentation;
    const nativeFields = ["representationSource", "dialectId"];
    if (native.representationSource === "separate_files") nativeFields.push("files");
    else if (native.representationSource === "separate_file_graph") nativeFields.push("files", "directories");
    else if (native.representationSource !== "canonical_files")
        throw new Error("invalid restricted source native representation");
    if (!hasExactKeys(native, nativeFields) || typeof native.dialectId !== "string")
        throw new Error("invalid restricted source native fields");
    if (native.representationSource !== "canonical_files") {
        if (
            !Array.isArray(native.files) ||
            (native.representationSource === "separate_file_graph" && !Array.isArray(native.directories))
        )
            throw new Error("invalid restricted source native graph");
        for (const file of native.files) {
            if (
                !hasExactKeys(file, [
                    "relativePath",
                    "contentKind",
                    "mediaType",
                    "bytes",
                    "executable",
                    ...(file.fragmentOrigin === undefined ? [] : ["fragmentOrigin"]),
                ]) ||
                !isCanonicalRelativePath(file.relativePath) ||
                !["text", "binary"].includes(file.contentKind) ||
                typeof file.mediaType !== "string" ||
                typeof file.executable !== "boolean"
            )
                throw new Error("invalid restricted source native file");
            file.bytes = decodeBytes(file.bytes);
        }
    }
    const restoration = candidate.dialectRestorationTransition;
    if (restoration.action === "replace") {
        if (!hasExactKeys(restoration, ["action", "bytes"])) throw new Error("invalid restricted source restoration fields");
        restoration.bytes = decodeBytes(restoration.bytes);
    } else if (!["inherit", "clear"].includes(restoration.action) || !hasExactKeys(restoration, ["action"]))
        throw new Error("invalid restricted source restoration action");
}

function encodeBytes(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) throw new Error("restricted source bytes are not a byte array");
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
function decodeBytes(value: unknown): Uint8Array {
    if (typeof value !== "string") throw new Error("restricted source bytes require explicit base64");
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("restricted source base64 is not canonical");
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requirePlainJson(value: unknown): void {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    )
        return;
    if (Array.isArray(value)) {
        for (const entry of value) requirePlainJson(entry);
        return;
    }
    if (
        value !== null &&
        typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
        for (const entry of Object.values(value)) requirePlainJson(entry);
        return;
    }
    throw new Error("restricted source result contains an undeclared non-JSON value");
}
