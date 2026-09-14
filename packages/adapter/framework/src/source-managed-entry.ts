/** Respect Core's frozen exclusions without replacing its raw-read authority checks. */
import type { ManagedTargetReadGuard, ReadEntryHandle } from "@oaam/core";

export function canIgnoreManagedSourceEntry(guards: readonly ManagedTargetReadGuard[], entry: ReadEntryHandle): boolean {
    const sameRoot = guards.filter((guard) => guard.sourceRootId === entry.sourceRootId);
    if (sameRoot.some((guard) => guard.managementState === "in_flight_managed" && overlapsEntry(guard, entry))) return false;
    return sameRoot.some((guard) => guard.managementState !== "in_flight_managed" && coversEntry(guard, entry.relativePath));
}

function coversEntry(guard: ManagedTargetReadGuard, relativePath: string): boolean {
    if (guard.matchKind === "entire_root") return true;
    return (
        guard.relativePath === relativePath ||
        (guard.matchKind === "directory_prefix" && relativePath.startsWith(`${guard.relativePath}/`))
    );
}

function overlapsEntry(guard: ManagedTargetReadGuard, entry: ReadEntryHandle): boolean {
    return (
        coversEntry(guard, entry.relativePath) ||
        (guard.matchKind !== "entire_root" &&
            entry.entryKind === "directory" &&
            guard.relativePath.startsWith(`${entry.relativePath}/`))
    );
}

/** The Provider supplies its own source bases; a nested resource is never a direct child. */
export function isDirectSourceDirectoryEntry(entry: ReadEntryHandle, bases: readonly string[]): boolean {
    if (entry.entryKind !== "directory") return false;
    return bases.some((base) => {
        const relative =
            base === ""
                ? entry.relativePath
                : entry.relativePath.startsWith(`${base}/`)
                  ? entry.relativePath.slice(base.length + 1)
                  : "";
        return relative !== "" && !relative.includes("/");
    });
}
