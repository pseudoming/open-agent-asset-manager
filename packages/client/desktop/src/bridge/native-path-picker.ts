export type ProjectRootPickerResult =
    | { readonly status: "cancelled" }
    | {
          readonly status: "selected";
          readonly displayPath: string;
          readonly localPathSelectionToken: string;
      };

export type SourceRootPickerResult = ProjectRootPickerResult;
export type InstallationRootPickerResult = ProjectRootPickerResult;

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

export function parseProjectRootPickerResult(value: unknown): ProjectRootPickerResult {
    if (isExactRecord(value, ["status"]) && value.status === "cancelled") {
        return Object.freeze({ status: "cancelled" });
    }
    if (
        isExactRecord(value, ["displayPath", "localPathSelectionToken", "status"]) &&
        value.status === "selected" &&
        isNonEmptyString(value.displayPath) &&
        isNonEmptyString(value.localPathSelectionToken)
    ) {
        return Object.freeze({
            status: "selected",
            displayPath: value.displayPath,
            localPathSelectionToken: value.localPathSelectionToken,
        });
    }
    throw new TypeError("invalid Desktop project-root picker result");
}

export function parseProjectRootPickerSuggestedPath(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (!isNonEmptyString(value) || value.length > 32_767) {
        throw new TypeError("invalid Desktop project-root picker suggestion");
    }
    return value;
}

export function parseSourceRootPickerResult(value: unknown): SourceRootPickerResult {
    try {
        return parseProjectRootPickerResult(value);
    } catch {
        throw new TypeError("invalid Desktop source-root picker result");
    }
}

export function parseInstallationRootPickerResult(value: unknown): InstallationRootPickerResult {
    try {
        return parseProjectRootPickerResult(value);
    } catch {
        throw new TypeError("invalid Desktop installation-root picker result");
    }
}
