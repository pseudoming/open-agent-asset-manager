/** Render-selection physical closure, lock, user-evidence, and failure guards. */

import type { RenderOutputUnit } from "../contracts/deployment-authority";
import type { CoreResult, OperationDiagnostic } from "../types";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { RenderAnalysisFailure } from "./render-analysis";

export function validatePhysicalOutputClosure(units: readonly RenderOutputUnit[]): void {
    const claims = new Map<string, string>();
    const boundaries = new Map<string, string>();
    for (const unit of units) {
        for (const claim of unit.claims) {
            for (const [path, owner] of claims) {
                if (
                    owner !== unit.outputUnitFingerprint &&
                    (path === claim.relativePath ||
                        path.startsWith(`${claim.relativePath}/`) ||
                        claim.relativePath.startsWith(`${path}/`))
                ) {
                    throw new RenderSelectionFailure(
                        "render.output_path_conflict",
                        "different output units claim the same path or treat a file as a directory",
                    );
                }
            }
            claims.set(claim.relativePath, unit.outputUnitFingerprint);
        }
        for (const boundary of unit.managedDirectoryBoundaries) {
            for (const [path, owner] of boundaries) {
                if (
                    owner !== unit.outputUnitFingerprint &&
                    (path === boundary.relativePath ||
                        path.startsWith(`${boundary.relativePath}/`) ||
                        boundary.relativePath.startsWith(`${path}/`))
                ) {
                    throw new RenderSelectionFailure(
                        "render.output_boundary_conflict",
                        "managed directory boundaries overlap across output units",
                    );
                }
            }
            boundaries.set(boundary.relativePath, unit.outputUnitFingerprint);
        }
    }
    for (const [boundary, owner] of boundaries) {
        for (const [claim, claimOwner] of claims) {
            if (
                owner !== claimOwner &&
                (claim === boundary || claim.startsWith(`${boundary}/`) || boundary.startsWith(`${claim}/`))
            ) {
                throw new RenderSelectionFailure(
                    "render.output_boundary_claim_conflict",
                    "one unit's managed boundary contains another unit's claim",
                );
            }
        }
    }
}

export function acquireRenderSelectionAssetLocks(authorityLocksRoot: string, assetIds: readonly string[]): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "assets", assetIds);
    if (release === null) {
        throw new RenderSelectionFailure("render.asset_locked", "one or more Asset authorities are locked", "unavailable", true);
    }
    return release;
}

export function acquireRenderSelectionSettingsLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "settings", ["settings"]);
    if (release === null) {
        throw new RenderSelectionFailure("render.settings_locked", "promotion settings authority is locked", "unavailable", true);
    }
    return release;
}

export function requireRenderSelectionUserText(value: string, label: string): void {
    if (value.trim().length === 0) {
        throw new RenderSelectionFailure("render.user_evidence_missing", `${label} must be non-blank`);
    }
}

export class RenderSelectionFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}

export function failedRenderSelectionResult<T>(error: unknown): CoreResult<T> {
    const known = error instanceof RenderSelectionFailure || error instanceof RenderAnalysisFailure;
    const message = error instanceof Error ? error.message : String(error);
    const structured = known ? error : null;
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: structured?.code ?? "render.selection_internal_error",
        message,
        path: "",
        traceId: "",
        operation: "render",
        causeKind: structured?.causeKind ?? "internal_error",
        retryable: structured?.retryable ?? false,
        suggestedActions: structured?.retryable ? ["retry"] : [],
        rawSummary: message,
    };
    return { status: "failed", value: undefined as T, diagnostics: [diagnostic] };
}
