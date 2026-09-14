import { describe, expect, it } from "vitest";
import {
    importAssetKindMessage,
    importCandidateStatusMessage,
    importCandidateStatusTone,
} from "../src/renderer/features/import-review/import-review-presentation";
import { candidate } from "./import-review-test-fixtures";

describe("Desktop import review presentation", () => {
    it.each([
        ["Guidance", "library.kind.guidance"],
        ["Rule", "library.kind.rule"],
        ["Workflow", "library.kind.workflow"],
        ["Skill", "library.kind.skill"],
        ["Subagent", "library.kind.subagent"],
        ["Memory", "library.kind.memory"],
    ] as const)("maps the %s Asset kind to ordinary localized product copy", (kind, messageId) => {
        expect(importAssetKindMessage(kind)).toBe(messageId);
    });

    it.each([
        ["incomplete", "fresh", "import.ui.asset.status.incomplete", "warning"],
        ["blocked", "fresh", "import.ui.asset.status.blocked", "warning"],
        ["duplicate", "fresh", "import.ui.asset.status.duplicate", "neutral"],
        ["importable", "fresh", "import.ui.asset.status.ready", "success"],
        ["importable", "stale", "import.ui.asset.status.stale", "warning"],
        ["importable", "unknown", "import.ui.asset.status.unknown", "neutral"],
        ["importable", "requires_refresh", "import.ui.asset.status.requires_refresh", "warning"],
    ] as const)("presents %s/%s import status without exposing protocol enums", (status, freshness, messageId, tone) => {
        const view = candidate(`status-${status}-${freshness}`, "Guidance", { status, freshness });
        expect(importCandidateStatusMessage(view)).toBe(messageId);
        expect(importCandidateStatusTone(view)).toBe(tone);
    });
});
