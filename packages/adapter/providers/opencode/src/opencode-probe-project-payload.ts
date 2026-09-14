/** Shared bounded parser for OpenCode's public project-list documents. */

const MAXIMUM_PROJECTS = 10_000;
const MAXIMUM_SANDBOXES_PER_PROJECT = 4_096;
const MAXIMUM_IDENTITY_TEXT = 32_768;

export interface OpenCodeProjectRecord {
    readonly runtimeProjectKey: string;
    readonly displayName: string;
    readonly primaryRuntimePath: string;
    readonly additionalRuntimePaths: readonly string[];
    readonly locatorKey: string;
}

type LocatorSurface =
    | "debug_scrap"
    | "http_project_list"
    | "stopped_debug_scrap"
    | "profile_debug_scrap"
    | "compatibility_database";

export function parseOpenCodeProjectList(
    bytes: Uint8Array,
    locatorSurface: LocatorSurface = "debug_scrap",
): readonly OpenCodeProjectRecord[] {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length > MAXIMUM_PROJECTS) throw new TypeError("invalid OpenCode project list");
    const records = value.map((item) => parseProject(item, locatorSurface));
    const identities = new Set<string>();
    for (const record of records) {
        if (identities.has(record.runtimeProjectKey)) throw new TypeError("duplicate OpenCode project identity");
        identities.add(record.runtimeProjectKey);
    }
    const projects = records.filter((record) => record.runtimeProjectKey !== "global");
    return projects.sort((left, right) =>
        compareText(
            `${left.runtimeProjectKey}\0${left.primaryRuntimePath}`,
            `${right.runtimeProjectKey}\0${right.primaryRuntimePath}`,
        ),
    );
}

function parseProject(value: unknown, locatorSurface: LocatorSurface): OpenCodeProjectRecord {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError("invalid OpenCode project record");
    const record = value as Record<string, unknown>;
    const runtimeProjectKey = canonicalText(record.id, false);
    const primaryRuntimePath = canonicalText(record.worktree, false);
    const displayName = record.name === undefined || record.name === null ? "" : canonicalText(record.name, true);
    const sandboxes = record.sandboxes;
    if (!Array.isArray(sandboxes) || sandboxes.length > MAXIMUM_SANDBOXES_PER_PROJECT) {
        throw new TypeError("invalid OpenCode project sandboxes");
    }
    const additionalRuntimePaths = [...new Set(sandboxes.map((item) => canonicalText(item, false)))]
        .filter((item) => item !== primaryRuntimePath)
        .sort(compareText);
    return {
        runtimeProjectKey,
        displayName,
        primaryRuntimePath,
        additionalRuntimePaths,
        // Keep the historical opaque installed-command key for saved source decisions; it asserts no process state.
        locatorKey: `${locatorSurface === "profile_debug_scrap" ? "stopped_debug_scrap" : locatorSurface}:${runtimeProjectKey}`,
    };
}

function canonicalText(value: unknown, allowEmpty: boolean): string {
    if (
        typeof value !== "string" ||
        value.length > MAXIMUM_IDENTITY_TEXT ||
        value.includes("\0") ||
        value.trim() !== value ||
        (!allowEmpty && value.length === 0)
    ) {
        throw new TypeError("non-canonical OpenCode project text");
    }
    return value;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
