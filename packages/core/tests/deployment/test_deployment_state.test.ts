/**
 * deployment-state tests (Phase 14 + Addition 1).
 *
 * Tests deriveDeploymentStatus pure function:
 * - 5 stable stage priority (deleted > recovery(internal) > blocked > conflict > needs_repair > in_sync)
 * - needs_recovery NOT in public DeploymentStage union
 * - 20 blocked reason codes valid
 * - observationState warnings appended when != complete
 * - unknown blocked reason → blocked_needs_support (audit fix)
 * - state derived from RAW observed fields, not caller booleans (audit fix)
 * - executable bit drift → needs_repair
 */

import { describe, it, expect } from "vitest";
import {
    deriveDeploymentStatus,
    BLOCKED_REASON_CODES,
    isValidBlockedReasonCode,
    type DeploymentDerivationInput,
    type FileObservationInput,
} from "../../src/deployment/deployment-state";
import type { DeploymentStage } from "../../src/types";

// ============================================================
// Helpers
// ============================================================

const SHA = `sha256:${"a".repeat(64)}`;
const SHA2 = `sha256:${"b".repeat(64)}`;

function baseInput(overrides: Partial<DeploymentDerivationInput> = {}): DeploymentDerivationInput {
    return {
        deleted: false,
        observationState: "complete",
        blockingEvidence: { reasonCode: "", operation: "", contextFingerprint: "" },
        hasUnresolvedJournal: false,
        recoveryFailed: false,
        hasAppliedBaseline: true,
        fileObservations: [],
        ...overrides,
    };
}

function filePresent(path: string, hash = SHA, exec = false): FileObservationInput {
    return {
        relativePath: path,
        appliedContentHash: hash,
        observedState: "present",
        observedContentHash: hash,
        appliedExecutable: exec,
        observedExecutable: exec,
    };
}

function fileChanged(path: string): FileObservationInput {
    return {
        relativePath: path,
        appliedContentHash: SHA,
        observedState: "present",
        observedContentHash: SHA2,
        appliedExecutable: false,
        observedExecutable: false,
    };
}

function fileMissing(path: string): FileObservationInput {
    return {
        relativePath: path,
        appliedContentHash: SHA,
        observedState: "missing",
        observedContentHash: "",
        appliedExecutable: false,
        observedExecutable: false,
    };
}

function fileExecDrift(path: string): FileObservationInput {
    return {
        relativePath: path,
        appliedContentHash: SHA,
        observedState: "present",
        observedContentHash: SHA,
        appliedExecutable: true,
        observedExecutable: false,
    };
}

// ============================================================
// 1. Stage priority
// ============================================================

describe("deriveDeploymentStatus: stage priority", () => {
    it("deleted takes priority over everything", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                deleted: true,
                hasUnresolvedJournal: true,
                recoveryFailed: true,
                blockingEvidence: { reasonCode: "blocked_by_deploy_target_unavailable", operation: "", contextFingerprint: "" },
                fileObservations: [fileChanged("a.md")],
            }),
        );
        expect(r.stage).toBe("deleted");
        expect(r.reason).toBe("");
    });

    it("unresolved journal (recovery not failed) → blocked with state_unavailable", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                hasUnresolvedJournal: true,
                recoveryFailed: false,
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.reason).toBe("blocked_by_recovery_state_unavailable");
    });

    it("unresolved journal + recovery failed → blocked with recovery reason", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                hasUnresolvedJournal: true,
                recoveryFailed: true,
                blockingEvidence: { reasonCode: "blocked_by_recovery_journal_corrupt", operation: "", contextFingerprint: "" },
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.reason).toBe("blocked_by_recovery_journal_corrupt");
    });

    it("unresolved journal + recovery failed + empty evidence → blocked with default recovery reason", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                hasUnresolvedJournal: true,
                recoveryFailed: true,
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.reason).toBe("blocked_by_recovery_journal_corrupt");
    });

    it("blocked evidence takes priority over conflict", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "blocked_by_unavailable_adapter", operation: "", contextFingerprint: "" },
                fileObservations: [fileChanged("a.md")],
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.reason).toBe("blocked_by_unavailable_adapter");
    });

    it("conflict takes priority over needs_repair", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileChanged("a.md"), fileMissing("b.md")],
            }),
        );
        expect(r.stage).toBe("conflict");
    });

    it("needs_repair when files missing but no runtime-changed", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileMissing("a.md")],
            }),
        );
        expect(r.stage).toBe("needs_repair");
    });

    it("in_sync when all files match baseline", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [filePresent("a.md"), filePresent("b.md")],
            }),
        );
        expect(r.stage).toBe("in_sync");
    });

    it("in_sync when no file observations (empty deployment)", () => {
        const r = deriveDeploymentStatus(baseInput({}));
        expect(r.stage).toBe("in_sync");
    });
});

