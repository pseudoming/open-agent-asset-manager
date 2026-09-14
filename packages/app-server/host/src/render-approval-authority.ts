/** Host-scoped attestation for one exact client-requested render approval. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfirmOneTimeRenderApprovalInput, EpochMillis, RenderSelectionRequest, Sha256Digest } from "@oaam/core";

export interface HostOneTimeRenderApprovalResolution {
    readonly renderInputFingerprint: Sha256Digest;
    readonly optionFingerprint: Sha256Digest;
    readonly userActionId: string;
    readonly resolvedAt: EpochMillis;
}

export interface HostRenderApprovalAuthority {
    createResolutions(selection: RenderSelectionRequest): HostOneTimeRenderApprovalResolution[];
    runWithResolutions<T>(
        selection: RenderSelectionRequest,
        resolutions: readonly HostOneTimeRenderApprovalResolution[],
        operation: () => Promise<T>,
    ): Promise<T>;
    confirmOneTimeApproval(input: ConfirmOneTimeRenderApprovalInput): EpochMillis | null;
}

export function createHostRenderApprovalAuthority(now: () => number = Date.now): HostRenderApprovalAuthority {
    return Object.freeze(new OperationLocalRenderApprovalAuthority(now));
}

class OperationLocalRenderApprovalAuthority implements HostRenderApprovalAuthority {
    readonly #active = new AsyncLocalStorage<ReadonlyMap<string, EpochMillis>>();

    public constructor(private readonly now: () => number) {}

    public createResolutions(selection: RenderSelectionRequest): HostOneTimeRenderApprovalResolution[] {
        const requests = requestedApprovals(selection);
        if (requests.length === 0) return [];
        const resolvedAt = this.now();
        requireResolutionTime(resolvedAt);
        return requests.map((request) => ({
            renderInputFingerprint: selection.renderInputFingerprint,
            optionFingerprint: request.optionFingerprint,
            userActionId: request.userActionId,
            resolvedAt: resolvedAt as EpochMillis,
        }));
    }

    public async runWithResolutions<T>(
        selection: RenderSelectionRequest,
        resolutions: readonly HostOneTimeRenderApprovalResolution[],
        operation: () => Promise<T>,
    ): Promise<T> {
        const entries = resolutions.map((resolution) => {
            validateResolution(resolution, selection.renderInputFingerprint);
            return [approvalKey(resolution), resolution.resolvedAt] as const;
        });
        if (!hostRenderApprovalResolutionsMatchSelection(selection, resolutions)) {
            throw new TypeError("render approval resolutions do not match the exact selection request");
        }
        return this.#active.run(new Map(entries), operation);
    }

    public confirmOneTimeApproval(input: ConfirmOneTimeRenderApprovalInput): EpochMillis | null {
        return (
            this.#active.getStore()?.get(
                approvalKey({
                    renderInputFingerprint: input.deployment.renderInputFingerprint,
                    optionFingerprint: input.option.optionFingerprint,
                    userActionId: input.userActionId,
                }),
            ) ?? null
        );
    }
}

export function hostRenderApprovalResolutionsMatchSelection(
    selection: RenderSelectionRequest,
    resolutions: readonly HostOneTimeRenderApprovalResolution[],
): boolean {
    let expected: ReturnType<typeof requestedApprovals>;
    try {
        expected = requestedApprovals(selection);
    } catch {
        return false;
    }
    const keys = resolutions.map((resolution) => approvalKey(resolution));
    return (
        resolutions.every(
            (resolution) =>
                isHostOneTimeRenderApprovalResolution(resolution) &&
                resolution.renderInputFingerprint === selection.renderInputFingerprint,
        ) &&
        new Set(keys).size === keys.length &&
        resolutions.length === expected.length &&
        expected.every((request) =>
            keys.includes(
                approvalKey({
                    renderInputFingerprint: selection.renderInputFingerprint,
                    optionFingerprint: request.optionFingerprint,
                    userActionId: request.userActionId,
                }),
            ),
        )
    );
}

export function isHostOneTimeRenderApprovalResolution(value: unknown): value is HostOneTimeRenderApprovalResolution {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return (
        Object.keys(object).sort().join("\0") ===
            ["optionFingerprint", "renderInputFingerprint", "resolvedAt", "userActionId"].sort().join("\0") &&
        isSha256(object.renderInputFingerprint) &&
        isSha256(object.optionFingerprint) &&
        typeof object.userActionId === "string" &&
        object.userActionId.trim() === object.userActionId &&
        object.userActionId.length > 0 &&
        Number.isSafeInteger(object.resolvedAt) &&
        (object.resolvedAt as number) >= 0
    );
}

function requestedApprovals(selection: RenderSelectionRequest) {
    const requests = selection.semanticOptions.flatMap((option) =>
        option.approvalRequest.approvalAction === "approve_once"
            ? [{ optionFingerprint: option.optionFingerprint, userActionId: option.approvalRequest.userActionId }]
            : [],
    );
    if (
        requests.some((request) => request.userActionId.trim() !== request.userActionId || request.userActionId.length === 0) ||
        new Set(requests.map((request) => `${request.optionFingerprint}\0${request.userActionId}`)).size !== requests.length
    ) {
        throw new TypeError("render approval requests must be non-blank and unique");
    }
    return requests;
}

function validateResolution(value: HostOneTimeRenderApprovalResolution, renderInputFingerprint: Sha256Digest): void {
    if (!isHostOneTimeRenderApprovalResolution(value) || value.renderInputFingerprint !== renderInputFingerprint) {
        throw new TypeError("render approval resolution is invalid or stale");
    }
}

function requireResolutionTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("render approval resolution time is invalid");
}

function approvalKey(input: {
    renderInputFingerprint: Sha256Digest;
    optionFingerprint: Sha256Digest;
    userActionId: string;
}): string {
    return `${input.renderInputFingerprint}\0${input.optionFingerprint}\0${input.userActionId}`;
}

function isSha256(value: unknown): value is Sha256Digest {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
