import type { DesktopMessageId } from "../../presentation";
import type { WorkbenchBadgeTone } from "../../ui";
import type { ImportCandidateView } from "./import-review-model";

export function importAssetScopeMessage(scope: ImportCandidateView["scope"]): DesktopMessageId {
    switch (scope) {
        case "global":
            return "import.ui.asset.scope.global";
        case "project":
            return "import.ui.asset.scope.project";
    }
}

export function importAssetKindMessage(kind: ImportCandidateView["kind"]): DesktopMessageId {
    switch (kind) {
        case "Guidance":
            return "library.kind.guidance";
        case "Rule":
            return "library.kind.rule";
        case "Workflow":
            return "library.kind.workflow";
        case "Skill":
            return "library.kind.skill";
        case "Subagent":
            return "library.kind.subagent";
        case "Memory":
            return "library.kind.memory";
    }
}

export function importCandidateStatusMessage(candidate: ImportCandidateView): DesktopMessageId {
    switch (candidate.status) {
        case "incomplete":
            return "import.ui.asset.status.incomplete";
        case "blocked":
            return "import.ui.asset.status.blocked";
        case "duplicate":
            return "import.ui.asset.status.duplicate";
        case "importable":
            break;
    }
    switch (candidate.freshness) {
        case "fresh":
            return "import.ui.asset.status.ready";
        case "stale":
            return "import.ui.asset.status.stale";
        case "unknown":
            return "import.ui.asset.status.unknown";
        case "requires_refresh":
            return "import.ui.asset.status.requires_refresh";
    }
}

export function importCandidateStatusTone(candidate: ImportCandidateView): WorkbenchBadgeTone {
    switch (candidate.status) {
        case "duplicate":
            return "neutral";
        case "incomplete":
        case "blocked":
            return "warning";
        case "importable":
            break;
    }
    switch (candidate.freshness) {
        case "fresh":
            return "success";
        case "unknown":
            return "neutral";
        case "stale":
        case "requires_refresh":
            return "warning";
    }
}

export function importCandidateIncompleteHelpMessage(candidate: ImportCandidateView, hasReviewedFile: boolean): DesktopMessageId {
    const specificCause = candidate.diagnosticCodes?.includes("antigravity.skill_trigger_frontmatter_unverified") ?? false;
    if (specificCause) {
        return hasReviewedFile
            ? "import.ui.candidate.incomplete_help.antigravity_skill_trigger_file"
            : "import.ui.candidate.incomplete_help.antigravity_skill_trigger";
    }
    return hasReviewedFile ? "import.ui.candidate.incomplete_help_file" : "import.ui.candidate.incomplete_help";
}
