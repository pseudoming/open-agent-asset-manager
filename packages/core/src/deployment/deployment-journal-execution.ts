/** Private journal provenance for identities observed by the selected Linux process. */
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";
import { isSelectedWslPhysicalRootMapping } from "@oaam/shared/paths";
import { hasExactKeys, isCanonicalTargetRootPath } from "../foundation/validators";
import { isDirectoryIdentityOrNull } from "./deployment-journal-directory-validation";

export interface SelectedWslJournalExecution {
    kind: "selected_wsl";
    platformInstanceId: string;
    targetRootPath: string;
    executionRootPath: string;
    rootIdentity: PhysicalPathIdentity;
}

export function isSelectedWslJournalExecution(value: unknown): value is SelectedWslJournalExecution {
    if (!hasExactKeys(value, ["kind", "platformInstanceId", "targetRootPath", "executionRootPath", "rootIdentity"])) {
        return false;
    }
    const execution = value as SelectedWslJournalExecution;
    return (
        execution.kind === "selected_wsl" &&
        typeof execution.platformInstanceId === "string" &&
        typeof execution.targetRootPath === "string" &&
        typeof execution.executionRootPath === "string" &&
        isCanonicalTargetRootPath(execution.targetRootPath, "wsl") &&
        isSelectedWslPhysicalRootMapping(execution.targetRootPath, execution.executionRootPath, execution.platformInstanceId) &&
        execution.rootIdentity !== null &&
        isDirectoryIdentityOrNull(execution.rootIdentity)
    );
}
