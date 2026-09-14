import * as path from "node:path";
import { fingerprintDomain } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import type {
    EpochMillis,
    StateRestoreOrphanEvidenceKind,
    StateRestoreOrphanEvidenceV1,
    StateRestoreProjectionRebuildV1,
    StateRestoreReopenIssueV1,
    StateRestoreReopenReportV1,
    UuidV4,
} from "../types";
import { StateRestoreError } from "./state-restore-model";

export const STATE_RESTORE_REOPEN_REPORT_FORMAT = "oaam-state-restore-reopen-report-v1" as const;
export const STATE_RESTORE_REOPEN_REPORT_NAME = "reopen-report.json";

export function buildStateRestoreReopenReport(input: {
    restoreId: UuidV4;
    backupId: UuidV4;
    outcome: StateRestoreReopenReportV1["outcome"];
    completedAt: EpochMillis;
    projection: StateRestoreProjectionRebuildV1;
    orphanEvidence: StateRestoreOrphanEvidenceV1[];
    issues: StateRestoreReopenIssueV1[];
}): StateRestoreReopenReportV1 {
    const preimage: Omit<StateRestoreReopenReportV1, "reportFingerprint"> = {
        format: STATE_RESTORE_REOPEN_REPORT_FORMAT,
        schemaVersion: 1,
        restoreId: input.restoreId,
        backupId: input.backupId,
        outcome: input.outcome,
        completedAt: input.completedAt,
        projection: structuredClone(input.projection),
        orphanEvidence: structuredClone(input.orphanEvidence),
        issues: structuredClone(input.issues),
    };
    return {
        ...preimage,
        reportFingerprint: fingerprintDomain("oaam.restore.reopen-report.v1", preimage),
    };
}

export function serializeStateRestoreReopenReport(report: StateRestoreReopenReportV1): string {
    validateStateRestoreReopenReportDocument(report);
    return `${JSON.stringify(report, null, 2)}\n`;
}

export function validateStateRestoreReopenReportDocument(value: unknown): StateRestoreReopenReportV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "format",
            "schemaVersion",
            "restoreId",
            "backupId",
            "outcome",
            "completedAt",
            "projection",
            "orphanEvidence",
            "issues",
            "reportFingerprint",
        ]) ||
        value.format !== STATE_RESTORE_REOPEN_REPORT_FORMAT ||
        value.schemaVersion !== 1 ||
        !isUuidV4(value.restoreId) ||
        !isUuidV4(value.backupId) ||
        (value.outcome !== "restored" && value.outcome !== "retained_current") ||
        !isSafeNonNegative(value.completedAt) ||
        !isProjection(value.projection) ||
        !Array.isArray(value.orphanEvidence) ||
        value.orphanEvidence.some((entry) => !isOrphanEvidence(entry)) ||
        !Array.isArray(value.issues) ||
        value.issues.some((issue) => !isIssue(issue)) ||
        !isSha256Digest(value.reportFingerprint)
    ) {
        throw reportFailure("State restore reopen report has an invalid strict shape");
    }
    const report = value as unknown as StateRestoreReopenReportV1;
    if (report.outcome === "retained_current" && report.projection.state !== "not_run") {
        throw reportFailure("retained-current restore report cannot claim a projection rebuild");
    }
    if (report.outcome === "restored" && report.projection.state === "not_run") {
        throw reportFailure("restored profile report must carry the projection rebuild result");
    }
    const orphanKeys = report.orphanEvidence.map((entry) => `${entry.path}\0${entry.evidenceKind}`);
    if (new Set(orphanKeys).size !== orphanKeys.length || !isSorted(orphanKeys)) {
        throw reportFailure("State restore orphan evidence must be unique and canonically sorted");
    }
    const preimage: Omit<StateRestoreReopenReportV1, "reportFingerprint"> = {
        format: report.format,
        schemaVersion: report.schemaVersion,
        restoreId: report.restoreId,
        backupId: report.backupId,
        outcome: report.outcome,
        completedAt: report.completedAt,
        projection: report.projection,
        orphanEvidence: report.orphanEvidence,
        issues: report.issues,
    };
    if (fingerprintDomain("oaam.restore.reopen-report.v1", preimage) !== report.reportFingerprint) {
        throw reportFailure("State restore reopen report fingerprint does not match its strict body");
    }
    return report;
}

function isProjection(value: unknown): value is StateRestoreProjectionRebuildV1 {
    if (!isStrictObject(value) || (value.state !== "not_run" && value.state !== "complete" && value.state !== "partial")) {
        return false;
    }
    if (value.state === "not_run") return hasExactKeys(value, ["state"]);
    if (
        !hasExactKeys(value, [
            "state",
            "scannedAssets",
            "indexedAssets",
            "skippedAssets",
            "scannedProjects",
            "indexedProjects",
            "skippedProjects",
        ])
    ) {
        return false;
    }
    const counts = [
        value.scannedAssets,
        value.indexedAssets,
        value.skippedAssets,
        value.scannedProjects,
        value.indexedProjects,
        value.skippedProjects,
    ];
    if (!counts.every(isSafeNonNegative)) return false;
    const [scannedAssets, indexedAssets, skippedAssets, scannedProjects, indexedProjects, skippedProjects] = counts;
    return indexedAssets + skippedAssets === scannedAssets && indexedProjects + skippedProjects === scannedProjects;
}

function isOrphanEvidence(value: unknown): value is StateRestoreOrphanEvidenceV1 {
    return (
        isStrictObject(value) &&
        hasExactKeys(value, ["evidenceKind", "path"]) &&
        isOrphanEvidenceKind(value.evidenceKind) &&
        typeof value.path === "string" &&
        isCanonicalNonRootAbsolutePath(value.path)
    );
}

function isIssue(value: unknown): value is StateRestoreReopenIssueV1 {
    return (
        isStrictObject(value) &&
        hasExactKeys(value, ["code", "message", "path"]) &&
        typeof value.code === "string" &&
        value.code.trim().length > 0 &&
        typeof value.message === "string" &&
        value.message.trim().length > 0 &&
        typeof value.path === "string" &&
        !value.path.includes("\0")
    );
}

function isOrphanEvidenceKind(value: unknown): value is StateRestoreOrphanEvidenceKind {
    return value === "deployment_payload" || value === "deployment_journal" || value === "corrupt_deployment_journal";
}

function isSafeNonNegative(value: unknown): value is number {
    return isNonNegativeInteger(value) && Number.isSafeInteger(value);
}

function isCanonicalNonRootAbsolutePath(value: string): boolean {
    return (
        value.length > 0 &&
        !value.includes("\0") &&
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        value !== path.parse(value).root &&
        !value.endsWith(path.sep)
    );
}

function isSorted(values: readonly string[]): boolean {
    for (let index = 1; index < values.length; index += 1) {
        if (Buffer.compare(Buffer.from(values[index - 1] as string), Buffer.from(values[index] as string)) >= 0) return false;
    }
    return true;
}

function reportFailure(message: string): StateRestoreError {
    return new StateRestoreError("restore.reopen_report_invalid", message, "verification_failed", false);
}

/** @internal Strict persisted-report validators exposed only to fault tests. */
export const stateRestoreReopenReportInternalsForTest = Object.freeze({
    isIssue,
    isOrphanEvidence,
    isProjection,
    isSorted,
});
