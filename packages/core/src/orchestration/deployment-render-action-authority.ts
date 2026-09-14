import { type AuthorityLockLease, tryAcquireAuthorityLockLease } from "../foundation/authority-locks";
import type { DeploymentRenderPreviewView, DeployWithRenderSelectionInput, OperationDiagnostic, UuidV4 } from "../types";

export class DeploymentRenderFailure extends Error {
    public constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"],
        readonly retryable: boolean,
        readonly diagnostics: OperationDiagnostic[],
    ) {
        super(message);
        this.name = "DeploymentRenderFailure";
    }
}

export function requirePreviewedAction(input: DeployWithRenderSelectionInput): void {
    if (input.expectedPreviewFingerprint.trim().length === 0) {
        throw new DeploymentRenderFailure(
            "render.preview_fingerprint_missing",
            "deployment requires an exact pre-write preview fingerprint",
            "invalid_schema",
            false,
            [],
        );
    }
    if (input.deploymentAction === "replace_unmanaged" && input.userActionId.trim().length === 0) {
        throw new DeploymentRenderFailure(
            "render.unmanaged_replacement_user_action_missing",
            "replace_unmanaged requires a non-empty userActionId",
            "invalid_schema",
            false,
            [],
        );
    }
}

export function requirePreviewMatch(input: DeployWithRenderSelectionInput, preview: DeploymentRenderPreviewView): void {
    if (preview.schemaVersion !== 3 || preview.previewFingerprint !== input.expectedPreviewFingerprint) {
        throw new DeploymentRenderFailure(
            "render.preview_stale",
            "confirmed target, selected render or protected content changed after the reviewed preview",
            "conflict",
            true,
            [],
        );
    }
    if (input.deploymentAction !== "overwrite_runtime" && preview.actionState === "blocked_managed_conflict") {
        throw new DeploymentRenderFailure(
            "render.preview_action_mismatch",
            "protected content outside complete replacement authority requires inspection",
            "conflict",
            false,
            [],
        );
    }
}

export function acquireActionTimeAuthorityLeases(
    authorityLocksRoot: string,
    sourceAssetIds: UuidV4[],
): { assets: AuthorityLockLease; settings: AuthorityLockLease } {
    const assetIds = [...new Set(sourceAssetIds)].sort();
    const assets = tryAcquireAuthorityLockLease(authorityLocksRoot, "assets", assetIds);
    if (assets === null) {
        throw new DeploymentRenderFailure(
            "render.asset_locked",
            "one or more Asset authorities are locked at action time",
            "unavailable",
            true,
            [],
        );
    }
    const settings = tryAcquireAuthorityLockLease(authorityLocksRoot, "settings", ["settings"]);
    if (settings === null) {
        assets.release();
        throw new DeploymentRenderFailure(
            "render.settings_locked",
            "promotion settings authority is locked at action time",
            "unavailable",
            true,
            [],
        );
    }
    return { assets, settings };
}

export function requireActionTimeAssetLeaseCoverage(
    initialSourceAssetIds: readonly UuidV4[],
    currentSourceAssetIds: readonly UuidV4[],
): void {
    const initial = [...new Set(initialSourceAssetIds)].sort();
    const current = [...new Set(currentSourceAssetIds)].sort();
    if (initial.length === current.length && initial.every((assetId, index) => assetId === current[index])) return;
    throw new DeploymentRenderFailure(
        "render.action_time_context_changed",
        "Deployment Asset authority changed before the acquired lease set could cover action-time preparation",
        "conflict",
        true,
        [],
    );
}

/** @internal Narrow helper seam for the overwrite and exact-preview action boundary. */
export const deploymentRenderActionAuthorityInternalsForTest = Object.freeze({
    requirePreviewedAction,
    requirePreviewMatch,
    requireActionTimeAssetLeaseCoverage,
});
