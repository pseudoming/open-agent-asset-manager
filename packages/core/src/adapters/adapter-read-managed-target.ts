/**
 * Core-owned managed-target exclusion for raw adapter source reads.
 */

import type { ManagedTargetReadGuard } from "../types";
import { ReadAccessFailure } from "./adapter-read-budget";

export function rejectManagedTarget(guards: readonly ManagedTargetReadGuard[], sourceRootId: string, relativePath: string): void {
    if (isManagedTargetPath(guards, sourceRootId, relativePath)) {
        throw new ReadAccessFailure("blocked_managed_target", "managed target cannot be read as a raw source");
    }
}

export function isManagedTargetPath(
    guards: readonly ManagedTargetReadGuard[],
    sourceRootId: string,
    relativePath: string,
): boolean {
    return guards.some((guard) => {
        if (guard.sourceRootId !== sourceRootId) {
            return false;
        }
        if (guard.matchKind === "entire_root") {
            return true;
        }
        if (guard.matchKind === "exact_file") {
            return guard.relativePath === relativePath;
        }
        return relativePath === guard.relativePath || relativePath.startsWith(`${guard.relativePath}/`);
    });
}