describe("Core-owned Deployment action hints", () => {
    it("projects actions from authoritative state without exposing mutation authorization", () => {
        const cases: Array<[DeploymentDerivationInput, string[]]> = [
            [baseInput({ deleted: true }), []],
            [baseInput({ hasUnresolvedJournal: true }), ["recover"]],
            [
                baseInput({
                    hasUnresolvedJournal: true,
                    recoveryFailed: true,
                    blockingEvidence: {
                        reasonCode: "blocked_by_recovery_journal_corrupt",
                        operation: "",
                        contextFingerprint: "",
                    },
                }),
                ["contact_support"],
            ],
            [
                baseInput({
                    blockingEvidence: {
                        reasonCode: "blocked_by_unavailable_adapter",
                        operation: "",
                        contextFingerprint: "",
                    },
                }),
                ["review_deployment"],
            ],
            [
                baseInput({
                    recoveryFailed: true,
                    blockingEvidence: {
                        reasonCode: "blocked_by_recovery_state_unavailable",
                        operation: "",
                        contextFingerprint: "",
                    },
                }),
                ["recover"],
            ],
            [baseInput({ fileObservations: [fileChanged("a.md")] }), ["review_external_changes", "check_now"]],
            [baseInput({ fileObservations: [fileMissing("a.md")] }), ["review_repair", "check_now"]],
            [baseInput({ hasAppliedBaseline: true }), ["check_now"]],
            [baseInput({ hasAppliedBaseline: false }), ["review_deployment"]],
        ];
        for (const [input, expected] of cases) expect(deriveDeploymentStatus(input).actionHints).toEqual(expected);
    });

    it("maps unknown blocked evidence to support instead of leaking or guessing a repair action", () => {
        expect(
            deriveDeploymentStatus(
                baseInput({
                    blockingEvidence: { reasonCode: "future_unknown", operation: "", contextFingerprint: "" },
                }),
            ).actionHints,
        ).toEqual(["contact_support"]);
    });
});

// ============================================================
// 2. needs_recovery NOT in public union
// ============================================================

describe("needs_recovery exclusion", () => {
    it("DeploymentStage type does not include needs_recovery", () => {
        const stages: DeploymentStage[] = ["deleted", "blocked", "conflict", "needs_repair", "in_sync"];
        const recoveryInputs = [
            baseInput({ hasUnresolvedJournal: true, recoveryFailed: false }),
            baseInput({ hasUnresolvedJournal: true, recoveryFailed: true }),
            baseInput({ hasUnresolvedJournal: false, recoveryFailed: true }),
        ];
        for (const input of recoveryInputs) {
            const r = deriveDeploymentStatus(input);
            expect(r.stage).not.toBe("needs_recovery");
            expect(stages).toContain(r.stage);
        }
    });
});

// ============================================================
// 3. Blocked reason codes
// ============================================================

describe("blocked reason codes", () => {
    it("BLOCKED_REASON_CODES has exactly 20 codes", () => {
        expect(BLOCKED_REASON_CODES).toHaveLength(20);
    });

    it("isValidBlockedReasonCode accepts all 20 codes", () => {
        for (const code of BLOCKED_REASON_CODES) {
            expect(isValidBlockedReasonCode(code)).toBe(true);
        }
    });

    it("isValidBlockedReasonCode rejects unknown codes", () => {
        expect(isValidBlockedReasonCode("blocked_by_magic")).toBe(false);
        expect(isValidBlockedReasonCode("")).toBe(false);
        expect(isValidBlockedReasonCode("needs_recovery")).toBe(false);
    });

    it("non-recovery reason code is valid even when recoveryFailed=false", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "blocked_by_unavailable_adapter", operation: "", contextFingerprint: "" },
                recoveryFailed: false,
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.reason).toBe("blocked_by_unavailable_adapter");
    });

    it("recovery reason code requires recoveryFailed=true", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "blocked_by_recovery_journal_corrupt", operation: "", contextFingerprint: "" },
                recoveryFailed: false,
                hasUnresolvedJournal: false,
                fileObservations: [],
            }),
        );
        expect(r.stage).toBe("in_sync");
    });

    it("empty reasonCode → not blocked (falls through)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "", operation: "", contextFingerprint: "" },
            }),
        );
        expect(r.stage).not.toBe("blocked");
    });
});

// ============================================================
// 4. Unknown blocked reason → blocked_needs_support (audit fix)
// ============================================================

describe("unknown blocked reason → blocked_needs_support", () => {
    it("unknown reason code maps to blocked_needs_support", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "blocked_by_magic", operation: "", contextFingerprint: "" },
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.reason).toBe("blocked_needs_support");
    });

    it("unknown reason code does not leak raw string", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "totally_bogus_reason", operation: "", contextFingerprint: "" },
            }),
        );
        expect(r.reason).not.toBe("totally_bogus_reason");
        expect(r.reason).toBe("blocked_needs_support");
    });
});

