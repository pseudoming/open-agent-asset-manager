export const OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL = "oaam:desktop-observed-project-root-authorize";
export const OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL = "oaam:desktop-observed-project-root-reveal";
export const REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL = "oaam:desktop-registered-project-root-authorize";
export const REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL = "oaam:desktop-registered-project-root-reveal";

export interface DesktopObservedProjectRootReference {
    readonly probeToken: string;
    readonly probeResultRowId: string;
    readonly projectRowId: string;
    readonly sourceRootRowId: string;
}

export type ObservedProjectRootAuthorizationResult =
    | {
          readonly status: "authorized";
          readonly displayPath: string;
          readonly localPathSelectionToken: string;
      }
    | { readonly status: "failed"; readonly code: "unavailable" };

export type ObservedProjectRootRevealResult =
    | { readonly status: "complete" }
    | { readonly status: "failed"; readonly code: "unavailable" | "open_failed" };

export type RegisteredProjectRootAuthorizationResult = ObservedProjectRootAuthorizationResult;
export type RegisteredProjectRootRevealResult = ObservedProjectRootRevealResult;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

export function parseDesktopObservedProjectRootReference(value: unknown): DesktopObservedProjectRootReference {
    if (
        !isExactRecord(value, ["probeResultRowId", "probeToken", "projectRowId", "sourceRootRowId"]) ||
        !isNonEmptyString(value.probeToken) ||
        !isNonEmptyString(value.probeResultRowId) ||
        !isNonEmptyString(value.projectRowId) ||
        !isNonEmptyString(value.sourceRootRowId)
    ) {
        throw new TypeError("invalid Desktop observed Project root reference");
    }
    return Object.freeze({
        probeToken: value.probeToken,
        probeResultRowId: value.probeResultRowId,
        projectRowId: value.projectRowId,
        sourceRootRowId: value.sourceRootRowId,
    });
}

export function parseDesktopRegisteredProjectId(value: unknown): string {
    if (!isNonEmptyString(value) || !UUID_V4_PATTERN.test(value)) {
        throw new TypeError("invalid Desktop registered Project id");
    }
    return value;
}

export function parseObservedProjectRootAuthorizationResult(value: unknown): ObservedProjectRootAuthorizationResult {
    if (isExactRecord(value, ["code", "status"]) && value.status === "failed" && value.code === "unavailable") {
        return Object.freeze({ status: "failed", code: "unavailable" });
    }
    if (
        isExactRecord(value, ["displayPath", "localPathSelectionToken", "status"]) &&
        value.status === "authorized" &&
        isNonEmptyString(value.displayPath) &&
        isNonEmptyString(value.localPathSelectionToken)
    ) {
        return Object.freeze({
            status: "authorized",
            displayPath: value.displayPath,
            localPathSelectionToken: value.localPathSelectionToken,
        });
    }
    throw new TypeError("invalid Desktop observed Project root authorization result");
}

export function parseObservedProjectRootRevealResult(value: unknown): ObservedProjectRootRevealResult {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["code", "status"]) &&
        value.status === "failed" &&
        (value.code === "unavailable" || value.code === "open_failed")
    ) {
        return Object.freeze({ status: "failed", code: value.code });
    }
    throw new TypeError("invalid Desktop observed Project root reveal result");
}

export const parseRegisteredProjectRootAuthorizationResult = parseObservedProjectRootAuthorizationResult;
export const parseRegisteredProjectRootRevealResult = parseObservedProjectRootRevealResult;