// ============================================================
// 5. State derived from RAW fields, not caller booleans (audit fix)
// ============================================================

describe("RAW field derivation (audit fix: inconsistent booleans cannot bypass)", () => {
    it("missing observedState → needs_repair regardless of absent isMissing flag", () => {
        // Old: isMissing=false would bypass. New: derived from observedState="missing".
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileMissing("a.md")],
            }),
        );
        expect(r.stage).toBe("needs_repair");
    });

    it("present + different hash → conflict regardless of absent isRuntimeChanged flag", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileChanged("a.md")],
            }),
        );
        expect(r.stage).toBe("conflict");
    });

    it("present + same hash → in_sync (not tricked into conflict)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [filePresent("a.md")],
            }),
        );
        expect(r.stage).toBe("in_sync");
    });

    it("never observed → in_sync (not missing/repair)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [
                    {
                        relativePath: "a.md",
                        appliedContentHash: SHA,
                        observedState: "never",
                        observedContentHash: "",
                        appliedExecutable: false,
                        observedExecutable: false,
                    },
                ],
            }),
        );
        expect(r.stage).toBe("in_sync");
    });
});

// ============================================================
// 6. Executable bit drift → needs_repair
// ============================================================

describe("executable bit drift", () => {
    it("present + same hash + exec bit lost → needs_repair", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileExecDrift("script.sh")],
            }),
        );
        expect(r.stage).toBe("needs_repair");
    });

    it("present + same hash + same exec → in_sync", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [filePresent("script.sh", SHA, true)],
            }),
        );
        expect(r.stage).toBe("in_sync");
    });

    it("runtime-changed content takes priority over exec drift", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [
                    {
                        relativePath: "a.md",
                        appliedContentHash: SHA,
                        observedState: "present",
                        observedContentHash: SHA2,
                        appliedExecutable: true,
                        observedExecutable: false,
                    },
                ],
            }),
        );
        expect(r.stage).toBe("conflict");
    });
});

// ============================================================
// 7. ObservationState warnings
// ============================================================

describe("observationState warnings", () => {
    it("in_sync with complete observation → no warnings", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                observationState: "complete",
                fileObservations: [filePresent("a.md")],
            }),
        );
        expect(r.stage).toBe("in_sync");
        expect(r.observationWarnings).toHaveLength(0);
    });

    it("in_sync with never → warning", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                observationState: "never",
            }),
        );
        expect(r.stage).toBe("in_sync");
        expect(r.observationWarnings.some((w) => w.code === "observation.never")).toBe(true);
    });

    it("needs_repair with partial → warning", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                observationState: "partial",
                fileObservations: [fileMissing("a.md")],
            }),
        );
        expect(r.stage).toBe("needs_repair");
        expect(r.observationWarnings.some((w) => w.code === "observation.partial")).toBe(true);
    });

    it("conflict with failed → warning", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                observationState: "failed",
                fileObservations: [fileChanged("a.md")],
            }),
        );
        expect(r.stage).toBe("conflict");
        expect(r.observationWarnings.some((w) => w.code === "observation.failed")).toBe(true);
    });

    it("deleted → no observation warnings (preempted)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                deleted: true,
                observationState: "failed",
            }),
        );
        expect(r.stage).toBe("deleted");
        expect(r.observationWarnings).toHaveLength(0);
    });

    it("blocked → no observation warnings (preempted)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                blockingEvidence: { reasonCode: "blocked_by_unavailable_adapter", operation: "", contextFingerprint: "" },
                observationState: "partial",
            }),
        );
        expect(r.stage).toBe("blocked");
        expect(r.observationWarnings).toHaveLength(0);
    });

    it("in_progress observation state → warning", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                observationState: "in_progress",
            }),
        );
        expect(r.stage).toBe("in_sync");
        expect(r.observationWarnings.some((w) => w.code === "observation.in_progress")).toBe(true);
    });
});

// ============================================================
// 8. Mixed file observations
// ============================================================

describe("mixed file observations", () => {
    it("one runtime-changed + one matching → conflict (not in_sync)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileChanged("a.md"), filePresent("b.md")],
            }),
        );
        expect(r.stage).toBe("conflict");
    });

    it("one missing + one matching → needs_repair", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileMissing("a.md"), filePresent("b.md")],
            }),
        );
        expect(r.stage).toBe("needs_repair");
    });

    it("one missing + one runtime-changed → conflict (conflict has priority)", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [fileMissing("a.md"), fileChanged("b.md")],
            }),
        );
        expect(r.stage).toBe("conflict");
    });

    it("all files match → in_sync", () => {
        const r = deriveDeploymentStatus(
            baseInput({
                fileObservations: [filePresent("a.md", SHA), filePresent("b.md", SHA2)],
            }),
        );
        expect(r.stage).toBe("in_sync");
    });
});
